import assert from "node:assert/strict";
import test from "node:test";
import {
  buildEventRecordV2,
  domainClaimsFor,
  domainEventTime,
  domainFreshness,
  EMPTY_SCOPE,
  NULL_VALIDITY,
  type DomainEvidenceRef,
} from "../src/layers/l4-application-integration/event-record-v2.js";
import { projectPublicEvent } from "../src/layers/l4-application-integration/public-projection.js";
import {
  PublicReadModel,
  proposalToEventDetail,
} from "../src/layers/l4-application-integration/public-read-model.js";

// F-14: an event start is only ever a time the source gave. Processing, publish and "now" times
// are never used as the event start, and freshness is not "current" by construction.
const processingTime = "2026-11-13T02:00:00.000Z";
const sourceStatus = { listPublicSourceStatus: () => [] } as never;

function proposal(overrides: Record<string, unknown> = {}) {
  return {
    schema_version: "2.0",
    proposal_id: "prop-time-001",
    title: "Banjir merendam Jalan DI Panjaitan",
    incident_type: "genangan_air_luapan_saluran",
    primary_category: "disasters_weather",
    severity: "medium",
    event_time: { precision: "unknown", value: null },
    location_label: "Cawang, Jakarta Timur",
    coordinates: null,
    claims: [
      {
        claim_id: "claim-1",
        claim_text: "Genangan setinggi 50 cm.",
        evidence_label: "attributed_report",
        support_assessment: "supported",
        quote_text: "Banjir setinggi 50 cm",
        source_url: "https://example.invalid/berita/1",
        outlet: "Contoh Berita",
        source_id: "src-example",
      },
    ],
    impacts: [],
    proposed_at: processingTime,
    ...overrides,
  };
}

function rawInput(overrides: Record<string, unknown> = {}) {
  return {
    proposal_id: "raw-time-001",
    title: "Pohon tumbang di Kebayoran Baru",
    primary_category: "fires_infrastructure_hazards",
    location_label: "Kebayoran Baru, Jakarta Selatan",
    published_at: processingTime,
    ...overrides,
  };
}

test("F-14: a proposal without an event time has no event start and unknown precision", () => {
  const detail = proposalToEventDetail(proposal({ event_time: undefined }) as never);
  assert.deepEqual(detail.event_time, { start: null, end: null, precision: "unknown" });
});

test("F-14: a proposal with unknown precision keeps no event start even if a value is present", () => {
  const detail = proposalToEventDetail(
    proposal({ event_time: { precision: "unknown", value: processingTime } }) as never,
  );
  assert.equal(detail.event_time.start, null);
  assert.equal(detail.event_time.precision, "unknown");
});

test("F-14: an exact time without a value is treated as no event time, not as proposed_at", () => {
  const detail = proposalToEventDetail(
    proposal({ event_time: { precision: "exact", value: null } }) as never,
  );
  assert.deepEqual(detail.event_time, { start: null, end: null, precision: "unknown" });
});

test("F-14: a proposal without an event time is not marked current and invents no validity start", () => {
  const detail = proposalToEventDetail(proposal({ event_time: undefined }) as never);
  assert.deepEqual(detail.freshness, {
    status: "needs_update",
    evaluated_at: processingTime,
    review_due_at: null,
    basis: "unknown",
  });
  assert.deepEqual(detail.validity, { valid_from: null, valid_until: null });
});

test("F-14: claims of a proposal without an event time carry no event start", () => {
  const detail = proposalToEventDetail(proposal({ event_time: undefined }) as never);
  assert.equal(detail.claims.length, 1);
  assert.deepEqual(detail.claims[0]!.event_time, { start: null, end: null, precision: "unknown" });
});

test("F-14 control: a proposal with a source event time keeps its start, precision and current freshness", () => {
  const detail = proposalToEventDetail(
    proposal({ event_time: { precision: "exact", value: "2026-11-12T08:30:00+07:00" } }) as never,
  );
  assert.deepEqual(detail.event_time, {
    start: "2026-11-12T01:30:00.000Z",
    end: null,
    precision: "exact",
  });
  assert.equal(detail.freshness.status, "current");
  assert.equal(detail.freshness.basis, "fast_observation_review");
  assert.deepEqual(detail.validity, { valid_from: "2026-11-12T01:30:00.000Z", valid_until: null });
  assert.equal(detail.claims[0]!.event_time.start, "2026-11-12T01:30:00.000Z");
  assert.equal(detail.claims[0]!.event_time.precision, "exact");
});

test("F-14: a raw input without an event time is listed and detailed with no event start", () => {
  PublicReadModel.clearPublishedEvents();
  const model = new PublicReadModel(sourceStatus, [], [rawInput() as never]);
  const [event] = model.events(new URLSearchParams()).data;
  assert.ok(event, "the raw input is listed");
  assert.deepEqual(event.event_time, { start: null, end: null, precision: "unknown" });
  assert.equal(event.freshness.status, "needs_update");
  assert.equal(event.freshness.basis, "unknown");
  assert.equal(model.detail(event.event_id)?.event_time.start, null);
  PublicReadModel.clearPublishedEvents();
});

