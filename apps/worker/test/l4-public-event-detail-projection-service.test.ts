import assert from "node:assert/strict";
import test from "node:test";
import {
  createPublicEventDetailProjectionService,
  PublicEventDetailProjectionServiceError,
  type PublicEventDetailGeometry,
} from "../src/layers/l4-application-integration/public-event-detail-projection-service.js";
import type {
  PublicEventProjectionLookupQuery,
  PublicEventProjectionLookupResult,
  PublicEventProjectionSnapshotReadResult,
} from "../src/layers/l4-application-integration/public-event-projection-service.js";

/**
 * All values in this file are authored fictional, live-shaped fixtures. They
 * establish service boundaries only; they do not assert a real publication,
 * source permission, source content, factual support, or live data.
 */
const eventId = "event-synthetic-detail-01";
const eventVersion = 3;
const impactId = "impact-synthetic-detail-01";
const impactVersion = 2;
const revisionId = "revision-synthetic-detail-01";
const supportHash = "a".repeat(64);
const eventGeometryId = "geometry-synthetic-event-01";
const claimGeometryId = "geometry-synthetic-claim-01";
const impactGeometryId = "geometry-synthetic-impact-01";

type RecordValue = Record<string, unknown>;

function makeScope(
  values: {
    place_ids?: readonly string[];
    service_ids?: readonly string[];
    institution_ids?: readonly string[];
    audience_ids?: readonly string[];
    geometry_ids?: readonly unknown[];
  } = {},
): RecordValue {
  return {
    place_ids: [...(values.place_ids ?? [])],
    service_ids: [...(values.service_ids ?? [])],
    institution_ids: [...(values.institution_ids ?? [])],
    audience_ids: [...(values.audience_ids ?? [])],
    geometry_ids: [...(values.geometry_ids ?? [])],
    private_scope_marker: "PRIVATE_SCOPE_MARKER",
  };
}

function makeSupportReference(overrides: RecordValue = {}): RecordValue {
  return {
    report_revision_id: revisionId,
    permitted_text_hash: supportHash,
    span_start: 1,
    span_end: 12,
    offset_unit: "unicode_code_points",
    relation: "supports",
    private_support_marker: "PRIVATE_SUPPORT_MARKER",
    ...overrides,
  };
}

function makeEvent(
  eventGeometryIds: readonly unknown[] = [eventGeometryId],
  claimGeometryIds: readonly unknown[] = [claimGeometryId, eventGeometryId],
): RecordValue {
  return {
    schema_version: "2.0",
    trace_id: "trace-synthetic-detail-private",
    record_type: "Event",
    dataset_kind: "live",
    event_id: eventId,
    version: eventVersion,
    supersedes_version: eventVersion - 1,
    title: "Synthetic event detail",
    summary: "An authored fictional record for the EventDetail service.",
    category: "transport_road_incidents",
    tags: [{ namespace: "topic", value: "synthetic_notice", private_tag_marker: "PRIVATE_TAG_MARKER" }],
    lifecycle: "ongoing",
    freshness: {
      status: "current",
      evaluated_at: "2026-09-26T03:00:00Z",
      review_due_at: null,
      basis: "manual_review",
    },
    event_time: { start: null, end: null, precision: "unknown" },
    validity: { valid_from: null, valid_until: null },
    scope: makeScope({
      place_ids: ["place-synthetic-event"],
      geometry_ids: eventGeometryIds,
    }),
    claims: [{
      claim_id: "claim-synthetic-detail-01",
      text: "Synthetic claim whose support is represented by a fictional source span.",
      event_time: { start: null, end: null, precision: "unknown" },
      validity: { valid_from: null, valid_until: null },
      scope: makeScope({
        service_ids: ["service-synthetic-claim"],
        geometry_ids: claimGeometryIds,
      }),
      qualifiers: [],
      support: [makeSupportReference()],
      contradictions: [],
      context_evidence: [],
      origin_ids: ["origin-synthetic-private"],
      evidence_label: "attributed_report",
      private_claim_marker: "PRIVATE_CLAIM_MARKER",
    }],
    impact_refs: [{ impact_id: impactId, version: impactVersion }],
    publication_status: "published",
    withdrawal_reason: null,
    publication_decision_id: "decision-synthetic-private",
    published_at: "2026-09-26T03:01:00Z",
    withdrawn_at: null,
    private_event_marker: "PRIVATE_EVENT_MARKER",
  };
}

