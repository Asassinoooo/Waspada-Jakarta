import { isDeepStrictEqual } from 'node:util';
import type { SqlExecutor } from './sql.js';

export const PUBLIC_EVENT_HISTORY_LIMITS = Object.freeze({
  defaultPageSize: 50,
  maxPageSize: 100,
  eventIdLength: 128,
});

export interface PublicEventHistoryVersion {
  readonly datasetKind: 'live';
  readonly eventId: string;
  readonly eventVersion: number;
  /** Untrusted schema 2.0 input for a later Layer 4 history projection. */
  readonly recordJson: unknown;
}

export interface PublicEventHistoryPage {
  readonly eventId: string;
  readonly versions: readonly PublicEventHistoryVersion[];
  /** The last returned version to use as the next keyset boundary, or null at the end. */
  readonly nextAfterVersion: number | null;
}

export type PublicEventHistoryReadResult =
  | { readonly kind: 'found'; readonly page: PublicEventHistoryPage }
  | { readonly kind: 'missing' };

export interface PublicEventHistoryRepository {
  /** Reads a bounded page only while this exact event ID is currently public and live. */
  read(eventId: unknown, options?: unknown): Promise<PublicEventHistoryReadResult>;
}

export type PublicEventHistoryErrorCode =
  | 'INVALID_EVENT_ID'
  | 'INVALID_PAGE'
  | 'RESULT_INVALID'
  | 'READ_FAILED';

const errorMessages: Record<PublicEventHistoryErrorCode, string> = {
  INVALID_EVENT_ID: 'The public event identifier is invalid.',
  INVALID_PAGE: 'The public event history page is invalid.',
  RESULT_INVALID: 'The public event history could not be validated.',
  READ_FAILED: 'The public event history could not be read.',
};

/** Stable errors never include IDs, SQL text, record content, or database errors. */
export class PublicEventHistoryError extends Error {
  constructor(readonly code: PublicEventHistoryErrorCode) {
    super(errorMessages[code]);
    this.name = 'PublicEventHistoryError';
  }
}

interface PublicEventHistoryRow {
  readonly current_dataset_kind: unknown;
  readonly current_event_id: unknown;
  readonly current_version: unknown;
  readonly current_record_json: unknown;
  readonly dataset_kind: unknown;
  readonly event_id: unknown;
  readonly version: unknown;
  readonly record_json: unknown;
}

interface ValidatedPageOptions {
  readonly limit: number;
  readonly afterVersion: number;
}

const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const maxDatabaseInteger = 2_147_483_647;
const eventRecordKeys = [
  'schema_version', 'trace_id', 'record_type', 'dataset_kind', 'event_id', 'version',
  'supersedes_version', 'title', 'summary', 'category', 'tags', 'lifecycle', 'freshness',
  'event_time', 'validity', 'scope', 'claims', 'impact_refs', 'publication_status',
  'withdrawal_reason', 'publication_decision_id', 'published_at', 'withdrawn_at',
] as const;

export function createPublicEventHistoryRepository(
  executor: SqlExecutor,
): PublicEventHistoryRepository {
  return {
    async read(eventId: unknown, options?: unknown): Promise<PublicEventHistoryReadResult> {
      if (!isIdentifier(eventId)) fail('INVALID_EVENT_ID');
      const pageOptions = validatePageOptions(options);
      const probeLimit = pageOptions.limit + 1;

      const result = await queryRows<PublicEventHistoryRow>(executor, [
        'WITH current_event AS (',
        '  SELECT event.dataset_kind, event.event_id, event.version, event.record_json',
        '  FROM waspada.public_event_versions AS event',
        "  WHERE event.dataset_kind = 'live' AND event.event_id = $1",
        '), history_page AS (',
        '  SELECT history.dataset_kind, history.event_id, history.version, history.record_json',
        '  FROM waspada.public_event_history_versions AS history',
        '  JOIN current_event ON current_event.dataset_kind = history.dataset_kind',
        '    AND current_event.event_id = history.event_id',
        '    AND history.version <= current_event.version',
        "  WHERE history.dataset_kind = 'live' AND history.event_id = $1 AND history.version > $2",
        '  ORDER BY history.version ASC',
        '  LIMIT $3',
        ')',
        'SELECT current_event.dataset_kind AS current_dataset_kind,',
        '       current_event.event_id AS current_event_id,',
        '       current_event.version AS current_version,',
        '       current_event.record_json AS current_record_json,',
        '       history_page.dataset_kind, history_page.event_id,',
        '       history_page.version, history_page.record_json',
        'FROM current_event',
        'LEFT JOIN history_page ON TRUE',
        'ORDER BY history_page.version ASC NULLS LAST',
      ].join('\n'), [eventId, pageOptions.afterVersion, probeLimit]);

      if (result.rows.length === 0) return { kind: 'missing' };
      return { kind: 'found', page: validateRows(result.rows, eventId, pageOptions, probeLimit) };
    },
  };
}

