import { createHash } from 'node:crypto';
import type { SqlExecutor } from './sql.js';

export type EvidenceChunkDatasetKind = 'live' | 'historical' | 'synthetic';

/** Structural copy of the L2 input fields plus the L1 chunker lineage. */
export interface EvidenceChunkInput {
  readonly chunkId: string;
  readonly reportRevisionId: string;
  readonly permittedTextHash: string;
  readonly normalizationVersion: string;
  readonly spanStart: number;
  readonly spanEnd: number;
  readonly offsetUnit: 'unicode_code_points';
  readonly chunkTextHash: string;
  readonly text: string;
  readonly chunkerVersion: string;
}

export interface PersistEvidenceChunksInput {
  readonly datasetKind: EvidenceChunkDatasetKind;
  readonly traceId: string;
  readonly reportRevisionId: string;
  readonly permittedTextHash: string;
  readonly normalizationVersion: string;
  readonly chunks: readonly EvidenceChunkInput[];
}

export interface PersistEvidenceChunksResult {
  readonly persistedChunkCount: number;
  readonly invalidatedChunkCount: number;
  readonly invalidatedEmbeddingRunCount: number;
}

export interface EvidenceChunkRepository {
  /**
   * Insert/retry a complete chunk set and invalidate superseded active chunks
   * and available embedding runs in one atomic SQL statement.
   */
  persist(input: PersistEvidenceChunksInput): Promise<PersistEvidenceChunksResult>;
}

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const MAX_CHUNK_COUNT = 1_024;
const MAX_CHUNK_CODE_POINTS = 40_000;

export function createSqlEvidenceChunkRepository(executor: SqlExecutor): EvidenceChunkRepository {
  return new SqlEvidenceChunkRepository(executor);
}

class SqlEvidenceChunkRepository implements EvidenceChunkRepository {
  constructor(private readonly executor: SqlExecutor) {}

