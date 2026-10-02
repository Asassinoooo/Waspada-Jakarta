import type { SqlExecutor } from './sql.js';

export type FreshnessDueDatasetKind = 'live' | 'historical' | 'synthetic';
export type FreshnessDueStatus = 'current' | 'needs_update' | 'expired';
export type FreshnessDueTargetKind = 'event_claim_set' | 'impact';

export type FreshnessDueTargetIdentity =
  | { readonly kind: 'event_claim_set' }
  | { readonly kind: 'impact'; readonly impactId: string; readonly impactVersion: number };

export interface FreshnessDueTargetCursor {
  readonly eventId: string;
  readonly eventVersion: number;
  readonly target: FreshnessDueTargetIdentity;
}

export interface ReadFreshnessDueTargetsRequest {
  readonly datasetKind: FreshnessDueDatasetKind;
  /** The caller's explicit RFC 3339 evaluation instant. This repository has no clock. */
  readonly now: string;
  readonly limit: number;
  readonly cursor?: FreshnessDueTargetCursor | null;
}

export interface FreshnessDueTarget extends FreshnessDueTargetCursor {
  readonly datasetKind: FreshnessDueDatasetKind;
  readonly status: FreshnessDueStatus;
  /** Zero means no transition exists for this exact target version. */
  readonly transitionSequence: number;
  readonly validUntil: string | null;
  readonly reviewDueAt: string | null;
}

export interface FreshnessDueTargetPage {
  readonly targets: readonly FreshnessDueTarget[];
  readonly nextCursor: FreshnessDueTargetCursor | null;
}

export interface FreshnessDueTargetReader {
  read(request: unknown): Promise<FreshnessDueTargetPage>;
}

export type FreshnessDueTargetReaderErrorCode = 'INVALID_REQUEST' | 'INVALID_RESULT' | 'READ_FAILED';

const errorMessages: Record<FreshnessDueTargetReaderErrorCode, string> = {
  INVALID_REQUEST: 'The freshness due-target request is invalid.',
  INVALID_RESULT: 'The freshness due-target page could not be validated.',
  READ_FAILED: 'The freshness due-target page could not be read.',
};

/** Stable, content-free errors never include caller values, cursors, SQL, or database details. */
export class FreshnessDueTargetReaderError extends Error {
  constructor(readonly code: FreshnessDueTargetReaderErrorCode) {
    super(errorMessages[code]);
    this.name = 'FreshnessDueTargetReaderError';
  }
}

interface DueTargetRow {
  readonly dataset_kind: unknown;
  readonly event_id: unknown;
  readonly event_version: unknown;
  readonly target_kind: unknown;
  readonly impact_id: unknown;
  readonly impact_version: unknown;
  readonly status: unknown;
  readonly transition_sequence: unknown;
  readonly valid_until: unknown;
  readonly review_due_at: unknown;
}

interface ParsedInstant {
  readonly epochSecond: number;
  readonly fraction: string;
}

interface ValidatedRequest {
  readonly datasetKind: FreshnessDueDatasetKind;
  readonly now: string;
  readonly parsedNow: ParsedInstant;
  readonly limit: number;
  readonly cursor: FreshnessDueTargetCursor | null;
}

interface ValidatedRow {
  readonly target: FreshnessDueTarget;
  readonly key: readonly [string, number, string, string, number];
}

const DATASETS = new Set<FreshnessDueDatasetKind>(['live', 'historical', 'synthetic']);
const STATUSES = new Set<FreshnessDueStatus>(['current', 'needs_update', 'expired']);
const TARGET_KINDS = new Set<FreshnessDueTargetKind>(['event_claim_set', 'impact']);
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const RFC3339_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|([+-])(\d{2}):(\d{2}))$/u;
const MAX_DATABASE_INTEGER = 2_147_483_647;
const MAX_TIMESTAMP_LENGTH = 128;
const MAX_PAGE_SIZE = 100;
const REQUEST_KEYS = ['datasetKind', 'now', 'limit'] as const;
const ALLOWED_REQUEST_KEYS = new Set<string>([...REQUEST_KEYS, 'cursor']);

