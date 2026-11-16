import { createHash } from "node:crypto";
import type { SqlExecutor, TransactionalSqlExecutor } from "./sql.js";

export type GeometryDatasetKind = "live" | "historical" | "synthetic";
export type GeometryRole =
  | "incident_scene"
  | "affected_area"
  | "warning_boundary"
  | "route_segment"
  | "service_stop"
  | "facility"
  | "venue"
  | "service_area"
  | "approximate_place";
export type GeometryPrecisionBasis =
  | "source_supplied"
  | "provider_accuracy"
  | "gazetteer_match"
  | "moderator_generalization"
  | "unknown";

export interface GeometrySupportEvidenceRef {
  readonly report_revision_id: string;
  readonly permitted_text_hash: string;
  readonly span_start: number;
  readonly span_end: number;
  readonly offset_unit: "unicode_code_points";
  readonly relation: "supports";
}

export type GeoPosition = readonly [longitude: number, latitude: number];

export type GeoJSONGeometry =
  | { readonly type: "Point"; readonly coordinates: GeoPosition }
  | { readonly type: "LineString"; readonly coordinates: readonly GeoPosition[] }
  | { readonly type: "Polygon"; readonly coordinates: readonly (readonly GeoPosition[])[] }
  | { readonly type: "MultiPoint"; readonly coordinates: readonly GeoPosition[] }
  | { readonly type: "MultiLineString"; readonly coordinates: readonly (readonly GeoPosition[])[] }
  | { readonly type: "MultiPolygon"; readonly coordinates: readonly (readonly (readonly GeoPosition[])[])[] };

export interface GeometryRecord {
  readonly schema_version: "2.0";
  readonly trace_id: string;
  readonly record_type: "Geometry";
  readonly dataset_kind: GeometryDatasetKind;
  readonly geometry_id: string;
  readonly role: GeometryRole;
  readonly geojson: GeoJSONGeometry;
  readonly coordinate_reference_system: "OGC:CRS84";
  readonly precision_m: number | null;
  readonly precision_basis: GeometryPrecisionBasis;
  readonly display_label: string | null;
  readonly source_evidence: readonly GeometrySupportEvidenceRef[];
}

export interface GeometryWriteResult {
  readonly geometryId: string;
  readonly outcome: "created" | "already_exists";
}

export interface GeometryWriter {
  /** Validate and append one schema 2.0 Geometry and its exact persisted support links atomically. */
  persist(input: unknown): Promise<GeometryWriteResult>;
}

export type GeometryWriteErrorCode =
  | "geometry_input_invalid"
  | "geometry_support_invalid"
  | "geometry_conflict";

export class GeometryWriteError extends Error {
  constructor(readonly code: GeometryWriteErrorCode, message: string) {
    super(message);
    this.name = "GeometryWriteError";
  }
}

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const MAX_GEOMETRY_POSITIONS = 10_000;
const MAX_SUPPORT_REFERENCES = 32;
const TOP_LEVEL_KEYS = [
  "schema_version", "trace_id", "record_type", "dataset_kind", "geometry_id", "role",
  "geojson", "coordinate_reference_system", "precision_m", "precision_basis",
  "display_label", "source_evidence",
];
const SUPPORT_KEYS = [
  "report_revision_id", "permitted_text_hash", "span_start", "span_end", "offset_unit", "relation",
];
const POINT_ROLES = new Set<GeometryRole>([
  "incident_scene", "service_stop", "facility", "venue", "approximate_place",
]);
const LINE_ROLES = new Set<GeometryRole>(["route_segment"]);
const AREA_ROLES = new Set<GeometryRole>(["affected_area", "warning_boundary", "service_area"]);

interface CoordinateCounter {
  positions: number;
}

interface ResolvedSupport {
  readonly evidenceRefId: string;
}

interface SupportEvidenceRow {
  readonly evidence_ref_id: string;
  readonly permitted_text: string;
  readonly permitted_text_hash: string;
}

