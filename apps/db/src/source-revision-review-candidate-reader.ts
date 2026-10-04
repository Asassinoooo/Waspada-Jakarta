import type { SqlExecutor } from './sql.js';

export type SourceRevisionReviewCandidateDatasetKind = 'live' | 'historical' | 'synthetic';
export type SourceRevisionReviewAssertionState = 'superseded' | 'retracted' | 'withdrawn';
export type SourceRevisionReviewTargetKind = 'event_claim_set' | 'impact';

export type SourceRevisionReviewTargetIdentity =
  | { readonly kind: 'event_claim_set' }
  | { readonly kind: 'impact'; readonly impactId: string; readonly impactVersion: number };

export interface SourceRevisionReviewCandidateCursor {
  readonly observationId: string;
  readonly eventId: string;
  readonly eventVersion: number;
  readonly target: SourceRevisionReviewTargetIdentity;
}

export interface ReadSourceRevisionReviewCandidatesRequest {
  readonly datasetKind: SourceRevisionReviewCandidateDatasetKind;
  readonly limit: number;
  readonly cursor?: SourceRevisionReviewCandidateCursor | null;
}

export interface SourceRevisionReviewCandidate extends SourceRevisionReviewCandidateCursor {
  readonly datasetKind: SourceRevisionReviewCandidateDatasetKind;
  readonly assertedState: SourceRevisionReviewAssertionState;
  readonly targetReportRevisionId: string;
  readonly assertionReportRevisionId: string;
  readonly replacementReportRevisionId: string | null;
  readonly publisherObservedAt: string | null;
  readonly retrievedAt: string;
  readonly recordedAt: string;
}

export interface SourceRevisionReviewCandidatePage {
  readonly candidates: readonly SourceRevisionReviewCandidate[];
  readonly nextCursor: SourceRevisionReviewCandidateCursor | null;
}

export interface SourceRevisionReviewCandidateReader {
  read(request: unknown): Promise<SourceRevisionReviewCandidatePage>;
}

export type SourceRevisionReviewCandidateReaderErrorCode =
  | 'INVALID_REQUEST'
  | 'INVALID_RESULT'
  | 'READ_FAILED';

const ERROR_MESSAGES: Record<SourceRevisionReviewCandidateReaderErrorCode, string> = {
  INVALID_REQUEST: 'The source-revision review-candidate request is invalid.',
  INVALID_RESULT: 'The source-revision review-candidate page could not be validated.',
  READ_FAILED: 'The source-revision review-candidate page could not be read.',
};

export class SourceRevisionReviewCandidateReaderError extends Error {
  constructor(readonly code: SourceRevisionReviewCandidateReaderErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = 'SourceRevisionReviewCandidateReaderError';
  }
}

interface CandidateRow {
  readonly dataset_kind: unknown;
  readonly observation_id: unknown;
  readonly asserted_state: unknown;
  readonly target_report_revision_id: unknown;
  readonly assertion_report_revision_id: unknown;
  readonly replacement_report_revision_id: unknown;
  readonly publisher_observed_at: unknown;
  readonly retrieved_at: unknown;
  readonly recorded_at: unknown;
  readonly event_id: unknown;
  readonly event_version: unknown;
  readonly target_kind: unknown;
  readonly impact_id: unknown;
  readonly impact_version: unknown;
}

interface ValidatedRequest {
  readonly datasetKind: SourceRevisionReviewCandidateDatasetKind;
  readonly limit: number;
  readonly cursor: SourceRevisionReviewCandidateCursor | null;
}

interface ValidatedCandidate {
  readonly candidate: SourceRevisionReviewCandidate;
  readonly key: CandidateKey;
}

type CandidateKey = readonly [string, string, number, string, string, number];

const DATASETS = new Set<SourceRevisionReviewCandidateDatasetKind>([
  'live', 'historical', 'synthetic',
]);
const ASSERTION_STATES = new Set<SourceRevisionReviewAssertionState>([
  'superseded', 'retracted', 'withdrawn',
]);
const TARGET_KINDS = new Set<SourceRevisionReviewTargetKind>(['event_claim_set', 'impact']);
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const UTC_TIMESTAMP_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{6})Z$/u;
const MAX_DATABASE_INTEGER = 2_147_483_647;
const MAX_PAGE_SIZE = 100;
const REQUIRED_REQUEST_KEYS = ['datasetKind', 'limit'] as const;
const ALLOWED_REQUEST_KEYS = new Set<string>([...REQUIRED_REQUEST_KEYS, 'cursor']);
const ROW_KEYS = [
  'dataset_kind', 'observation_id', 'asserted_state', 'target_report_revision_id',
  'assertion_report_revision_id', 'replacement_report_revision_id',
  'publisher_observed_at', 'retrieved_at', 'recorded_at', 'event_id', 'event_version',
  'target_kind', 'impact_id', 'impact_version',
] as const;

