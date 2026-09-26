import assert from "node:assert/strict";
import test from "node:test";
import {
  createPublicEventProjectionService,
  PublicEventProjectionServiceError,
  type PublicEventProjectionLookupQuery,
  type PublicEventProjectionLookupResult,
  type PublicEventProjectionSnapshotReadResult,
} from "../src/layers/l4-application-integration/public-event-projection-service.js";

const eventId = "event-synthetic-live-shaped-01";
const eventVersion = 3;
const supportHashOne = "a".repeat(64);
const supportHashTwo = "b".repeat(64);

// These are authored fictional test values. Their live-shaped fields and
// approval markers exercise the boundary only; they assert no real source,
// source rights, publication, fact, or human review.
function makeSupportReference(
  reportRevisionId: string,
  permittedTextHash = supportHashOne,
  spanStart = 0,
  spanEnd = 12,
  relation = "supports",
): Record<string, unknown> {
  return {
    report_revision_id: reportRevisionId,
    permitted_text_hash: permittedTextHash,
    span_start: spanStart,
    span_end: spanEnd,
    offset_unit: "unicode_code_points",
    relation,
    private_reference_marker: "PRIVATE_SUPPORT_MARKER",
  };
}

function makeScope(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    place_ids: [],
    service_ids: [],
    institution_ids: [],
    audience_ids: [],
    geometry_ids: ["geometry-private-marker"],
    private_scope_marker: "PRIVATE_SCOPE_MARKER",
    ...overrides,
  };
}

function makeEvent(): Record<string, unknown> {
  return {
    schema_version: "2.0",
    trace_id: "trace-synthetic-private-marker",
    record_type: "Event",
    dataset_kind: "live",
    event_id: eventId,
    version: eventVersion,
    supersedes_version: 2,
    title: "Synthetic event title",
    summary: "Synthetic event summary.",
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
      institution_ids: ["institution-synthetic-event"],
    }),
    claims: [
      {
        claim_id: "claim-synthetic-a",
        text: "Synthetic claim A.",
        event_time: { start: null, end: null, precision: "unknown" },
        validity: { valid_from: null, valid_until: null },
        scope: makeScope({
          place_ids: ["place-synthetic-shared"],
          service_ids: ["service-synthetic-claim"],
        }),
        qualifiers: [],
        support: [makeSupportReference("revision-synthetic-one", supportHashOne, 1, 14)],
        contradictions: [makeSupportReference("revision-synthetic-contrary", "c".repeat(64), 0, 9, "contradicts")],
        context_evidence: [
          makeSupportReference("revision-synthetic-context", "d".repeat(64), 2, 10, "context"),
          makeSupportReference("revision-synthetic-update", "e".repeat(64), 1, 5, "updates"),
        ],
        origin_ids: ["origin-synthetic-private-marker"],
        evidence_label: "attributed_report",
        private_claim_marker: "PRIVATE_CLAIM_MARKER",
      },
      {
        claim_id: "claim-synthetic-b",
        text: "Synthetic claim B.",
        event_time: { start: null, end: null, precision: "unknown" },
        validity: { valid_from: null, valid_until: null },
        scope: makeScope({
          place_ids: ["place-synthetic-shared"],
          audience_ids: ["audience-synthetic-claim"],
        }),
        qualifiers: [],
        support: [
          makeSupportReference("revision-synthetic-one", supportHashOne, 1, 14),
          makeSupportReference("revision-synthetic-two", supportHashTwo, 3, 18),
        ],
        contradictions: [],
        context_evidence: [],
        origin_ids: ["origin-synthetic-private-marker"],
        evidence_label: "issuer_notice",
      },
    ],
    impact_refs: [{ impact_id: "impact-synthetic-01", version: 2 }],
    publication_status: "published",
    withdrawal_reason: null,
    publication_decision_id: "decision-synthetic-private-marker",
    published_at: "2026-09-26T03:01:00Z",
    withdrawn_at: null,
    private_event_marker: "PRIVATE_EVENT_MARKER",
  };
}

