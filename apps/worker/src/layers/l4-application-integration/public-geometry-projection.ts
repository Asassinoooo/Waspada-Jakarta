import type {
  EventDetail,
  PublicFeature,
  PublicFeatureCollection,
  PublicGeoJSONGeometry,
  PublicGeoJSONPosition,
  PublicGeometry,
} from "../../contracts/public-api.js";
import {
  projectPublicEventForGeometry,
  type PublicEventGeometryProjectionContext,
  type PublicGeometrySupportReference,
  type PublicProjectionLookups,
} from "./public-projection.js";

const MAX_GEOMETRY_POSITIONS = 10_000;
const MAX_SUPPORT_REFERENCES = 32;
const MAX_PUBLIC_GEOMETRIES = 500;
const MAX_FEATURES = 500;
const MAX_DETAIL_POSITIONS = 100_000;

const idPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const hashPattern = /^[a-f0-9]{64}$/u;

const geometryRoles = new Set<PublicGeometry["role"]>([
  "incident_scene",
  "affected_area",
  "warning_boundary",
  "route_segment",
  "service_stop",
  "facility",
  "venue",
  "service_area",
  "approximate_place",
]);
const precisionBases = new Set([
  "source_supplied",
  "provider_accuracy",
  "gazetteer_match",
  "moderator_generalization",
  "unknown",
]);
const pointRoles = new Set<PublicGeometry["role"]>([
  "incident_scene", "service_stop", "facility", "venue", "approximate_place",
]);
const lineRoles = new Set<PublicGeometry["role"]>(["route_segment"]);
const areaRoles = new Set<PublicGeometry["role"]>(["affected_area", "warning_boundary", "service_area"]);

export type PublicGeometryProjectionErrorCode =
  | "INVALID_GEOMETRIES"
  | "INVALID_GEOMETRY"
  | "GEOMETRY_RESOLUTION_FAILED"
  | "GEOMETRY_LIMIT_EXCEEDED"
  | "INVALID_EVENT_DETAIL";

const errorMessages: Record<PublicGeometryProjectionErrorCode, string> = {
  INVALID_GEOMETRIES: "The event geometry inputs are invalid.",
  INVALID_GEOMETRY: "A geometry cannot be projected.",
  GEOMETRY_RESOLUTION_FAILED: "The event geometry references could not be resolved.",
  GEOMETRY_LIMIT_EXCEEDED: "The public geometry limit was exceeded.",
  INVALID_EVENT_DETAIL: "The projected event details cannot be mapped.",
};

/** A bounded projection error that does not expose input geometry or evidence. */
export class PublicGeometryProjectionError extends Error {
  constructor(readonly code: PublicGeometryProjectionErrorCode) {
    super(errorMessages[code]);
    this.name = "PublicGeometryProjectionError";
  }
}

interface SupportReference {
  readonly reportRevisionId: string;
  readonly permittedTextHash: string;
  readonly spanStart: number;
  readonly spanEnd: number;
  readonly offsetUnit: "unicode_code_points";
  readonly relation: "supports";
}

interface ValidatedGeometryRecord extends PublicGeometry {
  readonly datasetKind: "live" | "historical" | "synthetic";
  readonly sourceEvidence: readonly SupportReference[];
}

interface PositionBudget {
  count: number;
}

interface CoordinateCounter {
  count: number;
  readonly detailBudget: PositionBudget;
}

/**
 * Projects a current public Event into EventDetail, adding only geometries
 * linked by the event/claims and an exact published-claim support reference.
 */
export function projectPublicEventDetail(
  eventValue: unknown,
  lookupsValue: PublicProjectionLookups,
  geometryValues: unknown,
): EventDetail {
  const context = projectPublicEventForGeometry(eventValue, lookupsValue);
  const geometries = projectReferencedGeometries(geometryValues, context);
  return { ...context.eventView, geometries };
}

/**
 * Projects only previously projected EventDetail values into the unchanged
 * GeoJSON FeatureCollection allowlist. Feature order and IDs are deterministic.
 */