interface ExistingGeometryRow {
  readonly trace_id: string;
  readonly role: string;
  readonly coordinate_reference_system: string;
  readonly precision_m: number | null;
  readonly precision_basis: string;
  readonly display_label: string | null;
  readonly record_matches: boolean;
  readonly shape_matches: boolean;
}

export function createSqlGeometryWriter(executor: TransactionalSqlExecutor): GeometryWriter {
  return new SqlGeometryWriter(executor);
}

class SqlGeometryWriter implements GeometryWriter {
  constructor(private readonly transactions: TransactionalSqlExecutor) {}

  async persist(input: unknown): Promise<GeometryWriteResult> {
    const record = parseGeometryRecord(input);
    const recordJson = JSON.stringify(record);
    const geoJson = JSON.stringify(record.geojson);

    try {
      return await this.transactions.transaction((transaction) =>
        this.persistInTransaction(transaction, record, recordJson, geoJson));
    } catch (error) {
      if (!isUniqueViolation(error, "geometries_pkey")) throw error;

      // A concurrent identical insert can win after our initial read. Re-read
      // after the failed transaction, then accept only the complete same record.
      const retry = await this.transactions.transaction(async (transaction) => {
        const supports = await resolveSupportingEvidence(transaction, record);
        const existing = await findExistingGeometry(transaction, record, recordJson, geoJson);
        return existing
          ? compareExistingGeometry(transaction, record, supports, existing)
          : null;
      });
      if (retry === null) throw error;
      return retry;
    }
  }

  private async persistInTransaction(
    transaction: SqlExecutor,
    record: GeometryRecord,
    recordJson: string,
    geoJson: string,
  ): Promise<GeometryWriteResult> {
    await assertPostgisTopology(transaction, geoJson);
    const supports = await resolveSupportingEvidence(transaction, record);
    const existing = await findExistingGeometry(transaction, record, recordJson, geoJson);
    if (existing) return compareExistingGeometry(transaction, record, supports, existing);

    await transaction.query(
      [
        "INSERT INTO waspada.geometries",
        "  (dataset_kind, geometry_id, trace_id, role, shape, coordinate_reference_system,",
        "   precision_m, precision_basis, display_label, record_json)",
        "VALUES ($1, $2, $3, $4,",
        "  ST_SetSRID(ST_GeomFromGeoJSON($5::text), 4326), $6, $7, $8, $9, $10::jsonb)",
      ].join("\n"),
      [
        record.dataset_kind,
        record.geometry_id,
        record.trace_id,
        record.role,
        geoJson,
        record.coordinate_reference_system,
        record.precision_m,
        record.precision_basis,
        record.display_label,
        recordJson,
      ],
    );

    for (const support of supports) {
      await transaction.query(
        "INSERT INTO waspada.geometry_evidence (dataset_kind, geometry_id, evidence_ref_id) VALUES ($1, $2, $3)",
        [record.dataset_kind, record.geometry_id, support.evidenceRefId],
      );
    }

    return { geometryId: record.geometry_id, outcome: "created" };
  }
}

