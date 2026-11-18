import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { createTestDatabase, type TestDatabase } from "../../db/test/harness.js";
import { seedProposalLineage, type ProposalLineage } from "../../db/test/proposal-lineage-fixture.js";
import { applyMigrations, readMigrations } from "../../db/src/migrations.js";
import { createEventProposalWriter, type EventProposalDto } from "../../db/src/event-proposal-writer.js";
import { createPublicEventListRepository } from "../../db/src/public-event-list.js";
import { createPublicEventSnapshotRepository } from "../../db/src/public-event-snapshot.js";
import { createPublicProjectionLookupRepository } from "../../db/src/public-projection-lookups.js";
import { createPublicEventGeometriesRepository } from "../../db/src/public-event-geometries.js";
import { createPublicEventListProjectionService } from "../src/layers/l4-application-integration/public-event-list-projection-service.js";
import { createPublicEventDetailProjectionService } from "../src/layers/l4-application-integration/public-event-detail-projection-service.js";
import {
  createPublicEventProjectionService,
} from "../src/layers/l4-application-integration/public-event-projection-service.js";
import {
  AGENT_AUTO_PUBLISHER_ID,
  attributionDecisionIdFor,
  attributionUrlFor,
  decideProposal,
  writeSourceAttributions,
  type ProposalDecisionDependencies,
  type ProposalDecisionOutcome,
} from "../src/layers/l4-application-integration/proposal-publication.js";
import type { WorkerEnvironment } from "../src/layers/l4-application-integration/api.js";
import { checkSourcePublicDisplay } from "../src/index.js";

/**
 * HOSTED-22 (owner decision, 16-17 Nov 2026): approving a source grants public display of its attribution. The
 * publication transaction writes the approved attribution of each supporting reference, from the source's approval.
 * Authored fictional data, the real publish path and PGlite. The publication role is exercised through the
 * attribution writer itself, because decideProposal cannot run as that role yet (see agent-origin-writer test (e)).
 */

const CLAIM_TEXT = "Genangan setinggi 50 cm di Cawang (fiktif)";
const PUBLISHED_AT = "2026-11-09T05:30:00.000Z";
const SOURCE_PUBLISHED_AT_TEXT = "2026-11-09T05:30:00.000000Z";
const RETRIEVED_AT = "2026-11-10T08:00:00.000Z";