export function projectPublicFeatureCollection(
  eventDetails: readonly EventDetail[],
): PublicFeatureCollection {
  if (!Array.isArray(eventDetails)) fail("INVALID_EVENT_DETAIL");

  const features: PublicFeature[] = [];
  const featureIds = new Set<string>();
  const detailBudget: PositionBudget = { count: 0 };
  for (const detailValue of eventDetails as readonly unknown[]) {
    const detail = readProjectedDetail(detailValue, detailBudget);
    for (const geometry of detail.geometries) {
      if (features.length >= MAX_FEATURES) fail("GEOMETRY_LIMIT_EXCEEDED");
      const id = publicFeatureId(detail.eventId, detail.version, geometry.geometry_id);
      if (featureIds.has(id)) fail("INVALID_EVENT_DETAIL");
      featureIds.add(id);
      features.push({
        type: "Feature",
        id,
        geometry: geometry.geometry,
        properties: {
          event_id: detail.eventId,
          version: detail.version,
          title: detail.title,
          category: detail.category,
          lifecycle: detail.lifecycle,
          freshness: detail.freshness,
          geometry_role: geometry.role,
        },
      });
    }
  }

  features.sort((left, right) => compareStrings(left.properties.event_id, right.properties.event_id)
    || left.properties.version - right.properties.version
    || compareStrings(left.id, right.id));
  return { type: "FeatureCollection", features };
}

function projectReferencedGeometries(
  values: unknown,
  context: PublicEventGeometryProjectionContext,
): PublicGeometry[] {
  if (!Array.isArray(values)) fail("INVALID_GEOMETRIES");

  const referencedIds = new Set(context.geometryIds);
  for (const claim of context.claims) {
    for (const geometryId of claim.geometryIds) referencedIds.add(geometryId);
  }
  if (referencedIds.size > MAX_PUBLIC_GEOMETRIES || values.length > MAX_PUBLIC_GEOMETRIES) {
    fail("GEOMETRY_LIMIT_EXCEEDED");
  }
  if (values.length !== referencedIds.size) fail("GEOMETRY_RESOLUTION_FAILED");

  const seenIds = new Set<string>();
  const result: PublicGeometry[] = [];
  const detailBudget: PositionBudget = { count: 0 };
  for (const value of values) {
    const geometry = readGeometryRecord(value, detailBudget);
    if (geometry.datasetKind !== "live" || !referencedIds.has(geometry.geometry_id)) {
      fail("GEOMETRY_RESOLUTION_FAILED");
    }
    if (seenIds.has(geometry.geometry_id)) fail("GEOMETRY_RESOLUTION_FAILED");
    seenIds.add(geometry.geometry_id);

    const isSupportedByReferencingClaim = context.claims.some((claim) =>
      claim.geometryIds.includes(geometry.geometry_id)
      && claim.supports.some((claimSupport) =>
        geometry.sourceEvidence.some((geometrySupport) => supportsMatch(claimSupport, geometrySupport))));
    if (!isSupportedByReferencingClaim) fail("GEOMETRY_RESOLUTION_FAILED");

    result.push({
      geometry_id: geometry.geometry_id,
      role: geometry.role,
      geometry: geometry.geometry,
      precision_m: geometry.precision_m,
      label: geometry.label,
    });
  }
  if (seenIds.size !== referencedIds.size) fail("GEOMETRY_RESOLUTION_FAILED");
  result.sort((left, right) => compareStrings(left.geometry_id, right.geometry_id));
  return result;
}

