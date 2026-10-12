import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openLocalPipelineDatabase } from './database.js';
import { createLocalPipelineStore } from './store.js';
import { createLocalPipelineProcessor } from './processor.js';
import { createLocalMockModels } from './mock-models.js';
import { resolveLocalModels } from './models.js';
import { parseAuthoredFeed } from './feed.js';
import { startLocalPipelinePreviewServer } from './server.js';
import { getLocalPipelinePreview } from '../../apps/web/src/local-pipeline-client.js';
import type { ModelCapabilityAdapter } from '../../apps/worker/src/layers/l2-model-grounding/contracts.js';

test('app composition reads exact PGlite proposals over loopback through the strict browser client without model calls', { timeout: 90_000 }, async () => {
  const now = '2026-10-12T11:00:00.000Z';
  const models = createLocalMockModels();
  let calls = 0;
  const adapter: ModelCapabilityAdapter = {
    ...models.adapter,
    extract: async (input) => { calls++; return models.adapter.extract(input); },
    embed: async (input) => { calls++; return models.adapter.embed(input); },
    reason: async (input) => { calls++; return models.adapter.reason(input); },
  };
  const database = await openLocalPipelineDatabase({ profileId: models.profileId });
  let server: Awaited<ReturnType<typeof startLocalPipelinePreviewServer>> | undefined;
  try {
    const store = createLocalPipelineStore(database.executor);
    const feed = parseAuthoredFeed(await readFile(new URL('./fixtures/feed.json', import.meta.url), 'utf8'));
    const processor = createLocalPipelineProcessor({ ...models, adapter, store, executor: database.executor, now: () => now });
    await store.capture(feed, now);
    await processor.processIngestion();
    await processor.processAi();
    assert.equal(calls, 3);
    server = await startLocalPipelinePreviewServer({ executor: database.executor, models: 'mock',
      scheduler: () => ({ status: 'completed', polls: 1, collectionFailures: 0 }), port: 0 });
    const baseUrl = `http://127.0.0.1:${server.port}`;
    const transport = ((input: RequestInfo | URL, init?: RequestInit) => fetch(new URL(String(input), baseUrl), init)) as typeof fetch;
    const first = await getLocalPipelinePreview({ fetchImpl: transport });
    assert.equal(first.summary.proposals, 1);
    assert.equal(first.summary.ingestion.completed, 1);
    assert.equal(first.summary.ai.completed, 1);
    assert.equal(first.publicationEnabled, false);
    assert.equal(first.datasetKind, 'synthetic');
    assert.equal(first.reports.length, 1);
    const report = first.reports[0]!;
    assert.equal(report.version, 1);
    assert.equal(report.permittedText, feed.reports[0]!.text.normalize('NFC'));
    assert.deepEqual(report.stages, ['extraction', 'embedding', 'grounding', 'reasoning', 'proposal']);
    assert.ok(report.proposal);
    assert.ok(report.proposal.claims.some((claim) => claim.evidence.some((reference) => reference.relation === 'contradicts')));
    const second = await getLocalPipelinePreview({ fetchImpl: transport });
    assert.deepEqual(second.reports, first.reports);
    assert.equal(calls, 3, 'HTTP reads never invoke models');
    assert.deepEqual(await store.capture(feed, now), { captured: 0, unchanged: 1 });
    await processor.processIngestion();
    await processor.processAi();
    assert.equal(calls, 3, 'unchanged collection never invokes models');
    for (const table of ['event_versions', 'impact_versions', 'publication_decisions', 'publication_outbox']) {
      const rows = await database.executor.query<{ count: number }>(`SELECT count(*)::int AS count FROM waspada.${table}`);
      assert.equal(rows.rows[0]?.count, 0, table);
    }
    const denied = await fetch(`${baseUrl}/__local/pipeline`, { method: 'POST' });
    assert.equal(denied.status, 405);
    assert.equal(calls, 3);
  } finally {
    await server?.close();
    await database.close();
  }
});

test('real profile output policy cannot reopen another owned file-backed state without any provider request', { timeout: 90_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'waspada-profile-policy-'));
  let calls = 0;
  const env = { NINEROUTER_URL: 'https://example.invalid/v1', NINEROUTER_KEY: 'authored-synthetic-test-key', NINEROUTER_CURATION_EPOCH: 'synthetic-policy-test' };
  const transport = (async () => { calls++; throw new Error('unexpected_provider_call'); }) as typeof fetch;
  const original = resolveLocalModels({ realAi: true, omitExtractionOutputLimits: false, env, fetchImpl: transport });
  const alternate = resolveLocalModels({ realAi: true, omitExtractionOutputLimits: true, env, fetchImpl: transport });
  try {
    const database = await openLocalPipelineDatabase({ dataDir: directory, profileId: original.profileId });
    await database.close();
    await assert.rejects(openLocalPipelineDatabase({ dataDir: directory, profileId: alternate.profileId }));
    assert.equal(calls, 0);
    const reopened = await openLocalPipelineDatabase({ dataDir: directory, profileId: original.profileId });
    assert.equal((await createLocalPipelineStore(reopened.executor).summary()).snapshots, 0);
    await reopened.close();
  } finally { await rm(directory, { recursive: true, force: true }); }
});
