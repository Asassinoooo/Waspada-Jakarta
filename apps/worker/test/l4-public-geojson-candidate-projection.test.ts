import assert from "node:assert/strict";
import test from "node:test";
import {
  projectPublicGeoJSONCandidateCollection,
  PublicGeometryProjectionError,
} from "../src/layers/l4-application-integration/public-geometry-projection.js";
import { PublicProjectionError } from "../src/layers/l4-application-integration/public-projection.js";

const syntheticHash = "a".repeat(64);
const secondSyntheticHash = "b".repeat(64);
const privateMarkers = [
  "trace-synthetic-event-private",
  "trace-synthetic-geometry-private",
  "revision-synthetic-private",
  syntheticHash,
  secondSyntheticHash,
  "PRIVATE_EVENT_MARKER",
  "PRIVATE_GEOMETRY_MARKER",
  "PRIVATE_SCOPE_MARKER",
  "PRIVATE_SOURCE_TEXT_MARKER",
  "precision_basis",
  "source_evidence",
  "geometryRecordJson",
  "eventRecordJson",
];

function makeEvent(
  eventId = "event-synthetic-geojson-01",
  geometryIds: readonly string[] = ["geometry-synthetic-a"],
  claimGeometryIds: readonly string[] = geometryIds,
  version = 1,
): Record<string, unknown> {
  return {
    schema_version: "2.0",
    trace_id: "trace-synthetic-event-private",
    record_type: "Event",
    dataset_kind: "live",
    event_id: eventId,
    version,
    supersedes_version: version === 1 ? null : version - 1,
    title: "Synthetic GeoJSON candidate event",
    summary: "An authored live-shaped fixture for strict GeoJSON candidate projection.",
    category: "transport_road_incidents",
    tags: [],
    lifecycle: "ongoing",
    freshness: {
      status: "current",
      evaluated_at: "2026-09-27T03:00:00Z",
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
      geometry_ids: [...geometryIds],
    },
    claims: [
      {
        claim_id: "claim-synthetic-geojson-01",
        text: "Synthetic supported claim for the GeoJSON projection test.",
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
            report_revision_id: "revision-synthetic-private",
            permitted_text_hash: syntheticHash,
            span_start: 2,
            span_end: 19,
            offset_unit: "unicode_code_points",
            relation: "supports",
          },
        ],
        contradictions: [],
        context_evidence: [],
        origin_ids: ["origin-synthetic-private"],
        evidence_label: "attributed_report",
      },
    ],
    impact_refs: [],
    publication_status: "published",
    withdrawal_reason: null,
    publication_decision_id: "decision-synthetic-private",
    published_at: "2026-09-27T03:01:00Z",
    withdrawn_at: null,
    private_event_note: "PRIVATE_EVENT_MARKER",
  };
}

function makeAttribution(hash = syntheticHash): Record<string, unknown> {
  return {
    dataset_kind: "live",
    report_revision_id: "revision-synthetic-private",
    permitted_text_hash: hash,
    span_start: 2,
    span_end: 19,
    offset_unit: "unicode_code_points",
    relation: "supports",
    public_use_approved: true,
    display_name: "Synthetic test source",
    url: "https://source.example.invalid/synthetic-record",
    published_at: "2026-09-27T02:50:00Z",
    observed_at: null,
    excerpt_public_use_approved: false,
    excerpt: null,
    permitted_text: "PRIVATE_SOURCE_TEXT_MARKER",
  };
}

function makeLookups(): {
  scopeNames: Record<string, unknown>[];
  publicAttributions: Record<string, unknown>[];
  impacts: Record<string, unknown>[];
} {
  return {
    scopeNames: [
      {
        entity_type: "place",
        id: "place-synthetic-jakarta",
        display_name: "Synthetic Jakarta place",
        private_scope_note: "PRIVATE_SCOPE_MARKER",
      },
    ],
    publicAttributions: [makeAttribution()],
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
    trace_id: "trace-synthetic-geometry-private",
    record_type: "Geometry",
    dataset_kind: "live",
    geometry_id: geometryId,
    role,
    geojson,
    coordinate_reference_system: "OGC:CRS84",
    precision_m: 25,
    precision_basis: "source_supplied",
    display_label: "Synthetic geometry label",
    source_evidence: [
      {
        report_revision_id: "revision-synthetic-private",
        permitted_text_hash: syntheticHash,
        span_start: 2,
        span_end: 19,
        offset_unit: "unicode_code_points",
        relation: "supports",
      },
    ],
    private_geometry_note: "PRIVATE_GEOMETRY_MARKER",
  };
}