function makeImpact(): Record<string, unknown> {
  return {
    schema_version: "2.0",
    trace_id: "trace-impact-synthetic-private-marker",
    record_type: "Impact",
    dataset_kind: "live",
    impact_id: "impact-synthetic-01",
    version: 2,
    event_id: eventId,
    event_version: eventVersion,
    impact_type: "facility_closure",
    title: "Synthetic impact title",
    description: "Synthetic impact description.",
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
      place_ids: ["place-synthetic-impact"],
      institution_ids: ["institution-synthetic-impact"],
    }),
    supporting_claim_ids: ["claim-synthetic-a", "claim-synthetic-b"],
    published_at: "2026-09-26T03:02:00Z",
    private_impact_marker: "PRIVATE_IMPACT_MARKER",
  };
}

function makeSnapshot(
  eventRecord = makeEvent(),
  impactRecord = makeImpact(),
): Record<string, unknown> {
  return {
    datasetKind: "live",
    eventId,
    eventVersion,
    recordJson: eventRecord,
    impacts: [{
      eventId,
      eventVersion,
      impactId: impactRecord.impact_id,
      impactVersion: impactRecord.version,
      recordJson: impactRecord,
    }],
  };
}

function makeAttribution(reference: PublicEventProjectionLookupQuery["supportReferences"][number]): Record<string, unknown> {
  const isFirst = reference.reportRevisionId === "revision-synthetic-one";
  return {
    dataset_kind: "live",
    report_revision_id: reference.reportRevisionId,
    permitted_text_hash: reference.permittedTextHash,
    span_start: reference.spanStart,
    span_end: reference.spanEnd,
    offset_unit: "unicode_code_points",
    relation: "supports",
    public_use_approved: true,
    display_name: `Synthetic source ${reference.reportRevisionId}`,
    url: `https://source.example.invalid/${reference.reportRevisionId}`,
    published_at: isFirst ? "2026-09-25T20:00:00Z" : null,
    observed_at: isFirst ? "2026-09-26T03:10:00+07:00" : "2026-09-26T03:12:00Z",
    excerpt_public_use_approved: false,
    excerpt: null,
    private_attribution_marker: "PRIVATE_ATTRIBUTION_MARKER",
  };
}

function defaultLookupResult(query: PublicEventProjectionLookupQuery): PublicEventProjectionLookupResult {
  return {
    scopeNames: query.scopeKeys.map((key) => ({
      entity_type: key.entityType,
      id: key.entityId,
      display_name: `Synthetic name ${key.entityId}`,
      private_label_marker: "PRIVATE_LABEL_MARKER",
    })),
    publicAttributions: query.supportReferences.map(makeAttribution),
  };
}

function makeHarness(
  snapshotResult: unknown,
  resolve: (query: PublicEventProjectionLookupQuery) => unknown | Promise<unknown> = defaultLookupResult,
) {
  const snapshotCalls: unknown[] = [];
  const lookupCalls: PublicEventProjectionLookupQuery[] = [];
  const service = createPublicEventProjectionService({
    snapshots: {
      async read(id) {
        snapshotCalls.push(id);
        return snapshotResult as PublicEventProjectionSnapshotReadResult;
      },
    },
    lookups: {
      async resolve(query) {
        lookupCalls.push(query);
        return await resolve(query) as PublicEventProjectionLookupResult;
      },
    },
  });
  return { service, snapshotCalls, lookupCalls };
}

function assertServiceError(error: unknown, code: string, privateMarker?: string): void {
  assert.ok(error instanceof PublicEventProjectionServiceError);
  assert.equal(error.code, code);
  assert.ok(error.message.length <= 80);
  if (privateMarker !== undefined) assert.equal(error.message.includes(privateMarker), false);
}

