import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';
import { applyMigrations, readMigrations } from '../../db/src/migrations.js';
import { createTestDatabase, type TestDatabase } from '../../db/test/harness.js';
import {
  newsTriageIdentityHash,
  readLatestAttemptForRevision,
  readTriageDecision,
} from '../../db/src/news-triage-store.js';
import type { TransactionalSqlExecutor } from '../../db/src/sql.js';
import {
  buildAuthorizedRevision,
  newsContentHash,
  newsItemIdentityHash,
  newsRevisionId,
} from '../src/layers/l1-data-knowledge/rss-news-ingest.js';
import {
  TRIAGE_POLICY_VERSION,
  type NewsTriageDecision,
} from '../src/layers/l1-data-knowledge/news-triage.js';
import {
  createLiveNewsPollRuntime,
  type HeldTriageDecision,
  type NewsFeedConfig,
  type StoredReportRevision,
} from '../src/runtime/news-poll-runtime.js';
import type { WorkerEnvironment } from '../src/layers/l4-application-integration/api.js';
import { buildLiveTriageGate } from '../src/runtime/news-triage-composition.js';
import {
  persistAcceptedRssItem,
  persistHeldTriageItem,
} from '../src/runtime/gated-rss-persistence.js';

// WJ-INT-02B content-version identity + permission-filtered persistence.

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

describe('news content-version identity', () => {
  it('keeps a stable identity across edits and distinct identities per source', () => {
    assert.equal(newsItemIdentityHash('s1', 'guid-1'), newsItemIdentityHash('s1', 'guid-1'));
    assert.notEqual(newsItemIdentityHash('s1', 'guid-1'), newsItemIdentityHash('s1', 'guid-2'));
    assert.notEqual(newsItemIdentityHash('s1', 'guid-1'), newsItemIdentityHash('s2', 'guid-1'));
    assert.throws(() => newsItemIdentityHash('', 'guid-1'), TypeError);
    assert.throws(() => newsItemIdentityHash('s1', ''), TypeError);
  });

  it('changes the content hash on any authorized edit', () => {
    const link = 'https://example.test/news/1';
    assert.equal(newsContentHash('t', link), sha256Hex(`${link}:t`));
    assert.notEqual(newsContentHash('title A', link), newsContentHash('title B', link));
  });

  it('binds revision ids to identity and content', () => {
    const first = newsRevisionId('s1', 'guid-1', 'c1');
    assert.ok(first.startsWith('rep-s1-'));
    assert.equal(first, newsRevisionId('s1', 'guid-1', 'c1'));
    assert.notEqual(first, newsRevisionId('s1', 'guid-1', 'c2'));
    assert.notEqual(first, newsRevisionId('s1', 'guid-2', 'c1'));
    assert.notEqual(first, newsRevisionId('s2', 'guid-1', 'c1'));
  });
});

describe('buildAuthorizedRevision', () => {
  const stored = {
    report_revision_id: 'rep-old',
    source_id: 'source-x',
    canonical_url: 'https://example.test/news/1',
    permitted_text: 'Old Title\n\nOld excerpt.',
    permitted_text_hash: sha256Hex('Old Title\n\nOld excerpt.'),
    published_at: null,
    retrieved_at: '2026-10-01T01:00:00.000Z',
    revision_status: 'unreviewed' as const,
    source_revision_key: 'guid-1',
  };
  it('rebuilds the full payload when everything is retained', () => {
    const built = buildAuthorizedRevision(
      stored,
      { title: 'New Title', descriptionExcerpt: 'New excerpt.', canonicalUrl: stored.canonical_url, retrievedAt: stored.retrieved_at },
      { titleRetention: true, descriptionRetention: true },
    );
    assert.equal(built.permitted_text, 'New Title\n\nNew excerpt.');
    assert.equal(built.chunks.length, 2);
    assert.equal(built.report_revision_id, newsRevisionId('source-x', 'guid-1', newsContentHash(built.permitted_text, stored.canonical_url)));
    assert.equal(built.content_hash, newsContentHash(built.permitted_text, stored.canonical_url));
  });

  it('drops the description to a single title chunk when retention is denied', () => {
    const built = buildAuthorizedRevision(
      stored,
      { title: 'New Title', descriptionExcerpt: 'New excerpt.', canonicalUrl: stored.canonical_url, retrievedAt: stored.retrieved_at },
      { titleRetention: true, descriptionRetention: false },
    );
    assert.equal(built.permitted_text, 'New Title');
    assert.equal(built.chunks.length, 1);
    assert.ok(!built.permitted_text.includes('excerpt'));
  });

  it('throws when title retention is denied', () => {
    assert.throws(
      () =>
        buildAuthorizedRevision(
          stored,
          { title: 'New Title', descriptionExcerpt: null, canonicalUrl: stored.canonical_url, retrievedAt: stored.retrieved_at },
          { titleRetention: false, descriptionRetention: false },
        ),
      /TitleRetentionNotPermitted/,
    );
  });
});