  async persist(input: PersistEvidenceChunksInput): Promise<PersistEvidenceChunksResult> {
    validateInput(input);
    const revisionResult = await this.executor.query<RevisionTextRow>(
      `SELECT permitted_text, permitted_text_hash, normalization_version
       FROM waspada.report_revisions
       WHERE dataset_kind = $1 AND report_revision_id = $2`,
      [input.datasetKind, input.reportRevisionId],
    );
    const revision = revisionResult.rows[0];
    if (!revision) throw new Error('Report revision is not present in the requested dataset');
    if (revision.permitted_text_hash !== input.permittedTextHash) {
      throw new Error('Chunk set hash does not match its immutable report revision');
    }
    if (revision.normalization_version !== input.normalizationVersion) {
      throw new Error('Chunk normalization version does not match its immutable report revision');
    }
    if (sha256(revision.permitted_text) !== revision.permitted_text_hash) {
      throw new Error('Persisted report revision text does not match its stored hash');
    }
    validateChunks(input, revision.permitted_text);

    const valuesOffset = 7;
    const valuesSql = input.chunks.map((_, index) => {
      const start = valuesOffset + index * 4;
      return `($${start}::text, $${start + 1}::integer, $${start + 2}::integer, $${start + 3}::text)`;
    }).join(',\n              ');
    const parameters: unknown[] = [
      input.datasetKind,
      input.traceId,
      input.reportRevisionId,
      input.permittedTextHash,
      input.normalizationVersion,
      input.chunks[0]!.chunkerVersion,
    ];
    for (const chunk of input.chunks) {
      parameters.push(chunk.chunkId, chunk.spanStart, chunk.spanEnd, chunk.chunkTextHash);
    }

    try {
      const result = await this.executor.query<PersistResultRow>(
        `WITH incoming(chunk_id, span_start, span_end, chunk_text_hash) AS (
           VALUES ${valuesSql}
         ),
         valid_revision AS MATERIALIZED (
           SELECT 1 AS allowed
           FROM waspada.report_revisions AS revision
           WHERE revision.dataset_kind = $1
             AND revision.report_revision_id = $3
             AND revision.permitted_text_hash = $4
             AND revision.normalization_version = $5
             AND NOT EXISTS (
               SELECT 1
               FROM incoming
               JOIN waspada.evidence_chunks AS existing
                 ON existing.dataset_kind = $1 AND existing.chunk_id = incoming.chunk_id
               WHERE existing.report_revision_id <> $3
                  OR existing.permitted_text_hash <> $4
                  OR existing.span_start <> incoming.span_start
                  OR existing.span_end <> incoming.span_end
                  OR existing.offset_unit <> 'unicode_code_points'
                  OR existing.chunker_version <> $6
                  OR existing.chunk_text_hash <> incoming.chunk_text_hash
             )
         ),
         persisted AS (
           INSERT INTO waspada.evidence_chunks
             (dataset_kind, chunk_id, trace_id, report_revision_id, permitted_text_hash,
              span_start, span_end, offset_unit, chunker_version, chunk_text_hash, status)
           SELECT $1, incoming.chunk_id, $2, $3, $4,
                  incoming.span_start, incoming.span_end, 'unicode_code_points', $6,
                  incoming.chunk_text_hash, 'active'
           FROM incoming CROSS JOIN valid_revision
           ON CONFLICT (dataset_kind, chunk_id) DO UPDATE
             SET status = 'active'
             WHERE waspada.evidence_chunks.report_revision_id = EXCLUDED.report_revision_id
               AND waspada.evidence_chunks.permitted_text_hash = EXCLUDED.permitted_text_hash
               AND waspada.evidence_chunks.span_start = EXCLUDED.span_start
               AND waspada.evidence_chunks.span_end = EXCLUDED.span_end
               AND waspada.evidence_chunks.offset_unit = EXCLUDED.offset_unit
               AND waspada.evidence_chunks.chunker_version = EXCLUDED.chunker_version
               AND waspada.evidence_chunks.chunk_text_hash = EXCLUDED.chunk_text_hash
           RETURNING chunk_id
         ),
         invalidated_chunks AS (
           UPDATE waspada.evidence_chunks AS old_chunk
           SET status = 'invalidated'
           WHERE old_chunk.dataset_kind = $1
             AND old_chunk.report_revision_id = $3
             AND old_chunk.status = 'active'
             AND old_chunk.chunker_version <> $6
             AND (SELECT count(*) FROM persisted) = (SELECT count(*) FROM incoming)
           RETURNING old_chunk.chunk_id
         ),
         invalidated_runs AS (
           UPDATE waspada.embedding_runs AS old_run
           SET status = 'invalidated'
           WHERE old_run.dataset_kind = $1
             AND old_run.status = 'available'
             AND old_run.chunk_id IN (SELECT chunk_id FROM invalidated_chunks)
           RETURNING old_run.embedding_run_id
         ),
         result AS (
           SELECT (SELECT count(*) FROM persisted)::integer AS persisted_count,
                  (SELECT count(*) FROM incoming)::integer AS requested_count,
                  (SELECT count(*) FROM invalidated_chunks)::integer AS invalidated_chunk_count,
                  (SELECT count(*) FROM invalidated_runs)::integer AS invalidated_embedding_run_count
         )
         SELECT persisted_count, invalidated_chunk_count, invalidated_embedding_run_count,
                1 / CASE WHEN persisted_count = requested_count THEN 1 ELSE 0 END AS atomic_guard
         FROM result`,
        parameters,
      );
      const row = result.rows[0];
      if (!row || Number(row.atomic_guard) !== 1) {
        throw new Error('Chunk persistence did not complete');
      }
      return {
        persistedChunkCount: Number(row.persisted_count),
        invalidatedChunkCount: Number(row.invalidated_chunk_count),
        invalidatedEmbeddingRunCount: Number(row.invalidated_embedding_run_count),
      };
    } catch (error) {
      if (isAtomicGuardFailure(error)) {
        throw new Error('Chunk persistence rejected because the revision or existing chunk lineage/content does not match');
      }
      throw error;
    }
  }
}

