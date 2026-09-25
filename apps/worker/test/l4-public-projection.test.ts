import assert from "node:assert/strict";
import test from "node:test";
import { projectPublicEvent, PublicProjectionError, type PublicProjectionErrorCode, type PublicProjectionLookups } from "../src/layers/l4-application-integration/public-projection.js";

const syntheticHashOne = "a".repeat(64);
const syntheticHashTwo = "b".repeat(64);
const syntheticHashThree = "c".repeat(64);

// Every `live` value below is an authored test marker. These are not live
// source records, real publications, actual source-rights permissions, or
// human-review data. The `.invalid` URLs and synthetic approval flags exist
// only to exercise the projector's allowlist and fail-closed behavior.
function makeSyntheticEvent(): Record<string, unknown> {
  return {
    schema_version: "2.0",
    trace_id: "trace-synthetic-private-marker",
    record_type: "Event",
    dataset_kind: "live",
    event_id: "event-synthetic-live-shaped-01",
    version: 2,
    supersedes_version: 1,
    title: "Synthetic notice title",
    summary: "Synthetic summary for a non-geographic notice.",
    category: "group_specific_critical_notices",
    tags: [
      { namespace: "topic", value: "synthetic_notice", internal_tag_note: "PRIVATE_TAG_MARKER" },
      { namespace: "audience", value: "students" },
    ],
    lifecycle: "ongoing",
    freshness: {
      status: "current",
      evaluated_at: "2026-09-25T03:00:00Z",
      review_due_at: "2026-09-26T03:00:00Z",
      basis: "manual_review",
    },
    event_time: { start: "2026-09-25", end: null, precision: "date" },
    validity: { valid_from: null, valid_until: null },
    scope: {
      place_ids: [],
      service_ids: [],
      institution_ids: [],
      audience_ids: ["audience-synthetic-students"],
      geometry_ids: [],
      private_scope_note: "PRIVATE_SCOPE_MARKER",
    },
    claims: [
      {
        claim_id: "claim-synthetic-b",
        text: "Synthetic claim with two source references.",
        event_time: { start: "2026-09-25T09:00:00+07:00", end: null, precision: "exact" },
        validity: { valid_from: "2026-09-25T02:00:00Z", valid_until: "2026-09-26T02:00:00Z" },
        scope: {
          place_ids: [], service_ids: [], institution_ids: [],
          audience_ids: ["audience-synthetic-students"], geometry_ids: [],
        },
        qualifiers: ["synthetic", "test_only"],
        support: [
          {
            report_revision_id: "revision-synthetic-two",
            permitted_text_hash: syntheticHashTwo,
            span_start: 4,
            span_end: 19,
            offset_unit: "unicode_code_points",
            relation: "supports",
          },
          {
            report_revision_id: "revision-synthetic-three",
            permitted_text_hash: syntheticHashThree,
            span_start: 0,
            span_end: 14,
            offset_unit: "unicode_code_points",
            relation: "supports",
          },
        ],
        contradictions: [
          {
            report_revision_id: "revision-synthetic-contrary",
            permitted_text_hash: "d".repeat(64),
            span_start: 0,
            span_end: 12,
            offset_unit: "unicode_code_points",
            relation: "contradicts",
          },
        ],
        context_evidence: [
          {
            report_revision_id: "revision-synthetic-context",
            permitted_text_hash: "e".repeat(64),
            span_start: 2,
            span_end: 13,
            offset_unit: "unicode_code_points",
            relation: "context",
          },
        ],
        origin_ids: ["origin-synthetic-private-marker"],
        evidence_label: "attributed_report",
        private_claim_note: "PRIVATE_CLAIM_MARKER",
      },
      {
        claim_id: "claim-synthetic-a",
        text: "Synthetic claim with one source reference.",
        event_time: { start: null, end: null, precision: "unknown" },
        validity: { valid_from: null, valid_until: null },
        scope: {
          place_ids: [], service_ids: [], institution_ids: [],
          audience_ids: ["audience-synthetic-students"], geometry_ids: [],
        },
        qualifiers: [],
        support: [
          {
            report_revision_id: "revision-synthetic-one",
            permitted_text_hash: syntheticHashOne,
            span_start: 0,
            span_end: 16,
            offset_unit: "unicode_code_points",
            relation: "supports",
          },
        ],
        contradictions: [],
        context_evidence: [],
        origin_ids: ["origin-synthetic-one"],
        evidence_label: "issuer_notice",
      },
    ],
    impact_refs: [
      { impact_id: "impact-synthetic-z", version: 2 },
      { impact_id: "impact-synthetic-a", version: 1 },
    ],
    publication_status: "published",
    withdrawal_reason: null,
    publication_decision_id: "decision-synthetic-private-marker",
    published_at: "2026-09-25T03:01:00Z",
    withdrawn_at: null,
    model_run: { prompt: "PRIVATE_MODEL_MARKER" },
    storage_secret: "PRIVATE_STORAGE_MARKER",
  };
}

