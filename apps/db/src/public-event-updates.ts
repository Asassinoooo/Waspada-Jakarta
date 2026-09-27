import type { SqlExecutor } from './sql.js';

export const PUBLIC_EVENT_UPDATES_LIMITS = Object.freeze({
  defaultPageSize: 20,
  maxPageSize: 100,
  maxSequence: '9223372036854775807',
  eventIdLength: 128,
  summaryLength: 500,
});

export const PUBLIC_EVENT_UPDATE_CHANGE_TYPES = Object.freeze([
  'published',
  'corrected',
  'impact_changed',
  'retracted',
] as const);

export type PublicEventUpdateChangeType = typeof PUBLIC_EVENT_UPDATE_CHANGE_TYPES[number];

export interface PublicEventUpdateCandidate {
  readonly datasetKind: 'live';
  readonly eventId: string;
  readonly eventVersion: number;
  /** Internal global ordering key; it is not an API cursor or public DTO field. */
  readonly changeSequence: string;
  readonly changeType: PublicEventUpdateChangeType;
  readonly summary: string;
  /** Exact publication timestamp input from the current-public history view. */
  readonly publishedAt: string;
}

export interface PublicEventUpdateCandidatePage {
  readonly candidates: readonly PublicEventUpdateCandidate[];
  readonly hasMore: boolean;
}

export interface PublicEventUpdateCandidateOptions {
  readonly afterSequence: string;
  readonly throughSequence: string;
  readonly limit?: number;
}

export interface PublicEventUpdatesReader {
  /** Reads the latest committed transactional counter as a decimal string. */
  readWatermark(): Promise<string>;
  /** Reads a bounded ascending page strictly after one sequence through another. */
  readCandidates(options: unknown): Promise<PublicEventUpdateCandidatePage>;
}

export type PublicEventUpdatesErrorCode =
  | 'INVALID_BOUNDS'
  | 'INVALID_PAGE'
  | 'WATERMARK_INVALID'
  | 'RESULT_INVALID'
  | 'READ_FAILED';

const errorMessages: Record<PublicEventUpdatesErrorCode, string> = {
  INVALID_BOUNDS: 'The public update sequence bounds are invalid.',
  INVALID_PAGE: 'The public update page size is invalid.',
  WATERMARK_INVALID: 'The public update watermark could not be validated.',
  RESULT_INVALID: 'The public update candidates could not be validated.',
  READ_FAILED: 'The public update candidates could not be read.',
};

/** Stable errors omit SQL, sequence input, event data, and database details. */
export class PublicEventUpdatesError extends Error {
  constructor(readonly code: PublicEventUpdatesErrorCode) {
    super(errorMessages[code]);
    this.name = 'PublicEventUpdatesError';
  }
}

interface WatermarkRow {
  readonly through_sequence: unknown;
}

interface CandidateRow {
  readonly dataset_kind: unknown;
  readonly event_id: unknown;
  readonly event_version: unknown;
  readonly change_sequence: unknown;
  readonly change_type: unknown;
  readonly summary: unknown;
  readonly published_at: unknown;
}

interface ValidatedOptions {
  readonly afterSequence: string;
  readonly throughSequence: string;
  readonly limit: number;
}

const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const sequencePattern = /^(0|[1-9][0-9]{0,18})$/u;
const maxDatabaseInteger = 2_147_483_647;
const timestampPattern = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|([+-])(\d{2}):(\d{2}))$/u;
const watermarkKeys = ['through_sequence'] as const;
const candidateKeys = [
  'dataset_kind', 'event_id', 'event_version', 'change_sequence',
  'change_type', 'summary', 'published_at',
] as const;

export function createPublicEventUpdatesReader(executor: SqlExecutor): PublicEventUpdatesReader {
  return {
    async readWatermark(): Promise<string> {
      const result = await queryRows<WatermarkRow>(executor,
        'SELECT through_sequence::text AS through_sequence\n'
          + 'FROM waspada.public_event_updates_watermark',
        [],
        'WATERMARK_INVALID',
      );
      if (result.rows.length !== 1) fail('WATERMARK_INVALID');
      const row = result.rows[0];
      if (!hasExactKeys(row, watermarkKeys) || !isSequence(row.through_sequence)) {
        fail('WATERMARK_INVALID');
      }
      return row.through_sequence;
    },

    async readCandidates(options: unknown): Promise<PublicEventUpdateCandidatePage> {
      const page = validateOptions(options);
      const probeLimit = page.limit + 1;
      const result = await queryRows<CandidateRow>(executor, [
        'SELECT candidates.dataset_kind, candidates.event_id, candidates.event_version,',
        '       candidates.change_sequence::text AS change_sequence, candidates.change_type,',
        '       candidates.summary, candidates.published_at',
        'FROM waspada.public_event_updates_candidates AS candidates',
        'WHERE candidates.change_sequence > $1::bigint AND candidates.change_sequence <= $2::bigint',
        'ORDER BY candidates.change_sequence ASC',
        'LIMIT $3',
      ].join('\n'), [page.afterSequence, page.throughSequence, probeLimit]);

      return validateCandidates(result.rows, page, probeLimit);
    },
  };
}

