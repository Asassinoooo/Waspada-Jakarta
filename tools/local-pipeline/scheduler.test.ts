import assert from 'node:assert/strict';
import test from 'node:test';
import { LOCAL_FEED_SCHEMA, LOCAL_SOURCE_ID, type AuthoredFeed, type LocalPipelineStore } from './contracts.js';
import { runLocalSchedule, abortableSleep } from './scheduler.js';

const feed: AuthoredFeed = { schemaVersion: LOCAL_FEED_SCHEMA, sourceId: LOCAL_SOURCE_ID, datasetKind: 'synthetic', reports: [] };
function schedulerStore(capture: LocalPipelineStore['capture']): LocalPipelineStore {
  return { capture, recover: async () => ({ ingestion: 0, ai: 0 }) } as LocalPipelineStore;
}
test('collection captures a changed report while the independent AI worker is still awaiting', async () => {
  let releaseAi!: () => void;
  let startedAi!: () => void;
  const aiStarted = new Promise<void>((resolve) => { startedAi = resolve; });
  const aiPending = new Promise<void>((resolve) => { releaseAi = resolve; });
  let captured = 0;
  let finishedAi = false;
  let aiCalls = 0;
  const store = schedulerStore(async () => {
    captured++;
    if (captured === 2) { assert.equal(finishedAi, false); releaseAi(); }
    return { captured: 1, unchanged: 0 };
  });
  const result = await runLocalSchedule({ store, now: () => '2026-10-12T00:00:00Z', readFeed: async () => feed,
    intervalMs: 1000, maxPolls: 2,
    sleep: async () => { if (captured === 1) await aiStarted; },
    processor: { processIngestion: async () => undefined, processAi: async () => {
      aiCalls++;
      if (aiCalls === 1) { startedAi(); await aiPending; finishedAi = true; }
    } },
  });
  assert.equal(captured, 2);
  assert.deepEqual(result, { polls: 2, collectionFailures: 0 });
});
test('collection errors emit a closed callback and next poll still runs', async () => {
  let reads = 0;
  let errors = 0;
  let captures = 0;
  const result = await runLocalSchedule({ store: schedulerStore(async () => { captures++; return { captured: 0, unchanged: 0 }; }),
    processor: { processIngestion: async () => null, processAi: async () => null }, now: () => '2026-10-12T00:00:00Z',
    readFeed: async () => { if (++reads === 1) throw new Error('untrusted_source_error'); return feed; },
    intervalMs: 1000, maxPolls: 2, sleep: async () => undefined, onCollectionError: () => { errors++; },
  });
  assert.equal(captures, 1);
  assert.equal(errors, 1);
  assert.deepEqual(result, { polls: 2, collectionFailures: 1 });
});
test('aborted schedule does not read or process and sleep clears promptly', async () => {
  const controller = new AbortController();
  controller.abort();
  let reads = 0;
  const result = await runLocalSchedule({ store: schedulerStore(async () => { throw new Error(); }),
    processor: { processIngestion: async () => { throw new Error(); }, processAi: async () => { throw new Error(); } },
    readFeed: async () => { reads++; return feed; }, now: () => '2026-10-12T00:00:00Z', intervalMs: 1000, maxPolls: 1, signal: controller.signal });
  assert.equal(reads, 0);
  assert.equal(result.polls, 0);
  await abortableSleep(10_000, controller.signal);
});
test('unbounded or too-frequent schedules are rejected before work', async () => {
  for (const [intervalMs, maxPolls] of [[999, 1], [1000, 0], [1000, 10_001], [Infinity, 1]]) {
    await assert.rejects(runLocalSchedule({ store: schedulerStore(async () => { throw new Error(); }),
      processor: { processIngestion: async () => null, processAi: async () => null }, readFeed: async () => feed,
      now: () => '', intervalMs, maxPolls }), /invalid_local_schedule/);
  }
});
