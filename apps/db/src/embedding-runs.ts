import { createHash } from 'node:crypto';
import type { DatasetKind } from './ports.js';
import type { TransactionalSqlExecutor } from './sql.js';

export type EmbeddingRunDistanceMetric = 'cosine' | 'dot_product' | 'euclidean';

/** Closed schema 2.0 metadata record. The vector is passed separately. */
export interface EmbeddingRunRecord {
  readonly schema_version: '2.0';
  readonly trace_id: string;
  readonly record_type: 'EmbeddingRun';
  readonly dataset_kind: DatasetKind;
  readonly embedding_run_id: string;
  readonly chunk_id: string;
  readonly capability: 'embedding';
  readonly provider: string;
  readonly model_version: string;
  readonly dimensions: number;
  readonly distance_metric: EmbeddingRunDistanceMetric;
  readonly vector_index_version: string;
  readonly input_text_hash: string;
  readonly status: 'available';
  readonly created_at: string;
}

export type EmbeddingRunWriteOutcome = 'created' | 'replayed' | 'unavailable';

export interface EmbeddingRunRepository {
  createOrVerify(record: EmbeddingRunRecord, vector: readonly number[]): Promise<EmbeddingRunWriteOutcome>;
}

export type EmbeddingRunRepositoryErrorCode =
  | 'invalid_embedding_run'
  | 'embedding_run_reference_not_found'
  | 'embedding_run_lineage_mismatch'
  | 'embedding_run_conflict'
  | 'embedding_run_unavailable'
  | 'embedding_run_integrity_error'
  | 'embedding_run_persistence_failed';

/** Errors expose a fixed code only; they never include record, vector, or driver contents. */
export class EmbeddingRunRepositoryError extends Error {
  readonly code: EmbeddingRunRepositoryErrorCode;

  constructor(code: EmbeddingRunRepositoryErrorCode) {
    super(code);
    this.name = 'EmbeddingRunRepositoryError';
    this.code = code;
  }
}

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const RUN_FIELDS = [
  'schema_version', 'trace_id', 'record_type', 'dataset_kind', 'embedding_run_id', 'chunk_id',
  'capability', 'provider', 'model_version', 'dimensions', 'distance_metric',
  'vector_index_version', 'input_text_hash', 'status', 'created_at',
] as const;
const MAX_VECTOR_DIMENSIONS = 2_048;
const MAX_PROVIDER_CODE_POINTS = 120;
const MAX_MODEL_VERSION_CODE_POINTS = 200;
const RFC3339_MICROSECOND_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(Z|([+-])(\d{2}):(\d{2}))$/;

export function createSqlEmbeddingRunRepository(executor: TransactionalSqlExecutor): EmbeddingRunRepository {
  if (!executor || typeof executor.transaction !== 'function') {
    throw new TypeError('Embedding run persistence requires a transactional SQL executor');
  }
  return new SqlEmbeddingRunRepository(executor);
}

class SqlEmbeddingRunRepository implements EmbeddingRunRepository {
  constructor(private readonly executor: TransactionalSqlExecutor) {}

