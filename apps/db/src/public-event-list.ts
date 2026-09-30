import { isDeepStrictEqual } from 'node:util';
import type { SqlExecutor } from './sql.js';

export const PUBLIC_EVENT_LIST_LIMITS = Object.freeze({
  defaultPageSize: 20,
  maxPageSize: 100,
  eventIdLength: 128,
  queryLength: 120,
  placeIdLength: 128,
  dateTimeLength: 128,
});

export type PublicEventListCategory =
  | 'crime_personal_security'
  | 'demonstrations_public_gatherings'
  | 'crowds_major_events'
  | 'violence_immediate_threats'
  | 'disasters_weather'
  | 'fires_infrastructure_hazards'
  | 'transport_road_incidents'
  | 'utilities_essential_services'
  | 'health_environmental_advisories'
  | 'group_specific_critical_notices';

export type PublicEventListLifecycle = 'planned' | 'ongoing' | 'resolved' | 'cancelled' | 'unknown';
export type PublicEventListFreshness = 'current' | 'needs_update' | 'expired';

/** Closed internal filters corresponding to the existing public list vocabulary. */
export interface PublicEventListFilters {
  readonly category?: PublicEventListCategory;
  readonly lifecycle?: PublicEventListLifecycle;
  readonly freshness?: PublicEventListFreshness;
  readonly from?: string;
  readonly to?: string;
  readonly q?: string;
  readonly place_id?: string;
}

export interface PublicEventListCursor {
  readonly firstPublishedAt: string;
  readonly eventId: string;
}

export interface PublicEventListCandidate {
  readonly eventId: string;
  readonly eventVersion: number;
  readonly firstPublishedAt: string;
  /** Untrusted schema 2.0 input for a later Layer 4 projection. */
  readonly recordJson: unknown;
}

export interface PublicEventListPage {
  readonly candidates: readonly PublicEventListCandidate[];
  /** The last returned candidate's immutable key when another row exists. */
  readonly nextCursor: PublicEventListCursor | null;
}

export interface PublicEventListRepository {
  /** Reads a bounded page of current published live event candidates. */
  read(options?: unknown): Promise<PublicEventListPage>;
}

export type PublicEventListErrorCode = 'INVALID_PAGE' | 'RESULT_INVALID' | 'READ_FAILED';

const errorMessages: Record<PublicEventListErrorCode, string> = {
  INVALID_PAGE: 'The public event list page is invalid.',
  RESULT_INVALID: 'The public event list could not be validated.',
  READ_FAILED: 'The public event list could not be read.',
};

/** Stable errors never include cursor values, SQL, record content, or database errors. */
export class PublicEventListError extends Error {
  constructor(readonly code: PublicEventListErrorCode) {
    super(errorMessages[code]);
    this.name = 'PublicEventListError';
  }
}

interface PublicEventListRow {
  readonly dataset_kind: unknown;
  readonly event_id: unknown;
  readonly version: unknown;
  readonly record_json: unknown;
  readonly first_record_json: unknown;
  readonly first_published_at: unknown;
}

interface ValidatedOptions {
  readonly limit: number;
  readonly cursor: PublicEventListCursor | null;
  readonly filters: PublicEventListFilters;
}

interface ValidatedEventRecord {
  readonly publishedAtMicros: bigint;
}

const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const maxDatabaseInteger = 2_147_483_647;
const maxDateRangeMicros = 90n * 24n * 60n * 60n * 1_000_000n;
const categories = new Set<PublicEventListCategory>([
  'crime_personal_security',
  'demonstrations_public_gatherings',
  'crowds_major_events',
  'violence_immediate_threats',
  'disasters_weather',
  'fires_infrastructure_hazards',
  'transport_road_incidents',
  'utilities_essential_services',
  'health_environmental_advisories',
  'group_specific_critical_notices',
]);
const lifecycles = new Set<PublicEventListLifecycle>(['planned', 'ongoing', 'resolved', 'cancelled', 'unknown']);
const freshnessStatuses = new Set<PublicEventListFreshness>(['current', 'needs_update', 'expired']);
const eventRecordKeys = [
  'schema_version', 'trace_id', 'record_type', 'dataset_kind', 'event_id', 'version',
  'supersedes_version', 'title', 'summary', 'category', 'tags', 'lifecycle', 'freshness',
  'event_time', 'validity', 'scope', 'claims', 'impact_refs', 'publication_status',
  'withdrawal_reason', 'publication_decision_id', 'published_at', 'withdrawn_at',
] as const;

