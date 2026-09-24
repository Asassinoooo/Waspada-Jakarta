import assert from "node:assert/strict";
import test from "node:test";
import {
  PETABENCANA_GEOJSON_LIMITS,
  parsePetabencanaGeoJson,
  type PetabencanaParseResult,
} from "../src/layers/l1-data-knowledge/petabencana-geojson.js";

// Synthetic test fixtures only: no provider content and no claim about a current incident.
// `pkey`, `status`, and `report_type` are provisional field-name assumptions; no
// non-empty provider payload has verified them. Only `created_at` is documented.
const SYNTHETIC_FIXTURE_LABEL = "SYNTHETIC TEST ONLY — not a PetaBencana report";
const SYNTHETIC_RETRIEVED_AT = "2001-02-03T10:00:00+07:00";
const SYNTHETIC_OBSERVED_AT = "2001-02-03T09:45:00+07:00";

interface SyntheticFeatureOptions {
  readonly id?: string | number;
  readonly pkey?: string | number | null;
  readonly status?: unknown;
  readonly report_type?: unknown;
  readonly created_at?: unknown;
  readonly includeCreatedAt?: boolean;
  readonly geometry?: unknown;
}

function syntheticFeature(options: SyntheticFeatureOptions = {}): Record<string, unknown> {
  const properties: Record<string, unknown> = {
    fixture_label: SYNTHETIC_FIXTURE_LABEL,
  };
  if (options.pkey !== undefined) properties.pkey = options.pkey;
  if (options.status !== undefined) properties.status = options.status;
  if (options.report_type !== undefined) properties.report_type = options.report_type;
  if (options.includeCreatedAt === true) properties.created_at = options.created_at;

  const feature: Record<string, unknown> = {
    type: "Feature",
    properties,
    geometry: options.geometry === undefined ? null : options.geometry,
  };
  if (options.id !== undefined) feature.id = options.id;
  return feature;
}

function syntheticCollection(features: readonly unknown[]): string {
  return JSON.stringify({ type: "FeatureCollection", features });
}

function errorResult(result: PetabencanaParseResult): Extract<PetabencanaParseResult, { kind: "error" }> {
  assert.equal(result.kind, "error");
  if (result.kind !== "error") throw new Error("expected parser error result");
  return result;
}

test("an empty synthetic FeatureCollection is a valid empty result with retrieval time", () => {
  const result = parsePetabencanaGeoJson(
    syntheticCollection([]),
    SYNTHETIC_RETRIEVED_AT,
  );

  assert.deepEqual(result, {
    kind: "empty",
    retrievedAt: SYNTHETIC_RETRIEVED_AT,
    reports: [],
  });
  // `empty` describes this response only; the parser does not emit an all-clear status.
  assert.equal("allClear" in result, false);
});

test("multiple synthetic reports preserve explicit fields and all supported source geometry", () => {
  const point = { type: "Point", coordinates: [0, 0] };
  const multipoint = { type: "MultiPoint", coordinates: [[1, 2], [3, 4, 5]] };
  const line = { type: "LineString", coordinates: [[0, 0], [1, 1]] };
  const multiline = { type: "MultiLineString", coordinates: [[[0, 0], [1, 1]], [[2, 2], [3, 3]]] };
  const polygon = {
    type: "Polygon",
    coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]],
  };
  const multipolygon = {
    type: "MultiPolygon",
    coordinates: [[[[0, 0], [1, 0], [1, 1], [0, 0]]]],
  };
  const geometries = [point, multipoint, line, multiline, polygon, multipolygon];
  const features = geometries.map((geometry, index) => syntheticFeature({
    pkey: `synthetic-feature-${index + 1}`,
    status: "fixture-only",
    report_type: "test-only",
    created_at: SYNTHETIC_OBSERVED_AT,
    includeCreatedAt: true,
    geometry,
  }));

  const result = parsePetabencanaGeoJson(syntheticCollection(features), SYNTHETIC_RETRIEVED_AT);

  assert.equal(result.kind, "records");
  if (result.kind !== "records") return;
  assert.equal(result.retrievedAt, SYNTHETIC_RETRIEVED_AT);
  assert.equal(result.reports.length, geometries.length);
  result.reports.forEach((report, index) => {
    assert.equal(report.featureId, `synthetic-feature-${index + 1}`);
    assert.equal(report.providerStatus, "fixture-only");
    assert.equal(report.reportType, "test-only");
    assert.equal(report.observedAt, SYNTHETIC_OBSERVED_AT);
    assert.equal(report.observedAtState, "valid");
    assert.equal(report.retrievedAt, SYNTHETIC_RETRIEVED_AT);
    assert.deepEqual(report.geometry, geometries[index]);
  });
});

