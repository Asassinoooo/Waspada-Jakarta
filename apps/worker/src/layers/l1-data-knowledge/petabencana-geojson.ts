/**
 * Pure parser for an already-buffered PetaBencana-style GeoJSON response.
 *
 * This module performs no acquisition, persistence, geocoding, or inference.
 * An empty collection means only that this response contained no features; it
 * does not establish an all-clear condition.
 *
 * `created_at` is documented as report creation time in the source feasibility note;
 * it does not establish when the described incident was observed. The exact
 * `properties.pkey`, `properties.status`, and `properties.report_type` names
 * are provisional synthetic-fixture assumptions; a non-empty provider payload
 * has not verified these names or their meanings.
 */

export const PETABENCANA_GEOJSON_LIMITS = {
  maxInputBytes: 1_048_576,
  maxNestingDepth: 32,
  maxFeatures: 500,
  maxCoordinatePositions: 20_000,
  maxProviderTextLength: 128,
} as const;

export type ProviderIdentifier = string | number;

export type GeoJsonPosition = readonly [longitude: number, latitude: number]
  | readonly [longitude: number, latitude: number, altitude: number];

export type PetabencanaGeometry =
  | { readonly type: "Point"; readonly coordinates: GeoJsonPosition }
  | { readonly type: "MultiPoint"; readonly coordinates: readonly GeoJsonPosition[] }
  | { readonly type: "LineString"; readonly coordinates: readonly GeoJsonPosition[] }
  | { readonly type: "MultiLineString"; readonly coordinates: readonly (readonly GeoJsonPosition[])[] }
  | { readonly type: "Polygon"; readonly coordinates: readonly (readonly GeoJsonPosition[])[] }
  | {
      readonly type: "MultiPolygon";
      readonly coordinates: readonly (readonly (readonly GeoJsonPosition[])[])[];
    };

export interface PetabencanaReport {
  /** Explicit GeoJSON feature.id or provisional fixture assumption properties.pkey; never generated. */
  readonly featureId: ProviderIdentifier | null;
  /** Provisional fixture assumption properties.status; attribution metadata, not verification. */
  readonly providerStatus: string | null;
  /** Provisional fixture assumption properties.report_type. */
  readonly reportType: string | null;
  /** Valid properties.created_at copied verbatim as report-record creation metadata. */
  readonly sourceCreatedAt: string | null;
  readonly sourceCreatedAtState: "valid" | "missing" | "invalid";
  readonly retrievedAt: string;
  /** Original source geometry, or null when GeoJSON explicitly supplies null. */
  readonly geometry: PetabencanaGeometry | null;
}

export type PetabencanaParseErrorCode =
  | "invalid_retrieved_at"
  | "input_too_large"
  | "nesting_limit_exceeded"
  | "invalid_json"
  | "unsupported_root_type"
  | "invalid_feature_list"
  | "feature_limit_exceeded"
  | "invalid_feature"
  | "invalid_feature_id"
  | "conflicting_feature_ids"
  | "duplicate_feature_id"
  | "invalid_feature_properties"
  | "invalid_provider_field"
  | "unsupported_geometry_type"
  | "invalid_geometry"
  | "coordinate_limit_exceeded";

export interface PetabencanaParseError {
  readonly kind: "malformed" | "unsupported";
  readonly code: PetabencanaParseErrorCode;
  /** Present only for feature-specific errors; contains no source text. */
  readonly featureIndex?: number;
}

export type PetabencanaParseResult =
  | {
      readonly kind: "empty";
      readonly retrievedAt: string;
      readonly reports: readonly [];
    }
  | {
      readonly kind: "records";
      readonly retrievedAt: string;
      readonly reports: readonly PetabencanaReport[];
    }
  | {
      readonly kind: "error";
      readonly error: PetabencanaParseError;
    };

interface CoordinateBudget {
  used: number;
}

class ParseFailure extends Error {
  constructor(readonly detail: PetabencanaParseError) {
    super(detail.code);
  }
}