function makeImpact(): RecordValue {
  return {
    schema_version: "2.0",
    trace_id: "trace-synthetic-impact-private",
    record_type: "Impact",
    dataset_kind: "live",
    impact_id: impactId,
    version: impactVersion,
    event_id: eventId,
    event_version: eventVersion,
    impact_type: "facility_closure",
    title: "Synthetic facility impact",
    description: "Fictional impact description.",
    lifecycle: "ongoing",
    freshness: {
      status: "needs_update",
      evaluated_at: "2026-09-26T03:02:00Z",
      review_due_at: null,
      basis: "unknown",
    },
    event_time: { start: null, end: null, precision: "unknown" },
    validity: { valid_from: null, valid_until: null },
    scope: makeScope({
      audience_ids: ["audience-synthetic-impact"],
      geometry_ids: [impactGeometryId],
    }),
    supporting_claim_ids: ["claim-synthetic-detail-01"],
    published_at: "2026-09-26T03:02:00Z",
    private_impact_marker: "PRIVATE_IMPACT_MARKER",
  };
}

function makeSnapshot(event = makeEvent()): RecordValue {
  const impact = makeImpact();
  return {
    datasetKind: "live",
    eventId,
    eventVersion,
    recordJson: event,
    impacts: [{
      eventId,
      eventVersion,
      impactId,
      impactVersion,
      recordJson: impact,
    }],
  };
}

function makeAttribution(
  reference: PublicEventProjectionLookupQuery["supportReferences"][number],
): RecordValue {
  return {
    dataset_kind: "live",
    report_revision_id: reference.reportRevisionId,
    permitted_text_hash: reference.permittedTextHash,
    span_start: reference.spanStart,
    span_end: reference.spanEnd,
    offset_unit: "unicode_code_points",
    relation: "supports",
    public_use_approved: true,
    display_name: "Synthetic fictional source",
    url: "https://source.example.invalid/synthetic-detail",
    published_at: "2026-09-26T02:50:00Z",
    observed_at: null,
    excerpt_public_use_approved: false,
    excerpt: null,
  };
}

function makeLookupResult(query: PublicEventProjectionLookupQuery): PublicEventProjectionLookupResult {
  return {
    scopeNames: query.scopeKeys.map((key) => ({
      entity_type: key.entityType,
      id: key.entityId,
      display_name: "Synthetic " + key.entityId,
    })),
    publicAttributions: query.supportReferences.map(makeAttribution),
  };
}

function makeGeometry(
  geometryId: string,
  overrides: RecordValue = {},
): PublicEventDetailGeometry {
  return {
    datasetKind: "live",
    geometryId,
    recordJson: {
      schema_version: "2.0",
      trace_id: "trace-synthetic-geometry-private",
      record_type: "Geometry",
      dataset_kind: "live",
      geometry_id: geometryId,
      role: "incident_scene",
      coordinate_reference_system: "OGC:CRS84",
      precision_basis: "source_supplied",
      precision_m: 25,
      display_label: "Synthetic test point",
      geojson: { type: "Point", coordinates: [106.8, -6.2] },
      source_evidence: [{
        report_revision_id: revisionId,
        permitted_text_hash: supportHash,
        span_start: 1,
        span_end: 12,
        offset_unit: "unicode_code_points",
        relation: "supports",
      }],
      private_geometry_marker: "PRIVATE_GEOMETRY_MARKER",
      ...overrides,
    },
  };
}

