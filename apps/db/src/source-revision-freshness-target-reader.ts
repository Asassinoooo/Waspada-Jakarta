import type { SqlExecutor } from './sql.js';

export type FreshnessTargetStatus = 'current' | 'needs_update' | 'expired';

export type FreshnessTargetIdentity =
  | { readonly kind: 'event_claim_set' }
  | { readonly kind: 'impact'; readonly impactId: string; readonly impactVersion: number };

export interface SourceRevisionFreshnessTargetRequest {
  readonly eventId: string;
  readonly eventVersion: number;
  readonly target: FreshnessTargetIdentity;
}

export interface ReadSourceRevisionFreshnessTargetsRequest {
  readonly datasetKind: 'live';
  readonly targets: readonly SourceRevisionFreshnessTargetRequest[];
}

export interface SourceRevisionFreshnessTarget extends SourceRevisionFreshnessTargetRequest {
  readonly status: FreshnessTargetStatus;
  /** Zero means this exact target version has no recorded transition. */
  readonly transitionSequence: number;
  readonly validUntil: string | null;
}

export interface SourceRevisionFreshnessTargetReader {
  read(request: unknown): Promise<readonly SourceRevisionFreshnessTarget[]>;
}

export type SourceRevisionFreshnessTargetReaderErrorCode =
  | 'INVALID_REQUEST'
  | 'INVALID_RESULT'
  | 'READ_FAILED';

const ERROR_MESSAGES: Record<SourceRevisionFreshnessTargetReaderErrorCode, string> = {
  INVALID_REQUEST: 'The source-revision freshness target request is invalid.',
  INVALID_RESULT: 'The source-revision freshness target result could not be validated.',
  READ_FAILED: 'The source-revision freshness targets could not be read.',
};

/** Stable, content-free failures do not reveal target IDs, SQL, or database diagnostics. */
export class SourceRevisionFreshnessTargetReaderError extends Error {
  constructor(readonly code: SourceRevisionFreshnessTargetReaderErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = 'SourceRevisionFreshnessTargetReaderError';
  }
}

interface TargetRow {
  readonly dataset_kind: unknown;
  readonly event_id: unknown;
  readonly event_version: unknown;
  readonly target_kind: unknown;
  readonly impact_id: unknown;
  readonly impact_version: unknown;
  readonly status: unknown;
  readonly transition_sequence: unknown;
  readonly valid_until: unknown;
}

interface TargetKey {
  readonly eventId: string;
  readonly eventVersion: number;
  readonly targetKind: FreshnessTargetIdentity['kind'];
  readonly impactId: string;
  readonly impactVersion: number;
}

interface ValidatedTarget {
  readonly target: SourceRevisionFreshnessTarget;
}

interface ValidatedRequest {
  readonly targets: readonly SourceRevisionFreshnessTargetRequest[];
  readonly targetKeys: ReadonlySet<string>;
  readonly parameter: string;
}

const MAX_TARGETS = 100;
const MAX_DATABASE_INTEGER = 2_147_483_647;
const MAX_ID_LENGTH = 128;
const MAX_TIMESTAMP_LENGTH = 128;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const RFC3339_PATTERN = /^([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})(?:\.([0-9]+))?(Z|([+-])([0-9]{2}):([0-9]{2}))$/u;
const STATUSES = new Set<FreshnessTargetStatus>(['current', 'needs_update', 'expired']);
const TARGET_KINDS = new Set<FreshnessTargetIdentity['kind']>(['event_claim_set', 'impact']);
const RESULT_KEYS = [
  'dataset_kind', 'event_id', 'event_version', 'target_kind', 'impact_id', 'impact_version',
  'status', 'transition_sequence', 'valid_until',
] as const;

/**
 * Reads effective freshness for a bounded set of exact, current live targets.
 * The repository issues one parameterized SELECT and has no write or clock path.
 */
export function createSourceRevisionFreshnessTargetReader(
  executor: SqlExecutor,
): SourceRevisionFreshnessTargetReader {
  if (!executor || typeof executor.query !== 'function') {
    throw new TypeError('Source-revision freshness target reading requires a SQL executor');
  }

  return {
    async read(request: unknown): Promise<readonly SourceRevisionFreshnessTarget[]> {
      let options: ValidatedRequest;
      try {
        options = validateRequest(request);
      } catch {
        throw readerError('INVALID_REQUEST');
      }

      let result: unknown;
      try {
        result = await executor.query<TargetRow>(buildQuery(), [options.parameter]);
      } catch {
        throw readerError('READ_FAILED');
      }

      try {
        const rawRows: unknown = isObject(result) ? result.rows : undefined;
        return validateRows(rawRows, options);
      } catch {
        throw readerError('INVALID_RESULT');
      }
    },
  };
}