/** Parse a FeatureCollection from JSON text already obtained by the caller. */
export function parsePetabencanaGeoJson(
  jsonText: string,
  retrievedAt: string,
): PetabencanaParseResult {
  if (typeof retrievedAt !== "string" || !isValidRfc3339DateTime(retrievedAt)) {
    return failure("malformed", "invalid_retrieved_at");
  }

  if (typeof jsonText !== "string") {
    return failure("malformed", "invalid_json");
  }
  if (jsonText.length > PETABENCANA_GEOJSON_LIMITS.maxInputBytes) {
    return failure("unsupported", "input_too_large");
  }

  // The code-unit precheck bounds this allocation even for malformed input.
  if (new TextEncoder().encode(jsonText).byteLength > PETABENCANA_GEOJSON_LIMITS.maxInputBytes) {
    return failure("unsupported", "input_too_large");
  }

  if (hasExcessiveNesting(jsonText)) {
    return failure("unsupported", "nesting_limit_exceeded");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText) as unknown;
  } catch {
    // JSON.parse messages can contain source excerpts. Return a fixed code only.
    return failure("malformed", "invalid_json");
  }

  try {
    return parseCollection(parsed, retrievedAt);
  } catch (error) {
    if (error instanceof ParseFailure) {
      return { kind: "error", error: error.detail };
    }
    return failure("malformed", "invalid_feature");
  }
}

function parseCollection(value: unknown, retrievedAt: string): PetabencanaParseResult {
  if (!isRecord(value) || value.type !== "FeatureCollection") {
    throw new ParseFailure({ kind: "unsupported", code: "unsupported_root_type" });
  }
  if (!Array.isArray(value.features)) {
    throw new ParseFailure({ kind: "malformed", code: "invalid_feature_list" });
  }
  if (value.features.length > PETABENCANA_GEOJSON_LIMITS.maxFeatures) {
    throw new ParseFailure({ kind: "unsupported", code: "feature_limit_exceeded" });
  }

  const reports: PetabencanaReport[] = [];
  const seenIds = new Set<string>();
  const budget: CoordinateBudget = { used: 0 };

  for (let index = 0; index < value.features.length; index += 1) {
    const feature = value.features[index];
    try {
      const report = parseFeature(feature, retrievedAt, budget);
      if (report.featureId !== null) {
        const key = identifierKey(report.featureId);
        if (seenIds.has(key)) {
          throw new ParseFailure({
            kind: "malformed",
            code: "duplicate_feature_id",
            featureIndex: index,
          });
        }
        seenIds.add(key);
      }
      reports.push(report);
    } catch (error) {
      if (error instanceof ParseFailure) {
        throw new ParseFailure({ ...error.detail, featureIndex: index });
      }
      throw new ParseFailure({ kind: "malformed", code: "invalid_feature", featureIndex: index });
    }
  }

  if (reports.length === 0) {
    return { kind: "empty", retrievedAt, reports: [] };
  }
  return { kind: "records", retrievedAt, reports };
}

function parseFeature(
  value: unknown,
  retrievedAt: string,
  budget: CoordinateBudget,
): PetabencanaReport {
  if (!isRecord(value) || value.type !== "Feature" || !hasOwn(value, "geometry")
    || !hasOwn(value, "properties")) {
    throw new ParseFailure({ kind: "malformed", code: "invalid_feature" });
  }

  const properties = value.properties;
  if (properties !== null && !isRecord(properties)) {
    throw new ParseFailure({ kind: "malformed", code: "invalid_feature_properties" });
  }

  const featureId = parseFeatureId(value, properties);
  const metadata = properties ?? {};
  const providerStatus = readOptionalProviderText(metadata, "status");
  const reportType = readOptionalProviderText(metadata, "report_type");
  const sourceCreatedAt = readOptionalCreatedAt(metadata);
  const geometry = value.geometry === null ? null : parseGeometry(value.geometry, budget);

  return {
    featureId,
    providerStatus,
    reportType,
    sourceCreatedAt: sourceCreatedAt.value,
    sourceCreatedAtState: sourceCreatedAt.state,
    retrievedAt,
    geometry,
  };
}

