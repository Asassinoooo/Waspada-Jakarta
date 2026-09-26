import assert from "node:assert/strict";
import test from "node:test";
import type { EventDetail, PublicFeatureCollection } from "../src/contracts/public-api.js";
import { PublicProjectionError } from "../src/layers/l4-application-integration/public-projection.js";
import {
  projectPublicEventDetail,
  projectPublicFeatureCollection,
  PublicGeometryProjectionError,
  type PublicGeometryProjectionErrorCode,
} from "../src/layers/l4-application-integration/public-geometry-projection.js";
import type { PublicProjectionLookups } from "../src/layers/l4-application-integration/public-projection.js";

/**
 * These authored live-shaped records are synthetic-only. They are not actual
 * reports, publications, source permissions, factual validation, or live data.
 */
const syntheticHash = "a".repeat(64);
const geometryIds = [
  "geometry-synthetic-point",
  "geometry-synthetic-line",
  "geometry-synthetic-polygon",
];

function makeEvent(
  eventId = "event-synthetic-geometry-01",
  referencedGeometryIds: readonly string[] = geometryIds,
  claimGeometryIds: readonly string[] = referencedGeometryIds,
): Record<string, unknown> {
  return {
    schema_version: "2.0",
    trace_id: "trace-synthetic-event-private-marker",
    record_type: "Event",
    dataset_kind: "live",
    event_id: eventId,
    version: 1,
    supersedes_version: null,
    title: "Synthetic geometry projection event",
    summary: "An authored live-shaped fixture for the public geometry projector.",
    category: "transport_road_incidents",
    tags: [],
    lifecycle: "ongoing",
    freshness: {
      status: "current",
      evaluated_at: "2026-09-26T03:00:00Z",
      review_due_at: null,
      basis: "manual_review",
    },
    event_time: { start: null, end: null, precision: "unknown" },
    validity: { valid_from: null, valid_until: null },
    scope: {
      place_ids: ["place-synthetic-jakarta"],
      service_ids: [],
      institution_ids: [],
      audience_ids: [],
      geometry_ids: [...referencedGeometryIds],
    },
    claims: [
      {
        claim_id: "claim-synthetic-geometry-01",
        text: "Synthetic supported claim for the geometry projection test.",
        event_time: { start: null, end: null, precision: "unknown" },
        validity: { valid_from: null, valid_until: null },
        scope: {
          place_ids: ["place-synthetic-jakarta"],
          service_ids: [],
          institution_ids: [],
          audience_ids: [],
          geometry_ids: [...claimGeometryIds],
        },
        qualifiers: [],
        support: [
          {
            report_revision_id: "revision-synthetic-private-marker",
            permitted_text_hash: syntheticHash,
            span_start: 2,
            span_end: 19,
            offset_unit: "unicode_code_points",
            relation: "supports",
          },
        ],
        contradictions: [],
        context_evidence: [],
        origin_ids: ["origin-synthetic-private-marker"],
        evidence_label: "attributed_report",
      },
    ],
    impact_refs: [],
    publication_status: "published",
    withdrawal_reason: null,
    publication_decision_id: "decision-synthetic-private-marker",
    published_at: "2026-09-26T03:01:00Z",
    withdrawn_at: null,
    private_event_note: "PRIVATE_EVENT_STORAGE_MARKER",
  };
}

function makeLookups(): PublicProjectionLookups {
  return {
    scopeNames: [
      {
        entity_type: "place",
        id: "place-synthetic-jakarta",
        display_name: "Synthetic Jakarta place",
        private_scope_note: "PRIVATE_SCOPE_LOOKUP_MARKER",
      },
    ],
    publicAttributions: [
      {
        dataset_kind: "live",
        report_revision_id: "revision-synthetic-private-marker",
        permitted_text_hash: syntheticHash,
        span_start: 2,
        span_end: 19,
        offset_unit: "unicode_code_points",
        relation: "supports",
        public_use_approved: true,
        display_name: "Synthetic test source",
        url: "https://source.example.invalid/synthetic-record",
        published_at: "2026-09-26T02:50:00Z",
        observed_at: null,
        excerpt_public_use_approved: false,
        excerpt: null,
        permitted_text: "PRIVATE_SOURCE_TEXT_MARKER",
      },
    ],
    impacts: [],
  };
}