function readGeometryRecord(value: unknown, detailBudget: PositionBudget): ValidatedGeometryRecord {
  if (!isRecord(value)
    || value.schema_version !== "2.0"
    || value.record_type !== "Geometry"
    || !isId(value.trace_id)
    || !isDatasetKind(value.dataset_kind)
    || !isId(value.geometry_id)
    || typeof value.coordinate_reference_system !== "string"
    || value.coordinate_reference_system !== "OGC:CRS84") {
    fail("INVALID_GEOMETRY");
  }

  const role = readEnum(value.role, geometryRoles, "INVALID_GEOMETRY");
  if (typeof value.precision_basis !== "string" || !precisionBases.has(value.precision_basis)) {
    fail("INVALID_GEOMETRY");
  }

  let precisionM: number | null;
  if (value.precision_m === null) {
    precisionM = null;
  } else if (typeof value.precision_m === "number"
    && Number.isFinite(value.precision_m)
    && value.precision_m >= 0
    && value.precision_m <= 10_000_000) {
    precisionM = value.precision_m;
  } else {
    fail("INVALID_GEOMETRY");
  }

  let label: string | null;
  if (value.display_label === null) {
    label = null;
  } else if (typeof value.display_label === "string"
    && codePointLength(value.display_label) >= 1
    && codePointLength(value.display_label) <= 200) {
    label = value.display_label;
  } else {
    fail("INVALID_GEOMETRY");
  }

  const counter: CoordinateCounter = { count: 0, detailBudget };
  const geometry = readGeoJSONGeometry(value.geojson, counter);
  if (!roleAcceptsGeometry(role, geometry.type)) fail("INVALID_GEOMETRY");
  const sourceEvidence = readSourceEvidence(value.source_evidence);

  return {
    datasetKind: value.dataset_kind,
    geometry_id: value.geometry_id,
    role,
    geometry,
    precision_m: precisionM,
    label,
    sourceEvidence,
  };
}

function readSourceEvidence(value: unknown): SupportReference[] {
  const references = readArray(value, 1, MAX_SUPPORT_REFERENCES, "INVALID_GEOMETRY");
  const seen = new Set<string>();
  return references.map((referenceValue) => {
    if (!isRecord(referenceValue)) fail("INVALID_GEOMETRY");
    const revisionId = readId(referenceValue.report_revision_id, "INVALID_GEOMETRY");
    const hash = referenceValue.permitted_text_hash;
    if (typeof hash !== "string" || !hashPattern.test(hash)) fail("INVALID_GEOMETRY");
    const spanStart = readInteger(referenceValue.span_start, 0, 10_000_000, "INVALID_GEOMETRY");
    const spanEnd = readInteger(referenceValue.span_end, 1, 10_000_000, "INVALID_GEOMETRY");
    if (spanEnd <= spanStart
      || referenceValue.offset_unit !== "unicode_code_points"
      || referenceValue.relation !== "supports"
      || !hasExactKeys(referenceValue, [
        "report_revision_id", "permitted_text_hash", "span_start", "span_end", "offset_unit", "relation",
      ])) {
      fail("INVALID_GEOMETRY");
    }

    const parsed: SupportReference = {
      reportRevisionId: revisionId,
      permittedTextHash: hash,
      spanStart,
      spanEnd,
      offsetUnit: "unicode_code_points",
      relation: "supports",
    };
    const key = supportKey(parsed);
    if (seen.has(key)) fail("INVALID_GEOMETRY");
    seen.add(key);
    return parsed;
  });
}

function readGeoJSONGeometry(value: unknown, counter: CoordinateCounter): PublicGeoJSONGeometry {
  if (!isRecord(value) || !hasExactKeys(value, ["type", "coordinates"])) fail("INVALID_GEOMETRY");
  const type = value.type;
  const coordinates = value.coordinates;
  if (type === "Point") {
    return { type, coordinates: readPosition(coordinates, counter) };
  }
  if (type === "LineString") {
    return { type, coordinates: readLine(coordinates, counter) };
  }
  if (type === "Polygon") {
    return { type, coordinates: readPolygon(coordinates, counter) };
  }
  if (type === "MultiPoint") {
    return {
      type,
      coordinates: readArray(coordinates, 1, MAX_GEOMETRY_POSITIONS, "INVALID_GEOMETRY")
        .map((position) => readPosition(position, counter)),
    };
  }
  if (type === "MultiLineString") {
    return {
      type,
      coordinates: readArray(coordinates, 1, MAX_GEOMETRY_POSITIONS, "INVALID_GEOMETRY")
        .map((line) => readLine(line, counter)),
    };
  }
  if (type === "MultiPolygon") {
    return {
      type,
      coordinates: readArray(coordinates, 1, MAX_GEOMETRY_POSITIONS, "INVALID_GEOMETRY")
        .map((polygon) => readPolygon(polygon, counter)),
    };
  }
  fail("INVALID_GEOMETRY");
}