// --- Gate + persist integration (synthetic PGlite, synthetic source ids) ---

const SOURCE_ID = 'source-synthetic-gate';

function feedXml(items: ReadonlyArray<{ guid: string; title: string; link: string; excerpt: string | null }>, pubDate: string): string {
  const rendered = items
    .map((item) => `    <item>
      <title>${item.title}</title>
      <link>${item.link}</link>
      <guid>${item.guid}</guid>
      <pubDate>${pubDate}</pubDate>
      ${item.excerpt === null ? '' : `<description>${item.excerpt}</description>`}
    </item>`)
    .join('\n');
  return `<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0"><channel><title>t</title><link>https://example.test/</link><description>d</description>
${rendered}
</channel></rss>`;
}

async function createMigratedDatabase(): Promise<TestDatabase> {
  const database = await createTestDatabase();
  try {
    const migrations = await readMigrations(new URL('../../db/migrations/', import.meta.url));
    await applyMigrations(database.executor, migrations);
    return database;
  } catch (error) {
    await database.close();
    throw error;
  }
}

async function seedSource(
  executor: TransactionalSqlExecutor,
  sourceId: string,
  basis: readonly string[],
  license?: { url: string; scope: string; reviewer: string; reviewedAt: string; expiresAt: string | null },
): Promise<void> {
  await executor.query(
    `INSERT INTO waspada.traces (trace_id, dataset_kind, started_at, outcome, metadata)
     VALUES ('trace-seed', 'live', now(), 'succeeded', '{}'::jsonb)
     ON CONFLICT (trace_id, dataset_kind) DO NOTHING`,
  );
  await executor.query(
    `INSERT INTO waspada.source_registry (
       source_id, trace_id, registry_version, display_name, source_kind, remit,
       access_method, approved_hosts, access_restrictions, reuse_basis, registry_status,
       approval_status, health_status, auto_acquisition_enabled, auto_publication_policy,
       reuse_license_url, reuse_scope, reuse_reviewer, reuse_reviewed_at, reuse_expires_at
     )
     VALUES ('${sourceId}', 'trace-seed', 1, 'Synthetic Gate', 'newsroom', ARRAY['test'],
             'rss', ARRAY[]::text[], ARRAY[]::text[], $1,
             'active', 'approved', 'healthy', true, 'never',
             $2, $3, $4, $5::timestamptz, $6::timestamptz)
     ON CONFLICT (source_id) DO NOTHING`,
    [
      [...basis],
      license?.url ?? null,
      license?.scope ?? null,
      license?.reviewer ?? null,
      license?.reviewedAt ?? null,
      license?.expiresAt ?? null,
    ],
  );
}

function ingestChatMock(calls: Array<{ system: string; user: string }>) {
  return async (system: string, user: string): Promise<unknown> => {
    calls.push({ system, user });
    const parsed = JSON.parse(user) as { title: string };
    return {
      disposition: 'ingest',
      jakartaScope: 'dki_jakarta',
      actionability: 'actionable',
      primaryCategory: 'disasters_weather',
      incidentType: 'flood',
      confidence: 'high',
      reasonCodes: ['triage_v1_ingest'],
      evidence: [{ field: 'title', exactQuote: parsed.title }],
    };
  };
}

async function pollOnce(
  _executor: TransactionalSqlExecutor,
  xml: string,
  triage: {
    checkAuthorization: (sourceId: string) => Promise<{ cleared: boolean }>;
    callChat?: (system: string, user: string) => Promise<unknown>;
    findPriorDecision: (key: {
      itemIdentityHash: string;
      contentHash: string;
      policyVersion: string;
      reportRevisionId?: string;
    }) => Promise<NewsTriageDecision | null>;
  },
  sourceId: string = SOURCE_ID,
): Promise<{ revisions: readonly StoredReportRevision[]; held: readonly HeldTriageDecision[] }> {
  const feed: NewsFeedConfig = { url: 'https://example.test/rss.xml', sourceId };
  const runtime = createLiveNewsPollRuntime({
    feeds: [feed],
    fetchFn: (async () => new Response(xml)) as typeof fetch,
    triage: { sourceRemit: 'general news', ...triage },
  });
  const result = await runtime.poll();
  return { revisions: result.revisions, held: result.held };
}