test("F-14: a raw input keeps its own source event time as the event start", () => {
  PublicReadModel.clearPublishedEvents();
  const model = new PublicReadModel(sourceStatus, [], [
    rawInput({ event_time: { precision: "exact", value: "2026-11-12T08:30:00+07:00" } }) as never,
  ]);
  const [event] = model.events(new URLSearchParams()).data;
  assert.ok(event, "the raw input is listed");
  assert.equal(event.event_time.start, "2026-11-12T01:30:00.000Z");
  assert.equal(event.event_time.precision, "exact");
  assert.equal(event.freshness.status, "current");
  PublicReadModel.clearPublishedEvents();
});

test("F-14: a date filter does not match an event that has no event start", () => {
  PublicReadModel.clearPublishedEvents();
  const model = new PublicReadModel(sourceStatus, [], [rawInput() as never]);
  const page = model.events(new URLSearchParams("from=2026-11-01T00:00:00Z"));
  assert.equal(page.data.length, 0);
  PublicReadModel.clearPublishedEvents();
});

/* HOSTED-21 (owner decision 17 Nov 2026): an event with no event time is accepted by the stored record and the public
   projection, shown with its time unknown, and its source time is never its processing time. */

test("HOSTED-21: the stored v2 record of an event with no event time is accepted by the public projection", () => {
  const dto = proposal({ event_time: { precision: "unknown", value: null } }) as never;
  const eventTime = domainEventTime({ precision: "unknown", value: null });
  assert.deepEqual(eventTime, { start: null, end: null, precision: "unknown" });
  const support: DomainEvidenceRef[] = [{
    report_revision_id: "rev-f14-no-time-001",
    permitted_text_hash: "a".repeat(64),
    span_start: 0,
    span_end: 12,
    offset_unit: "unicode_code_points",
    relation: "supports",
  }];
  const record = buildEventRecordV2({
    datasetKind: "live",
    traceId: "trace-f14-no-time-001",
    eventId: "prop-time-001",
    version: 1,
    supersedesVersion: null,
    decisionId: "dec-f14-no-time-001",
    status: "published",
    statusAt: processingTime,
    withdrawalReason: null,
    title: "Banjir merendam Jalan DI Panjaitan",
    summary: "Banjir merendam Jalan DI Panjaitan",
    category: "disasters_weather",
    lifecycle: "ongoing",
    tags: [],
    freshness: domainFreshness(eventTime, processingTime),
    eventTime,
    validity: NULL_VALIDITY,
    scope: { ...EMPTY_SCOPE, geometry_ids: [] },
    claims: domainClaimsFor(dto, "prop-time-001", eventTime, [
      { text: "Genangan setinggi 50 cm.", evidence_label: "attributed_report" },
    ], { support, originIdsByClaim: [["origin-f14-no-time-001"]] }),
  });
  assert.deepEqual(record.event_time, { start: null, end: null, precision: "unknown" });
  assert.equal(record.freshness.status, "needs_update");

  const view = projectPublicEvent(record, {
    scopeNames: [],
    impacts: [],
    publicAttributions: [{
      dataset_kind: "live",
      report_revision_id: "rev-f14-no-time-001",
      permitted_text_hash: "a".repeat(64),
      span_start: 0,
      span_end: 12,
      offset_unit: "unicode_code_points",
      relation: "supports",
      public_use_approved: true,
      display_name: "Contoh Berita",
      url: "https://example.invalid/berita/1",
      published_at: null,
      observed_at: null,
      retrieved_at: null,
      excerpt_public_use_approved: false,
      excerpt: null,
    }],
  }, { locationLabelPresent: true });
  assert.deepEqual(view.event_time, { start: null, end: null, precision: "unknown" });
  assert.equal(view.freshness.status, "needs_update");
  assert.equal(view.freshness.basis, "unknown");
  assert.equal(view.location_display, "whole_view");
  assert.equal(view.claims[0]!.event_time.precision, "unknown");
  assert.equal(view.claims[0]!.sources[0]!.published_at, null, "no source time is invented");
});

test("HOSTED-21: a source publish time is never the processing time, and no source time is invented", () => {
  const detail = proposalToEventDetail(proposal({ event_time: undefined }) as never);
  assert.equal(detail.claims[0]!.sources[0]!.published_at, null);
  assert.equal(detail.claims[0]!.sources[0]!.observed_at, null);
  assert.notEqual(detail.claims[0]!.sources[0]!.published_at, processingTime);
  assert.equal(detail.published_at, processingTime, "the version's own publication time is the proposal time, not a source time");
});