export function createPublicEventListRepository(executor: SqlExecutor): PublicEventListRepository {
  return {
    async read(options?: unknown): Promise<PublicEventListPage> {
      const page = validateOptions(options);
      const probeLimit = page.limit + 1;
      const { statement, parameters } = buildQuery(page, probeLimit);
      const rows = await queryRows<PublicEventListRow>(executor, statement, parameters);
      const candidates = validateRows(rows, page, probeLimit);
      const hasMore = candidates.length > page.limit;
      if (hasMore) candidates.length = page.limit;

      const lastCandidate = candidates.at(-1);
      return {
        candidates,
        nextCursor: hasMore && lastCandidate !== undefined
          ? {
            firstPublishedAt: lastCandidate.firstPublishedAt,
            eventId: lastCandidate.eventId,
          }
          : null,
      };
    },
  };
}

function buildQuery(options: ValidatedOptions, probeLimit: number): {
  readonly statement: string;
  readonly parameters: readonly unknown[];
} {
  const parameters: unknown[] = [];
  const filters = options.filters;
  const conditions: string[] = [];
  const parameter = (value: unknown): string => {
    parameters.push(value);
    return '$' + parameters.length;
  };
  const eventStartText = "(candidate_events.record_json #>> '{event_time,start}')";
  const eventStartTimestamp = `CASE WHEN ${eventStartText} ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'`
    + ` THEN (${eventStartText} || 'T00:00:00Z')::timestamptz`
    + ` ELSE ${eventStartText}::timestamptz END`;

  if (filters.category !== undefined) {
    conditions.push(`candidate_events.record_json->>'category' = ${parameter(filters.category)}::text`);
  }
  if (filters.lifecycle !== undefined) {
    conditions.push(`candidate_events.record_json->>'lifecycle' = ${parameter(filters.lifecycle)}::text`);
  }
  if (filters.freshness !== undefined) {
    conditions.push(`candidate_events.freshness_status = ${parameter(filters.freshness)}::text`);
  }
  if (filters.from !== undefined) {
    conditions.push(`${eventStartTimestamp} >= ${parameter(filters.from)}::timestamptz`);
  }
  if (filters.to !== undefined) {
    conditions.push(`${eventStartTimestamp} <= ${parameter(filters.to)}::timestamptz`);
  }
  if (filters.place_id !== undefined) {
    conditions.push(`COALESCE(candidate_events.record_json #> '{scope,place_ids}', '[]'::jsonb) @> jsonb_build_array(${parameter(filters.place_id)}::text)`);
  }
  if (filters.q !== undefined) {
    conditions.push(`strpos(lower(concat_ws(' ', candidate_events.record_json->>'title', candidate_events.record_json->>'summary', candidate_events.record_json->>'category', scope_search.display_names)), ${parameter(filters.q)}::text) > 0`);
  }

  const hasSearch = filters.q !== undefined;
  const scopeSearchJoin = hasSearch ? [
    'LEFT JOIN LATERAL (',
    '  SELECT string_agg(scope_name.display_name, \' \'',
    '    ORDER BY scope_ids.scope_order, scope_ids.ordinality) AS display_names',
    '  FROM (',
    '    SELECT 1 AS scope_order, places.ordinality, places.id, \'place\'::text AS entity_type',
    "    FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(candidate_events.record_json #> '{scope,place_ids}') = 'array'",
    "      THEN candidate_events.record_json #> '{scope,place_ids}' ELSE '[]'::jsonb END)",
    '      WITH ORDINALITY AS places(id, ordinality)',
    '    UNION ALL',
    '    SELECT 2 AS scope_order, services.ordinality, services.id, \'service\'::text AS entity_type',
    "    FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(candidate_events.record_json #> '{scope,service_ids}') = 'array'",
    "      THEN candidate_events.record_json #> '{scope,service_ids}' ELSE '[]'::jsonb END)",
    '      WITH ORDINALITY AS services(id, ordinality)',
    '    UNION ALL',
    '    SELECT 3 AS scope_order, institutions.ordinality, institutions.id, \'institution\'::text AS entity_type',
    "    FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(candidate_events.record_json #> '{scope,institution_ids}') = 'array'",
    "      THEN candidate_events.record_json #> '{scope,institution_ids}' ELSE '[]'::jsonb END)",
    '      WITH ORDINALITY AS institutions(id, ordinality)',
    '    UNION ALL',
    '    SELECT 4 AS scope_order, audiences.ordinality, audiences.id, \'audience\'::text AS entity_type',
    "    FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(candidate_events.record_json #> '{scope,audience_ids}') = 'array'",
    "      THEN candidate_events.record_json #> '{scope,audience_ids}' ELSE '[]'::jsonb END)",
    '      WITH ORDINALITY AS audiences(id, ordinality)',
    '  ) AS scope_ids',
    '  JOIN waspada.public_scope_names AS scope_name',
    '    ON scope_name.entity_type = scope_ids.entity_type AND scope_name.id = scope_ids.id',
    ') AS scope_search ON true',
  ].join('\n') : '';

  const filtered = [
    'WITH candidate_events AS (',
    '  SELECT current.dataset_kind, current.event_id, current.version, current.record_json,',
    '         current.freshness_status,',
    '         initial.record_json AS first_record_json',
    '  FROM waspada.public_event_versions AS current',
    '  JOIN waspada.public_event_history_versions AS initial',
    '    ON initial.dataset_kind = current.dataset_kind',
    '   AND initial.event_id = current.event_id',
    '   AND initial.version = 1',
    "  WHERE current.dataset_kind = 'live' AND initial.dataset_kind = 'live'",
    '), filtered_candidates AS (',
    '  SELECT candidate_events.dataset_kind, candidate_events.event_id, candidate_events.version,',
    '         candidate_events.record_json, candidate_events.first_record_json',
    '  FROM candidate_events',
    scopeSearchJoin,
    conditions.length === 0 ? '' : '  WHERE ' + conditions.join('\n    AND '),
    '), ordered_candidates AS (',
    '  SELECT filtered_candidates.dataset_kind, filtered_candidates.event_id, filtered_candidates.version,',
    '         filtered_candidates.record_json, filtered_candidates.first_record_json,',
    "         to_char((filtered_candidates.first_record_json->>'published_at')::timestamptz AT TIME ZONE 'UTC',",
    '           \'YYYY-MM-DD"T"HH24:MI:SS.US"Z"\') AS first_published_at',
    '  FROM filtered_candidates',
    ')',
    'SELECT dataset_kind, event_id, version, record_json, first_record_json, first_published_at',
    'FROM ordered_candidates',
  ].filter((line) => line !== '').join('\n');

  const cursorWhere = options.cursor === null
    ? []
    : (() => {
      const cursorTime = parameter(options.cursor.firstPublishedAt);
      const cursorEventId = parameter(options.cursor.eventId);
      return [
        `WHERE first_published_at::timestamptz < ${cursorTime}::timestamptz`,
        `   OR (first_published_at::timestamptz = ${cursorTime}::timestamptz`,
        `       AND event_id COLLATE "C" > (${cursorEventId}::text COLLATE "C"))`,
      ];
    })();
  const probeLimitParameter = parameter(probeLimit);
  const statement = [
    filtered,
    ...cursorWhere,
    'ORDER BY first_published_at::timestamptz DESC, event_id COLLATE "C" ASC',
    `LIMIT ${probeLimitParameter}`,
  ].join('\n');
  return { statement, parameters };
}