function parseGeometryRecord(input: unknown): GeometryRecord {
  const record = exactRecord(input, TOP_LEVEL_KEYS, "Geometry");
  if (record.schema_version !== "2.0") invalidInput("schema_version must be 2.0");
  if (record.record_type !== "Geometry") invalidInput("record_type must be Geometry");

  const datasetKind = enumValue(
    record.dataset_kind,
    ["live", "historical", "synthetic"],
    "dataset_kind",
  );
  const traceId = idValue(record.trace_id, "trace_id");
  const geometryId = idValue(record.geometry_id, "geometry_id");
  const role = enumValue(
    record.role,
    [
      "incident_scene", "affected_area", "warning_boundary", "route_segment", "service_stop",
      "facility", "venue", "service_area", "approximate_place",
    ],
    "role",
  );
  if (record.coordinate_reference_system !== "OGC:CRS84") {
    invalidInput("coordinate_reference_system must be OGC:CRS84");
  }

  let precisionM: number | null;
  if (record.precision_m === null) {
    precisionM = null;
  } else if (
    typeof record.precision_m === "number"
    && Number.isFinite(record.precision_m)
    && record.precision_m >= 0
    && record.precision_m <= 10_000_000
  ) {
    precisionM = record.precision_m;
  } else {
    invalidInput("precision_m must be null or a finite number between 0 and 10000000");
  }

  const precisionBasis = enumValue(
    record.precision_basis,
    ["source_supplied", "provider_accuracy", "gazetteer_match", "moderator_generalization", "unknown"],
    "precision_basis",
  );
  let displayLabel: string | null;
  if (record.display_label === null) {
    displayLabel = null;
  } else if (typeof record.display_label === "string" && codePointLength(record.display_label) <= 200
    && codePointLength(record.display_label) >= 1) {
    displayLabel = record.display_label;
  } else {
    invalidInput("display_label must be null or a string of 1 to 200 Unicode code points");
  }

  const counter: CoordinateCounter = { positions: 0 };
  const geojson = parseGeoJSON(record.geojson, counter);
  if (!roleAcceptsGeometry(role, geojson.type)) {
    invalidInput("role " + role + " does not allow GeoJSON " + geojson.type);
  }
  const sourceEvidence = parseSupportingEvidence(record.source_evidence);

  return {
    schema_version: "2.0",
    trace_id: traceId,
    record_type: "Geometry",
    dataset_kind: datasetKind,
    geometry_id: geometryId,
    role,
    geojson,
    coordinate_reference_system: "OGC:CRS84",
    precision_m: precisionM,
    precision_basis: precisionBasis,
    display_label: displayLabel,
    source_evidence: sourceEvidence,
  };
}

function parseGeoJSON(value: unknown, counter: CoordinateCounter): GeoJSONGeometry {
  const geometry = exactRecord(value, ["type", "coordinates"], "geojson");
  const type = geometry.type;

  if (type === "Point") {
    return { type, coordinates: parsePosition(geometry.coordinates, counter, "geojson.coordinates") };
  }
  if (type === "LineString") {
    return { type, coordinates: parseLine(geometry.coordinates, counter, "geojson.coordinates") };
  }
  if (type === "Polygon") {
    return { type, coordinates: parsePolygon(geometry.coordinates, counter, "geojson.coordinates") };
  }
  if (type === "MultiPoint") {
    const positions = arrayValue(geometry.coordinates, 1, MAX_GEOMETRY_POSITIONS, "geojson.coordinates");
    return {
      type,
      coordinates: positions.map((position, index) =>
        parsePosition(position, counter, "geojson.coordinates[" + index + "]")),
    };
  }
  if (type === "MultiLineString") {
    const lines = arrayValue(geometry.coordinates, 1, MAX_GEOMETRY_POSITIONS, "geojson.coordinates");
    return {
      type,
      coordinates: lines.map((line, index) => parseLine(line, counter, "geojson.coordinates[" + index + "]")),
    };
  }
  if (type === "MultiPolygon") {
    const polygons = arrayValue(geometry.coordinates, 1, MAX_GEOMETRY_POSITIONS, "geojson.coordinates");
    return {
      type,
      coordinates: polygons.map((polygon, index) =>
        parsePolygon(polygon, counter, "geojson.coordinates[" + index + "]")),
    };
  }

  invalidInput("geojson.type must be Point, LineString, Polygon, MultiPoint, MultiLineString, or MultiPolygon");
}

