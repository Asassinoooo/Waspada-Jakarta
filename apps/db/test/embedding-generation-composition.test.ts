import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { createSqlEmbeddingRunRepository } from '../src/embedding-runs.js';
import { applyMigrations, readMigrations } from '../src/migrations.js';
import { createRepositoryPorts, type NewReportRevision, type TraceRecord } from '../src/ports.js';
import type { TransactionalSqlExecutor } from '../src/sql.js';
import { createEmbeddingGenerationRunner, type EmbeddingGenerationRequest } from '../../worker/src/layers/l1-data-knowledge/embedding-generation.js';
import { chunkPermittedText } from '../../worker/src/layers/l1-data-knowledge/evidence-chunking.js';
import { createModelCapabilityAdapter } from '../../worker/src/layers/l2-model-grounding/adapter.js';
import type {
  ClassificationRequest,
  EmbeddingRequest,
  ExtractionRequest,
  ModelCapability,
  ReasoningRequest,
  UntrustedModelProvider,
} from '../../worker/src/layers/l2-model-grounding/contracts.js';
import { createTestDatabase, type TestDatabase } from './harness.js';

const NORMALIZATION_VERSION = 'nfkc-lf-contact-redaction-v1';
const SOURCE_ID = 'source-embedding-generation-fixture';
const EMBEDDING_IDENTITY = {
  provider: 'synthetic-test-only',
  modelVersion: 'embedding-fixture-v1',
  dimensions: 2,
  distanceMetric: 'cosine' as const,
  vectorIndexVersion: 'embedding-index-fixture-v1',
};

class DeterministicEmbeddingProviderDoubleForTests implements UntrustedModelProvider {
  readonly calls: Record<ModelCapability, number> = {
    classification: 0,
    extraction: 0,
    embedding: 0,
    reasoning: 0,
  };
  readonly requests: EmbeddingRequest[] = [];

  constructor(
    private readonly vector: readonly number[] | Error,
    private readonly events: string[] = [],
  ) {}

  async classify(_request: ClassificationRequest): Promise<unknown> {
    this.calls.classification += 1;
    return {};
  }

  async extract(_request: ExtractionRequest): Promise<unknown> {
    this.calls.extraction += 1;
    return {};
  }

  async embed(request: EmbeddingRequest): Promise<unknown> {
    this.calls.embedding += 1;
    this.events.push('provider');
    this.requests.push(request);
    if (this.vector instanceof Error) throw this.vector;
    return { vector: [...this.vector] };
  }

  async reason(_request: ReasoningRequest): Promise<unknown> {
    this.calls.reasoning += 1;
    return {};
  }
}