function validateOptions(value: unknown): ValidatedOptions {
  if (value === undefined) {
    return { limit: PUBLIC_EVENT_LIST_LIMITS.defaultPageSize, cursor: null, filters: {} };
  }

  try {
    if (!isPlainRecord(value) || !hasAllowedKeys(value, ['limit', 'cursor', 'filters'])) fail('INVALID_PAGE');
    const limit = Object.hasOwn(value, 'limit')
      ? value.limit
      : PUBLIC_EVENT_LIST_LIMITS.defaultPageSize;
    if (!isSafeInteger(limit, 1, PUBLIC_EVENT_LIST_LIMITS.maxPageSize)) fail('INVALID_PAGE');

    const cursor = Object.hasOwn(value, 'cursor') ? validateCursor(value.cursor) : null;
    const filters = Object.hasOwn(value, 'filters') ? validateFilters(value.filters) : {};
    return { limit, cursor, filters };
  } catch (error) {
    if (error instanceof PublicEventListError) throw error;
    fail('INVALID_PAGE');
  }
}

function validateFilters(value: unknown): PublicEventListFilters {
  if (!isPlainRecord(value)
    || !hasAllowedKeys(value, ['category', 'lifecycle', 'freshness', 'from', 'to', 'q', 'place_id'])) {
    fail('INVALID_PAGE');
  }

  const result: {
    category?: PublicEventListCategory;
    lifecycle?: PublicEventListLifecycle;
    freshness?: PublicEventListFreshness;
    from?: string;
    to?: string;
    q?: string;
    place_id?: string;
  } = {};

  if (Object.hasOwn(value, 'category')) {
    if (typeof value.category !== 'string' || !categories.has(value.category as PublicEventListCategory)) fail('INVALID_PAGE');
    result.category = value.category as PublicEventListCategory;
  }
  if (Object.hasOwn(value, 'lifecycle')) {
    if (typeof value.lifecycle !== 'string' || !lifecycles.has(value.lifecycle as PublicEventListLifecycle)) fail('INVALID_PAGE');
    result.lifecycle = value.lifecycle as PublicEventListLifecycle;
  }
  if (Object.hasOwn(value, 'freshness')) {
    if (typeof value.freshness !== 'string' || !freshnessStatuses.has(value.freshness as PublicEventListFreshness)) fail('INVALID_PAGE');
    result.freshness = value.freshness as PublicEventListFreshness;
  }
  if (Object.hasOwn(value, 'from')) {
    if (typeof value.from !== 'string' || parseDateTimeMicrosOrNull(value.from) === null) fail('INVALID_PAGE');
    result.from = value.from;
  }
  if (Object.hasOwn(value, 'to')) {
    if (typeof value.to !== 'string' || parseDateTimeMicrosOrNull(value.to) === null) fail('INVALID_PAGE');
    result.to = value.to;
  }
  if (result.from !== undefined && result.to !== undefined) {
    const fromMicros = parseDateTimeMicros(result.from);
    const toMicros = parseDateTimeMicros(result.to);
    if (toMicros < fromMicros || toMicros - fromMicros > maxDateRangeMicros) fail('INVALID_PAGE');
  }
  if (Object.hasOwn(value, 'q')) {
    if (typeof value.q !== 'string') fail('INVALID_PAGE');
    const query = value.q.trim();
    if (query.length > PUBLIC_EVENT_LIST_LIMITS.queryLength) fail('INVALID_PAGE');
    if (query.length > 0) result.q = query.toLocaleLowerCase('id');
  }
  if (Object.hasOwn(value, 'place_id')) {
    if (typeof value.place_id !== 'string') fail('INVALID_PAGE');
    const placeId = value.place_id.trim();
    if (placeId.length > PUBLIC_EVENT_LIST_LIMITS.placeIdLength) fail('INVALID_PAGE');
    if (placeId.length > 0) result.place_id = placeId;
  }
  return result;
}