function buildQuery(): string {
  return `
    WITH requested_targets AS (
      SELECT DISTINCT request.event_id, request.event_version, request.target_kind,
             request.impact_id, request.impact_version
      FROM jsonb_to_recordset($1::jsonb) AS request(
        event_id text,
        event_version integer,
        target_kind text,
        impact_id text,
        impact_version integer
      )
    ),
    current_event_targets AS (
      SELECT event.dataset_kind, event.event_id, event.version AS event_version,
             requested.target_kind, NULL::text AS impact_id, NULL::integer AS impact_version,
             COALESCE(transition.resulting_status,
                      event.record_json #>> '{freshness,status}') AS status,
             COALESCE(transition.transition_sequence, 0)::integer AS transition_sequence,
             event.record_json #>> '{validity,valid_until}' AS valid_until
      FROM requested_targets AS requested
      JOIN waspada.event_versions AS event
        ON event.dataset_kind = 'live'
       AND event.event_id = requested.event_id
       AND event.version = requested.event_version
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
      WHERE requested.target_kind = 'event_claim_set'
        AND event.publication_status = 'published'
        AND NOT EXISTS (
          SELECT 1
          FROM waspada.event_versions AS newer
          WHERE newer.dataset_kind = event.dataset_kind
            AND newer.event_id = event.event_id
            AND newer.version > event.version
        )
    ),
    current_impact_targets AS (
      SELECT event.dataset_kind, event.event_id, event.version AS event_version,
             requested.target_kind, reference.impact_id, reference.impact_version,
             COALESCE(transition.resulting_status,
                      impact.record_json #>> '{freshness,status}') AS status,
             COALESCE(transition.transition_sequence, 0)::integer AS transition_sequence,
             impact.record_json #>> '{validity,valid_until}' AS valid_until
      FROM requested_targets AS requested
      JOIN waspada.event_versions AS event
        ON event.dataset_kind = 'live'
       AND event.event_id = requested.event_id
       AND event.version = requested.event_version
       AND event.publication_status = 'published'
      JOIN waspada.event_impact_refs AS reference
        ON reference.dataset_kind = event.dataset_kind
       AND reference.event_id = event.event_id
       AND reference.event_version = event.version
       AND reference.impact_id = requested.impact_id
       AND reference.impact_version = requested.impact_version
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
      WHERE requested.target_kind = 'impact'
        AND NOT EXISTS (
          SELECT 1
          FROM waspada.event_versions AS newer
          WHERE newer.dataset_kind = event.dataset_kind
            AND newer.event_id = event.event_id
            AND newer.version > event.version
        )
    ),
    resolved_targets AS (
      SELECT * FROM current_event_targets
      UNION ALL
      SELECT * FROM current_impact_targets
    )
    SELECT target.dataset_kind, target.event_id, target.event_version, target.target_kind,
           target.impact_id, target.impact_version, target.status,
           target.transition_sequence, target.valid_until
    FROM resolved_targets AS target
    ORDER BY target.event_id COLLATE "C" ASC, target.event_version ASC,
             target.target_kind COLLATE "C" ASC,
             COALESCE(target.impact_id, '') COLLATE "C" ASC,
             COALESCE(target.impact_version, 0) ASC
    LIMIT (SELECT count(*) FROM requested_targets)
  `;
}

function validateRequest(value: unknown): ValidatedRequest {
  if (!isObject(value) || !hasExactKeys(value, ['datasetKind', 'targets'])
    || value.datasetKind !== 'live' || !Array.isArray(value.targets)
    || value.targets.length < 1 || value.targets.length > MAX_TARGETS) {
    throw readerError('INVALID_REQUEST');
  }

  const uniqueTargets = new Map<string, SourceRevisionFreshnessTargetRequest>();
  for (const candidate of value.targets) {
    const target = validateTargetRequest(candidate);
    if (target === null) throw readerError('INVALID_REQUEST');
    uniqueTargets.set(targetIdentityKey(target), target);
  }

  const targets = [...uniqueTargets.values()];
  const targetKeys = new Set(uniqueTargets.keys());
  const parameter = JSON.stringify(targets.map(({ eventId, eventVersion, target }) => ({
    event_id: eventId,
    event_version: eventVersion,
    target_kind: target.kind,
    impact_id: target.kind === 'impact' ? target.impactId : null,
    impact_version: target.kind === 'impact' ? target.impactVersion : null,
  })));

  return { targets, targetKeys, parameter };
}

function validateTargetRequest(value: unknown): SourceRevisionFreshnessTargetRequest | null {
  if (!isObject(value) || !hasExactKeys(value, ['eventId', 'eventVersion', 'target'])
    || !isId(value.eventId) || !isPositiveDatabaseInteger(value.eventVersion)) {
    return null;
  }

  const target = validateTargetIdentity(value.target);
  if (target === null) return null;
  return { eventId: value.eventId, eventVersion: value.eventVersion, target };
}