function agentProposal(lineage: ProposalLineage, sourceId: string, key: string, incidentId: string): EventProposalDto {
  return {
    schema_version: "2.0",
    ...lineage,
    proposal_id: `prop-${incidentId}`,
    incident_id: incidentId,
    title: "Genangan di Cawang (fiktif)",
    incident_type: "genangan_air_luapan_saluran",
    primary_category: "disasters_weather",
    compatibility_category: "flood",
    severity: "medium",
    event_time: { precision: "exact", value: "2026-11-10T08:00:00.000Z" },
    location_label: "Cawang, Jakarta Timur",
    coordinates: null,
    claims: [{
      claim_id: "claim-1",
      claim_text: CLAIM_TEXT,
      evidence_label: "attributed_report",
      support_assessment: "supported",
      quote_text: CLAIM_TEXT,
      evidence_ref_id: `chk-${incidentId}`,
      source_id: sourceId,
      outlet: "Fictional lineage source",
      source_url: `https://lineage.invalid/${key}`,
    }],
    impacts: [],
    interpretation_category: null,
    source_id: sourceId,
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

describe("HOSTED-22 attribution URL guard", () => {
  it("accepts only an https link with no credentials and no credential-like query parameter", () => {
    assert.equal(attributionUrlFor("https://news.example/berita/1"), "https://news.example/berita/1");
    assert.equal(attributionUrlFor("  https://news.example/berita/1  "), "https://news.example/berita/1", "the stored value is trimmed");
    assert.equal(attributionUrlFor("http://news.example/berita/1"), null, "the schema allows https only");
    assert.equal(attributionUrlFor("https://user:secret@news.example/berita/1"), null, "no credentials in a shown link");
    assert.equal(attributionUrlFor("https://feed.example/rss?api_key=abc"), null, "a key-like parameter is never shown");
    assert.equal(attributionUrlFor("https://feed.example/rss?token=abc&x=1"), null);
    assert.equal(attributionUrlFor("https://news.example/berita 1"), null, "no whitespace inside the link");
    assert.equal(attributionUrlFor("https://"), null, "too short for the schema (8 characters, the minimum is 9)");
    assert.equal(attributionUrlFor("https://a"), "https://a", "9 characters is the schema minimum");
    assert.equal(attributionUrlFor(null), null);
    assert.equal(attributionUrlFor(42), null);
  });

  it("derives a stable decision id per dataset and evidence reference", () => {
    const id = attributionDecisionIdFor("live", "42");
    assert.match(id, /^attr-[0-9a-f]{40}$/u);
    assert.equal(id, attributionDecisionIdFor("live", "42"));
    assert.notEqual(id, attributionDecisionIdFor("live", "43"));
    assert.notEqual(id, attributionDecisionIdFor("synthetic", "42"));
  });
});

describe("HOSTED-22 publication writes the attribution from source approval", () => {
  let db: TestDatabase;
  let deps: ProposalDecisionDependencies;
  let lineageOk: ProposalLineage;
  let lineageOff: ProposalLineage;

  const persist = (value: EventProposalDto) => createEventProposalWriter(db.executor).persistProposal(value, "live");
  const auto = (proposalId: string, sourcePermission?: "required" | "local_relaxed"): Promise<ProposalDecisionOutcome> =>
    decideProposal(deps, {
      proposalId,
      action: "auto_publish",
      actor: { kind: "agent", actorId: AGENT_AUTO_PUBLISHER_ID },
      ...(sourcePermission === undefined ? {} : { sourcePermission }),
    });

  const attributionsFor = async (reportRevisionId: string) => {
    const result = await db.executor.query<Record<string, any>>(
      `SELECT review_decision_id, evidence_ref_id::text AS evidence_ref_id, review_version, decision_status,
              public_display_name, source_url, source_observed_at, reviewer_id, rights_basis_ref, relation,
              offset_unit,
              to_char(reviewed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS reviewed_at,
              to_char(source_published_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS source_published_at
       FROM waspada.public_attribution_review_decisions
       WHERE dataset_kind = 'live' AND report_revision_id = $1
       ORDER BY evidence_ref_id`,
      [reportRevisionId],
    );
    return result.rows;
  };

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
    // The public views read only a dataset the namespace config names as live.
    await db.executor.query("INSERT INTO waspada.dataset_namespace_config (singleton, dataset_kind) VALUES (true, 'live')");
    const env = { SQL_EXECUTOR: db.executor } as unknown as WorkerEnvironment;
    deps = {
      executor: db.executor,
      datasetKind: "live",
      // The real rights check the gate uses: approval and public-display permission, read from source_registry.
      checkPublicDisplay: (sourceId: string) => checkSourcePublicDisplay(env, sourceId),
    };
    lineageOk = await seedProposalLineage(db.executor, "hosted22-ok", "live", RETRIEVED_AT, PUBLISHED_AT);
    lineageOff = await seedProposalLineage(db.executor, "hosted22-off", "live", RETRIEVED_AT, PUBLISHED_AT);
    await seedProposalLineage(db.executor, "hosted22-role", "live", RETRIEVED_AT, PUBLISHED_AT);
  });

  after(async () => {
    await db?.close();
  });

  it("(a) an approved source writes one approved attribution with the registry name, the article link and the source's own publish time, and the event lists with that name", async () => {
    const sourceId = "source-lineage-hosted22-ok";
    await persist(agentProposal(lineageOk, sourceId, "hosted22-ok", "inc-h22-ok-1"));
    const outcome = await auto("prop-inc-h22-ok-1");
    assert.equal(outcome.status, "published", JSON.stringify(outcome));

    const rows = await attributionsFor("rev-lineage-hosted22-ok");
    assert.equal(rows.length, 1, "the one supporting reference has one attribution row");
    const row = rows[0]!;
    assert.equal(row.review_decision_id, attributionDecisionIdFor("live", row.evidence_ref_id));
    assert.equal(row.review_version, 1);
    assert.equal(row.decision_status, "approved");
    assert.equal(row.public_display_name, "Fictional lineage source", "the registry display name");
    assert.equal(row.source_url, "https://lineage.invalid/hosted22-ok", "the revision's own canonical link");
    assert.equal(row.source_published_at, SOURCE_PUBLISHED_AT_TEXT, "the source's own publish time, not the retrieval time");
    assert.equal(row.source_observed_at, null, "no observed time is invented");
    assert.equal(row.reviewer_id, AGENT_AUTO_PUBLISHER_ID);
    assert.equal(row.rights_basis_ref, `source_registry:${sourceId}`);
    assert.equal(row.relation, "supports");
    assert.equal(row.offset_unit, "unicode_code_points");

    const page = await listService().read();
    const listed = page.events.find((event) => event.event_id === "inc-h22-ok-1");
    assert.ok(listed, "the agent event is listed on the DB public list");
    assert.equal(listed.location_display, "whole_view");
    const sources = listed.claims[0]!.sources;
    assert.equal(sources.length, 1);
    assert.equal(sources[0]!.display_name, "Fictional lineage source");
    assert.equal(sources[0]!.url, "https://lineage.invalid/hosted22-ok");
  });

  it("(b) a repeated publication from the same source keeps the first row unchanged and adds no second row", async () => {
    const sourceId = "source-lineage-hosted22-ok";
    const rowsBefore = await attributionsFor("rev-lineage-hosted22-ok");
    assert.equal(rowsBefore.length, 1);

    await persist(agentProposal(lineageOk, sourceId, "hosted22-ok", "inc-h22-ok-2"));
    assert.equal((await auto("prop-inc-h22-ok-2")).status, "published");

    const rowsAfter = await attributionsFor("rev-lineage-hosted22-ok");
    assert.deepEqual(rowsAfter, rowsBefore, "the same row, with the same reviewed_at and the same id");
    const page = await listService().read();
    assert.ok(page.events.some((event) => event.event_id === "inc-h22-ok-2"), "the second event lists too");
  });

  it("(c) a revoked source writes no attribution, collection stays on, and under the default gate the event is queued as source_revoked", async () => {
    const sourceId = "source-lineage-hosted22-off";
    // HOSTED-28: revocation changes the approval only. Collection stays on (FR-16).
    await db.executor.query(
      `UPDATE waspada.source_registry
       SET approval_status = 'revoked'
       WHERE source_id = $1`,
      [sourceId],
    );
    assert.deepEqual(
      (await db.executor.query<{ auto_acquisition_enabled: boolean }>(
        "SELECT auto_acquisition_enabled FROM waspada.source_registry WHERE source_id = $1",
        [sourceId],
      )).rows.map((row) => row.auto_acquisition_enabled),
      [true],
    );
    await persist(agentProposal(lineageOff, sourceId, "hosted22-off", "inc-h22-off-1"));
    const outcome = await auto("prop-inc-h22-off-1");
    assert.equal(outcome.status, "queued", JSON.stringify(outcome));
    assert.ok(((outcome as { reasons?: readonly string[] }).reasons ?? []).includes("source_revoked"));

    assert.deepEqual(await attributionsFor("rev-lineage-hosted22-off"), []);
    const versions = await db.executor.query<{ n: number }>(
      "SELECT COUNT(*)::int AS n FROM waspada.event_versions WHERE dataset_kind = 'live' AND event_id = 'inc-h22-off-1'",
    );
    assert.equal(versions.rows[0]!.n, 0, "no public version exists for the queued event");
  });

  it("(d) under local_relaxed a revoked source publishes without an attribution, the list skips that event, and its detail answers not found", async () => {
    // HOSTED-28: the local_relaxed waiver never reaches a revoked source. The gate refuses the proposal with
    // source_revoked, so nothing publishes, no attribution is written and the public reads show no version.
    await persist(agentProposal(lineageOff, "source-lineage-hosted22-off", "hosted22-off", "inc-h22-off-2"));
    const outcome = await auto("prop-inc-h22-off-2", "local_relaxed");
    assert.equal(outcome.status, "queued", JSON.stringify(outcome));
    assert.ok(((outcome as { reasons?: readonly string[] }).reasons ?? []).includes("source_revoked"));
    assert.deepEqual(await attributionsFor("rev-lineage-hosted22-off"), [], "no attribution row for the revoked source");
    const versions = await db.executor.query<{ n: number }>(
      "SELECT COUNT(*)::int AS n FROM waspada.event_versions WHERE dataset_kind = 'live' AND event_id = 'inc-h22-off-2'",
    );
    assert.equal(versions.rows[0]!.n, 0, "no public version exists for the revoked source's event");
    const page = await listService().read();
    const listedIds = page.events.map((event) => event.event_id);
    assert.ok(listedIds.includes("inc-h22-ok-1"), "the attributed event still lists");
    assert.equal(listedIds.includes("inc-h22-off-2"), false, "the revoked source's event is not listed");

    const detail = createPublicEventDetailProjectionService({
      snapshots: createPublicEventSnapshotRepository(db.executor),
      lookups: createPublicProjectionLookupRepository(db.executor),
      geometries: createPublicEventGeometriesRepository(db.executor),
    });
    assert.deepEqual(await detail.read("inc-h22-off-2"), { kind: "missing" }, "the detail route answers not found");
  });

  it("(e) the attribution writer runs as the publication role: insert, repeat and the skip path need no read of the attribution table", async () => {
    const refs = await db.executor.query<{ evidence_ref_id: string }>(
      `SELECT evidence_ref_id::text AS evidence_ref_id FROM waspada.evidence_references
       WHERE dataset_kind = 'live' AND report_revision_id = 'rev-lineage-hosted22-role' AND relation = 'supports'`,
    );
    const evidenceRefIds = refs.rows.map((row) => row.evidence_ref_id);
    assert.equal(evidenceRefIds.length, 1);
    const sourceId = "source-lineage-hosted22-role";
    const decidedAt = "2026-11-10T08:06:00.000Z";

    await db.executor.execute("SET ROLE waspada_l4_publication_writer");
    try {
      const skipped = await writeSourceAttributions(db.executor, {
        datasetKind: "live", evidenceRefIds, publicDisplaySourceIds: new Set(["some-other-source"]), decidedAt,
      });
      assert.deepEqual(skipped, { attributed: 0, skipped: 1 }, "a source outside the rights check gets no row");

      const first = await writeSourceAttributions(db.executor, {
        datasetKind: "live", evidenceRefIds, publicDisplaySourceIds: new Set([sourceId]), decidedAt,
      });
      const second = await writeSourceAttributions(db.executor, {
        datasetKind: "live", evidenceRefIds, publicDisplaySourceIds: new Set([sourceId]), decidedAt: "2026-11-10T09:00:00.000Z",
      });
      assert.deepEqual(first, { attributed: 1, skipped: 0 });
      assert.deepEqual(second, { attributed: 1, skipped: 0 }, "the repeat is a no-op on the database");

      await assert.rejects(
        db.executor.query("SELECT COUNT(*) FROM waspada.public_attribution_review_decisions"),
        /permission denied/,
        "the publication role still cannot read the attribution table",
      );
      await assert.rejects(
        db.executor.query("SELECT permitted_text FROM waspada.report_revisions LIMIT 1"),
        /permission denied/,
        "the revision's permitted text stays unreadable to the publication role",
      );
    } finally {
      await db.executor.execute("RESET ROLE");
    }

    const stored = await attributionsFor("rev-lineage-hosted22-role");
    assert.equal(stored.length, 1, "one row, however many times the writer ran");
    assert.equal(stored[0]!.reviewed_at, "2026-11-10T08:06:00.000000Z", "the first decision time is kept");
    assert.equal(stored[0]!.source_published_at, SOURCE_PUBLISHED_AT_TEXT);
  });
});