async function persistPollResult(
  executor: TransactionalSqlExecutor,
  revisions: readonly StoredReportRevision[],
  held: readonly HeldTriageDecision[],
): Promise<void> {
  for (const rev of revisions) {
    const triage = rev.triage;
    if (!triage || triage.disposition !== 'ingest') continue;
    await persistAcceptedRssItem(executor, {
      datasetKind: 'live',
      rev: { ...rev, triage },
      itemIdentityHash: newsTriageIdentityHash(rev.source_id, rev.source_revision_key ?? rev.canonical_url),
      contentHash: rev.content_hash ?? rev.permitted_text_hash,
      supersedesHash: null,
      policyVersion: TRIAGE_POLICY_VERSION,
    });
  }
  for (const item of held) {
    await persistHeldTriageItem(executor, item, 'live', TRIAGE_POLICY_VERSION, item.replayed ?? false);
  }
}

const TITLE = 'Banjir rendam permukiman di Mampang Prapatan Jakarta Selatan';
const EXCERPT_A = 'Air setinggi lutut merendam puluhan rumah di Mampang Prapatan Jakarta Selatan.';
const EXCERPT_B = 'Air setinggi pinggang merendam ratusan rumah di Mampang Prapatan Jakarta Selatan.';
const FULL_BASIS = ['model_triage', 'model_description', 'retain_title', 'retain_description', 'retain_derived'];

function recentPubDate(): string {
  return new Date(Date.now() - 30 * 60 * 1000).toUTCString();
}

