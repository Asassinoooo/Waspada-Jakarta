import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openLocalPipelineDatabase } from './database.js';
import { createLocalPipelineStore } from './store.js';
import { createLocalPipelineProcessor } from './processor.js';
import { createLocalMockModels } from './mock-models.js';
import { parseAuthoredFeed } from './feed.js';
import type { AuthoredFeed, LocalPipelineStore } from './contracts.js';
import type { ModelCapabilityAdapter } from '../../apps/worker/src/layers/l2-model-grounding/contracts.js';
import { runLocalSchedule } from './scheduler.js';

const start = '2026-10-12T07:00:00.000Z';
async function authoredFeed(): Promise<AuthoredFeed> {
  return parseAuthoredFeed(await readFile(new URL('./fixtures/feed.json', import.meta.url), 'utf8'));
}
function countModels(adapter: ModelCapabilityAdapter) {
  const calls = { extraction: 0, embedding: 0, reasoning: 0, classification: 0 };
  const counted: ModelCapabilityAdapter = {
    extract: async (request) => { calls.extraction++; return adapter.extract(request); },
    embed: async (request) => { calls.embedding++; return adapter.embed(request); },
    reason: async (request) => { calls.reasoning++; return adapter.reason(request); },
    classify: async (request) => { calls.classification++; return adapter.classify(request); },
  };
  return { adapter: counted, calls };
}
async function assertPrivateOnly(executor: Awaited<ReturnType<typeof openLocalPipelineDatabase>>['executor']) {
  for (const table of ['event_versions', 'impact_versions', 'publication_decisions', 'publication_claim_decisions',
    'publication_outbox', 'public_event_history_review_decisions', 'freshness_transitions']) {
    const result = await executor.query<{ count: number }>(`SELECT count(*)::int AS count FROM waspada.${table}`);
    assert.equal(result.rows[0].count, 0, table);
  }
  const revisions = await executor.query<{ dataset_kind: string; revision_status: string }>('SELECT dataset_kind,revision_status FROM waspada.report_revisions');
  assert.ok(revisions.rows.length > 0);
  assert.ok(revisions.rows.every((row) => row.dataset_kind === 'synthetic' && row.revision_status === 'unreviewed'));
}

test('canonical local composition: unchanged polling, queued snapshots, changed provenance and private proposals', { timeout: 90_000 }, async () => {
  const models = createLocalMockModels();
  const counted = countModels(models.adapter);
  const database = await openLocalPipelineDatabase({ profileId: models.profileId });
  try {
    const store = createLocalPipelineStore(database.executor);
    const processor = createLocalPipelineProcessor({ store, executor: database.executor, ...models, adapter: counted.adapter, now: () => start });
    const original = await authoredFeed();
    assert.equal(original.reports.length, 1);
    assert.deepEqual(await store.capture(original, start), { captured: 1, unchanged: 0 });
    assert.deepEqual(await store.capture(original, start), { captured: 0, unchanged: 1 });
    const changed = { ...original, reports: original.reports.map((report) => ({ ...report, text: `${report.text}\nPembaruan sintetis: latihan diperpanjang.` })) };
    // A later feed must not alter the queued first revision.
    assert.equal((await store.capture(changed, start)).captured, 1);
    await processor.processIngestion();
    await processor.processIngestion();
    const revisions = await database.executor.query<{ revision_id: string; supersedes_id: string | null; permitted_text: string; content_hash: string }>(
      'SELECT report_revision_id AS revision_id,supersedes_id,permitted_text,content_hash FROM waspada.report_revisions ORDER BY source_revision_key');
    assert.equal(revisions.rows.length, 2);
    const first = revisions.rows.find((row) => row.supersedes_id === null)!;
    const second = revisions.rows.find((row) => row.supersedes_id !== null)!;
    assert.equal(second.supersedes_id, first.revision_id);
    assert.notEqual(first.content_hash, second.content_hash);
    assert.equal(first.permitted_text.includes('latihan diperpanjang'), false);
    assert.equal(second.permitted_text.includes('latihan diperpanjang'), true);
    await processor.processAi();
    await processor.processAi();
    const summary = await store.summary();
    assert.equal(summary.ingestion.completed, 2);
    assert.equal(summary.ai.completed, 2);
    assert.equal(summary.proposals, 2);
    const contexts = await database.executor.query<{ record: { evidence: { relation: string }[]; missing_fields: string[]; conflicts: string[] } }>(
      'SELECT record_json AS record FROM waspada.grounding_contexts');
    assert.equal(contexts.rows.length, 2);
    assert.ok(contexts.rows.every(({ record }) => record.evidence.some((ref) => ref.relation === 'contradicts') &&
      record.missing_fields.includes('event_time') && record.conflicts.length > 0), 'contrary evidence and unknown fields survive grounding');
    const origins = await database.executor.query<{ independence_status: string }>('SELECT independence_status FROM waspada.evidence_origins');
    assert.ok(origins.rows.every((row) => row.independence_status === 'unknown'));
    const before = { ...counted.calls };
    assert.equal((await store.capture(changed, start)).captured, 0);
    await processor.processIngestion();
    await processor.processAi();
    assert.deepEqual(counted.calls, before);
    assert.deepEqual(before, { extraction: 2, embedding: 2, reasoning: 2, classification: 0 });
    assert.equal((await store.capture(original, start)).captured, 1, 'A→B→A creates a third source version');
    await processor.processIngestion();
    await processor.processAi();
    assert.equal((await store.summary()).proposals, 3);
    await assertPrivateOnly(database.executor);
  } finally { await database.close(); }
});

