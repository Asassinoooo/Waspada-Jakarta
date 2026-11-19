import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { createTestDatabase, type TestDatabase } from "../../db/test/harness.js";
import { seedProposalLineage, type ProposalLineage } from "../../db/test/proposal-lineage-fixture.js";
import { applyMigrations, readMigrations } from "../../db/src/migrations.js";
import { createEventProposalWriter, type EventProposalDto } from "../../db/src/event-proposal-writer.js";
import {
  AGENT_AUTO_PUBLISHER_ID,
  decideProposal,
  expireStaleProposals,
  type ProposalDecisionDependencies,
} from "../src/layers/l4-application-integration/proposal-publication.js";
import { PublicReadModel } from "../src/layers/l4-application-integration/public-read-model.js";

/**
 * POLISH-03 (ADR-062 amendment): a proposal superseded by a newer proposal of its incident is a terminal decision.
 * A moderator or agent decision refuses it as already_decided, the expiry sweep skips it, and the newer proposal
 * still publishes normally. These tests use the real proposal and decision tables (PGlite).
 */

const PERMITTED_SOURCES = new Set(["source-detik", "source-antara"]);
const NOW = new Date("2026-11-19T12:00:00.000Z");
const HOUR = 3_600_000;
const hoursBefore = (hours: number) => new Date(NOW.getTime() - hours * HOUR).toISOString();

let lineage: ProposalLineage | undefined;

function proposal(proposalId: string, incidentId: string, proposedAt: string): EventProposalDto {
  const claim = {
    claim_id: `claim-${proposalId}`,
    claim_text: `Genangan di Cawang (${proposalId})`,
    evidence_label: "attributed_report" as const,
    support_assessment: "supported" as const,
    quote_text: `Genangan di Cawang (${proposalId})`,
    evidence_ref_id: `chk-${proposalId}`,
    source_id: "source-detik",
    outlet: "Outlet Uji",
    source_url: `https://news.example/${proposalId}`,
  };
  return {
    schema_version: "2.0",
    ...(lineage ?? {}),
    proposal_id: proposalId,
    incident_id: incidentId,
    title: "Genangan di Cawang",
    incident_type: "genangan_air_luapan_saluran",
    primary_category: "disasters_weather",
    compatibility_category: "flood",
    severity: "medium",
    event_time: { precision: "exact", value: "2026-11-19T08:00:00.000Z" },
    location_label: "Cawang, Jakarta Timur",
    coordinates: null,
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
    proposed_at: proposedAt,
  } as EventProposalDto;
}

describe("POLISH-03 a superseded proposal is terminal", () => {
  let db: TestDatabase;
  let deps: ProposalDecisionDependencies;
  const writer = () => createEventProposalWriter(db.executor);

  before(async () => {
    db = await createTestDatabase();
    const migrations = await readMigrations(new URL("../../db/migrations/", import.meta.url));
    await applyMigrations(db.executor, migrations);
    lineage = await seedProposalLineage(db.executor, "proposal-supersede-worker");
    deps = {
      executor: db.executor,
      datasetKind: "live",
      checkPublicDisplay: async (sourceId: string) => PERMITTED_SOURCES.has(sourceId),
    };
    PublicReadModel.clearPublishedEvents();
  });

  after(async () => {
    await db?.close();
  });

  async function dispositions(proposalId: string): Promise<string[]> {
    const result = await db.executor.query<{ disposition: string }>(
      `SELECT record_json->>'disposition' AS disposition FROM waspada.publication_decisions
       WHERE dataset_kind = 'live' AND proposal_id = $1 ORDER BY decided_at ASC, decision_id ASC`,
      [proposalId],
    );
    return result.rows.map((row) => row.disposition);
  }

  it("refuses a superseded proposal to a moderator publish, a moderator reject and an agent auto-publish as already_decided", async () => {
    await writer().persistProposal(proposal("sw-old", "inc-sw", hoursBefore(60)), "live");
    await writer().persistProposal(proposal("sw-new", "inc-sw", hoursBefore(2)), "live");
    assert.deepEqual(await dispositions("sw-old"), ["supersede"], "the newer proposal superseded it");
    const publicBefore = PublicReadModel.getPublishedEvents().length;

    const published = await decideProposal(deps, {
      proposalId: "sw-old",
      action: "publish",
      actor: { kind: "moderator", actorId: "mod-1" },
    });
    assert.deepEqual(published, { status: "already_decided", disposition: "supersede" });

    const rejected = await decideProposal(deps, {
      proposalId: "sw-old",
      action: "reject",
      actor: { kind: "moderator", actorId: "mod-1" },
      reason: "tidak relevan",
    });
    assert.deepEqual(rejected, { status: "already_decided", disposition: "supersede" });

    const agent = await decideProposal(deps, {
      proposalId: "sw-old",
      action: "auto_publish",
      actor: { kind: "agent", actorId: AGENT_AUTO_PUBLISHER_ID },
      sourcePermission: "required",
    });
    assert.deepEqual(agent, { status: "already_decided", disposition: "supersede" });

    assert.equal(PublicReadModel.getPublishedEvents().length, publicBefore, "nothing new is public");
    assert.deepEqual(await dispositions("sw-old"), ["supersede"], "no publish or reject row is added");
  });

  it("the expiry sweep skips a superseded proposal, even when it is older than the review TTL", async () => {
    const result = await expireStaleProposals({
      executor: db.executor,
      writer: writer(),
      datasetKind: "live",
      now: NOW,
      ttlHours: 48,
    });
    assert.deepEqual(result, { expired: 0, skipped_already_decided: 0, failed: 0 });
    assert.deepEqual(await dispositions("sw-old"), ["supersede"], "no expire row is added");
  });

  it("the newer proposal still publishes normally, and the superseded one keeps only its supersede row", async () => {
    const outcome = await decideProposal(deps, {
      proposalId: "sw-new",
      action: "auto_publish",
      actor: { kind: "agent", actorId: AGENT_AUTO_PUBLISHER_ID },
      sourcePermission: "required",
    });
    assert.equal(outcome.status, "published", JSON.stringify(outcome));
    assert.deepEqual(await dispositions("sw-new"), ["publish"]);
    assert.deepEqual(await dispositions("sw-old"), ["supersede"]);
    assert.ok(
      PublicReadModel.getPublishedEvents().some((event) => event.event_id === "inc-sw" && event.version === 1),
      "the newer proposal is the one public version",
    );
  });
});