describe('gated RSS revision identity and idempotency', () => {
  it('stable content keeps revision ids with one model call, one attempt, one job', async () => {
    const database = await createMigratedDatabase();
    try {
      await seedSource(database.executor, SOURCE_ID, FULL_BASIS);
      const env = { NINEROUTER_URL: 'https://example.test', NINEROUTER_KEY: 'k' } as WorkerEnvironment;
      const gate = buildLiveTriageGate(env, database.executor);
      const calls: Array<{ system: string; user: string }> = [];
      const triage = { ...gate, callChat: ingestChatMock(calls) };
      const xml = feedXml([{ guid: 'g1', title: TITLE, link: 'https://example.test/news/1', excerpt: EXCERPT_A }], recentPubDate());

      const first = await pollOnce(database.executor, xml, triage);
      assert.equal(first.revisions.length, 1);
      const firstId = first.revisions[0]!.report_revision_id;
      await persistPollResult(database.executor, first.revisions, first.held);

      const second = await pollOnce(database.executor, xml, triage);
      assert.equal(second.revisions.length, 1);
      assert.equal(second.revisions[0]!.report_revision_id, firstId);
      await persistPollResult(database.executor, second.revisions, second.held);

      assert.equal(calls.length, 1);
      const attempts = await database.executor.query<{ n: string }>(
        `SELECT COUNT(*)::text AS n FROM waspada.news_triage_attempts WHERE dataset_kind = 'live'`,
      );
      assert.equal(attempts.rows[0]!.n, '1');
      const jobs = await database.executor.query<{ n: string }>(
        `SELECT COUNT(*)::text AS n FROM waspada.ai_jobs WHERE dataset_kind = 'live'`,
      );
      assert.equal(jobs.rows[0]!.n, '1');
    } finally {
      await database.close();
    }
  });

  it('changed description keeps identity but mints a new revision linked by supersedes', async () => {
    const database = await createMigratedDatabase();
    try {
      await seedSource(database.executor, SOURCE_ID, FULL_BASIS);
      const env = { NINEROUTER_URL: 'https://example.test', NINEROUTER_KEY: 'k' } as WorkerEnvironment;
      const gate = buildLiveTriageGate(env, database.executor);
      const calls: Array<{ system: string; user: string }> = [];
      const triage = { ...gate, callChat: ingestChatMock(calls) };
      const pubDate = recentPubDate();

      const first = await pollOnce(
        database.executor,
        feedXml([{ guid: 'g1', title: TITLE, link: 'https://example.test/news/1', excerpt: EXCERPT_A }], pubDate),
        triage,
      );
      await persistPollResult(database.executor, first.revisions, first.held);
      const firstId = first.revisions[0]!.report_revision_id;

      const second = await pollOnce(
        database.executor,
        feedXml([{ guid: 'g1', title: TITLE, link: 'https://example.test/news/1', excerpt: EXCERPT_B }], pubDate),
        triage,
      );
      assert.equal(second.revisions.length, 1);
      const secondRev = second.revisions[0]!;
      assert.notEqual(secondRev.report_revision_id, firstId);
      assert.equal(calls.length, 2);
      await persistPollResult(database.executor, second.revisions, second.held);

      const snapshot = await readTriageDecision(database.executor, 'live', secondRev.triage ? newsTriageIdentityHash(SOURCE_ID, 'g1') : '');
      assert.equal(snapshot?.reportRevisionId, secondRev.report_revision_id);
      assert.equal(snapshot?.attemptCount, 2);
      const latest = await readLatestAttemptForRevision(database.executor, 'live', secondRev.report_revision_id);
      assert.equal(latest?.supersedesHash, first.revisions[0]!.content_hash ?? first.revisions[0]!.permitted_text_hash);
      const revision = await database.executor.query<{ supersedes_id: string | null }>(
        `SELECT supersedes_id FROM waspada.report_revisions WHERE dataset_kind = 'live' AND report_revision_id = $1`,
        [secondRev.report_revision_id],
      );
      assert.equal(revision.rows[0]!.supersedes_id, firstId);
    } finally {
      await database.close();
    }
  });
  it('changed title mints a new revision id for the same guid', async () => {
    const database = await createMigratedDatabase();
    try {
      await seedSource(database.executor, SOURCE_ID, FULL_BASIS);
      const env = { NINEROUTER_URL: 'https://example.test', NINEROUTER_KEY: 'k' } as WorkerEnvironment;
      const gate = buildLiveTriageGate(env, database.executor);
      const calls: Array<{ system: string; user: string }> = [];
      const triage = { ...gate, callChat: ingestChatMock(calls) };
      const pubDate = recentPubDate();
      const first = await pollOnce(
        database.executor,
        feedXml([{ guid: 'g1', title: TITLE, link: 'https://example.test/news/1', excerpt: EXCERPT_A }], pubDate),
        triage,
      );
      await persistPollResult(database.executor, first.revisions, first.held);
      const editedTitle = 'Banjir bandang rendam permukiman di Mampang Prapatan Jakarta Selatan';
      const second = await pollOnce(
        database.executor,
        feedXml([{ guid: 'g1', title: editedTitle, link: 'https://example.test/news/1', excerpt: EXCERPT_A }], pubDate),
        triage,
      );
      assert.equal(second.revisions.length, 1);
      assert.notEqual(second.revisions[0]!.report_revision_id, first.revisions[0]!.report_revision_id);
      assert.ok(second.revisions[0]!.permitted_text.startsWith(editedTitle));
    } finally {
      await database.close();
    }
  });

  it('identical URLs from two sources yield distinct identities and revisions', async () => {
    const otherSource = 'source-synthetic-gate-2';
    const database = await createMigratedDatabase();
    try {
      await seedSource(database.executor, SOURCE_ID, FULL_BASIS);
      await seedSource(database.executor, otherSource, FULL_BASIS);
      const env = { NINEROUTER_URL: 'https://example.test', NINEROUTER_KEY: 'k' } as WorkerEnvironment;
      const gate = buildLiveTriageGate(env, database.executor);
      const calls: Array<{ system: string; user: string }> = [];
      const triage = { ...gate, callChat: ingestChatMock(calls) };
      const xml = feedXml([{ guid: 'g1', title: TITLE, link: 'https://example.test/news/1', excerpt: EXCERPT_A }], recentPubDate());
      const feedA = { url: 'https://example.test/a.xml', sourceId: SOURCE_ID };
      const feedB = { url: 'https://example.test/b.xml', sourceId: otherSource };
      const runtime = createLiveNewsPollRuntime({
        feeds: [feedA, feedB],
        fetchFn: (async () => new Response(xml)) as typeof fetch,
        triage: { ...triage },
      });
      // pollFeed per feed: poll() aggregates by canonical URL, but each
      // source's evaluation must mint a distinct identity and revision id.
      const resultA = await runtime.pollFeed(feedA, new Date().toISOString());
      const resultB = await runtime.pollFeed(feedB, new Date().toISOString());
      assert.equal(resultA.revisions.length, 1);
      assert.equal(resultB.revisions.length, 1);
      const [left, right] = [resultA.revisions[0]!, resultB.revisions[0]!];
      assert.notEqual(left.report_revision_id, right.report_revision_id);
      await persistPollResult(database.executor, [...resultA.revisions, ...resultB.revisions], [...resultA.held, ...resultB.held]);
      const decisions = await database.executor.query<{ n: string }>(
        `SELECT COUNT(*)::text AS n FROM waspada.news_triage_decisions WHERE dataset_kind = 'live'`,
      );
      assert.equal(decisions.rows[0]!.n, '2');
    } finally {
      await database.close();
    }
  });


  it('concurrent polls for the same version create one evaluation and one job', async () => {
    const database = await createMigratedDatabase();
    try {
      await seedSource(database.executor, SOURCE_ID, FULL_BASIS);
      const env = { NINEROUTER_URL: 'https://example.test', NINEROUTER_KEY: 'k' } as WorkerEnvironment;
      const gate = buildLiveTriageGate(env, database.executor);
      const calls: Array<{ system: string; user: string }> = [];
      const triage = { ...gate, callChat: ingestChatMock(calls) };
      const xml = feedXml([{ guid: 'g1', title: TITLE, link: 'https://example.test/news/1', excerpt: EXCERPT_A }], recentPubDate());

      const [first, second] = await Promise.all([
        pollOnce(database.executor, xml, triage),
        pollOnce(database.executor, xml, triage),
      ]);
      await Promise.all([
        persistPollResult(database.executor, first.revisions, first.held),
        persistPollResult(database.executor, second.revisions, second.held),
      ]);

      const jobs = await database.executor.query<{ n: string }>(
        `SELECT COUNT(*)::text AS n FROM waspada.ai_jobs WHERE dataset_kind = 'live'`,
      );
      assert.equal(jobs.rows[0]!.n, '1');
      const attempts = await database.executor.query<{ n: string }>(
        `SELECT COUNT(*)::text AS n FROM waspada.news_triage_attempts WHERE dataset_kind = 'live'`,
      );
      assert.equal(attempts.rows[0]!.n, '1');
    } finally {
      await database.close();
    }
  });

  it('bounds provider-error retries to three attempts per version per 24h', async () => {
    const database = await createMigratedDatabase();
    try {
      await seedSource(database.executor, SOURCE_ID, FULL_BASIS);
      const env = { NINEROUTER_URL: 'https://example.test', NINEROUTER_KEY: 'k' } as WorkerEnvironment;
      const gate = buildLiveTriageGate(env, database.executor);
      let chatCalls = 0;
      const triage = {
        ...gate,
        callChat: async (): Promise<unknown> => {
          chatCalls += 1;
          throw new Error('transport down');
        },
      };
      const xml = feedXml([{ guid: 'g1', title: TITLE, link: 'https://example.test/news/1', excerpt: EXCERPT_A }], recentPubDate());

      for (let round = 0; round < 3; round += 1) {
        const polled = await pollOnce(database.executor, xml, triage);
        assert.equal(polled.held.length, 1);
        await persistPollResult(database.executor, polled.revisions, polled.held);
      }
      assert.equal(chatCalls, 3);

      const fourth = await pollOnce(database.executor, xml, triage);
      assert.equal(fourth.held.length, 1);
      assert.deepEqual(fourth.held[0]!.decision.reasonCodes, ['provider_error']);
      assert.equal(chatCalls, 3);
      await persistPollResult(database.executor, fourth.revisions, fourth.held);
      const attempts = await database.executor.query<{ n: string }>(
        `SELECT COUNT(*)::text AS n FROM waspada.news_triage_attempts WHERE dataset_kind = 'live'`,
      );
      assert.equal(attempts.rows[0]!.n, '3');
    } finally {
      await database.close();
    }
  });
});