function validateCursor(value: unknown): PublicEventListCursor {
  if (!isPlainRecord(value)
    || !hasExactKeys(value, ['firstPublishedAt', 'eventId'])
    || !isCanonicalTimestamp(value.firstPublishedAt)
    || !isIdentifier(value.eventId)) {
    fail('INVALID_PAGE');
  }
  return { firstPublishedAt: value.firstPublishedAt, eventId: value.eventId };
}

function validateRows(
  rows: readonly unknown[],
  options: ValidatedOptions,
  probeLimit: number,
): PublicEventListCandidate[] {
  if (rows.length > probeLimit) fail('RESULT_INVALID');

  const seenEventIds = new Set<string>();
  const candidates: PublicEventListCandidate[] = [];
  let previous: { readonly timestampMicros: bigint; readonly eventId: string } | null = null;
  const cursorMicros = options.cursor === null
    ? null
    : parseDateTimeMicros(options.cursor.firstPublishedAt);

  for (const value of rows) {
    if (!hasExactKeys(value, [
      'dataset_kind', 'event_id', 'version', 'record_json', 'first_record_json', 'first_published_at',
    ])
      || value.dataset_kind !== 'live'
      || !isIdentifier(value.event_id)
      || !isPositiveDatabaseInteger(value.version)) {
      fail('RESULT_INVALID');
    }

    validateEventRecord(value.record_json, value.event_id, value.version);
    const firstRecord = validateEventRecord(value.first_record_json, value.event_id, 1);
    if (value.version === 1 && !isDeepStrictEqual(value.record_json, value.first_record_json)) {
      fail('RESULT_INVALID');
    }
    if (!isCanonicalTimestamp(value.first_published_at)) fail('RESULT_INVALID');

    const timestampMicros = parseDateTimeMicros(value.first_published_at);
    if (timestampMicros !== firstRecord.publishedAtMicros) fail('RESULT_INVALID');

    if (seenEventIds.has(value.event_id)) fail('RESULT_INVALID');
    seenEventIds.add(value.event_id);

    if (previous !== null) {
      const outOfOrder = previous.timestampMicros < timestampMicros
        || (previous.timestampMicros === timestampMicros
          && compareStrings(previous.eventId, value.event_id) >= 0);
      if (outOfOrder) fail('RESULT_INVALID');
    }
    if (cursorMicros !== null) {
      const notAfterCursor = timestampMicros > cursorMicros
        || (timestampMicros === cursorMicros
          && compareStrings(value.event_id, options.cursor!.eventId) <= 0);
      if (notAfterCursor) fail('RESULT_INVALID');
    }

    previous = { timestampMicros, eventId: value.event_id };
    candidates.push({
      eventId: value.event_id,
      eventVersion: value.version,
      firstPublishedAt: value.first_published_at,
      recordJson: value.record_json,
    });
  }

  return candidates;
}