function parsePosition(value: unknown, counter: CoordinateCounter, label: string): GeoPosition {
  const position = arrayValue(value, 2, 2, label);
  const longitude = position[0];
  const latitude = position[1];
  if (typeof longitude !== "number" || !Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
    invalidInput(label + " longitude must be a finite number between -180 and 180");
  }
  if (typeof latitude !== "number" || !Number.isFinite(latitude) || latitude < -90 || latitude > 90) {
    invalidInput(label + " latitude must be a finite number between -90 and 90");
  }
  counter.positions += 1;
  if (counter.positions > MAX_GEOMETRY_POSITIONS) {
    invalidInput("geojson exceeds the maximum of " + MAX_GEOMETRY_POSITIONS + " coordinate positions");
  }
  return [longitude, latitude];
}

function parseLine(value: unknown, counter: CoordinateCounter, label: string): readonly GeoPosition[] {
  const positions = arrayValue(value, 2, MAX_GEOMETRY_POSITIONS, label);
  return positions.map((position, index) =>
    parsePosition(position, counter, label + "[" + index + "]"));
}

function parseRing(value: unknown, counter: CoordinateCounter, label: string): readonly GeoPosition[] {
  const positions = arrayValue(value, 4, MAX_GEOMETRY_POSITIONS, label);
  const ring = positions.map((position, index) =>
    parsePosition(position, counter, label + "[" + index + "]"));
  const first = ring[0]!;
  const last = ring[ring.length - 1]!;
  if (first[0] !== last[0] || first[1] !== last[1]) {
    invalidInput(label + " must be closed with its first position repeated at the end");
  }
  return ring;
}

function parsePolygon(
  value: unknown,
  counter: CoordinateCounter,
  label: string,
): readonly (readonly GeoPosition[])[] {
  const rings = arrayValue(value, 1, MAX_GEOMETRY_POSITIONS, label);
  return rings.map((ring, index) => parseRing(ring, counter, label + "[" + index + "]"));
}

function parseSupportingEvidence(value: unknown): readonly GeometrySupportEvidenceRef[] {
  const references = arrayValue(value, 1, MAX_SUPPORT_REFERENCES, "source_evidence");
  const seen = new Set<string>();
  return references.map((value, index) => {
    const reference = exactRecord(value, SUPPORT_KEYS, "source_evidence[" + index + "]");
    const parsed: GeometrySupportEvidenceRef = {
      report_revision_id: idValue(reference.report_revision_id, "source_evidence[" + index + "].report_revision_id"),
      permitted_text_hash: hashValue(reference.permitted_text_hash, "source_evidence[" + index + "].permitted_text_hash"),
      span_start: integerValue(reference.span_start, 0, 10_000_000, "source_evidence[" + index + "].span_start"),
      span_end: integerValue(reference.span_end, 1, 10_000_000, "source_evidence[" + index + "].span_end"),
      offset_unit: reference.offset_unit === "unicode_code_points"
        ? "unicode_code_points"
        : invalidInput("source_evidence[" + index + "].offset_unit must be unicode_code_points"),
      relation: reference.relation === "supports"
        ? "supports"
        : invalidInput("source_evidence[" + index + "].relation must be supports"),
    };
    if (parsed.span_end <= parsed.span_start) {
      invalidInput("source_evidence[" + index + "] must have a non-empty span");
    }
    const key = canonicalJson(parsed);
    if (seen.has(key)) invalidInput("source_evidence must contain unique references");
    seen.add(key);
    return parsed;
  });
}

async function assertPostgisTopology(transaction: SqlExecutor, geoJson: string): Promise<void> {
  const result = await transaction.query<{ is_valid: boolean }>(
    "SELECT ST_IsValid(ST_SetSRID(ST_GeomFromGeoJSON($1::text), 4326)) AS is_valid",
    [geoJson],
  );
  if (result.rows[0]?.is_valid !== true) {
    throw new GeometryWriteError("geometry_input_invalid", "GeoJSON geometry has invalid PostGIS topology");
  }
}

