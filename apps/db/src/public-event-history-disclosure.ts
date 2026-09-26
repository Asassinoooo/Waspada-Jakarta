import type { SqlExecutor } from './sql.js';

export const PUBLIC_EVENT_HISTORY_DISCLOSURE_LIMITS = Object.freeze({
  defaultPageSize: 50,
  maxPageSize: 100,
  eventIdLength: 128,
});

export const PUBLIC_EVENT_HISTORY_CHANGE_TYPES = Object.freeze([
  'published',
  'corrected',
  'impact_changed',
  'retracted',
] as const);

export type PublicEventHistoryChangeType = typeof PUBLIC_EVENT_HISTORY_CHANGE_TYPES[number];

export interface PublicEventHistoryDisclosure {
  readonly datasetKind: 'live';
  readonly eventId: string;
  readonly eventVersion: number;
  readonly reviewStatus: 'approved';
  readonly changeType: PublicEventHistoryChangeType;
  readonly summary: string;
  /** Internal opaque moderator key; never serialize this object as a public DTO. */
  readonly reviewerId: string;
  /** Review time is separate from the event version's published_at. */
  readonly reviewedAt: string;
}

export interface PublicEventHistoryDisclosureCandidate {
  readonly datasetKind: 'live';
  readonly eventId: string;
  readonly eventVersion: number;
  /** Null means this exact public version has no current approved disclosure. */
  readonly disclosure: PublicEventHistoryDisclosure | null;
}

export interface PublicEventHistoryDisclosurePage {
  readonly eventId: string;
  readonly versions: readonly PublicEventHistoryDisclosureCandidate[];
  /** False whenever a candidate version lacks approved metadata. */
  readonly coverageComplete: boolean;
  readonly nextAfterVersion: number | null;
}

export type PublicEventHistoryDisclosureReadResult =
  | { readonly kind: 'found'; readonly page: PublicEventHistoryDisclosurePage }
  | { readonly kind: 'missing' };

export interface PublicEventHistoryDisclosureRepository {
  /** Reads the bounded exact-version candidate page and exposes missing approval as a coverage gap. */
  read(eventId: unknown, options?: unknown): Promise<PublicEventHistoryDisclosureReadResult>;
}

export type PublicEventHistoryDisclosureErrorCode =
  | 'INVALID_EVENT_ID'
  | 'INVALID_PAGE'
  | 'RESULT_INVALID'
  | 'READ_FAILED';

const errorMessages: Record<PublicEventHistoryDisclosureErrorCode, string> = {
  INVALID_EVENT_ID: 'The public event identifier is invalid.',
  INVALID_PAGE: 'The public event history review page is invalid.',
  RESULT_INVALID: 'The public event history review metadata could not be validated.',
  READ_FAILED: 'The public event history review metadata could not be read.',
};

/** Stable errors never include event IDs, SQL text, review content, or database errors. */
export class PublicEventHistoryDisclosureError extends Error {
  constructor(readonly code: PublicEventHistoryDisclosureErrorCode) {
    super(errorMessages[code]);
    this.name = 'PublicEventHistoryDisclosureError';
  }
}

interface DisclosureQueryRow {
  readonly current_dataset_kind: unknown;
  readonly current_event_id: unknown;
  readonly current_version: unknown;
  readonly candidate_dataset_kind: unknown;
  readonly candidate_event_id: unknown;
  readonly candidate_version: unknown;
  readonly review_dataset_kind: unknown;
  readonly review_event_id: unknown;
  readonly review_event_version: unknown;

  readonly review_status: unknown;
  readonly change_type: unknown;
  readonly summary: unknown;
  readonly reviewer_id: unknown;
  readonly reviewed_at: unknown;
}

interface ValidatedPageOptions {
  readonly limit: number;
  readonly afterVersion: number;
}

const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const reviewerIdentifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u;
const maxDatabaseInteger = 2_147_483_647;
const timestampPattern = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|([+-])(\d{2}):(\d{2}))$/u;
const disclosureRowKeys = [
  'current_dataset_kind', 'current_event_id', 'current_version',
  'candidate_dataset_kind', 'candidate_event_id', 'candidate_version',
  'review_dataset_kind', 'review_event_id', 'review_event_version',
  'review_status', 'change_type', 'summary', 'reviewer_id', 'reviewed_at',
] as const;
const metadataFields = [
  'review_dataset_kind', 'review_event_id', 'review_event_version',
  'review_status', 'change_type', 'summary', 'reviewer_id', 'reviewed_at',
] as const;