function readPosition(value: unknown, counter: CoordinateCounter): PublicGeoJSONPosition {
  const position = readArray(value, 2, 2, "INVALID_GEOMETRY");
  const longitude = position[0];
  const latitude = position[1];
  if (typeof longitude !== "number" || !Number.isFinite(longitude) || longitude < -180 || longitude > 180
    || typeof latitude !== "number" || !Number.isFinite(latitude) || latitude < -90 || latitude > 90) {
    fail("INVALID_GEOMETRY");
  }
  counter.count += 1;
  counter.detailBudget.count += 1;
  if (counter.count > MAX_GEOMETRY_POSITIONS || counter.detailBudget.count > MAX_DETAIL_POSITIONS) {
    fail("GEOMETRY_LIMIT_EXCEEDED");
  }
  return [longitude, latitude];
}

function readLine(value: unknown, counter: CoordinateCounter): PublicGeoJSONPosition[] {
  return readArray(value, 2, MAX_GEOMETRY_POSITIONS, "INVALID_GEOMETRY")
    .map((position) => readPosition(position, counter));
}

function readRing(value: unknown, counter: CoordinateCounter): PublicGeoJSONPosition[] {
  const ring = readArray(value, 4, MAX_GEOMETRY_POSITIONS, "INVALID_GEOMETRY")
    .map((position) => readPosition(position, counter));
  const first = ring[0]!;
  const last = ring[ring.length - 1]!;
  if (first[0] !== last[0] || first[1] !== last[1]) fail("INVALID_GEOMETRY");
  return ring;
}

function readPolygon(value: unknown, counter: CoordinateCounter): PublicGeoJSONPosition[][] {
  return readArray(value, 1, MAX_GEOMETRY_POSITIONS, "INVALID_GEOMETRY")
    .map((ring) => readRing(ring, counter));
}

function readProjectedDetail(value: unknown, budget: PositionBudget): {
  readonly eventId: string;
  readonly version: number;
  readonly title: string;
  readonly category: EventDetail["category"];
  readonly lifecycle: EventDetail["lifecycle"];
  readonly freshness: EventDetail["freshness"]["status"];
  readonly geometries: readonly PublicGeometry[];
} {
  if (!isRecord(value)
    || !isId(value.event_id)
    || !isPositiveInteger(value.version)
    || !isBoundedString(value.title, 240)
    || !isCategory(value.category)
    || !isLifecycle(value.lifecycle)
    || !isRecord(value.freshness)
    || !isFreshness(value.freshness.status)
    || !Array.isArray(value.geometries)) {
    fail("INVALID_EVENT_DETAIL");
  }
  if (value.geometries.length > MAX_PUBLIC_GEOMETRIES) fail("GEOMETRY_LIMIT_EXCEEDED");
  const geometries = value.geometries.map((geometryValue) => readProjectedGeometry(geometryValue, budget));
  return {
    eventId: value.event_id,
    version: value.version,
    title: value.title,
    category: value.category,
    lifecycle: value.lifecycle,
    freshness: value.freshness.status,
    geometries,
  };
}

function readProjectedGeometry(value: unknown, budget: PositionBudget): PublicGeometry {
  if (!isRecord(value)
    || !hasExactKeys(value, ["geometry_id", "role", "geometry", "precision_m", "label"])
    || !isId(value.geometry_id)
    || typeof value.role !== "string"
    || !geometryRoles.has(value.role as PublicGeometry["role"])) {
    fail("INVALID_EVENT_DETAIL");
  }
  const counter: CoordinateCounter = { count: 0, detailBudget: budget };
  const geometry = readGeoJSONGeometry(value.geometry, counter);
  const role = value.role as PublicGeometry["role"];
  if (!roleAcceptsGeometry(role, geometry.type)) fail("INVALID_EVENT_DETAIL");

  let precisionM: number | null;
  if (value.precision_m === null) {
    precisionM = null;
  } else if (typeof value.precision_m === "number"
    && Number.isFinite(value.precision_m)
    && value.precision_m >= 0
    && value.precision_m <= 10_000_000) {
    precisionM = value.precision_m;
  } else {
    fail("INVALID_EVENT_DETAIL");
  }

  let label: string | null;
  if (value.label === null) {
    label = null;
  } else if (typeof value.label === "string"
    && codePointLength(value.label) >= 1
    && codePointLength(value.label) <= 200) {
    label = value.label;
  } else {
    fail("INVALID_EVENT_DETAIL");
  }

  return {
    geometry_id: value.geometry_id,
    role,
    geometry,
    precision_m: precisionM,
    label,
  };
}