function makeSyntheticImpacts(): Record<string, unknown>[] {
  return [
    {
      schema_version: "2.0",
      trace_id: "trace-impact-synthetic-private-marker",
      record_type: "Impact",
      dataset_kind: "live",
      impact_id: "impact-synthetic-z",
      version: 2,
      event_id: "event-synthetic-live-shaped-01",
      event_version: 2,
      impact_type: "audience_notice",
      title: "Synthetic secondary impact",
      description: "Synthetic impact description.",
      lifecycle: "planned",
      freshness: {
        status: "needs_update",
        evaluated_at: "2026-09-25T03:02:00Z",
        review_due_at: null,
        basis: "unknown",
      },
      event_time: { start: "2026-09-25T09:00:00+07:00", end: "2026-09-25T10:00:00+07:00", precision: "range" },
      validity: { valid_from: null, valid_until: null },
      scope: {
        place_ids: [], service_ids: [], institution_ids: [],
        audience_ids: ["audience-synthetic-students"], geometry_ids: [],
      },
      supporting_claim_ids: ["claim-synthetic-b"],
      published_at: "2026-09-25T03:02:00Z",
      private_impact_note: "PRIVATE_IMPACT_MARKER",
    },
    {
      schema_version: "2.0",
      trace_id: "trace-impact-synthetic-private-marker",
      record_type: "Impact",
      dataset_kind: "live",
      impact_id: "impact-synthetic-a",
      version: 1,
      event_id: "event-synthetic-live-shaped-01",
      event_version: 2,
      impact_type: "facility_closure",
      title: "Synthetic primary impact",
      description: "Another synthetic impact description.",
      lifecycle: "ongoing",
      freshness: {
        status: "current",
        evaluated_at: "2026-09-25T03:03:00Z",
        review_due_at: "2026-09-25T04:03:00Z",
        basis: "manual_review",
      },
      event_time: { start: null, end: null, precision: "unknown" },
      validity: { valid_from: null, valid_until: null },
      scope: {
        place_ids: [], service_ids: [], institution_ids: [],
        audience_ids: ["audience-synthetic-students"], geometry_ids: [],
      },
      supporting_claim_ids: ["claim-synthetic-a", "claim-synthetic-b"],
      published_at: "2026-09-25T03:03:00Z",
    },
  ];
}