function validateEventRecord(value: unknown, eventId: string, version: number): ValidatedEventRecord {
  if (!hasExactKeys(value, eventRecordKeys)
    || value.schema_version !== '2.0'
    || value.record_type !== 'Event'
    || value.dataset_kind !== 'live'
    || !isIdentifier(value.trace_id)
    || value.event_id !== eventId
    || value.version !== version
    || value.supersedes_version !== (version === 1 ? null : version - 1)
    || !isIdentifier(value.publication_decision_id)
    || value.publication_status !== 'published'
    || value.withdrawal_reason !== null
    || value.withdrawn_at !== null
    || !isDateTime(value.published_at)) {
    fail('RESULT_INVALID');
  }
  return { publishedAtMicros: parseDateTimeMicros(value.published_at) };
}

async function queryRows<Row extends object>(
  executor: SqlExecutor,
  statement: string,
  parameters: readonly unknown[],
): Promise<readonly Row[]> {
  let result: unknown;
  try {
    result = await executor.query<Row>(statement, parameters);
  } catch {
    fail('READ_FAILED');
  }
  if (!isRecord(result) || !Array.isArray(result.rows)) fail('RESULT_INVALID');
  return result.rows as readonly Row[];
}

function isIdentifier(value: unknown): value is string {
  return typeof value === 'string'
    && value.length <= PUBLIC_EVENT_LIST_LIMITS.eventIdLength
    && identifierPattern.test(value);
}