function parseFeatureId(
  feature: Record<string, unknown>,
  properties: Record<string, unknown> | null,
): ProviderIdentifier | null {
  const featureHasId = hasOwn(feature, "id");
  const propertiesHaveKey = properties !== null && hasOwn(properties, "pkey");
  const featureId = featureHasId ? parseIdentifier(feature.id) : null;
  const providerKey = propertiesHaveKey ? parseIdentifier(properties?.pkey) : null;

  if (featureHasId && featureId === null) {
    throw new ParseFailure({ kind: "malformed", code: "invalid_feature_id" });
  }
  if (propertiesHaveKey && properties?.pkey !== null && providerKey === null) {
    throw new ParseFailure({ kind: "malformed", code: "invalid_feature_id" });
  }
  if (featureId !== null && providerKey !== null && !sameIdentifier(featureId, providerKey)) {
    throw new ParseFailure({ kind: "malformed", code: "conflicting_feature_ids" });
  }
  return featureId ?? providerKey;
}

function parseIdentifier(value: unknown): ProviderIdentifier | null {
  if (typeof value === "string" && value.length > 0
    && value.length <= PETABENCANA_GEOJSON_LIMITS.maxProviderTextLength) {
    return value;
  }
  // Reject rounded/unsafe JSON integers instead of retaining a changed identifier.
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  return null;
}

function sameIdentifier(left: ProviderIdentifier, right: ProviderIdentifier): boolean {
  return typeof left === typeof right && left === right;
}

function identifierKey(value: ProviderIdentifier): string {
  return typeof value === "string" ? `s:${value}` : `n:${Object.is(value, -0) ? 0 : value}`;
}

function readOptionalProviderText(
  properties: Record<string, unknown>,
  key: "status" | "report_type",
): string | null {
  if (!hasOwn(properties, key) || properties[key] === null) return null;
  const value = properties[key];
  if (typeof value !== "string" || value.length > PETABENCANA_GEOJSON_LIMITS.maxProviderTextLength) {
    throw new ParseFailure({ kind: "malformed", code: "invalid_provider_field" });
  }
  return value;
}

function readOptionalCreatedAt(
  properties: Record<string, unknown>,
): { readonly value: string | null; readonly state: "valid" | "missing" | "invalid" } {
  if (!hasOwn(properties, "created_at")) return { value: null, state: "missing" };
  const value = properties.created_at;
  if (typeof value !== "string" || !isValidRfc3339DateTime(value)) {
    return { value: null, state: "invalid" };
  }
  return { value, state: "valid" };
}

function parseGeometry(value: unknown, budget: CoordinateBudget): PetabencanaGeometry {
  if (!isRecord(value) || typeof value.type !== "string") {
    throw new ParseFailure({ kind: "malformed", code: "invalid_geometry" });
  }
  if (!["Point", "MultiPoint", "LineString", "MultiLineString", "Polygon", "MultiPolygon"].includes(value.type)) {
    throw new ParseFailure({ kind: "unsupported", code: "unsupported_geometry_type" });
  }
  if (!hasOwn(value, "coordinates")) {
    throw new ParseFailure({ kind: "malformed", code: "invalid_geometry" });
  }

  switch (value.type) {
    case "Point":
      return { type: "Point", coordinates: parsePosition(value.coordinates, budget) };
    case "MultiPoint":
      return { type: "MultiPoint", coordinates: parsePositions(value.coordinates, budget) };
    case "LineString":
      return { type: "LineString", coordinates: parseLine(value.coordinates, budget) };
    case "MultiLineString":
      return { type: "MultiLineString", coordinates: parseLines(value.coordinates, budget) };
    case "Polygon":
      return { type: "Polygon", coordinates: parsePolygon(value.coordinates, budget) };
    case "MultiPolygon":
      return { type: "MultiPolygon", coordinates: parseMultiPolygon(value.coordinates, budget) };
    default:
      throw new ParseFailure({ kind: "unsupported", code: "unsupported_geometry_type" });
  }
}