async function resolveSupportingEvidence(
  transaction: SqlExecutor,
  record: GeometryRecord,
): Promise<readonly ResolvedSupport[]> {
  const resolved: ResolvedSupport[] = [];
  for (const reference of record.source_evidence) {
    const result = await transaction.query<SupportEvidenceRow>(
      [
        "SELECT reference.evidence_ref_id::text AS evidence_ref_id,",
        "       revision.permitted_text, revision.permitted_text_hash",
        "FROM waspada.evidence_references AS reference",
        "JOIN waspada.report_revisions AS revision",
        "  ON revision.dataset_kind = reference.dataset_kind",
        " AND revision.report_revision_id = reference.report_revision_id",
        " AND revision.permitted_text_hash = reference.permitted_text_hash",
        "WHERE reference.dataset_kind = $1",
        "  AND reference.report_revision_id = $2",
        "  AND reference.permitted_text_hash = $3",
        "  AND reference.span_start = $4",
        "  AND reference.span_end = $5",
        "  AND reference.offset_unit = $6",
        "  AND reference.relation = $7",
        "LIMIT 2",
      ].join("\n"),
      [
        record.dataset_kind,
        reference.report_revision_id,
        reference.permitted_text_hash,
        reference.span_start,
        reference.span_end,
        reference.offset_unit,
        reference.relation,
      ],
    );
    if (result.rows.length === 0) {
      throw new GeometryWriteError(
        "geometry_support_invalid",
        "source_evidence reference is not a persisted supports reference in the geometry dataset",
      );
    }
    if (result.rows.length !== 1) {
      throw new GeometryWriteError(
        "geometry_support_invalid",
        "source_evidence reference resolves to more than one persisted evidence reference",
      );
    }
    const row = result.rows[0]!;
    if (sha256(row.permitted_text) !== row.permitted_text_hash
      || row.permitted_text_hash !== reference.permitted_text_hash) {
      throw new GeometryWriteError(
        "geometry_support_invalid",
        "source_evidence hash does not match the immutable report revision text",
      );
    }
    if (reference.span_end > codePointLength(row.permitted_text)) {
      throw new GeometryWriteError(
        "geometry_support_invalid",
        "source_evidence offsets exceed the Unicode code-point length of the immutable report text",
      );
    }
    resolved.push({ evidenceRefId: row.evidence_ref_id });
  }
  return resolved;
}

async function findExistingGeometry(
  transaction: SqlExecutor,
  record: GeometryRecord,
  recordJson: string,
  geoJson: string,
): Promise<ExistingGeometryRow | null> {
  const result = await transaction.query<ExistingGeometryRow>(
    [
      "SELECT trace_id, role, coordinate_reference_system, precision_m, precision_basis, display_label,",
      "       record_json = $3::jsonb AS record_matches,",
      "       ST_AsEWKB(shape) = ST_AsEWKB(ST_SetSRID(ST_GeomFromGeoJSON($4::text), 4326)) AS shape_matches",
      "FROM waspada.geometries",
      "WHERE dataset_kind = $1 AND geometry_id = $2",
    ].join("\n"),
    [record.dataset_kind, record.geometry_id, recordJson, geoJson],
  );
  return result.rows[0] ?? null;
}

async function compareExistingGeometry(
  transaction: SqlExecutor,
  record: GeometryRecord,
  supports: readonly ResolvedSupport[],
  existing: ExistingGeometryRow,
): Promise<GeometryWriteResult> {
  const typedColumnsMatch = existing.trace_id === record.trace_id
    && existing.role === record.role
    && existing.coordinate_reference_system === record.coordinate_reference_system
    && existing.precision_m === record.precision_m
    && existing.precision_basis === record.precision_basis
    && existing.display_label === record.display_label;
  if (!typedColumnsMatch || existing.record_matches !== true || existing.shape_matches !== true) {
    throw geometryConflict(record.geometry_id);
  }

  const links = await transaction.query<{ evidence_ref_id: string }>(
    [
      "SELECT evidence_ref_id::text AS evidence_ref_id",
      "FROM waspada.geometry_evidence",
      "WHERE dataset_kind = $1 AND geometry_id = $2",
    ].join("\n"),
    [record.dataset_kind, record.geometry_id],
  );
  const expected = new Set(supports.map(({ evidenceRefId }) => evidenceRefId));
  const actual = new Set(links.rows.map(({ evidence_ref_id }) => evidence_ref_id));
  if (actual.size !== links.rows.length || actual.size !== expected.size
    || [...expected].some((evidenceRefId) => !actual.has(evidenceRefId))) {
    throw geometryConflict(record.geometry_id);
  }
  return { geometryId: record.geometry_id, outcome: "already_exists" };
}