function makeHarness(
  snapshotValue: unknown,
  options: {
    lookup?: (query: PublicEventProjectionLookupQuery) => unknown | Promise<unknown>;
    geometries?: (ids: readonly string[]) => unknown | Promise<unknown>;
  } = {},
) {
  const calls: string[] = [];
  const snapshotCalls: unknown[] = [];
  const lookupCalls: PublicEventProjectionLookupQuery[] = [];
  const geometryCalls: unknown[] = [];
  const service = createPublicEventDetailProjectionService({
    snapshots: {
      async read(requestedId) {
        calls.push("snapshot");
        snapshotCalls.push(requestedId);
        return snapshotValue as PublicEventProjectionSnapshotReadResult;
      },
    },
    lookups: {
      async resolve(query) {
        calls.push("lookup");
        lookupCalls.push(query);
        if (options.lookup) return await options.lookup(query) as PublicEventProjectionLookupResult;
        return makeLookupResult(query);
      },
    },
    geometries: {
      async read(ids) {
        calls.push("geometry");
        geometryCalls.push(ids);
        if (options.geometries) {
          return await options.geometries(ids as readonly string[]) as readonly PublicEventDetailGeometry[];
        }
        return (ids as readonly string[]).map((id) => makeGeometry(id));
      },
    },
  });
  return { service, calls, snapshotCalls, lookupCalls, geometryCalls };
}

function assertError(error: unknown, code: string, marker?: string): void {
  assert.ok(error instanceof PublicEventDetailProjectionServiceError);
  assert.equal(error.code, code);
  assert.ok(error.message.length <= 80);
  if (marker !== undefined) assert.equal(error.message.includes(marker), false);
}

test("binds one snapshot and exact lookups before reading unique event/claim geometries", async () => {
  const harness = makeHarness({ kind: "found", snapshot: makeSnapshot() });
  const result = await harness.service.read(eventId);

  assert.deepEqual(harness.calls, ["snapshot", "lookup", "geometry"]);
  assert.deepEqual(harness.snapshotCalls, [eventId]);
  assert.deepEqual(harness.lookupCalls, [{
    scopeKeys: [
      { entityType: "audience", entityId: "audience-synthetic-impact" },
      { entityType: "place", entityId: "place-synthetic-event" },
      { entityType: "service", entityId: "service-synthetic-claim" },
    ],
    supportReferences: [{
      reportRevisionId: revisionId,
      permittedTextHash: supportHash,
      spanStart: 1,
      spanEnd: 12,
      offsetUnit: "unicode_code_points",
      relation: "supports",
    }],
  }]);
  assert.deepEqual(harness.geometryCalls, [[claimGeometryId, eventGeometryId]]);
  assert.equal(result.kind, "found");
  if (result.kind !== "found") return;
  assert.deepEqual(Object.keys(result), ["kind", "detail"]);
  assert.deepEqual(Object.keys(result.detail).sort(), [
    "category", "claims", "event_id", "event_time", "freshness", "geometries", "impacts",
    "lifecycle", "published_at", "scope", "summary", "tags", "title", "validity", "version",
  ]);
  assert.deepEqual(result.detail.geometries.map((geometry) => geometry.geometry_id), [
    claimGeometryId,
    eventGeometryId,
  ]);
  assert.equal(result.detail.claims[0]?.sources[0]?.excerpt, null);
  for (const marker of [
    "PRIVATE_EVENT_MARKER",
    "PRIVATE_CLAIM_MARKER",
    "PRIVATE_IMPACT_MARKER",
    "PRIVATE_SUPPORT_MARKER",
    "PRIVATE_SCOPE_MARKER",
    "PRIVATE_TAG_MARKER",
    "PRIVATE_GEOMETRY_MARKER",
    "trace-synthetic",
    "origin-synthetic-private",
    impactGeometryId,
  ]) {
    assert.equal(JSON.stringify(result).includes(marker), false);
  }
});