export function createFreshnessDueTargetReader(executor: SqlExecutor): FreshnessDueTargetReader {
  if (!executor || typeof executor.query !== 'function') {
    throw new TypeError('Freshness due-target reading requires a SQL executor');
  }

  return {
    async read(request: unknown): Promise<FreshnessDueTargetPage> {
      const options = validateRequest(request);
      const probeLimit = options.limit + 1;
      const query = buildQuery(options, probeLimit);

      let rawRows: unknown;
      try {
        const result: unknown = await executor.query<DueTargetRow>(query.statement, query.parameters);
        rawRows = isObject(result) ? result.rows : undefined;
      } catch {
        throw new FreshnessDueTargetReaderError('READ_FAILED');
      }

      const rows = validateRows(rawRows, options);
      const hasMore = rows.length > options.limit;
      if (hasMore) rows.length = options.limit;
      const last = rows.at(-1)?.target;

      return {
        targets: rows.map(({ target }) => target),
        nextCursor: hasMore && last !== undefined ? cursorFromTarget(last) : null,
      };
    },
  };
}

function buildQuery(options: ValidatedRequest, probeLimit: number): {
  readonly statement: string;
  readonly parameters: readonly unknown[];
} {
  const parameters: unknown[] = [
    options.datasetKind,
    options.now,
    options.cursor !== null,
    options.cursor?.eventId ?? null,
    options.cursor?.eventVersion ?? null,
    options.cursor?.target.kind ?? null,
    options.cursor?.target.kind === 'impact' ? options.cursor.target.impactId : null,
    options.cursor?.target.kind === 'impact' ? options.cursor.target.impactVersion : null,
    probeLimit,
  ];

  const nowSeconds = wholeSecondSql('$2::text');
  const nowFraction = fractionSql('$2::text');
  const validUntilSeconds = wholeSecondSql('target.valid_until');
  const validUntilFraction = fractionSql('target.valid_until');
  const reviewDueSeconds = wholeSecondSql('target.review_due_at');
  const reviewDueFraction = fractionSql('target.review_due_at');
  const validUntilDue = instantAtOrBefore(validUntilSeconds, validUntilFraction);
  const reviewDue = instantAtOrBefore(reviewDueSeconds, reviewDueFraction);

  return {
    statement: `
      WITH request_time AS (
        SELECT ${nowSeconds} AS second, ${nowFraction} AS fraction
      ),
      current_events AS (
        SELECT event.dataset_kind, event.event_id, event.version, event.record_json
        FROM waspada.event_versions AS event
        WHERE event.dataset_kind = $1::text
          AND event.publication_status = 'published'
          AND NOT EXISTS (
            SELECT 1
            FROM waspada.event_versions AS newer
            WHERE newer.dataset_kind = event.dataset_kind
              AND newer.event_id = event.event_id
              AND newer.version > event.version
          )
      ),
      event_targets AS (
        SELECT event.dataset_kind, event.event_id, event.version AS event_version,
               'event_claim_set'::text AS target_kind,
               NULL::text AS impact_id, NULL::integer AS impact_version,
               COALESCE(transition.resulting_status,
                        event.record_json #>> '{freshness,status}') AS status,
               COALESCE(transition.transition_sequence, 0)::integer AS transition_sequence,
               event.record_json #>> '{validity,valid_until}' AS valid_until,
               event.record_json #>> '{freshness,review_due_at}' AS review_due_at
        FROM current_events AS event
        LEFT JOIN LATERAL (
          SELECT latest.resulting_status, latest.transition_sequence
          FROM waspada.freshness_transitions AS latest
          WHERE latest.dataset_kind = event.dataset_kind
            AND latest.event_id = event.event_id
            AND latest.event_version = event.version
            AND latest.target_kind = 'event_claim_set'
          ORDER BY latest.transition_sequence DESC
          LIMIT 1
        ) AS transition ON true
      ),
      impact_targets AS (
        SELECT event.dataset_kind, event.event_id, event.version AS event_version,
               'impact'::text AS target_kind,
               reference.impact_id, reference.impact_version,
               COALESCE(transition.resulting_status,
                        impact.record_json #>> '{freshness,status}') AS status,
               COALESCE(transition.transition_sequence, 0)::integer AS transition_sequence,
               impact.record_json #>> '{validity,valid_until}' AS valid_until,
               impact.record_json #>> '{freshness,review_due_at}' AS review_due_at
        FROM current_events AS event
        JOIN waspada.event_impact_refs AS reference
          ON reference.dataset_kind = event.dataset_kind
         AND reference.event_id = event.event_id
         AND reference.event_version = event.version
        JOIN waspada.impact_versions AS impact
          ON impact.dataset_kind = reference.dataset_kind
         AND impact.event_id = reference.event_id
         AND impact.impact_id = reference.impact_id
         AND impact.version = reference.impact_version
        LEFT JOIN LATERAL (
          SELECT latest.resulting_status, latest.transition_sequence
          FROM waspada.freshness_transitions AS latest
          WHERE latest.dataset_kind = reference.dataset_kind
            AND latest.event_id = reference.event_id
            AND latest.event_version = reference.event_version
            AND latest.target_kind = 'impact'
            AND latest.impact_id = reference.impact_id
            AND latest.impact_version = reference.impact_version
          ORDER BY latest.transition_sequence DESC
          LIMIT 1
        ) AS transition ON true
      ),
      targets AS (
        SELECT * FROM event_targets
        UNION ALL
        SELECT * FROM impact_targets
      ),
      target_instants AS (
        SELECT target.*,
               CASE WHEN target.valid_until IS NULL THEN NULL
                    ELSE ${validUntilSeconds} END AS valid_until_second,
               CASE WHEN target.valid_until IS NULL THEN ''::text
                    ELSE ${validUntilFraction} END AS valid_until_fraction,
               CASE WHEN target.review_due_at IS NULL THEN NULL
                    ELSE ${reviewDueSeconds} END AS review_due_second,
               CASE WHEN target.review_due_at IS NULL THEN ''::text
                    ELSE ${reviewDueFraction} END AS review_due_fraction
        FROM targets AS target
      ),
      due_targets AS (
        SELECT target.*
        FROM target_instants AS target
        CROSS JOIN request_time
        WHERE (
          target.status IN ('current', 'needs_update')
          AND target.valid_until IS NOT NULL
          AND ${validUntilDue}
        ) OR (
          target.status = 'current'
          AND target.review_due_at IS NOT NULL
          AND ${reviewDue}
        )
      )
      SELECT due.dataset_kind, due.event_id, due.event_version, due.target_kind,
             due.impact_id, due.impact_version, due.status, due.transition_sequence,
             due.valid_until, due.review_due_at
      FROM due_targets AS due
      WHERE NOT $3::boolean OR ROW(
          due.event_id COLLATE "C", due.event_version, due.target_kind COLLATE "C",
          COALESCE(due.impact_id, '') COLLATE "C", COALESCE(due.impact_version, 0)
        ) > ROW(
          $4::text COLLATE "C", $5::integer, $6::text COLLATE "C",
          COALESCE($7::text, '') COLLATE "C", COALESCE($8::integer, 0)
        )
      ORDER BY due.event_id COLLATE "C" ASC, due.event_version ASC,
               due.target_kind COLLATE "C" ASC,
               COALESCE(due.impact_id, '') COLLATE "C" ASC,
               COALESCE(due.impact_version, 0) ASC
      LIMIT $9::integer
    `,
    parameters,
  };
}