test("missing and invalid created_at remain unknown instead of using retrieval time", () => {
  const result = parsePetabencanaGeoJson(
    syntheticCollection([
      syntheticFeature(),
      syntheticFeature({ created_at: "2001-02-30T09:45:00+07:00", includeCreatedAt: true }),
    ]),
    SYNTHETIC_RETRIEVED_AT,
  );

  assert.equal(result.kind, "records");
  if (result.kind !== "records") return;
  assert.deepEqual(result.reports.map(({ observedAt, observedAtState }) => ({ observedAt, observedAtState })), [
    { observedAt: null, observedAtState: "missing" },
    { observedAt: null, observedAtState: "invalid" },
  ]);
  assert.ok(result.reports.every((report) => report.retrievedAt === SYNTHETIC_RETRIEVED_AT));
});

test("source time and caller-supplied retrieval time remain distinct", () => {
  const result = parsePetabencanaGeoJson(
    syntheticCollection([syntheticFeature({
      created_at: SYNTHETIC_OBSERVED_AT,
      includeCreatedAt: true,
    })]),
    SYNTHETIC_RETRIEVED_AT,
  );

  assert.equal(result.kind, "records");
  if (result.kind !== "records") return;
  assert.equal(result.reports[0]?.observedAt, SYNTHETIC_OBSERVED_AT);
  assert.equal(result.reports[0]?.retrievedAt, SYNTHETIC_RETRIEVED_AT);
});

test("invalid coordinates reject the entire collection with a bounded error detail", () => {
  const payload = syntheticCollection([
    syntheticFeature({ id: "synthetic-valid-point", geometry: { type: "Point", coordinates: [0, 0] } }),
    syntheticFeature({ id: "synthetic-invalid-point", geometry: { type: "Point", coordinates: [181, 91] } }),
  ]);
  const result = errorResult(parsePetabencanaGeoJson(payload, SYNTHETIC_RETRIEVED_AT));

  assert.deepEqual(result.error, {
    kind: "malformed",
    code: "invalid_geometry",
    featureIndex: 1,
  });
  assert.equal(JSON.stringify(result).includes(payload), false);
});

test("duplicate explicit feature IDs are rejected and absent IDs remain absent", () => {
  const duplicateResult = errorResult(parsePetabencanaGeoJson(
    syntheticCollection([
      syntheticFeature({ id: "synthetic-duplicate" }),
      syntheticFeature({ pkey: "synthetic-duplicate" }),
    ]),
    SYNTHETIC_RETRIEVED_AT,
  ));
  assert.deepEqual(duplicateResult.error, {
    kind: "malformed",
    code: "duplicate_feature_id",
    featureIndex: 1,
  });

  const absentResult = parsePetabencanaGeoJson(
    syntheticCollection([syntheticFeature(), syntheticFeature()]),
    SYNTHETIC_RETRIEVED_AT,
  );
  assert.equal(absentResult.kind, "records");
  if (absentResult.kind === "records") {
    assert.deepEqual(absentResult.reports.map(({ featureId }) => featureId), [null, null]);
  }
});