describe('DATA-02-EMBEDDING-GENERATION-CORE composition', () => {
  let database: TestDatabase;
  let ports: ReturnType<typeof createRepositoryPorts>;
  let generationRequest: EmbeddingGenerationRequest;

  before(async () => {
    database = await createTestDatabase();
    ports = createRepositoryPorts(database.executor);
    await applyMigrations(database.executor, await readMigrations(new URL('../migrations/', import.meta.url)));
    await addTrace('trace-embedding-generation-catalog', null);
    await addTrace('trace-embedding-generation-revision', 'synthetic');
    await addTrace('trace-embedding-generation-run', 'synthetic');
    await database.executor.query(
      `INSERT INTO waspada.source_registry
         (source_id, trace_id, registry_version, display_name, source_kind, remit,
          access_method, approved_hosts, access_restrictions, reuse_basis, registry_status,
          approval_status, health_status, auto_acquisition_enabled, auto_publication_policy)
       VALUES ($1, 'trace-embedding-generation-catalog', 1, 'Synthetic embedding fixture source',
          'other', ARRAY['authored test fixtures'], 'manual_fixture', ARRAY[]::text[],
          ARRAY['synthetic rows only'], ARRAY['test fixture'], 'active', 'approved',
          'unknown', false, 'never')`,
      [SOURCE_ID],
    );

    const text = 'Synthetic fixture: closure near Monas 😀; exact chunk lineage.';
    const permittedTextHash = sha256(text);
    const revision: NewReportRevision = {
      datasetKind: 'synthetic',
      reportRevisionId: 'revision-embedding-generation',
      traceId: 'trace-embedding-generation-revision',
      sourceId: SOURCE_ID,
      canonicalUrl: 'https://fixtures.invalid/embedding-generation',
      sourceRevisionKey: null,
      contentHash: sha256('synthetic raw embedding generation fixture'),
      permittedText: text,
      permittedTextHash,
      normalizationVersion: NORMALIZATION_VERSION,
      publishedAt: null,
      observedAt: '2026-10-01T00:00:00Z',
      retrievedAt: '2026-10-01T00:01:00Z',
      validFrom: null,
      validUntil: null,
      supersedesId: null,
      revisionStatus: 'eligible',
      recordJson: { fixture: 'synthetic-test-only' },
    };
    await ports.reportRevisions.create(revision);
    const [chunk] = await chunkPermittedText({
      datasetKind: 'synthetic',
      reportRevisionId: revision.reportRevisionId,
      permittedTextHash,
      normalizationVersion: NORMALIZATION_VERSION,
      permittedText: text,
    });
    assert.ok(chunk);
    await ports.evidenceChunks.persist({
      datasetKind: 'synthetic',
      traceId: revision.traceId,
      reportRevisionId: revision.reportRevisionId,
      permittedTextHash,
      normalizationVersion: NORMALIZATION_VERSION,
      chunks: [chunk],
    });

    const evidenceRefId = await ports.reportRevisions.createEvidenceReference({
      datasetKind: 'synthetic',
      traceId: revision.traceId,
      reportRevisionId: revision.reportRevisionId,
      permittedTextHash,
      spanStart: chunk.spanStart,
      spanEnd: chunk.spanEnd,
      relation: 'supports',
    });
    await database.executor.query(
      `INSERT INTO waspada.extraction_results
         (dataset_kind, candidate_id, trace_id, report_revision_id, category, record_json)
       VALUES ('synthetic', 'candidate-embedding-generation', $1, $2,
          'transport_road_incidents', $3::jsonb)`,
      [revision.traceId, revision.reportRevisionId,
        JSON.stringify({ contractVersion: '2.0', fixture: 'synthetic-test-only' })],
    );
    await database.executor.query(
      `INSERT INTO waspada.extraction_evidence (dataset_kind, candidate_id, evidence_ref_id)
       VALUES ('synthetic', 'candidate-embedding-generation', $1)`,
      [evidenceRefId],
    );

    generationRequest = {
      datasetKind: 'synthetic',
      traceId: 'trace-embedding-generation-run',
      embeddingRunId: 'embedding-run-generation-main',
      createdAt: '2026-10-01T08:00:00.123456+07:00',
      chunk,
    };
  });

  after(async () => {
    await database?.close();
  });

  async function runAsL1<Result>(operation: () => Promise<Result>): Promise<Result> {
    await database.executor.query('SET ROLE waspada_l1_pipeline');
    try {
      return await operation();
    } finally {
      await database.executor.query('RESET ROLE');
    }
  }

  async function runAsL2<Result>(operation: () => Promise<Result>): Promise<Result> {
    await database.executor.query('SET ROLE waspada_l2_grounding_reader');
    try {
      return await operation();
    } finally {
      await database.executor.query('RESET ROLE');
    }
  }

  it('runs the real adapter before the L1 transaction, persists exact lineage, replays, and retrieves the vector under L2', async () => {
    const events: string[] = [];
    const provider = new DeterministicEmbeddingProviderDoubleForTests([1, 0], events);
    const modelAdapter = createModelCapabilityAdapter(provider, { embedding: EMBEDDING_IDENTITY });
    const observedExecutor = transactionObservedExecutor(database.executor, events);
    const embeddingRuns = createSqlEmbeddingRunRepository(observedExecutor);
    const run = createEmbeddingGenerationRunner({ modelAdapter, embeddingRuns });

    const publicationBefore = await publicationSnapshot();
    assert.deepEqual(await runAsL1(() => run(generationRequest)), { status: 'created' });
    assert.deepEqual(events, ['provider', 'persistence']);
    assert.equal(provider.calls.embedding, 1);
    assert.deepEqual(provider.requests, [{
      data: {
        chunk: {
          chunkId: generationRequest.chunk.chunkId,
          reportRevisionId: generationRequest.chunk.reportRevisionId,
          permittedTextHash: generationRequest.chunk.permittedTextHash,
          normalizationVersion: generationRequest.chunk.normalizationVersion,
          spanStart: generationRequest.chunk.spanStart,
          spanEnd: generationRequest.chunk.spanEnd,
          offsetUnit: generationRequest.chunk.offsetUnit,
          chunkTextHash: generationRequest.chunk.chunkTextHash,
          text: generationRequest.chunk.text,
        },
      },
    }]);

    const persisted = await database.executor.query<{
      readonly dataset_kind: string;
      readonly trace_id: string;
      readonly embedding_run_id: string;
      readonly chunk_id: string;
      readonly provider: string;
      readonly model_version: string;
      readonly dimensions: number;
      readonly distance_metric: string;
      readonly vector_index_version: string;
      readonly input_text_hash: string;
      readonly created_at_matches: boolean;
      readonly run_status: string;
      readonly vector: string;
    }>(
      `SELECT run.dataset_kind, run.trace_id, run.embedding_run_id, run.chunk_id,
              run.provider, run.model_version, run.dimensions, run.distance_metric,
              run.vector_index_version, run.input_text_hash,
              run.created_at = '2026-10-01T01:00:00.123456Z'::timestamptz AS created_at_matches,
              run.status AS run_status, vector.embedding::text AS vector
       FROM waspada.embedding_runs AS run
       JOIN waspada.embedding_vectors AS vector
         ON vector.dataset_kind = run.dataset_kind
        AND vector.embedding_run_id = run.embedding_run_id
       WHERE run.dataset_kind = 'synthetic' AND run.embedding_run_id = $1`,
      [generationRequest.embeddingRunId],
    );
    assert.deepEqual(persisted.rows, [{
      dataset_kind: 'synthetic',
      trace_id: generationRequest.traceId,
      embedding_run_id: generationRequest.embeddingRunId,
      chunk_id: generationRequest.chunk.chunkId,
      provider: EMBEDDING_IDENTITY.provider,
      model_version: EMBEDDING_IDENTITY.modelVersion,
      dimensions: EMBEDDING_IDENTITY.dimensions,
      distance_metric: EMBEDDING_IDENTITY.distanceMetric,
      vector_index_version: EMBEDDING_IDENTITY.vectorIndexVersion,
      input_text_hash: generationRequest.chunk.chunkTextHash,
      created_at_matches: true,
      run_status: 'available',
      vector: '[1,0]',
    }]);

    assert.deepEqual(await runAsL1(() => run(generationRequest)), { status: 'replayed' });
    assert.equal(provider.calls.embedding, 2, 'the caller retry invokes the adapter once for that invocation');
    assert.deepEqual(events, ['provider', 'persistence', 'provider', 'persistence']);

    const retrieval = await runAsL2(() => ports.evidenceRetrieval.search({
      datasetKind: 'synthetic',
      identifiers: [{ kind: 'candidate', value: 'candidate-embedding-generation' }],
      semantic: { identity: EMBEDDING_IDENTITY, queryVector: [1, 0] },
    }));
    assert.equal(retrieval.semanticStatus, 'matched');
    assert.equal(retrieval.candidates.length, 1);
    assert.equal(retrieval.candidates[0]?.chunk?.chunkId, generationRequest.chunk.chunkId);
    assert.equal(retrieval.candidates[0]?.chunk?.embeddingRunId, generationRequest.embeddingRunId);
    assert.equal(retrieval.candidates[0]?.chunk?.embeddingProvider, EMBEDDING_IDENTITY.provider);
    assert.equal(retrieval.candidates[0]?.chunk?.embeddingModelVersion, EMBEDDING_IDENTITY.modelVersion);
    assert.equal(retrieval.candidates[0]?.matchFacets.semanticDistance, 0);
    assert.deepEqual(await publicationSnapshot(), publicationBefore);
  });

  it('does not persist unavailable, failed, invalid-output, or invalid-request results', async () => {
    const before = await countGenerationRuns();
    const noProviderRun = createEmbeddingGenerationRunner({
      modelAdapter: createModelCapabilityAdapter(),
      embeddingRuns: createSqlEmbeddingRunRepository(database.executor),
    });
    assert.deepEqual(await runAsL1(() => noProviderRun({
      ...generationRequest,
      embeddingRunId: 'embedding-run-not-configured',
    })), { status: 'not_configured', reason: 'provider_not_configured' });

    const providerError = new DeterministicEmbeddingProviderDoubleForTests(new Error('private provider error'));
    const providerErrorRun = createEmbeddingGenerationRunner({
      modelAdapter: createModelCapabilityAdapter(providerError, { embedding: EMBEDDING_IDENTITY }),
      embeddingRuns: createSqlEmbeddingRunRepository(database.executor),
    });
    assert.deepEqual(await runAsL1(() => providerErrorRun({
      ...generationRequest,
      embeddingRunId: 'embedding-run-provider-error',
    })), { status: 'provider_error' });
    assert.equal(providerError.calls.embedding, 1);

    const invalidOutputProvider = new DeterministicEmbeddingProviderDoubleForTests([1]);
    const invalidOutputRun = createEmbeddingGenerationRunner({
      modelAdapter: createModelCapabilityAdapter(invalidOutputProvider, { embedding: EMBEDDING_IDENTITY }),
      embeddingRuns: createSqlEmbeddingRunRepository(database.executor),
    });
    assert.deepEqual(await runAsL1(() => invalidOutputRun({
      ...generationRequest,
      embeddingRunId: 'embedding-run-invalid-output',
    })), { status: 'invalid_output' });
    assert.equal(invalidOutputProvider.calls.embedding, 1);

    const invalidRequestProvider = new DeterministicEmbeddingProviderDoubleForTests([1, 0]);
    const invalidRequestRun = createEmbeddingGenerationRunner({
      modelAdapter: createModelCapabilityAdapter(invalidRequestProvider, { embedding: EMBEDDING_IDENTITY }),
      embeddingRuns: createSqlEmbeddingRunRepository(database.executor),
    });
    assert.deepEqual(await runAsL1(() => invalidRequestRun({
      ...generationRequest,
      embeddingRunId: 'embedding-run-invalid-request',
      chunk: { ...generationRequest.chunk, chunkTextHash: '0'.repeat(64) },
    })), { status: 'invalid_request' });
    assert.equal(invalidRequestProvider.calls.embedding, 0);
    assert.equal(await countGenerationRuns(), before);
  });

  it('rejects changed vectors on a stable retry and never resurrects an invalidated chunk', async () => {
    const first = await database.executor.query<{ readonly metadata: string; readonly vector: string }>(
      `SELECT to_jsonb(run)::text AS metadata, vector.embedding::text AS vector
       FROM waspada.embedding_runs AS run
       JOIN waspada.embedding_vectors AS vector
         ON vector.dataset_kind = run.dataset_kind
        AND vector.embedding_run_id = run.embedding_run_id
       WHERE run.dataset_kind = 'synthetic' AND run.embedding_run_id = $1`,
      [generationRequest.embeddingRunId],
    );
    assert.equal(first.rows.length, 1);

    const changedProvider = new DeterministicEmbeddingProviderDoubleForTests([0, 1]);
    const changedRun = createEmbeddingGenerationRunner({
      modelAdapter: createModelCapabilityAdapter(changedProvider, { embedding: EMBEDDING_IDENTITY }),
      embeddingRuns: createSqlEmbeddingRunRepository(database.executor),
    });
    assert.deepEqual(await runAsL1(() => changedRun(generationRequest)), { status: 'conflict' });
    const afterConflict = await database.executor.query<{ readonly metadata: string; readonly vector: string }>(
      `SELECT to_jsonb(run)::text AS metadata, vector.embedding::text AS vector
       FROM waspada.embedding_runs AS run
       JOIN waspada.embedding_vectors AS vector
         ON vector.dataset_kind = run.dataset_kind
        AND vector.embedding_run_id = run.embedding_run_id
       WHERE run.dataset_kind = 'synthetic' AND run.embedding_run_id = $1`,
      [generationRequest.embeddingRunId],
    );
    assert.deepEqual(afterConflict.rows, first.rows);

    const replacementChunk = {
      ...generationRequest.chunk,
      chunkId: 'chunk-embedding-generation-replacement',
      chunkerVersion: 'chunker-generation-replacement-v2',
    };
    await runAsL1(() => ports.evidenceChunks.persist({
      datasetKind: 'synthetic',
      traceId: 'trace-embedding-generation-revision',
      reportRevisionId: generationRequest.chunk.reportRevisionId,
      permittedTextHash: generationRequest.chunk.permittedTextHash,
      normalizationVersion: generationRequest.chunk.normalizationVersion,
      chunks: [replacementChunk],
    }));

    const sameProvider = new DeterministicEmbeddingProviderDoubleForTests([1, 0]);
    const invalidatedReplayRun = createEmbeddingGenerationRunner({
      modelAdapter: createModelCapabilityAdapter(sameProvider, { embedding: EMBEDDING_IDENTITY }),
      embeddingRuns: createSqlEmbeddingRunRepository(database.executor),
    });
    assert.deepEqual(await runAsL1(() => invalidatedReplayRun(generationRequest)), { status: 'unavailable' });
    assert.equal(sameProvider.calls.embedding, 1);

    const states = await database.executor.query<{
      readonly chunk_id: string;
      readonly chunk_status: string;
      readonly run_status: string;
      readonly vector: string;
    }>(
      `SELECT chunk.chunk_id, chunk.status AS chunk_status, run.status AS run_status,
              vector.embedding::text AS vector
       FROM waspada.evidence_chunks AS chunk
       JOIN waspada.embedding_runs AS run
         ON run.dataset_kind = chunk.dataset_kind AND run.chunk_id = chunk.chunk_id
       JOIN waspada.embedding_vectors AS vector
         ON vector.dataset_kind = run.dataset_kind AND vector.embedding_run_id = run.embedding_run_id
       WHERE chunk.dataset_kind = 'synthetic'
         AND run.embedding_run_id = $1`,
      [generationRequest.embeddingRunId],
    );
    assert.deepEqual(states.rows, [{
      chunk_id: generationRequest.chunk.chunkId,
      chunk_status: 'invalidated',
      run_status: 'invalidated',
      vector: '[1,0]',
    }]);

    const afterInvalidation = await runAsL2(() => ports.evidenceRetrieval.search({
      datasetKind: 'synthetic',
      identifiers: [{ kind: 'candidate', value: 'candidate-embedding-generation' }],
      semantic: { identity: EMBEDDING_IDENTITY, queryVector: [1, 0] },
    }));
    assert.equal(afterInvalidation.candidates[0]?.chunk?.chunkId, replacementChunk.chunkId);
    assert.equal(afterInvalidation.candidates[0]?.chunk?.embeddingStatus, 'no_compatible_embedding');
    assert.equal(afterInvalidation.candidates[0]?.chunk?.embeddingRunId, null);
  });

  async function addTrace(traceId: string, datasetKind: TraceRecord['datasetKind']): Promise<void> {
    await ports.tracesAndAudit.createTrace({
      traceId,
      datasetKind,
      startedAt: '2026-10-01T00:00:00Z',
      endedAt: null,
      outcome: 'open',
      metadata: { fixture: 'synthetic-test-only' },
    });
  }

  async function countGenerationRuns(): Promise<number> {
    const result = await database.executor.query<{ readonly count: number }>(
      `SELECT count(*)::integer AS count
       FROM waspada.embedding_runs
       WHERE dataset_kind = 'synthetic' AND embedding_run_id LIKE 'embedding-run-%'`,
    );
    return result.rows[0]?.count ?? 0;
  }

  async function publicationSnapshot(): Promise<readonly unknown[]> {
    const result = await database.executor.query<{
      readonly publication_decisions: number;
      readonly event_versions: number;
      readonly publication_write_receipts: number;
      readonly publication_outbox: number;
      readonly publication_outbox_delivery_attempts: number;
      readonly publication_outbox_delivery_results: number;
    }>(
      `SELECT
         (SELECT count(*)::integer FROM waspada.publication_decisions) AS publication_decisions,
         (SELECT count(*)::integer FROM waspada.event_versions) AS event_versions,
         (SELECT count(*)::integer FROM waspada.publication_write_receipts) AS publication_write_receipts,
         (SELECT count(*)::integer FROM waspada.publication_outbox) AS publication_outbox,
         (SELECT count(*)::integer FROM waspada.publication_outbox_delivery_attempts) AS publication_outbox_delivery_attempts,
         (SELECT count(*)::integer FROM waspada.publication_outbox_delivery_results) AS publication_outbox_delivery_results`,
    );
    return result.rows;
  }
});

function transactionObservedExecutor(
  executor: TransactionalSqlExecutor,
  events: string[],
): TransactionalSqlExecutor {
  return {
    query: (statement, parameters) => executor.query(statement, parameters),
    execute: (statement) => executor.execute(statement),
    transaction: (work) => {
      events.push('persistence');
      return executor.transaction(work);
    },
  };
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
