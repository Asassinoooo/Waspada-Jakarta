/**
 * AI-RPM-01 gateway-call profile for live RSS.
 *
 * - a syndicated copy in a second feed in the same cycle makes no triage call and no job;
 * - a normalised-title duplicate in a later cycle makes no model call and is recorded as a duplicate;
 * - the per-cycle fresh-call cap holds excess items without a call or a persisted decision;
 * - a mocked RSS article makes at most three gateway calls (triage, interpretation, embedding).
 *
 * Fake clock, fake transports, mock agents and PGlite only. No network, no credentials.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import type { Agent } from '@mastra/core/agent';
import { applyMigrations, readMigrations } from '../../db/src/migrations.js';
import { createTestDatabase, type TestDatabase } from '../../db/test/harness.js';
import {
  createNineRouterRateGate,
  getNineRouterCallCounts,
  setNineRouterRateGate,
  type NineRouterFetch,
} from '../../db/src/ninerouter-rate-gate.js';
import { newsTriageIdentityHash } from '../../db/src/news-triage-store.js';
import { createJobRunner } from '../../intelligence/src/job-runner.js';
import { generateMockVector, type NineRouterConfig } from '../../intelligence/src/providers/ninerouter-adapter.js';
import { TRIAGE_POLICY_VERSION } from '../src/layers/l1-data-knowledge/news-triage.js';
import {
  createRecentItemIndex,
  MIN_DEDUPE_TITLE_CHARS,
  normalizedTitleKey,
  RECENT_ITEM_WINDOW_MS,
} from '../src/layers/l1-data-knowledge/news-title-dedupe.js';
import {
  applyTriageGate,
  createCycleRevisionDedupe,
  createLiveNewsPollRuntime,
  type NewsFeedConfig,
  type StoredReportRevision,
} from '../src/runtime/news-poll-runtime.js';
import { buildLiveTriageGate } from '../src/runtime/news-triage-composition.js';
import { runGatedRssCycle } from '../src/runtime/gated-rss-persistence.js';
import {
  DEFAULT_LIVE_MAX_NEW_ITEMS_PER_CYCLE,
  DEFAULT_LIVE_RSS_MAX_AGE_HOURS,
  parseLiveCycleConfig,
} from '../src/runtime/live-cycle-config.js';
import type { WorkerEnvironment } from '../src/layers/l4-application-integration/api.js';

const FEED_A: NewsFeedConfig = { url: 'https://example.test/feed-a.xml', sourceId: 'source-dedupe-a' };
const FEED_B: NewsFeedConfig = { url: 'https://example.test/feed-b.xml', sourceId: 'source-dedupe-b' };
const STORY_TITLE = 'Banjir rendam permukiman di Mampang Prapatan Jakarta Selatan';
// Same story, different case, punctuation and link: the normalised title is equal.
const SYNDICATED_TITLE = 'BANJIR rendam permukiman di Mampang-Prapatan, Jakarta Selatan!';
const EXCERPT_A = 'Air setinggi lutut merendam puluhan rumah di Mampang Prapatan Jakarta Selatan.';
const EXCERPT_B = 'Air setinggi pinggang merendam ratusan rumah di Mampang Prapatan Jakarta Selatan.';
const FULL_BASIS = ['model_triage', 'model_description', 'retain_title', 'retain_description', 'retain_derived'];
const LIVE_ENV = { NINEROUTER_URL: 'https://example.test', NINEROUTER_KEY: 'k' } as WorkerEnvironment;
const RETRIEVED_AT = '2026-11-11T08:00:00Z';
const NO_SLEEP_CLOCK = { now: () => Date.now(), sleep: async () => {} };
const LIVE_CONFIG: NineRouterConfig = {
  baseUrl: 'http://nr.test',
  apiKey: 'test-key',
  chatModel: 'Waspada-Jakarta',
  embeddingModel: 'gemini/gemini-embedding-2-preview',
  embeddingDimensions: 768,
  executionMode: 'live',
};

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function recentPubDate(): string {
  return new Date(Date.now() - 30 * 60 * 1000).toUTCString();
}

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

function xmlFetch(xmlFor: (url: string) => string): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    return new Response(xmlFor(url));
  }) as typeof fetch;
}

/** Fake triage chat: ingests every item and records the title it was asked about. */
function ingestChat(calls: string[]) {
  return async (_system: string, user: string): Promise<unknown> => {
    const parsed = JSON.parse(user) as { title: string };
    calls.push(parsed.title);
    return {
      disposition: 'ingest',
      jakartaScope: 'dki_jakarta',
      actionability: 'actionable',
      primaryCategory: 'disasters_weather',
      incidentType: 'banjir',
      confidence: 'high',
      reasonCodes: ['triage_v1_ingest'],
      evidence: [{ field: 'title', exactQuote: parsed.title }],
    };
  };
}