function makeSyntheticLookups(): PublicProjectionLookups {
  return {
    scopeNames: [
      {
        entity_type: "audience",
        id: "audience-synthetic-students",
        display_name: "Synthetic student audience",
        private_label_note: "PRIVATE_LABEL_MARKER",
      },
    ],
    publicAttributions: [
      {
        dataset_kind: "live",
        report_revision_id: "revision-synthetic-one",
        permitted_text_hash: syntheticHashOne,
        span_start: 0,
        span_end: 16,
        offset_unit: "unicode_code_points",
        relation: "supports",
        public_use_approved: true,
        display_name: "Synthetic Office One",
        url: "https://office-one.example.invalid/synthetic-notice",
        published_at: "2026-09-24T20:00:00Z",
        observed_at: "2026-09-25T03:10:00+07:00",
        excerpt_public_use_approved: true,
        excerpt: "Synthetic excerpt one.",
        report_revision_id_private: "PRIVATE_REVISION_MARKER",
        permitted_text: "PRIVATE_PERMITTED_TEXT_MARKER",
      },
      {
        dataset_kind: "live",
        report_revision_id: "revision-synthetic-two",
        permitted_text_hash: syntheticHashTwo,
        span_start: 4,
        span_end: 19,
        offset_unit: "unicode_code_points",
        relation: "supports",
        public_use_approved: true,
        display_name: "Synthetic Office Two",
        url: "https://office-two.example.invalid/synthetic-notice",
        published_at: "2026-09-25T02:00:00+07:00",
        observed_at: null,
        excerpt_public_use_approved: false,
        excerpt: "SYNTHETIC_UNAPPROVED_EXCERPT_MARKER",
      },
      {
        dataset_kind: "live",
        report_revision_id: "revision-synthetic-three",
        permitted_text_hash: syntheticHashThree,
        span_start: 0,
        span_end: 14,
        offset_unit: "unicode_code_points",
        relation: "supports",
        public_use_approved: true,
        display_name: "Synthetic Office Three",
        url: "https://office-three.example.invalid/synthetic-notice",
        published_at: null,
        observed_at: "2026-09-25T03:15:00Z",
        excerpt_public_use_approved: true,
        excerpt: null,
      },
      {
        dataset_kind: "live",
        report_revision_id: "revision-synthetic-contrary",
        permitted_text_hash: "d".repeat(64),
        span_start: 0,
        span_end: 12,
        offset_unit: "unicode_code_points",
        relation: "contradicts",
        public_use_approved: true,
        display_name: "Synthetic Contrary Source Must Not Appear",
        url: "https://contrary.example.invalid/synthetic-note",
        published_at: null,
        observed_at: null,
        excerpt_public_use_approved: true,
        excerpt: "Synthetic contrary excerpt.",
      },
    ],
    impacts: makeSyntheticImpacts(),
  };
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function assertExactKeys(value: unknown, openApiKeys: readonly string[]): void {
  assert.equal(value !== null && typeof value === "object", true);
  assert.deepEqual(Object.keys(value as object).sort(), [...openApiKeys].sort());
}

function assertProjectionError(action: () => unknown, code: PublicProjectionErrorCode): void {
  assert.throws(action, (error: unknown) => {
    assert.ok(error instanceof PublicProjectionError);
    assert.equal(error.code, code);
    assert.equal(error.message.includes("PRIVATE"), false);
    return true;
  });
}

const openApiKeys = {
  eventView: ["event_id", "version", "title", "summary", "category", "tags", "lifecycle", "freshness", "event_time", "validity", "scope", "claims", "impacts", "published_at"],
  publicClaim: ["claim_id", "text", "event_time", "validity", "scope", "qualifiers", "evidence_label", "sources"],
  publicSource: ["display_name", "url", "published_at", "observed_at", "excerpt"],
  publicImpact: ["impact_id", "version", "impact_type", "title", "description", "lifecycle", "freshness", "event_time", "validity", "scope"],
  publicScope: ["places", "services", "institutions", "audiences"],
  tag: ["namespace", "value"],
  freshness: ["status", "evaluated_at", "review_due_at", "basis"],
  timeScope: ["start", "end", "precision"],
  validity: ["valid_from", "valid_until"],
};

test("projects the exact OpenAPI EventView allowlist with synthetic test lookups", () => {
  const result = projectPublicEvent(makeSyntheticEvent(), makeSyntheticLookups());
  const serialized = JSON.stringify(result);

  assertExactKeys(result, openApiKeys.eventView);
  assertExactKeys(result.scope, openApiKeys.publicScope);
  assertExactKeys(result.freshness, openApiKeys.freshness);
  assertExactKeys(result.event_time, openApiKeys.timeScope);
  assertExactKeys(result.validity, openApiKeys.validity);
  assert.deepEqual(result.scope, {
    places: [],
    services: [],
    institutions: [],
    audiences: ["Synthetic student audience"],
  });
  assert.equal(result.scope.audiences.includes("audience-synthetic-students"), false);
  assert.equal(result.tags[0]?.namespace, "audience");
  assert.equal(result.claims[0]?.claim_id, "claim-synthetic-a");
  assert.deepEqual(result.claims[0]?.sources[0], {
    display_name: "Synthetic Office One",
    url: "https://office-one.example.invalid/synthetic-notice",
    published_at: "2026-09-24T20:00:00Z",
    observed_at: "2026-09-25T03:10:00+07:00",
    excerpt: "Synthetic excerpt one.",
  });
  assert.notEqual(result.claims[0]?.sources[0]?.published_at, result.claims[0]?.sources[0]?.observed_at);
  assert.equal(result.claims[1]?.claim_id, "claim-synthetic-b");
  assert.deepEqual(result.claims[1]?.sources.map((source) => source.display_name), [
    "Synthetic Office Three",
    "Synthetic Office Two",
  ]);
  assert.equal(result.claims[1]?.sources[0]?.published_at, null);
  assert.equal(result.claims[1]?.sources[0]?.observed_at, "2026-09-25T03:15:00Z");
  assert.equal(result.claims[1]?.sources[1]?.excerpt, null);
  assert.deepEqual(result.impacts.map((impact) => impact.impact_id), ["impact-synthetic-a", "impact-synthetic-z"]);
  assert.deepEqual(result.impacts[0]?.scope.audiences, ["Synthetic student audience"]);

  for (const claim of result.claims) {
    assertExactKeys(claim, openApiKeys.publicClaim);
    assertExactKeys(claim.event_time, openApiKeys.timeScope);
    assertExactKeys(claim.validity, openApiKeys.validity);
    assertExactKeys(claim.scope, openApiKeys.publicScope);
    for (const source of claim.sources) assertExactKeys(source, openApiKeys.publicSource);
  }
  for (const impact of result.impacts) {
    assertExactKeys(impact, openApiKeys.publicImpact);
    assertExactKeys(impact.freshness, openApiKeys.freshness);
    assertExactKeys(impact.event_time, openApiKeys.timeScope);
    assertExactKeys(impact.validity, openApiKeys.validity);
    assertExactKeys(impact.scope, openApiKeys.publicScope);
  }
  for (const tag of result.tags) assertExactKeys(tag, openApiKeys.tag);

  for (const marker of [
    "trace-synthetic-private-marker",
    "origin-synthetic-private-marker",
    "decision-synthetic-private-marker",
    "PRIVATE_",
    "SYNTHETIC_UNAPPROVED_EXCERPT_MARKER",
    "contrary.example.invalid",
    syntheticHashOne,
    syntheticHashTwo,
    syntheticHashThree,
  ]) assert.equal(serialized.includes(marker), false, `serialized public output must omit ${marker}`);
});

test("projection ordering is stable when stored and lookup arrays arrive in another order", () => {
  const event = makeSyntheticEvent();
  const reversedEvent = clone(event);
  (reversedEvent.claims as Array<Record<string, unknown>>).reverse();
  (reversedEvent.impact_refs as Array<Record<string, unknown>>).reverse();
  (reversedEvent.tags as Array<Record<string, unknown>>).reverse();
  const claims = reversedEvent.claims as Array<Record<string, unknown>>;
  (claims[1]!.support as Array<Record<string, unknown>>).reverse();

  const lookups = makeSyntheticLookups();
  const shuffledLookups: PublicProjectionLookups = {
    scopeNames: [...lookups.scopeNames].reverse(),
    publicAttributions: [...lookups.publicAttributions].reverse(),
    impacts: [...lookups.impacts].reverse(),
  };
  assert.deepEqual(projectPublicEvent(reversedEvent, shuffledLookups), projectPublicEvent(event, lookups));
});

test("non-live and withdrawn event versions fail closed", () => {
  for (const datasetKind of ["historical", "synthetic"]) {
    const event = makeSyntheticEvent();
    event.dataset_kind = datasetKind;
    assertProjectionError(() => projectPublicEvent(event, makeSyntheticLookups()), "EVENT_NOT_PUBLIC");
  }

  const withdrawn = makeSyntheticEvent();
  withdrawn.publication_status = "withdrawn";
  assertProjectionError(() => projectPublicEvent(withdrawn, makeSyntheticLookups()), "EVENT_NOT_PUBLIC");
});

test("invalid consumed event, claim, freshness, time, and version fields fail closed", () => {
  const mutations: Array<(event: Record<string, unknown>) => void> = [
    (event) => { event.category = "unrecognized_category"; },
    (event) => { event.version = 3.5; },
    (event) => { event.supersedes_version = 0; },
    (event) => { (event.freshness as Record<string, unknown>).evaluated_at = "2026-02-30T03:00:00Z"; },
    (event) => { (event.event_time as Record<string, unknown>).precision = "approximate"; },
    (event) => { (event.scope as Record<string, unknown>).audience_ids = ["not valid id!"]; },
    (event) => {
      const claims = event.claims as Array<Record<string, unknown>>;
      claims[0]!.evidence_label = "under_review";
    },
    (event) => {
      const claims = event.claims as Array<Record<string, unknown>>;
      (claims[0]!.support as Array<Record<string, unknown>>)[0]!.span_end = 0;
    },
  ];

  for (const mutate of mutations) {
    const event = makeSyntheticEvent();
    mutate(event);
    assertProjectionError(() => projectPublicEvent(event, makeSyntheticLookups()), "INVALID_EVENT");
  }
});

test("range times preserve mixed date/date-time endpoints and reject inverted same-type endpoints", () => {
  const mixedRange = makeSyntheticEvent();
  mixedRange.event_time = {
    start: "2026-09-25",
    end: "2026-09-25T10:00:00Z",
    precision: "range",
  };
  assert.deepEqual(
    projectPublicEvent(mixedRange, makeSyntheticLookups()).event_time,
    { start: "2026-09-25", end: "2026-09-25T10:00:00Z", precision: "range" },
  );

  // A date-only endpoint has coarser precision than a timestamp. Preserve a
  // mixed pair without inferring an ordering across those precision levels.
  const mixedPrecision = makeSyntheticEvent();
  mixedPrecision.event_time = {
    start: "2026-09-26",
    end: "2026-09-25T10:00:00Z",
    precision: "range",
  };
  assert.deepEqual(
    projectPublicEvent(mixedPrecision, makeSyntheticLookups()).event_time,
    { start: "2026-09-26", end: "2026-09-25T10:00:00Z", precision: "range" },
  );

  const invertedTimestamps = makeSyntheticEvent();
  invertedTimestamps.event_time = {
    start: "2026-09-25T10:00:00Z",
    end: "2026-09-25T09:00:00Z",
    precision: "range",
  };
  assertProjectionError(() => projectPublicEvent(invertedTimestamps, makeSyntheticLookups()), "INVALID_EVENT");
});

test("missing, ambiguous, or invalid scope names fail closed", () => {
  const event = makeSyntheticEvent();
  const lookups = makeSyntheticLookups();
  assertProjectionError(() => projectPublicEvent(event, { ...lookups, scopeNames: [] }), "NAME_LOOKUP_FAILED");
  assertProjectionError(() => projectPublicEvent(event, {
    ...lookups,
    scopeNames: [lookups.scopeNames[0], clone(lookups.scopeNames[0])],
  }), "NAME_LOOKUP_FAILED");
  assertProjectionError(() => projectPublicEvent(event, {
    ...lookups,
    scopeNames: [{ entity_type: "audience", id: "audience-synthetic-students", display_name: "  " }],
  }), "NAME_LOOKUP_FAILED");
});

test("support attributions must match exact span, be approved, and use HTTPS", () => {
  const event = makeSyntheticEvent();
  const lookups = makeSyntheticLookups();
  assertProjectionError(() => projectPublicEvent(event, { ...lookups, publicAttributions: [] }), "ATTRIBUTION_FAILED");

  const duplicate: PublicProjectionLookups = {
    ...lookups,
    publicAttributions: [...lookups.publicAttributions, clone(lookups.publicAttributions[0])],
  };
  assertProjectionError(() => projectPublicEvent(event, duplicate), "ATTRIBUTION_FAILED");

  for (const mutate of [
    (record: Record<string, unknown>) => { record.public_use_approved = false; },
    (record: Record<string, unknown>) => { record.url = "http://office-one.example.invalid/not-approved"; },
    (record: Record<string, unknown>) => { record.published_at = "not-a-timestamp"; },
    (record: Record<string, unknown>) => { record.span_end = 15; },
  ]) {
    const broken = clone(lookups);
    const attributions = broken.publicAttributions as Array<Record<string, unknown>>;
    mutate(attributions[0]!);
    assertProjectionError(() => projectPublicEvent(event, broken), "ATTRIBUTION_FAILED");
  }
});

test("impacts must exactly match every event reference and have no extras", () => {
  const event = makeSyntheticEvent();
  const lookups = makeSyntheticLookups();
  assertProjectionError(() => projectPublicEvent(event, { ...lookups, impacts: [] }), "IMPACT_RESOLUTION_FAILED");

  const wrongVersion = clone(lookups);
  const wrongVersionImpacts = wrongVersion.impacts as Array<Record<string, unknown>>;
  wrongVersionImpacts[0]!.version = 1;
  assertProjectionError(() => projectPublicEvent(event, wrongVersion), "IMPACT_RESOLUTION_FAILED");

  const wrongEventVersion = clone(lookups);
  const wrongEventVersionImpacts = wrongEventVersion.impacts as Array<Record<string, unknown>>;
  wrongEventVersionImpacts[0]!.event_version = 1;
  assertProjectionError(() => projectPublicEvent(event, wrongEventVersion), "IMPACT_RESOLUTION_FAILED");

  const wrongDataset = clone(lookups);
  const wrongDatasetImpacts = wrongDataset.impacts as Array<Record<string, unknown>>;
  wrongDatasetImpacts[0]!.dataset_kind = "synthetic";
  assertProjectionError(() => projectPublicEvent(event, wrongDataset), "IMPACT_RESOLUTION_FAILED");

  const wrongEventId = clone(lookups);
  const wrongEventIdImpacts = wrongEventId.impacts as Array<Record<string, unknown>>;
  wrongEventIdImpacts[0]!.event_id = "event-synthetic-other";
  assertProjectionError(() => projectPublicEvent(event, wrongEventId), "IMPACT_RESOLUTION_FAILED");

  const unreferenced = clone(lookups);
  const extra = clone((unreferenced.impacts as Array<Record<string, unknown>>)[0]);
  (extra as Record<string, unknown>).impact_id = "impact-synthetic-unreferenced";
  (unreferenced.impacts as Array<Record<string, unknown>>).push(extra);
  assertProjectionError(() => projectPublicEvent(event, unreferenced), "IMPACT_RESOLUTION_FAILED");

  const duplicate = clone(lookups);
  const duplicateImpacts = duplicate.impacts as Array<Record<string, unknown>>;
  duplicateImpacts.push(clone(duplicateImpacts[0]));
  assertProjectionError(() => projectPublicEvent(event, duplicate), "IMPACT_RESOLUTION_FAILED");
});

test("malformed lookup container returns a bounded typed error without echoing input", () => {
  assertProjectionError(() => projectPublicEvent(makeSyntheticEvent(), null as unknown as PublicProjectionLookups), "LOOKUPS_INVALID");
  assertProjectionError(() => projectPublicEvent("PRIVATE_EVENT_MARKER", makeSyntheticLookups()), "INVALID_EVENT");
});