  async createOrVerify(recordInput: EmbeddingRunRecord, vectorInput: readonly number[]): Promise<EmbeddingRunWriteOutcome> {
    const record = validateRecord(recordInput);
    const vector = validateVector(vectorInput, record);
    const vectorLiteral = toVectorLiteral(vector);
    const createdAtSql = normalizeCreatedAt(record.created_at);

    try {
      return await this.executor.transaction(async (transaction) => {
        await transaction.query(
          'SELECT pg_advisory_xact_lock(hashtext($1::text), hashtext($2::text))',
          [record.dataset_kind, record.embedding_run_id],
        );

        const trace = await transaction.query<{ trace_id: string }>(
          `SELECT trace_id
           FROM waspada.traces
           WHERE dataset_kind = $1 AND trace_id = $2`,
          [record.dataset_kind, record.trace_id],
        );
        if (!trace.rows[0]) throw new EmbeddingRunRepositoryError('embedding_run_reference_not_found');

        const chunkResult = await transaction.query<ChunkLineageRow>(
          `SELECT chunk.dataset_kind, chunk.chunk_id,
                  chunk.report_revision_id, chunk.permitted_text_hash,
                  chunk.span_start, chunk.span_end, chunk.offset_unit,
                  chunk.chunk_text_hash, chunk.status AS chunk_status,
                  revision.permitted_text, revision.permitted_text_hash AS revision_text_hash,
                  revision.revision_status
           FROM waspada.evidence_chunks AS chunk
           JOIN waspada.report_revisions AS revision
             ON revision.dataset_kind = chunk.dataset_kind
            AND revision.report_revision_id = chunk.report_revision_id
           WHERE chunk.dataset_kind = $1 AND chunk.chunk_id = $2
           FOR UPDATE OF chunk`,
          [record.dataset_kind, record.chunk_id],
        );
        const chunk = chunkResult.rows[0];
        if (!chunk) throw new EmbeddingRunRepositoryError('embedding_run_reference_not_found');
        verifyChunkLineage(record, chunk);

        const existingResult = await transaction.query<ExistingEmbeddingRunRow>(
          `SELECT run.dataset_kind, run.embedding_run_id, run.trace_id, run.chunk_id,
                  run.capability, run.provider, run.model_version, run.dimensions,
                  run.distance_metric, run.vector_index_version, run.input_text_hash,
                  run.status,
                  run.created_at IS NOT DISTINCT FROM $3::timestamptz AS created_at_matches,
                  vector.embedding IS NOT NULL AS vector_present,
                  vector.dimensions AS vector_dimensions,
                  vector_dims(vector.embedding) AS vector_actual_dimensions,
                  CASE
                    WHEN vector.dimensions = run.dimensions
                     AND vector_dims(vector.embedding) = run.dimensions
                     AND run.dimensions = $5::integer
                    THEN vector.embedding = $4::vector
                    ELSE false
                  END AS vector_matches
           FROM waspada.embedding_runs AS run
           LEFT JOIN waspada.embedding_vectors AS vector
             ON vector.dataset_kind = run.dataset_kind
            AND vector.embedding_run_id = run.embedding_run_id
           WHERE run.dataset_kind = $1 AND run.embedding_run_id = $2`,
          [record.dataset_kind, record.embedding_run_id, createdAtSql, vectorLiteral, record.dimensions],
        );
        const existing = existingResult.rows[0];

        if (existing) {
          if (existing.vector_present !== true
            || existing.vector_dimensions !== existing.dimensions
            || existing.vector_actual_dimensions !== existing.dimensions) {
            throw new EmbeddingRunRepositoryError('embedding_run_integrity_error');
          }
          if (!existingMetadataMatches(existing, record)
            || existing.created_at_matches !== true
            || existing.vector_matches !== true) {
            throw new EmbeddingRunRepositoryError('embedding_run_conflict');
          }
          if (existing.status === 'invalidated') return 'unavailable';
          if (existing.status !== 'available') {
            throw new EmbeddingRunRepositoryError('embedding_run_integrity_error');
          }
          if (chunk.chunk_status !== 'active'
            || !isEmbeddingEligibleRevision(chunk.revision_status)) {
            throw new EmbeddingRunRepositoryError('embedding_run_unavailable');
          }
          return 'replayed';
        }

        if (chunk.chunk_status !== 'active'
          || !isEmbeddingEligibleRevision(chunk.revision_status)) {
          throw new EmbeddingRunRepositoryError('embedding_run_unavailable');
        }

        await transaction.query(
          `INSERT INTO waspada.embedding_runs
             (dataset_kind, embedding_run_id, trace_id, chunk_id, capability, provider,
              model_version, dimensions, distance_metric, vector_index_version,
              input_text_hash, status, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'available', $12::timestamptz)`,
          [record.dataset_kind, record.embedding_run_id, record.trace_id, record.chunk_id,
            record.capability, record.provider, record.model_version, record.dimensions,
            record.distance_metric, record.vector_index_version, record.input_text_hash,
            createdAtSql],
        );
        await transaction.query(
          `INSERT INTO waspada.embedding_vectors
             (dataset_kind, embedding_run_id, dimensions, embedding)
           VALUES ($1, $2, $3, $4::vector)`,
          [record.dataset_kind, record.embedding_run_id, record.dimensions, vectorLiteral],
        );
        return 'created';
      });
    } catch (error) {
      if (error instanceof EmbeddingRunRepositoryError) throw error;
      throw new EmbeddingRunRepositoryError('embedding_run_persistence_failed');
    }
  }
}