export function createSourceRevisionReviewCandidateReader(
  executor: SqlExecutor,
): SourceRevisionReviewCandidateReader {
  if (!executor || typeof executor.query !== 'function') {
    throw new TypeError('Source-revision review-candidate reading requires a SQL executor');
  }

  return {
    async read(request: unknown): Promise<SourceRevisionReviewCandidatePage> {
      const options = validateRequest(request);
      const query = buildQuery(options, options.limit + 1);

      let rawRows: unknown;
      try {
        const result: unknown = await executor.query<CandidateRow>(query.statement, query.parameters);
        rawRows = isObject(result) ? result.rows : undefined;
      } catch {
        throw new SourceRevisionReviewCandidateReaderError('READ_FAILED');
      }

      const rows = validateRows(rawRows, options);
      const hasMore = rows.length > options.limit;
      if (hasMore) rows.length = options.limit;
      const last = rows.at(-1)?.candidate;

      return {
        candidates: rows.map(({ candidate }) => candidate),
        nextCursor: hasMore && last !== undefined ? cursorFromCandidate(last) : null,
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
    options.cursor !== null,
    options.cursor?.observationId ?? null,
    options.cursor?.eventId ?? null,
    options.cursor?.eventVersion ?? null,
    options.cursor?.target.kind ?? null,
    options.cursor?.target.kind === 'impact' ? options.cursor.target.impactId : null,
    options.cursor?.target.kind === 'impact' ? options.cursor.target.impactVersion : null,
    probeLimit,
  ];

  return {
    statement: `
      WITH observations AS (
        SELECT observation.dataset_kind, observation.observation_id,
               observation.asserted_state, observation.target_report_revision_id,
               observation.assertion_report_revision_id,
               observation.replacement_report_revision_id,
               to_char(observation.publisher_observed_at AT TIME ZONE 'UTC',
                       'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS publisher_observed_at,
               to_char(observation.retrieved_at AT TIME ZONE 'UTC',
                       'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS retrieved_at,
               to_char(observation.recorded_at AT TIME ZONE 'UTC',
                       'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS recorded_at
        FROM waspada.report_revision_source_observations AS observation
        WHERE observation.dataset_kind = $1::text
          AND observation.asserted_state IN ('superseded', 'retracted', 'withdrawn')
          AND (NOT $2::boolean OR observation.observation_id COLLATE "C"
               >= $3::text COLLATE "C")
      ),
      current_events AS (
        SELECT event.dataset_kind, event.event_id, event.version AS event_version
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
      matched_claims AS (
        SELECT DISTINCT observation.dataset_kind, observation.observation_id,
               current.event_id, current.event_version, claim_evidence.claim_id
        FROM observations AS observation
        JOIN current_events AS current
          ON current.dataset_kind = observation.dataset_kind
        JOIN waspada.event_claim_evidence AS claim_evidence
          ON claim_evidence.dataset_kind = current.dataset_kind
         AND claim_evidence.event_id = current.event_id
         AND claim_evidence.event_version = current.event_version
        JOIN waspada.evidence_references AS evidence
          ON evidence.dataset_kind = claim_evidence.dataset_kind
         AND evidence.evidence_ref_id = claim_evidence.evidence_ref_id
        WHERE claim_evidence.evidence_kind = 'support'
          AND evidence.relation = 'supports'
          AND evidence.report_revision_id = observation.target_report_revision_id
      ),
      event_targets AS (
        SELECT matched.dataset_kind, matched.observation_id,
               matched.event_id, matched.event_version,
               'event_claim_set'::text AS target_kind,
               NULL::text AS impact_id, NULL::integer AS impact_version
        FROM matched_claims AS matched
        GROUP BY matched.dataset_kind, matched.observation_id,
                 matched.event_id, matched.event_version
      ),
      impact_targets AS (
        SELECT DISTINCT matched.dataset_kind, matched.observation_id,
               matched.event_id, matched.event_version,
               'impact'::text AS target_kind,
               reference.impact_id, reference.impact_version
        FROM matched_claims AS matched
        JOIN waspada.event_impact_refs AS reference
          ON reference.dataset_kind = matched.dataset_kind
         AND reference.event_id = matched.event_id
         AND reference.event_version = matched.event_version
        JOIN waspada.impact_claim_support AS impact_support
          ON impact_support.dataset_kind = reference.dataset_kind
         AND impact_support.impact_id = reference.impact_id
         AND impact_support.impact_version = reference.impact_version
         AND impact_support.event_id = reference.event_id
         AND impact_support.event_version = reference.event_version
         AND impact_support.claim_id = matched.claim_id
      ),
      targets AS (
        SELECT * FROM event_targets
        UNION ALL
        SELECT * FROM impact_targets
      )
      SELECT observation.dataset_kind, observation.observation_id,
             observation.asserted_state, observation.target_report_revision_id,
             observation.assertion_report_revision_id,
             observation.replacement_report_revision_id,
             observation.publisher_observed_at, observation.retrieved_at,
             observation.recorded_at, target.event_id, target.event_version,
             target.target_kind, target.impact_id, target.impact_version
      FROM targets AS target
      JOIN observations AS observation
        ON observation.dataset_kind = target.dataset_kind
       AND observation.observation_id = target.observation_id
      WHERE NOT $2::boolean OR ROW(
          target.observation_id COLLATE "C", target.event_id COLLATE "C",
          target.event_version, target.target_kind COLLATE "C",
          COALESCE(target.impact_id, '') COLLATE "C",
          COALESCE(target.impact_version, 0)
        ) > ROW(
          $3::text COLLATE "C", $4::text COLLATE "C", $5::integer,
          $6::text COLLATE "C", COALESCE($7::text, '') COLLATE "C",
          COALESCE($8::integer, 0)
        )
      ORDER BY target.observation_id COLLATE "C" ASC,
               target.event_id COLLATE "C" ASC, target.event_version ASC,
               target.target_kind COLLATE "C" ASC,
               COALESCE(target.impact_id, '') COLLATE "C" ASC,
               COALESCE(target.impact_version, 0) ASC
      LIMIT $9::integer
    `,
    parameters,
  };
}

function validateRequest(value: unknown): ValidatedRequest {
  if (!isObject(value)) return invalidRequest();
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== 'string' || !ALLOWED_REQUEST_KEYS.has(key))
    || REQUIRED_REQUEST_KEYS.some((key) => !Object.hasOwn(value, key))) {
    return invalidRequest();
  }
  if (typeof value.datasetKind !== 'string'
    || !DATASETS.has(value.datasetKind as SourceRevisionReviewCandidateDatasetKind)) {
    return invalidRequest();
  }
  if (!Number.isSafeInteger(value.limit)
    || (value.limit as number) < 1
    || (value.limit as number) > MAX_PAGE_SIZE) {
    return invalidRequest();
  }

  let cursor: SourceRevisionReviewCandidateCursor | null = null;
  if (Object.hasOwn(value, 'cursor')) {
    if (value.cursor !== null) cursor = validateCursor(value.cursor);
    if (value.cursor !== null && cursor === null) return invalidRequest();
  }

  return {
    datasetKind: value.datasetKind as SourceRevisionReviewCandidateDatasetKind,
    limit: value.limit as number,
    cursor,
  };
}