function wholeSecondSql(expression: string): string {
  const zone = `CASE WHEN right(${expression}, 1) = 'Z' THEN 'Z' ELSE right(${expression}, 6) END`;
  return `(substring(${expression} from 1 for 19) || ${zone})::timestamptz`;
}

function fractionSql(expression: string): string {
  const zoneLength = `CASE WHEN right(${expression}, 1) = 'Z' THEN 1 ELSE 6 END`;
  return `CASE WHEN substring(${expression} from 20 for 1) = '.' THEN `
    + `substring(${expression} from 21 for (length(${expression}) - 20 - ${zoneLength})) `
    + `ELSE ''::text END`;
}

function instantAtOrBefore(seconds: string, fraction: string): string {
  const precision = `GREATEST(length(${fraction}), length(request_time.fraction))`;
  return `(${seconds} < request_time.second OR (${seconds} = request_time.second AND `
    + `rpad(${fraction}, ${precision}, '0') <= `
    + `rpad(request_time.fraction, ${precision}, '0')))`;
}

function validateRequest(value: unknown): ValidatedRequest {
  if (!isObject(value)) return invalidRequest();
  const keys = Object.keys(value);
  if (keys.some((key) => !ALLOWED_REQUEST_KEYS.has(key))
    || REQUEST_KEYS.some((key) => !(key in value))) {
    return invalidRequest();
  }
  if (typeof value.datasetKind !== 'string' || !DATASETS.has(value.datasetKind as FreshnessDueDatasetKind)) {
    return invalidRequest();
  }
  if (typeof value.now !== 'string' || value.now.length > MAX_TIMESTAMP_LENGTH) return invalidRequest();
  const parsedNow = parseInstant(value.now);
  if (parsedNow === null) return invalidRequest();
  if (!Number.isSafeInteger(value.limit) || (value.limit as number) < 1 || (value.limit as number) > MAX_PAGE_SIZE) {
    return invalidRequest();
  }

  let cursor: FreshnessDueTargetCursor | null = null;
  if ('cursor' in value) {
    if (value.cursor !== null) cursor = validateCursor(value.cursor);
    if (value.cursor !== null && cursor === null) return invalidRequest();
  }

  return {
    datasetKind: value.datasetKind as FreshnessDueDatasetKind,
    now: value.now,
    parsedNow,
    limit: value.limit as number,
    cursor,
  };
}

