import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { createTestDatabase, type TestDatabase } from "../../db/test/harness.js";
import { seedProposalLineage, type ProposalLineage } from "../../db/test/proposal-lineage-fixture.js";
import { applyMigrations, readMigrations } from "../../db/src/migrations.js";
import { createEventProposalWriter, type EventProposalDto } from "../../db/src/event-proposal-writer.js";
import { createPublicEventGeometriesRepository } from "../../db/src/public-event-geometries.js";
import {
  AGENT_AUTO_PUBLISHER_ID,
  decideProposal,
  pointGeometryIdFor,
  type ProposalDecisionDependencies,
  type ProposalDecisionOutcome,
} from "../src/layers/l4-application-integration/proposal-publication.js";
import { PublicReadModel } from "../src/layers/l4-application-integration/public-read-model.js";
import { LOCATION_CANDIDATE_SQL, backfillPublishedLocations } from "../../../tools/hosted/location-backfill.js";

/**
 * MAP-GEO-02 (23 Nov 2026): a coordinate-bearing event built from two or more report revisions gets its one Point. The
 * point cites the union of its claims' support (each persisted reference once), so every revision a claim cites is
 * evidence of the point, and the publication writes one geometry row with one evidence link per reference. Before this,
 * such an event recorded "pending_geometry_writer" and stayed a whole view.
 *
 * Covered: the point for a merged event; a merged proposal whose claim has no support is refused before any write (a
 * merged version with an unsupported claim is never published, so "pending" cannot be recorded for it; HOSTED-31 refuses
 * it first); a coordinate event with no point support records "pending_geometry_writer" and writes no row; whole-view and
 * group-notice outcomes stay as they were; and the location backfill selects a pre-MAP-GEO-02 pending event whose decision
 * carries the label key (every decision since migration 055 does), then writes its point.
 *
 * Authored fictional data, the real publication path, the real backfill, and PGlite.
 */

const PERMITTED = new Set(["source-detik", "source-antara"]);
const MODEL_POINT: [number, number] = [106.871, -6.244];
const LABEL = "Cawang, Jakarta Timur";
const EVENT_LEGACY = "inc-mg2-legacy";

let db: TestDatabase;
let deps: ProposalDecisionDependencies;
let lineageA: ProposalLineage;
let revisionA: string;
let revisionB: string;
let chunkA: string;
let chunkB: string;

const checkPublicDisplay = async (sourceId: string): Promise<boolean> => PERMITTED.has(sourceId);

/** One evidence chunk over the whole text of a lineage revision, the same span as its evidence reference. */
async function seedChunk(revisionId: string): Promise<string> {
  const revision = await db.executor.query<{ trace_id: string; permitted_text_hash: string; permitted_text: string }>(
    "SELECT trace_id, permitted_text_hash, permitted_text FROM waspada.report_revisions WHERE dataset_kind = 'live' AND report_revision_id = $1",
    [revisionId],
  );
  const row = revision.rows[0]!;
  const chunkId = `chk-${revisionId}-0`;
  await db.executor.query(
    `INSERT INTO waspada.evidence_chunks
       (dataset_kind, chunk_id, trace_id, report_revision_id, permitted_text_hash, span_start, span_end, offset_unit,
        chunker_version, chunk_text_hash, status)
     VALUES ('live', $1, $2, $3, $4, 0, $5, 'unicode_code_points', 'fixture-chunker-v1', $4, 'active')`,
    [chunkId, row.trace_id, revisionId, row.permitted_text_hash, Array.from(row.permitted_text).length],
  );
  return chunkId;
}