export function createPublicEventHistoryDisclosureRepository(
  executor: SqlExecutor,
): PublicEventHistoryDisclosureRepository {
  return {
    async read(eventId: unknown, options?: unknown): Promise<PublicEventHistoryDisclosureReadResult> {
      if (!isIdentifier(eventId)) fail('INVALID_EVENT_ID');
      const pageOptions = validatePageOptions(options);
      const probeLimit = pageOptions.limit + 1;

      const result = await queryRows<DisclosureQueryRow>(executor, [
        'WITH current_event AS (',
        '  SELECT event.dataset_kind, event.event_id, event.version AS current_version',
        '  FROM waspada.public_event_versions AS event',
        "  WHERE event.dataset_kind = 'live' AND event.event_id = $1",
        '    AND EXISTS (',
        '      SELECT 1 FROM waspada.public_event_history_versions AS latest_history',
        '      WHERE latest_history.dataset_kind = event.dataset_kind',
        '        AND latest_history.event_id = event.event_id',
        '        AND latest_history.version = event.version',
        '    )',
        '), history_page AS (',
        '  SELECT history.dataset_kind, history.event_id, history.version',
        '  FROM waspada.public_event_history_versions AS history',
        '  JOIN current_event ON current_event.dataset_kind = history.dataset_kind',
        '    AND current_event.event_id = history.event_id',
        '    AND history.version <= current_event.current_version',
        "  WHERE history.dataset_kind = 'live' AND history.event_id = $1 AND history.version > $2",
        '  ORDER BY history.version ASC',
        '  LIMIT $3',
        ')',
        'SELECT current_event.dataset_kind AS current_dataset_kind,',
        '       current_event.event_id AS current_event_id,',
        '       current_event.current_version,',
        '       history_page.dataset_kind AS candidate_dataset_kind,',
        '       history_page.event_id AS candidate_event_id,',
        '       history_page.version AS candidate_version,',
        '       disclosure.dataset_kind AS review_dataset_kind,',
        '       disclosure.event_id AS review_event_id,',
        '       disclosure.event_version AS review_event_version,',
        '       disclosure.review_status, disclosure.change_type,',
        "       disclosure.summary, disclosure.reviewer_id, to_char(disclosure.reviewed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS reviewed_at",
        'FROM current_event',
        'LEFT JOIN history_page ON TRUE',
        'LEFT JOIN waspada.public_event_history_review_metadata AS disclosure',
        '  ON disclosure.dataset_kind = history_page.dataset_kind',
        ' AND disclosure.event_id = history_page.event_id',
        ' AND disclosure.event_version = history_page.version',
        'ORDER BY history_page.version ASC NULLS LAST',
      ].join('\n'), [eventId, pageOptions.afterVersion, probeLimit]);

      if (result.rows.length === 0) return { kind: 'missing' };
      return {
        kind: 'found',
        page: validateRows(result.rows, eventId, pageOptions, probeLimit),
      };
    },
  };
}

function validatePageOptions(value: unknown): ValidatedPageOptions {
  if (value === undefined) {
    return { limit: PUBLIC_EVENT_HISTORY_DISCLOSURE_LIMITS.defaultPageSize, afterVersion: 0 };
  }
  if (!isRecord(value) || Object.keys(value).some((key) => key !== 'limit' && key !== 'afterVersion')) {
    fail('INVALID_PAGE');
  }

  const limit = Object.hasOwn(value, 'limit')
    ? value.limit
    : PUBLIC_EVENT_HISTORY_DISCLOSURE_LIMITS.defaultPageSize;
  if (!isSafeInteger(limit, 1, PUBLIC_EVENT_HISTORY_DISCLOSURE_LIMITS.maxPageSize)) fail('INVALID_PAGE');

  let afterVersion = 0;
  if (Object.hasOwn(value, 'afterVersion')) {
    if (value.afterVersion === null) {
      afterVersion = 0;
    } else if (isPositiveDatabaseInteger(value.afterVersion)) {
      afterVersion = value.afterVersion;
    } else {
      fail('INVALID_PAGE');
    }
  }

  return { limit, afterVersion };
}