function validateCursor(value: unknown): FreshnessDueTargetCursor | null {
  if (!isObject(value) || !hasExactKeys(value, ['eventId', 'eventVersion', 'target'])
    || !isId(value.eventId) || !isPositiveDatabaseInteger(value.eventVersion)) {
    return null;
  }
  const target = validateTargetIdentity(value.target);
  return target === null ? null : { eventId: value.eventId, eventVersion: value.eventVersion, target };
}

function validateTargetIdentity(value: unknown): FreshnessDueTargetIdentity | null {
  if (!isObject(value) || typeof value.kind !== 'string' || !TARGET_KINDS.has(value.kind as FreshnessDueTargetKind)) {
    return null;
  }
  if (value.kind === 'event_claim_set' && hasExactKeys(value, ['kind'])) {
    return { kind: 'event_claim_set' };
  }
  if (value.kind === 'impact' && hasExactKeys(value, ['kind', 'impactId', 'impactVersion'])
    && isId(value.impactId) && isPositiveDatabaseInteger(value.impactVersion)) {
    return { kind: 'impact', impactId: value.impactId, impactVersion: value.impactVersion };
  }
  return null;
}

function validateRows(rows: unknown, request: ValidatedRequest): ValidatedRow[] {
  if (!Array.isArray(rows) || rows.length > request.limit + 1) return invalidResult();
  const validated: ValidatedRow[] = [];
  let previousKey: readonly [string, number, string, string, number] | null = null;
  const cursorKey = request.cursor === null ? null : keyFromCursor(request.cursor);

  for (const row of rows) {
    if (!isObject(row) || row.dataset_kind !== request.datasetKind || !isId(row.event_id)
      || !isPositiveDatabaseInteger(row.event_version) || typeof row.target_kind !== 'string'
      || !TARGET_KINDS.has(row.target_kind as FreshnessDueTargetKind)
      || typeof row.status !== 'string' || !STATUSES.has(row.status as FreshnessDueStatus)
      || !isNonnegativeDatabaseInteger(row.transition_sequence)) {
      return invalidResult();
    }

    let target: FreshnessDueTargetIdentity;
    if (row.target_kind === 'event_claim_set') {
      if (row.impact_id !== null || row.impact_version !== null) return invalidResult();
      target = { kind: 'event_claim_set' };
    } else {
      if (!isId(row.impact_id) || !isPositiveDatabaseInteger(row.impact_version)) return invalidResult();
      target = { kind: 'impact', impactId: row.impact_id, impactVersion: row.impact_version };
    }

    const validUntil = nullableInstant(row.valid_until);
    const reviewDueAt = nullableInstant(row.review_due_at);
    if (validUntil === undefined || reviewDueAt === undefined) return invalidResult();
    const status = row.status as FreshnessDueStatus;
    if (!isDue(status, validUntil?.parsed ?? null, reviewDueAt?.parsed ?? null, request.parsedNow)) {
      return invalidResult();
    }

    const record: FreshnessDueTarget = {
      datasetKind: request.datasetKind,
      eventId: row.event_id,
      eventVersion: row.event_version as number,
      target,
      status,
      transitionSequence: row.transition_sequence as number,
      validUntil: validUntil?.source ?? null,
      reviewDueAt: reviewDueAt?.source ?? null,
    };
    const key = keyFromTarget(record);
    if ((previousKey !== null && compareKeys(key, previousKey) <= 0)
      || (cursorKey !== null && compareKeys(key, cursorKey) <= 0)) {
      return invalidResult();
    }
    previousKey = key;
    validated.push({ target: record, key });
  }

  return validated;
}