test("reads one current snapshot, requests only deduplicated public keys, and returns the strict EventView", async () => {
  const harness = makeHarness({ kind: "found", snapshot: makeSnapshot() });
  const result = await harness.service.read(eventId);

  assert.deepEqual(harness.snapshotCalls, [eventId]);
  assert.equal(harness.lookupCalls.length, 1);
  assert.deepEqual(harness.lookupCalls[0], {
    scopeKeys: [
      { entityType: "audience", entityId: "audience-synthetic-claim" },
      { entityType: "institution", entityId: "institution-synthetic-event" },
      { entityType: "institution", entityId: "institution-synthetic-impact" },
      { entityType: "place", entityId: "place-synthetic-event" },
      { entityType: "place", entityId: "place-synthetic-impact" },
      { entityType: "place", entityId: "place-synthetic-shared" },
      { entityType: "service", entityId: "service-synthetic-claim" },
    ],
    supportReferences: [
      {
        reportRevisionId: "revision-synthetic-one",
        permittedTextHash: supportHashOne,
        spanStart: 1,
        spanEnd: 14,
        offsetUnit: "unicode_code_points",
        relation: "supports",
      },
      {
        reportRevisionId: "revision-synthetic-two",
        permittedTextHash: supportHashTwo,
        spanStart: 3,
        spanEnd: 18,
        offsetUnit: "unicode_code_points",
        relation: "supports",
      },
    ],
  });
  assert.equal(JSON.stringify(harness.lookupCalls[0]).includes("geometry-private-marker"), false);
  assert.equal(JSON.stringify(harness.lookupCalls[0]).includes("revision-synthetic-contrary"), false);
  assert.equal(JSON.stringify(harness.lookupCalls[0]).includes("revision-synthetic-context"), false);
  assert.equal(JSON.stringify(harness.lookupCalls[0]).includes("revision-synthetic-update"), false);

  assert.deepEqual(Object.keys(result).sort(), ["event", "kind"]);
  assert.equal(result.kind, "found");
  if (result.kind !== "found") return;
  assert.deepEqual(Object.keys(result.event).sort(), [
    "category", "claims", "event_id", "event_time", "freshness", "impacts", "lifecycle",
    "published_at", "scope", "summary", "tags", "title", "validity", "version",
  ]);
  assert.deepEqual(result.event.scope.places, ["Synthetic name place-synthetic-event"]);
  assert.deepEqual(result.event.scope.institutions, ["Synthetic name institution-synthetic-event"]);
  assert.equal(result.event.claims.length, 2);
  assert.equal(result.event.claims[0]?.claim_id, "claim-synthetic-a");
  assert.deepEqual(result.event.claims[0]?.scope.services, ["Synthetic name service-synthetic-claim"]);
  assert.equal(result.event.claims[0]?.sources[0]?.published_at, "2026-09-25T20:00:00Z");
  assert.equal(result.event.claims[0]?.sources[0]?.observed_at, "2026-09-26T03:10:00+07:00");
  assert.equal(result.event.claims[1]?.sources.length, 2);
  assert.deepEqual(Object.keys(result.event.claims[0]!.sources[0]!).sort(), [
    "display_name", "excerpt", "observed_at", "published_at", "url",
  ]);
  assert.equal(result.event.impacts.length, 1);
  assert.equal(result.event.impacts[0]?.impact_id, "impact-synthetic-01");
  assert.equal(result.event.impacts[0]?.version, 2);
  assert.deepEqual(result.event.impacts[0]?.scope.institutions, ["Synthetic name institution-synthetic-impact"]);
  for (const marker of [
    "PRIVATE_EVENT_MARKER", "PRIVATE_CLAIM_MARKER", "PRIVATE_IMPACT_MARKER", "PRIVATE_SUPPORT_MARKER",
    "PRIVATE_SCOPE_MARKER", "PRIVATE_LABEL_MARKER", "PRIVATE_ATTRIBUTION_MARKER", "trace-synthetic-private-marker",
    "origin-synthetic-private-marker", "geometry-private-marker",
  ]) {
    assert.equal(JSON.stringify(result).includes(marker), false);
  }
});

test("returns missing without asking the lookup port", async () => {
  const harness = makeHarness({ kind: "missing" });
  assert.deepEqual(await harness.service.read(eventId), { kind: "missing" });
  assert.deepEqual(harness.snapshotCalls, [eventId]);
  assert.deepEqual(harness.lookupCalls, []);
});

test("rejects an invalid event identifier without reading either port", async () => {
  const harness = makeHarness({ kind: "found", snapshot: makeSnapshot() });
  await assert.rejects(harness.service.read("../private/event"), (error: unknown) => {
    assertServiceError(error, "INVALID_EVENT_ID", "../private/event");
    return true;
  });
  assert.deepEqual(harness.snapshotCalls, []);
  assert.deepEqual(harness.lookupCalls, []);
});