function parsePosition(value: unknown, budget: CoordinateBudget): GeoJsonPosition {
  if (!Array.isArray(value) || (value.length !== 2 && value.length !== 3)) {
    throw new ParseFailure({ kind: "malformed", code: "invalid_geometry" });
  }
  budget.used += 1;
  if (budget.used > PETABENCANA_GEOJSON_LIMITS.maxCoordinatePositions) {
    throw new ParseFailure({ kind: "unsupported", code: "coordinate_limit_exceeded" });
  }

  const longitude = value[0];
  const latitude = value[1];
  const altitude = value[2];
  if (typeof longitude !== "number" || !Number.isFinite(longitude) || longitude < -180 || longitude > 180
    || typeof latitude !== "number" || !Number.isFinite(latitude) || latitude < -90 || latitude > 90
    || (value.length === 3 && (typeof altitude !== "number" || !Number.isFinite(altitude)))) {
    throw new ParseFailure({ kind: "malformed", code: "invalid_geometry" });
  }
  return value.length === 2 ? [longitude, latitude] : [longitude, latitude, altitude as number];
}

function parsePositions(value: unknown, budget: CoordinateBudget): readonly GeoJsonPosition[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new ParseFailure({ kind: "malformed", code: "invalid_geometry" });
  }
  return value.map((position) => parsePosition(position, budget));
}

function parseLine(value: unknown, budget: CoordinateBudget): readonly GeoJsonPosition[] {
  const positions = parsePositions(value, budget);
  if (positions.length < 2) throw new ParseFailure({ kind: "malformed", code: "invalid_geometry" });
  return positions;
}

function parseLines(
  value: unknown,
  budget: CoordinateBudget,
): readonly (readonly GeoJsonPosition[])[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new ParseFailure({ kind: "malformed", code: "invalid_geometry" });
  }
  return value.map((line) => parseLine(line, budget));
}

function parsePolygon(
  value: unknown,
  budget: CoordinateBudget,
): readonly (readonly GeoJsonPosition[])[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new ParseFailure({ kind: "malformed", code: "invalid_geometry" });
  }
  return value.map((ring) => {
    const positions = parsePositions(ring, budget);
    if (positions.length < 4 || !samePosition(positions[0]!, positions[positions.length - 1]!)) {
      throw new ParseFailure({ kind: "malformed", code: "invalid_geometry" });
    }
    return positions;
  });
}

function parseMultiPolygon(
  value: unknown,
  budget: CoordinateBudget,
): readonly (readonly (readonly GeoJsonPosition[])[])[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new ParseFailure({ kind: "malformed", code: "invalid_geometry" });
  }
  return value.map((polygon) => parsePolygon(polygon, budget));
}

function samePosition(left: GeoJsonPosition, right: GeoJsonPosition): boolean {
  return left.length === right.length && left.every((ordinate, index) => ordinate === right[index]);
}

function hasExcessiveNesting(text: string): boolean {
  let depth = 0;
  let insideString = false;
  let escaped = false;

  for (let index = 0; index < text.length; index += 1) {
    const character = text.charCodeAt(index);
    if (insideString) {
      if (escaped) escaped = false;
      else if (character === 0x5c) escaped = true;
      else if (character === 0x22) insideString = false;
      continue;
    }
    if (character === 0x22) {
      insideString = true;
    } else if (character === 0x7b || character === 0x5b) {
      depth += 1;
      if (depth > PETABENCANA_GEOJSON_LIMITS.maxNestingDepth) return true;
    } else if ((character === 0x7d || character === 0x5d) && depth > 0) {
      depth -= 1;
    }
  }
  return false;
}

function isValidRfc3339DateTime(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (match === null) return false;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  if (month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) return false;

  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysPerMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (day < 1 || day > daysPerMonth[month - 1]!) return false;

  const offset = match[8]!;
  if (offset !== "Z") {
    const offsetHour = Number(offset.slice(1, 3));
    const offsetMinute = Number(offset.slice(4, 6));
    if (offsetHour > 23 || offsetMinute > 59) return false;
  }
  return Number.isFinite(Date.parse(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function failure(kind: PetabencanaParseError["kind"], code: PetabencanaParseErrorCode): PetabencanaParseResult {
  return { kind: "error", error: { kind, code } };
}