function validateOptions(value: unknown): ValidatedOptions {
  if (!isRecord(value)
    || Object.keys(value).some((key) => key !== 'afterSequence' && key !== 'throughSequence' && key !== 'limit')
    || !Object.hasOwn(value, 'afterSequence')
    || !Object.hasOwn(value, 'throughSequence')) {
    fail('INVALID_BOUNDS');
  }

  if (!isSequence(value.afterSequence)
    || !isSequence(value.throughSequence)
    || compareSequences(value.afterSequence, value.throughSequence) > 0) {
    fail('INVALID_BOUNDS');
  }

  const limit = Object.hasOwn(value, 'limit') ? value.limit : PUBLIC_EVENT_UPDATES_LIMITS.defaultPageSize;
  if (!isSafeInteger(limit, 1, PUBLIC_EVENT_UPDATES_LIMITS.maxPageSize)) fail('INVALID_PAGE');

  return {
    afterSequence: value.afterSequence,
    throughSequence: value.throughSequence,
    limit,
  };
}

function validateCandidates(
  rows: readonly unknown[],
  options: ValidatedOptions,
  probeLimit: number,
): PublicEventUpdateCandidatePage {
  if (rows.length > probeLimit) fail('RESULT_INVALID');

  const candidates: PublicEventUpdateCandidate[] = [];
  let previousSequence = options.afterSequence;
  for (const value of rows) {
    if (!hasExactKeys(value, candidateKeys)
      || value.dataset_kind !== 'live'
      || !isIdentifier(value.event_id)
      || !isPositiveDatabaseInteger(value.event_version)
      || !isSequence(value.change_sequence)
      || compareSequences(value.change_sequence, previousSequence) <= 0
      || compareSequences(value.change_sequence, options.throughSequence) > 0
      || !isChangeType(value.change_type)
      || !isValidSummary(value.summary)
      || !isTimestamp(value.published_at)) {
      fail('RESULT_INVALID');
    }

    candidates.push({
      datasetKind: 'live',
      eventId: value.event_id,
      eventVersion: value.event_version,
      changeSequence: value.change_sequence,
      changeType: value.change_type,
      summary: value.summary,
      publishedAt: value.published_at,
    });
    previousSequence = value.change_sequence;
  }

  const hasMore = candidates.length > options.limit;
  if (hasMore) candidates.length = options.limit;
  return { candidates, hasMore };
}

function isSequence(value: unknown): value is string {
  return typeof value === 'string'
    && sequencePattern.test(value)
    && compareSequences(value, PUBLIC_EVENT_UPDATES_LIMITS.maxSequence) <= 0;
}

function compareSequences(left: string, right: string): number {
  if (left.length !== right.length) return left.length < right.length ? -1 : 1;
  return left === right ? 0 : left < right ? -1 : 1;
}

function isChangeType(value: unknown): value is PublicEventUpdateChangeType {
  return typeof value === 'string'
    && (PUBLIC_EVENT_UPDATE_CHANGE_TYPES as readonly string[]).includes(value);
}

function isValidSummary(value: unknown): value is string {
  return typeof value === 'string'
    && value.trim().length > 0
    && Array.from(value).length <= PUBLIC_EVENT_UPDATES_LIMITS.summaryLength;
}

function isTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = timestampPattern.exec(value);
  if (match === null || !Number.isFinite(Date.parse(value))) return false;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetHour = match[9] === undefined ? 0 : Number(match[9]);
  const offsetMinute = match[10] === undefined ? 0 : Number(match[10]);
  if (year < 1 || month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59
    || offsetHour > 23 || offsetMinute > 59) {
    return false;
  }
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return day >= 1 && day <= daysInMonth;
}

async function queryRows<Row extends object>(
  executor: SqlExecutor,
  statement: string,
  parameters: readonly unknown[],
  invalidCode: 'WATERMARK_INVALID' | 'RESULT_INVALID' = 'RESULT_INVALID',
): Promise<{ readonly rows: readonly Row[] }> {
  let result: unknown;
  try {
    result = await executor.query<Row>(statement, parameters);
  } catch {
    fail('READ_FAILED');
  }
  if (!isRecord(result) || !Array.isArray(result.rows)) fail(invalidCode);
  return result as { readonly rows: readonly Row[] };
}

function isIdentifier(value: unknown): value is string {
  return typeof value === 'string' && identifierPattern.test(value);
}

function isPositiveDatabaseInteger(value: unknown): value is number {
  return isSafeInteger(value, 1, maxDatabaseInteger);
}

function isSafeInteger(value: unknown, minimum: number, maximum: number): value is number {
  return Number.isSafeInteger(value)
    && (value as number) >= minimum
    && (value as number) <= maximum;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function fail(code: PublicEventUpdatesErrorCode): never {
  throw new PublicEventUpdatesError(code);
}
