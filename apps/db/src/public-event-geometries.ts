import type { SqlExecutor } from './sql.js';

export const PUBLIC_EVENT_GEOMETRY_LIMITS = Object.freeze({
  geometryIds: 500,
  identifierLength: 128,
});

export interface PublicEventGeometry {
  readonly datasetKind: 'live';
  readonly geometryId: string;
  /** Untrusted schema 2.0 JSON passed to the existing Layer 4 geometry validator. */
  readonly recordJson: unknown;
}

export interface PublicEventGeometriesRepository {
  /** Reads only the requested IDs visible through the current-public geometry view. */
  read(geometryIds: unknown): Promise<readonly PublicEventGeometry[]>;
}

export type PublicEventGeometriesErrorCode =
  | 'INVALID_GEOMETRY_IDS'
  | 'GEOMETRY_ID_LIMIT_EXCEEDED'
  | 'RESULT_INVALID'
  | 'READ_FAILED';

const errorMessages: Record<PublicEventGeometriesErrorCode, string> = {
  INVALID_GEOMETRY_IDS: 'The public geometry identifiers are invalid.',
  GEOMETRY_ID_LIMIT_EXCEEDED: 'The public geometry identifier list exceeds its limit.',
  RESULT_INVALID: 'A public geometry result could not be validated.',
  READ_FAILED: 'The public geometries could not be read.',
};

const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

interface GeometryRow {
  readonly dataset_kind: unknown;
  readonly geometry_id: unknown;
  readonly record_json: unknown;
}

/** Stable errors never include IDs, SQL text, record content, or database errors. */
export class PublicEventGeometriesError extends Error {
  constructor(readonly code: PublicEventGeometriesErrorCode) {
    super(errorMessages[code]);
    this.name = 'PublicEventGeometriesError';
  }
}

export function createPublicEventGeometriesRepository(
  executor: SqlExecutor,
): PublicEventGeometriesRepository {
  return {
    async read(geometryIds: unknown): Promise<readonly PublicEventGeometry[]> {
      const requestedIds = validateGeometryIds(geometryIds);
      if (requestedIds.length === 0) return [];

      let result: { readonly rows: readonly GeometryRow[] };
      try {
        result = await executor.query<GeometryRow>(
          'SELECT geometry.dataset_kind, geometry.geometry_id, geometry.record_json '
            + 'FROM waspada.public_event_geometries AS geometry '
            + 'WHERE geometry.dataset_kind = \'live\' '
            + 'AND geometry.geometry_id = ANY($1::text[]) '
            + 'ORDER BY geometry.geometry_id ASC',
          [requestedIds],
        );
      } catch {
        fail('READ_FAILED');
      }

      return validateResult(result, requestedIds);
    },
  };
}

function validateGeometryIds(value: unknown): string[] {
  if (!Array.isArray(value)) fail('INVALID_GEOMETRY_IDS');
  if (value.length > PUBLIC_EVENT_GEOMETRY_LIMITS.geometryIds) {
    fail('GEOMETRY_ID_LIMIT_EXCEEDED');
  }

  const ids: string[] = [];
  const seen = new Set<string>();
  for (const candidate of value) {
    if (!isIdentifier(candidate) || seen.has(candidate)) fail('INVALID_GEOMETRY_IDS');
    seen.add(candidate);
    ids.push(candidate);
  }
  return ids;
}

function validateResult(
  result: unknown,
  requestedIds: readonly string[],
): readonly PublicEventGeometry[] {
  try {
    if (!isRecord(result) || !Array.isArray(result.rows)
      || result.rows.length > requestedIds.length) {
      fail('RESULT_INVALID');
    }

    const requested = new Set(requestedIds);
    const seen = new Set<string>();
    const geometries: PublicEventGeometry[] = [];
    for (const candidate of result.rows) {
      if (!isRecord(candidate)
        || candidate.dataset_kind !== 'live'
        || !isIdentifier(candidate.geometry_id)
        || !requested.has(candidate.geometry_id)
        || seen.has(candidate.geometry_id)
        || !isGeometryRecordIdentity(candidate.record_json, candidate.geometry_id)) {
        fail('RESULT_INVALID');
      }
      seen.add(candidate.geometry_id);
      geometries.push({
        datasetKind: 'live',
        geometryId: candidate.geometry_id,
        recordJson: candidate.record_json,
      });
    }

    geometries.sort((left, right) => compareStrings(left.geometryId, right.geometryId));
    return geometries;
  } catch (error) {
    if (error instanceof PublicEventGeometriesError) throw error;
    fail('RESULT_INVALID');
  }
}

function isGeometryRecordIdentity(value: unknown, geometryId: string): boolean {
  return isRecord(value)
    && value.schema_version === '2.0'
    && value.record_type === 'Geometry'
    && value.dataset_kind === 'live'
    && value.geometry_id === geometryId
    && isIdentifier(value.trace_id);
}

function isIdentifier(value: unknown): value is string {
  return typeof value === 'string'
    && value.length <= PUBLIC_EVENT_GEOMETRY_LIMITS.identifierLength
    && identifierPattern.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function fail(code: PublicEventGeometriesErrorCode): never {
  throw new PublicEventGeometriesError(code);
}