describe('gated RSS rights enforcement', () => {
  it('denies model use for a public-only basis without license evidence: no prompt, no revision, no job', async () => {
    const database = await createMigratedDatabase();
    try {
      await seedSource(database.executor, SOURCE_ID, ['public']);
      const env = { NINEROUTER_URL: 'https://example.test', NINEROUTER_KEY: 'k' } as WorkerEnvironment;
      const gate = buildLiveTriageGate(env, database.executor);
      const calls: Array<{ system: string; user: string }> = [];
      const polled = await pollOnce(database.executor, feedXml([{ guid: 'g1', title: TITLE, link: 'https://example.test/news/1', excerpt: EXCERPT_A }], recentPubDate()), {
        ...gate,
        callChat: ingestChatMock(calls),
      });
      assert.equal(calls.length, 0);
      assert.equal(polled.revisions.length, 0);
      assert.equal(polled.held.length, 1);
      await persistPollResult(database.executor, polled.revisions, polled.held);
      const revisions = await database.executor.query<{ n: string }>(
        `SELECT COUNT(*)::text AS n FROM waspada.report_revisions WHERE dataset_kind = 'live'`,
      );
      assert.equal(revisions.rows[0]!.n, '0');
      const jobs = await database.executor.query<{ n: string }>(
        `SELECT COUNT(*)::text AS n FROM waspada.ai_jobs WHERE dataset_kind = 'live'`,
      );
      assert.equal(jobs.rows[0]!.n, '0');
    } finally {
      await database.close();
    }
  });

  it('title-only retention keeps the description out of the prompt payload and the persisted text', async () => {
    const database = await createMigratedDatabase();
    try {
      await seedSource(database.executor, SOURCE_ID, ['model_triage', 'retain_title']);
      const env = { NINEROUTER_URL: 'https://example.test', NINEROUTER_KEY: 'k' } as WorkerEnvironment;
      const gate = buildLiveTriageGate(env, database.executor);
      const calls: Array<{ system: string; user: string }> = [];
      const polled = await pollOnce(database.executor, feedXml([{ guid: 'g1', title: TITLE, link: 'https://example.test/news/1', excerpt: EXCERPT_A }], recentPubDate()), {
        ...gate,
        callChat: ingestChatMock(calls),
      });
      assert.equal(calls.length, 1);
      const promptUser = JSON.parse(calls[0]!.user) as { description: string | null };
      assert.equal(promptUser.description, null);
      assert.equal(polled.revisions.length, 1);
      const kept = polled.revisions[0]!;
      assert.equal(kept.permitted_text, TITLE);
      assert.equal(kept.chunks.length, 1);
      assert.ok(!kept.permitted_text.includes(EXCERPT_A));
      await persistPollResult(database.executor, polled.revisions, polled.held);
      const stored = await database.executor.query<{ permitted_text: string; chunk_count: string }>(
        `SELECT r.permitted_text, (SELECT COUNT(*)::text FROM waspada.evidence_chunks c
          WHERE c.dataset_kind = 'live' AND c.report_revision_id = r.report_revision_id) AS chunk_count
         FROM waspada.report_revisions r WHERE r.dataset_kind = 'live'`,
      );
      assert.equal(stored.rows.length, 1);
      assert.ok(!stored.rows[0]!.permitted_text.includes(EXCERPT_A));
      assert.equal(stored.rows[0]!.chunk_count, '1');
    } finally {
      await database.close();
    }
  });

  it('model use without title retention routes to held and persists no revision or job', async () => {
    const database = await createMigratedDatabase();
    try {
      await seedSource(database.executor, SOURCE_ID, ['model_triage']);
      const env = { NINEROUTER_URL: 'https://example.test', NINEROUTER_KEY: 'k' } as WorkerEnvironment;
      const gate = buildLiveTriageGate(env, database.executor);
      const calls: Array<{ system: string; user: string }> = [];
      const polled = await pollOnce(database.executor, feedXml([{ guid: 'g1', title: TITLE, link: 'https://example.test/news/1', excerpt: EXCERPT_A }], recentPubDate()), {
        ...gate,
        callChat: ingestChatMock(calls),
      });
      assert.equal(calls.length, 1);
      const promptUser = JSON.parse(calls[0]!.user) as { description: string | null };
      assert.equal(promptUser.description, null);
      assert.equal(polled.revisions.length, 0);
      assert.equal(polled.held.length, 1);
      assert.deepEqual(polled.held[0]!.decision.reasonCodes, ['retention_not_permitted']);
      await persistPollResult(database.executor, polled.revisions, polled.held);
      const revisions = await database.executor.query<{ n: string }>(
        `SELECT COUNT(*)::text AS n FROM waspada.report_revisions WHERE dataset_kind = 'live'`,
      );
      assert.equal(revisions.rows[0]!.n, '0');
      const jobs = await database.executor.query<{ n: string }>(
        `SELECT COUNT(*)::text AS n FROM waspada.ai_jobs WHERE dataset_kind = 'live'`,
      );
      assert.equal(jobs.rows[0]!.n, '0');
      const attempts = await database.executor.query<{ n: string }>(
        `SELECT COUNT(*)::text AS n FROM waspada.news_triage_attempts WHERE dataset_kind = 'live'`,
      );
      assert.equal(attempts.rows[0]!.n, '1');
    } finally {
      await database.close();
    }
  });
});