function validateInput(input: PersistEvidenceChunksInput): void {
  if (input.datasetKind !== 'live' && input.datasetKind !== 'historical' && input.datasetKind !== 'synthetic') {
    throw new Error('Invalid evidence chunk dataset');
  }
  if (!ID_PATTERN.test(input.traceId) || !ID_PATTERN.test(input.reportRevisionId)) {
    throw new Error('Evidence chunk trace and revision IDs must be valid identifiers');
  }
  if (!ID_PATTERN.test(input.normalizationVersion)) throw new Error('Invalid evidence chunk normalization version');
  if (!HASH_PATTERN.test(input.permittedTextHash)) throw new Error('Invalid permitted text SHA-256 digest');
  if (input.chunks.length < 1 || input.chunks.length > MAX_CHUNK_COUNT) {
    throw new Error('Evidence chunk count is outside the supported bound');
  }
}

function validateChunks(input: PersistEvidenceChunksInput, permittedText: string): void {
  const codePoints = Array.from(permittedText);
  const ids = new Set<string>();
  const orderedChunks = [...input.chunks].sort((left, right) => left.spanStart - right.spanStart || left.spanEnd - right.spanEnd);
  let coveredUntil = 0;

  for (const chunk of input.chunks) {
    if (!ID_PATTERN.test(chunk.chunkId) || !ID_PATTERN.test(chunk.chunkerVersion)) {
      throw new Error('Evidence chunk IDs and chunker versions must be valid identifiers');
    }
    if (ids.has(chunk.chunkId)) throw new Error('Evidence chunk IDs must be unique within a persisted set');
    ids.add(chunk.chunkId);
    if (chunk.reportRevisionId !== input.reportRevisionId
      || chunk.permittedTextHash !== input.permittedTextHash
      || chunk.normalizationVersion !== input.normalizationVersion) {
      throw new Error('Evidence chunk lineage does not match the persisted set');
    }
    if (chunk.offsetUnit !== 'unicode_code_points') throw new Error('Evidence chunks require Unicode code-point offsets');
    if (!Number.isInteger(chunk.spanStart) || !Number.isInteger(chunk.spanEnd)
      || chunk.spanStart < 0 || chunk.spanEnd <= chunk.spanStart || chunk.spanEnd > codePoints.length) {
      throw new Error('Evidence chunk span is outside its immutable report revision');
    }
    const chunkCodePoints = Array.from(chunk.text);
    if (chunkCodePoints.length > MAX_CHUNK_CODE_POINTS || chunkCodePoints.length !== chunk.spanEnd - chunk.spanStart) {
      throw new Error('Evidence chunk text length does not match its bounded code-point span');
    }
    const exactText = codePoints.slice(chunk.spanStart, chunk.spanEnd).join('');
    if (exactText !== chunk.text) throw new Error('Evidence chunk span does not resolve to its exact text');
    if (!HASH_PATTERN.test(chunk.chunkTextHash) || sha256(chunk.text) !== chunk.chunkTextHash) {
      throw new Error('Evidence chunk hash does not match its exact UTF-8 text');
    }
  }

  for (const chunk of orderedChunks) {
    if (chunk.spanStart > coveredUntil) throw new Error('Evidence chunk set leaves a gap in the immutable report revision');
    coveredUntil = Math.max(coveredUntil, chunk.spanEnd);
  }
  if (orderedChunks[0]?.spanStart !== 0 || coveredUntil !== codePoints.length) {
    throw new Error('Evidence chunk set must cover the entire immutable report revision');
  }
  if (input.chunks.some((chunk) => chunk.chunkerVersion !== input.chunks[0]!.chunkerVersion)) {
    throw new Error('Evidence chunk set must use one chunker version');
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function isAtomicGuardFailure(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const record = error as { code?: unknown; message?: unknown };
  return record.code === '22012'
    || (typeof record.message === 'string' && record.message.toLowerCase().includes('division by zero'));
}

interface RevisionTextRow {
  permitted_text: string;
  permitted_text_hash: string;
  normalization_version: string;
}

interface PersistResultRow {
  persisted_count: number | string;
  invalidated_chunk_count: number | string;
  invalidated_embedding_run_count: number | string;
  atomic_guard: number | string;
}