test("rejects snapshot and record identity mismatches before reviewed lookup", async (t) => {
  const cases: Array<{ name: string; mutate: (snapshot: Record<string, unknown>) => void }> = [
    {
      name: "requested ID does not match snapshot ID",
      mutate: (snapshot) => { snapshot.eventId = "event-synthetic-other"; },
    },
    {
      name: "snapshot version does not match event record",
      mutate: (snapshot) => { snapshot.eventVersion = eventVersion + 1; },
    },
    {
      name: "event record ID does not match snapshot",
      mutate: (snapshot) => { (snapshot.recordJson as Record<string, unknown>).event_id = "event-synthetic-other"; },
    },
    {
      name: "event record version does not match snapshot",
      mutate: (snapshot) => { (snapshot.recordJson as Record<string, unknown>).version = eventVersion + 1; },
    },
    {
      name: "impact envelope event ID does not match snapshot",
      mutate: (snapshot) => { (snapshot.impacts as Array<Record<string, unknown>>)[0]!.eventId = "event-synthetic-other"; },
    },
    {
      name: "impact envelope event version does not match snapshot",
      mutate: (snapshot) => { (snapshot.impacts as Array<Record<string, unknown>>)[0]!.eventVersion = eventVersion + 1; },
    },
    {
      name: "impact envelope ID does not match impact record",
      mutate: (snapshot) => { (snapshot.impacts as Array<Record<string, unknown>>)[0]!.impactId = "impact-synthetic-other"; },
    },
    {
      name: "impact envelope version does not match impact record",
      mutate: (snapshot) => { (snapshot.impacts as Array<Record<string, unknown>>)[0]!.impactVersion = 1; },
    },
    {
      name: "impact record event ID does not match snapshot",
      mutate: (snapshot) => {
        (((snapshot.impacts as Array<Record<string, unknown>>)[0]!.recordJson) as Record<string, unknown>).event_id = "event-synthetic-other";
      },
    },
    {
      name: "impact record event version does not match snapshot",
      mutate: (snapshot) => {
        (((snapshot.impacts as Array<Record<string, unknown>>)[0]!.recordJson) as Record<string, unknown>).event_version = eventVersion + 1;
      },
    },
    {
      name: "impact record ID does not match envelope",
      mutate: (snapshot) => {
        (((snapshot.impacts as Array<Record<string, unknown>>)[0]!.recordJson) as Record<string, unknown>).impact_id = "impact-synthetic-other";
      },
    },
    {
      name: "impact record version does not match envelope",
      mutate: (snapshot) => {
        (((snapshot.impacts as Array<Record<string, unknown>>)[0]!.recordJson) as Record<string, unknown>).version = 1;
      },
    },
    {
      name: "event impact reference does not match snapshot impacts",
      mutate: (snapshot) => {
        ((snapshot.recordJson as Record<string, unknown>).impact_refs as Array<Record<string, unknown>>)[0]!.version = 1;
      },
    },
    {
      name: "synthetic snapshot is rejected before lookup",
      mutate: (snapshot) => { snapshot.datasetKind = "synthetic"; },
    },
  ];

  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
      const snapshot = makeSnapshot();
      scenario.mutate(snapshot);
      const harness = makeHarness({ kind: "found", snapshot });
      await assert.rejects(harness.service.read(eventId), (error: unknown) => {
        assertServiceError(error, "SNAPSHOT_INVALID");
        return true;
      });
      assert.equal(harness.snapshotCalls.length, 1);
      assert.deepEqual(harness.lookupCalls, []);
    });
  }
});

test("rejects malformed scope and support keys before lookup", async (t) => {
  const cases: Array<{ name: string; mutate: (event: Record<string, unknown>) => void }> = [
    {
      name: "invalid scope identifier",
      mutate: (event) => { ((event.scope as Record<string, unknown>).place_ids as unknown[]).push({}); },
    },
    {
      name: "invalid support relation",
      mutate: (event) => {
        ((((event.claims as Array<Record<string, unknown>>)[0]!.support as Array<Record<string, unknown>>)[0]!).relation) = "contradicts";
      },
    },
    {
      name: "missing claim scope",
      mutate: (event) => { (event.claims as Array<Record<string, unknown>>)[0]!.scope = null; },
    },
  ];

  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
      const event = makeEvent();
      scenario.mutate(event);
      const harness = makeHarness({ kind: "found", snapshot: makeSnapshot(event) });
      await assert.rejects(harness.service.read(eventId), (error: unknown) => {
        assertServiceError(error, "SNAPSHOT_INVALID");
        return true;
      });
      assert.deepEqual(harness.lookupCalls, []);
    });
  }
});

