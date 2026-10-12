import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import type { TransactionalSqlExecutor } from '../../apps/db/src/sql.js';
import type {
  EvidenceReference,
  EmbeddingRequest,
  ExtractionRequest,
  ModelCapabilityAdapter,
  ReasoningRequest,
} from '../../apps/worker/src/layers/l2-model-grounding/contracts.js';
import { createLocalPipelineProcessor } from './processor.js';
import { createLocalMockModels } from './mock-models.js';
import { AuthoredFeedError, parseAuthoredFeed } from './feed.js';
import type { AiJob, LocalPipelineStore, PipelineSummary, ReportSnapshot } from './contracts.js';

const FIXTURE_PATH = 'tools/local-pipeline/fixtures/feed.json';

test('parses the bounded authored fixture and rejects URLs, geometry, and extra keys', async () => {
  const feedText = await readFile(FIXTURE_PATH, 'utf8');
  const feed = parseAuthoredFeed(feedText);
  assert.equal(feed.datasetKind, 'synthetic');
  assert.equal(feed.sourceId, 'local-authored-api');
  assert.equal(feed.reports.length, 1);
  assert.match(feed.reports[0]!.text, /hanya latihan sintetis/);
  assert.match(feed.reports[0]!.text, /perbedaan catatan ini belum diperiksa/);

  const value = JSON.parse(feedText) as Record<string, any>;
  assert.throws(() => parseAuthoredFeed(JSON.stringify({ ...value, reports: [{ ...value.reports[0], url: 'https://example.test' }] })), AuthoredFeedError);
  assert.throws(() => parseAuthoredFeed(JSON.stringify({ ...value, reports: [{ ...value.reports[0], text: 'Baca detail di example.test' }] })), AuthoredFeedError);
  assert.throws(() => parseAuthoredFeed(JSON.stringify({ ...value, geometry: { type: 'Point', coordinates: [106, -6] } })), AuthoredFeedError);
  assert.throws(() => parseAuthoredFeed(' '.repeat(65_537)), (error: unknown) => error instanceof AuthoredFeedError && error.code === 'feed_too_large');
});

test('mock capabilities pass through the validating adapter with fixture lineage', async () => {
  const models = createLocalMockModels();
  const text = 'Laporan simulasi sintetis mengenai genangan di Jakarta Selatan.';
  const reportHash = createHash('sha256').update(text, 'utf8').digest('hex');
  const extractionRequest: ExtractionRequest = {
    data: {
      candidateId: 'candidate-test-001',
      report: {
        reportRevisionId: 'revision-test-001',
        permittedTextHash: reportHash,
        normalizationVersion: 'nfkc-lf-contact-redaction-v1',
        permittedText: text,
      },
    },
  };
  const extracted = await models.adapter.extract(extractionRequest);
  assert.equal(extracted.status, 'succeeded');
  if (extracted.status !== 'succeeded') return;
  assert.equal(extracted.value.evidence[0]!.spanEnd, Array.from(text).length);
  assert.deepEqual(extracted.value.unknownFields, ['event_time']);

  const embeddingRequest: EmbeddingRequest = {
    data: {
      chunk: {
        chunkId: 'chunk-test-001',
        reportRevisionId: 'revision-test-001',
        permittedTextHash: reportHash,
        normalizationVersion: 'nfkc-lf-contact-redaction-v1',
        spanStart: 0,
        spanEnd: Array.from(text).length,
        offsetUnit: 'unicode_code_points',
        chunkTextHash: reportHash,
        text,
      },
    },
  };
  const embedded = await models.adapter.embed(embeddingRequest);
  assert.equal(embedded.status, 'succeeded');
  if (embedded.status === 'succeeded') assert.equal(embedded.value.vector.length, 8);

  const contextReferences: EvidenceReference[] = [extracted.value.evidence[0]!, {
    reportRevisionId: 'revision-test-001',
    permittedTextHash: reportHash,
    spanStart: 0,
    spanEnd: Array.from(text).length,
    offsetUnit: 'unicode_code_points',
    relation: 'contradicts',
  }];
  const reasoningRequest: ReasoningRequest = {
    data: {
      groundingContext: {
        schemaVersion: '2.0',
        recordType: 'GroundingContext',
        datasetKind: 'synthetic',
        traceId: 'trace-test-001',
        contextId: 'context-test-001',
        candidateId: 'candidate-test-001',
        evidence: contextReferences.map((reference) => ({
          reference,
          text,
          sourceId: 'local-authored-api',
          revisionStatus: 'unreviewed' as const,
          publishedAt: null,
          observedAt: null,
          retrievedAt: '2026-10-12T06:00:00Z',
          origins: [{ originId: 'origin-test-001', independenceStatus: 'unknown' as const, dependsOnOriginIds: [] }],
        })),
        revisionStates: [{ reportRevisionId: 'revision-test-001', revisionStatus: 'unreviewed' }],
        candidateEvents: [],
        priorDecisionIds: [],
        missingFields: ['event_time'],
        conflicts: ['extraction_contradiction:revision-test-001:0:1'],
        retrievalVersion: 'hybrid-evidence-v2',
        indexVersion: 'local-vector-v1',
        sufficient: true,
      },
    },
  };
  const reasoned = await models.adapter.reason(reasoningRequest);
  assert.equal(reasoned.status, 'succeeded');
  if (reasoned.status === 'succeeded') {
    assert.equal(reasoned.value.claims[0]!.support[0]!.reportRevisionId, 'revision-test-001');
    assert.equal(reasoned.value.claims[0]!.contradictions[0]!.relation, 'contradicts');
    assert.deepEqual(reasoned.value.conflicts, ['extraction_contradiction:revision-test-001:0:1']);
  }
});

