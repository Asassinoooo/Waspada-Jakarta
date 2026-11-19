import assert from "node:assert/strict";
import test from "node:test";
import type {
  CorrelatedIncidentCluster,
  StoredReportRevision,
} from "../src/layers/l1-data-knowledge/multisource-correlator.js";
import { generateCorrelatedProposal } from "../src/layers/l2-model-grounding/correlated-proposal-engine.js";
import {
  extractStatedDate,
  generateProposalFromReport,
  isCalendarDate,
} from "../src/layers/l2-model-grounding/proposal-engine.js";
import {
  buildEventRecordV2,
  domainClaimsFor,
  domainEventTime,
  domainFreshness,
  EMPTY_SCOPE,
  NULL_VALIDITY,
  type DomainEvidenceRef,
  type DomainTimeScope,
  type DomainValidity,
} from "../src/layers/l4-application-integration/event-record-v2.js";
import {
  PublicProjectionError,
  projectPublicEvent,
  type PublicProjectionLookups,
} from "../src/layers/l4-application-integration/public-projection.js";
import {
  PublicReadModel,
  proposalToEventDetail,
} from "../src/layers/l4-application-integration/public-read-model.js";

// HOSTED-29 (owner decision 18 Nov 2026): an event time the report gives only as a calendar date keeps precision
// "date" with start YYYY-MM-DD, end to end. It is never dropped to "unknown" and never turned into an hour.

const PUBLISHED_AT = "2026-10-27T03:30:00.000Z";
const PROCESSING_TIME = "2026-10-27T03:35:00.000Z";
const sourceStatus = { listPublicSourceStatus: () => [] } as never;

function report(id: string, sourceId: string, text: string): StoredReportRevision {
  return {
    report_revision_id: id,
    source_id: sourceId,
    canonical_url: `https://example.invalid/laporan/${id}`,
    permitted_text: text,
    permitted_text_hash: `hash-${id}`,
    published_at: PUBLISHED_AT,
    retrieved_at: PROCESSING_TIME,
    revision_status: "unreviewed",
    chunks: [{ chunk_index: 0, text, span_start: 0, span_end: Array.from(text).length }],
  };
}

function cluster(reports: readonly StoredReportRevision[]): CorrelatedIncidentCluster {
  const sources = Array.from(new Set(reports.map((r) => r.source_id)));
  return {
    cluster_id: "cluster-hosted29-001",
    primary_category: "flood",
    location_label: "Rawamangun, Jakarta Timur",
    coordinates: null,
    reports,
    is_multi_source: sources.length >= 2,
    sources,
  };
}

function eventTimeOf(reports: readonly StoredReportRevision[]) {
  return generateCorrelatedProposal(cluster(reports)).event_time;
}

test("HOSTED-29: a multi-source cluster whose reports state only a date keeps date precision", () => {
  const proposal = generateCorrelatedProposal(cluster([
    report("rep-h29-cit-001", "petabencana", "Banjir setinggi 60 cm di Rawamangun pada 26 Oktober 2026."),
    report("rep-h29-news-001", "source-antara-metro", "Banjir merendam Rawamangun, dilaporkan pada 26 Oktober 2026 setelah hujan deras."),
  ]));
  assert.equal(proposal.is_multi_source, true);
  assert.deepEqual(proposal.event_time, { precision: "date", value: "2026-10-26" });
});

test("HOSTED-29: a single-source cluster with a YYYY-MM-DD date keeps date precision", () => {
  assert.deepEqual(
    eventTimeOf([report("rep-h29-iso-001", "petabencana", "Genangan di Rawamangun tercatat pada 2026-10-26 dan masih berlangsung.")]),
    { precision: "date", value: "2026-10-26" },
  );
});

test("HOSTED-29: the correlated and single-report engines give the same stated date for the same text", () => {
  const text = "Banjir tergenang setinggi 60 cm di kawasan Rawamangun Jakarta Timur akibat hujan deras pada 26 Oktober 2026.";
  const single = generateProposalFromReport(report("rep-h29-single-001", "source-antara-metro", text));
  assert.ok(single !== null);
  assert.deepEqual(single.event_time, { precision: "date", value: "2026-10-26" });
  assert.deepEqual(eventTimeOf([report("rep-h29-single-001", "source-antara-metro", text)]), single.event_time);
});