test("returns missing without lookup or geometry reads", async () => {
  const harness = makeHarness({ kind: "missing" });
  assert.deepEqual(await harness.service.read(eventId), { kind: "missing" });
  assert.deepEqual(harness.calls, ["snapshot"]);
  assert.deepEqual(harness.lookupCalls, []);
  assert.deepEqual(harness.geometryCalls, []);
});

test("rejects an invalid requested ID before any port call", async () => {
  const harness = makeHarness({ kind: "found", snapshot: makeSnapshot() });
  await assert.rejects(harness.service.read("../private/event"), (error: unknown) => {
    assertError(error, "INVALID_EVENT_ID", "../private/event");
    return true;
  });
  assert.deepEqual(harness.calls, []);
});

test("rejects snapshot identity mismatches before reviewed lookup", async () => {
  const snapshot = makeSnapshot();
  (snapshot.recordJson as RecordValue).event_id = "event-synthetic-other-private";
  const harness = makeHarness({ kind: "found", snapshot });
  await assert.rejects(harness.service.read(eventId), (error: unknown) => {
    assertError(error, "SNAPSHOT_INVALID", "event-synthetic-other-private");
    return true;
  });
  assert.deepEqual(harness.calls, ["snapshot"]);
});

test("does not read geometries for an event without event or claim references", async () => {
  const harness = makeHarness({
    kind: "found",
    snapshot: makeSnapshot(makeEvent([], [])),
  });
  const result = await harness.service.read(eventId);

  assert.deepEqual(harness.calls, ["snapshot", "lookup"]);
  assert.deepEqual(harness.geometryCalls, []);
  assert.equal(result.kind, "found");
  if (result.kind === "found") assert.deepEqual(result.detail.geometries, []);
});

test("enforces the geometry cap and rejects malformed references before geometry I/O", async (t) => {
  await t.test("over-limit unique references", async () => {
    const ids = Array.from({ length: 501 }, (_, index) => "geometry-synthetic-limit-" + index);
    const harness = makeHarness({
      kind: "found",
      snapshot: makeSnapshot(makeEvent(ids, ids)),
    });
    await assert.rejects(harness.service.read(eventId), (error: unknown) => {
      assertError(error, "GEOMETRY_LIMIT_EXCEEDED");
      return true;
    });
    assert.deepEqual(harness.calls, ["snapshot", "lookup"]);
    assert.deepEqual(harness.geometryCalls, []);
  });

  await t.test("invalid geometry identifier", async () => {
    const harness = makeHarness({
      kind: "found",
      snapshot: makeSnapshot(makeEvent(["bad/geometry"], ["bad/geometry"])),
    });
    await assert.rejects(harness.service.read(eventId), (error: unknown) => {
      assertError(error, "SNAPSHOT_INVALID");
      return true;
    });
    assert.deepEqual(harness.calls, ["snapshot", "lookup"]);
    assert.deepEqual(harness.geometryCalls, []);
  });

  await t.test("duplicate IDs inside one scope", async () => {
    const harness = makeHarness({
      kind: "found",
      snapshot: makeSnapshot(makeEvent([eventGeometryId, eventGeometryId], [claimGeometryId])),
    });
    await assert.rejects(harness.service.read(eventId), (error: unknown) => {
      assertError(error, "SNAPSHOT_INVALID");
      return true;
    });
    assert.deepEqual(harness.calls, ["snapshot", "lookup"]);
    assert.deepEqual(harness.geometryCalls, []);
  });
});

