import type { SqlExecutor } from './sql.js';

export const PUBLIC_EVENT_GEOJSON_CANDIDATE_LIMITS = Object.freeze({
  features: 500,
  overflowProbe: 501,
  identifierLength: 128,
  applicationEnvelope: Object.freeze({
    west: 106.32,
    south: -6.4,
    east: 106.98,
    north: -5.16,
  }),
});

export type PublicEventGeoJSONCategory =
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

export type PublicEventGeoJSONLifecycle = 'planned' | 'ongoing' | 'resolved' | 'cancelled' | 'unknown';
export type PublicEventGeoJSONFreshness = 'current' | 'needs_update' | 'expired';

export type PublicEventGeoJSONBBox = readonly [west: number, south: number, east: number, north: number];

/** Closed query input matching the existing GeoJSON route vocabulary. */
export interface PublicEventGeoJSONCandidateQuery {
  readonly bbox: PublicEventGeoJSONBBox;
  readonly category?: PublicEventGeoJSONCategory;
  readonly lifecycle?: PublicEventGeoJSONLifecycle;
  readonly freshness?: PublicEventGeoJSONFreshness;
}

export interface PublicEventGeoJSONCandidate {
  readonly datasetKind: 'live';
  readonly eventId: string;
  readonly eventVersion: number;
  readonly category: PublicEventGeoJSONCategory;
  readonly lifecycle: PublicEventGeoJSONLifecycle;
  readonly freshness: PublicEventGeoJSONFreshness;
  readonly geometryId: string;
  /** Untrusted current published schema 2.0 Event input for later Layer 4 validation. */
  readonly eventRecordJson: unknown;
  /** Untrusted exact source Geometry record input for later Layer 4 validation. */
  readonly geometryRecordJson: unknown;
}

export interface PublicEventGeoJSONCandidateRepository {
  /** Reads all matching candidates or fails if the existing 500-feature contract would truncate. */
  read(query: unknown): Promise<readonly PublicEventGeoJSONCandidate[]>;
}

export type PublicEventGeoJSONCandidateErrorCode =
  | 'INVALID_QUERY'
  | 'FEATURE_LIMIT_EXCEEDED'
  | 'RESULT_INVALID'
  | 'READ_FAILED';

const errorMessages: Record<PublicEventGeoJSONCandidateErrorCode, string> = {
  INVALID_QUERY: 'The public GeoJSON query is invalid.',
  FEATURE_LIMIT_EXCEEDED: 'The public GeoJSON result exceeds its feature limit.',
  RESULT_INVALID: 'The public GeoJSON candidates could not be validated.',
  READ_FAILED: 'The public GeoJSON candidates could not be read.',
};

interface CandidateRow extends Record<string, unknown> {
  readonly dataset_kind: unknown;
  readonly event_id: unknown;
  readonly event_version: unknown;
  readonly category: unknown;
  readonly lifecycle: unknown;
  readonly freshness: unknown;
  readonly geometry_id: unknown;
  readonly event_record_json: unknown;
  readonly geometry_record_json: unknown;
}

interface ValidatedQuery {
  readonly bbox: PublicEventGeoJSONBBox;
  readonly category?: PublicEventGeoJSONCategory;
  readonly lifecycle?: PublicEventGeoJSONLifecycle;
  readonly freshness?: PublicEventGeoJSONFreshness;
}