function validateRows(
  rows: readonly unknown[],
  requestedEventId: string,
  options: ValidatedPageOptions,
  probeLimit: number,
): PublicEventHistoryDisclosurePage {
  if (rows.length > probeLimit) fail('RESULT_INVALID');

  let currentVersion: number | null = null;
  let previousCandidateVersion = options.afterVersion;
  const candidates: PublicEventHistoryDisclosureCandidate[] = [];

  for (const value of rows) {
    if (!hasExactKeys(value, disclosureRowKeys)) fail('RESULT_INVALID');
    if (value.current_dataset_kind !== 'live'
      || value.current_event_id !== requestedEventId
      || !isPositiveDatabaseInteger(value.current_version)) {
      fail('RESULT_INVALID');
    }

    if (currentVersion === null) {
      currentVersion = value.current_version;
    } else if (currentVersion !== value.current_version) {
      fail('RESULT_INVALID');
    }

    if (value.candidate_version === null) {
      if (rows.length !== 1
        || value.candidate_dataset_kind !== null
        || value.candidate_event_id !== null
        || metadataFields.some((field) => value[field] !== null)) {
        fail('RESULT_INVALID');
      }
      continue;
    }

    if (value.candidate_dataset_kind !== 'live'
      || value.candidate_event_id !== requestedEventId
      || !isPositiveDatabaseInteger(value.candidate_version)
      || value.candidate_version <= previousCandidateVersion
      || value.candidate_version > currentVersion) {
      fail('RESULT_INVALID');
    }

    const disclosure = validateDisclosure(value, requestedEventId, value.candidate_version);
    previousCandidateVersion = value.candidate_version;
    candidates.push({
      datasetKind: 'live',
      eventId: requestedEventId,
      eventVersion: value.candidate_version,
      disclosure,
    });
  }

  if (currentVersion === null) fail('RESULT_INVALID');
  const hasMore = candidates.length > options.limit;
  if (hasMore) candidates.length = options.limit;
  return {
    eventId: requestedEventId,
    versions: candidates,
    coverageComplete: candidates.every(({ disclosure }) => disclosure !== null),
    nextAfterVersion: hasMore ? candidates[candidates.length - 1]!.eventVersion : null,
  };
}

function validateDisclosure(
  row: Record<string, unknown>,
  eventId: string,
  eventVersion: number,
): PublicEventHistoryDisclosure | null {
  const allNull = metadataFields.every((field) => row[field] === null);
  if (allNull) return null;
  if (metadataFields.some((field) => row[field] === null)
    || row.review_dataset_kind !== 'live'
    || row.review_event_id !== eventId
    || row.review_event_version !== eventVersion
    || row.review_status !== 'approved'
    || !isChangeType(row.change_type)
    || !isValidSummary(row.summary)
    || !isReviewerIdentifier(row.reviewer_id)
    || !isTimestamp(row.reviewed_at)) {
    fail('RESULT_INVALID');
  }

  return {
    datasetKind: 'live',
    eventId,
    eventVersion,
    reviewStatus: 'approved',
    changeType: row.change_type,
    summary: row.summary,
    reviewerId: row.reviewer_id,
    reviewedAt: row.reviewed_at,
  };
}

function isChangeType(value: unknown): value is PublicEventHistoryChangeType {
  return typeof value === 'string'
    && (PUBLIC_EVENT_HISTORY_CHANGE_TYPES as readonly string[]).includes(value);
}

function isValidSummary(value: unknown): value is string {
  return typeof value === 'string'
    && value.trim().length > 0
    && Array.from(value).length <= 500;
}

function isReviewerIdentifier(value: unknown): value is string {
  return typeof value === 'string' && reviewerIdentifierPattern.test(value);
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
): Promise<{ readonly rows: readonly Row[] }> {
  let result: unknown;
  try {
    result = await executor.query<Row>(statement, parameters);
  } catch {
    fail('READ_FAILED');
  }
  if (!isRecord(result) || !Array.isArray(result.rows)) fail('RESULT_INVALID');
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

function fail(code: PublicEventHistoryDisclosureErrorCode): never {
  throw new PublicEventHistoryDisclosureError(code);
}
