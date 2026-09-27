import type { SqlExecutor } from './sql.js';

export const PUBLIC_BRIEFING_CANDIDATE_LIMITS = Object.freeze({
  textInterestsPerField: 30,
  textInterestCodePoints: 128,
  categories: 10,
  results: 100,
});

export type PublicBriefingCandidateCategory =
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

export interface PublicBriefingCandidate {
  readonly eventId: string;
  readonly eventVersion: number;
  /** Immutable version-1 publication timestamp used for deterministic ordering. */
  readonly firstPublishedAt: string;
}

export interface PublicBriefingCandidateRepository {
  /** Finds every current published live event matching the closed briefing request. */
  read(request: unknown): Promise<readonly PublicBriefingCandidate[]>;
}

export type PublicBriefingCandidateErrorCode =
  | 'INVALID_REQUEST'
  | 'RESULT_LIMIT_EXCEEDED'
  | 'RESULT_INVALID'
  | 'READ_FAILED';

const errorMessages: Record<PublicBriefingCandidateErrorCode, string> = {
  INVALID_REQUEST: 'The public briefing request is invalid.',
  RESULT_LIMIT_EXCEEDED: 'The briefing exceeds its maximum number of items.',
  RESULT_INVALID: 'The public briefing candidate result could not be validated.',
  READ_FAILED: 'The public briefing candidates could not be read.',
};

/** Stable errors never include interests, event labels, SQL, or database errors. */
export class PublicBriefingCandidateError extends Error {
  constructor(readonly code: PublicBriefingCandidateErrorCode) {
    super(errorMessages[code]);
    this.name = 'PublicBriefingCandidateError';
  }
}

interface PublicBriefingCandidateRow {
  readonly dataset_kind: unknown;
  readonly event_id: unknown;
  readonly version: unknown;
  readonly first_published_at: unknown;
}

interface ValidatedRequest {
  readonly places: readonly string[];
  readonly services: readonly string[];
  readonly institutions: readonly string[];
  readonly audiences: readonly string[];
  readonly categories: readonly PublicBriefingCandidateCategory[];
}

type ScopeField = 'places' | 'services' | 'institutions' | 'audiences';

