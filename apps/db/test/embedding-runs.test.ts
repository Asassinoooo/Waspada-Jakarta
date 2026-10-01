import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import {
  EmbeddingRunRepositoryError,
  createSqlEmbeddingRunRepository,
  type EmbeddingRunRecord,
} from '../src/embedding-runs.js';
import { applyMigrations, readMigrations } from '../src/migrations.js';
import {
  createRepositoryPorts,
  type NewReportRevision,
  type TraceRecord,
} from '../src/ports.js';
import type { TransactionalSqlExecutor } from '../src/sql.js';
import { createTestDatabase, type TestDatabase } from './harness.js';

const NORMALIZATION_VERSION = 'nfkc-lf-contact-redaction-v1';
const SOURCE_ID = 'source-embedding-fixtures';

interface Fixture {
  readonly datasetKind: 'live' | 'historical' | 'synthetic';
  readonly revision: NewReportRevision;
  readonly chunkId: string;
  readonly chunkerVersion: string;
  readonly text: string;
  readonly runTraceId: string;
}

describe('DATA-02-EMBEDDING-PERSIST-CORE', () => {
  let database: TestDatabase;
  let ports: ReturnType<typeof createRepositoryPorts>;
  let mainFixture: Fixture;

  before(async () => {
    database = await createTestDatabase();
    ports = createRepositoryPorts(database.executor);
    await applyMigrations(database.executor, await readMigrations(new URL('../migrations/', import.meta.url)));
    await createTrace('trace-embedding-catalog', null);
    await insertSource();
    mainFixture = await createFixture('main', 'synthetic', 'eligible');
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

  it('writes one available run and its vector atomically under the L1 role, then replays it', async () => {
    const record = makeRecord(mainFixture, 'embedding-basic');
    assert.equal(await runAsL1(() => ports.embeddingRuns.createOrVerify(record, [0.25, 0.75])), 'created');
    assert.equal(await runAsL1(() => ports.embeddingRuns.createOrVerify(record, [0.25, 0.75])), 'replayed');

    const rows = await database.executor.query<{
      run_status: string;
      run_chunk_id: string;
      run_trace_id: string;
      input_text_hash: string;
      dimensions: number;
      vector_status: string | null;
    }>(
      `SELECT run.status AS run_status, run.chunk_id AS run_chunk_id, run.trace_id AS run_trace_id,
              run.input_text_hash, vector.dimensions,
              vector.embedding::text AS vector_status
       FROM waspada.embedding_runs AS run
       LEFT JOIN waspada.embedding_vectors AS vector
         ON vector.dataset_kind = run.dataset_kind
        AND vector.embedding_run_id = run.embedding_run_id
       WHERE run.dataset_kind = $1 AND run.embedding_run_id = $2`,
      [record.dataset_kind, record.embedding_run_id],
    );
    assert.deepEqual(rows.rows, [{
      run_status: 'available',
      run_chunk_id: record.chunk_id,
      run_trace_id: record.trace_id,
      input_text_hash: record.input_text_hash,
      dimensions: record.dimensions,
      vector_status: '[0.25,0.75]',
    }]);
  });

  it('compares replay vectors in pgvector float32 storage and rejects changed metadata or vectors without writes', async () => {
    const record = makeRecord(mainFixture, 'embedding-float32');
    const firstVector = [0.1, 0.2];
    assert.equal(await runAsL1(() => ports.embeddingRuns.createOrVerify(record, firstVector)), 'created');
    assert.equal(await runAsL1(() => ports.embeddingRuns.createOrVerify(
      record,
      [0.1000000001, 0.2000000001],
    )), 'replayed');

    const before = await database.executor.query<{ metadata: string; vector: string }>(
      `SELECT to_jsonb(run)::text AS metadata, vector.embedding::text AS vector
       FROM waspada.embedding_runs AS run
       JOIN waspada.embedding_vectors AS vector
         ON vector.dataset_kind = run.dataset_kind
        AND vector.embedding_run_id = run.embedding_run_id
       WHERE run.dataset_kind = $1 AND run.embedding_run_id = $2`,
      [record.dataset_kind, record.embedding_run_id],
    );
    await assertRepositoryError(
      runAsL1(() => ports.embeddingRuns.createOrVerify(record, [0.2, 0.1])),
      'embedding_run_conflict',
    );
    await assertRepositoryError(
      runAsL1(() => ports.embeddingRuns.createOrVerify({ ...record, provider: 'changed-provider' }, firstVector)),
      'embedding_run_conflict',
    );
    const after = await database.executor.query<{ metadata: string; vector: string }>(
      `SELECT to_jsonb(run)::text AS metadata, vector.embedding::text AS vector
       FROM waspada.embedding_runs AS run
       JOIN waspada.embedding_vectors AS vector
         ON vector.dataset_kind = run.dataset_kind
        AND vector.embedding_run_id = run.embedding_run_id
       WHERE run.dataset_kind = $1 AND run.embedding_run_id = $2`,
      [record.dataset_kind, record.embedding_run_id],
    );
    assert.deepEqual(after.rows, before.rows);
  });

  it('compares explicit RFC3339 timestamps at microsecond precision across equivalent offsets', async () => {
    const record = makeRecord(mainFixture, 'embedding-time', {
      created_at: '2026-09-30T10:00:00.123456+07:00',
    });
    assert.equal(await runAsL1(() => ports.embeddingRuns.createOrVerify(record, [0.4, 0.6])), 'created');
    assert.equal(await runAsL1(() => ports.embeddingRuns.createOrVerify({
      ...record,
      created_at: '2026-09-30T03:00:00.123456Z',
    }, [0.4, 0.6])), 'replayed');
    await assertRepositoryError(
      runAsL1(() => ports.embeddingRuns.createOrVerify({
        ...record,
        created_at: '2026-09-30T03:00:00.123457Z',
      }, [0.4, 0.6])),
      'embedding_run_conflict',
    );

    const stored = await database.executor.query<{ timestamp: string }>(
      `SELECT to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US') AS timestamp
       FROM waspada.embedding_runs
       WHERE dataset_kind = $1 AND embedding_run_id = $2`,
      [record.dataset_kind, record.embedding_run_id],
    );
    assert.equal(stored.rows[0]?.timestamp, '2026-09-30T03:00:00.123456');
  });

  it('rejects malformed metadata, over-precise or invalid timestamps, and unsafe vectors before SQL', async () => {
    let sqlCalls = 0;
    const countedExecutor = countingExecutor(database.executor, () => { sqlCalls += 1; });
    const repository = createSqlEmbeddingRunRepository(countedExecutor);
    const validRecord = makeRecord(mainFixture, 'embedding-invalid-input');
    const invalidCases: Array<{ readonly record: EmbeddingRunRecord; readonly vector: readonly number[] }> = [
      { record: { ...validRecord, created_at: '2026-09-30T03:00:00.1234567Z' }, vector: [0.1, 0.2] },
      { record: { ...validRecord, created_at: '2026-02-30T03:00:00Z' }, vector: [0.1, 0.2] },
      { record: { ...validRecord, created_at: '2026-09-30T03:00:00' }, vector: [0.1, 0.2] },
      { record: { ...validRecord, dimensions: 2_049 }, vector: [0.1, 0.2] },
      { record: { ...validRecord, input_text_hash: 'bad-hash' }, vector: [0.1, 0.2] },
      { record: { ...validRecord, embedding_run_id: 'embedding ID with spaces' }, vector: [0.1, 0.2] },
      { record: { ...validRecord, provider: 'p'.repeat(121) }, vector: [0.1, 0.2] },
      { record: { ...validRecord, model_version: 'm'.repeat(201) }, vector: [0.1, 0.2] },
      { record: { ...validRecord, vector_index_version: 'bad index!' }, vector: [0.1, 0.2] },
      { record: { ...validRecord, dataset_kind: 'other' } as unknown as EmbeddingRunRecord, vector: [0.1, 0.2] },
      { record: { ...validRecord, distance_metric: 'manhattan' } as unknown as EmbeddingRunRecord, vector: [0.1, 0.2] },
      { record: { ...validRecord, status: 'invalidated' } as unknown as EmbeddingRunRecord, vector: [0.1, 0.2] },
      { record: Object.assign({}, validRecord, { unexpected: 'not in schema 2.0' }) as EmbeddingRunRecord, vector: [0.1, 0.2] },
      { record: validRecord, vector: [0.1] },
      { record: validRecord, vector: [Number.NaN, 0.2] },
      { record: validRecord, vector: [Number.POSITIVE_INFINITY, 0.2] },
      { record: validRecord, vector: [Number.NEGATIVE_INFINITY, 0.2] },
      { record: validRecord, vector: [3.5e38, 0.2] },
      { record: validRecord, vector: [1e-50, 0] },
    ];

    for (const invalidCase of invalidCases) {
      await assertRepositoryError(
        repository.createOrVerify(invalidCase.record, invalidCase.vector),
        'invalid_embedding_run',
      );
    }
    assert.equal(sqlCalls, 0);
  });

  it('snapshots validated metadata and float32 vector values before awaiting the transaction', async () => {
    let signalLock!: () => void;
    let releaseLock!: () => void;
    const lockReached = new Promise<void>((resolve) => { signalLock = resolve; });
    const waitForRelease = new Promise<void>((resolve) => { releaseLock = resolve; });
    const delayedExecutor: TransactionalSqlExecutor = {
      query: (statement, parameters) => database.executor.query(statement, parameters),
      execute: (statement) => database.executor.execute(statement),
      transaction: (work) => database.executor.transaction((transaction) => work({
        query: async <Row extends object>(statement: string, parameters?: readonly unknown[]) => {
          if (statement.includes('pg_advisory_xact_lock')) {
            signalLock();
            await waitForRelease;
          }
          return transaction.query<Row>(statement, parameters);
        },
        execute: (statement) => transaction.execute(statement),
      })),
    };
    const mutableRecord = makeRecord(mainFixture, 'embedding-snapshot') as unknown as Record<string, unknown>;
    const mutableVector = [0.1000000001, 0.2];
    const repository = createSqlEmbeddingRunRepository(delayedExecutor);
    const pending = runAsL1(() => repository.createOrVerify(
      mutableRecord as unknown as EmbeddingRunRecord,
      mutableVector,
    ));
    await lockReached;
    mutableRecord.provider = 'mutated-provider';
    mutableVector[0] = 0.9;
    releaseLock();
    assert.equal(await pending, 'created');

    const stored = await database.executor.query<{ provider: string; vector: string }>(
      `SELECT run.provider, vector.embedding::text AS vector
       FROM waspada.embedding_runs AS run
       JOIN waspada.embedding_vectors AS vector
         ON vector.dataset_kind = run.dataset_kind
        AND vector.embedding_run_id = run.embedding_run_id
       WHERE run.dataset_kind = $1 AND run.embedding_run_id = $2`,
      ['synthetic', 'embedding-snapshot'],
    );
    assert.deepEqual(stored.rows, [{ provider: 'synthetic-test-only', vector: '[0.1,0.2]' }]);
  });

  it('checks dataset-scoped traces and exact persisted Unicode chunk spans and hashes', async () => {
    const historicalFixture = await createFixture('shared', 'historical', 'unreviewed', 'chunk-embedding-shared');
    const syntheticFixture = await createFixture('shared', 'synthetic', 'eligible', 'chunk-embedding-shared');
    const sharedId = 'embedding-dataset-shared';
    assert.equal(await runAsL1(() => ports.embeddingRuns.createOrVerify(
      makeRecord(syntheticFixture, sharedId), [0.25, 0.75])), 'created');
    assert.equal(await runAsL1(() => ports.embeddingRuns.createOrVerify(
      makeRecord(historicalFixture, sharedId), [0.25, 0.75])), 'created');
    await assertRepositoryError(
      runAsL1(() => ports.embeddingRuns.createOrVerify({
        ...makeRecord(historicalFixture, 'embedding-wrong-trace'),
        trace_id: syntheticFixture.runTraceId,
      }, [0.25, 0.75])),
      'embedding_run_reference_not_found',
    );

    const badSpan = await createFixture('bad-span', 'synthetic', 'eligible');
    await database.executor.query(
      `UPDATE waspada.evidence_chunks SET span_end = span_end - 1
       WHERE dataset_kind = 'synthetic' AND chunk_id = $1`,
      [badSpan.chunkId],
    );
    await assertRepositoryError(
      runAsL1(() => ports.embeddingRuns.createOrVerify(makeRecord(badSpan, 'embedding-bad-span'), [0.25, 0.75])),
      'embedding_run_lineage_mismatch',
    );

    const badHash = await createFixture('bad-hash', 'synthetic', 'eligible');
    const alteredChunkHash = '0'.repeat(64);
    await database.executor.query(
      `UPDATE waspada.evidence_chunks SET chunk_text_hash = $2
       WHERE dataset_kind = 'synthetic' AND chunk_id = $1`,
      [badHash.chunkId, alteredChunkHash],
    );
    await assertRepositoryError(
      runAsL1(() => ports.embeddingRuns.createOrVerify(
        makeRecord(badHash, 'embedding-bad-hash', { input_text_hash: alteredChunkHash }), [0.25, 0.75])),
      'embedding_run_lineage_mismatch',
    );

    const badRevisionText = await createCorruptRevisionFixture();
    await assertRepositoryError(
      runAsL1(() => ports.embeddingRuns.createOrVerify(
        makeRecord(badRevisionText, 'embedding-bad-revision-text'), [0.25, 0.75])),
      'embedding_run_lineage_mismatch',
    );
  });

  it('requires an active chunk and unreviewed or eligible revision for new available runs', async () => {
    for (const status of ['quarantined', 'superseded', 'retracted'] as const) {
      const disallowed = await createFixture(status, 'synthetic', status);
      await assertRepositoryError(
        runAsL1(() => ports.embeddingRuns.createOrVerify(
          makeRecord(disallowed, `embedding-${status}`), [0.25, 0.75])),
        'embedding_run_unavailable',
      );
    }
    const unreviewed = await createFixture('unreviewed', 'synthetic', 'unreviewed');
    assert.equal(await runAsL1(() => ports.embeddingRuns.createOrVerify(
      makeRecord(unreviewed, 'embedding-unreviewed'), [0.25, 0.75])), 'created');
  });

  it('rolls metadata back when the second vector write fails', async () => {
    const record = makeRecord(mainFixture, 'embedding-rollback');
    const failingExecutor: TransactionalSqlExecutor = {
      query: (statement, parameters) => database.executor.query(statement, parameters),
      execute: (statement) => database.executor.execute(statement),
      transaction: (work) => database.executor.transaction((transaction) => work({
        query: <Row extends object>(statement: string, parameters?: readonly unknown[]) => {
          if (statement.includes('INSERT INTO waspada.embedding_vectors')) {
            throw new Error('synthetic second-write failure with hidden driver details');
          }
          return transaction.query<Row>(statement, parameters);
        },
        execute: (statement) => transaction.execute(statement),
      })),
    };
    const repository = createSqlEmbeddingRunRepository(failingExecutor);
    await assertRepositoryError(
      runAsL1(() => repository.createOrVerify(record, [0.25, 0.75])),
      'embedding_run_persistence_failed',
    );

    const counts = await database.executor.query<{ run_count: number; vector_count: number }>(
      `SELECT (SELECT count(*)::integer FROM waspada.embedding_runs
                WHERE dataset_kind = $1 AND embedding_run_id = $2) AS run_count,
              (SELECT count(*)::integer FROM waspada.embedding_vectors
                WHERE dataset_kind = $1 AND embedding_run_id = $2) AS vector_count`,
      [record.dataset_kind, record.embedding_run_id],
    );
    assert.deepEqual(counts.rows[0], { run_count: 0, vector_count: 0 });
  });

  it('fails closed for missing or changed stored vectors and preserves L1-only write/status grants', async () => {
    const missingVector = makeRecord(mainFixture, 'embedding-missing-vector');
    await insertRunWithoutVector(missingVector);
    await assertRepositoryError(
      runAsL1(() => ports.embeddingRuns.createOrVerify(missingVector, [0.25, 0.75])),
      'embedding_run_integrity_error',
    );

    const changedVector = makeRecord(mainFixture, 'embedding-changed-vector');
    await runAsL1(() => ports.embeddingRuns.createOrVerify(changedVector, [0.25, 0.75]));
    await database.executor.query(
      `UPDATE waspada.embedding_vectors SET embedding = '[0.5,0.5]'::vector
       WHERE dataset_kind = $1 AND embedding_run_id = $2`,
      [changedVector.dataset_kind, changedVector.embedding_run_id],
    );
    await assertRepositoryError(
      runAsL1(() => ports.embeddingRuns.createOrVerify(changedVector, [0.25, 0.75])),
      'embedding_run_conflict',
    );

    const failedRun = makeRecord(mainFixture, 'embedding-failed-run');
    await insertRunWithStatus(failedRun, 'failed', [0.25, 0.75]);
    const failedBefore = await database.executor.query<{ status: string; vector: string }>(
      `SELECT run.status, vector.embedding::text AS vector
       FROM waspada.embedding_runs AS run
       JOIN waspada.embedding_vectors AS vector
         ON vector.dataset_kind = run.dataset_kind
        AND vector.embedding_run_id = run.embedding_run_id
       WHERE run.dataset_kind = $1 AND run.embedding_run_id = $2`,
      [failedRun.dataset_kind, failedRun.embedding_run_id],
    );
    await assertRepositoryError(
      runAsL1(() => ports.embeddingRuns.createOrVerify(failedRun, [0.25, 0.75])),
      'embedding_run_integrity_error',
    );
    const failedAfter = await database.executor.query<{ status: string; vector: string }>(
      `SELECT run.status, vector.embedding::text AS vector
       FROM waspada.embedding_runs AS run
       JOIN waspada.embedding_vectors AS vector
         ON vector.dataset_kind = run.dataset_kind
        AND vector.embedding_run_id = run.embedding_run_id
       WHERE run.dataset_kind = $1 AND run.embedding_run_id = $2`,
      [failedRun.dataset_kind, failedRun.embedding_run_id],
    );
    assert.deepEqual(failedAfter.rows, failedBefore.rows);

    const privileges = await database.executor.query<{
      run_table_select: boolean;
      vector_table_select: boolean;
      run_insert: boolean;
      vector_insert: boolean;
      run_status_update: boolean;
      run_provider_update: boolean;
      run_delete: boolean;
      vector_delete: boolean;
      l2_run_trace_select: boolean;
      l2_chunk_trace_select: boolean;
      public_vector_select: boolean;
    }>(
      `SELECT has_table_privilege('waspada_l1_pipeline', 'waspada.embedding_runs', 'SELECT') AS run_table_select,
              has_table_privilege('waspada_l1_pipeline', 'waspada.embedding_vectors', 'SELECT') AS vector_table_select,
              has_table_privilege('waspada_l1_pipeline', 'waspada.embedding_runs', 'INSERT') AS run_insert,
              has_table_privilege('waspada_l1_pipeline', 'waspada.embedding_vectors', 'INSERT') AS vector_insert,
              has_column_privilege('waspada_l1_pipeline', 'waspada.embedding_runs', 'status', 'UPDATE') AS run_status_update,
              has_column_privilege('waspada_l1_pipeline', 'waspada.embedding_runs', 'provider', 'UPDATE') AS run_provider_update,
              has_table_privilege('waspada_l1_pipeline', 'waspada.embedding_runs', 'DELETE') AS run_delete,
              has_table_privilege('waspada_l1_pipeline', 'waspada.embedding_vectors', 'DELETE') AS vector_delete,
              has_column_privilege('waspada_l2_grounding_reader', 'waspada.embedding_runs', 'trace_id', 'SELECT') AS l2_run_trace_select,
              has_column_privilege('waspada_l2_grounding_reader', 'waspada.evidence_chunks', 'trace_id', 'SELECT') AS l2_chunk_trace_select,
              has_column_privilege('waspada_public_reader', 'waspada.embedding_vectors', 'embedding', 'SELECT') AS public_vector_select`,
    );
    assert.deepEqual(privileges.rows[0], {
      run_table_select: false,
      vector_table_select: false,
      run_insert: true,
      vector_insert: true,
      run_status_update: true,
      run_provider_update: false,
      run_delete: false,
      vector_delete: false,
      l2_run_trace_select: false,
      l2_chunk_trace_select: false,
      public_vector_select: false,
    });

    const readableColumns = await database.executor.query<{
      chunk_lineage: boolean;
      run_identity: boolean;
      vector_value: boolean;
    }>(
      `SELECT has_column_privilege('waspada_l1_pipeline', 'waspada.evidence_chunks', 'chunk_text_hash', 'SELECT')
                AND has_column_privilege('waspada_l1_pipeline', 'waspada.evidence_chunks', 'span_start', 'SELECT')
                AND has_column_privilege('waspada_l1_pipeline', 'waspada.evidence_chunks', 'span_end', 'SELECT')
                AND has_column_privilege('waspada_l1_pipeline', 'waspada.report_revisions', 'permitted_text', 'SELECT')
                AS chunk_lineage,
              has_column_privilege('waspada_l1_pipeline', 'waspada.embedding_runs', 'provider', 'SELECT')
                AND has_column_privilege('waspada_l1_pipeline', 'waspada.embedding_runs', 'created_at', 'SELECT')
                AS run_identity,
              has_column_privilege('waspada_l1_pipeline', 'waspada.embedding_vectors', 'embedding', 'SELECT') AS vector_value`,
    );
    assert.deepEqual(readableColumns.rows[0], { chunk_lineage: true, run_identity: true, vector_value: true });
  });

  it('uses only a matching persisted vector in semantic retrieval and keeps invalidated data unavailable', async () => {
    const candidateId = 'candidate-embedding-retrieval';
    await database.executor.query(
      `INSERT INTO waspada.extraction_results
         (dataset_kind, candidate_id, trace_id, report_revision_id, category, record_json)
       VALUES ($1, $2, $3, $4, NULL, $5::jsonb)`,
      [mainFixture.datasetKind, candidateId, mainFixture.revision.traceId,
        mainFixture.revision.reportRevisionId,
        JSON.stringify({ event_time: { start: null, end: null, precision: 'unknown' } })],
    );
    const evidence = await database.executor.query<{ evidence_ref_id: string }>(
      `INSERT INTO waspada.evidence_references
         (dataset_kind, trace_id, report_revision_id, permitted_text_hash,
          span_start, span_end, offset_unit, relation)
       VALUES ($1, $2, $3, $4, 0, $5, 'unicode_code_points', 'supports')
       RETURNING evidence_ref_id::text AS evidence_ref_id`,
      [mainFixture.datasetKind, mainFixture.revision.traceId, mainFixture.revision.reportRevisionId,
        mainFixture.revision.permittedTextHash, Array.from(mainFixture.text).length],
    );
    await database.executor.query(
      `INSERT INTO waspada.extraction_evidence (dataset_kind, candidate_id, evidence_ref_id)
       VALUES ($1, $2, $3)`,
      [mainFixture.datasetKind, candidateId, evidence.rows[0]!.evidence_ref_id],
    );

    const record = makeRecord(mainFixture, 'embedding-retrieval', {
      provider: 'fixture-provider-v1',
      model_version: 'fixture-model-v1',
      vector_index_version: 'fixture-index-v1',
    });
    const identity = {
      provider: record.provider,
      modelVersion: record.model_version,
      dimensions: record.dimensions,
      distanceMetric: record.distance_metric,
      vectorIndexVersion: record.vector_index_version,
    };
    assert.equal(await runAsL1(() => ports.embeddingRuns.createOrVerify(record, [1, 0])), 'created');

    const matched = await runAsL2(() => ports.evidenceRetrieval.search({
      datasetKind: mainFixture.datasetKind,
      identifiers: [{ kind: 'candidate', value: candidateId }],
      semantic: { identity, queryVector: [1, 0] },
    }));
    assert.equal(matched.semanticStatus, 'matched');
    assert.equal(matched.candidates[0]?.chunk?.embeddingStatus, 'matched');
    assert.equal(matched.candidates[0]?.chunk?.embeddingRunId, record.embedding_run_id);

    const incompatible = await runAsL2(() => ports.evidenceRetrieval.search({
      datasetKind: mainFixture.datasetKind,
      identifiers: [{ kind: 'candidate', value: candidateId }],
      semantic: { identity: { ...identity, provider: 'other-provider' }, queryVector: [1, 0] },
    }));
    assert.equal(incompatible.semanticStatus, 'no_compatible_vector');
    assert.equal(incompatible.candidates[0]?.chunk?.embeddingStatus, 'no_compatible_embedding');

    const replacementChunk = makeChunk(mainFixture, 'chunker-embedding-v2', 'chunk-embedding-reindexed');
    await runAsL1(() => ports.evidenceChunks.persist({
      datasetKind: mainFixture.datasetKind,
      traceId: mainFixture.revision.traceId,
      reportRevisionId: mainFixture.revision.reportRevisionId,
      permittedTextHash: mainFixture.revision.permittedTextHash,
      normalizationVersion: mainFixture.revision.normalizationVersion,
      chunks: [replacementChunk],
    }));
    assert.equal(await runAsL1(() => ports.embeddingRuns.createOrVerify(record, [1, 0])), 'unavailable');

    const invalidated = await database.executor.query<{ chunk_status: string; run_status: string }>(
      `SELECT chunk.status AS chunk_status, run.status AS run_status
       FROM waspada.evidence_chunks AS chunk
       JOIN waspada.embedding_runs AS run
         ON run.dataset_kind = chunk.dataset_kind AND run.chunk_id = chunk.chunk_id
       WHERE chunk.dataset_kind = $1 AND chunk.chunk_id = $2 AND run.embedding_run_id = $3`,
      [mainFixture.datasetKind, mainFixture.chunkId, record.embedding_run_id],
    );
    assert.deepEqual(invalidated.rows, [{ chunk_status: 'invalidated', run_status: 'invalidated' }]);

    const afterInvalidation = await runAsL2(() => ports.evidenceRetrieval.search({
      datasetKind: mainFixture.datasetKind,
      identifiers: [{ kind: 'candidate', value: candidateId }],
      semantic: { identity, queryVector: [1, 0] },
    }));
    assert.equal(afterInvalidation.semanticStatus, 'no_compatible_vector');
    assert.equal(afterInvalidation.candidates[0]?.chunk?.embeddingStatus, 'no_compatible_embedding');
  });

  async function createFixture(
    suffix: string,
    datasetKind: Fixture['datasetKind'],
    revisionStatus: NewReportRevision['revisionStatus'],
    chunkId = `chunk-embedding-${suffix}`,
  ): Promise<Fixture> {
    const text = `Synthetic embedding fixture ${suffix}: closure near Monas 😀.`;
    const revisionTraceId = `trace-${datasetKind}-revision-${suffix}`;
    const runTraceId = `trace-${datasetKind}-run-${suffix}`;
    await createTrace(revisionTraceId, datasetKind);
    await createTrace(runTraceId, datasetKind);
    const revision: NewReportRevision = {
      datasetKind,
      reportRevisionId: `revision-embedding-${suffix}`,
      traceId: revisionTraceId,
      sourceId: SOURCE_ID,
      canonicalUrl: `https://fixtures.invalid/embedding/${suffix}`,
      sourceRevisionKey: null,
      contentHash: sha256(`synthetic raw fixture ${suffix}`),
      permittedText: text,
      permittedTextHash: sha256(text),
      normalizationVersion: NORMALIZATION_VERSION,
      publishedAt: null,
      observedAt: null,
      retrievedAt: '2026-09-30T03:00:00.123456Z',
      validFrom: null,
      validUntil: null,
      supersedesId: null,
      revisionStatus,
      recordJson: { record_type: 'ReportRevision', fixture: 'synthetic-test-only' },
    };
    await ports.reportRevisions.create(revision);
    await ports.evidenceChunks.persist({
      datasetKind,
      traceId: revisionTraceId,
      reportRevisionId: revision.reportRevisionId,
      permittedTextHash: revision.permittedTextHash,
      normalizationVersion: revision.normalizationVersion,
      chunks: [makeChunk({ datasetKind, revision, text }, 'chunker-embedding-v1', chunkId)],
    });
    return {
      datasetKind,
      revision,
      chunkId,
      chunkerVersion: 'chunker-embedding-v1',
      text,
      runTraceId,
    };
  }

  async function createTrace(traceId: string, datasetKind: TraceRecord['datasetKind']): Promise<void> {
    await ports.tracesAndAudit.createTrace({
      traceId,
      datasetKind,
      startedAt: '2026-09-30T03:00:00Z',
      endedAt: null,
      outcome: 'open',
      metadata: { fixture: 'synthetic-test-only' },
    });
  }

  async function createCorruptRevisionFixture(): Promise<Fixture> {
    const suffix = 'bad-revision-text';
    const datasetKind = 'synthetic' as const;
    const text = `Synthetic embedding fixture ${suffix}: closure near Monas 😀.`;
    const revisionTraceId = `trace-${datasetKind}-revision-${suffix}`;
    const runTraceId = `trace-${datasetKind}-run-${suffix}`;
    const reportRevisionId = `revision-embedding-${suffix}`;
    const chunkId = `chunk-embedding-${suffix}`;
    await createTrace(revisionTraceId, datasetKind);
    await createTrace(runTraceId, datasetKind);
    const incorrectPermittedHash = '0'.repeat(64);
    const revision: NewReportRevision = {
      datasetKind,
      reportRevisionId,
      traceId: revisionTraceId,
      sourceId: SOURCE_ID,
      canonicalUrl: `https://fixtures.invalid/embedding/${suffix}`,
      sourceRevisionKey: null,
      contentHash: sha256(`synthetic raw fixture ${suffix}`),
      permittedText: text,
      permittedTextHash: incorrectPermittedHash,
      normalizationVersion: NORMALIZATION_VERSION,
      publishedAt: null,
      observedAt: null,
      retrievedAt: '2026-09-30T03:00:00.123456Z',
      validFrom: null,
      validUntil: null,
      supersedesId: null,
      revisionStatus: 'eligible',
      recordJson: { record_type: 'ReportRevision', fixture: 'synthetic-test-only' },
    };
    await database.executor.query(
      `INSERT INTO waspada.report_revisions
         (dataset_kind, report_revision_id, trace_id, source_id, canonical_url,
          source_revision_key, content_hash, permitted_text, permitted_text_hash,
          normalization_version, retrieved_at, revision_status, record_json)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb)`,
      [revision.datasetKind, revision.reportRevisionId, revision.traceId, revision.sourceId,
        revision.canonicalUrl, revision.sourceRevisionKey, revision.contentHash, revision.permittedText,
        revision.permittedTextHash, revision.normalizationVersion, revision.retrievedAt,
        revision.revisionStatus, JSON.stringify(revision.recordJson)],
    );
    await database.executor.query(
      `INSERT INTO waspada.evidence_chunks
         (dataset_kind, chunk_id, trace_id, report_revision_id, permitted_text_hash,
          span_start, span_end, offset_unit, chunker_version, chunk_text_hash, status)
       VALUES ($1, $2, $3, $4, $5, 0, $6, 'unicode_code_points', 'chunker-corrupt-fixture', $7, 'active')`,
      [datasetKind, chunkId, revisionTraceId, reportRevisionId, incorrectPermittedHash,
        Array.from(text).length, sha256(text)],
    );
    return {
      datasetKind,
      revision,
      chunkId,
      chunkerVersion: 'chunker-corrupt-fixture',
      text,
      runTraceId,
    };
  }

  async function insertSource(): Promise<void> {
    await database.executor.query(
      `INSERT INTO waspada.source_registry
         (source_id, trace_id, registry_version, display_name, source_kind, remit,
          access_method, approved_hosts, access_restrictions, reuse_basis, registry_status,
          approval_status, health_status, auto_acquisition_enabled, auto_publication_policy)
       VALUES ($1, 'trace-embedding-catalog', 1, 'Synthetic embedding source', 'other',
          ARRAY['authored fixtures'], 'manual_fixture', ARRAY[]::text[],
          ARRAY['synthetic rows only'], ARRAY['test fixture'], 'active', 'approved', 'unknown', false, 'never')`,
      [SOURCE_ID],
    );
  }

  async function insertRunWithoutVector(record: EmbeddingRunRecord): Promise<void> {
    await database.executor.query(
      `INSERT INTO waspada.embedding_runs
         (dataset_kind, embedding_run_id, trace_id, chunk_id, capability, provider,
          model_version, dimensions, distance_metric, vector_index_version,
          input_text_hash, status, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'available', $12)`,
      [record.dataset_kind, record.embedding_run_id, record.trace_id, record.chunk_id,
        record.capability, record.provider, record.model_version, record.dimensions,
        record.distance_metric, record.vector_index_version, record.input_text_hash,
        record.created_at],
    );
  }

  async function insertRunWithStatus(
    record: EmbeddingRunRecord,
    status: 'failed' | 'invalidated',
    vector: readonly number[],
  ): Promise<void> {
    await database.executor.query(
      `INSERT INTO waspada.embedding_runs
         (dataset_kind, embedding_run_id, trace_id, chunk_id, capability, provider,
          model_version, dimensions, distance_metric, vector_index_version,
          input_text_hash, status, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [record.dataset_kind, record.embedding_run_id, record.trace_id, record.chunk_id,
        record.capability, record.provider, record.model_version, record.dimensions,
        record.distance_metric, record.vector_index_version, record.input_text_hash,
        status, record.created_at],
    );
    await database.executor.query(
      `INSERT INTO waspada.embedding_vectors (dataset_kind, embedding_run_id, dimensions, embedding)
       VALUES ($1, $2, $3, $4::vector)`,
      [record.dataset_kind, record.embedding_run_id, record.dimensions, `[${vector.join(',')}]`],
    );
  }
});

function makeRecord(
  fixture: Fixture,
  embeddingRunId: string,
  overrides: Partial<EmbeddingRunRecord> = {},
): EmbeddingRunRecord {
  return {
    schema_version: '2.0',
    trace_id: fixture.runTraceId,
    record_type: 'EmbeddingRun',
    dataset_kind: fixture.datasetKind,
    embedding_run_id: embeddingRunId,
    chunk_id: fixture.chunkId,
    capability: 'embedding',
    provider: 'synthetic-test-only',
    model_version: 'fixture-model-v1',
    dimensions: 2,
    distance_metric: 'cosine',
    vector_index_version: 'fixture-index-v1',
    input_text_hash: sha256(fixture.text),
    status: 'available',
    created_at: '2026-09-30T03:00:00.123456Z',
    ...overrides,
  };
}

function makeChunk(
  fixture: Pick<Fixture, 'datasetKind' | 'revision' | 'text'>,
  chunkerVersion: string,
  chunkId: string,
) {
  return {
    chunkId,
    reportRevisionId: fixture.revision.reportRevisionId,
    permittedTextHash: fixture.revision.permittedTextHash,
    normalizationVersion: fixture.revision.normalizationVersion,
    spanStart: 0,
    spanEnd: Array.from(fixture.text).length,
    offsetUnit: 'unicode_code_points' as const,
    chunkTextHash: sha256(fixture.text),
    text: fixture.text,
    chunkerVersion,
  };
}

function countingExecutor(executor: TransactionalSqlExecutor, onCall: () => void): TransactionalSqlExecutor {
  return {
    query: (statement, parameters) => {
      onCall();
      return executor.query(statement, parameters);
    },
    execute: (statement) => {
      onCall();
      return executor.execute(statement);
    },
    transaction: (work) => {
      onCall();
      return executor.transaction(work);
    },
  };
}

async function assertRepositoryError(
  result: Promise<unknown>,
  code: EmbeddingRunRepositoryError['code'],
): Promise<void> {
  await assert.rejects(result, (error: unknown) => {
    assert.ok(error instanceof EmbeddingRunRepositoryError);
    assert.equal(error.code, code);
    assert.equal(error.message, code);
    return true;
  });
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