/** The persisted supports reference of one revision: its exact span, as the claims and the point cite it. */
async function referenceOf(revisionId: string) {
  const row = await db.executor.query<{
    report_revision_id: string;
    permitted_text_hash: string;
    span_start: number;
    span_end: number;
  }>(
    `SELECT report_revision_id, permitted_text_hash, span_start, span_end FROM waspada.evidence_references
     WHERE dataset_kind = 'live' AND report_revision_id = $1 AND relation = 'supports' LIMIT 1`,
    [revisionId],
  );
  const found = row.rows[0]!;
  return {
    report_revision_id: found.report_revision_id,
    permitted_text_hash: found.permitted_text_hash,
    span_start: Number(found.span_start),
    span_end: Number(found.span_end),
    offset_unit: "unicode_code_points" as const,
    relation: "supports" as const,
  };
}

function claim(index: number, chunkId: string, sourceId: string) {
  const text = `Klaim fiktif ${index} dari laporan gabungan`;
  return {
    claim_id: `claim-${index}`,
    claim_text: text,
    evidence_label: "attributed_report" as const,
    support_assessment: "supported" as const,
    quote_text: text,
    evidence_ref_id: chunkId,
    source_id: sourceId,
    outlet: sourceId === "source-detik" ? "Detik News" : "Antara",
    source_url: `https://news.example/${chunkId}`,
  };
}

interface ProposalOptions {
  readonly claims: ReturnType<typeof claim>[];
  readonly incidentId?: string;
  readonly coordinates?: [number, number] | null;
  readonly locationLabel?: string | null;
  readonly primaryCategory?: string;
  /** The revisions the proposal was built from. Two or more makes it a merged proposal. */
  readonly reportRevisionIds?: readonly string[];
  /** A grounding context of the lineage. Defaults to the first lineage's own context. */
  readonly contextId?: string;
}

function proposal(proposalId: string, options: ProposalOptions): EventProposalDto {
  return {
    schema_version: "2.0",
    ...lineageA,
    ...(options.contextId === undefined ? {} : { context_id: options.contextId }),
    ...(options.reportRevisionIds === undefined ? {} : { report_revision_ids: [...options.reportRevisionIds] }),
    proposal_id: proposalId,
    incident_id: options.incidentId ?? "inc-" + proposalId,
    title: "Genangan di Cawang (fiktif)",
    incident_type: "genangan_air_luapan_saluran",
    primary_category: options.primaryCategory ?? "disasters_weather",
    compatibility_category: "flood",
    severity: "medium",
    event_time: { precision: "exact", value: "2026-11-10T08:00:00.000Z" },
    location_label: options.locationLabel === undefined ? LABEL : options.locationLabel,
    coordinates: options.coordinates === undefined ? null : options.coordinates,
    claims: options.claims,
    impacts: [],
    interpretation_category: null,
    source_id: "source-detik",
    is_multi_source: options.claims.length > 1,
    source_count: options.claims.length > 1 ? 2 : 1,
    has_discrepancy: false,
    discrepancy_summary: null,
    discrepancies: [],
    caveats: [],
    correlation_relationship: options.claims.length > 1 ? "corroborating" : "primary_initial",
    proposed_at: "2026-11-10T08:05:00.000Z",
  } as EventProposalDto;
}

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

async function versionRecord(eventId: string, version: number): Promise<Record<string, any> | undefined> {
  const result = await db.executor.query<{ record_json: Record<string, any> }>(
    "SELECT record_json FROM waspada.event_versions WHERE dataset_kind = 'live' AND event_id = $1 AND version = $2",
    [eventId, version],
  );
  return result.rows[0]?.record_json;
}

/** The publication decision of one event version. */
async function decisionOf(eventId: string, version: number): Promise<Record<string, any>> {
  const result = await db.executor.query<{ record_json: Record<string, any> }>(
    "SELECT record_json FROM waspada.publication_decisions WHERE dataset_kind = 'live' AND event_id = $1 AND event_version = $2",
    [eventId, version],
  );
  return result.rows[0]!.record_json;
}

async function geometryTotal(): Promise<number> {
  const result = await db.executor.query<{ n: number }>("SELECT COUNT(*)::int AS n FROM waspada.geometries WHERE dataset_kind = 'live'");
  return result.rows[0]!.n;
}