function makeCandidate(event: Record<string, unknown>, geometry: Record<string, unknown>): Record<string, unknown> {
  const freshness = event.freshness as Record<string, unknown>;
  return {
    datasetKind: "live",
    eventId: event.event_id,
    eventVersion: event.version,
    category: event.category,
    lifecycle: event.lifecycle,
    freshness: freshness.status,
    geometryId: geometry.geometry_id,
    eventRecordJson: event,
    geometryRecordJson: geometry,
  };
}

function makeBatch(
  event: Record<string, unknown>,
  lookups = makeLookups(),
): Record<string, unknown> {
  return {
    eventId: event.event_id,
    eventVersion: event.version,
    scopeNames: lookups.scopeNames,
    publicAttributions: lookups.publicAttributions,
    impacts: lookups.impacts,
  };
}

function makeEnvelope(
  candidates: readonly unknown[],
  lookupBatches: readonly unknown[] = [],
): Record<string, unknown> {
  return { candidates, lookupBatches };
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function assertFailure(action: () => unknown, code: string): void {
  assert.throws(action, (error: unknown) => {
    assert.ok(error instanceof PublicGeometryProjectionError || error instanceof PublicProjectionError);
    assert.equal(error.code, code);
    assert.equal(error.message.includes("PRIVATE"), false);
    assert.equal(error.message.includes(syntheticHash), false);
    return true;
  });
}

function makeImpact(event: Record<string, unknown>): Record<string, unknown> {
  return {
    schema_version: "2.0",
    trace_id: "trace-synthetic-impact-private",
    record_type: "Impact",
    dataset_kind: "live",
    impact_id: "impact-synthetic-geojson",
    version: 1,
    event_id: event.event_id,
    event_version: event.version,
    impact_type: "road_closure",
    title: "Synthetic road closure",
    description: "A fictional impact record for a projection check.",
    lifecycle: "ongoing",
    freshness: {
      status: "current",
      evaluated_at: "2026-09-27T03:00:00Z",
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
      geometry_ids: [],
    },
    published_at: "2026-09-27T03:01:00Z",
    supporting_claim_ids: ["claim-synthetic-geojson-01"],
  };
}

const openApiKeys = {
  collection: ["type", "features"],
  feature: ["type", "id", "geometry", "properties"],
  geometry: ["type", "coordinates"],
  properties: ["event_id", "version", "title", "category", "lifecycle", "freshness", "geometry_role"],
};

function assertExactKeys(value: unknown, expected: readonly string[]): void {
  assert.ok(value !== null && typeof value === "object");
  assert.deepEqual(Object.keys(value as object).sort(), [...expected].sort());
}

test("projects only selected point, line, and polygon candidates with stable allowlists and exact coordinates", () => {
  const ids = [
    "geometry-synthetic-a",
    "geometry-synthetic-b",
    "geometry-synthetic-c",
    "geometry-synthetic-outside-viewport",
  ];
  const event = makeEvent("event-synthetic-geojson-01", ids);
  const point = makeGeometry(ids[0]!, "incident_scene", {
    type: "Point",
    coordinates: [106.812345, -6.201234],
  });
  const line = makeGeometry(ids[1]!, "route_segment", {
    type: "LineString",
    coordinates: [[106.8, -6.2], [106.81, -6.21]],
  });
  const polygon = makeGeometry(ids[2]!, "warning_boundary", {
    type: "Polygon",
    coordinates: [[[106.8, -6.2], [106.81, -6.2], [106.81, -6.21], [106.8, -6.2]]],
  });
  const candidates = [
    makeCandidate(clone(event), polygon),
    makeCandidate(clone(event), line),
    makeCandidate(clone(event), point),
  ];
  const result = projectPublicGeoJSONCandidateCollection(makeEnvelope(candidates, [makeBatch(event)]));

  assertExactKeys(result, openApiKeys.collection);
  assert.equal(result.type, "FeatureCollection");
  assert.deepEqual(result.features.map((feature) => feature.id), [
    JSON.stringify([event.event_id, 1, ids[0]]),
    JSON.stringify([event.event_id, 1, ids[1]]),
    JSON.stringify([event.event_id, 1, ids[2]]),
  ]);
  assert.deepEqual(result.features.map((feature) => feature.geometry), [
    { type: "Point", coordinates: [106.812345, -6.201234] },
    { type: "LineString", coordinates: [[106.8, -6.2], [106.81, -6.21]] },
    { type: "Polygon", coordinates: [[[106.8, -6.2], [106.81, -6.2], [106.81, -6.21], [106.8, -6.2]]] },
  ]);
  for (const feature of result.features) {
    assertExactKeys(feature, openApiKeys.feature);
    assertExactKeys(feature.geometry, openApiKeys.geometry);
    assertExactKeys(feature.properties, openApiKeys.properties);
    assert.equal(feature.properties.event_id, event.event_id);
    assert.equal(feature.properties.version, 1);
  }
  const serialized = JSON.stringify(result);
  for (const marker of privateMarkers) assert.equal(serialized.includes(marker), false, marker);
  assert.equal(serialized.includes("Synthetic test source"), false);
  assert.equal(serialized.includes("Synthetic Jakarta place"), false);
  assert.equal(result.features.length, 3);
});

test("accepts a viewport-selected subset without requiring out-of-viewport geometry rows", () => {
  const selectedId = "geometry-synthetic-selected";
  const unselectedId = "geometry-synthetic-unselected";
  const event = makeEvent("event-synthetic-subset", [selectedId, unselectedId]);
  const selected = makeGeometry(selectedId, "incident_scene", {
    type: "Point",
    coordinates: [106.8, -6.2],
  });
  const result = projectPublicGeoJSONCandidateCollection(makeEnvelope(
    [makeCandidate(event, selected)],
    [makeBatch(event)],
  ));

  assert.equal(result.features.length, 1);
  assert.equal(result.features[0]?.properties.event_id, event.event_id);
  assert.deepEqual(result.features[0]?.geometry, { type: "Point", coordinates: [106.8, -6.2] });
});

test("requires a selected geometry to be scoped and supported by the same published claim", () => {
  const geometryId = "geometry-synthetic-claim-link";
  const eventOnlyLink = makeEvent("event-synthetic-event-only-link", [geometryId], []);
  const geometry = makeGeometry(geometryId, "incident_scene", {
    type: "Point",
    coordinates: [106.8, -6.2],
  });
  assertFailure(
    () => projectPublicGeoJSONCandidateCollection(makeEnvelope(
      [makeCandidate(eventOnlyLink, geometry)],
      [makeBatch(eventOnlyLink)],
    )),
    "GEOMETRY_RESOLUTION_FAILED",
  );

  const twoClaims = makeEvent("event-synthetic-same-claim", [geometryId], [geometryId]);
  const claims = twoClaims.claims as Array<Record<string, unknown>>;
  const firstClaim = claims[0]!;
  const firstSupport = (firstClaim.support as Array<Record<string, unknown>>)[0]!;
  firstSupport.permitted_text_hash = secondSyntheticHash;
  const secondClaim = clone(firstClaim);
  secondClaim.claim_id = "claim-synthetic-second";
  (secondClaim.scope as Record<string, unknown>).geometry_ids = [];
  ((secondClaim.support as Array<Record<string, unknown>>)[0]!).permitted_text_hash = syntheticHash;
  claims.push(secondClaim);
  const lookups = makeLookups();
  lookups.publicAttributions.push(makeAttribution(secondSyntheticHash));
  assertFailure(
    () => projectPublicGeoJSONCandidateCollection(makeEnvelope(
      [makeCandidate(twoClaims, geometry)],
      [makeBatch(twoClaims, lookups)],
    )),
    "GEOMETRY_RESOLUTION_FAILED",
  );
});

test("matches complete support references and rejects altered span, revision, hash, unit, or relation", () => {
  const event = makeEvent();
  const geometry = makeGeometry("geometry-synthetic-support", "incident_scene", {
    type: "Point",
    coordinates: [106.8, -6.2],
  });
  for (const field of ["report_revision_id", "permitted_text_hash", "span_start", "span_end"] as const) {
    const changed = clone(geometry);
    const reference = (changed.source_evidence as Array<Record<string, unknown>>)[0]!;
    if (field === "report_revision_id") reference[field] = "revision-synthetic-other";
    if (field === "permitted_text_hash") reference[field] = secondSyntheticHash;
    if (field === "span_start") reference[field] = 3;
    if (field === "span_end") reference[field] = 20;
    assertFailure(
      () => projectPublicGeoJSONCandidateCollection(makeEnvelope(
        [makeCandidate(event, changed)],
        [makeBatch(event)],
      )),
      "GEOMETRY_RESOLUTION_FAILED",
    );
  }

  for (const [field, value] of [
    ["offset_unit", "utf16"],
    ["relation", "contradicts"],
  ] as const) {
    const changed = clone(geometry);
    (changed.source_evidence as Array<Record<string, unknown>>)[0]![field] = value;
    assertFailure(
      () => projectPublicGeoJSONCandidateCollection(makeEnvelope(
        [makeCandidate(event, changed)],
        [makeBatch(event)],
      )),
      "INVALID_GEOMETRY",
    );
  }
});

test("rejects malformed candidate identity, duplicates, inconsistent Event JSON, stale versions, and unused batches", () => {
  const event = makeEvent();
  const geometry = makeGeometry("geometry-synthetic-identity", "incident_scene", {
    type: "Point",
    coordinates: [106.8, -6.2],
  });
  const candidate = makeCandidate(event, geometry);

  const duplicate = clone(candidate);
  assertFailure(
    () => projectPublicGeoJSONCandidateCollection(makeEnvelope(
      [candidate, duplicate],
      [makeBatch(event)],
    )),
    "GEOMETRY_RESOLUTION_FAILED",
  );

  const changedEvent = clone(event);
  changedEvent.private_event_note = "different";
  assertFailure(
    () => projectPublicGeoJSONCandidateCollection(makeEnvelope(
      [candidate, makeCandidate(changedEvent, clone(geometry))],
      [makeBatch(event)],
    )),
    "GEOMETRY_RESOLUTION_FAILED",
  );

  const wrongCategory = clone(candidate);
  wrongCategory.category = "crime_personal_security";
  assertFailure(
    () => projectPublicGeoJSONCandidateCollection(makeEnvelope([wrongCategory], [makeBatch(event)])),
    "INVALID_GEOJSON_CANDIDATES",
  );

  assertFailure(
    () => projectPublicGeoJSONCandidateCollection(makeEnvelope([candidate], [])),
    "GEOMETRY_RESOLUTION_FAILED",
  );
  assertFailure(
    () => projectPublicGeoJSONCandidateCollection(makeEnvelope(
      [candidate],
      [makeBatch(event), makeBatch(makeEvent("event-synthetic-unused"))],
    )),
    "GEOMETRY_RESOLUTION_FAILED",
  );

  const wrongVersion = clone(candidate);
  wrongVersion.eventVersion = 2;
  assertFailure(
    () => projectPublicGeoJSONCandidateCollection(makeEnvelope([wrongVersion], [makeBatch(event)])),
    "INVALID_GEOJSON_CANDIDATES",
  );

  const oldVersionEvent = makeEvent("event-synthetic-stale-version", ["geometry-synthetic-old"], ["geometry-synthetic-old"], 1);
  const currentVersionEvent = makeEvent("event-synthetic-stale-version", ["geometry-synthetic-current"], ["geometry-synthetic-current"], 2);
  const currentGeometry = makeGeometry("geometry-synthetic-current", "incident_scene", {
    type: "Point",
    coordinates: [106.8, -6.2],
  });
  assertFailure(
    () => projectPublicGeoJSONCandidateCollection(makeEnvelope(
      [
        makeCandidate(oldVersionEvent, makeGeometry("geometry-synthetic-old", "incident_scene", {
          type: "Point",
          coordinates: [106.8, -6.2],
        })),
        makeCandidate(currentVersionEvent, currentGeometry),
      ],
      [makeBatch(oldVersionEvent), makeBatch(currentVersionEvent)],
    )),
    "GEOMETRY_RESOLUTION_FAILED",
  );
});

test("rejects missing, duplicate, extraneous, malformed, and unreviewed lookup values", () => {
  const event = makeEvent();
  const geometry = makeGeometry("geometry-synthetic-lookups", "incident_scene", {
    type: "Point",
    coordinates: [106.8, -6.2],
  });
  const candidate = makeCandidate(event, geometry);

  const missingName = makeLookups();
  missingName.scopeNames = [];
  assertFailure(
    () => projectPublicGeoJSONCandidateCollection(makeEnvelope([candidate], [makeBatch(event, missingName)])),
    "GEOMETRY_RESOLUTION_FAILED",
  );

  const duplicateName = makeLookups();
  duplicateName.scopeNames.push(clone(duplicateName.scopeNames[0]!));
  assertFailure(
    () => projectPublicGeoJSONCandidateCollection(makeEnvelope([candidate], [makeBatch(event, duplicateName)])),
    "GEOMETRY_RESOLUTION_FAILED",
  );

  const extraName = makeLookups();
  extraName.scopeNames.push({
    entity_type: "place",
    id: "place-synthetic-unused",
    display_name: "Unused place",
  });
  assertFailure(
    () => projectPublicGeoJSONCandidateCollection(makeEnvelope([candidate], [makeBatch(event, extraName)])),
    "GEOMETRY_RESOLUTION_FAILED",
  );

  const malformedName = makeLookups();
  malformedName.scopeNames[0]!.display_name = "";
  assertFailure(
    () => projectPublicGeoJSONCandidateCollection(makeEnvelope([candidate], [makeBatch(event, malformedName)])),
    "NAME_LOOKUP_FAILED",
  );

  const missingAttribution = makeLookups();
  missingAttribution.publicAttributions = [];
  assertFailure(
    () => projectPublicGeoJSONCandidateCollection(makeEnvelope([candidate], [makeBatch(event, missingAttribution)])),
    "ATTRIBUTION_FAILED",
  );

  const duplicateAttribution = makeLookups();
  duplicateAttribution.publicAttributions.push(clone(duplicateAttribution.publicAttributions[0]!));
  assertFailure(
    () => projectPublicGeoJSONCandidateCollection(makeEnvelope([candidate], [makeBatch(event, duplicateAttribution)])),
    "ATTRIBUTION_FAILED",
  );

  const extraAttribution = makeLookups();
  extraAttribution.publicAttributions.push(makeAttribution(secondSyntheticHash));
  assertFailure(
    () => projectPublicGeoJSONCandidateCollection(makeEnvelope([candidate], [makeBatch(event, extraAttribution)])),
    "GEOMETRY_RESOLUTION_FAILED",
  );

  const unreviewedAttribution = makeLookups();
  unreviewedAttribution.publicAttributions[0]!.public_use_approved = false;
  assertFailure(
    () => projectPublicGeoJSONCandidateCollection(makeEnvelope([candidate], [makeBatch(event, unreviewedAttribution)])),
    "ATTRIBUTION_FAILED",
  );

  const wrongVersionBatch = makeBatch(event);
  wrongVersionBatch.eventVersion = 2;
  assertFailure(
    () => projectPublicGeoJSONCandidateCollection(makeEnvelope([candidate], [wrongVersionBatch])),
    "GEOMETRY_RESOLUTION_FAILED",
  );
});

test("validates exact impact records in each event-version lookup batch", () => {
  const event = makeEvent("event-synthetic-impact", ["geometry-synthetic-impact"]);
  event.impact_refs = [{ impact_id: "impact-synthetic-geojson", version: 1 }];
  const impact = makeImpact(event);
  const geometry = makeGeometry("geometry-synthetic-impact", "incident_scene", {
    type: "Point",
    coordinates: [106.8, -6.2],
  });
  const lookups = makeLookups();
  lookups.impacts = [impact];
  const result = projectPublicGeoJSONCandidateCollection(makeEnvelope(
    [makeCandidate(event, geometry)],
    [makeBatch(event, lookups)],
  ));
  assert.equal(result.features.length, 1);

  const missing = makeLookups();
  assertFailure(
    () => projectPublicGeoJSONCandidateCollection(makeEnvelope(
      [makeCandidate(event, geometry)],
      [makeBatch(event, missing)],
    )),
    "IMPACT_RESOLUTION_FAILED",
  );

  const extra = makeLookups();
  extra.impacts = [makeImpact(makeEvent("event-synthetic-other"))];
  assertFailure(
    () => projectPublicGeoJSONCandidateCollection(makeEnvelope(
      [makeCandidate(event, geometry)],
      [makeBatch(event, extra)],
    )),
    "IMPACT_RESOLUTION_FAILED",
  );
});

test("rejects non-live, withdrawn, stale, and malformed geometry candidates without fallback", () => {
  const event = makeEvent("event-synthetic-withdrawn", ["geometry-synthetic-withdrawn"]);
  event.version = 2;
  event.supersedes_version = 1;
  event.publication_status = "withdrawn";
  event.withdrawal_reason = "withdrawn";
  event.withdrawn_at = "2026-09-27T03:02:00Z";
  const geometry = makeGeometry("geometry-synthetic-withdrawn", "incident_scene", {
    type: "Point",
    coordinates: [106.8, -6.2],
  });
  assertFailure(
    () => projectPublicGeoJSONCandidateCollection(makeEnvelope(
      [makeCandidate(event, geometry)],
      [makeBatch(event)],
    )),
    "EVENT_NOT_PUBLIC",
  );

  const nonLive = makeEvent("event-synthetic-nonlive", ["geometry-synthetic-nonlive"]);
  nonLive.dataset_kind = "historical";
  assertFailure(
    () => projectPublicGeoJSONCandidateCollection(makeEnvelope(
      [makeCandidate(nonLive, makeGeometry("geometry-synthetic-nonlive", "incident_scene", {
        type: "Point",
        coordinates: [106.8, -6.2],
      }))],
      [makeBatch(nonLive)],
    )),
    "INVALID_GEOJSON_CANDIDATES",
  );

  for (const mutate of [
    (value: Record<string, unknown>) => { value.coordinate_reference_system = "EPSG:4326"; },
    (value: Record<string, unknown>) => { value.role = "unknown"; },
    (value: Record<string, unknown>) => { value.geojson = { type: "Point", coordinates: [181, -6.2] }; },
    (value: Record<string, unknown>) => { value.precision_m = -1; },
  ]) {
    const changed = makeGeometry("geometry-synthetic-malformed", "incident_scene", {
      type: "Point",
      coordinates: [106.8, -6.2],
    });
    mutate(changed);
    const malformedEvent = makeEvent("event-synthetic-malformed", ["geometry-synthetic-malformed"]);
    assertFailure(
      () => projectPublicGeoJSONCandidateCollection(makeEnvelope(
        [makeCandidate(malformedEvent, changed)],
        [makeBatch(malformedEvent)],
      )),
      "INVALID_GEOMETRY",
    );
  }

  const nonLiveGeometryEvent = makeEvent("event-synthetic-nonlive-geometry", ["geometry-synthetic-nonlive-geometry"]);
  const nonLiveGeometry = makeGeometry("geometry-synthetic-nonlive-geometry", "incident_scene", {
    type: "Point",
    coordinates: [106.8, -6.2],
  });
  nonLiveGeometry.dataset_kind = "synthetic";
  assertFailure(
    () => projectPublicGeoJSONCandidateCollection(makeEnvelope(
      [makeCandidate(nonLiveGeometryEvent, nonLiveGeometry)],
      [makeBatch(nonLiveGeometryEvent)],
    )),
    "GEOMETRY_RESOLUTION_FAILED",
  );

  const oversized = makeGeometry("geometry-synthetic-oversized", "incident_scene", {
    type: "MultiPoint",
    coordinates: Array.from({ length: 10_001 }, () => [106.8, -6.2]),
  });
  const oversizedEvent = makeEvent("event-synthetic-oversized", ["geometry-synthetic-oversized"]);
  assertFailure(
    () => projectPublicGeoJSONCandidateCollection(makeEnvelope(
      [makeCandidate(oversizedEvent, oversized)],
      [makeBatch(oversizedEvent)],
    )),
    "INVALID_GEOMETRY",
  );
});

test("bounds candidate and lookup work before projection, and returns the exact empty collection", () => {
  assert.deepEqual(
    projectPublicGeoJSONCandidateCollection(makeEnvelope([], [])),
    { type: "FeatureCollection", features: [] },
  );
  assertFailure(
    () => projectPublicGeoJSONCandidateCollection(makeEnvelope([], [makeBatch(makeEvent())])),
    "INVALID_GEOJSON_CANDIDATES",
  );

  assertFailure(
    () => projectPublicGeoJSONCandidateCollection(makeEnvelope(
      Array.from({ length: 501 }, () => ({})),
      [],
    )),
    "GEOMETRY_LIMIT_EXCEEDED",
  );

  const event = makeEvent();
  const candidate = makeCandidate(event, makeGeometry("geometry-synthetic-bounds", "incident_scene", {
    type: "Point",
    coordinates: [106.8, -6.2],
  }));
  const oversizedLookup = makeBatch(event);
  oversizedLookup.scopeNames = Array.from({ length: 501 }, () => ({}));
  assertFailure(
    () => projectPublicGeoJSONCandidateCollection(makeEnvelope([candidate], [oversizedLookup])),
    "GEOMETRY_LIMIT_EXCEEDED",
  );

  const tooManyTagsEvent = makeEvent();
  tooManyTagsEvent.tags = Array.from({ length: 501 }, () => ({ namespace: "topic", value: "notice" }));
  const tooManyTagsCandidate = makeCandidate(tooManyTagsEvent, makeGeometry(
    "geometry-synthetic-too-many-tags",
    "incident_scene",
    { type: "Point", coordinates: [106.8, -6.2] },
  ));
  assertFailure(
    () => projectPublicGeoJSONCandidateCollection(makeEnvelope(
      [tooManyTagsCandidate],
      [makeBatch(tooManyTagsEvent)],
    )),
    "GEOMETRY_LIMIT_EXCEEDED",
  );
});

test("accepts 500 selected features and rejects the 501st before inspecting candidate rows", () => {
  const ids = Array.from({ length: 500 }, (_, index) => "geometry-synthetic-limit-" + String(index).padStart(3, "0"));
  const event = makeEvent("event-synthetic-limit", ids);
  const candidates = ids.map((id, index) => makeCandidate(
    index % 2 === 0 ? event : clone(event),
    makeGeometry(id, "incident_scene", { type: "Point", coordinates: [106.8, -6.2] }),
  ));
  const result = projectPublicGeoJSONCandidateCollection(makeEnvelope(candidates, [makeBatch(event)]));
  assert.equal(result.features.length, 500);

  assertFailure(
    () => projectPublicGeoJSONCandidateCollection(makeEnvelope(
      [...candidates, {}],
      [makeBatch(event)],
    )),
    "GEOMETRY_LIMIT_EXCEEDED",
  );
});