test("conflicting feature id and provider key are rejected without choosing one", () => {
  const result = errorResult(parsePetabencanaGeoJson(
    syntheticCollection([syntheticFeature({ id: "synthetic-geojson-id", pkey: "synthetic-provider-key" })]),
    SYNTHETIC_RETRIEVED_AT,
  ));
  assert.equal(result.error.code, "conflicting_feature_ids");
});

test("unsafe numeric IDs are rejected instead of being rounded by JSON parsing", () => {
  const payload = `{"type":"FeatureCollection","features":[{"type":"Feature","id":9007199254740993,"properties":{"fixture_label":"${SYNTHETIC_FIXTURE_LABEL}"},"geometry":null}]}`;
  const result = errorResult(parsePetabencanaGeoJson(payload, SYNTHETIC_RETRIEVED_AT));
  assert.equal(result.error.code, "invalid_feature_id");
});

test("unsupported root and geometry types are identified without echoing input", () => {
  const wrongRoot = JSON.stringify({ type: "Feature", geometry: null, properties: null });
  const rootResult = errorResult(parsePetabencanaGeoJson(wrongRoot, SYNTHETIC_RETRIEVED_AT));
  assert.equal(rootResult.error.code, "unsupported_root_type");

  const unsupportedGeometry = syntheticCollection([
    syntheticFeature({ geometry: { type: "GeometryCollection", geometries: [] } }),
  ]);
  const geometryResult = errorResult(parsePetabencanaGeoJson(unsupportedGeometry, SYNTHETIC_RETRIEVED_AT));
  assert.equal(geometryResult.error.kind, "unsupported");
  assert.equal(geometryResult.error.code, "unsupported_geometry_type");
  assert.equal(JSON.stringify(geometryResult).includes(unsupportedGeometry), false);
});

test("malformed JSON, oversized JSON, and excessive nesting fail deterministically", () => {
  assert.equal(
    errorResult(parsePetabencanaGeoJson("{\"type\":", SYNTHETIC_RETRIEVED_AT)).error.code,
    "invalid_json",
  );
  assert.equal(
    errorResult(parsePetabencanaGeoJson(" ".repeat(PETABENCANA_GEOJSON_LIMITS.maxInputBytes + 1), SYNTHETIC_RETRIEVED_AT)).error.code,
    "input_too_large",
  );
  const nestedPayload = `${"[".repeat(PETABENCANA_GEOJSON_LIMITS.maxNestingDepth + 1)}${"]".repeat(PETABENCANA_GEOJSON_LIMITS.maxNestingDepth + 1)}`;
  assert.equal(
    errorResult(parsePetabencanaGeoJson(nestedPayload, SYNTHETIC_RETRIEVED_AT)).error.code,
    "nesting_limit_exceeded",
  );
});

test("feature and coordinate work are bounded", () => {
  const tooManyFeatures = Array.from(
    { length: PETABENCANA_GEOJSON_LIMITS.maxFeatures + 1 },
    () => syntheticFeature(),
  );
  assert.equal(
    errorResult(parsePetabencanaGeoJson(syntheticCollection(tooManyFeatures), SYNTHETIC_RETRIEVED_AT)).error.code,
    "feature_limit_exceeded",
  );

  const tooManyPositions = Array.from(
    { length: PETABENCANA_GEOJSON_LIMITS.maxCoordinatePositions + 1 },
    () => [0, 0],
  );
  const result = errorResult(parsePetabencanaGeoJson(
    syntheticCollection([syntheticFeature({ geometry: { type: "MultiPoint", coordinates: tooManyPositions } })]),
    SYNTHETIC_RETRIEVED_AT,
  ));
  assert.equal(result.error.kind, "unsupported");
  assert.equal(result.error.code, "coordinate_limit_exceeded");
});

test("invalid caller retrieval time is rejected before parsing records", () => {
  const result = errorResult(parsePetabencanaGeoJson(
    syntheticCollection([syntheticFeature()]),
    "2001-02-30T10:00:00+07:00",
  ));
  assert.equal(result.error.code, "invalid_retrieved_at");
});