test("rejects more than 100 deduplicated scope keys or support references before lookup", async (t) => {
  await t.test("scope keys", async () => {
    const event = makeEvent();
    (event.scope as Record<string, unknown>).place_ids = Array.from({ length: 101 }, (_, index) => `place-synthetic-${index}`);
    const harness = makeHarness({ kind: "found", snapshot: makeSnapshot(event) });
    await assert.rejects(harness.service.read(eventId), (error: unknown) => {
      assertServiceError(error, "LOOKUP_LIMIT_EXCEEDED");
      return true;
    });
    assert.deepEqual(harness.lookupCalls, []);
  });

  await t.test("support references", async () => {
    const event = makeEvent();
    (event.claims as Array<Record<string, unknown>>)[0]!.support = Array.from({ length: 101 }, (_, index) =>
      makeSupportReference(`revision-synthetic-${index}`, supportHashOne, index, index + 1));
    const harness = makeHarness({ kind: "found", snapshot: makeSnapshot(event) });
    await assert.rejects(harness.service.read(eventId), (error: unknown) => {
      assertServiceError(error, "LOOKUP_LIMIT_EXCEEDED");
      return true;
    });
    assert.deepEqual(harness.lookupCalls, []);
  });
});

test("fails closed on missing or ambiguous reviewed names and support attributions", async (t) => {
  const scenarios: Array<{
    name: string;
    resolve: (query: PublicEventProjectionLookupQuery) => unknown;
  }> = [
    {
      name: "missing scope name",
      resolve: (query) => ({
        ...defaultLookupResult(query),
        scopeNames: [],
      }),
    },
    {
      name: "duplicate scope name",
      resolve: (query) => {
        const rows = defaultLookupResult(query).scopeNames;
        return { ...defaultLookupResult(query), scopeNames: [...rows, rows[0]] };
      },
    },
    {
      name: "missing support attribution",
      resolve: (query) => ({
        ...defaultLookupResult(query),
        publicAttributions: [],
      }),
    },
    {
      name: "duplicate support attribution",
      resolve: (query) => {
        const rows = defaultLookupResult(query).publicAttributions;
        return { ...defaultLookupResult(query), publicAttributions: [...rows, rows[0]] };
      },
    },
  ];

  for (const scenario of scenarios) {
    await t.test(scenario.name, async () => {
      const harness = makeHarness({ kind: "found", snapshot: makeSnapshot() }, scenario.resolve);
      await assert.rejects(harness.service.read(eventId), (error: unknown) => {
        assertServiceError(error, "PROJECTION_FAILED");
        return true;
      });
      assert.equal(harness.lookupCalls.length, 1);
    });
  }
});

test("maps port and projector failures to stable redacted errors", async (t) => {
  await t.test("snapshot reader failure", async () => {
    const harness = makeHarness(undefined);
    harness.service = createPublicEventProjectionService({
      snapshots: { async read() { throw new Error(`PRIVATE_EVENT_ID ${eventId}`); } },
      lookups: { async resolve(query) { return defaultLookupResult(query); } },
    });
    await assert.rejects(harness.service.read(eventId), (error: unknown) => {
      assertServiceError(error, "SNAPSHOT_READ_FAILED", eventId);
      return true;
    });
    assert.deepEqual(harness.lookupCalls, []);
  });

  await t.test("lookup reader failure", async () => {
    const harness = makeHarness({ kind: "found", snapshot: makeSnapshot() }, () => {
      throw new Error("PRIVATE_SQL_AND_SOURCE_TEXT_MARKER");
    });
    await assert.rejects(harness.service.read(eventId), (error: unknown) => {
      assertServiceError(error, "LOOKUP_READ_FAILED", "PRIVATE_SQL_AND_SOURCE_TEXT_MARKER");
      return true;
    });
  });

  await t.test("projector validation failure", async () => {
    const event = makeEvent();
    event.publication_status = "withdrawn";
    const harness = makeHarness({ kind: "found", snapshot: makeSnapshot(event) });
    await assert.rejects(harness.service.read(eventId), (error: unknown) => {
      assertServiceError(error, "PROJECTION_FAILED", "PRIVATE_EVENT_MARKER");
      return true;
    });
    assert.equal(harness.lookupCalls.length, 1);
  });
});