function validateTargetIdentity(value: unknown): FreshnessTargetIdentity | null {
  if (!isObject(value) || typeof value.kind !== 'string'
    || !TARGET_KINDS.has(value.kind as FreshnessTargetIdentity['kind'])) {
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

function validateRows(rows: unknown, request: ValidatedRequest): readonly SourceRevisionFreshnessTarget[] {
  if (!Array.isArray(rows) || rows.length > request.targets.length) return invalidResult();

  const validated: ValidatedTarget[] = [];
  const seen = new Set<string>();
  let previousKey: TargetKey | null = null;

  for (const row of rows) {
    if (!isObject(row) || !hasExactKeys(row, RESULT_KEYS)
      || row.dataset_kind !== 'live' || !isId(row.event_id)
      || !isPositiveDatabaseInteger(row.event_version)
      || typeof row.target_kind !== 'string'
      || !TARGET_KINDS.has(row.target_kind as FreshnessTargetIdentity['kind'])
      || typeof row.status !== 'string'
      || !STATUSES.has(row.status as FreshnessTargetStatus)
      || !isNonnegativeDatabaseInteger(row.transition_sequence)
      || !isNullableInstant(row.valid_until)) {
      return invalidResult();
    }

    let target: FreshnessTargetIdentity;
    if (row.target_kind === 'event_claim_set') {
      if (row.impact_id !== null || row.impact_version !== null) return invalidResult();
      target = { kind: 'event_claim_set' };
    } else {
      if (!isId(row.impact_id) || !isPositiveDatabaseInteger(row.impact_version)) return invalidResult();
      target = { kind: 'impact', impactId: row.impact_id, impactVersion: row.impact_version };
    }

    const key = makeKey(row.event_id, row.event_version as number, target);
    const identityKey = keyString(key);
    if (!request.targetKeys.has(identityKey) || seen.has(identityKey)
      || (previousKey !== null && compareKeys(key, previousKey) <= 0)) {
      return invalidResult();
    }
    seen.add(identityKey);
    previousKey = key;

    validated.push({
      target: {
        eventId: row.event_id,
        eventVersion: row.event_version as number,
        target,
        status: row.status as FreshnessTargetStatus,
        transitionSequence: row.transition_sequence as number,
        validUntil: row.valid_until,
      },
    });
  }

  return validated.map(({ target }) => target);
}

function makeKey(
  eventId: string,
  eventVersion: number,
  target: FreshnessTargetIdentity,
): TargetKey {
  return {
    eventId,
    eventVersion,
    targetKind: target.kind,
    impactId: target.kind === 'impact' ? target.impactId : '',
    impactVersion: target.kind === 'impact' ? target.impactVersion : 0,
  };
}

function keyString(key: TargetKey): string {
  return JSON.stringify([key.eventId, key.eventVersion, key.targetKind, key.impactId, key.impactVersion]);
}

function targetIdentityKey(target: SourceRevisionFreshnessTargetRequest): string {
  return keyString(makeKey(target.eventId, target.eventVersion, target.target));
}

function compareKeys(left: TargetKey, right: TargetKey): number {
  return compareText(left.eventId, right.eventId)
    || compareNumbers(left.eventVersion, right.eventVersion)
    || compareText(left.targetKind, right.targetKind)
    || compareText(left.impactId, right.impactId)
    || compareNumbers(left.impactVersion, right.impactVersion);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareNumbers(left: number, right: number): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isId(value: unknown): value is string {
  return typeof value === 'string' && value.length <= MAX_ID_LENGTH && ID_PATTERN.test(value);
}

function isPositiveDatabaseInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 1 && (value as number) <= MAX_DATABASE_INTEGER;
}

function isNonnegativeDatabaseInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= MAX_DATABASE_INTEGER;
}

function isNullableInstant(value: unknown): value is string | null {
  return value === null || (typeof value === 'string'
    && value.length <= MAX_TIMESTAMP_LENGTH && parseInstant(value));
}

function parseInstant(value: string): boolean {
  const match = RFC3339_PATTERN.exec(value);
  if (match === null) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetHour = match[10] === undefined ? 0 : Number(match[10]);
  const offsetMinute = match[11] === undefined ? 0 : Number(match[11]);
  return year >= 1 && month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth(year, month)
    && hour <= 23 && minute <= 59 && second <= 59
    && offsetHour <= 23 && offsetMinute <= 59;
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31;
}

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Reflect.ownKeys(value);
  return keys.length === expected.length
    && keys.every((key) => typeof key === 'string' && expected.includes(key));
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readerError(code: SourceRevisionFreshnessTargetReaderErrorCode): SourceRevisionFreshnessTargetReaderError {
  return new SourceRevisionFreshnessTargetReaderError(code);
}

function invalidResult(): never {
  throw readerError('INVALID_RESULT');
}