function nullableInstant(value: unknown): { readonly source: string; readonly parsed: ParsedInstant } | null | undefined {
  if (value === null) return null;
  if (typeof value !== 'string' || value.length > MAX_TIMESTAMP_LENGTH) return undefined;
  const parsed = parseInstant(value);
  return parsed === null ? undefined : { source: value, parsed };
}

function isDue(
  status: FreshnessDueStatus,
  validUntil: ParsedInstant | null,
  reviewDueAt: ParsedInstant | null,
  now: ParsedInstant,
): boolean {
  return ((status === 'current' || status === 'needs_update')
      && validUntil !== null && compareInstants(validUntil, now) <= 0)
    || (status === 'current' && reviewDueAt !== null && compareInstants(reviewDueAt, now) <= 0);
}

function parseInstant(value: string): ParsedInstant | null {
  const match = RFC3339_PATTERN.exec(value);
  if (match === null) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetHour = match[10] === undefined ? 0 : Number(match[10]);
  const offsetMinute = match[11] === undefined ? 0 : Number(match[11]);
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)
    || hour > 23 || minute > 59 || second > 59 || offsetHour > 23 || offsetMinute > 59) {
    return null;
  }

  const wallClock = new Date(0);
  wallClock.setUTCFullYear(year, month - 1, day);
  wallClock.setUTCHours(hour, minute, second, 0);
  const offsetSeconds = (offsetHour * 60 + offsetMinute) * 60
    * (match[9] === '+' ? 1 : match[9] === '-' ? -1 : 0);
  const epochSecond = wallClock.getTime() / 1_000 - offsetSeconds;
  if (!Number.isSafeInteger(epochSecond)) return null;
  return { epochSecond, fraction: (match[7] ?? '').replace(/0+$/u, '') };
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31;
}

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function compareInstants(left: ParsedInstant, right: ParsedInstant): number {
  if (left.epochSecond !== right.epochSecond) return left.epochSecond < right.epochSecond ? -1 : 1;
  const precision = Math.max(left.fraction.length, right.fraction.length);
  const leftFraction = left.fraction.padEnd(precision, '0');
  const rightFraction = right.fraction.padEnd(precision, '0');
  return leftFraction < rightFraction ? -1 : leftFraction > rightFraction ? 1 : 0;
}

function cursorFromTarget(target: FreshnessDueTarget): FreshnessDueTargetCursor {
  return { eventId: target.eventId, eventVersion: target.eventVersion, target: target.target };
}

function keyFromCursor(cursor: FreshnessDueTargetCursor): readonly [string, number, string, string, number] {
  return [
    cursor.eventId,
    cursor.eventVersion,
    cursor.target.kind,
    cursor.target.kind === 'impact' ? cursor.target.impactId : '',
    cursor.target.kind === 'impact' ? cursor.target.impactVersion : 0,
  ];
}

function keyFromTarget(target: FreshnessDueTarget): readonly [string, number, string, string, number] {
  return keyFromCursor(target);
}

function compareKeys(
  left: readonly [string, number, string, string, number],
  right: readonly [string, number, string, string, number],
): number {
  const eventIdOrder = compareStrings(left[0], right[0]);
  if (eventIdOrder !== 0) return eventIdOrder;
  if (left[1] !== right[1]) return left[1] < right[1] ? -1 : 1;
  const kindOrder = compareStrings(left[2], right[2]);
  if (kindOrder !== 0) return kindOrder;
  const impactIdOrder = compareStrings(left[3], right[3]);
  if (impactIdOrder !== 0) return impactIdOrder;
  return left[4] === right[4] ? 0 : left[4] < right[4] ? -1 : 1;
}

function compareStrings(left: string, right: string): number {
  return left === right ? 0 : left < right ? -1 : 1;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const expected = new Set(keys);
  return Object.keys(value).length === expected.size && Object.keys(value).every((key) => expected.has(key));
}

function isId(value: unknown): value is string {
  return typeof value === 'string' && ID_PATTERN.test(value);
}

function isPositiveDatabaseInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0 && (value as number) <= MAX_DATABASE_INTEGER;
}

function isNonnegativeDatabaseInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= MAX_DATABASE_INTEGER;
}

function invalidRequest(): never {
  throw new FreshnessDueTargetReaderError('INVALID_REQUEST');
}

function invalidResult(): never {
  throw new FreshnessDueTargetReaderError('INVALID_RESULT');
}