function isPositiveDatabaseInteger(value: unknown): value is number {
  return isSafeInteger(value, 1, maxDatabaseInteger);
}

function isSafeInteger(value: unknown, minimum: number, maximum: number): value is number {
  return Number.isSafeInteger(value)
    && (value as number) >= minimum
    && (value as number) <= maximum;
}

function isDateTime(value: unknown): value is string {
  return typeof value === 'string'
    && value.length <= PUBLIC_EVENT_LIST_LIMITS.dateTimeLength
    && parseDateTimeMicrosOrNull(value) !== null;
}

function isCanonicalTimestamp(value: unknown): value is string {
  return typeof value === 'string'
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/u.test(value)
    && parseDateTimeMicrosOrNull(value) !== null;
}

function parseDateTimeMicros(value: string): bigint {
  const parsed = parseDateTimeMicrosOrNull(value);
  if (parsed === null) fail('RESULT_INVALID');
  return parsed;
}

/** Parse RFC 3339 timestamps at PostgreSQL's microsecond precision. */
function parseDateTimeMicrosOrNull(value: string): bigint | null {
  if (value.length > PUBLIC_EVENT_LIST_LIMITS.dateTimeLength) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|([+-])(\d{2}):(\d{2}))$/u.exec(value);
  if (match === null) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetSign = match[9];
  const offsetHour = match[10] === undefined ? 0 : Number(match[10]);
  const offsetMinute = match[11] === undefined ? 0 : Number(match[11]);
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)
    || hour > 23 || minute > 59 || second > 59 || offsetHour > 23 || offsetMinute > 59) {
    return null;
  }

  const fractionalDigits = match[7] ?? '';
  const microsText = fractionalDigits.slice(0, 6).padEnd(6, '0');
  let micros = BigInt(microsText || '0');
  if (fractionalDigits.length > 6 && fractionalDigits[6]! >= '5') micros += 1n;

  const localSeconds = daysFromCivil(year, month, day) * 86_400n
    + BigInt(hour * 3_600 + minute * 60 + second);
  const offsetSeconds = BigInt(offsetHour * 3_600 + offsetMinute * 60)
    * (offsetSign === '+' ? 1n : -1n);
  return (localSeconds - offsetSeconds) * 1_000_000n + micros;
}

function daysFromCivil(year: number, month: number, day: number): bigint {
  const adjustedYear = BigInt(year) - (month <= 2 ? 1n : 0n);
  const era = adjustedYear / 400n;
  const yearOfEra = adjustedYear - era * 400n;
  const adjustedMonth = BigInt(month + (month > 2 ? -3 : 9));
  const dayOfYear = (153n * adjustedMonth + 2n) / 5n + BigInt(day) - 1n;
  const dayOfEra = yearOfEra * 365n + yearOfEra / 4n - yearOfEra / 100n + dayOfYear;
  return era * 146_097n + dayOfEra - 719_468n;
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasAllowedKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  try {
    return Reflect.ownKeys(value).every((key) => typeof key === 'string' && allowed.includes(key));
  } catch {
    return false;
  }
}

function hasExactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  try {
    const actual = Reflect.ownKeys(value);
    return actual.length === keys.length
      && actual.every((key) => typeof key === 'string' && keys.includes(key));
  } catch {
    return false;
  }
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function fail(code: PublicEventListErrorCode): never {
  throw new PublicEventListError(code);
}
