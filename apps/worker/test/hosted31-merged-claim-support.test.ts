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
  refreshPublishedLocation,
  type ProposalDecisionDependencies,
} from "../src/layers/l4-application-integration/proposal-publication.js";
import { PublicReadModel } from "../src/layers/l4-application-integration/public-read-model.js";
import { createPublicEventProjectionService } from "../src/layers/l4-application-integration/public-event-projection-service.js";
import { createPublicEventListProjectionService } from "../src/layers/l4-application-integration/public-event-list-projection-service.js";
import { LOCATION_CANDIDATE_SQL } from "../../../tools/hosted/location-backfill.js";

/**
 * HOSTED-31 (18 Nov 2026): a proposal built from several report revisions (a merged event) used to publish every claim
 * with empty support. The public reader refuses such a snapshot, and one refused snapshot fails the whole public list
 * (500 on /api/v1/events). Now each claim gets the persisted reference that exactly matches the chunk it cites, from one
 * of the proposal's own revisions. A claim with no such reference stops the version before any write (denied,
 * publication_failed). The location
 * refresh re-writes an existing version with an unsupported claim. Authored fictional data, the real writer, PGlite.
 */

const PERMITTED = new Set(["source-detik", "source-antara"]);

let db: TestDatabase;
let deps: ProposalDecisionDependencies;
let first: ProposalLineage;
let second: ProposalLineage;