const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const categories = new Set<PublicEventGeoJSONCategory>([
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
const lifecycles = new Set<PublicEventGeoJSONLifecycle>([
  'planned', 'ongoing', 'resolved', 'cancelled', 'unknown',
]);
const freshnessStatuses = new Set<PublicEventGeoJSONFreshness>([
  'current', 'needs_update', 'expired',
]);
const candidateRowKeys = [
  'dataset_kind', 'event_id', 'event_version', 'category', 'lifecycle', 'freshness',
  'geometry_id', 'event_record_json', 'geometry_record_json',
] as const;
const maxDatabaseInteger = 2_147_483_647;

/** Stable errors never include query values, record content, SQL, or driver errors. */
export class PublicEventGeoJSONCandidateError extends Error {
  constructor(readonly code: PublicEventGeoJSONCandidateErrorCode) {
    super(errorMessages[code]);
    this.name = 'PublicEventGeoJSONCandidateError';
  }
}

export function createPublicEventGeoJSONCandidateRepository(
  executor: SqlExecutor,
): PublicEventGeoJSONCandidateRepository {
  return {
    async read(query: unknown): Promise<readonly PublicEventGeoJSONCandidate[]> {
      const input = validateQuery(query);
      const parameters: readonly unknown[] = [
        ...input.bbox,
        input.category ?? null,
        input.lifecycle ?? null,
        input.freshness ?? null,
      ];

      let result: unknown;
      try {
        result = await executor.query<CandidateRow>(
          `WITH viewport AS (
             SELECT CASE
               WHEN $1::double precision = $3::double precision
                 AND $2::double precision = $4::double precision
                 THEN ST_SetSRID(ST_MakePoint($1::double precision, $2::double precision), 4326)
               WHEN $1::double precision = $3::double precision
                 OR $2::double precision = $4::double precision
                 THEN ST_SetSRID(ST_MakeLine(
                   ST_MakePoint($1::double precision, $2::double precision),
                   ST_MakePoint($3::double precision, $4::double precision)), 4326)
               ELSE ST_MakeEnvelope($1::double precision, $2::double precision,
                                    $3::double precision, $4::double precision, 4326)
             END AS shape
           )
           SELECT candidate.dataset_kind, candidate.event_id,
                  candidate.event_version, candidate.category, candidate.lifecycle,
                  candidate.freshness, candidate.geometry_id,
                  candidate.event_record_json, candidate.geometry_record_json
           FROM waspada.public_event_geojson_candidates AS candidate
           CROSS JOIN viewport
           WHERE candidate.dataset_kind = 'live'
             AND candidate.shape && viewport.shape
             AND ST_Intersects(candidate.shape, viewport.shape)
             AND ($5::text IS NULL OR candidate.category = $5::text)
             AND ($6::text IS NULL OR candidate.lifecycle = $6::text)
             AND ($7::text IS NULL OR candidate.freshness = $7::text)
           ORDER BY candidate.event_id COLLATE "C" ASC,
                    candidate.event_version ASC,
                    candidate.geometry_id COLLATE "C" ASC
           LIMIT 501`,
          parameters,
        );
      } catch {
        fail('READ_FAILED');
      }

      const candidates = validateRows(result);
      if (candidates.length === PUBLIC_EVENT_GEOJSON_CANDIDATE_LIMITS.overflowProbe) {
        fail('FEATURE_LIMIT_EXCEEDED');
      }
      candidates.sort((left, right) => compareStrings(left.eventId, right.eventId)
        || left.eventVersion - right.eventVersion
        || compareStrings(left.geometryId, right.geometryId));
      return candidates;
    },
  };
}

function validateQuery(value: unknown): ValidatedQuery {
  try {
    if (!isPlainRecord(value) || !hasAllowedKeys(value, ['bbox', 'category', 'lifecycle', 'freshness'])
      || !Object.hasOwn(value, 'bbox')) {
      fail('INVALID_QUERY');
    }

    const bbox = validateBBox(value.bbox);
    const result: {
      bbox: PublicEventGeoJSONBBox;
      category?: PublicEventGeoJSONCategory;
      lifecycle?: PublicEventGeoJSONLifecycle;
      freshness?: PublicEventGeoJSONFreshness;
    } = { bbox };

    if (Object.hasOwn(value, 'category')) {
      if (!isCategory(value.category)) fail('INVALID_QUERY');
      result.category = value.category;
    }
    if (Object.hasOwn(value, 'lifecycle')) {
      if (!isLifecycle(value.lifecycle)) fail('INVALID_QUERY');
      result.lifecycle = value.lifecycle;
    }
    if (Object.hasOwn(value, 'freshness')) {
      if (!isFreshness(value.freshness)) fail('INVALID_QUERY');
      result.freshness = value.freshness;
    }
    return result;
  } catch (error) {
    if (error instanceof PublicEventGeoJSONCandidateError) throw error;
    fail('INVALID_QUERY');
  }
}

function validateBBox(value: unknown): PublicEventGeoJSONBBox {
  if (!Array.isArray(value) || value.length !== 4 || !hasExactArrayKeys(value, 4)) {
    fail('INVALID_QUERY');
  }
  const [west, south, east, north] = value;
  const envelope = PUBLIC_EVENT_GEOJSON_CANDIDATE_LIMITS.applicationEnvelope;
  if (![west, south, east, north].every((bound) => typeof bound === 'number' && Number.isFinite(bound))
    || west > east
    || south > north
    || west < envelope.west
    || south < envelope.south
    || east > envelope.east
    || north > envelope.north) {
    fail('INVALID_QUERY');
  }
  return [west as number, south as number, east as number, north as number];
}

function validateRows(value: unknown): PublicEventGeoJSONCandidate[] {
  try {
    if (!isRecord(value) || !Array.isArray(value.rows)
      || value.rows.length > PUBLIC_EVENT_GEOJSON_CANDIDATE_LIMITS.overflowProbe) {
      fail('RESULT_INVALID');
    }

    const candidates: PublicEventGeoJSONCandidate[] = [];
    const seen = new Set<string>();
    for (const row of value.rows) {
      if (!hasCandidateRowKeys(row)
        || row.dataset_kind !== 'live'
        || !isIdentifier(row.event_id)
        || !isPositiveDatabaseInteger(row.event_version)
        || !isCategory(row.category)
        || !isLifecycle(row.lifecycle)
        || !isFreshness(row.freshness)
        || !isIdentifier(row.geometry_id)
        || !isEventRecordIdentity(row.event_record_json, row)
        || !isGeometryRecordIdentity(row.geometry_record_json, row.geometry_id)) {
        fail('RESULT_INVALID');
      }

      const identity = JSON.stringify([row.event_id, row.event_version, row.geometry_id]);
      if (seen.has(identity)) fail('RESULT_INVALID');
      seen.add(identity);
      candidates.push({
        datasetKind: 'live',
        eventId: row.event_id,
        eventVersion: row.event_version,
        category: row.category,
        lifecycle: row.lifecycle,
        freshness: row.freshness,
        geometryId: row.geometry_id,
        eventRecordJson: row.event_record_json,
        geometryRecordJson: row.geometry_record_json,
      });
    }
    return candidates;
  } catch (error) {
    if (error instanceof PublicEventGeoJSONCandidateError) throw error;
    fail('RESULT_INVALID');
  }
}

function isEventRecordIdentity(value: unknown, row: CandidateRow): boolean {
  return isRecord(value)
    && value.schema_version === '2.0'
    && value.record_type === 'Event'
    && value.dataset_kind === 'live'
    && value.event_id === row.event_id
    && value.version === row.event_version
    && value.publication_status === 'published'
    && value.category === row.category
    && value.lifecycle === row.lifecycle
    && isRecord(value.freshness)
    && value.freshness.status === row.freshness
    && Array.isArray(value.claims);
}

function isGeometryRecordIdentity(value: unknown, geometryId: string): boolean {
  return isRecord(value)
    && value.schema_version === '2.0'
    && value.record_type === 'Geometry'
    && value.dataset_kind === 'live'
    && value.geometry_id === geometryId;
}

function hasExactArrayKeys(value: readonly unknown[], length: number): boolean {
  try {
    const keys = Reflect.ownKeys(value);
    return keys.length === length + 1
      && keys.includes('length')
      && Array.from({ length }, (_, index) => keys.includes(String(index))).every(Boolean);
  } catch {
    return false;
  }
}

function isIdentifier(value: unknown): value is string {
  return typeof value === 'string'
    && value.length <= PUBLIC_EVENT_GEOJSON_CANDIDATE_LIMITS.identifierLength
    && identifierPattern.test(value);
}

function isPositiveDatabaseInteger(value: unknown): value is number {
  return Number.isSafeInteger(value)
    && (value as number) >= 1
    && (value as number) <= maxDatabaseInteger;
}

function isCategory(value: unknown): value is PublicEventGeoJSONCategory {
  return typeof value === 'string' && categories.has(value as PublicEventGeoJSONCategory);
}

function isLifecycle(value: unknown): value is PublicEventGeoJSONLifecycle {
  return typeof value === 'string' && lifecycles.has(value as PublicEventGeoJSONLifecycle);
}

function isFreshness(value: unknown): value is PublicEventGeoJSONFreshness {
  return typeof value === 'string' && freshnessStatuses.has(value as PublicEventGeoJSONFreshness);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
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

function hasCandidateRowKeys(value: unknown): value is CandidateRow {
  return hasExactKeys(value, candidateRowKeys);
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function fail(code: PublicEventGeoJSONCandidateErrorCode): never {
  throw new PublicEventGeoJSONCandidateError(code);
}