test("rejects missing, duplicate, extra, and identity-mismatched lookup rows before geometry I/O", async (t) => {
  const invalidResults: Array<{ name: string; resolve: (query: PublicEventProjectionLookupQuery) => unknown }> = [
    {
      name: "missing requested names",
      resolve: () => ({ scopeNames: [], publicAttributions: [] }),
    },
    {
      name: "extra scope identity",
      resolve: (query) => {
        const result = makeLookupResult(query) as unknown as RecordValue;
        (result.scopeNames as RecordValue[]).push({
          entity_type: "place",
          id: "place-synthetic-extra",
          display_name: "Synthetic extra",
        });
        return result;
      },
    },
    {
      name: "duplicate support attribution",
      resolve: (query) => {
        const result = makeLookupResult(query) as unknown as RecordValue;
        const attributions = result.publicAttributions as RecordValue[];
        attributions.push({ ...attributions[0] });
        return result;
      },
    },
    {
      name: "invalid source timestamp",
      resolve: (query) => {
        const result = makeLookupResult(query) as unknown as RecordValue;
        (result.publicAttributions as RecordValue[])[0]!.published_at = "2025-02-29T02:50:00Z";
        return result;
      },
    },
    {
      name: "source text or excerpt leakage",
      resolve: (query) => {
        const result = makeLookupResult(query) as unknown as RecordValue;
        (result.publicAttributions as RecordValue[])[0]!.excerpt = "PRIVATE_EXCERPT_MARKER";
        return result;
      },
    },
    {
      name: "wrong supporting attribution identity",
      resolve: (query) => {
        const result = makeLookupResult(query) as unknown as RecordValue;
        (result.publicAttributions as RecordValue[])[0]!.report_revision_id = "revision-synthetic-other";
        return result;
      },
    },
  ];

  for (const scenario of invalidResults) {
    await t.test(scenario.name, async () => {
      const harness = makeHarness(
        { kind: "found", snapshot: makeSnapshot() },
        { lookup: scenario.resolve },
      );
      await assert.rejects(harness.service.read(eventId), (error: unknown) => {
        assertError(error, "LOOKUP_RESULT_INVALID", "PRIVATE_EXCERPT_MARKER");
        return true;
      });
      assert.deepEqual(harness.calls, ["snapshot", "lookup"]);
      assert.deepEqual(harness.geometryCalls, []);
    });
  }
});

test("rejects malformed geometry port rows without returning partial detail", async (t) => {
  const invalidResults: Array<{
    name: string;
    read: (ids: readonly string[]) => unknown;
  }> = [
    { name: "missing geometry", read: () => [] },
    {
      name: "duplicate geometry",
      read: (ids) => [makeGeometry(ids[0]!), makeGeometry(ids[0]!)],
    },
    {
      name: "extra geometry",
      read: () => [makeGeometry("geometry-synthetic-extra")],
    },
    {
      name: "wrong dataset",
      read: (ids) => [{ ...makeGeometry(ids[0]!), datasetKind: "synthetic" }],
    },
    {
      name: "wrapper and record IDs disagree",
      read: (ids) => [{ ...makeGeometry(ids[0]!), geometryId: "geometry-synthetic-other" }],
    },
    {
      name: "record identity disagrees with its wrapper",
      read: (ids) => [{
        ...makeGeometry(ids[0]!),
        recordJson: {
          ...(makeGeometry(ids[0]!).recordJson as RecordValue),
          geometry_id: "geometry-synthetic-other",
        },
      }],
    },
    { name: "malformed result container", read: () => null },
  ];

  for (const scenario of invalidResults) {
    await t.test(scenario.name, async () => {
      const harness = makeHarness(
        { kind: "found", snapshot: makeSnapshot(makeEvent([eventGeometryId], [eventGeometryId])) },
        { geometries: scenario.read },
      );
      await assert.rejects(harness.service.read(eventId), (error: unknown) => {
        assertError(error, "GEOMETRY_RESULT_INVALID", eventId);
        return true;
      });
      assert.deepEqual(harness.calls, ["snapshot", "lookup", "geometry"]);
    });
  }
});