test('invalid model output exhausts bounded retries while L1 evidence remains recoverable', { timeout: 90_000 }, async () => {
  const models = createLocalMockModels();
  let calls = 0;
  const adapter: ModelCapabilityAdapter = { ...models.adapter, extract: async () => {
    calls++;
    return { status: 'invalid_output', capability: 'extraction', reason: 'synthetic_bad_json' };
  } };
  const database = await openLocalPipelineDatabase({ profileId: models.profileId });
  let now = start;
  try {
    const store = createLocalPipelineStore(database.executor);
    const processor = createLocalPipelineProcessor({ store, executor: database.executor, ...models, adapter, now: () => now });
    await store.capture(await authoredFeed(), now);
    await processor.processIngestion();
    for (let attempt = 1; attempt <= 5; attempt++) {
      await processor.processAi();
      assert.equal(calls, attempt);
      await processor.processAi();
      assert.equal(calls, attempt, 'retry backoff prevents immediate repeated inference');
      now = new Date(Date.parse(now) + [30_000, 60_000, 120_000, 120_000, 120_000][attempt - 1]).toISOString();
    }
    const summary = await store.summary();
    assert.equal(summary.ingestion.completed, 1);
    assert.equal(summary.ai.terminal, 1);
    assert.equal(summary.proposals, 0);
    const chunks = await database.executor.query<{ count: number }>('SELECT count(*)::int AS count FROM waspada.evidence_chunks');
    assert.equal(chunks.rows[0].count, 1);
    const failure = await database.executor.query<{ last_failure_code: string }>('SELECT last_failure_code FROM waspada.local_ai_jobs');
    assert.equal(failure.rows[0].last_failure_code, 'invalid_output');
    await assertPrivateOnly(database.executor);
  } finally { await database.close(); }
});

test('model failure retains L1, later collection succeeds, retry reuses stages and never stores raw errors', { timeout: 90_000 }, async () => {
  const models = createLocalMockModels();
  const counted = countModels(models.adapter);
  const sentinel = 'PRIVATE_PROVIDER_KEY_AND_RAW_BODY_8aa412';
  let failed = false;
  const adapter: ModelCapabilityAdapter = { ...counted.adapter, reason: async (request) => {
    if (!failed) { failed = true; throw new Error(sentinel); }
    return counted.adapter.reason(request);
  } };
  let now = start;
  const database = await openLocalPipelineDatabase({ profileId: models.profileId });
  try {
    const store = createLocalPipelineStore(database.executor);
    const processor = createLocalPipelineProcessor({ store, executor: database.executor, ...models, adapter, now: () => now });
    const feed = await authoredFeed();
    await store.capture(feed, now);
    await processor.processIngestion();
    await processor.processAi();
    let summary = await store.summary();
    assert.equal(summary.ingestion.completed, 1);
    assert.equal(summary.ai.retry, 1);
    assert.equal(summary.proposals, 0);
    const next = { ...feed, reports: feed.reports.map((report) => ({ ...report, id: `${report.id}-next` })) };
    await store.capture(next, now);
    await processor.processIngestion();
    await processor.processAi();
    assert.equal((await store.summary()).proposals, 1, 'later report proceeds while earlier AI awaits backoff');
    now = '2026-10-12T07:01:00.000Z';
    await processor.processAi();
    summary = await store.summary();
    assert.equal(summary.ai.completed, 2);
    assert.equal(summary.proposals, 2);
    assert.equal(counted.calls.extraction, 2, 'committed extraction reused on reasoning retry');
    assert.equal(counted.calls.embedding, 2, 'committed embedding reused on reasoning retry');
    const tables = await database.executor.query<{ tablename: string }>("SELECT tablename FROM pg_tables WHERE schemaname='waspada'");
    for (const { tablename } of tables.rows) {
      assert.match(tablename, /^[a-z0-9_]+$/);
      const rows = await database.executor.query(`SELECT row_to_json(t) AS data FROM waspada.${tablename} t`);
      assert.equal(JSON.stringify(rows.rows).includes(sentinel), false, tablename);
    }
    await assertPrivateOnly(database.executor);
  } finally { await database.close(); }
});