function exactRecord(value: unknown, allowedKeys: readonly string[], label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    invalidInput(label + " must be an object");
  }
  const record = value as Record<string, unknown>;
  const allowed = new Set(allowedKeys);
  for (const key of Reflect.ownKeys(record)) {
    if (typeof key !== "string" || !allowed.has(key)) invalidInput(label + " contains an unsupported field");
  }
  for (const key of allowedKeys) {
    if (!Object.prototype.hasOwnProperty.call(record, key)) invalidInput(label + " is missing " + key);
  }
  return record;
}

function arrayValue(value: unknown, minimum: number, maximum: number, label: string): unknown[] {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) {
    invalidInput(label + " must be an array with " + minimum + " to " + maximum + " items");
  }
  for (const key of Reflect.ownKeys(value)) {
    if (key === "length") continue;
    if (typeof key !== "string" || !/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length) {
      invalidInput(label + " contains an unsupported array property");
    }
  }
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.prototype.hasOwnProperty.call(value, index)) invalidInput(label + " must not contain sparse items");
  }
  return value;
}

function enumValue<const Values extends readonly string[]>(
  value: unknown,
  options: Values,
  label: string,
): Values[number] {
  if (typeof value !== "string" || !options.includes(value)) {
    invalidInput(label + " has an unsupported value");
  }
  return value as Values[number];
}

function idValue(value: unknown, label: string): string {
  if (typeof value !== "string" || !ID_PATTERN.test(value)) {
    invalidInput(label + " must be a schema 2.0 ID of 1 to 128 characters");
  }
  return value;
}

function hashValue(value: unknown, label: string): string {
  if (typeof value !== "string" || !HASH_PATTERN.test(value)) {
    invalidInput(label + " must be a lowercase SHA-256 hash");
  }
  return value;
}

function integerValue(value: unknown, minimum: number, maximum: number, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < minimum || value > maximum) {
    invalidInput(label + " must be an integer between " + minimum + " and " + maximum);
  }
  return value;
}

function roleAcceptsGeometry(role: GeometryRole, type: GeoJSONGeometry["type"]): boolean {
  if (POINT_ROLES.has(role)) return type === "Point" || type === "MultiPoint";
  if (LINE_ROLES.has(role)) return type === "LineString" || type === "MultiLineString";
  if (AREA_ROLES.has(role)) return type === "Polygon" || type === "MultiPolygon";
  return false;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right));
    return "{" + entries.map(([key, entry]) => JSON.stringify(key) + ":" + canonicalJson(entry)).join(",") + "}";
  }
  return JSON.stringify(value);
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function codePointLength(value: string): number {
  return Array.from(value).length;
}

function geometryConflict(geometryId: string): GeometryWriteError {
  return new GeometryWriteError(
    "geometry_conflict",
    "Geometry ID already exists with different record or support links: " + geometryId,
  );
}

function invalidInput(message: string): never {
  throw new GeometryWriteError("geometry_input_invalid", message);
}

function isUniqueViolation(error: unknown, constraint: string): boolean {
  return error !== null && typeof error === "object"
    && "code" in error && (error as { code?: unknown }).code === "23505"
    && "constraint" in error && (error as { constraint?: unknown }).constraint === constraint;
}
