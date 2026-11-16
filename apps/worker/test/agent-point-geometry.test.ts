import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { createTestDatabase, type TestDatabase } from "../../db/test/harness.js";
import { seedProposalLineage, type ProposalLineage } from "../../db/test/proposal-lineage-fixture.js";
import { applyMigrations, readMigrations } from "../../db/src/migrations.js";
import { createEventProposalWriter, type EventProposalDto } from "../../db/src/event-proposal-writer.js";
import { createPublicEventListRepository } from "../../db/src/public-event-list.js";
import { createPublicEventSnapshotRepository } from "../../db/src/public-event-snapshot.js";
import { createPublicProjectionLookupRepository } from "../../db/src/public-projection-lookups.js";
import {
  AGENT_AUTO_PUBLISHER_ID,
  decideProposal,
  type ProposalDecisionDependencies,
  type ProposalDecisionOutcome,
} from "../src/layers/l4-application-integration/proposal-publication.js";
import {
  PublicEventDetailProjectionServiceError,
  PublicReadModel,
  proposalToEventDetail,
} from "../src/layers/l4-application-integration/public-read-model.js";
import { createPublicEventProjectionService } from "../src/layers/l4-application-integration/public-event-projection-service.js";
import { createPublicEventListProjectionService } from "../src/layers/l4-application-integration/public-event-list-projection-service.js";
import { PublicProjectionError, projectPublicEvent } from "../src/layers/l4-application-integration/public-projection.js";
import {
  publicPointLabel,
  publicPointOutcomeFor,
} from "../src/layers/l4-application-integration/public-point.js";

/**
 * HOSTED-10: the point rule for published events (owner decision, 17 Nov 2026). An event with an approximate in-box
 * coordinate gets one Point (model_approximate) in the in-memory read model. The publication role writes no geometry row,
 * so its decision records geometry_status "pending_geometry_writer". An event with no usable coordinate has no point and
 * no geometry row. It is the whole map view (location_display "whole_view"). A non-group event needs a place id or a
 * label. A group-specific critical notice may have neither. Authored fictional data, the real decision writer and PGlite.
 *
 * The DB list lists nothing for these events yet: no origin writer exists, so origin_ids stay empty and the strict
 * projector rejects them as INVALID_EVENT. The test pins that the page does not fail because of them.
 */

const MODEL_POINT: [number, number] = [106.871, -6.244];
const SUPPORT_HASH = "a".repeat(64);
const CLAIM_TEXT = "Genangan 50 cm di Cawang";
const PERMITTED = new Set(["source-detik"]);

let lineage: ProposalLineage | undefined;

interface ProposalOptions {
  readonly coordinates?: [number, number] | null;
  readonly locationLabel?: string | null;
  readonly primaryCategory?: string;
}

function proposal(proposalId: string, options: ProposalOptions = {}): EventProposalDto {
  const claim = {
    claim_id: "claim-1",
    claim_text: CLAIM_TEXT,
    evidence_label: "attributed_report" as const,
    support_assessment: "supported" as const,
    quote_text: CLAIM_TEXT,
    evidence_ref_id: "chk-" + proposalId,
    source_id: "source-detik",
    outlet: "Detik News",
    source_url: "https://news.example/" + proposalId,
  };
  return {
    schema_version: "2.0",
    ...(lineage ?? {}),
    proposal_id: proposalId,
    incident_id: "inc-" + proposalId,
    title: "Genangan di Cawang",
    incident_type: "genangan_air_luapan_saluran",
    primary_category: options.primaryCategory ?? "disasters_weather",
    compatibility_category: "flood",
    severity: "medium",
    event_time: { precision: "exact", value: "2026-11-10T08:00:00.000Z" },
    location_label: options.locationLabel === undefined ? "Cawang, Jakarta Timur" : options.locationLabel,
    coordinates: options.coordinates === undefined ? null : options.coordinates,
    claims: [claim],
    impacts: [],
    interpretation_category: null,
    source_id: "source-detik",
    is_multi_source: false,
    source_count: 1,
    has_discrepancy: false,
    discrepancy_summary: null,
    discrepancies: [],
    caveats: [],
    correlation_relationship: "primary_initial",
    proposed_at: "2026-11-10T08:05:00.000Z",
  } as EventProposalDto;
}

// ---------------------------------------------------------------------------------------------------------------------
// The one point rule and the in-memory read model (the DTO path that local live mode serves).
// ---------------------------------------------------------------------------------------------------------------------

