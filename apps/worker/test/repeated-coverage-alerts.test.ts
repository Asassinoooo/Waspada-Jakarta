import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { createTestDatabase, type TestDatabase } from "../../db/test/harness.js";
import { applyMigrations, readMigrations } from "../../db/src/migrations.js";
import { createEventProposalWriter, type EventProposalDto } from "../../db/src/event-proposal-writer.js";
import { createPublicEventUpdatesReader } from "../../db/src/public-event-updates.js";
import {
  AGENT_AUTO_PUBLISHER_ID,
  decideProposal,
  type ProposalDecisionDependencies,
} from "../src/layers/l4-application-integration/proposal-publication.js";
import { PublicReadModel } from "../src/layers/l4-application-integration/public-read-model.js";

/**
 * FR-11, repeated coverage. The first delivery of a proposal publishes once. A re-delivery of the
 * same proposal writes nothing. A repeated report of the same facts from another outlet should not
 * create a second public version, and a published version should reach the updates feed. The last
 * two are expected behaviour that current code does not meet: they are todo findings, not passes.
 * Authored fictional data, real PGlite tables and the real decision writer.
 */

const PERMITTED = new Set(["source-detik", "source-antara"]);
const CLAIM_TEXT = "Genangan 50 cm di Cawang";

function proposal(
  proposalId: string,
  incidentId: string,
  sourceId = "source-detik",
  options: { readonly relationship?: "primary_initial" | "corroborating"; readonly proposedAt?: string } = {},
): EventProposalDto {
  const claim = {
    claim_id: "claim-1",
    claim_text: CLAIM_TEXT,
    evidence_label: "attributed_report" as const,
    support_assessment: "supported" as const,
    quote_text: CLAIM_TEXT,
    evidence_ref_id: "chk-" + proposalId,
    source_id: sourceId,
    outlet: sourceId === "source-detik" ? "Detik News" : "Antara News",
    source_url: "https://news.example/" + proposalId,
  };
  return {
    schema_version: "2.0",
    proposal_id: proposalId,
    incident_id: incidentId,
    title: "Genangan di Cawang",
    incident_type: "genangan_air_luapan_saluran",
    primary_category: "disasters_weather",
    compatibility_category: "flood",
    severity: "medium",
    event_time: { precision: "exact", value: "2026-11-10T08:00:00.000Z" },
    location_label: "Cawang, Jakarta Timur",
    coordinates: null,
    claims: [claim],
    impacts: [],
    interpretation_category: null,
    source_id: sourceId,
    is_multi_source: false,
    source_count: 1,
    has_discrepancy: false,
    discrepancy_summary: null,
    discrepancies: [],
    caveats: [],
    correlation_relationship: options.relationship ?? "primary_initial",
    proposed_at: options.proposedAt ?? "2026-11-10T08:05:00.000Z",
  } as EventProposalDto;
}

describe("FR-11 repeated coverage and re-delivery", () => {
  let db: TestDatabase;
  let deps: ProposalDecisionDependencies;
  const writer = () => createEventProposalWriter(db.executor);
  const auto = (proposalId: string) => decideProposal(deps, {
    proposalId,
    action: "auto_publish",
    actor: { kind: "agent", actorId: AGENT_AUTO_PUBLISHER_ID },
  });

  async function versionCount(eventId: string): Promise<number> {
    const result = await db.executor.query<{ n: number }>(
      "SELECT COUNT(*)::int AS n FROM waspada.event_versions WHERE dataset_kind = 'live' AND event_id = $1",
      [eventId],
    );
    return result.rows[0]!.n;
  }

  async function decisionCount(proposalId: string): Promise<number> {
    const result = await db.executor.query<{ n: number }>(
      "SELECT COUNT(*)::int AS n FROM waspada.publication_decisions WHERE dataset_kind = 'live' AND proposal_id = $1",
      [proposalId],
    );
    return result.rows[0]!.n;
  }

  before(async () => {
    db = await createTestDatabase();
    await applyMigrations(db.executor, await readMigrations(new URL("../../db/migrations/", import.meta.url)));
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

  it("a re-delivered proposal is already decided: no second decision and no second public version", async () => {
    await writer().persistProposal(proposal("prop-rep-redeliver", "inc-rep-redeliver"), "live");

    const first = await auto("prop-rep-redeliver");
    assert.equal(first.status, "published", JSON.stringify(first));
    assert.equal(await versionCount("inc-rep-redeliver"), 1);

    const again = await auto("prop-rep-redeliver");
    assert.equal(again.status, "already_decided");
    assert.equal(await decisionCount("prop-rep-redeliver"), 1);
    assert.equal(await versionCount("inc-rep-redeliver"), 1, "re-delivery adds no version");
  });

  it("a repeated report of the same facts from another outlet does not publish a second version",
    { todo: "F-ALERT-01 a repeated report of unchanged facts publishes version 2 and a second card" },
    async () => {
      await writer().persistProposal(proposal("prop-rep-dup-a", "inc-rep-dup", "source-detik"), "live");
      assert.equal((await auto("prop-rep-dup-a")).status, "published");

      await writer().persistProposal(
        proposal("prop-rep-dup-b", "inc-rep-dup", "source-antara", {
          relationship: "corroborating",
          proposedAt: "2026-11-10T09:00:00.000Z",
        }),
        "live",
      );
      await auto("prop-rep-dup-b");
      assert.equal(await versionCount("inc-rep-dup"), 1,
        "the same facts from a second outlet add no public version and no update");
    });

  it("a newly published version appears in the public updates feed",
    { todo: "F-ALERT-02 no production writer records the approved history review the updates feed requires" },
    async () => {
      await writer().persistProposal(proposal("prop-rep-feed", "inc-rep-feed"), "live");
      const decided = await auto("prop-rep-feed");
      assert.equal(decided.status, "published", JSON.stringify(decided));

      const reader = createPublicEventUpdatesReader(db.executor);
      const watermark = await reader.readWatermark();
      const page = await reader.readCandidates({ afterSequence: "0", throughSequence: watermark, limit: 20 });
      assert.equal(page.candidates.some((candidate) => candidate.eventId === "inc-rep-feed"), true,
        "the published version is listed as a material update");
    });
});