function roleAcceptsGeometry(role: PublicGeometry["role"], type: PublicGeoJSONGeometry["type"]): boolean {
  if (pointRoles.has(role)) return type === "Point" || type === "MultiPoint";
  if (lineRoles.has(role)) return type === "LineString" || type === "MultiLineString";
  if (areaRoles.has(role)) return type === "Polygon" || type === "MultiPolygon";
  return false;
}

function supportsMatch(left: PublicGeometrySupportReference, right: SupportReference): boolean {
  return left.reportRevisionId === right.reportRevisionId
    && left.permittedTextHash === right.permittedTextHash
    && left.spanStart === right.spanStart
    && left.spanEnd === right.spanEnd
    && left.offsetUnit === right.offsetUnit
    && left.relation === right.relation;
}

function supportKey(reference: SupportReference): string {
  return JSON.stringify([
    reference.reportRevisionId,
    reference.permittedTextHash,
    reference.spanStart,
    reference.spanEnd,
    reference.offsetUnit,
    reference.relation,
  ]);
}

function publicFeatureId(eventId: string, version: number, geometryId: string): string {
  return JSON.stringify([eventId, version, geometryId]);
}

function readArray(value: unknown, minimum: number, maximum: number, code: PublicGeometryProjectionErrorCode): unknown[] {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) fail(code);
  for (const key of Reflect.ownKeys(value)) {
    if (key === "length") continue;
    if (typeof key !== "string" || !/^(0|[1-9][0-9]*)$/u.test(key) || Number(key) >= value.length) fail(code);
  }
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.prototype.hasOwnProperty.call(value, index)) fail(code);
  }
  return value;
}

function readEnum<const T extends string>(value: unknown, allowed: ReadonlySet<T>, code: PublicGeometryProjectionErrorCode): T {
  if (typeof value !== "string" || !allowed.has(value as T)) fail(code);
  return value as T;
}

function readId(value: unknown, code: PublicGeometryProjectionErrorCode): string {
  if (!isId(value)) fail(code);
  return value;
}

function readInteger(value: unknown, minimum: number, maximum: number, code: PublicGeometryProjectionErrorCode): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) fail(code);
  return value;
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Reflect.ownKeys(value);
  return keys.length === expected.length
    && expected.every((key) => Object.prototype.hasOwnProperty.call(value, key))
    && keys.every((key) => typeof key === "string" && expected.includes(key));
}

function isId(value: unknown): value is string {
  return typeof value === "string" && value.length <= 128 && idPattern.test(value);
}

function isDatasetKind(value: unknown): value is "live" | "historical" | "synthetic" {
  return value === "live" || value === "historical" || value === "synthetic";
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 && value <= 2_147_483_647;
}

function isBoundedString(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.length > 0 && codePointLength(value) <= maxLength;
}

function isCategory(value: unknown): value is EventDetail["category"] {
  return typeof value === "string" && [
    "crime_personal_security", "demonstrations_public_gatherings", "crowds_major_events",
    "violence_immediate_threats", "disasters_weather", "fires_infrastructure_hazards",
    "transport_road_incidents", "utilities_essential_services", "health_environmental_advisories",
    "group_specific_critical_notices",
  ].includes(value);
}

function isLifecycle(value: unknown): value is EventDetail["lifecycle"] {
  return value === "planned" || value === "ongoing" || value === "resolved" || value === "cancelled" || value === "unknown";
}

function isFreshness(value: unknown): value is EventDetail["freshness"]["status"] {
  return value === "current" || value === "needs_update" || value === "expired";
}

function codePointLength(value: string): number {
  return Array.from(value).length;
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function fail(code: PublicGeometryProjectionErrorCode): never {
  throw new PublicGeometryProjectionError(code);
}