describe("HOSTED-10 point rule", () => {
  it("(a) an agent coordinate inside the box is the one Point, labelled model_approximate", () => {
    assert.deepEqual(
      publicPointOutcomeFor({ category: "disasters_weather", locationLabel: "Cawang", coordinates: MODEL_POINT }),
      { status: "point", coordinates: MODEL_POINT },
    );

    const detail = proposalToEventDetail(proposal("prop-h10-dto-a", { coordinates: MODEL_POINT }), undefined, { version: 1 });
    assert.equal(detail.location_display, "point");
    assert.equal(detail.geometries.length, 1);
    assert.equal(detail.geometries[0]!.role, "approximate_place");
    assert.deepEqual(detail.geometries[0]!.geometry, { type: "Point", coordinates: MODEL_POINT });
    assert.equal(detail.geometries[0]!.precision_m, null, "no radius is invented");
    assert.equal(detail.geometries[0]!.label, "Cawang, Jakarta Timur");
  });

  it("(b) no usable coordinate gives no geometry, location_display whole_view, and the event is listed", () => {
    const cases: Array<[number, number] | null> = [null, [107.6, -6.9]];
    for (const coordinates of cases) {
      const detail = proposalToEventDetail(proposal("prop-h10-dto-b", { coordinates }), undefined, { version: 1 });
      assert.equal(detail.title, "Genangan di Cawang", "the event is listed");
      assert.equal(detail.location_display, "whole_view");
      assert.deepEqual(detail.geometries, [], "no point is written for a whole-view event");
    }
    // The Jakarta-centre fallback is gone: no fallback point, label or coordinate reaches the detail.
    const detail = proposalToEventDetail(proposal("prop-h10-dto-b"), undefined, { version: 1 });
    assert.doesNotMatch(JSON.stringify(detail), /Perkiraan pusat Jakarta|106\.82/u);
  });

  it("(c) a non-group event with neither a place id nor a label is INVALID_EVENT, with or without a coordinate", () => {
    const cases: Array<[number, number] | null> = [MODEL_POINT, null];
    for (const coordinates of cases) {
      assert.throws(
        () => proposalToEventDetail(proposal("prop-h10-dto-c", { locationLabel: null, coordinates }), undefined, { version: 1 }),
        (error: unknown) => error instanceof PublicEventDetailProjectionServiceError && error.message === "INVALID_EVENT",
      );
    }
  });

  it("(d) a group-specific critical notice with no location is listed as a whole view, with no point", () => {
    const detail = proposalToEventDetail(
      proposal("prop-h10-dto-d", { locationLabel: null, coordinates: null, primaryCategory: "group_specific_critical_notices" }),
      undefined,
      { version: 1 },
    );
    assert.equal(detail.category, "group_specific_critical_notices");
    assert.equal(detail.location_display, "whole_view");
    assert.deepEqual(detail.geometries, []);
    assert.deepEqual(
      publicPointOutcomeFor({ category: "group_specific_critical_notices", locationLabel: null, coordinates: null }),
      { status: "not_required_group_notice" },
    );
  });

  it("a group notice with a label but no coordinate is a whole view, not a fallback point", () => {
    assert.deepEqual(
      publicPointOutcomeFor({ category: "group_specific_critical_notices", locationLabel: "Kemang", coordinates: null }),
      { status: "whole_view" },
    );
  });

  it("the point label is the event's own label, or a neutral one", () => {
    assert.equal(publicPointLabel("Cawang, Jakarta Timur"), "Cawang, Jakarta Timur");
    assert.equal(publicPointLabel(null), "Lokasi perkiraan dari laporan");
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// The projector's target rule (pure). The origin and attribution rows are fixtures. No production writer creates them.
// ---------------------------------------------------------------------------------------------------------------------

function eventRecord(category: string, geometryIds: readonly string[], placeIds: readonly string[] = []): Record<string, unknown> {
  const scope = { place_ids: [...placeIds], service_ids: [], institution_ids: [], audience_ids: [], geometry_ids: [...geometryIds] };
  const claim = {
    claim_id: "claim-1",
    text: CLAIM_TEXT,
    event_time: { start: "2026-11-10T08:00:00.000Z", end: null, precision: "exact" },
    validity: { valid_from: null, valid_until: null },
    scope: { ...scope },
    qualifiers: [],
    support: [{
      report_revision_id: "rev-h10",
      permitted_text_hash: SUPPORT_HASH,
      span_start: 0,
      span_end: 10,
      offset_unit: "unicode_code_points",
      relation: "supports",
    }],
    contradictions: [],
    context_evidence: [],
    origin_ids: ["orig-h10"],
    evidence_label: "attributed_report",
  };
  return {
    schema_version: "2.0",
    trace_id: "trace-h10",
    record_type: "Event",
    dataset_kind: "live",
    event_id: "evt-h10",
    version: 1,
    supersedes_version: null,
    title: "Genangan di Cawang",
    summary: CLAIM_TEXT,
    category,
    tags: [{ namespace: "topic", value: "genangan_air" }],
    lifecycle: "ongoing",
    freshness: { status: "current", evaluated_at: "2026-11-10T08:05:00.000Z", review_due_at: null, basis: "fast_observation_review" },
    event_time: { start: "2026-11-10T08:00:00.000Z", end: null, precision: "exact" },
    validity: { valid_from: null, valid_until: null },
    scope,
    claims: [claim],
    impact_refs: [],
    publication_status: "published",
    withdrawal_reason: null,
    publication_decision_id: "dec-h10",
    published_at: "2026-11-10T08:05:00.000Z",
    withdrawn_at: null,
  };
}

const attributionLookups = {
  scopeNames: [],
  publicAttributions: [{
    dataset_kind: "live",
    report_revision_id: "rev-h10",
    permitted_text_hash: SUPPORT_HASH,
    span_start: 0,
    span_end: 10,
    offset_unit: "unicode_code_points",
    relation: "supports",
    public_use_approved: true,
    display_name: "Detik News",
    url: "https://news.example/h10",
    published_at: null,
    observed_at: null,
    excerpt_public_use_approved: false,
    excerpt: null,
  }],
  impacts: [],
};

describe("HOSTED-10 projector target rule", () => {
  it("(c) a non-group event with no place and no geometry is INVALID_EVENT", () => {
    assert.throws(
      () => projectPublicEvent(eventRecord("disasters_weather", []), attributionLookups),
      (error: unknown) => error instanceof PublicProjectionError && error.code === "INVALID_EVENT",
    );
  });

  it("a geometry alone is a public target, so an event needs no gazetteer place id", () => {
    const view = projectPublicEvent(eventRecord("disasters_weather", ["geo-h10"]), attributionLookups);
    assert.deepEqual(view.scope.places, []);
    assert.equal(view.claims.length, 1);
  });

  it("(d) a group notice with no location is listed without a target", () => {
    const view = projectPublicEvent(eventRecord("group_specific_critical_notices", []), attributionLookups);
    assert.equal(view.category, "group_specific_critical_notices");
    assert.deepEqual(view.scope.places, []);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// The publication transaction and the public geometry reader (DB path, PGlite).
// ---------------------------------------------------------------------------------------------------------------------

describe("HOSTED-10 publication writes the point and its evidence", () => {
  let db: TestDatabase;
  let deps: ProposalDecisionDependencies;
  const persist = (value: EventProposalDto) => createEventProposalWriter(db.executor).persistProposal(value, "live");
  const auto = (proposalId: string): Promise<ProposalDecisionOutcome> => decideProposal(deps, {
    proposalId,
    action: "auto_publish",
    actor: { kind: "agent", actorId: AGENT_AUTO_PUBLISHER_ID },
  });
  const moderate = (proposalId: string): Promise<ProposalDecisionOutcome> => decideProposal(deps, {
    proposalId,
    action: "publish",
    actor: { kind: "moderator", actorId: "fictional-moderator-rep" },
  });

  /** The version-1 record of the event the proposal publishes. The event id is the proposal's incident id. */
  async function currentRecord(proposalId: string): Promise<Record<string, any>> {
    const result = await db.executor.query<{ record_json: Record<string, any> }>(
      "SELECT record_json FROM waspada.event_versions WHERE dataset_kind = 'live' AND event_id = $1 AND version = 1",
      ["inc-" + proposalId],
    );
    return result.rows[0]!.record_json;
  }

  async function decisionRecord(proposalId: string): Promise<Record<string, unknown>> {
    const result = await db.executor.query<{ record_json: Record<string, unknown> }>(
      "SELECT record_json FROM waspada.publication_decisions WHERE dataset_kind = 'live' AND proposal_id = $1",
      [proposalId],
    );
    return result.rows[0]!.record_json;
  }

  async function geometryRowCount(): Promise<number> {
    const result = await db.executor.query<{ n: number }>("SELECT COUNT(*)::int AS n FROM waspada.geometries");
    return result.rows[0]!.n;
  }

  before(async () => {
    db = await createTestDatabase();
    await applyMigrations(db.executor, await readMigrations(new URL("../../db/migrations/", import.meta.url)));
    lineage = await seedProposalLineage(db.executor, "hosted10");
    // The public views read only a dataset the namespace config names as live.
    await db.executor.query("INSERT INTO waspada.dataset_namespace_config (singleton, dataset_kind) VALUES (true, 'live')");
    deps = {
      executor: db.executor,
      datasetKind: "live",
      checkPublicDisplay: async (sourceId: string) => PERMITTED.has(sourceId),
    };
    PublicReadModel.clearPublishedEvents();
  });

  after(async () => {
    await db?.close();
  });

  it("(a) an agent coordinate inside the box is pending_geometry_writer, with no geometry row", async () => {
    const rowsBefore = await geometryRowCount();
    await persist(proposal("prop-h10-db-a", { coordinates: MODEL_POINT }));
    const outcome = await auto("prop-h10-db-a");
    assert.equal(outcome.status, "published", JSON.stringify(outcome));

    const record = await currentRecord("prop-h10-db-a");
    assert.deepEqual(record.scope.geometry_ids, [], "the publication role writes no geometry row");
    assert.deepEqual(record.claims[0].scope.geometry_ids, []);
    assert.equal(record.claims[0].support.length, 1, "the claim cites the persisted span it was built from");
    assert.equal(record.claims[0].support[0].report_revision_id, "rev-lineage-hosted10");

    const decision = await decisionRecord("prop-h10-db-a");
    assert.equal(decision.geometry_source, "model_approximate");
    assert.equal(decision.geometry_status, "pending_geometry_writer");
    assert.equal(await geometryRowCount(), rowsBefore, "no geometry row is written");
  });

  it("(b) no usable coordinate publishes as a whole view, with no geometry row", async () => {
    const rowsBefore = await geometryRowCount();
    await persist(proposal("prop-h10-db-b"));
    const outcome = await auto("prop-h10-db-b");
    assert.equal(outcome.status, "published", JSON.stringify(outcome));

    const record = await currentRecord("prop-h10-db-b");
    assert.deepEqual(record.scope.geometry_ids, []);
    const decision = await decisionRecord("prop-h10-db-b");
    assert.equal(decision.geometry_status, "whole_view");
    assert.equal(decision.geometry_source, null);
    assert.equal(await geometryRowCount(), rowsBefore, "no geometry row is written");
  });

  it("(c) an event with neither a place id nor a label is refused and writes nothing", async () => {
    await persist(proposal("prop-h10-db-c", { locationLabel: null, coordinates: MODEL_POINT }));
    const outcome = await auto("prop-h10-db-c");
    assert.deepEqual(outcome, { status: "denied", code: "publication_failed" });
    const rows = await db.executor.query<{ n: number }>(
      "SELECT COUNT(*)::int AS n FROM waspada.publication_decisions WHERE dataset_kind = 'live' AND proposal_id = 'prop-h10-db-c'",
    );
    assert.equal(rows.rows[0]!.n, 0);
  });

  it("(c2) a non-group event with neither a place id nor a label and no coordinate is INVALID_EVENT at publish", async () => {
    await persist(proposal("prop-h10-db-c2", { locationLabel: null, coordinates: null }));
    // The unchanged ADR-061 gate queues a location-less proposal for a moderator first.
    assert.deepEqual(await auto("prop-h10-db-c2"), { status: "queued", reasons: ["location_missing"] });
    // The moderator publish builds the DTO, which rejects the event as INVALID_EVENT, so nothing is written.
    const outcome = await moderate("prop-h10-db-c2");
    assert.deepEqual(outcome, { status: "denied", code: "publication_failed" });
    const rows = await db.executor.query<{ n: number }>(
      "SELECT COUNT(*)::int AS n FROM waspada.publication_decisions WHERE dataset_kind = 'live' AND proposal_id = 'prop-h10-db-c2'",
    );
    assert.equal(rows.rows[0]!.n, 0);
  });

  it("(d) a group notice with no location is listed by a moderator as a whole view, with no point", async () => {
    await persist(proposal("prop-h10-db-d", {
      locationLabel: null,
      coordinates: null,
      primaryCategory: "group_specific_critical_notices",
    }));
    // The automatic gate (ADR-061) still asks for a location, so it queues this notice for a moderator. That gate is
    // not changed here. A moderator publish runs the source gate only, which has no location check.
    const queued = await auto("prop-h10-db-d");
    assert.deepEqual(queued, { status: "queued", reasons: ["location_missing"] });

    const outcome = await moderate("prop-h10-db-d");
    assert.equal(outcome.status, "published", JSON.stringify(outcome));
    const record = await currentRecord("prop-h10-db-d");
    assert.deepEqual(record.scope.geometry_ids, []);
    assert.equal(record.category, "group_specific_critical_notices");
    assert.equal((await decisionRecord("prop-h10-db-d")).geometry_status, "not_required_group_notice");
  });

  it("the DB list lists none of these events yet and the page does not fail", async () => {
    // No origin writer exists, so origin_ids stay empty and the projector skips each event as INVALID_EVENT.
    const list = createPublicEventListProjectionService({
      candidates: createPublicEventListRepository(db.executor),
      projections: createPublicEventProjectionService({
        snapshots: createPublicEventSnapshotRepository(db.executor),
        lookups: createPublicProjectionLookupRepository(db.executor),
      }),
    });
    const page = await list.read();
    assert.deepEqual(page.events, []);
  });
});