function validatePageOptions(value: unknown): ValidatedPageOptions {
  if (value === undefined) {
    return { limit: PUBLIC_EVENT_HISTORY_LIMITS.defaultPageSize, afterVersion: 0 };
  }
  if (!isRecord(value) || Object.keys(value).some((key) => key !== 'limit' && key !== 'afterVersion')) {
    fail('INVALID_PAGE');
  }

  const limit = Object.hasOwn(value, 'limit')
    ? value.limit
    : PUBLIC_EVENT_HISTORY_LIMITS.defaultPageSize;
  if (!isSafeInteger(limit, 1, PUBLIC_EVENT_HISTORY_LIMITS.maxPageSize)) fail('INVALID_PAGE');

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
): PublicEventHistoryPage {
  if (rows.length > probeLimit) fail('RESULT_INVALID');

  let currentVersion: number | null = null;
  let currentRecord: unknown;
  let previousHistoryVersion = options.afterVersion;
  const versions: PublicEventHistoryVersion[] = [];
  for (const value of rows) {
    if (!hasExactKeys(value, [
      'current_dataset_kind', 'current_event_id', 'current_version', 'current_record_json',
      'dataset_kind', 'event_id', 'version', 'record_json',
    ])) {
      fail('RESULT_INVALID');
    }

    if (value.current_dataset_kind !== 'live'
      || value.current_event_id !== requestedEventId
      || !isPositiveDatabaseInteger(value.current_version)
      || !isPublishedEventRecord(value.current_record_json, requestedEventId, value.current_version)) {
      fail('RESULT_INVALID');
    }

    if (currentVersion === null) {
      currentVersion = value.current_version;
      currentRecord = value.current_record_json;
    } else if (currentVersion !== value.current_version || !isDeepStrictEqual(currentRecord, value.current_record_json)) {
      fail('RESULT_INVALID');
    }

    if (value.version === null) {
      if (rows.length !== 1 || value.dataset_kind !== null || value.event_id !== null || value.record_json !== null) {
        fail('RESULT_INVALID');
      }
      continue;
    }

    if (value.dataset_kind !== 'live'
      || value.event_id !== requestedEventId
      || !isPositiveDatabaseInteger(value.version)
      || value.version <= options.afterVersion
      || value.version <= previousHistoryVersion
      || value.version > currentVersion
      || !isPublishedEventRecord(value.record_json, requestedEventId, value.version)) {
      fail('RESULT_INVALID');
    }

    previousHistoryVersion = value.version;
    versions.push({
      datasetKind: 'live',
      eventId: requestedEventId,
      eventVersion: value.version,
      recordJson: value.record_json,
    });
  }

  if (currentVersion === null) fail('RESULT_INVALID');
  const hasMore = versions.length > options.limit;
  if (hasMore) versions.length = options.limit;
  return {
    eventId: requestedEventId,
    versions,
    nextAfterVersion: hasMore ? versions[versions.length - 1]!.eventVersion : null,
  };
}

function isPublishedEventRecord(value: unknown, eventId: string, version: number): boolean {
  return isRecord(value)
    && hasExactKeys(value, eventRecordKeys)
    && value.schema_version === '2.0'
    && value.record_type === 'Event'
    && value.dataset_kind === 'live'
    && isIdentifier(value.trace_id)
    && value.event_id === eventId
    && value.version === version
    && value.publication_status === 'published';
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
  return Number.isSafeInteger(value) && (value as number) >= minimum && (value as number) <= maximum;
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

function fail(code: PublicEventHistoryErrorCode): never {
  throw new PublicEventHistoryError(code);
}