function validateCursor(value: unknown): SourceRevisionReviewCandidateCursor | null {
  if (!isObject(value)
    || !hasExactKeys(value, ['observationId', 'eventId', 'eventVersion', 'target'])
    || !isId(value.observationId)
    || !isId(value.eventId)
    || !isPositiveDatabaseInteger(value.eventVersion)) {
    return null;
  }
  const target = validateTargetIdentity(value.target);
  return target === null ? null : {
    observationId: value.observationId,
    eventId: value.eventId,
    eventVersion: value.eventVersion,
    target,
  };
}

function validateTargetIdentity(value: unknown): SourceRevisionReviewTargetIdentity | null {
  if (!isObject(value) || typeof value.kind !== 'string'
    || !TARGET_KINDS.has(value.kind as SourceRevisionReviewTargetKind)) {
    return null;
  }
  if (value.kind === 'event_claim_set' && hasExactKeys(value, ['kind'])) {
    return { kind: 'event_claim_set' };
  }
  if (value.kind === 'impact' && hasExactKeys(value, ['kind', 'impactId', 'impactVersion'])
    && isId(value.impactId)
    && isPositiveDatabaseInteger(value.impactVersion)) {
    return { kind: 'impact', impactId: value.impactId, impactVersion: value.impactVersion };
  }
  return null;
}