async function geometryEvidenceTotal(): Promise<number> {
  const result = await db.executor.query<{ n: number }>("SELECT COUNT(*)::int AS n FROM waspada.geometry_evidence WHERE dataset_kind = 'live'");
  return result.rows[0]!.n;
}

async function geometryRowsFor(geometryId: string) {
  const result = await db.executor.query<{
    role: string;
    precision_m: number | null;
    geometry_type: string;
    lon: number;
    lat: number;
  }>(
    `SELECT role, precision_m, GeometryType(shape) AS geometry_type, ST_X(shape) AS lon, ST_Y(shape) AS lat
       FROM waspada.geometries WHERE dataset_kind = 'live' AND geometry_id = $1`,
    [geometryId],
  );
  return result.rows;
}

/** The report revisions the point's evidence links cite, sorted. One link per persisted reference. */
async function pointEvidenceRevisions(geometryId: string): Promise<string[]> {
  const result = await db.executor.query<{ report_revision_id: string }>(
    `SELECT ref.report_revision_id
       FROM waspada.geometry_evidence AS link
       JOIN waspada.evidence_references AS ref
         ON ref.dataset_kind = link.dataset_kind AND ref.evidence_ref_id = link.evidence_ref_id
      WHERE link.dataset_kind = 'live' AND link.geometry_id = $1
      ORDER BY ref.report_revision_id`,
    [geometryId],
  );
  return result.rows.map((row) => row.report_revision_id);
}

async function claimGeometryLinks(eventId: string, version: number): Promise<Array<{ claim_id: string; geometry_id: string }>> {
  const result = await db.executor.query<{ claim_id: string; geometry_id: string }>(
    `SELECT claim_id, geometry_id FROM waspada.event_claim_geometries
      WHERE dataset_kind = 'live' AND event_id = $1 AND event_version = $2 ORDER BY claim_id, geometry_id`,
    [eventId, version],
  );
  return result.rows.map((row) => ({ claim_id: row.claim_id, geometry_id: row.geometry_id }));
}

/**
 * The state a merged event left before MAP-GEO-02: its claims carry support, its point was never written, and its
 * decision carries the label key, as every decision since migration 055 does. Written directly, as the HOSTED-26
 * fixtures do, so the publication code cannot write the point.
 */
async function recordPrePointPublication(proposalId: string, eventId: string, revisionIds: readonly string[]): Promise<void> {
  const decisionId = `dec-mg2-prepoint-${proposalId}`;
  const claims: Array<{ claim_id: string; support: unknown[] }> = [];
  for (const [index, revisionId] of revisionIds.entries()) {
    claims.push({ claim_id: `claim-${index + 1}`, support: [await referenceOf(revisionId)] });
  }
  await db.executor.transaction(async (tx) => {
    await tx.execute("SET CONSTRAINTS ALL DEFERRED");
    await tx.query(
      `INSERT INTO waspada.publication_decisions (
         dataset_kind, decision_id, trace_id, proposal_id, policy_version,
         event_id, event_version, reviewer_id, decided_at, record_json)
       VALUES ('live', $1, $2, $3, 'merge-review-v1', $4, 1, $5, '2026-11-10T08:05:00.000Z'::timestamptz, $6::jsonb)`,
      [decisionId, lineageA.trace_id, proposalId, eventId, AGENT_AUTO_PUBLISHER_ID, JSON.stringify({
        disposition: "publish",
        actor_kind: "agent",
        actor_id: AGENT_AUTO_PUBLISHER_ID,
        publication_mode: "agent_auto",
        gate: "agent_auto_publication",
        source_count: 2,
        location_label_present: true,
        location_label: LABEL,
        geometry_source: "model_approximate",
        geometry_status: "pending_geometry_writer",
      })],
    );
    await tx.query(
      `INSERT INTO waspada.event_versions (
         dataset_kind, event_id, version, trace_id, supersedes_version, title, summary, category,
         lifecycle, publication_status, publication_decision_id, published_at, record_json)
       VALUES ('live', $1, 1, $2, NULL, 'Genangan di Cawang (fiktif)', 'Genangan 50 cm di Cawang', 'disasters_weather',
         'ongoing', 'published', $3, '2026-11-10T08:05:00.000Z'::timestamptz, $4::jsonb)`,
      [eventId, lineageA.trace_id, decisionId, JSON.stringify({
        schema_version: "2.0",
        record_type: "Event",
        event_id: eventId,
        version: 1,
        claims,
        scope: { place_ids: [], service_ids: [], institution_ids: [], audience_ids: [], geometry_ids: [] },
        impact_refs: [],
      })],
    );
  });
}