/** Fake NineRouter transport: answers embeddings, records each embedded input, rejects chat. */
function embeddingTransport(embedInputs: string[]): NineRouterFetch {
  return async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (!url.endsWith('/v1/embeddings')) {
      throw new Error(`unexpected gateway request in this test: ${url}`);
    }
    const body = JSON.parse(String(init?.body ?? '{}')) as { input?: string };
    const text = body.input ?? '';
    embedInputs.push(text);
    return new Response(JSON.stringify({ data: [{ embedding: generateMockVector(text) }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
}

function countingAgent(payload: unknown): { agent: Agent; calls: () => number } {
  let count = 0;
  const agent = {
    generate: async () => {
      count += 1;
      return { text: JSON.stringify(payload) };
    },
  } as unknown as Agent;
  return { agent, calls: () => count };
}

const INTERPRETATION = {
  summary: STORY_TITLE,
  incidentType: 'banjir',
  severity: 'medium',
  primaryCategory: 'disasters_weather',
  location: { label: 'Mampang Prapatan, Jakarta Selatan', approximateCoordinates: null, precision: 'district' },
  eventTime: { value: null, precision: 'unknown' },
  entities: [],
  impacts: [],
  operationalStatus: 'active',
  evidence: [],
  conflictingInfo: [],
  uncertaintyNotes: [],
  confidence: 'high',
};

const NEW_INCIDENT = {
  decision: 'new_incident',
  candidateIncidentId: null,
  reasoning: 'Tidak ada kandidat.',
  supportingEvidence: [],
  contradictoryEvidence: [],
  distinctions: [],
  unresolvedQuestions: [],
  uncertainty: [],
};

const FULL_PERMISSIONS = {
  acquisition: true,
  titleModel: true,
  descriptionModel: true,
  titleRetention: true,
  descriptionRetention: true,
  derivedRetention: true,
  publicDisplay: false,
};

function triageOptions(extra: Record<string, unknown>) {
  return {
    sourceRemit: 'general news',
    checkAuthorization: async () => ({ cleared: true, permissions: FULL_PERMISSIONS }),
    findPriorDecision: async () => null,
    policyVersion: TRIAGE_POLICY_VERSION,
    concurrency: 1,
    // Shadow keeps every authorized item on the Stage B path, so the call count is the test subject.
    deterministicMode: 'shadow' as const,
    ...extra,
  };
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

async function seedSource(db: TestDatabase, sourceId: string): Promise<void> {
  await db.executor.query(
    `INSERT INTO waspada.traces (trace_id, dataset_kind, started_at, outcome, metadata)
     VALUES ('trace-seed', 'live', now(), 'succeeded', '{}'::jsonb)
     ON CONFLICT (trace_id, dataset_kind) DO NOTHING`,
  );
  await db.executor.query(
    `INSERT INTO waspada.source_registry (
       source_id, trace_id, registry_version, display_name, source_kind, remit,
       access_method, approved_hosts, access_restrictions, reuse_basis, registry_status,
       approval_status, health_status, auto_acquisition_enabled, auto_publication_policy
     )
     VALUES ($1, 'trace-seed', 1, 'Dedupe Fixture', 'newsroom', ARRAY['test'],
             'rss', ARRAY[]::text[], ARRAY[]::text[], $2,
             'active', 'approved', 'healthy', true, 'never')
     ON CONFLICT (source_id) DO NOTHING`,
    [sourceId, [...FULL_BASIS]],
  );
}

async function countRows(db: TestDatabase, sql: string, params: unknown[]): Promise<number> {
  const result = await db.executor.query<{ count: string }>(sql, params);
  return Number(result.rows[0]?.count ?? '0');
}

// --- Pure helpers ---

test('normalizedTitleKey ignores case, width, punctuation and whitespace; generic short titles get no key', () => {
  const base = normalizedTitleKey(STORY_TITLE);
  assert.ok(base);
  assert.equal(normalizedTitleKey(SYNDICATED_TITLE), base);
  assert.equal(normalizedTitleKey('ＢＡＮＪＩＲ rendam permukiman di Mampang Prapatan Jakarta Selatan'), base);
  assert.notEqual(normalizedTitleKey('Banjir rendam permukiman di Cawang Jakarta Timur'), base);
  assert.equal(normalizedTitleKey('Banjir'), null, 'a generic headline is never a duplicate key');
  assert.equal(normalizedTitleKey(null), null);
  assert.ok(MIN_DEDUPE_TITLE_CHARS >= 20);
});

test('the recent-item index blocks only a different item identity, and only inside the 48-hour window', () => {
  const index = createRecentItemIndex();
  const t0 = Date.parse('2026-11-11T08:00:00Z');
  index.remember('key-a', 'item-1', t0);
  assert.equal(index.isDuplicate('key-a', 'item-2', t0), true, 'a different item with the same title is a duplicate');
  assert.equal(index.isDuplicate('key-a', 'item-1', t0), false, 'the item that settled the title is not its own duplicate');
  assert.equal(index.isDuplicate('key-a', 'item-2', t0 + RECENT_ITEM_WINDOW_MS), true);
  assert.equal(index.isDuplicate('key-a', 'item-2', t0 + RECENT_ITEM_WINDOW_MS + 1), false);
  assert.equal(index.isDuplicate('key-b', 'item-2', t0), false);
});

test('the cycle revision dedupe admits the first revision per canonical URL or revision id', () => {
  const rev = (id: string, url: string) => ({ report_revision_id: id, canonical_url: url }) as unknown as StoredReportRevision;
  const dedupe = createCycleRevisionDedupe();
  assert.equal(dedupe.admit(rev('r1', 'https://example.test/1')), true);
  assert.equal(dedupe.admit(rev('r2', 'https://example.test/1')), false, 'same URL from another feed');
  assert.equal(dedupe.admit(rev('r1', 'https://example.test/2')), false, 'same revision id');
  assert.equal(dedupe.admit(rev('r3', 'https://example.test/3')), true);
});

test('live cycle knobs default to 6 h and 5 new triage calls, and bad input falls back to the defaults', () => {
  assert.equal(DEFAULT_LIVE_RSS_MAX_AGE_HOURS, 6);
  assert.equal(DEFAULT_LIVE_MAX_NEW_ITEMS_PER_CYCLE, 5);
  assert.deepEqual(parseLiveCycleConfig({}), { rssMaxAgeHours: 6, maxNewItemsPerCycle: 5 });
  assert.deepEqual(
    parseLiveCycleConfig({ LIVE_RSS_MAX_AGE_HOURS: '3', LIVE_MAX_NEW_ITEMS_PER_CYCLE: '0' }),
    { rssMaxAgeHours: 3, maxNewItemsPerCycle: 0 },
  );
  assert.deepEqual(
    parseLiveCycleConfig({ LIVE_RSS_MAX_AGE_HOURS: 'soon', LIVE_MAX_NEW_ITEMS_PER_CYCLE: '2.5' }),
    { rssMaxAgeHours: 6, maxNewItemsPerCycle: 5 },
  );
  assert.deepEqual(
    parseLiveCycleConfig({ LIVE_RSS_MAX_AGE_HOURS: '-1', LIVE_MAX_NEW_ITEMS_PER_CYCLE: '-3' }),
    { rssMaxAgeHours: 6, maxNewItemsPerCycle: 5 },
  );
});

// --- Cap (direct applyTriageGate) ---

const CAP_FEED: NewsFeedConfig = { url: 'https://example.test/cap.xml', sourceId: 'source-cap-test' };
const CAP_TITLES = [
  'Banjir rendam jalan di Cawang Jakarta Timur',
  'Kebakaran gudang di Tebet Jakarta Selatan',
  'Pohon tumbang menutup jalan di Kemang Jakarta Selatan',
  'Demonstrasi memblokir Jalan Merdeka Barat Jakarta Pusat',
];
const CAP_PUB = new Date(Date.parse(RETRIEVED_AT) - 60 * 60 * 1000).toUTCString();

function capStored(guid: string, title: string): StoredReportRevision {
  const hash = sha256Hex(title);
  return {
    report_revision_id: `rep-cap-${guid}`,
    source_id: CAP_FEED.sourceId,
    canonical_url: `https://example.test/cap/${guid}`,
    permitted_text: title,
    permitted_text_hash: hash,
    published_at: null,
    retrieved_at: RETRIEVED_AT,
    revision_status: 'unreviewed',
    chunks: [{ chunk_index: 0, text: title, span_start: 0, span_end: [...title].length }],
    content_hash: hash,
    source_revision_key: guid,
  };
}

test('the per-cycle fresh-call cap holds excess items with no call and no decision, and a later cycle evaluates them', async () => {
  const stored = CAP_TITLES.map((title, i) => capStored(`cap-${i}`, title));
  const classified = CAP_TITLES.map((title, i) => ({
    guid: `cap-${i}`,
    title,
    descriptionExcerpt: null,
    link: `https://example.test/cap/cap-${i}`,
    pubDate: CAP_PUB,
  }));
  const calls: string[] = [];
  const budget = { remaining: 2 };

  const first = await applyTriageGate(stored, classified, CAP_FEED, RETRIEVED_AT, triageOptions({
    callChat: ingestChat(calls),
    freshCallBudget: budget,
  }));
  assert.equal(calls.length, 2, 'only the budgeted items reach the model');
  assert.equal(first.triageCounts.budgetDeferred, 2);
  assert.equal(first.revisions.length, 2);
  assert.equal(first.held.length, 0, 'deferred items are not held as decided');
  assert.equal(budget.remaining, 0);

  // Kept revisions get a content-bound id, so match the decided items by their guid.
  const decided = new Set(first.revisions.map((rev) => rev.source_revision_key));
  const deferred = stored.filter((rev) => !decided.has(rev.source_revision_key));
  assert.equal(deferred.length, 2);

  const second = await applyTriageGate(deferred, classified, CAP_FEED, RETRIEVED_AT, triageOptions({
    callChat: ingestChat(calls),
    freshCallBudget: { remaining: 5 },
  }));
  assert.equal(calls.length, 4, 'the next cycle evaluates the deferred items');
  assert.equal(second.revisions.length, 2);
  assert.equal(second.triageCounts.budgetDeferred, 0);
});

// --- Identity-aware title dedupe (applyTriageGate) ---

function itemRevision(sourceId: string, guid: string, title: string, excerpt: string, url: string): StoredReportRevision {
  const text = `${title}\n\n${excerpt}`;
  const hash = sha256Hex(text);
  return {
    report_revision_id: `rep-item-${guid}-${hash.slice(0, 8)}`,
    source_id: sourceId,
    canonical_url: url,
    permitted_text: text,
    permitted_text_hash: hash,
    published_at: null,
    retrieved_at: RETRIEVED_AT,
    revision_status: 'unreviewed',
    chunks: [
      { chunk_index: 0, text: title, span_start: 0, span_end: [...title].length },
      { chunk_index: 1, text: excerpt, span_start: [...title].length + 2, span_end: [...text].length },
    ],
    content_hash: hash,
    source_revision_key: guid,
  };
}

function itemClassified(guid: string, title: string, excerpt: string, url: string) {
  return { guid, title, descriptionExcerpt: excerpt, link: url, pubDate: CAP_PUB };
}

test('a corrected description of the same item is not a duplicate: it takes the normal triage path', async () => {
  const url = 'https://example.test/correction/fix-1';
  const recentItems = createRecentItemIndex();
  const calls: string[] = [];
  const options = () => triageOptions({ callChat: ingestChat(calls), recentItems });

  const first = await applyTriageGate(
    [itemRevision(FEED_A.sourceId, 'fix-1', STORY_TITLE, EXCERPT_A, url)],
    [itemClassified('fix-1', STORY_TITLE, EXCERPT_A, url)],
    FEED_A,
    RETRIEVED_AT,
    options(),
  );
  assert.equal(calls.length, 1);
  assert.equal(first.revisions.length, 1);

  // The same article is corrected: same title, same source and guid, changed description.
  const second = await applyTriageGate(
    [itemRevision(FEED_A.sourceId, 'fix-1', STORY_TITLE, EXCERPT_B, url)],
    [itemClassified('fix-1', STORY_TITLE, EXCERPT_B, url)],
    FEED_A,
    RETRIEVED_AT,
    options(),
  );
  assert.equal(calls.length, 2, 'the corrected item goes through the model again');
  assert.equal(second.triageCounts.duplicate, 0, 'the same item is never its own duplicate');
  assert.equal(second.revisions.length, 1, 'the corrected version is kept');
  assert.equal(second.held.length, 0);
});

test('the same title from a different source or a different item is a duplicate with no model call', async () => {
  const recentItems = createRecentItemIndex();
  const calls: string[] = [];
  const options = () => triageOptions({ callChat: ingestChat(calls), recentItems });
  const originUrl = 'https://example.test/origin/1';

  const origin = await applyTriageGate(
    [itemRevision(FEED_A.sourceId, 'origin-1', STORY_TITLE, EXCERPT_A, originUrl)],
    [itemClassified('origin-1', STORY_TITLE, EXCERPT_A, originUrl)],
    FEED_A,
    RETRIEVED_AT,
    options(),
  );
  assert.equal(origin.revisions.length, 1);

  // Another feed carries the same headline under its own guid and URL.
  const syndicatedUrl = 'https://example.test/syndicated/9';
  const otherSource = await applyTriageGate(
    [itemRevision(FEED_B.sourceId, 'syndicated-9', SYNDICATED_TITLE, EXCERPT_B, syndicatedUrl)],
    [itemClassified('syndicated-9', SYNDICATED_TITLE, EXCERPT_B, syndicatedUrl)],
    FEED_B,
    RETRIEVED_AT,
    options(),
  );

  // The same feed re-lists the story under a different guid and URL.
  const relistedUrl = 'https://example.test/origin/3';
  const otherItem = await applyTriageGate(
    [itemRevision(FEED_A.sourceId, 'relisted-3', SYNDICATED_TITLE, EXCERPT_B, relistedUrl)],
    [itemClassified('relisted-3', SYNDICATED_TITLE, EXCERPT_B, relistedUrl)],
    FEED_A,
    RETRIEVED_AT,
    options(),
  );

  assert.equal(calls.length, 1, 'no model call for either duplicate');
  for (const result of [otherSource, otherItem]) {
    assert.equal(result.triageCounts.duplicate, 1);
    assert.equal(result.revisions.length, 0, 'no revision for a duplicate');
    assert.deepEqual(result.held[0]?.decision.reasonCodes, ['duplicate_item']);
  }
});

// --- DB-backed cycle behaviour ---

test('the same story in two feeds within one cycle makes one triage call and one ai job', async () => {
  const db = await createMigratedDatabase();
  try {
    await seedSource(db, FEED_A.sourceId);
    await seedSource(db, FEED_B.sourceId);
    const xmlByUrl = new Map<string, string>([
      [FEED_A.url, feedXml([{ guid: 'a-1', title: STORY_TITLE, link: 'https://example.test/a/1', excerpt: EXCERPT_A }], recentPubDate())],
      [FEED_B.url, feedXml([{ guid: 'b-1', title: SYNDICATED_TITLE, link: 'https://example.test/b/1', excerpt: EXCERPT_B }], recentPubDate())],
    ]);
    const calls: string[] = [];
    const gate = buildLiveTriageGate(LIVE_ENV, db.executor, {
      recentItems: createRecentItemIndex(),
      maxFreshCallsPerCycle: 5,
    });
    const runtime = createLiveNewsPollRuntime({
      feeds: [FEED_A, FEED_B],
      fetchFn: xmlFetch((url) => xmlByUrl.get(url) ?? ''),
      triage: { ...gate, callChat: ingestChat(calls) },
    });

    // serve:live shape: per-feed poll, cycle-wide revision dedupe, persist before the next feed.
    const dedupe = createCycleRevisionDedupe();
    for (const feed of [FEED_A, FEED_B]) {
      const res = await runtime.pollFeed(feed);
      const admitted = res.revisions.filter((rev) => dedupe.admit(rev));
      await runGatedRssCycle(db.executor, {
        datasetKind: 'live',
        revisions: admitted,
        held: res.held,
        policyVersion: TRIAGE_POLICY_VERSION,
      });
    }

    assert.equal(calls.length, 1, 'one triage call for the story');
    assert.equal(await countRows(db, `SELECT COUNT(*)::text AS count FROM waspada.ai_jobs WHERE dataset_kind = 'live'`, []), 1);
    const decision = await db.executor.query<{ reason_codes: string[] }>(
      `SELECT reason_codes FROM waspada.news_triage_decisions
       WHERE dataset_kind = 'live' AND item_identity_hash = $1`,
      [newsTriageIdentityHash(FEED_B.sourceId, 'b-1')],
    );
    assert.ok(decision.rows[0]?.reason_codes.includes('duplicate_item'), 'the syndicated copy is recorded as a duplicate');
  } finally {
    await db.close();
  }
});

test('a normalised-title duplicate in a later cycle makes no model call and is recorded as a duplicate', async () => {
  const db = await createMigratedDatabase();
  try {
    await seedSource(db, FEED_A.sourceId);
    let xml = feedXml([{ guid: 'a-1', title: STORY_TITLE, link: 'https://example.test/a/1', excerpt: EXCERPT_A }], recentPubDate());
    const calls: string[] = [];
    const gate = buildLiveTriageGate(LIVE_ENV, db.executor, {
      recentItems: createRecentItemIndex(),
      maxFreshCallsPerCycle: 5,
    });
    const runtime = createLiveNewsPollRuntime({
      feeds: [FEED_A],
      fetchFn: xmlFetch(() => xml),
      triage: { ...gate, callChat: ingestChat(calls) },
    });

    const cycleOne = await runtime.pollFeed(FEED_A);
    await runGatedRssCycle(db.executor, {
      datasetKind: 'live',
      revisions: cycleOne.revisions,
      held: cycleOne.held,
      policyVersion: TRIAGE_POLICY_VERSION,
    });
    assert.equal(calls.length, 1);

    xml = feedXml([{ guid: 'a-2', title: SYNDICATED_TITLE, link: 'https://example.test/a/2', excerpt: EXCERPT_B }], recentPubDate());
    const cycleTwo = await runtime.pollFeed(FEED_A);
    assert.equal(calls.length, 1, 'no model call for the duplicate in the later cycle');
    assert.equal(cycleTwo.revisions.length, 0, 'no revision for the duplicate');
    const duplicate = cycleTwo.held.find((held) => held.sourceRevisionKey === 'a-2');
    assert.ok(duplicate, 'the duplicate is held as a decision');
    assert.deepEqual(duplicate.decision.reasonCodes, ['duplicate_item']);
    assert.equal(duplicate.decision.modelStatus, 'skipped_stage_a');
    assert.equal(cycleTwo.triageCounts?.duplicate, 1);

    await runGatedRssCycle(db.executor, {
      datasetKind: 'live',
      revisions: cycleTwo.revisions,
      held: cycleTwo.held,
      policyVersion: TRIAGE_POLICY_VERSION,
    });
    const identity = newsTriageIdentityHash(FEED_A.sourceId, 'a-2');
    const decision = await db.executor.query<{ reason_codes: string[] }>(
      `SELECT reason_codes FROM waspada.news_triage_decisions WHERE dataset_kind = 'live' AND item_identity_hash = $1`,
      [identity],
    );
    assert.ok(decision.rows[0]?.reason_codes.includes('duplicate_item'));
    assert.equal(
      await countRows(db, `SELECT COUNT(*)::text AS count FROM waspada.news_triage_attempts WHERE dataset_kind = 'live' AND item_identity_hash = $1`, [identity]),
      1,
      'the duplicate has one attempt row',
    );
    assert.equal(
      await countRows(db, `SELECT COUNT(*)::text AS count FROM waspada.ai_jobs WHERE dataset_kind = 'live'`, []),
      1,
      'still one job',
    );
  } finally {
    await db.close();
  }
});

test('a mocked RSS article makes at most three gateway calls: one triage, one interpretation, one embedding', async () => {
  const db = await createMigratedDatabase();
  const embedInputs: string[] = [];
  try {
    await seedSource(db, FEED_A.sourceId);
    setNineRouterRateGate(createNineRouterRateGate({
      transport: embeddingTransport(embedInputs),
      clock: NO_SLEEP_CLOCK,
      log: () => {},
    }));
    const triageCalls: string[] = [];
    const gate = buildLiveTriageGate(LIVE_ENV, db.executor, {
      recentItems: createRecentItemIndex(),
      maxFreshCallsPerCycle: 5,
    });
    const runtime = createLiveNewsPollRuntime({
      feeds: [FEED_A],
      fetchFn: xmlFetch(() => feedXml([{ guid: 'a-1', title: STORY_TITLE, link: 'https://example.test/a/1', excerpt: EXCERPT_A }], recentPubDate())),
      triage: { ...gate, callChat: ingestChat(triageCalls) },
    });
    const res = await runtime.pollFeed(FEED_A);
    assert.equal(res.revisions.length, 1);
    await runGatedRssCycle(db.executor, {
      datasetKind: 'live',
      revisions: res.revisions,
      held: res.held,
      policyVersion: TRIAGE_POLICY_VERSION,
    });

    const interpreter = countingAgent(INTERPRETATION);
    const correlator = countingAgent(NEW_INCIDENT);
    const runner = createJobRunner({
      executor: db.executor,
      config: LIVE_CONFIG,
      agentOverrides: { interpreter: interpreter.agent, correlator: correlator.agent },
    });
    assert.equal(await runner.processNextJob('live'), true);

    const gateway = getNineRouterCallCounts();
    assert.deepEqual(embedInputs, [STORY_TITLE], 'the only embedding is the title chunk, reused as the query');
    assert.equal(correlator.calls(), 0, 'no candidates: no correlation model call');
    const total = triageCalls.length + interpreter.calls() + gateway.chat + gateway.embed;
    assert.equal(triageCalls.length, 1);
    assert.equal(interpreter.calls(), 1);
    assert.equal(gateway.embed, 1);
    assert.ok(total <= 3, `total gateway calls ${total} must be at most 3`);
    const job = await db.executor.query<{ status: string }>(`SELECT status FROM waspada.ai_jobs WHERE dataset_kind = 'live'`);
    assert.equal(job.rows[0]?.status, 'completed');
  } finally {
    setNineRouterRateGate(undefined);
    await db.close();
  }
});