function validateRows(rows: unknown, request: ValidatedRequest): ValidatedCandidate[] {
  if (!Array.isArray(rows) || rows.length > request.limit + 1) return invalidResult();
  const validated: ValidatedCandidate[] = [];
  let previousKey: CandidateKey | null = null;
  const cursorKey = request.cursor === null ? null : keyFromCursor(request.cursor);

  for (const row of rows) {
    if (!isObject(row)
      || !hasExactKeys(row, ROW_KEYS)
      || row.dataset_kind !== request.datasetKind
      || !isId(row.observation_id)
      || typeof row.asserted_state !== 'string'
      || !ASSERTION_STATES.has(row.asserted_state as SourceRevisionReviewAssertionState)
      || !isId(row.target_report_revision_id)
      || !isId(row.assertion_report_revision_id)
      || !isIdOrNull(row.replacement_report_revision_id)
      || (row.asserted_state === 'superseded') !== (row.replacement_report_revision_id !== null)
      || !isUtcTimestampOrNull(row.publisher_observed_at)
      || !isUtcTimestamp(row.retrieved_at)
      || !isUtcTimestamp(row.recorded_at)
      || !isId(row.event_id)
      || !isPositiveDatabaseInteger(row.event_version)
      || typeof row.target_kind !== 'string'
      || !TARGET_KINDS.has(row.target_kind as SourceRevisionReviewTargetKind)) {
      return invalidResult();
    }

    let target: SourceRevisionReviewTargetIdentity;
    if (row.target_kind === 'event_claim_set') {
      if (row.impact_id !== null || row.impact_version !== null) return invalidResult();
      target = { kind: 'event_claim_set' };
    } else {
      if (!isId(row.impact_id) || !isPositiveDatabaseInteger(row.impact_version)) return invalidResult();
      target = {
        kind: 'impact',
        impactId: row.impact_id,
        impactVersion: row.impact_version as number,
      };
    }

    const candidate: SourceRevisionReviewCandidate = {
      datasetKind: request.datasetKind,
      observationId: row.observation_id,
      assertedState: row.asserted_state as SourceRevisionReviewAssertionState,
      targetReportRevisionId: row.target_report_revision_id,
      assertionReportRevisionId: row.assertion_report_revision_id,
      replacementReportRevisionId: row.replacement_report_revision_id,
      publisherObservedAt: row.publisher_observed_at,
      retrievedAt: row.retrieved_at,
      recordedAt: row.recorded_at,
      eventId: row.event_id,
      eventVersion: row.event_version as number,
      target,
    };
    const key = keyFromCandidate(candidate);
    if ((previousKey !== null && compareKeys(key, previousKey) <= 0)
      || (cursorKey !== null && compareKeys(key, cursorKey) <= 0)) {
      return invalidResult();
    }
    previousKey = key;
    validated.push({ candidate, key });
  }

  return validated;
}

function cursorFromCandidate(candidate: SourceRevisionReviewCandidate): SourceRevisionReviewCandidateCursor {
  return {
    observationId: candidate.observationId,
    eventId: candidate.eventId,
    eventVersion: candidate.eventVersion,
    target: candidate.target,
  };
}

function keyFromCursor(cursor: SourceRevisionReviewCandidateCursor): CandidateKey {
  return [
    cursor.observationId,
    cursor.eventId,
    cursor.eventVersion,
    cursor.target.kind,
    cursor.target.kind === 'impact' ? cursor.target.impactId : '',
    cursor.target.kind === 'impact' ? cursor.target.impactVersion : 0,
  ];
}

function keyFromCandidate(candidate: SourceRevisionReviewCandidate): CandidateKey {
  return keyFromCursor(candidate);
}

function compareKeys(left: CandidateKey, right: CandidateKey): number {
  const observationOrder = compareStrings(left[0], right[0]);
  if (observationOrder !== 0) return observationOrder;
  const eventOrder = compareStrings(left[1], right[1]);
  if (eventOrder !== 0) return eventOrder;
  if (left[2] !== right[2]) return left[2] < right[2] ? -1 : 1;
  const kindOrder = compareStrings(left[3], right[3]);
  if (kindOrder !== 0) return kindOrder;
  const impactOrder = compareStrings(left[4], right[4]);
  if (impactOrder !== 0) return impactOrder;
  return left[5] === right[5] ? 0 : left[5] < right[5] ? -1 : 1;
}

function compareStrings(left: string, right: string): number {
  return left === right ? 0 : left < right ? -1 : 1;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const expected = new Set(keys);
  const actual = Reflect.ownKeys(value);
  return actual.length === expected.size
    && actual.every((key) => typeof key === 'string' && expected.has(key));
}

function isId(value: unknown): value is string {
  return typeof value === 'string' && ID_PATTERN.test(value);
}

function isIdOrNull(value: unknown): value is string | null {
  return value === null || isId(value);
}

function isPositiveDatabaseInteger(value: unknown): value is number {
  return Number.isSafeInteger(value)
    && (value as number) > 0
    && (value as number) <= MAX_DATABASE_INTEGER;
}

function isUtcTimestampOrNull(value: unknown): value is string | null {
  return value === null || isUtcTimestamp(value);
}

function isUtcTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = UTC_TIMESTAMP_PATTERN.exec(value);
  if (!match) return false;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  if (year < 1 || month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) return false;
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysByMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day >= 1 && day <= daysByMonth[month - 1]!;
}

function invalidRequest(): never {
  throw new SourceRevisionReviewCandidateReaderError('INVALID_REQUEST');
}

function invalidResult(): never {
  throw new SourceRevisionReviewCandidateReaderError('INVALID_RESULT');
}
