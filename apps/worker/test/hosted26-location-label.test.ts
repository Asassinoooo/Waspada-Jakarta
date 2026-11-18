import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { createTestDatabase, type TestDatabase } from "../../db/test/harness.js";
import { lineageIdsFor, seedProposalLineage } from "../../db/test/proposal-lineage-fixture.js";
import { applyMigrations, readMigrations } from "../../db/src/migrations.js";
import { createEventProposalWriter, type EventProposalDto } from "../../db/src/event-proposal-writer.js";
import { createPublicEventGeometriesRepository } from "../../db/src/public-event-geometries.js";
import { createPublicEventListRepository } from "../../db/src/public-event-list.js";
import { createPublicEventSnapshotRepository } from "../../db/src/public-event-snapshot.js";
import { createPublicProjectionLookupRepository } from "../../db/src/public-projection-lookups.js";
import {
  AGENT_AUTO_PUBLISHER_ID,
  decideProposal,
  pointGeometryIdFor,
  refreshPublishedLocation,
  withdrawPublishedEvent,
  type LocationRefreshOutcome,
  type ProposalDecisionDependencies,
} from "../src/layers/l4-application-integration/proposal-publication.js";
import { PublicReadModel } from "../src/layers/l4-application-integration/public-read-model.js";
import { createPublicEventProjectionService } from "../src/layers/l4-application-integration/public-event-projection-service.js";
import { createPublicEventListProjectionService } from "../src/layers/l4-application-integration/public-event-list-projection-service.js";
import { createPublicEventDetailProjectionService } from "../src/layers/l4-application-integration/public-event-detail-projection-service.js";
import { publicLocationLabel, publicPointLabel } from "../src/layers/l4-application-integration/public-point.js";

/**
 * HOSTED-26 (owner decision, 18 Nov 2026): the public location label and the location refresh. A publication stores the
 * sanitized label on its decision, and the public reader sees it as text (migration 055). A generic label such as
 * "DKI Jakarta (Lokasi spesifik belum teridentifikasi)" is never shown, and a point labelled with it falls back to the
 * neutral label. An event published before migration 054 or 055 lacks its point or its label. refreshPublishedLocation
 * writes one new version for it, from the same proposal, and only when something is missing. A withdrawn event is never
 * refreshed. The publication path is the real decideProposal, the lineage is authored synthetic data, and the database is
 * PGlite. The legacy versions are fabricated rows that match the state those migrations left.
 */

const SOURCE_ID = "source-lineage-h26";
const CLAIM_TEXT = "Genangan 50 cm di Cawang";
const PUBLISHED_AT = "2026-11-10T08:05:00.000Z";
const PERMITTED = new Set([SOURCE_ID]);
const MODEL_POINT_CAWANG: [number, number] = [106.871, -6.244];
const MODEL_POINT_GENERIC: [number, number] = [106.802, -6.262];
const MODEL_POINT_KEMANG: [number, number] = [106.8, -6.26];

const EVENT_LABELLED = "inc-h26-labelled";
const EVENT_GENERIC = "inc-h26-generic";
const EVENT_LEGACY_POINT = "inc-h26-legacy-point";
const EVENT_LEGACY_LABEL = "inc-h26-legacy-label";
const EVENT_WITHDRAWN = "inc-h26-withdrawn";

interface ProposalOptions {
  readonly incidentId: string;
  readonly coordinates?: [number, number] | null;
  readonly locationLabel?: string | null;
}

