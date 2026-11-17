import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { applyMigrations, readMigrations } from '../../db/src/migrations.js';
import { createTestDatabase, type TestDatabase } from '../../db/test/harness.js';
import { newsTriageIdentityHash } from '../../db/src/news-triage-store.js';
import type { TransactionalSqlExecutor } from '../../db/src/sql.js';
import { TRIAGE_POLICY_VERSION } from '../src/layers/l1-data-knowledge/news-triage.js';
import {
  createLiveNewsPollRuntime,
  type NewsFeedConfig,
  type StoredReportRevision,
} from '../src/runtime/news-poll-runtime.js';
import { buildLiveTriageGate } from '../src/runtime/news-triage-composition.js';
import { persistAcceptedRssItem, storedPublishedAtOrNull } from '../src/runtime/gated-rss-persistence.js';
import type { WorkerEnvironment } from '../src/layers/l4-application-integration/api.js';

// HOSTED-22 (owner rule F-14): a gated RSS revision's published_at is the item's own pubDate. A missing or unparseable
// pubDate stores NULL, and the retrieval time is never written as the publish time. Real poll, real persistence, PGlite.

const SOURCE_ID = 'source-hosted22-published-at';
const FULL_BASIS = ['model_triage', 'model_description', 'retain_title', 'retain_description', 'retain_derived'];

function feedXml(items: ReadonlyArray<{ guid: string; title: string; link: string; excerpt: string; pubDate: string | null }>): string {
  const rendered = items
    .map((item) => `    <item>
      <title>${item.title}</title>
      <link>${item.link}</link>
      <guid>${item.guid}</guid>
      ${item.pubDate === null ? '' : `<pubDate>${item.pubDate}</pubDate>`}
      <description>${item.excerpt}</description>
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
    await applyMigrations(database.executor, await readMigrations(new URL('../../db/migrations/', import.meta.url)));
    return database;
  } catch (error) {
    await database.close();
    throw error;
  }
}

async function seedSource(executor: TransactionalSqlExecutor, basis: readonly string[]): Promise<void> {
  await executor.query(
    `INSERT INTO waspada.traces (trace_id, dataset_kind, started_at, outcome, metadata)
     VALUES ('trace-seed', 'live', now(), 'succeeded', '{}'::jsonb)
     ON CONFLICT (trace_id, dataset_kind) DO NOTHING`,
  );
  await executor.query(
    `INSERT INTO waspada.source_registry (
       source_id, trace_id, registry_version, display_name, source_kind, remit,
       access_method, approved_hosts, access_restrictions, reuse_basis, registry_status,
       approval_status, health_status, auto_acquisition_enabled, auto_publication_policy
     )
     VALUES ($1, 'trace-seed', 1, 'Synthetic Published At', 'newsroom', ARRAY['test'],
             'rss', ARRAY[]::text[], ARRAY[]::text[], $2,
             'active', 'approved', 'healthy', true, 'never')
     ON CONFLICT (source_id) DO NOTHING`,
    [SOURCE_ID, [...basis]],
  );
}

function ingestChatMock() {
  return async (_system: string, user: string): Promise<unknown> => {
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

async function pollAndPersist(executor: TransactionalSqlExecutor, xml: string): Promise<readonly StoredReportRevision[]> {
  const env = { NINEROUTER_URL: 'https://example.test', NINEROUTER_KEY: 'k' } as WorkerEnvironment;
  const gate = buildLiveTriageGate(env, executor);
  const feed: NewsFeedConfig = { url: 'https://example.test/rss.xml', sourceId: SOURCE_ID };
  const runtime = createLiveNewsPollRuntime({
    feeds: [feed],
    fetchFn: (async () => new Response(xml)) as typeof fetch,
    triage: { ...gate, callChat: ingestChatMock() },
  });
  const result = await runtime.poll();
  for (const rev of result.revisions) {
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
  return result.revisions;
}

describe('HOSTED-22 gated RSS revision publish time', () => {
  it('stores the item pubDate as published_at, NULL when pubDate is missing or unparseable, and never the retrieval time', async () => {
    const database = await createMigratedDatabase();
    try {
      await seedSource(database.executor, FULL_BASIS);
      const pubDate = new Date(Date.now() - 30 * 60 * 1000).toUTCString();
      const xml = feedXml([
        { guid: 'g-dated', title: 'Banjir rendam permukiman di Kemang Jakarta Selatan', link: 'https://example.test/news/dated', excerpt: 'Air setinggi lutut merendam rumah warga.', pubDate },
        { guid: 'g-undated', title: 'Pohon tumbang menutup jalan di Tebet Jakarta Selatan', link: 'https://example.test/news/undated', excerpt: 'Pohon tumbang menutup satu lajur jalan.', pubDate: null },
        { guid: 'g-invalid', title: 'Kebakaran kecil di Cengkareng Jakarta Barat', link: 'https://example.test/news/invalid', excerpt: 'Kebakaran kecil sudah dipadamkan petugas.', pubDate: 'not a date' },
      ]);

      const revisions = await pollAndPersist(database.executor, xml);
      assert.equal(revisions.length, 3, 'all three items are accepted for persistence');

      const rows = await database.executor.query<{ canonical_url: string; retrieved_at: string; published_text: string | null }>(
        `SELECT canonical_url,
                to_char(published_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS published_text,
                to_char(retrieved_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS retrieved_at
         FROM waspada.report_revisions
         WHERE dataset_kind = 'live' AND source_id = $1
         ORDER BY canonical_url`,
        [SOURCE_ID],
      );
      const byUrl = new Map(rows.rows.map((row) => [row.canonical_url, row]));

      const dated = byUrl.get('https://example.test/news/dated');
      assert.ok(dated, 'the dated revision is stored');
      assert.equal(dated.published_text, new Date(pubDate).toISOString(), 'published_at is the item pubDate');
      assert.notEqual(dated.published_text, dated.retrieved_at, 'the publish time is not the retrieval time');

      const undated = byUrl.get('https://example.test/news/undated');
      assert.ok(undated, 'the undated revision is stored');
      assert.equal(undated.published_text, null, 'no pubDate gives NULL, not the retrieval time');

      const invalid = byUrl.get('https://example.test/news/invalid');
      assert.ok(invalid, 'the revision with an unparseable pubDate is stored');
      assert.equal(invalid.published_text, null, 'an unparseable pubDate gives NULL');
    } finally {
      await database.close();
    }
  });
});

describe('HOSTED-22 structured publish time (F-14)', () => {
  const retrievedAt = '2026-11-17T01:00:00.000Z';

  it('stores the revision own time as a UTC instant', () => {
    assert.equal(
      storedPublishedAtOrNull({ published_at: '2026-11-09T05:30:00Z', retrieved_at: retrievedAt }),
      '2026-11-09T05:30:00.000Z',
    );
  });

  it('stores NULL for the BMKG in-memory fallback, which is the retrieval time and so never a publish time', () => {
    assert.equal(storedPublishedAtOrNull({ published_at: retrievedAt, retrieved_at: retrievedAt }), null);
  });

  it('stores NULL when the source gave no time, or one that does not parse', () => {
    assert.equal(storedPublishedAtOrNull({ published_at: null, retrieved_at: retrievedAt }), null);
    assert.equal(storedPublishedAtOrNull({ published_at: 'not a date', retrieved_at: retrievedAt }), null);
  });
});
