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
import type { AiJob, AuthoredFeed, LocalPipelineStore } from './contracts.js';
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

interface RenewalEvent {
  readonly at: string;
  readonly result: boolean;
  readonly threw?: boolean;
}

function createAsyncQueue<T>() {
  const values: T[] = [];
  const readers: Array<(value: T) => void> = [];
  return {
    push(value: T): void {
      const reader = readers.shift();
      if (reader) reader(value);
      else values.push(value);
    },
    next(timeoutMs = 5_000): Promise<T> {
      const value = values.shift();
      if (value !== undefined) return Promise.resolve(value);
      return new Promise<T>((resolve, reject) => {
        const reader = (nextValue: T) => {
          clearTimeout(timer);
          resolve(nextValue);
        };
        const timer = setTimeout(() => {
          const index = readers.indexOf(reader);
          if (index >= 0) readers.splice(index, 1);
          reject(new Error('synthetic_event_timeout'));
        }, timeoutMs);
        readers.push(reader);
      });
    },
  };
}

function observeRenewals(
  store: LocalPipelineStore,
  renew?: (job: AiJob, now: string, leaseDurationMs?: number) => Promise<boolean>,
) {
  const events = createAsyncQueue<RenewalEvent>();
  const observed = new Proxy(store, {
    get(target, property, receiver) {
      if (property === 'renewAi') {
        return async (job: AiJob, now: string, leaseDurationMs?: number) => {
          try {
            const result = renew
              ? await renew(job, now, leaseDurationMs)
              : await target.renewAi(job, now, leaseDurationMs);
            events.push({ at: now, result });
            return result;
          } catch {
            events.push({ at: now, result: false, threw: true });
            throw new Error('synthetic_renewal_failed');
          }
        };
      }
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as LocalPipelineStore;
  return { store: observed, events };
}

async function withinBound<T>(promise: Promise<T>, timeoutMs = 5_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('synthetic_wait_timeout')), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
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
  let cancelCalls = 0;
  const adapter: ModelCapabilityAdapter = { ...models.adapter, extract: async (request) => {
    if (firstCall) { firstCall = false; aiStarted(); return new Promise(() => undefined); }
    return models.adapter.extract(request);
  } };
  const database = await openLocalPipelineDatabase({ profileId: models.profileId });
  try {
    const store = createLocalPipelineStore(database.executor);
    const processor = createLocalPipelineProcessor({ store, executor: database.executor, ...models, adapter,
      now: () => start, modelTimeoutMs: 250, cancel: () => { cancelCalls++; } });
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
    assert.equal(cancelCalls, 1, 'the processor fallback timeout cancels the active transport');
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

test('long AI wait renews the five-minute lease and completes after its original expiry', { timeout: 90_000 }, async () => {
  const models = createLocalMockModels();
  const counted = countModels(models.adapter);
  let now = start;
  let signalStarted!: () => void;
  const started = new Promise<void>((resolve) => { signalStarted = resolve; });
  let finishExtraction!: (outcome: Awaited<ReturnType<ModelCapabilityAdapter['extract']>>) => void;
  let extractionRequest!: Parameters<ModelCapabilityAdapter['extract']>[0];
  const adapter: ModelCapabilityAdapter = {
    ...counted.adapter,
    extract: async (request) => {
      counted.calls.extraction++;
      extractionRequest = request;
      signalStarted();
      return await new Promise((resolve) => { finishExtraction = resolve; });
    },
  };
  const database = await openLocalPipelineDatabase({ profileId: models.profileId });
  try {
    const backingStore = createLocalPipelineStore(database.executor);
    let renewalsInFlight = 0;
    let maxRenewalsInFlight = 0;
    const observed = observeRenewals(backingStore, async (job, renewalTime, leaseDurationMs) => {
      renewalsInFlight++;
      maxRenewalsInFlight = Math.max(maxRenewalsInFlight, renewalsInFlight);
      try {
        await new Promise<void>((resolve) => setTimeout(resolve, 25));
        return await backingStore.renewAi(job, renewalTime, leaseDurationMs);
      } finally { renewalsInFlight--; }
    });
    const processor = createLocalPipelineProcessor({ store: observed.store, executor: database.executor, ...models,
      adapter, now: () => now, modelTimeoutMs: 901_000, leaseRenewIntervalMs: 20 });
    await backingStore.capture(await authoredFeed(), now);
    await processor.processIngestion();
    const processing = processor.processAi();
    await withinBound(started);

    const firstRenewal = await withinBound(observed.events.next());
    assert.deepEqual(firstRenewal, { at: start, result: true });
    now = '2026-10-12T07:04:00.000Z';
    const secondRenewal = await withinBound(observed.events.next());
    assert.deepEqual(secondRenewal, { at: now, result: true });

    now = '2026-10-12T07:06:00.000Z';
    const lease = await database.executor.query<{ status: string; lease_expires_at: string }>(
      'SELECT status, lease_expires_at::text AS lease_expires_at FROM waspada.local_ai_jobs');
    assert.equal(lease.rows[0]?.status, 'leased');
    assert.ok(Date.parse(lease.rows[0]!.lease_expires_at) > Date.parse(now));
    assert.equal(await backingStore.claimAi(now, 5 * 60_000), null, 'another worker cannot claim the renewed job');

    finishExtraction(await models.adapter.extract(extractionRequest));
    await withinBound(processing, 10_000);
    const summary = await backingStore.summary();
    assert.equal(maxRenewalsInFlight, 1, 'slow renewal calls never overlap');
    assert.equal(summary.ai.completed, 1);
    assert.equal(summary.proposals, 1);
    assert.deepEqual(counted.calls, { extraction: 1, embedding: 1, reasoning: 1, classification: 0 });
  } finally { await database.close(); }
});

test('lost long-wait renewal cancels late persistence and expired lease recovers', { timeout: 90_000 }, async () => {
  const models = createLocalMockModels();
  let now = start;
  let signalStarted!: () => void;
  const started = new Promise<void>((resolve) => { signalStarted = resolve; });
  let finishExtraction!: (outcome: Awaited<ReturnType<ModelCapabilityAdapter['extract']>>) => void;
  let extractionRequest!: Parameters<ModelCapabilityAdapter['extract']>[0];
  let cancelCalls = 0;
  const adapter: ModelCapabilityAdapter = {
    ...models.adapter,
    extract: async (request) => {
      extractionRequest = request;
      signalStarted();
      return await new Promise((resolve) => { finishExtraction = resolve; });
    },
  };
  const database = await openLocalPipelineDatabase({ profileId: models.profileId });
  try {
    const backingStore = createLocalPipelineStore(database.executor);
    const observed = observeRenewals(backingStore, async (job, _requestedAt, leaseDurationMs) =>
      await backingStore.renewAi(job, now, leaseDurationMs));
    const processor = createLocalPipelineProcessor({ store: observed.store, executor: database.executor, ...models,
      adapter, now: () => now, modelTimeoutMs: 901_000, leaseRenewIntervalMs: 100,
      cancel: () => { cancelCalls++; } });
    await backingStore.capture(await authoredFeed(), now);
    await processor.processIngestion();
    const processing = processor.processAi();
    await withinBound(started);
    now = '2026-10-12T07:05:00.000Z';
    const failedRenewal = await withinBound(observed.events.next());
    assert.deepEqual(failedRenewal, { at: '2026-10-12T07:05:00.000Z', result: false });
    await withinBound(processing, 2_000);
    assert.equal(cancelCalls, 1);

    const receipts = await database.executor.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM waspada.local_ai_receipts');
    assert.equal(receipts.rows[0]?.count, 0, 'the ignored late model result wrote no stage receipt');
    assert.equal((await backingStore.summary()).proposals, 0);

    const recovered = await backingStore.recover(now);
    assert.deepEqual(recovered, { ingestion: 0, ai: 1 });
    now = '2026-10-12T07:05:30.000Z';
    const retry = await backingStore.claimAi(now, 5 * 60_000);
    assert.equal(retry?.attemptCount, 2, 'recovery preserves the attempt and the next claim increments it');

    finishExtraction(await models.adapter.extract(extractionRequest));
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    const stillNoReceipt = await database.executor.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM waspada.local_ai_receipts');
    assert.equal(stillNoReceipt.rows[0]?.count, 0, 'the old result cannot write under the replacement lease');
    assert.equal((await backingStore.summary()).proposals, 0);
  } finally { await database.close(); }
});

test('renewal exception cancels the provider and fails closed before late stage writes', { timeout: 90_000 }, async () => {
  const models = createLocalMockModels();
  let signalStarted!: () => void;
  const started = new Promise<void>((resolve) => { signalStarted = resolve; });
  let finishExtraction!: (outcome: Awaited<ReturnType<ModelCapabilityAdapter['extract']>>) => void;
  let extractionRequest!: Parameters<ModelCapabilityAdapter['extract']>[0];
  let cancelCalls = 0;
  const adapter: ModelCapabilityAdapter = {
    ...models.adapter,
    extract: async (request) => {
      extractionRequest = request;
      signalStarted();
      return await new Promise((resolve) => { finishExtraction = resolve; });
    },
  };
  const database = await openLocalPipelineDatabase({ profileId: models.profileId });
  try {
    const backingStore = createLocalPipelineStore(database.executor);
    const observed = observeRenewals(backingStore, async () => { throw new Error('private_renewal_failure'); });
    const processor = createLocalPipelineProcessor({ store: observed.store, executor: database.executor, ...models,
      adapter, now: () => start, modelTimeoutMs: 901_000, leaseRenewIntervalMs: 15,
      cancel: () => { cancelCalls++; } });
    await backingStore.capture(await authoredFeed(), start);
    await processor.processIngestion();
    const processing = processor.processAi();
    await withinBound(started);
    const failedRenewal = await withinBound(observed.events.next());
    assert.deepEqual(failedRenewal, { at: start, result: false, threw: true });
    await withinBound(processing, 2_000);
    assert.equal(cancelCalls, 1);

    finishExtraction(await models.adapter.extract(extractionRequest));
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    const receipts = await database.executor.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM waspada.local_ai_receipts');
    assert.equal(receipts.rows[0]?.count, 0);
    const jobs = await database.executor.query<{ last_failure_code: string | null }>(
      'SELECT last_failure_code FROM waspada.local_ai_jobs');
    assert.equal(jobs.rows[0]?.last_failure_code, null, 'private renewal errors do not enter job state');
  } finally { await database.close(); }
});

test('abort settles an ignored model wait and removes the renewal timer', { timeout: 90_000 }, async () => {
  const models = createLocalMockModels();
  const counted = countModels(models.adapter);
  let now = start;
  let signalStarted!: () => void;
  const started = new Promise<void>((resolve) => { signalStarted = resolve; });
  let finishExtraction!: (outcome: Awaited<ReturnType<ModelCapabilityAdapter['extract']>>) => void;
  let extractionRequest!: Parameters<ModelCapabilityAdapter['extract']>[0];
  let cancelCalls = 0;
  const adapter: ModelCapabilityAdapter = {
    ...counted.adapter,
    extract: async (request) => {
      counted.calls.extraction++;
      extractionRequest = request;
      signalStarted();
      return await new Promise((resolve) => { finishExtraction = resolve; });
    },
  };
  const controller = new AbortController();
  const database = await openLocalPipelineDatabase({ profileId: models.profileId });
  try {
    const backingStore = createLocalPipelineStore(database.executor);
    const observed = observeRenewals(backingStore);
    const processor = createLocalPipelineProcessor({ store: observed.store, executor: database.executor, ...models,
      adapter, now: () => now, signal: controller.signal, cancel: () => { cancelCalls++; },
      modelTimeoutMs: 901_000, leaseRenewIntervalMs: 15 });
    await backingStore.capture(await authoredFeed(), now);
    await processor.processIngestion();
    const processing = processor.processAi();
    await withinBound(started);
    assert.equal((await withinBound(observed.events.next())).result, true);

    controller.abort();
    await withinBound(processing, 2_000);
    assert.equal(cancelCalls, 1);
    assert.equal(counted.calls.extraction, 1);
    assert.equal(counted.calls.embedding, 0);
    assert.equal(counted.calls.reasoning, 0);
    assert.equal((await backingStore.summary()).ai.retry, 1);
    const renewalsAtReturn = await database.executor.query<{ lease_expires_at: string | null }>(
      'SELECT lease_expires_at::text AS lease_expires_at FROM waspada.local_ai_jobs');
    assert.equal(renewalsAtReturn.rows[0]?.lease_expires_at, null, 'cancellation releases the owned retryable job');

    const renewalAfterReturn = await observed.events.next(20).catch(() => null);
    assert.equal(renewalAfterReturn, null, 'no renewal starts after processor return');
    finishExtraction(await models.adapter.extract(extractionRequest));
    const receiptRows = await database.executor.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM waspada.local_ai_receipts');
    assert.equal(receiptRows.rows[0]?.count, 0);
  } finally { await database.close(); }
});