function validateRecord(value: EmbeddingRunRecord): EmbeddingRunRecord {
  const record = exactRecord(value, RUN_FIELDS);
  if (record.schema_version !== '2.0'
    || record.record_type !== 'EmbeddingRun'
    || record.capability !== 'embedding'
    || record.status !== 'available') invalid();
  if (!isDatasetKind(record.dataset_kind)) invalid();
  if (!isId(record.trace_id) || !isId(record.embedding_run_id) || !isId(record.chunk_id)
    || !isId(record.vector_index_version)) invalid();
  if (!isBoundedString(record.provider, MAX_PROVIDER_CODE_POINTS)
    || !isBoundedString(record.model_version, MAX_MODEL_VERSION_CODE_POINTS)) invalid();
  if (typeof record.dimensions !== 'number' || !Number.isInteger(record.dimensions)
    || record.dimensions < 1 || record.dimensions > MAX_VECTOR_DIMENSIONS) invalid();
  if (record.distance_metric !== 'cosine'
    && record.distance_metric !== 'dot_product'
    && record.distance_metric !== 'euclidean') invalid();
  if (typeof record.input_text_hash !== 'string' || !HASH_PATTERN.test(record.input_text_hash)) invalid();
  if (typeof record.created_at !== 'string') invalid();
  normalizeCreatedAt(record.created_at);
  return {
    schema_version: record.schema_version as '2.0',
    trace_id: record.trace_id as string,
    record_type: record.record_type as 'EmbeddingRun',
    dataset_kind: record.dataset_kind as DatasetKind,
    embedding_run_id: record.embedding_run_id as string,
    chunk_id: record.chunk_id as string,
    capability: record.capability as 'embedding',
    provider: record.provider as string,
    model_version: record.model_version as string,
    dimensions: record.dimensions as number,
    distance_metric: record.distance_metric as EmbeddingRunDistanceMetric,
    vector_index_version: record.vector_index_version as string,
    input_text_hash: record.input_text_hash as string,
    status: record.status as 'available',
    created_at: record.created_at as string,
  };
}

function validateVector(value: readonly number[], record: EmbeddingRunRecord): readonly number[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype
    || value.length !== record.dimensions) invalid();
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== 'string'
    || (key !== 'length' && (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length)))) invalid();

  const storedValues: number[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !('value' in descriptor) || typeof descriptor.value !== 'number'
      || !Number.isFinite(descriptor.value)) invalid();
    const storedValue = Math.fround(descriptor.value);
    if (!Number.isFinite(storedValue)) invalid();
    storedValues.push(storedValue);
  }
  if (record.distance_metric === 'cosine' && storedValues.every((component) => component === 0)) invalid();
  return storedValues;
}

function verifyChunkLineage(record: EmbeddingRunRecord, chunk: ChunkLineageRow): void {
  if (chunk.dataset_kind !== record.dataset_kind || chunk.chunk_id !== record.chunk_id
    || !isId(chunk.report_revision_id) || chunk.permitted_text_hash !== chunk.revision_text_hash
    || chunk.offset_unit !== 'unicode_code_points'
    || !Number.isInteger(chunk.span_start) || !Number.isInteger(chunk.span_end)
    || chunk.span_start < 0 || chunk.span_end <= chunk.span_start
    || chunk.chunk_text_hash !== record.input_text_hash
    || sha256(chunk.permitted_text) !== chunk.revision_text_hash) {
    throw new EmbeddingRunRepositoryError('embedding_run_lineage_mismatch');
  }
  const codePoints = Array.from(chunk.permitted_text);
  if (chunk.span_end > codePoints.length) {
    throw new EmbeddingRunRepositoryError('embedding_run_lineage_mismatch');
  }
  const chunkText = codePoints.slice(chunk.span_start, chunk.span_end).join('');
  if (sha256(chunkText) !== chunk.chunk_text_hash) {
    throw new EmbeddingRunRepositoryError('embedding_run_lineage_mismatch');
  }
}

function existingMetadataMatches(row: ExistingEmbeddingRunRow, record: EmbeddingRunRecord): boolean {
  return row.dataset_kind === record.dataset_kind
    && row.embedding_run_id === record.embedding_run_id
    && row.trace_id === record.trace_id
    && row.chunk_id === record.chunk_id
    && row.capability === record.capability
    && row.provider === record.provider
    && row.model_version === record.model_version
    && row.dimensions === record.dimensions
    && row.distance_metric === record.distance_metric
    && row.vector_index_version === record.vector_index_version
    && row.input_text_hash === record.input_text_hash;
}