describe("MAP-GEO-02 a coordinate event from several revisions gets its point", () => {
  before(async () => {
    db = await createTestDatabase();
    await applyMigrations(db.executor, await readMigrations(new URL("../../db/migrations/", import.meta.url)));
    lineageA = await seedProposalLineage(db.executor, "mapgeo2a");
    // The second revision has its own lineage; the proposals below take their trace and context from the first.
    await seedProposalLineage(db.executor, "mapgeo2b");
    revisionA = "rev-lineage-mapgeo2a";
    revisionB = "rev-lineage-mapgeo2b";
    // The public views read only a dataset the namespace config names as live.
    await db.executor.query("INSERT INTO waspada.dataset_namespace_config (singleton, dataset_kind) VALUES (true, 'live')");
    chunkA = await seedChunk(revisionA);
    chunkB = await seedChunk(revisionB);
    deps = { executor: db.executor, datasetKind: "live", checkPublicDisplay };
    PublicReadModel.clearPublishedEvents();
  });

  after(async () => {
    await db?.close();
  });

  it("(a) a two-revision proposal with coordinates gets one Point that cites both revisions", async () => {
    const geometriesBefore = await geometryTotal();
    const evidenceBefore = await geometryEvidenceTotal();
    await persist(proposal("prop-mg2-two", {
      claims: [claim(1, chunkA, "source-detik"), claim(2, chunkB, "source-antara")],
      coordinates: MODEL_POINT,
      reportRevisionIds: [revisionA, revisionB],
    }));
    const outcome = await auto("prop-mg2-two");
    assert.equal(outcome.status, "published", JSON.stringify(outcome));

    const eventId = "inc-prop-mg2-two";
    const geometryId = pointGeometryIdFor("live", eventId, MODEL_POINT);
    const decision = await decisionOf(eventId, 1);
    assert.equal(decision.geometry_status, "point_written");
    assert.equal(decision.geometry_source, "model_approximate");

    const record = await versionRecord(eventId, 1);
    assert.ok(record);
    assert.deepEqual(record.scope.geometry_ids, [geometryId], "the event names its one Point");
    assert.deepEqual(record.claims.map((published: any) => published.support[0].report_revision_id), [revisionA, revisionB],
      "each claim keeps its own revision's support");

    assert.equal(await geometryTotal(), geometriesBefore + 1, "exactly one geometry row is written");
    assert.deepEqual(await geometryRowsFor(geometryId), [{
      role: "approximate_place",
      precision_m: null,
      geometry_type: "POINT",
      lon: MODEL_POINT[0],
      lat: MODEL_POINT[1],
    }], "the row is the Point at the model coordinate, with no radius");
    assert.deepEqual(await pointEvidenceRevisions(geometryId), [revisionA, revisionB],
      "the point's evidence links reference both revisions");
    assert.equal(await geometryEvidenceTotal(), evidenceBefore + 2, "one evidence link per reference, no more");
    assert.deepEqual(await claimGeometryLinks(eventId, 1), [
      { claim_id: "claim-1", geometry_id: geometryId },
      { claim_id: "claim-2", geometry_id: geometryId },
    ], "every claim of the version links the Point");
  });

  it("(a2) the Point reads back through the public geometry reader", async () => {
    const geometryId = pointGeometryIdFor("live", "inc-prop-mg2-two", MODEL_POINT);
    const geometries = await createPublicEventGeometriesRepository(db.executor).read([geometryId]);
    assert.equal(geometries.length, 1, "the detail reader returns the one Point");
    const stored = geometries[0]!.recordJson as Record<string, any>;
    assert.deepEqual(stored.geojson, { type: "Point", coordinates: MODEL_POINT });
    assert.equal(stored.display_label, LABEL);
  });

  it("(b) a two-revision proposal whose claim has no chunk support is refused, and writes no point", async () => {
    const geometriesBefore = await geometryTotal();
    const evidenceBefore = await geometryEvidenceTotal();
    await persist(proposal("prop-mg2-unsupported", {
      claims: [claim(1, chunkA, "source-detik"), claim(2, "chk-mg2-missing", "source-antara")],
      coordinates: MODEL_POINT,
      reportRevisionIds: [revisionA, revisionB],
    }));
    assert.deepEqual(await auto("prop-mg2-unsupported"), { status: "denied", code: "publication_failed" });

    const versions = await db.executor.query<{ n: number }>(
      "SELECT COUNT(*)::int AS n FROM waspada.event_versions WHERE dataset_kind = 'live' AND event_id = $1",
      ["inc-prop-mg2-unsupported"],
    );
    assert.equal(versions.rows[0]!.n, 0, "no version is written");
    assert.equal(await geometryTotal(), geometriesBefore, "no geometry row is written");
    assert.equal(await geometryEvidenceTotal(), evidenceBefore, "no evidence link is written");
    const point = pointGeometryIdFor("live", "inc-prop-mg2-unsupported", MODEL_POINT);
    assert.deepEqual(await geometryRowsFor(point), []);
  });

  it("(b2) a coordinate event with no point support records pending_geometry_writer and writes no point", async () => {
    // A grounding context with no persisted evidence: the proposal's one revision gives it no support at all.
    await db.executor.query(
      `INSERT INTO waspada.grounding_contexts
         (dataset_kind, context_id, trace_id, candidate_id, retrieval_version, index_version, sufficient, record_json)
       VALUES ('live', 'ctx-mg2-empty', $1, $2, 'mapgeo2-fixture-v1', 'mapgeo2-index-v1', true, '{"evidence": []}'::jsonb)`,
      [lineageA.trace_id, lineageA.candidate_id],
    );
    await persist(proposal("prop-mg2-empty", {
      claims: [claim(1, "chk-mg2-empty", "source-detik")],
      coordinates: MODEL_POINT,
      contextId: "ctx-mg2-empty",
    }));
    const outcome = await auto("prop-mg2-empty");
    assert.equal(outcome.status, "published", JSON.stringify(outcome));

    const eventId = "inc-prop-mg2-empty";
    const decision = await decisionOf(eventId, 1);
    assert.equal(decision.geometry_status, "pending_geometry_writer");
    assert.equal(decision.geometry_source, "model_approximate");
    assert.deepEqual(await geometryRowsFor(pointGeometryIdFor("live", eventId, MODEL_POINT)), []);
    assert.deepEqual((await versionRecord(eventId, 1))?.scope.geometry_ids, [], "the event stays a whole view");
  });

  it("(c) a two-revision whole view gets no point and keeps both claims' support", async () => {
    const geometriesBefore = await geometryTotal();
    await persist(proposal("prop-mg2-whole", {
      claims: [claim(1, chunkA, "source-detik"), claim(2, chunkB, "source-antara")],
      coordinates: null,
      reportRevisionIds: [revisionA, revisionB],
    }));
    const outcome = await auto("prop-mg2-whole");
    assert.equal(outcome.status, "published", JSON.stringify(outcome));

    const decision = await decisionOf("inc-prop-mg2-whole", 1);
    assert.equal(decision.geometry_status, "whole_view");
    assert.equal(decision.geometry_source, null);
    assert.equal(await geometryTotal(), geometriesBefore, "no geometry row is written");
    const record = await versionRecord("inc-prop-mg2-whole", 1);
    assert.deepEqual(record?.scope.geometry_ids, []);
    assert.deepEqual(record?.claims.map((published: any) => published.support.length), [1, 1]);
  });

  it("(c2) a two-revision group notice with no location gets no point, after a moderator publishes it", async () => {
    const geometriesBefore = await geometryTotal();
    await persist(proposal("prop-mg2-group", {
      claims: [claim(1, chunkA, "source-detik"), claim(2, chunkB, "source-antara")],
      coordinates: null,
      locationLabel: null,
      primaryCategory: "group_specific_critical_notices",
      reportRevisionIds: [revisionA, revisionB],
    }));
    // The automatic gate (ADR-061) queues a notice with no location for a moderator. The notice is not changed here.
    assert.deepEqual(await auto("prop-mg2-group"), { status: "queued", reasons: ["location_missing"] });
    const outcome = await moderate("prop-mg2-group");
    assert.equal(outcome.status, "published", JSON.stringify(outcome));

    const decision = await decisionOf("inc-prop-mg2-group", 1);
    assert.equal(decision.geometry_status, "not_required_group_notice");
    assert.equal(decision.geometry_source, null);
    assert.equal(await geometryTotal(), geometriesBefore, "no geometry row is written");
    assert.deepEqual((await versionRecord("inc-prop-mg2-group", 1))?.scope.geometry_ids, []);
  });

  it("(d) the backfill selects a pre-MAP-GEO-02 pending event with a label key, and writes its point", async () => {
    await persist(proposal("prop-mg2-legacy", {
      claims: [claim(1, chunkA, "source-detik"), claim(2, chunkB, "source-antara")],
      incidentId: EVENT_LEGACY,
      coordinates: MODEL_POINT,
      reportRevisionIds: [revisionA, revisionB],
    }));
    await recordPrePointPublication("prop-mg2-legacy", EVENT_LEGACY, [revisionA, revisionB]);

    const candidates = await db.executor.query<{ event_id: string }>(LOCATION_CANDIDATE_SQL, [100]);
    assert.ok(candidates.rows.some((row) => row.event_id === EVENT_LEGACY),
      "a pending point is a candidate even though its decision has the label key");

    const result = await backfillPublishedLocations({
      executor: db.executor,
      checkPublicDisplay,
      deadlineMs: Number.POSITIVE_INFINITY,
      now: () => 0,
    });
    assert.equal(result.failed, 0, JSON.stringify(result));

    const geometryId = pointGeometryIdFor("live", EVENT_LEGACY, MODEL_POINT);
    const decision = await decisionOf(EVENT_LEGACY, 2);
    assert.equal(decision.geometry_status, "point_written");
    assert.equal(decision.gate, "location_refresh");
    const record = await versionRecord(EVENT_LEGACY, 2);
    assert.deepEqual(record?.scope.geometry_ids, [geometryId], "version 2 names the one Point");
    assert.deepEqual(await pointEvidenceRevisions(geometryId), [revisionA, revisionB]);
    assert.deepEqual(await claimGeometryLinks(EVENT_LEGACY, 2), [
      { claim_id: "claim-1", geometry_id: geometryId },
      { claim_id: "claim-2", geometry_id: geometryId },
    ]);

    const again = await db.executor.query<{ event_id: string }>(LOCATION_CANDIDATE_SQL, [100]);
    assert.ok(!again.rows.some((row) => row.event_id === EVENT_LEGACY), "a repaired event is not selected again");
  });
});