test("HOSTED-29: a time range the reports state stays a range, even when another report gives only a date", () => {
  const eventTime = eventTimeOf([
    report("rep-h29-date-001", "petabencana", "Banjir di Rawamangun pada 26 Oktober 2026."),
    report("rep-h29-range-001", "source-antara-metro", "Banjir di Rawamangun dari jam 10.00 hingga 14.00 pada hari ini."),
  ]);
  assert.deepEqual(eventTime, { precision: "range", value: "dari jam 10.00 hingga 14.00" });
});

test("HOSTED-29: a report with no stated date gives unknown precision, and its publish time is not used", () => {
  const eventTime = eventTimeOf([
    report("rep-h29-none-001", "petabencana", "Banjir setinggi 50 cm di Rawamangun, pukul 14.30 WIB."),
  ]);
  assert.deepEqual(eventTime, { precision: "unknown", value: null });
});

test("HOSTED-29: a date that is not a real calendar day is not invented", () => {
  assert.equal(extractStatedDate("Banjir di Rawamangun pada 31 Februari 2026."), null);
  assert.equal(extractStatedDate("Banjir di Rawamangun tercatat 2026-02-30."), null);
  assert.deepEqual(
    eventTimeOf([report("rep-h29-bad-001", "petabencana", "Banjir di Rawamangun pada 31 Februari 2026.")]),
    { precision: "unknown", value: null },
  );
});

test("HOSTED-29: the shared date parsing accepts real calendar days, including a leap day", () => {
  assert.equal(isCalendarDate("2028-02-29"), true);
  assert.equal(isCalendarDate("2026-02-29"), false);
  assert.equal(isCalendarDate("2026-13-01"), false);
  assert.equal(isCalendarDate("2026-00-10"), false);
  assert.equal(extractStatedDate("Kebakaran di Kemang pada 1 Januari 2027."), "2027-01-01");
  assert.equal(extractStatedDate("Kebakaran di Kemang pada 29 Februari 2028."), "2028-02-29");
});

function proposal(eventTime: unknown): Record<string, unknown> {
  return {
    schema_version: "2.0",
    proposal_id: "prop-hosted29-001",
    title: "Banjir merendam Rawamangun",
    incident_type: "genangan_air_luapan_saluran",
    primary_category: "disasters_weather",
    severity: "medium",
    event_time: eventTime,
    location_label: "Rawamangun, Jakarta Timur",
    coordinates: null,
    claims: [
      {
        claim_id: "claim-1",
        claim_text: "Banjir merendam Rawamangun.",
        evidence_label: "attributed_report",
        support_assessment: "supported",
        quote_text: "Banjir merendam Rawamangun",
        source_url: "https://example.invalid/berita/29",
        outlet: "Contoh Berita",
        source_id: "src-example",
      },
    ],
    impacts: [],
    proposed_at: PROCESSING_TIME,
  };
}

function rawInput(eventTime: unknown): Record<string, unknown> {
  return {
    proposal_id: "raw-hosted29-001",
    title: "Pohon tumbang di Kebayoran Baru",
    primary_category: "fires_infrastructure_hazards",
    location_label: "Kebayoran Baru, Jakarta Selatan",
    published_at: PROCESSING_TIME,
    event_time: eventTime,
  };
}

test("HOSTED-29: the in-memory read model keeps a date as YYYY-MM-DD, gives its claims date precision and no validity start", () => {
  const detail = proposalToEventDetail(proposal({ precision: "date", value: "2026-10-26" }) as never);
  assert.deepEqual(detail.event_time, { start: "2026-10-26", end: null, precision: "date" });
  assert.deepEqual(detail.claims[0]!.event_time, { start: "2026-10-26", end: null, precision: "date" });
  assert.deepEqual(detail.validity, { valid_from: null, valid_until: null });
});

test("HOSTED-29: the in-memory read model keeps a date from a raw input as YYYY-MM-DD", () => {
  PublicReadModel.clearPublishedEvents();
  const model = new PublicReadModel(sourceStatus, [], [rawInput({ precision: "date", value: "2026-10-26" }) as never]);
  const [event] = model.events(new URLSearchParams()).data;
  assert.ok(event, "the raw input is listed");
  assert.deepEqual(event.event_time, { start: "2026-10-26", end: null, precision: "date" });
  PublicReadModel.clearPublishedEvents();
});