function exactRecord(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) invalid();
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== 'string')) invalid();
  const object = value as Record<string, unknown>;
  const expected = new Set(fields);
  const snapshot: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of keys as string[]) {
    if (!expected.has(key)) invalid();
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    if (!descriptor || !('value' in descriptor)) invalid();
    snapshot[key] = descriptor.value;
  }
  for (const field of fields) {
    if (!Object.prototype.hasOwnProperty.call(object, field)) invalid();
  }
  return snapshot;
}

function normalizeCreatedAt(value: string): string {
  const parts = RFC3339_MICROSECOND_PATTERN.exec(value);
  if (!parts) invalid();
  const [, yearText, monthText, dayText, hourText, minuteText, secondText,
    fractionText = '', zone, offsetSign, offsetHourText, offsetMinuteText] = parts;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const daysInMonth = month === 2
    ? isLeapYear(year) ? 29 : 28
    : [4, 6, 9, 11].includes(month) ? 30 : 31;
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > daysInMonth
    || hour > 23 || minute > 59 || second > 59) invalid();

  let offsetMinutes = 0;
  if (zone !== 'Z') {
    const offsetHour = Number(offsetHourText);
    const offsetMinute = Number(offsetMinuteText);
    if (offsetHour > 23 || offsetMinute > 59) invalid();
    const sign = offsetSign === '+' ? 1 : -1;
    offsetMinutes = sign * (offsetHour * 60 + offsetMinute);
  }

  const local = new Date(0);
  local.setUTCFullYear(year, month - 1, day);
  local.setUTCHours(hour, minute, second, 0);
  const utcMilliseconds = local.getTime() - offsetMinutes * 60_000;
  const utcDate = new Date(utcMilliseconds);
  if (!Number.isFinite(utcMilliseconds) || utcDate.getUTCFullYear() < 1 || utcDate.getUTCFullYear() > 9999) invalid();
  const micros = Number((fractionText + '000000').slice(0, 6));
  const pad = (part: number, width = 2) => String(part).padStart(width, '0');
  const utcYear = pad(utcDate.getUTCFullYear(), 4);
  const utcDateTime = `${utcYear}-${pad(utcDate.getUTCMonth() + 1)}-${pad(utcDate.getUTCDate())}`
    + `T${pad(utcDate.getUTCHours())}:${pad(utcDate.getUTCMinutes())}:${pad(utcDate.getUTCSeconds())}`
    + `.${pad(micros, 6)}Z`;
  return utcDateTime;
}

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function isDatasetKind(value: unknown): value is DatasetKind {
  return value === 'live' || value === 'historical' || value === 'synthetic';
}

function isId(value: unknown): value is string {
  return typeof value === 'string' && ID_PATTERN.test(value);
}

function isBoundedString(value: unknown, maximumCodePoints: number): value is string {
  return typeof value === 'string' && !value.includes('\u0000')
    && Array.from(value).length >= 1 && Array.from(value).length <= maximumCodePoints;
}

function isEmbeddingEligibleRevision(status: string): boolean {
  return status === 'unreviewed' || status === 'eligible';
}

function toVectorLiteral(values: readonly number[]): string {
  return `[${values.map((value) => String(value)).join(',')}]`;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function invalid(): never {
  throw new EmbeddingRunRepositoryError('invalid_embedding_run');
}

interface ChunkLineageRow {
  readonly dataset_kind: string;
  readonly chunk_id: string;
  readonly report_revision_id: string;
  readonly permitted_text_hash: string;
  readonly span_start: number;
  readonly span_end: number;
  readonly offset_unit: string;
  readonly chunk_text_hash: string;
  readonly chunk_status: string;
  readonly permitted_text: string;
  readonly revision_text_hash: string;
  readonly revision_status: string;
}

interface ExistingEmbeddingRunRow {
  readonly dataset_kind: string;
  readonly embedding_run_id: string;
  readonly trace_id: string;
  readonly chunk_id: string;
  readonly capability: string;
  readonly provider: string;
  readonly model_version: string;
  readonly dimensions: number;
  readonly distance_metric: string;
  readonly vector_index_version: string;
  readonly input_text_hash: string;
  readonly status: string;
  readonly created_at_matches: boolean;
  readonly vector_present: boolean;
  readonly vector_dimensions: number | null;
  readonly vector_actual_dimensions: number | null;
  readonly vector_matches: boolean;
}