const scopeFields: readonly ScopeField[] = ['places', 'services', 'institutions', 'audiences'];
const categories = new Set<PublicBriefingCandidateCategory>([
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
const eventIdentifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const maxDatabaseInteger = 2_147_483_647;
const overflowProbe = PUBLIC_BRIEFING_CANDIDATE_LIMITS.results + 1;
const canonicalTimestampPattern = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{6})Z$/u;

/*
 * PostgreSQL has no default trim set matching ECMAScript String.trim().
 * Spell out ECMAScript WhiteSpace and LineTerminator code points here. ICU's
 * und lower-case mapping has no Indonesian-specific tailoring and matches the
 * projector's id locale; deterministic C collation is used for exact equality.
 */
const candidateSql = [
  'WITH trim_characters AS (',
  '  SELECT chr(9) || chr(10) || chr(11) || chr(12) || chr(13) || chr(32)',
  '      || chr(160) || chr(5760) || chr(8192) || chr(8193) || chr(8194)',
  '      || chr(8195) || chr(8196) || chr(8197) || chr(8198) || chr(8199)',
  '      || chr(8200) || chr(8201) || chr(8202) || chr(8232) || chr(8233)',
  '      || chr(8239) || chr(8287) || chr(12288) || chr(65279) AS characters',
  '), current_events AS (',
  '  SELECT current.dataset_kind, current.event_id, current.version, current.record_json,',
  '         initial.record_json AS first_record_json',
  '  FROM waspada.public_event_versions AS current',
  '  JOIN waspada.public_event_history_versions AS initial',
  '    ON initial.dataset_kind = current.dataset_kind',
  '   AND initial.event_id = current.event_id',
  '   AND initial.version = 1',
  "  WHERE current.dataset_kind = 'live' AND initial.dataset_kind = 'live'",
  '), input_scope_interests AS (',
  "  SELECT 'place'::text AS entity_type, value AS interest_name FROM unnest($1::text[]) AS item(value)",
  '  UNION ALL',
  "  SELECT 'service'::text, value FROM unnest($2::text[]) AS item(value)",
  '  UNION ALL',
  "  SELECT 'institution'::text, value FROM unnest($3::text[]) AS item(value)",
  '  UNION ALL',
  "  SELECT 'audience'::text, value FROM unnest($4::text[]) AS item(value)",
  '), normalized_scope_interests AS (',
  '  SELECT interests.entity_type,',
  '         (lower(btrim(normalize(interests.interest_name, NFC), trim_characters.characters)',
  '           COLLATE "und-x-icu")) COLLATE "C" AS normalized_name',
  '  FROM input_scope_interests AS interests',
  '  CROSS JOIN trim_characters',
  '), requested_categories AS (',
  '  SELECT value AS category FROM unnest($5::text[]) AS item(value)',
  '), scope_documents AS (',
  '  SELECT event.dataset_kind, event.event_id, event.version AS event_version,',
  "         event.record_json #> '{scope}' AS scope_json",
  '  FROM current_events AS event',
  '  UNION ALL',
  '  SELECT event.dataset_kind, event.event_id, event.version, claim.value->\'scope\'',
  '  FROM current_events AS event',
  '  CROSS JOIN LATERAL jsonb_array_elements(',
  "    CASE WHEN jsonb_typeof(event.record_json->'claims') = 'array'",
  "      THEN event.record_json->'claims' ELSE '[]'::jsonb END",
  '  ) AS claim(value)',
  "  WHERE jsonb_typeof(claim.value) = 'object'",
  '  UNION ALL',
  '  SELECT impact.dataset_kind, impact.event_id, impact.event_version,',
  "         impact.record_json #> '{scope}'",
  '  FROM waspada.public_event_impacts AS impact',
  '  JOIN current_events AS event',
  '    ON event.dataset_kind = impact.dataset_kind',
  '   AND event.event_id = impact.event_id',
  '   AND event.version = impact.event_version',
  "  WHERE impact.dataset_kind = 'live'",
  '), scope_ids AS (',
  '  SELECT document.dataset_kind, document.event_id, document.event_version,',
  '         scope_field.entity_type, scope_value.value AS entity_id',
  '  FROM scope_documents AS document',
  '  CROSS JOIN LATERAL (',
  '    VALUES',
  "      ('place'::text, CASE WHEN jsonb_typeof(document.scope_json->'place_ids') = 'array'",
  "        THEN document.scope_json->'place_ids' ELSE '[]'::jsonb END),",
  "      ('service'::text, CASE WHEN jsonb_typeof(document.scope_json->'service_ids') = 'array'",
  "        THEN document.scope_json->'service_ids' ELSE '[]'::jsonb END),",
  "      ('institution'::text, CASE WHEN jsonb_typeof(document.scope_json->'institution_ids') = 'array'",
  "        THEN document.scope_json->'institution_ids' ELSE '[]'::jsonb END),",
  "      ('audience'::text, CASE WHEN jsonb_typeof(document.scope_json->'audience_ids') = 'array'",
  "        THEN document.scope_json->'audience_ids' ELSE '[]'::jsonb END)",
  '  ) AS scope_field(entity_type, scope_values)',
  '  CROSS JOIN LATERAL jsonb_array_elements_text(scope_field.scope_values) AS scope_value(value)',
  '), matched_scope_events AS (',
  '  SELECT DISTINCT scope.dataset_kind, scope.event_id, scope.event_version',
  '  FROM scope_ids AS scope',
  '  CROSS JOIN trim_characters',
  '  JOIN waspada.public_scope_names AS approved_name',
  '    ON approved_name.entity_type = scope.entity_type',
  '   AND approved_name.id COLLATE "C" = scope.entity_id COLLATE "C"',
  '  JOIN normalized_scope_interests AS interest',
  '    ON interest.entity_type = approved_name.entity_type',
  '   AND (lower(btrim(normalize(approved_name.display_name, NFC), trim_characters.characters)',
  '         COLLATE "und-x-icu")) COLLATE "C" = interest.normalized_name',
  '), eligible_candidates AS (',
  '  SELECT event.dataset_kind, event.event_id, event.version,',
  '         to_char((event.first_record_json->>\'published_at\')::timestamptz AT TIME ZONE \'UTC\',',
  '           \'YYYY-MM-DD"T"HH24:MI:SS.US"Z"\') AS first_published_at',
  '  FROM current_events AS event',
  '  WHERE EXISTS (',
  '    SELECT 1 FROM requested_categories AS category',
  '    WHERE (event.record_json->>\'category\') COLLATE "C" = category.category COLLATE "C"',
  '  ) OR EXISTS (',
  '    SELECT 1 FROM matched_scope_events AS scope_match',
  '    WHERE scope_match.dataset_kind = event.dataset_kind',
  '      AND scope_match.event_id = event.event_id',
  '      AND scope_match.event_version = event.version',
  '  )',
  ')',
  'SELECT dataset_kind, event_id, version, first_published_at',
  'FROM eligible_candidates',
  'ORDER BY first_published_at::timestamptz DESC, event_id COLLATE "C" ASC',
  'LIMIT $6',
].join('\n');

export function createPublicBriefingCandidateRepository(
  executor: SqlExecutor,
): PublicBriefingCandidateRepository {
  return {
    async read(request: unknown): Promise<readonly PublicBriefingCandidate[]> {
      let validated: ValidatedRequest;
      try {
        validated = validateRequest(request);
      } catch (error) {
        if (error instanceof PublicBriefingCandidateError) throw error;
        fail('INVALID_REQUEST');
      }

      if (validated.categories.length === 0
        && scopeFields.every((field) => validated[field].length === 0)) {
        return [];
      }

      const rows = await queryRows<PublicBriefingCandidateRow>(executor, candidateSql, [
        validated.places,
        validated.services,
        validated.institutions,
        validated.audiences,
        validated.categories,
        overflowProbe,
      ]);
      const candidates = validateRows(rows);
      if (candidates.length > PUBLIC_BRIEFING_CANDIDATE_LIMITS.results) {
        fail('RESULT_LIMIT_EXCEEDED');
      }
      return candidates;
    },
  };
}

function validateRequest(value: unknown): ValidatedRequest {
  if (!isPlainRecord(value) || !hasExactKeys(value, ['interests'])
    || !isPlainRecord(value.interests)
    || !hasExactKeys(value.interests, [
      'places', 'services', 'institutions', 'audiences', 'categories',
    ])) {
    fail('INVALID_REQUEST');
  }

  const result: {
    places: string[];
    services: string[];
    institutions: string[];
    audiences: string[];
    categories: PublicBriefingCandidateCategory[];
  } = {
    places: [],
    services: [],
    institutions: [],
    audiences: [],
    categories: [],
  };

  for (const field of scopeFields) {
    const entries: unknown = value.interests[field];
    if (!isPlainArray(entries) || entries.length > PUBLIC_BRIEFING_CANDIDATE_LIMITS.textInterestsPerField) {
      fail('INVALID_REQUEST');
    }
    for (const entry of entries) {
      if (typeof entry !== 'string' || codePointLength(entry) > PUBLIC_BRIEFING_CANDIDATE_LIMITS.textInterestCodePoints) {
        fail('INVALID_REQUEST');
      }
      const normalized = normalizeMatchText(entry);
      // PostgreSQL text cannot contain NUL or unpaired UTF-16 surrogates. Such
      // values cannot match any database display name, so omitting only those
      // names preserves the projector's result while keeping the query valid.
      if (normalized.length === 0 || !isPostgresText(normalized)) continue;
      result[field].push(entry);
    }
  }

  const categoryEntries: unknown = value.interests.categories;
  if (!isPlainArray(categoryEntries) || categoryEntries.length > PUBLIC_BRIEFING_CANDIDATE_LIMITS.categories) {
    fail('INVALID_REQUEST');
  }
  const seenCategories = new Set<PublicBriefingCandidateCategory>();
  for (const entry of categoryEntries) {
    if (typeof entry !== 'string' || !categories.has(entry as PublicBriefingCandidateCategory)
      || seenCategories.has(entry as PublicBriefingCandidateCategory)) {
      fail('INVALID_REQUEST');
    }
    seenCategories.add(entry as PublicBriefingCandidateCategory);
    result.categories.push(entry as PublicBriefingCandidateCategory);
  }

  return result;
}

function validateRows(rows: readonly unknown[]): PublicBriefingCandidate[] {
  if (rows.length > overflowProbe) fail('RESULT_INVALID');

  const candidates: PublicBriefingCandidate[] = [];
  const seenEventIds = new Set<string>();
  let previous: PublicBriefingCandidate | null = null;

  for (const value of rows) {
    if (!hasExactKeys(value, ['dataset_kind', 'event_id', 'version', 'first_published_at'])
      || value.dataset_kind !== 'live'
      || !isEventIdentifier(value.event_id)
      || !isPositiveDatabaseInteger(value.version)
      || !isCanonicalTimestamp(value.first_published_at)
      || seenEventIds.has(value.event_id)) {
      fail('RESULT_INVALID');
    }

    const candidate: PublicBriefingCandidate = {
      eventId: value.event_id,
      eventVersion: value.version,
      firstPublishedAt: value.first_published_at,
    };
    if (previous !== null) {
      const isOutOfOrder = previous.firstPublishedAt < candidate.firstPublishedAt
        || (previous.firstPublishedAt === candidate.firstPublishedAt
          && compareStrings(previous.eventId, candidate.eventId) >= 0);
      if (isOutOfOrder) fail('RESULT_INVALID');
    }

    seenEventIds.add(candidate.eventId);
    candidates.push(candidate);
    previous = candidate;
  }

  return candidates;
}

async function queryRows<Row extends object>(
  executor: SqlExecutor,
  statement: string,
  parameters: readonly unknown[],
): Promise<readonly unknown[]> {
  let result: unknown;
  try {
    result = await executor.query<Row>(statement, parameters);
  } catch {
    fail('READ_FAILED');
  }
  if (!isRecord(result) || !Array.isArray(result.rows)) fail('RESULT_INVALID');
  return result.rows;
}

function normalizeMatchText(value: string): string {
  return value.normalize('NFC').trim().toLocaleLowerCase('id');
}

function isPostgresText(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit === 0) return false;
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function codePointLength(value: string): number {
  return Array.from(value).length;
}

function isEventIdentifier(value: unknown): value is string {
  return typeof value === 'string'
    && value.length <= 128
    && eventIdentifierPattern.test(value);
}

function isPositiveDatabaseInteger(value: unknown): value is number {
  return Number.isSafeInteger(value)
    && (value as number) >= 1
    && (value as number) <= maxDatabaseInteger;
}

function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = canonicalTimestampPattern.exec(value);
  if (match === null) return false;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)
    || hour > 23 || minute > 59 || second > 59) {
    return false;
  }
  return Number.isFinite(Date.parse(value));
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

function isPlainArray(value: unknown): value is unknown[] {
  if (!Array.isArray(value)) return false;
  try {
    if (Object.getPrototypeOf(value) !== Array.prototype) return false;
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.length !== value.length + 1
      || !ownKeys.includes('length')
      || ownKeys.some((key) => typeof key !== 'string' || (key !== 'length' && !/^(0|[1-9]\d*)$/u.test(key)))) {
      return false;
    }
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.hasOwn(value, index)) return false;
    }
    return true;
  } catch {
    return false;
  }
}

function hasExactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!isPlainRecord(value)) return false;
  try {
    const ownKeys = Reflect.ownKeys(value);
    return ownKeys.length === keys.length
      && ownKeys.every((key) => typeof key === 'string' && keys.includes(key))
      && keys.every((key) => Object.hasOwn(value, key));
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function fail(code: PublicBriefingCandidateErrorCode): never {
  throw new PublicBriefingCandidateError(code);
}