test("HOSTED-29: the in-memory read model gives unknown for a date that is not a real calendar day", () => {
  const detail = proposalToEventDetail(proposal({ precision: "date", value: "2026-02-31" }) as never);
  assert.deepEqual(detail.event_time, { start: null, end: null, precision: "unknown" });
  assert.deepEqual(detail.claims[0]!.event_time, { start: null, end: null, precision: "unknown" });
});

test("HOSTED-29 control: an exact time keeps exact precision on its claims and its validity start", () => {
  const detail = proposalToEventDetail(
    proposal({ precision: "exact", value: "2026-10-26T08:30:00+07:00" }) as never,
  );
  assert.deepEqual(detail.event_time, { start: "2026-10-26T01:30:00.000Z", end: null, precision: "exact" });
  assert.equal(detail.claims[0]!.event_time.precision, "exact");
  assert.deepEqual(detail.validity, { valid_from: "2026-10-26T01:30:00.000Z", valid_until: null });
});

function lookups(): PublicProjectionLookups {
  return {
    scopeNames: [],
    impacts: [],
    publicAttributions: [{
      dataset_kind: "live",
      report_revision_id: "rev-hosted29-001",
      permitted_text_hash: "b".repeat(64),
      span_start: 0,
      span_end: 12,
      offset_unit: "unicode_code_points",
      relation: "supports",
      public_use_approved: true,
      display_name: "Contoh Berita",
      url: "https://example.invalid/berita/29",
      published_at: null,
      observed_at: null,
      retrieved_at: null,
      excerpt_public_use_approved: false,
      excerpt: null,
    }],
  };
}

/** A stored schema 2.0 record for one published event whose event time (and claim time) is eventTime. */
function storedRecord(eventTime: DomainTimeScope, validity: DomainValidity = NULL_VALIDITY) {
  const support: DomainEvidenceRef[] = [{
    report_revision_id: "rev-hosted29-001",
    permitted_text_hash: "b".repeat(64),
    span_start: 0,
    span_end: 12,
    offset_unit: "unicode_code_points",
    relation: "supports",
  }];
  return buildEventRecordV2({
    datasetKind: "live",
    traceId: "trace-hosted29-001",
    eventId: "prop-hosted29-001",
    version: 1,
    supersedesVersion: null,
    decisionId: "dec-hosted29-001",
    status: "published",
    statusAt: PROCESSING_TIME,
    withdrawalReason: null,
    title: "Banjir merendam Rawamangun",
    summary: "Banjir merendam Rawamangun pada 26 Oktober 2026.",
    category: "disasters_weather",
    lifecycle: "ongoing",
    tags: [],
    freshness: domainFreshness(eventTime, PROCESSING_TIME),
    eventTime,
    validity,
    scope: { ...EMPTY_SCOPE, geometry_ids: [] },
    claims: domainClaimsFor(
      proposal({ precision: "date", value: "2026-10-26" }) as never,
      "prop-hosted29-001",
      eventTime,
      [{ text: "Banjir merendam Rawamangun.", evidence_label: "attributed_report" }],
      { support, originIdsByClaim: [["origin-hosted29-001"]] },
    ),
  });
}

test("HOSTED-29: the strict public projector accepts a stored date-precision event and keeps the date", () => {
  const eventTime = domainEventTime({ precision: "date", value: "2026-10-26" });
  assert.deepEqual(eventTime, { start: "2026-10-26", end: null, precision: "date" });
  const view = projectPublicEvent(storedRecord(eventTime), lookups(), { locationLabelPresent: true });
  assert.deepEqual(view.event_time, { start: "2026-10-26", end: null, precision: "date" });
  assert.deepEqual(view.claims[0]!.event_time, { start: "2026-10-26", end: null, precision: "date" });
});

test("HOSTED-29: the strict public projector accepts the in-memory read model's own date output", () => {
  const detail = proposalToEventDetail(proposal({ precision: "date", value: "2026-10-26" }) as never);
  const view = projectPublicEvent(storedRecord(detail.event_time, detail.validity), lookups(), {
    locationLabelPresent: true,
  });
  assert.deepEqual(view.event_time, { start: "2026-10-26", end: null, precision: "date" });
});

test("HOSTED-29: the strict public projector refuses a date that carries an invented hour", () => {
  const invented: DomainTimeScope = { start: "2026-10-26T00:00:00.000Z", end: null, precision: "date" };
  assert.throws(
    () => projectPublicEvent(storedRecord(invented), lookups(), { locationLabelPresent: true }),
    (error: unknown) => error instanceof PublicProjectionError && error.code === "INVALID_EVENT",
  );
});
