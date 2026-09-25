import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { applyMigrations, readMigrations } from '../src/migrations.js';
import { createRepositoryPorts, type NewReportRevision, type TraceRecord } from '../src/ports.js';
import type { EvidenceChunkInput, PersistEvidenceChunksInput } from '../src/evidence-chunks.js';
import { chunkPreparedText } from '../../worker/src/layers/l1-data-knowledge/evidence-chunking.js';
import { preparePermittedText } from '../../worker/src/layers/l1-data-knowledge/text-preparation.js';
import { createTestDatabase, type TestDatabase } from './harness.js';

const normalizationVersion = 'nfkc-lf-contact-redaction-v1';
const traceCatalog: TraceRecord = {
  traceId: 'trace-chunk-source-catalog',
  datasetKind: null,
  startedAt: '2026-09-25T05:00:00Z',
  endedAt: null,
  outcome: 'open',
  metadata: { fixture: 'synthetic-test-only' },
};
const traceSynthetic: TraceRecord = {
  traceId: 'trace-synthetic-chunks',
  datasetKind: 'synthetic',
  startedAt: '2026-09-25T05:01:00Z',
  endedAt: null,
  outcome: 'open',
  metadata: { fixture: 'synthetic-test-only' },
};

describe('DATA-02-CORE evidence chunk persistence', () => {
  let testDatabase: TestDatabase;
  let ports: ReturnType<typeof createRepositoryPorts>;
  let revision: NewReportRevision;
  let permittedText: string;

  before(async () => {
    testDatabase = await createTestDatabase();
    ports = createRepositoryPorts(testDatabase.executor);
    const migrations = await readMigrations(new URL('../migrations/', import.meta.url));
    await applyMigrations(testDatabase.executor, migrations);
    await ports.tracesAndAudit.createTrace(traceCatalog);
    await ports.tracesAndAudit.createTrace(traceSynthetic);
    await testDatabase.executor.query(
      `INSERT INTO waspada.source_registry
         (source_id, trace_id, registry_version, display_name, source_kind, remit,
          access_method, approved_hosts, access_restrictions, reuse_basis, registry_status,
          approval_status, health_status, auto_acquisition_enabled, auto_publication_policy)
       VALUES ('source-synthetic-chunks', 'trace-chunk-source-catalog', 1,
          'Synthetic chunk fixture source', 'other', ARRAY['fixture checks'], 'manual_fixture',
          ARRAY[]::text[], ARRAY['synthetic rows only'], ARRAY['test fixture'], 'active',
          'approved', 'unknown', false, 'never')`,
    );

    permittedText = 'Synthetic fixture: café, emoji 😀, and a second span for overlap-safe evidence.';
    revision = makeRevision(permittedText, 'revision-chunks-main');
    await ports.reportRevisions.create(revision);
  });

  after(async () => {
    await testDatabase.close();
  });

  async function runAsL1<T>(operation: () => Promise<T>): Promise<T> {
    await testDatabase.executor.query('SET ROLE waspada_l1_pipeline');
    try {
      return await operation();
    } finally {
      await testDatabase.executor.query('RESET ROLE');
    }
  }

  it('persists only chunk metadata, accepts identical retries, and scopes by dataset', async () => {
    const set = makeSet(revision, [
      makeChunk(revision, 'chunk-synthetic-v1-a', 'chunker-v1', 0, 52,
        Array.from(permittedText).slice(0, 52).join('')),
      makeChunk(revision, 'chunk-synthetic-v1-b', 'chunker-v1', 40, Array.from(permittedText).length,
        Array.from(permittedText).slice(40).join('')),
    ]);

    const first = await runAsL1(() => ports.evidenceChunks.persist(set));
    const retry = await runAsL1(() => ports.evidenceChunks.persist(set));
    assert.deepEqual(first, {
      persistedChunkCount: 2,
      invalidatedChunkCount: 0,
      invalidatedEmbeddingRunCount: 0,
    });
    assert.deepEqual(retry, first);

    const rows = await testDatabase.executor.query<{ chunk_id: string; span_start: number; span_end: number }>(
      `SELECT chunk_id, span_start, span_end
       FROM waspada.evidence_chunks
       WHERE dataset_kind = 'synthetic' AND report_revision_id = $1
       ORDER BY span_start`,
      [revision.reportRevisionId],
    );
    assert.equal(rows.rows.length, 2);
    assert.equal(rows.rows[0]?.span_start, 0);
    assert.equal(rows.rows[1]?.span_start, 40);
    assert.equal(rows.rows[0]?.span_end, 52);

    await assert.rejects(
      runAsL1(() => ports.evidenceChunks.persist({ ...set, datasetKind: 'historical' })),
      /not present in the requested dataset/,
    );
    const otherDataset = await testDatabase.executor.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM waspada.evidence_chunks WHERE dataset_kind = 'historical'",
    );
    assert.equal(otherDataset.rows[0]?.count, '0');
  });

  it('checks immutable revision hash, normalization, span text, and complete coverage before writing', async () => {
    const complete = makeSet(revision, [
      makeChunk(revision, 'chunk-synthetic-invalid-a', 'chunker-checks', 0,
        Array.from(permittedText).length, permittedText),
    ]);
    await assert.rejects(
      runAsL1(() => ports.evidenceChunks.persist({ ...complete, normalizationVersion: 'different-normalizer-v1' })),
      /normalization version does not match/,
    );
    await assert.rejects(
      runAsL1(() => ports.evidenceChunks.persist({ ...complete, permittedTextHash: '0'.repeat(64) })),
      /hash does not match/,
    );
    await assert.rejects(
      runAsL1(() => ports.evidenceChunks.persist({
        ...complete,
        chunks: [{ ...complete.chunks[0]!, text: 'Synthetic false fixture.' }],
      })),
      /text length does not match|span does not resolve|hash does not match/,
    );
    await assert.rejects(
      runAsL1(() => ports.evidenceChunks.persist({
        ...complete,
        chunks: [{
          ...complete.chunks[0]!,
          spanStart: 1,
          text: Array.from(permittedText).slice(1).join(''),
          chunkTextHash: sha256(Array.from(permittedText).slice(1).join('')),
        }],
      })),
      /gap|span|cover the entire/,
    );
    const count = await testDatabase.executor.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM waspada.evidence_chunks
       WHERE dataset_kind = 'synthetic' AND chunk_id = 'chunk-synthetic-invalid-a'`,
    );
    assert.equal(count.rows[0]?.count, '0');
  });

  it('persists normalized, redacted L1 chunks without raw contact values', async () => {
    const rawSyntheticText = 'Synthetic report contact fixture.person@example.test and 081234567890.';
    const prepared = await preparePermittedText(rawSyntheticText);
    const privateFixtureRevision = makeRevision(
      prepared.permittedText,
      'revision-synthetic-redacted',
      prepared.sourceInputHash,
    );
    await ports.reportRevisions.create(privateFixtureRevision);
    const chunks = await chunkPreparedText('synthetic', privateFixtureRevision.reportRevisionId, prepared);
    const compatibleL2Input: import('../../worker/src/layers/l2-model-grounding/contracts.js').EvidenceChunkInput = chunks[0]!;
    assert.equal(compatibleL2Input.normalizationVersion, prepared.normalizationVersion);
    await runAsL1(() => ports.evidenceChunks.persist(makeSet(privateFixtureRevision, chunks)));

    const stored = await testDatabase.executor.query<{ revision_text: string; chunk_metadata: string }>(
      `SELECT revision.permitted_text AS revision_text,
              (SELECT jsonb_agg(to_jsonb(chunk))::text
               FROM waspada.evidence_chunks AS chunk
               WHERE chunk.dataset_kind = revision.dataset_kind
                 AND chunk.report_revision_id = revision.report_revision_id) AS chunk_metadata
       FROM waspada.report_revisions AS revision
       WHERE revision.dataset_kind = 'synthetic'
         AND revision.report_revision_id = $1`,
      [privateFixtureRevision.reportRevisionId],
    );
    const persistedContent = JSON.stringify(stored.rows[0]);
    assert.ok(stored.rows[0]?.revision_text.includes('[REDACTED:email]'));
    assert.ok(stored.rows[0]?.revision_text.includes('[REDACTED:indonesian-mobile]'));
    assert.equal(persistedContent.includes('fixture.person@example.test'), false);
    assert.equal(persistedContent.includes('081234567890'), false);
    assert.equal(persistedContent.includes('"text"'), false);
  });

  it('rejects chunk-ID lineage collisions without partial inserts or invalidation', async () => {
    const original = makeSet(revision, [
      makeChunk(revision, 'chunk-synthetic-collision', 'chunker-collision-v1', 0,
        Array.from(permittedText).length, permittedText),
    ]);
    await runAsL1(() => ports.evidenceChunks.persist(original));
    const nextVersion = makeSet(revision, [
      makeChunk(revision, 'chunk-synthetic-collision', 'chunker-collision-v2', 0, 40,
        Array.from(permittedText).slice(0, 40).join('')),
      makeChunk(revision, 'chunk-synthetic-never-written', 'chunker-collision-v2', 35,
        Array.from(permittedText).length, Array.from(permittedText).slice(35).join('')),
    ]);

    await assert.rejects(runAsL1(() => ports.evidenceChunks.persist(nextVersion)), /lineage\/content does not match/);
    const rows = await testDatabase.executor.query<{ chunk_id: string; status: string }>(
      `SELECT chunk_id, status FROM waspada.evidence_chunks
       WHERE dataset_kind = 'synthetic' AND report_revision_id = $1
         AND chunk_id IN ('chunk-synthetic-collision', 'chunk-synthetic-never-written')
       ORDER BY chunk_id`,
      [revision.reportRevisionId],
    );
    assert.deepEqual(rows.rows, [{ chunk_id: 'chunk-synthetic-collision', status: 'active' }]);
  });

  it('atomically invalidates older chunks and available embedding metadata while preserving vectors', async () => {
    const oldSet = makeSet(revision, [
      makeChunk(revision, 'chunk-synthetic-version-old', 'chunker-old', 0,
        Array.from(permittedText).length, permittedText),
    ]);
    await runAsL1(() => ports.evidenceChunks.persist(oldSet));
    const oldChunk = oldSet.chunks[0]!;
    await testDatabase.executor.query(
      `INSERT INTO waspada.embedding_runs
         (dataset_kind, embedding_run_id, trace_id, chunk_id, capability, provider,
          model_version, dimensions, distance_metric, vector_index_version,
          input_text_hash, status, created_at)
       VALUES ('synthetic', 'embedding-synthetic-old', 'trace-synthetic-chunks', $1,
          'embedding', 'synthetic-test-only', 'model-not-selected-fixture', 2,
          'cosine', 'index-fixture-v1', $2, 'available', '2026-09-25T05:02:00Z')`,
      [oldChunk.chunkId, oldChunk.chunkTextHash],
    );
    await testDatabase.executor.query(
      `INSERT INTO waspada.embedding_vectors (dataset_kind, embedding_run_id, dimensions, embedding)
       VALUES ('synthetic', 'embedding-synthetic-old', 2, '[0.25,0.75]'::vector)`,
    );

    const newSet = makeSet(revision, [
      makeChunk(revision, 'chunk-synthetic-version-new', 'chunker-new', 0,
        Array.from(permittedText).length, permittedText),
    ]);
    const result = await runAsL1(() => ports.evidenceChunks.persist(newSet));
    assert.deepEqual(result, {
      persistedChunkCount: 1,
      invalidatedChunkCount: 1,
      invalidatedEmbeddingRunCount: 1,
    });

    const states = await testDatabase.executor.query<{ chunk_id: string; status: string }>(
      `SELECT chunk_id, status FROM waspada.evidence_chunks
       WHERE dataset_kind = 'synthetic' AND report_revision_id = $1
         AND chunk_id IN ('chunk-synthetic-version-old', 'chunk-synthetic-version-new')
       ORDER BY chunk_id`,
      [revision.reportRevisionId],
    );
    assert.deepEqual(states.rows, [
      { chunk_id: 'chunk-synthetic-version-new', status: 'active' },
      { chunk_id: 'chunk-synthetic-version-old', status: 'invalidated' },
    ]);
    const metadata = await testDatabase.executor.query<{ status: string; vector_count: number }>(
      `SELECT run.status,
              (SELECT count(*)::integer FROM waspada.embedding_vectors AS vector
               WHERE vector.dataset_kind = run.dataset_kind
                 AND vector.embedding_run_id = run.embedding_run_id) AS vector_count
       FROM waspada.embedding_runs AS run
       WHERE run.dataset_kind = 'synthetic' AND run.embedding_run_id = 'embedding-synthetic-old'`,
    );
    assert.deepEqual(metadata.rows, [{ status: 'invalidated', vector_count: 1 }]);
  });
});

function makeSet(revision: NewReportRevision, chunks: readonly EvidenceChunkInput[]): PersistEvidenceChunksInput {
  return {
    datasetKind: revision.datasetKind,
    traceId: revision.traceId,
    reportRevisionId: revision.reportRevisionId,
    permittedTextHash: revision.permittedTextHash,
    normalizationVersion: revision.normalizationVersion,
    chunks,
  };
}

function makeChunk(
  revision: NewReportRevision,
  chunkId: string,
  chunkerVersion: string,
  spanStart: number,
  spanEnd: number,
  text: string,
): EvidenceChunkInput {
  return {
    chunkId,
    reportRevisionId: revision.reportRevisionId,
    permittedTextHash: revision.permittedTextHash,
    normalizationVersion: revision.normalizationVersion,
    spanStart,
    spanEnd,
    offsetUnit: 'unicode_code_points',
    chunkTextHash: sha256(text),
    text,
    chunkerVersion,
  };
}

function makeRevision(
  permittedText: string,
  reportRevisionId: string,
  sourceInputHash = sha256(`synthetic raw fixture: ${reportRevisionId}`),
): NewReportRevision {
  return {
    datasetKind: 'synthetic',
    reportRevisionId,
    traceId: 'trace-synthetic-chunks',
    sourceId: 'source-synthetic-chunks',
    canonicalUrl: `https://fixtures.invalid/${reportRevisionId}`,
    sourceRevisionKey: null,
    contentHash: sourceInputHash,
    permittedText,
    permittedTextHash: sha256(permittedText),
    normalizationVersion,
    publishedAt: null,
    observedAt: null,
    retrievedAt: '2026-09-25T05:02:00Z',
    validFrom: null,
    validUntil: null,
    supersedesId: null,
    revisionStatus: 'unreviewed',
    recordJson: { record_type: 'ReportRevision', fixture: 'synthetic-test-only' },
  };
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