/** An authored proposal on the shared lineage. Its single report revision gives it support. */
function proposal(proposalId: string, options: ProposalOptions): EventProposalDto {
  const claim = {
    claim_id: "claim-1",
    claim_text: CLAIM_TEXT,
    evidence_label: "attributed_report" as const,
    support_assessment: "supported" as const,
    quote_text: CLAIM_TEXT,
    evidence_ref_id: "chk-" + proposalId,
    source_id: SOURCE_ID,
    outlet: "Fictional lineage source",
    source_url: "https://lineage.invalid/h26",
  };
  return {
    schema_version: "2.0",
    ...lineageIdsFor("h26"),
    proposal_id: proposalId,
    incident_id: options.incidentId,
    title: "Genangan di Cawang (fiktif)",
    incident_type: "genangan_air_luapan_saluran",
    primary_category: "disasters_weather",
    compatibility_category: "flood",
    severity: "medium",
    event_time: { precision: "exact", value: "2026-11-10T08:00:00.000Z" },
    location_label: options.locationLabel === undefined ? "Cawang, Jakarta Timur" : options.locationLabel,
    coordinates: options.coordinates === undefined ? null : options.coordinates,
    claims: [claim],
    impacts: [],
    interpretation_category: null,
    source_id: SOURCE_ID,
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
// The pure label rule.
// ---------------------------------------------------------------------------------------------------------------------

describe("HOSTED-26 public location label rule", () => {
  it("trims, collapses whitespace and caps the text at 200 characters", () => {
    assert.equal(publicLocationLabel("  Kemang,\n\t Jakarta   Selatan  "), "Kemang, Jakarta Selatan");
    assert.equal(publicLocationLabel("x".repeat(250))?.length, 200);
  });

  it("is null for an absent, empty or non-text label", () => {
    for (const value of [null, undefined, "", "   ", 42]) {
      assert.equal(publicLocationLabel(value), null, JSON.stringify(value));
    }
  });

  it("is null for a generic label that names no specific place, in any case and spacing", () => {
    for (const value of [
      "DKI Jakarta (Lokasi spesifik belum teridentifikasi)",
      "DKI Jakarta",
      "  dki   jakarta ",
      "jakarta",
      "Ruas Jalan Gatot Subroto, Jakarta Pusat (tidak teridentifikasi)",
      "Kemang Jakarta Selatan - Lokasi spesifik",
    ]) {
      assert.equal(publicLocationLabel(value), null, value);
    }
  });

  it("the point label keeps a specific label and falls back to the neutral label, never to a generic one", () => {
    assert.equal(publicPointLabel("Cawang, Jakarta Timur"), "Cawang, Jakarta Timur");
    assert.equal(publicPointLabel("DKI Jakarta (Lokasi spesifik belum teridentifikasi)"), "Lokasi perkiraan dari laporan");
    assert.equal(publicPointLabel("Jakarta"), "Lokasi perkiraan dari laporan");
    assert.equal(publicPointLabel(null), "Lokasi perkiraan dari laporan");
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// The publication, the public reader and the refresh (PGlite).
// ---------------------------------------------------------------------------------------------------------------------

describe("HOSTED-26 location label and refresh (PGlite, real publication path)", () => {
  let db: TestDatabase;
  let deps: ProposalDecisionDependencies;
  const checkPublicDisplay = async (sourceId: string): Promise<boolean> => PERMITTED.has(sourceId);
  let legacyCounter = 0;

  const persist = (value: EventProposalDto) => createEventProposalWriter(db.executor).persistProposal(value, "live");
  const auto = (proposalId: string): Promise<unknown> => decideProposal(deps, {
    proposalId,
    action: "auto_publish",
    actor: { kind: "agent", actorId: AGENT_AUTO_PUBLISHER_ID },
  });
  const refresh = (eventId: string): Promise<LocationRefreshOutcome> => refreshPublishedLocation(db.executor, {
    datasetKind: "live",
    eventId,
    checkPublicDisplay,
  });

  /** The stored record of one publication decision of an event version. */
  async function decisionOf(eventId: string, version: number): Promise<Record<string, any>> {
    const result = await db.executor.query<{ record_json: Record<string, any> }>(
      "SELECT record_json FROM waspada.publication_decisions WHERE dataset_kind = 'live' AND event_id = $1 AND event_version = $2",
      [eventId, version],
    );
    assert.equal(result.rows.length, 1, `one decision for ${eventId} version ${version}`);
    return result.rows[0]!.record_json;
  }

  async function versionOf(eventId: string, version: number): Promise<Record<string, any> | null> {
    const result = await db.executor.query<{ record_json: Record<string, any> }>(
      "SELECT record_json FROM waspada.event_versions WHERE dataset_kind = 'live' AND event_id = $1 AND version = $2",
      [eventId, version],
    );
    return result.rows[0]?.record_json ?? null;
  }

  async function versionCount(eventId: string): Promise<number> {
    const result = await db.executor.query<{ n: number }>(
      "SELECT COUNT(*)::int AS n FROM waspada.event_versions WHERE dataset_kind = 'live' AND event_id = $1",
      [eventId],
    );
    return result.rows[0]!.n;
  }

  async function claimGeometryLinks(eventId: string, version: number): Promise<Array<{ claim_id: string; geometry_id: string }>> {
    const result = await db.executor.query<{ claim_id: string; geometry_id: string }>(
      `SELECT claim_id, geometry_id FROM waspada.event_claim_geometries
       WHERE dataset_kind = 'live' AND event_id = $1 AND event_version = $2 ORDER BY claim_id, geometry_id`,
      [eventId, version],
    );
    return result.rows.map((row) => ({ claim_id: row.claim_id, geometry_id: row.geometry_id }));
  }

  async function geometryCount(): Promise<number> {
    const result = await db.executor.query<{ n: number }>("SELECT COUNT(*)::int AS n FROM waspada.geometries");
    return result.rows[0]!.n;
  }

  async function decisionCount(): Promise<number> {
    const result = await db.executor.query<{ n: number }>("SELECT COUNT(*)::int AS n FROM waspada.publication_decisions WHERE dataset_kind = 'live'");
    return result.rows[0]!.n;
  }

  async function viewLabel(eventId: string, version: number): Promise<string | null> {
    const result = await db.executor.query<{ location_label: string | null }>(
      `SELECT location_label FROM waspada.public_event_location_status
       WHERE dataset_kind = 'live' AND event_id = $1 AND version = $2`,
      [eventId, version],
    );
    assert.equal(result.rows.length, 1, `one location status row for ${eventId} version ${version}`);
    return result.rows[0]!.location_label;
  }

  async function geometryLabel(geometryId: string): Promise<string | null> {
    const result = await db.executor.query<{ display_label: string | null }>(
      "SELECT display_label FROM waspada.geometries WHERE dataset_kind = 'live' AND geometry_id = $1",
      [geometryId],
    );
    return result.rows[0]?.display_label ?? null;
  }

  /**
   * A version published before migration 054 or 055: a publication decision and version 1 with no geometry, and before 055
   * no label text. The proposal is a real persisted one, so the refresh reads the same proposal the publication would have.
   */
  async function publishLegacyVersion(eventId: string, proposalId: string, decision: Record<string, unknown>): Promise<void> {
    legacyCounter += 1;
    const decisionId = `dec-h26-legacy-${legacyCounter}`;
    const ids = lineageIdsFor("h26");
    await db.executor.transaction(async (tx) => {
      await tx.execute("SET CONSTRAINTS ALL DEFERRED");
      await tx.query(
        `INSERT INTO waspada.publication_decisions (
           dataset_kind, decision_id, trace_id, proposal_id, policy_version,
           event_id, event_version, reviewer_id, decided_at, record_json)
         VALUES ('live', $1, $2, $3, 'merge-review-v1', $4, 1, $5, $6::timestamptz, $7::jsonb)`,
        [decisionId, ids.trace_id, proposalId, eventId, AGENT_AUTO_PUBLISHER_ID, PUBLISHED_AT, JSON.stringify({
          disposition: "publish",
          actor_kind: "agent",
          actor_id: AGENT_AUTO_PUBLISHER_ID,
          publication_mode: "agent_auto",
          gate: "agent_auto_publication",
          source_count: 1,
          ...decision,
        })],
      );
      await tx.query(
        `INSERT INTO waspada.event_versions (
           dataset_kind, event_id, version, trace_id, supersedes_version, title, summary, category,
           lifecycle, publication_status, publication_decision_id, published_at, record_json)
         VALUES ('live', $1, 1, $2, NULL, 'Genangan di Cawang (fiktif)', $3, 'disasters_weather',
           'ongoing', 'published', $4, $5::timestamptz, $6::jsonb)`,
        [eventId, ids.trace_id, CLAIM_TEXT, decisionId, PUBLISHED_AT, JSON.stringify({
          schema_version: "2.0",
          record_type: "Event",
          event_id: eventId,
          version: 1,
          claims: [{ claim_id: "legacy-claim-1" }],
          scope: { place_ids: [], service_ids: [], institution_ids: [], audience_ids: [], geometry_ids: [] },
          impact_refs: [],
        })],
      );
    });
  }

  const detailService = () => createPublicEventDetailProjectionService({
    snapshots: createPublicEventSnapshotRepository(db.executor),
    lookups: createPublicProjectionLookupRepository(db.executor),
    geometries: createPublicEventGeometriesRepository(db.executor),
  });
  const listService = () => createPublicEventListProjectionService({
    candidates: createPublicEventListRepository(db.executor),
    projections: createPublicEventProjectionService({
      snapshots: createPublicEventSnapshotRepository(db.executor),
      lookups: createPublicProjectionLookupRepository(db.executor),
    }),
  });

  before(async () => {
    db = await createTestDatabase();
    await applyMigrations(db.executor, await readMigrations(new URL("../../db/migrations/", import.meta.url)));
    await seedProposalLineage(db.executor, "h26");
    // The public views read only a dataset the namespace config names as live.
    await db.executor.query("INSERT INTO waspada.dataset_namespace_config (singleton, dataset_kind) VALUES (true, 'live')");
    deps = { executor: db.executor, datasetKind: "live", checkPublicDisplay };
    PublicReadModel.clearPublishedEvents();
  });

  after(async () => {
    await db?.close();
  });

  it("a label is stored on the decision and read back as text by the public view, the list and the detail", async () => {
    await persist(proposal("prop-h26-labelled", { incidentId: EVENT_LABELLED, coordinates: MODEL_POINT_CAWANG }));
    assert.equal((await auto("prop-h26-labelled") as { status: string }).status, "published");

    const decision = await decisionOf(EVENT_LABELLED, 1);
    assert.equal(decision.location_label, "Cawang, Jakarta Timur");
    assert.equal(decision.location_label_present, true);
    assert.equal(await viewLabel(EVENT_LABELLED, 1), "Cawang, Jakarta Timur");

    const page = await listService().read();
    const listed = page.events.find((event) => event.event_id === EVENT_LABELLED);
    assert.ok(listed, "the list shows the event");
    assert.equal(listed.location_label, "Cawang, Jakarta Timur");
    assert.equal(listed.location_display, undefined, "a point is not a whole view");

    const detailResult = await detailService().read(EVENT_LABELLED);
    assert.equal(detailResult.kind, "found");
    if (detailResult.kind !== "found") return;
    assert.equal(detailResult.detail.location_label, "Cawang, Jakarta Timur");
    assert.equal(detailResult.detail.geometries.length, 1, "the detail shows the pin");
    assert.equal(detailResult.detail.geometries[0]!.label, "Cawang, Jakarta Timur");
  });

  it("a generic label is never stored or shown, and its point is labelled with the neutral text", async () => {
    await persist(proposal("prop-h26-generic", {
      incidentId: EVENT_GENERIC,
      coordinates: MODEL_POINT_GENERIC,
      locationLabel: "DKI Jakarta (Lokasi spesifik belum teridentifikasi)",
    }));
    assert.equal((await auto("prop-h26-generic") as { status: string }).status, "published");

    const decision = await decisionOf(EVENT_GENERIC, 1);
    assert.equal(decision.location_label_present, true, "the flag keeps its meaning: the raw label was present");
    assert.equal(decision.location_label, null, "no label text is stored (the key is null, so the backfill never re-selects it)");
    assert.equal(await viewLabel(EVENT_GENERIC, 1), null);

    const geometryId = pointGeometryIdFor("live", EVENT_GENERIC, MODEL_POINT_GENERIC);
    assert.equal(await geometryLabel(geometryId), "Lokasi perkiraan dari laporan");

    const detailResult = await detailService().read(EVENT_GENERIC);
    assert.equal(detailResult.kind, "found");
    if (detailResult.kind !== "found") return;
    assert.equal("location_label" in detailResult.detail, false);
    assert.doesNotMatch(JSON.stringify(detailResult.detail), /belum teridentifikasi/u);
  });

  it("a withdrawn event is never refreshed, and an event with no publication is skipped", async () => {
    await persist(proposal("prop-h26-withdrawn", { incidentId: EVENT_WITHDRAWN, coordinates: null, locationLabel: "Pancoran, Jakarta Selatan" }));
    assert.equal((await auto("prop-h26-withdrawn") as { status: string }).status, "published");
    const withdrawn = await withdrawPublishedEvent(deps, {
      eventId: EVENT_WITHDRAWN,
      actorId: "fictional-moderator-rep",
      reasonCategory: "duplicate",
      reason: "Fictional fixture withdrawal.",
    });
    assert.equal(withdrawn.status, "withdrawn");
    const versionsBefore = await versionCount(EVENT_WITHDRAWN);
    assert.deepEqual(await refresh(EVENT_WITHDRAWN), { status: "skipped", reason: "withdrawn" });
    assert.equal(await versionCount(EVENT_WITHDRAWN), versionsBefore, "no version is written for a withdrawn event");

    assert.deepEqual(await refresh("inc-h26-never-published"), { status: "skipped", reason: "no_publication" });
  });

  // Runs before any fabricated legacy version exists. The public list reads every published version, and a fabricated
  // legacy record is not a valid projection, so a later list call would fail the whole page (the gap noted in
  // agent-point-geometry.test.ts). The legacy events are checked through the status view and the detail instead.
  it("the list shows the label of a labelled event, never a generic label as text, and never a withdrawn event", async () => {
    const listed = (await listService().read()).events;
    const byId = new Map(listed.map((event) => [event.event_id, event]));
    assert.equal(byId.get(EVENT_LABELLED)?.location_label, "Cawang, Jakarta Timur");
    assert.equal(byId.get(EVENT_GENERIC)?.location_label, undefined, "a generic label is not listed as text");
    assert.equal(byId.has(EVENT_WITHDRAWN), false, "a withdrawn event is not listed");
  });

  it("a published version that already has its point and label is skipped as nothing to add, and writes nothing", async () => {
    const decisionsBefore = await decisionCount();
    const geometriesBefore = await geometryCount();
    assert.deepEqual(await refresh(EVENT_LABELLED), { status: "skipped", reason: "nothing_to_add" });
    assert.deepEqual(await refresh(EVENT_LABELLED), { status: "skipped", reason: "nothing_to_add" }, "a repeat is the same");
    assert.equal(await versionCount(EVENT_LABELLED), 1, "no new version");
    assert.equal(await decisionCount(), decisionsBefore, "no new decision");
    assert.equal(await geometryCount(), geometriesBefore, "no new geometry row");
  });

  it("a version published before migration 054 gets its point and its label in one new version, from the same proposal", async () => {
    await persist(proposal("prop-h26-legacy-point", { incidentId: EVENT_LEGACY_POINT, coordinates: MODEL_POINT_KEMANG, locationLabel: "Kemang, Jakarta Selatan" }));
    await publishLegacyVersion(EVENT_LEGACY_POINT, "prop-h26-legacy-point", {
      location_label_present: true,
      geometry_source: "model_approximate",
      geometry_status: "pending_geometry_writer",
    });
    assert.equal((await versionOf(EVENT_LEGACY_POINT, 1))?.scope.geometry_ids.length, 0, "the legacy version has no point");
    assert.equal((await decisionOf(EVENT_LEGACY_POINT, 1)).location_label, undefined, "and no label text");

    const outcome = await refresh(EVENT_LEGACY_POINT);
    assert.deepEqual(outcome, { status: "refreshed", version: 2 });

    const geometryId = pointGeometryIdFor("live", EVENT_LEGACY_POINT, MODEL_POINT_KEMANG);
    const record = await versionOf(EVENT_LEGACY_POINT, 2);
    assert.ok(record, "version 2 is stored");
    assert.deepEqual(record.scope.geometry_ids, [geometryId], "version 2 names the one Point");
    assert.deepEqual(
      await claimGeometryLinks(EVENT_LEGACY_POINT, 2),
      [{ claim_id: "claim-1", geometry_id: geometryId }],
      "its claim links the same Point",
    );

    const decision = await decisionOf(EVENT_LEGACY_POINT, 2);
    assert.equal(decision.disposition, "publish");
    assert.equal(decision.gate, "location_refresh");
    assert.equal(decision.reason, "Lokasi peta diperbarui (HOSTED-26)");
    assert.equal(decision.base_version, 1);
    assert.equal(decision.actor_id, AGENT_AUTO_PUBLISHER_ID);
    assert.equal(decision.location_label, "Kemang, Jakarta Selatan");
    assert.equal(decision.geometry_status, "point_written");
    assert.equal(decision.geometry_source, "model_approximate");
    assert.equal(decision.location_label_present, true);
    assert.equal(decision.publication_mode, "agent_auto", "the publication mode carries over");
    assert.equal(await viewLabel(EVENT_LEGACY_POINT, 2), "Kemang, Jakarta Selatan");
    assert.equal(await geometryLabel(geometryId), "Kemang, Jakarta Selatan", "the new point takes the event's own label");

    const review = await db.executor.query<{ change_type: string; summary: string; reviewer_id: string }>(
      `SELECT change_type, summary, reviewer_id FROM waspada.public_event_history_review_decisions
       WHERE dataset_kind = 'live' AND event_id = $1 AND event_version = 2`,
      [EVENT_LEGACY_POINT],
    );
    assert.deepEqual(review.rows, [{ change_type: "corrected", summary: "Lokasi peta diperbarui.", reviewer_id: AGENT_AUTO_PUBLISHER_ID }]);

    const detailResult = await detailService().read(EVENT_LEGACY_POINT);
    assert.equal(detailResult.kind, "found");
    if (detailResult.kind !== "found") return;
    assert.equal(detailResult.detail.version, 2);
    assert.equal(detailResult.detail.location_label, "Kemang, Jakarta Selatan");
    assert.equal(detailResult.detail.geometries.length, 1, "the public detail now shows the pin");
    assert.deepEqual(detailResult.detail.geometries[0]!.geometry, { type: "Point", coordinates: MODEL_POINT_KEMANG });

    assert.equal(
      PublicReadModel.getPublishedEvents().find((event) => event.event_id === EVENT_LEGACY_POINT)?.location_label,
      "Kemang, Jakarta Selatan",
      "the in-memory read model shows the new version after the commit",
    );
  });

  it("a second refresh of that event is skipped as nothing to add", async () => {
    const versionsBefore = await versionCount(EVENT_LEGACY_POINT);
    const geometriesBefore = await geometryCount();
    assert.deepEqual(await refresh(EVENT_LEGACY_POINT), { status: "skipped", reason: "nothing_to_add" });
    assert.equal(await versionCount(EVENT_LEGACY_POINT), versionsBefore);
    assert.equal(await geometryCount(), geometriesBefore);
  });

  it("a version published before migration 055 gets its label, and no point, when it has no coordinate", async () => {
    await persist(proposal("prop-h26-legacy-label", { incidentId: EVENT_LEGACY_LABEL, coordinates: null, locationLabel: "Kebayoran Baru, Jakarta Selatan" }));
    await publishLegacyVersion(EVENT_LEGACY_LABEL, "prop-h26-legacy-label", {
      location_label_present: true,
      geometry_status: "whole_view",
    });
    const geometriesBefore = await geometryCount();

    assert.deepEqual(await refresh(EVENT_LEGACY_LABEL), { status: "refreshed", version: 2 });
    const record = await versionOf(EVENT_LEGACY_LABEL, 2);
    assert.ok(record);
    assert.deepEqual(record.scope.geometry_ids, [], "no coordinate, so no point");
    assert.equal(await geometryCount(), geometriesBefore, "no geometry row is written");
    assert.equal((await decisionOf(EVENT_LEGACY_LABEL, 2)).location_label, "Kebayoran Baru, Jakarta Selatan");
    assert.equal(await viewLabel(EVENT_LEGACY_LABEL, 2), "Kebayoran Baru, Jakarta Selatan");

    const detailResult = await detailService().read(EVENT_LEGACY_LABEL);
    assert.equal(detailResult.kind, "found");
    if (detailResult.kind !== "found") return;
    assert.equal(detailResult.detail.location_display, "whole_view");
    assert.equal(detailResult.detail.location_label, "Kebayoran Baru, Jakarta Selatan");
    assert.deepEqual(detailResult.detail.geometries, []);
  });
});