test('one ingestion pass claims at most one queued job', async () => {
  const models = createLocalMockModels();
  const jobs = [
    { jobId: 'job-ingest-001', status: 'leased', attemptCount: 1, leaseToken: 'lease-1', leaseExpiresAt: '2026-10-12T06:05:00.000Z' },
    { jobId: 'job-ingest-002', status: 'leased', attemptCount: 1, leaseToken: 'lease-2', leaseExpiresAt: '2026-10-12T06:05:00.000Z' },
  ] as unknown as NonNullable<Awaited<ReturnType<LocalPipelineStore['claimIngestion']>>>[];
  let claimCount = 0;
  let failureCount = 0;
  const store = {
    async capture() { return { captured: 0, unchanged: 0 }; },
    async claimIngestion() { claimCount += 1; return jobs.shift() ?? null; },
    async ingestionSnapshot() { return null; },
    async finishIngestion() { return true; },
    async failIngestion() { failureCount += 1; return 'retry' as const; },
    async claimAi() { return null; },
    async readReceipt() { return null; },
    async checkpoint() { return true; },
    async completeAi() { return true; },
    async failAi() { return 'retry' as const; },
    async recover() { return { ingestion: 0, ai: 0 }; },
    async summary() { return {} as PipelineSummary; },
  } as unknown as LocalPipelineStore;
  const executor = {
    async query() { return { rows: [] }; },
    async execute() {},
    async transaction(work: (tx: any) => Promise<unknown>) { return work(this); },
  } as unknown as TransactionalSqlExecutor;

  const processor = createLocalPipelineProcessor({
    store,
    executor,
    adapter: models.adapter,
    configuration: models.configuration,
    now: () => '2026-10-12T06:00:01.000Z',
  });
  await processor.processIngestion();
  assert.equal(claimCount, 1);
  assert.equal(failureCount, 1);
  assert.equal(jobs.length, 1);
});

test('a model timeout becomes a bounded retryable failure with no late SQL checkpoint', async () => {
  const models = createLocalMockModels();
  const snapshot: ReportSnapshot = {
    id: 'report-timeout-001',
    title: 'Simulasi genangan',
    text: 'Laporan simulasi sintetis mengenai genangan di Jakarta Selatan.',
    publishedAt: null,
    observedAt: null,
    sourceId: 'local-authored-api',
    datasetKind: 'synthetic',
    version: 1,
    contentHash: 'c'.repeat(64),
    canonicalUrl: 'https://local.invalid/synthetic/report-timeout-001',
    sourceRevisionKey: 'report-timeout-001-v1',
    reportRevisionId: 'revision-timeout-001',
    candidateId: 'candidate-timeout-001',
    traceId: 'trace-timeout-001',
    supersedesId: null,
    capturedAt: '2026-10-12T06:00:00.000Z',
  };
  let releaseLateCall: ((value: any) => void) | undefined;
  const waitingForProvider = new Promise<any>((resolve) => { releaseLateCall = resolve; });
  let providerCalls = 0;
  let checkpointCalls = 0;
  let failureCode: string | null = null;
  let claimed = false;
  const adapter = {
    ...models.adapter,
    async extract() {
      providerCalls += 1;
      return waitingForProvider;
    },
  } as unknown as ModelCapabilityAdapter;
  const job = {
    jobId: 'job-timeout-001',
    status: 'leased',
    attemptCount: 1,
    leaseToken: 'lease-token-001',
    leaseExpiresAt: '2026-10-12T06:05:00.000Z',
    snapshot,
  } as AiJob;
  const store = {
    async capture() { return { captured: 0, unchanged: 1 }; },
    async claimIngestion() { return null; },
    async ingestionSnapshot() { return snapshot; },
    async finishIngestion() { return true; },
    async failIngestion() { return 'retry' as const; },
    async claimAi() { if (claimed) return null; claimed = true; return job; },
    async readReceipt() { return null; },
    async checkpoint() { checkpointCalls += 1; return true; },
    async completeAi() { return true; },
    async failAi(_job: AiJob, _now: string, code: string) { failureCode = code; return 'retry' as const; },
    async recover() { return { ingestion: 0, ai: 0 }; },
    async summary() { return {} as PipelineSummary; },
  } as unknown as LocalPipelineStore;
  const executor = {
    async query() { return { rows: [] }; },
    async execute() {},
    async transaction(work: (tx: any) => Promise<unknown>) { return work(this); },
  } as unknown as TransactionalSqlExecutor;

  const processor = createLocalPipelineProcessor({
    store,
    executor,
    adapter,
    configuration: models.configuration,
    now: () => '2026-10-12T06:00:01.000Z',
    modelTimeoutMs: 10,
  });
  await processor.processAi();
  assert.equal(providerCalls, 1);
  assert.equal(failureCode, 'model_timeout');
  assert.equal(checkpointCalls, 0);

  releaseLateCall?.({ status: 'provider_error', capability: 'extraction' });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(checkpointCalls, 0);
});