test("validates valid and impossible source timestamps before geometry reads", async (t) => {
  await t.test("accepts a valid leap-day timestamp", async () => {
    const harness = makeHarness({ kind: "found", snapshot: makeSnapshot() }, {
      lookup: (query) => {
        const result = makeLookupResult(query) as unknown as RecordValue;
        (result.publicAttributions as RecordValue[])[0]!.published_at = "2024-02-29T02:50:00Z";
        return result;
      },
    });
    const result = await harness.service.read(eventId);
    assert.equal(result.kind, "found");
    if (result.kind === "found") {
      assert.equal(result.detail.claims[0]?.sources[0]?.published_at, "2024-02-29T02:50:00Z");
    }
    assert.deepEqual(harness.calls, ["snapshot", "lookup", "geometry"]);
  });

  await t.test("rejects an impossible calendar date", async () => {
    const harness = makeHarness({ kind: "found", snapshot: makeSnapshot() }, {
      lookup: (query) => {
        const result = makeLookupResult(query) as unknown as RecordValue;
        (result.publicAttributions as RecordValue[])[0]!.published_at = "2025-02-29T02:50:00Z";
        return result;
      },
    });
    await assert.rejects(harness.service.read(eventId), (error: unknown) => {
      assertError(error, "LOOKUP_RESULT_INVALID");
      return true;
    });
    assert.deepEqual(harness.calls, ["snapshot", "lookup"]);
    assert.deepEqual(harness.geometryCalls, []);
  });
});
test("redacts snapshot, lookup, geometry port errors", async (t) => {
  await t.test("snapshot", async () => {
    const service = createPublicEventDetailProjectionService({
      snapshots: { async read() { throw new Error("PRIVATE_SNAPSHOT_DATABASE_MESSAGE"); } },
      lookups: { async resolve(query) { return makeLookupResult(query); } },
      geometries: { async read(ids) { return (ids as string[]).map((id) => makeGeometry(id)); } },
    });
    await assert.rejects(service.read(eventId), (error: unknown) => {
      assertError(error, "SNAPSHOT_READ_FAILED", "PRIVATE_SNAPSHOT_DATABASE_MESSAGE");
      return true;
    });

  });

  await t.test("lookup", async () => {
    const harness = makeHarness({ kind: "found", snapshot: makeSnapshot() }, {
      lookup: async () => { throw new Error("PRIVATE_LOOKUP_DATABASE_MESSAGE"); },
    });
    await assert.rejects(harness.service.read(eventId), (error: unknown) => {
      assertError(error, "LOOKUP_READ_FAILED", "PRIVATE_LOOKUP_DATABASE_MESSAGE");
      return true;
    });
    assert.deepEqual(harness.calls, ["snapshot", "lookup"]);
  });

  await t.test("geometry", async () => {
    const harness = makeHarness({ kind: "found", snapshot: makeSnapshot() }, {
      geometries: async () => { throw new Error("PRIVATE_GEOMETRY_DATABASE_MESSAGE"); },
    });
    await assert.rejects(harness.service.read(eventId), (error: unknown) => {
      assertError(error, "GEOMETRY_READ_FAILED", "PRIVATE_GEOMETRY_DATABASE_MESSAGE");
      return true;
    });
    assert.deepEqual(harness.calls, ["snapshot", "lookup", "geometry"]);
  });
});

test("delegates exact claim/evidence support to the strict projector and returns no partial detail", async () => {
  const harness = makeHarness(
    { kind: "found", snapshot: makeSnapshot(makeEvent([eventGeometryId], [eventGeometryId])) },
    {
      geometries: (ids) => ids.map((id) => makeGeometry(id, {
        source_evidence: [{
          report_revision_id: revisionId,
          permitted_text_hash: "b".repeat(64),
          span_start: 1,
          span_end: 12,
          offset_unit: "unicode_code_points",
          relation: "supports",
        }],
      })),
    },
  );
  await assert.rejects(harness.service.read(eventId), (error: unknown) => {
    assertError(error, "PROJECTION_FAILED");
    return true;
  });
  assert.deepEqual(harness.calls, ["snapshot", "lookup", "geometry"]);
});