function makeGeometry(
  geometryId: string,
  role: string,
  geojson: unknown,
): Record<string, unknown> {
  return {
    schema_version: "2.0",
    trace_id: `trace-${geometryId}-private-marker`,
    record_type: "Geometry",
    dataset_kind: "live",
    geometry_id: geometryId,
    role,
    geojson,
    coordinate_reference_system: "OGC:CRS84",
    precision_m: 25,
    precision_basis: "source_supplied",
    display_label: `Synthetic label ${geometryId}`,
    source_evidence: [
      {
        report_revision_id: "revision-synthetic-private-marker",
        permitted_text_hash: syntheticHash,
        span_start: 2,
        span_end: 19,
        offset_unit: "unicode_code_points",
        relation: "supports",
      },
    ],
    private_geometry_note: "PRIVATE_GEOMETRY_STORAGE_MARKER",
  };
}

function makeValidGeometries(): Record<string, unknown>[] {
  return [
    makeGeometry(geometryIds[0]!, "incident_scene", { type: "Point", coordinates: [106.8123, -6.2011] }),
    makeGeometry(geometryIds[1]!, "route_segment", {
      type: "LineString",
      coordinates: [[106.8, -6.2], [106.81, -6.21], [106.82, -6.22]],
    }),
    makeGeometry(geometryIds[2]!, "warning_boundary", {
      type: "Polygon",
      coordinates: [[[106.8, -6.2], [106.81, -6.2], [106.81, -6.21], [106.8, -6.2]]],
    }),
  ];
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function assertExactKeys(value: unknown, expected: readonly string[]): void {
  assert.ok(value !== null && typeof value === "object");
  assert.deepEqual(Object.keys(value as object).sort(), [...expected].sort());
}

function assertGeometryError(action: () => unknown, code: PublicGeometryProjectionErrorCode): void {
  assert.throws(action, (error: unknown) => {
    assert.ok(error instanceof PublicGeometryProjectionError);
    assert.equal(error.code, code);
    assert.equal(error.message.includes("PRIVATE"), false);
    return true;
  });
}

function assertEventError(action: () => unknown, code: string): void {
  assert.throws(action, (error: unknown) => {
    assert.ok(error instanceof PublicProjectionError);
    assert.equal(error.code, code);
    assert.equal(error.message.includes("PRIVATE"), false);
    return true;
  });
}

const openApiKeys = {
  eventDetail: ["event_id", "version", "title", "summary", "category", "tags", "lifecycle", "freshness", "event_time", "validity", "scope", "claims", "impacts", "published_at", "geometries"],
  publicGeometry: ["geometry_id", "role", "geometry", "precision_m", "label"],
  geoJSONGeometry: ["type", "coordinates"],
  scope: ["places", "services", "institutions", "audiences"],
  claim: ["claim_id", "text", "event_time", "validity", "scope", "qualifiers", "evidence_label", "sources"],
  source: ["display_name", "url", "published_at", "observed_at", "excerpt"],
  freshness: ["status", "evaluated_at", "review_due_at", "basis"],
  timeScope: ["start", "end", "precision"],
  validity: ["valid_from", "valid_until"],
  featureCollection: ["type", "features"],
  feature: ["type", "id", "geometry", "properties"],
  featureProperties: ["event_id", "version", "title", "category", "lifecycle", "freshness", "geometry_role"],
};

test("projects exact supported Point, LineString, and Polygon allowlists without changing coordinates", () => {
  const geometries = makeValidGeometries();
  const detail = projectPublicEventDetail(makeEvent(), makeLookups(), geometries);
  const serialized = JSON.stringify(detail);

  assertExactKeys(detail, openApiKeys.eventDetail);
  assert.equal(detail.event_id, "event-synthetic-geometry-01");
  assertExactKeys(detail.scope, openApiKeys.scope);
  assertExactKeys(detail.freshness, openApiKeys.freshness);
  assertExactKeys(detail.event_time, openApiKeys.timeScope);
  assertExactKeys(detail.validity, openApiKeys.validity);
  assert.deepEqual(detail.geometries.map((geometry) => geometry.geometry_id), [...geometryIds].sort());
  for (const claim of detail.claims) {
    assertExactKeys(claim, openApiKeys.claim);
    assertExactKeys(claim.event_time, openApiKeys.timeScope);
    assertExactKeys(claim.validity, openApiKeys.validity);
    assertExactKeys(claim.scope, openApiKeys.scope);
    for (const source of claim.sources) assertExactKeys(source, openApiKeys.source);
  }
  for (const geometry of detail.geometries) {
    assertExactKeys(geometry, openApiKeys.publicGeometry);
    assertExactKeys(geometry.geometry, openApiKeys.geoJSONGeometry);
  }
  assert.deepEqual(detail.geometries.find((geometry) => geometry.geometry_id === geometryIds[0])?.geometry, {
    type: "Point",
    coordinates: [106.8123, -6.2011],
  });
  assert.deepEqual(detail.geometries.find((geometry) => geometry.geometry_id === geometryIds[1])?.geometry, {
    type: "LineString",
    coordinates: [[106.8, -6.2], [106.81, -6.21], [106.82, -6.22]],
  });
  assert.deepEqual(detail.geometries.find((geometry) => geometry.geometry_id === geometryIds[2])?.geometry, {
    type: "Polygon",
    coordinates: [[[106.8, -6.2], [106.81, -6.2], [106.81, -6.21], [106.8, -6.2]]],
  });
  for (const marker of [
    "trace-synthetic-event-private-marker",
    "trace-geometry-synthetic-point-private-marker",
    "revision-synthetic-private-marker",
    syntheticHash,
    "PRIVATE_EVENT_STORAGE_MARKER",
    "PRIVATE_GEOMETRY_STORAGE_MARKER",
    "PRIVATE_SOURCE_TEXT_MARKER",
    "precision_basis",
    "source_evidence",
  ]) assert.equal(serialized.includes(marker), false, `public detail must omit ${marker}`);
});

test("requires exact geometry ID coverage and a referencing claim with an exact supports reference", () => {
  const event = makeEvent();
  const geometries = makeValidGeometries();
  assertGeometryError(
    () => projectPublicEventDetail(event, makeLookups(), geometries.slice(1)),
    "GEOMETRY_RESOLUTION_FAILED",
  );

  const duplicate = [geometries[0], geometries[1], clone(geometries[0]!)];
  assertGeometryError(
    () => projectPublicEventDetail(event, makeLookups(), duplicate),
    "GEOMETRY_RESOLUTION_FAILED",
  );

  const unreferenced = clone(geometries);
  (unreferenced[2] as Record<string, unknown>).geometry_id = "geometry-synthetic-unreferenced";
  assertGeometryError(
    () => projectPublicEventDetail(event, makeLookups(), unreferenced),
    "GEOMETRY_RESOLUTION_FAILED",
  );

  const wrongDataset = clone(geometries);
  (wrongDataset[0] as Record<string, unknown>).dataset_kind = "synthetic";
  assertGeometryError(
    () => projectPublicEventDetail(event, makeLookups(), wrongDataset),
    "GEOMETRY_RESOLUTION_FAILED",
  );

  assertGeometryError(
    () => projectPublicEventDetail(makeEvent("event-synthetic-geometry-01", geometryIds, []), makeLookups(), geometries),
    "GEOMETRY_RESOLUTION_FAILED",
  );

  for (const mutate of [
    (reference: Record<string, unknown>) => { reference.report_revision_id = "revision-synthetic-other"; },
    (reference: Record<string, unknown>) => { reference.permitted_text_hash = "b".repeat(64); },
    (reference: Record<string, unknown>) => { reference.span_start = 3; },
    (reference: Record<string, unknown>) => { reference.span_end = 20; },
  ]) {
    const changed = clone(geometries);
    const record = changed[0] as Record<string, unknown>;
    mutate((record.source_evidence as Array<Record<string, unknown>>)[0]!);
    assertGeometryError(
      () => projectPublicEventDetail(event, makeLookups(), changed),
      "GEOMETRY_RESOLUTION_FAILED",
    );
  }

  for (const mutate of [
    (reference: Record<string, unknown>) => { reference.offset_unit = "utf16"; },
    (reference: Record<string, unknown>) => { reference.relation = "contradicts"; },
  ]) {
    const changed = clone(geometries);
    const record = changed[0] as Record<string, unknown>;
    mutate((record.source_evidence as Array<Record<string, unknown>>)[0]!);
    assertGeometryError(
      () => projectPublicEventDetail(event, makeLookups(), changed),
      "INVALID_GEOMETRY",
    );
  }
});

test("non-live, withdrawn, and malformed events fail at the accepted event projection boundary", () => {
  for (const datasetKind of ["historical", "synthetic"]) {
    const event = makeEvent();
    event.dataset_kind = datasetKind;
    assertEventError(
      () => projectPublicEventDetail(event, makeLookups(), makeValidGeometries()),
      "EVENT_NOT_PUBLIC",
    );
  }

  const withdrawn = makeEvent();
  withdrawn.publication_status = "withdrawn";
  assertEventError(
    () => projectPublicEventDetail(withdrawn, makeLookups(), makeValidGeometries()),
    "EVENT_NOT_PUBLIC",
  );

  const malformed = makeEvent();
  malformed.version = 0;
  assertEventError(
    () => projectPublicEventDetail(malformed, makeLookups(), makeValidGeometries()),
    "INVALID_EVENT",
  );
});

test("accepts each GeoJSON geometry kind defined by schema 2.0", () => {
  const geometries = [
    makeGeometry(geometryIds[0]!, "incident_scene", {
      type: "MultiPoint",
      coordinates: [[106.8, -6.2], [106.81, -6.21]],
    }),
    makeGeometry(geometryIds[1]!, "route_segment", {
      type: "MultiLineString",
      coordinates: [[[106.8, -6.2], [106.81, -6.21]]],
    }),
    makeGeometry(geometryIds[2]!, "affected_area", {
      type: "MultiPolygon",
      coordinates: [[[[106.8, -6.2], [106.81, -6.2], [106.81, -6.21], [106.8, -6.2]]]],
    }),
  ];
  const detail = projectPublicEventDetail(makeEvent(), makeLookups(), geometries);
  assert.deepEqual(detail.geometries.map((geometry) => geometry.geometry.type), [
    "MultiLineString", "MultiPoint", "MultiPolygon",
  ]);
});

test("validates schema 2.0 geometry metadata, CRS84, roles, precision, labels, and GeoJSON structure", () => {
  const mutations: Array<(geometry: Record<string, unknown>) => void> = [
    (geometry) => { geometry.schema_version = "1.0"; },
    (geometry) => { geometry.record_type = "Event"; },
    (geometry) => { geometry.geometry_id = "bad id!"; },
    (geometry) => { geometry.role = "unrecognized_role"; },
    (geometry) => { geometry.coordinate_reference_system = "EPSG:4326"; },
    (geometry) => { geometry.precision_basis = "not-a-basis"; },
    (geometry) => { geometry.precision_m = Number.NaN; },
    (geometry) => { geometry.precision_m = -1; },
    (geometry) => { geometry.precision_m = 10_000_001; },
    (geometry) => { geometry.display_label = ""; },
    (geometry) => { geometry.display_label = "x".repeat(201); },
    (geometry) => { geometry.geojson = { type: "GeometryCollection", geometries: [] }; },
    (geometry) => { geometry.geojson = { type: "Point", coordinates: [106.8, -6.2, 15] }; },
    (geometry) => { geometry.geojson = { type: "Point", coordinates: [181, -6.2] }; },
    (geometry) => { geometry.geojson = { type: "Point", coordinates: [106.8, -91] }; },
    (geometry) => { geometry.geojson = { type: "Point", coordinates: [Infinity, -6.2] }; },
    (geometry) => { geometry.geojson = { type: "Point", coordinates: [106.8] }; },
    (geometry) => { geometry.geojson = { type: "Point", coordinates: [106.8, -6.2], bbox: [1, 2] }; },
    (geometry) => { geometry.geojson = { type: "LineString", coordinates: [[106.8, -6.2]] }; },
    (geometry) => { geometry.geojson = { type: "Polygon", coordinates: [[[106.8, -6.2], [106.81, -6.2], [106.8, -6.2]]] }; },
    (geometry) => { geometry.geojson = { type: "Polygon", coordinates: [[[106.8, -6.2], [106.81, -6.2], [106.81, -6.21], [106.82, -6.22]]] }; },
    (geometry) => { geometry.role = "route_segment"; },
  ];

  for (const mutate of mutations) {
    const geometries = makeValidGeometries();
    mutate(geometries[0]!);
    assertGeometryError(
      () => projectPublicEventDetail(makeEvent(), makeLookups(), geometries),
      "INVALID_GEOMETRY",
    );
  }

  const oversized = makeValidGeometries();
  (oversized[0] as Record<string, unknown>).geojson = {
    type: "MultiPoint",
    coordinates: Array.from({ length: 10_001 }, () => [106.8, -6.2]),
  };
  (oversized[0] as Record<string, unknown>).role = "incident_scene";
  assertGeometryError(
    () => projectPublicEventDetail(makeEvent(), makeLookups(), oversized),
    "INVALID_GEOMETRY",
  );

  const tooManyReferences = makeEvent(
    "event-synthetic-too-many-geometries",
    Array.from({ length: 501 }, (_, index) => `geometry-synthetic-${index}`),
  );
  assertGeometryError(
    () => projectPublicEventDetail(tooManyReferences, makeLookups(), []),
    "GEOMETRY_LIMIT_EXCEEDED",
  );
});

test("builds an exact, stable FeatureCollection from projected details and enforces 500 features", () => {
  const alpha = projectPublicEventDetail(makeEvent("event-synthetic-alpha", [geometryIds[0]!]), makeLookups(), [
    makeGeometry(geometryIds[0]!, "incident_scene", { type: "Point", coordinates: [106.8, -6.2] }),
  ]);
  const beta = projectPublicEventDetail(makeEvent("event-synthetic-beta", [geometryIds[1]!]), makeLookups(), [
    makeGeometry(geometryIds[1]!, "route_segment", { type: "LineString", coordinates: [[106.8, -6.2], [106.9, -6.3]] }),
  ]);

  const collection = projectPublicFeatureCollection([beta, alpha]);
  const reordered = projectPublicFeatureCollection([alpha, beta]);
  assert.deepEqual(collection, reordered);
  assertExactKeys(collection, openApiKeys.featureCollection);
  assert.equal(collection.type, "FeatureCollection");
  assert.deepEqual(collection.features.map((feature) => feature.properties.event_id), [
    "event-synthetic-alpha",
    "event-synthetic-beta",
  ]);
  for (const feature of collection.features) {
    assertExactKeys(feature, openApiKeys.feature);
    assertExactKeys(feature.geometry, openApiKeys.geoJSONGeometry);
    assertExactKeys(feature.properties, openApiKeys.featureProperties);
    assert.equal(feature.id, JSON.stringify([feature.properties.event_id, feature.properties.version, feature.properties.event_id === "event-synthetic-alpha" ? geometryIds[0] : geometryIds[1]]));
  }

  const single = collection.features[0]!;
  const repeated: EventDetail[] = Array.from({ length: 500 }, (_, index) => {
    const copy = clone(alpha) as EventDetail;
    copy.event_id = `event-synthetic-${index.toString().padStart(3, "0")}`;
    return copy;
  });
  assert.equal(projectPublicFeatureCollection(repeated).features.length, 500);
  repeated.push(clone(alpha));
  assertGeometryError(() => projectPublicFeatureCollection(repeated), "GEOMETRY_LIMIT_EXCEEDED");
  assert.ok(single.id.length > 0);
  const withExtraPrivateDetail = { ...alpha, private_detail_marker: "PRIVATE" } as EventDetail;
  assert.equal(JSON.stringify(projectPublicFeatureCollection([withExtraPrivateDetail])).includes("PRIVATE"), false);
});

test("bounds aggregate coordinate work across an entire FeatureCollection", () => {
  const firstIds = Array.from({ length: 6 }, (_, index) => `geometry-synthetic-aggregate-a-${index}`);
  const secondIds = Array.from({ length: 5 }, (_, index) => `geometry-synthetic-aggregate-b-${index}`);
  const makePointGeometries = (ids: readonly string[]) => ids.map((id) => makeGeometry(id, "incident_scene", {
    type: "MultiPoint",
    coordinates: Array.from({ length: 10_000 }, () => [106.8, -6.2]),
  }));
  const first = projectPublicEventDetail(
    makeEvent("event-synthetic-aggregate-a", firstIds),
    makeLookups(),
    makePointGeometries(firstIds),
  );
  const second = projectPublicEventDetail(
    makeEvent("event-synthetic-aggregate-b", secondIds),
    makeLookups(),
    makePointGeometries(secondIds),
  );
  assertGeometryError(
    () => projectPublicFeatureCollection([first, second]),
    "GEOMETRY_LIMIT_EXCEEDED",
  );
});

test("an event with no geometry produces an empty detail and empty feature collection", () => {
  const detail = projectPublicEventDetail(makeEvent("event-synthetic-no-geometry", [], []), makeLookups(), []);
  assert.deepEqual(detail.geometries, []);
  const collection: PublicFeatureCollection = projectPublicFeatureCollection([detail]);
  assert.deepEqual(collection, { type: "FeatureCollection", features: [] });
});