/** One evidence chunk over the whole fixture text of a lineage revision, the same span as its evidence reference. */
async function seedChunk(key: string): Promise<string> {
  const revisionId = `rev-lineage-${key}`;
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

function mergedProposal(proposalId: string, claims: ReturnType<typeof claim>[]): EventProposalDto {
  return {
    schema_version: "2.0",
    ...first,
    report_revision_ids: ["rev-lineage-hosted31a", "rev-lineage-hosted31b"],
    proposal_id: proposalId,
    incident_id: "inc-" + proposalId,
    title: "Kebakaran fiktif di Cawang",
    incident_type: "kebakaran",
    primary_category: "fires_infrastructure_hazards",
    compatibility_category: "fire",
    severity: "medium",
    event_time: { precision: "date", value: "2026-11-18" },
    location_label: "Cawang, Jakarta Timur",
    coordinates: null,
    claims,
    impacts: [],
    interpretation_category: null,
    source_id: "source-detik",
    is_multi_source: true,
    source_count: 2,
    has_discrepancy: false,
    discrepancy_summary: null,
    discrepancies: [],
    caveats: [],
    correlation_relationship: "corroborating",
    proposed_at: "2026-11-18T08:00:00.000Z",
  } as EventProposalDto;
}

const auto = (proposalId: string) => decideProposal(deps, {
  proposalId,
  action: "auto_publish",
  actor: { kind: "agent", actorId: AGENT_AUTO_PUBLISHER_ID },
});

async function versionRecord(eventId: string, version: number): Promise<Record<string, any> | undefined> {
  const result = await db.executor.query<{ record_json: Record<string, any> }>(
    "SELECT record_json FROM waspada.event_versions WHERE dataset_kind = 'live' AND event_id = $1 AND version = $2",
    [eventId, version],
  );
  return result.rows[0]?.record_json;
}

function publicList() {
  return createPublicEventListProjectionService({
    candidates: createPublicEventListRepository(db.executor),
    projections: createPublicEventProjectionService({
      snapshots: createPublicEventSnapshotRepository(db.executor),
      lookups: createPublicProjectionLookupRepository(db.executor),
    }),
  });
}

describe("HOSTED-31 merged proposals give each claim its own support", () => {
  let chunkA: string;
  let chunkB: string;

  before(async () => {
    db = await createTestDatabase();
    await applyMigrations(db.executor, await readMigrations(new URL("../../db/migrations/", import.meta.url)));
    first = await seedProposalLineage(db.executor, "hosted31a");
    second = await seedProposalLineage(db.executor, "hosted31b");
    assert.ok(second.trace_id);
    await db.executor.query("INSERT INTO waspada.dataset_namespace_config (singleton, dataset_kind) VALUES (true, 'live')");
    chunkA = await seedChunk("hosted31a");
    chunkB = await seedChunk("hosted31b");
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

  it("each claim cites the persisted span of its own chunk's revision, and the public list still reads", async () => {
    const writer = createEventProposalWriter(db.executor);
    await writer.persistProposal(mergedProposal("prop-h31-ok", [
      claim(1, chunkA, "source-detik"),
      claim(2, chunkB, "source-antara"),
    ]), "live");
    const outcome = await auto("prop-h31-ok");
    assert.equal(outcome.status, "published", JSON.stringify(outcome));

    const record = await versionRecord("inc-prop-h31-ok", 1);
    assert.ok(record);
    assert.equal(record.claims.length, 2);
    assert.deepEqual(record.claims[0].support.map((ref: any) => ref.report_revision_id), ["rev-lineage-hosted31a"]);
    assert.deepEqual(record.claims[1].support.map((ref: any) => ref.report_revision_id), ["rev-lineage-hosted31b"]);
    for (const published of record.claims) assert.equal(published.support[0].relation, "supports");

    // The list must not fail on this version (it used to throw SNAPSHOT_INVALID and fail the page).
    await publicList().read();
  });

  it("a claim whose chunk has no persisted reference refuses the version before any write", async () => {
    const writer = createEventProposalWriter(db.executor);
    await writer.persistProposal(mergedProposal("prop-h31-missing", [
      claim(1, chunkA, "source-detik"),
      claim(2, "chk-does-not-exist", "source-antara"),
    ]), "live");
    assert.deepEqual(await auto("prop-h31-missing"), { status: "denied", code: "publication_failed" });
    assert.equal(await versionRecord("inc-prop-h31-missing", 1), undefined, "no version is written");
    const decisions = await db.executor.query<{ n: number }>(
      "SELECT COUNT(*)::int AS n FROM waspada.publication_decisions WHERE dataset_kind = 'live' AND proposal_id = $1",
      ["prop-h31-missing"],
    );
    assert.equal(decisions.rows[0]!.n, 0, "the refused publication leaves no decision row");
    await publicList().read();
  });

  it("a chunk of a revision outside the proposal gives no support", async () => {
    const outsider = await seedProposalLineage(db.executor, "hosted31c");
    assert.ok(outsider.trace_id);
    const chunkC = await seedChunk("hosted31c");
    const writer = createEventProposalWriter(db.executor);
    await writer.persistProposal(mergedProposal("prop-h31-outside", [
      claim(1, chunkA, "source-detik"),
      claim(2, chunkC, "source-antara"),
    ]), "live");
    assert.deepEqual(await auto("prop-h31-outside"), { status: "denied", code: "publication_failed" });
    assert.equal(await versionRecord("inc-prop-h31-outside", 1), undefined);
  });

  it("the refresh re-writes a legacy version whose claims have no support, and the backfill selects it first", async () => {
    // Make the version written in the first case look like a pre-HOSTED-31 one: every claim with empty support.
    const eventId = "inc-prop-h31-ok";
    const legacy = await versionRecord(eventId, 1);
    assert.ok(legacy);
    const broken = { ...legacy, claims: legacy.claims.map((published: any) => ({ ...published, support: [] })) };
    await db.executor.query("ALTER TABLE waspada.event_versions DISABLE TRIGGER event_versions_append_only");
    await db.executor.query(
      "UPDATE waspada.event_versions SET record_json = $3::jsonb WHERE dataset_kind = 'live' AND event_id = $1 AND version = $2",
      [eventId, 1, JSON.stringify(broken)],
    );
    await db.executor.query("ALTER TABLE waspada.event_versions ENABLE TRIGGER event_versions_append_only");
    await assert.rejects(publicList().read(), "the legacy version fails the list, as on the hosted site");

    const candidates = await db.executor.query<{ event_id: string }>(LOCATION_CANDIDATE_SQL, [100]);
    assert.ok(candidates.rows.some((row) => row.event_id === eventId), "the backfill selects the event");

    const outcome = await refreshPublishedLocation(db.executor, {
      datasetKind: "live",
      eventId,
      checkPublicDisplay: async (sourceId: string) => PERMITTED.has(sourceId),
    });
    assert.deepEqual(outcome, { status: "refreshed", version: 2 });
    const repaired = await versionRecord(eventId, 2);
    assert.ok(repaired);
    assert.ok(repaired.claims.every((published: any) => published.support.length === 1), "every claim has support again");
    const review = await db.executor.query<{ summary: string }>(
      "SELECT summary FROM waspada.public_event_history_review_decisions WHERE dataset_kind = 'live' AND event_id = $1 AND event_version = 2",
      [eventId],
    );
    assert.equal(review.rows[0]?.summary, "Rujukan sumber klaim dilengkapi.");
    await publicList().read();

    const again = await db.executor.query<{ event_id: string }>(LOCATION_CANDIDATE_SQL, [100]);
    assert.ok(!again.rows.some((row) => row.event_id === eventId), "a repaired event is not selected again");
  });
});