test('actual PGlite capture continues during a pending model and timeout leaves recoverable AI work', { timeout: 90_000 }, async () => {
  const models = createLocalMockModels();
  let aiStarted!: () => void;
  const started = new Promise<void>((resolve) => { aiStarted = resolve; });
  let firstCall = true;
  const adapter: ModelCapabilityAdapter = { ...models.adapter, extract: async (request) => {
    if (firstCall) { firstCall = false; aiStarted(); return new Promise(() => undefined); }
    return models.adapter.extract(request);
  } };
  const database = await openLocalPipelineDatabase({ profileId: models.profileId });
  try {
    const store = createLocalPipelineStore(database.executor);
    const processor = createLocalPipelineProcessor({ store, executor: database.executor, ...models, adapter, now: () => start, modelTimeoutMs: 250 });
    const original = await authoredFeed();
    const changed = { ...original, reports: original.reports.map((report) => ({ ...report, text: `${report.text}\nVersi latihan kedua.` })) };
    let poll = 0;
    await runLocalSchedule({ store, processor, now: () => start, intervalMs: 1000, maxPolls: 2,
      readFeed: async () => ++poll === 1 ? original : changed,
      sleep: async () => {
        if (poll === 1) {
          let deadline: ReturnType<typeof setTimeout> | undefined;
          try { await Promise.race([started, new Promise<never>((_, reject) => { deadline = setTimeout(() => reject(new Error('AI did not start after L1')), 5000); })]); }
          finally { clearTimeout(deadline); }
        }
      },
    });
    const summary = await store.summary();
    assert.equal(summary.snapshots, 2);
    assert.equal(summary.ingestion.completed, 2);
    assert.equal(summary.ai.retry, 1);
    assert.equal(summary.ai.completed, 1);
    assert.equal(summary.proposals, 1);
    await assertPrivateOnly(database.executor);
  } finally { await database.close(); }
});

test('file-backed restart after proposal commit but before completion reuses every model stage', { timeout: 90_000 }, async () => {
  const models = createLocalMockModels();
  const counted = countModels(models.adapter);
  const dataDir = await mkdtemp(join(tmpdir(), 'waspada-local-replay-'));
  let database = await openLocalPipelineDatabase({ dataDir, profileId: models.profileId });
  let isOpen = true;
  try {
    const store = createLocalPipelineStore(database.executor);
    // Simulate a lost completion acknowledgement after the proposal receipt committed.
    const lostAckStore: LocalPipelineStore = new Proxy(store, {
      get(target, property, receiver) {
        if (property === 'completeAi') return async () => { throw new Error('synthetic_lost_ack'); };
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const processor = createLocalPipelineProcessor({ store: lostAckStore, executor: database.executor, ...models, adapter: counted.adapter, now: () => start });
    const feed = await authoredFeed();
    await store.capture(feed, start);
    await processor.processIngestion();
    await processor.processAi();
    assert.equal((await store.summary()).proposals, 1);
    const priorCalls = { ...counted.calls };
    await database.close();
    isOpen = false;
    database = await openLocalPipelineDatabase({ dataDir, profileId: models.profileId });
    isOpen = true;
    const reopened = createLocalPipelineStore(database.executor);
    const resumed = createLocalPipelineProcessor({ store: reopened, executor: database.executor, ...models, adapter: counted.adapter,
      now: () => '2026-10-12T07:01:00.000Z' });
    assert.deepEqual(await reopened.capture(feed, '2026-10-12T07:01:00.000Z'), { captured: 0, unchanged: 1 });
    await resumed.processIngestion();
    await resumed.processAi();
    assert.deepEqual(counted.calls, priorCalls);
    assert.equal((await reopened.summary()).proposals, 1);
    assert.equal((await reopened.summary()).ai.completed, 1);
    await assertPrivateOnly(database.executor);
  } finally {
    if (isOpen) await database.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
