import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { createTestDatabase, type TestDatabase } from "../../db/test/harness.js";
import { applyMigrations, readMigrations } from "../../db/src/migrations.js";
import { createEventProposalWriter, type EventProposalDto } from "../../db/src/event-proposal-writer.js";
import {
  AGENT_AUTO_PUBLISHER_ID,
  decideProposal,
  type ProposalDecisionDependencies,
} from "../src/layers/l4-application-integration/proposal-publication.js";
import {
  parseAutoPublishSourcePermission,
  SOURCE_PERMISSION_WAIVED_LOCAL,
} from "../src/layers/l4-application-integration/publication-policy.js";
import { PublicReadModel } from "../src/layers/l4-application-integration/public-read-model.js";

/**
 * MERGE-REVIEW-01 (ADR-061): one decision writer for the agent and moderators. These tests use the
 * real proposal table and the real publication_decisions audit table (PGlite).
 */

const PERMITTED_SOURCES = new Set(["source-detik", "source-antara"]);

type TestEvidenceLabel = "attributed_report" | "issuer_notice" | "crowdsourced_observation" | "independent_corroboration";

function claim(
  id: string,
  text: string,
  source: { id: string; outlet: string; url: string } | null,
  label: TestEvidenceLabel = "attributed_report",
) {
  return {
    claim_id: id,
    claim_text: text,
    evidence_label: label,
    support_assessment: "supported" as const,
    quote_text: text,
    evidence_ref_id: `chk-${id}`,
    source_id: source?.id ?? null,
    outlet: source?.outlet ?? null,
    source_url: source?.url ?? null,
  };
}

function proposal(
  proposalId: string,
  incidentId: string,
  options: {
    readonly claims?: EventProposalDto["claims"];
    readonly hasDiscrepancy?: boolean;
    readonly discrepancySummary?: string | null;
    readonly relationship?: "primary_initial" | "corroborating" | "unresolved";
    readonly title?: string;
    readonly proposedAt?: string;
  } = {},
): EventProposalDto {
  const claims = options.claims ?? [
    claim("claim-1", "Genangan 50 cm di Cawang", { id: "source-detik", outlet: "Detik News", url: "https://news.example/cawang" }),
  ];
  return {
    schema_version: "2.0",
    proposal_id: proposalId,
    incident_id: incidentId,
    title: options.title ?? "Genangan di Cawang",
    incident_type: "genangan_air_luapan_saluran",
    primary_category: "disasters_weather",
    compatibility_category: "flood",
    severity: "medium",
    event_time: { precision: "exact", value: "2026-11-10T08:00:00.000Z" },
    location_label: "Cawang, Jakarta Timur",
    coordinates: null,
    claims,
    impacts: [],
    interpretation_category: null,
    source_id: claims[0]?.source_id ?? null,
    is_multi_source: false,
    source_count: 1,
    has_discrepancy: options.hasDiscrepancy ?? false,
    discrepancy_summary: options.discrepancySummary ?? null,
    discrepancies: [],
    caveats: [],
    correlation_relationship: options.relationship ?? "primary_initial",
    proposed_at: options.proposedAt ?? "2026-11-10T08:05:00.000Z",
  } as EventProposalDto;
}

describe("MERGE-REVIEW-01 decision writer", () => {
  let db: TestDatabase;
  let deps: ProposalDecisionDependencies;
  const writer = () => createEventProposalWriter(db.executor);

  before(async () => {
    db = await createTestDatabase();
    const migrations = await readMigrations(new URL("../../db/migrations/", import.meta.url));
    await applyMigrations(db.executor, migrations);
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

  function publishedEvent(eventId: string) {
    return PublicReadModel.getPublishedEvents().find((event) => event.event_id === eventId) ?? null;
  }

  async function decisionsFor(proposalId: string) {
    const result = await db.executor.query<{ reviewer_id: string | null; record_json: Record<string, unknown> }>(
      `SELECT reviewer_id, record_json FROM waspada.publication_decisions
       WHERE dataset_kind = 'live' AND proposal_id = $1 ORDER BY decided_at ASC`,
      [proposalId],
    );
    return result.rows;
  }

  it("publishes a proposal without discrepancy with the agent actor and attributed labels", async () => {
    await writer().persistProposal(proposal("prop-inc-a1", "inc-a"), "live");

    const outcome = await decideProposal(deps, {
      proposalId: "prop-inc-a1",
      action: "auto_publish",
      actor: { kind: "agent", actorId: AGENT_AUTO_PUBLISHER_ID },
    });
    assert.equal(outcome.status, "published");

    const [decision] = await decisionsFor("prop-inc-a1");
    assert.equal(decision?.reviewer_id, AGENT_AUTO_PUBLISHER_ID);
    assert.equal(decision?.record_json.disposition, "publish");
    assert.equal(decision?.record_json.publication_mode, "agent_auto");

    const event = publishedEvent("inc-a");
    assert.ok(event, "the event is public");
    assert.equal(event.version, 1);
    assert.equal(event.publication?.mode, "agent_auto");
    assert.equal(event.claims[0]?.evidence_label, "attributed_report");
    assert.equal(event.claims[0]?.sources[0]?.url, "https://news.example/cawang");
    assert.equal(event.claims[0]?.sources[0]?.display_name, "Detik News");
  });

  it("queues a proposal with a discrepancy for a moderator and leaves it pending", async () => {
    await writer().persistProposal(
      proposal("prop-inc-b1", "inc-b", {
        hasDiscrepancy: true,
        discrepancySummary: "Laporan rev-b1 menyebut 50 cm, laporan rev-b2 menyebut 30 cm.",
      }),
      "live",
    );

    const outcome = await decideProposal(deps, {
      proposalId: "prop-inc-b1",
      action: "auto_publish",
      actor: { kind: "agent", actorId: AGENT_AUTO_PUBLISHER_ID },
    });
    assert.equal(outcome.status, "queued");
    assert.ok(outcome.status === "queued" && outcome.reasons.includes("discrepancy_flagged"));
    assert.equal((await decisionsFor("prop-inc-b1")).length, 0, "no decision row is written for a queued proposal");
    assert.equal(publishedEvent("inc-b"), null, "nothing is public");

    const pending = await writer().readPendingProposals("live");
    assert.ok(pending.some((item) => item.proposal_id === "prop-inc-b1" && item.has_discrepancy === true));
  });

  it("keeps the old public version when a conflicting new version of a published event is queued", async () => {
    await writer().persistProposal(
      proposal("prop-inc-a2", "inc-a", {
        title: "Genangan di Cawang (versi baru)",
        hasDiscrepancy: true,
        discrepancySummary: "Laporan baru menyebut 80 cm.",
        relationship: "corroborating",
        proposedAt: "2026-11-10T09:00:00.000Z",
        claims: [
          claim("claim-1", "Genangan 50 cm di Cawang", { id: "source-detik", outlet: "Detik News", url: "https://news.example/cawang" }),
          claim("claim-2", "Genangan 80 cm di Cawang", { id: "source-antara", outlet: "Antara News", url: "https://news.example/antara" }),
        ],
      }),
      "live",
    );

    const outcome = await decideProposal(deps, {
      proposalId: "prop-inc-a2",
      action: "auto_publish",
      actor: { kind: "agent", actorId: AGENT_AUTO_PUBLISHER_ID },
    });
    assert.equal(outcome.status, "queued");
    const stillPublic = publishedEvent("inc-a");
    assert.ok(stillPublic);
    assert.equal(stillPublic.version, 1, "the old version stays public");
    assert.equal(stillPublic.title, "Genangan di Cawang", "the public title is still the first version's");
    assert.equal(stillPublic.claims.length, 1);
    const pending = await writer().readPendingProposals("live");
    assert.ok(pending.some((item) => item.proposal_id === "prop-inc-a2"), "the new version waits in the queue");
  });

  it("never auto-publishes a claim labelled independent_corroboration", async () => {
    await writer().persistProposal(
      proposal("prop-inc-f1", "inc-f", {
        claims: [claim("claim-1", "Kebakaran di Tanah Abang", { id: "source-detik", outlet: "Detik News", url: "https://news.example/f" }, "independent_corroboration")],
      }),
      "live",
    );
    const outcome = await decideProposal(deps, {
      proposalId: "prop-inc-f1",
      action: "auto_publish",
      actor: { kind: "agent", actorId: AGENT_AUTO_PUBLISHER_ID },
    });
    assert.equal(outcome.status, "queued");
    assert.ok(outcome.status === "queued" && outcome.reasons.includes("claim_label_not_allowed"));
  });

  it("rejects a proposal without publishing it, and a later publish is refused", async () => {
    await writer().persistProposal(proposal("prop-inc-c1", "inc-c"), "live");

    const rejected = await decideProposal(deps, {
      proposalId: "prop-inc-c1",
      action: "reject",
      actor: { kind: "moderator", actorId: "mod-1" },
      reason: "bukan insiden",
    });
    assert.equal(rejected.status, "rejected");
    assert.equal(publishedEvent("inc-c"), null, "a rejected proposal never becomes public");
    const pending = await writer().readPendingProposals("live");
    assert.ok(!pending.some((item) => item.proposal_id === "prop-inc-c1"), "a rejected proposal leaves the queue");

    const late = await decideProposal(deps, {
      proposalId: "prop-inc-c1",
      action: "publish",
      actor: { kind: "moderator", actorId: "mod-1" },
    });
    assert.equal(late.status, "already_decided");
    assert.equal(publishedEvent("inc-c"), null);
  });

  it("publishes a queued discrepancy proposal when a moderator approves it, labelled as moderator-reviewed", async () => {
    const outcome = await decideProposal(deps, {
      proposalId: "prop-inc-b1",
      action: "publish",
      actor: { kind: "moderator", actorId: "mod-1" },
      reason: "Kedua laporan diverifikasi.",
    });
    assert.equal(outcome.status, "published");
    const event = publishedEvent("inc-b");
    assert.equal(event?.publication?.mode, "moderator_reviewed");
    const [decision] = await decisionsFor("prop-inc-b1");
    assert.equal(decision?.reviewer_id, "mod-1");
  });

  it("denies moderator publication when a claim's source has no public-display permission", async () => {
    await writer().persistProposal(
      proposal("prop-inc-d1", "inc-d", {
        claims: [claim("claim-1", "Hujan deras di Kemang", { id: "source-unlicensed", outlet: "Outlet Tanpa Izin", url: "https://news.example/d" })],
      }),
      "live",
    );
    const outcome = await decideProposal(deps, {
      proposalId: "prop-inc-d1",
      action: "publish",
      actor: { kind: "moderator", actorId: "mod-1" },
    });
    assert.equal(outcome.status, "denied");
    assert.ok(outcome.status === "denied" && outcome.code === "publication_not_authorized");
    assert.equal(publishedEvent("inc-d"), null, "moderator approval never overrides missing rights");
  });

  describe("ADR-061 amendment: local live source-permission waiver", () => {
    const unpermittedClaim = (id: string, url: string | null = `https://news.example/${id}`) => ({
      ...claim("claim-1", "Hujan deras di Kemang", { id: "source-unlicensed", outlet: "Outlet Tanpa Izin", url: url ?? "" }),
      source_url: url,
    });

    it("queues an unpermitted source when the permission check is required (unset or unrecognised value)", async () => {
      await writer().persistProposal(
        proposal("prop-inc-r1", "inc-r1", { claims: [unpermittedClaim("inc-r1")] }),
        "live",
      );
      const unset = await decideProposal(deps, {
        proposalId: "prop-inc-r1",
        action: "auto_publish",
        actor: { kind: "agent", actorId: AGENT_AUTO_PUBLISHER_ID },
      });
      assert.equal(unset.status, "queued");
      assert.ok(unset.status === "queued" && unset.reasons.includes("source_rights_missing"));

      const garbage = await decideProposal(deps, {
        proposalId: "prop-inc-r1",
        action: "auto_publish",
        actor: { kind: "agent", actorId: AGENT_AUTO_PUBLISHER_ID },
        sourcePermission: parseAutoPublishSourcePermission("yes"),
      });
      assert.equal(garbage.status, "queued");
      assert.ok(garbage.status === "queued" && garbage.reasons.includes("source_rights_missing"));

      assert.equal((await decisionsFor("prop-inc-r1")).length, 0, "no decision row for a queued proposal");
      assert.equal(publishedEvent("inc-r1"), null, "nothing is public");
    });

    it("auto-publishes an unpermitted source under local_relaxed and records the waiver on the decision and the public version", async () => {
      await writer().persistProposal(
        proposal("prop-inc-r2", "inc-r2", { claims: [unpermittedClaim("inc-r2")] }),
        "live",
      );
      const outcome = await decideProposal(deps, {
        proposalId: "prop-inc-r2",
        action: "auto_publish",
        actor: { kind: "agent", actorId: AGENT_AUTO_PUBLISHER_ID },
        sourcePermission: parseAutoPublishSourcePermission("local_relaxed"),
      });
      assert.equal(outcome.status, "published");

      const [decision] = await decisionsFor("prop-inc-r2");
      assert.equal(decision?.record_json.disposition, "publish");
      assert.equal(decision?.record_json.gate, "agent_auto_publication");
      assert.deepEqual(decision?.record_json.waivers, [SOURCE_PERMISSION_WAIVED_LOCAL]);

      const event = publishedEvent("inc-r2");
      assert.ok(event, "the event is public");
      assert.equal(event.publication?.mode, "agent_auto");
      assert.deepEqual(event.publication?.waivers, [SOURCE_PERMISSION_WAIVED_LOCAL]);
    });

    it("still queues a discrepancy under local_relaxed", async () => {
      await writer().persistProposal(
        proposal("prop-inc-r3", "inc-r3", {
          claims: [unpermittedClaim("inc-r3")],
          hasDiscrepancy: true,
          discrepancySummary: "Laporan rev-r3a menyebut 50 cm, laporan rev-r3b menyebut 30 cm.",
        }),
        "live",
      );
      const outcome = await decideProposal(deps, {
        proposalId: "prop-inc-r3",
        action: "auto_publish",
        actor: { kind: "agent", actorId: AGENT_AUTO_PUBLISHER_ID },
        sourcePermission: "local_relaxed",
      });
      assert.equal(outcome.status, "queued");
      assert.ok(outcome.status === "queued" && outcome.reasons.includes("discrepancy_flagged"));
      assert.equal(publishedEvent("inc-r3"), null);
      assert.equal((await decisionsFor("prop-inc-r3")).length, 0);
    });

    it("still queues a claim without a source link under local_relaxed", async () => {
      await writer().persistProposal(
        proposal("prop-inc-r4", "inc-r4", { claims: [unpermittedClaim("inc-r4", null)] }),
        "live",
      );
      const outcome = await decideProposal(deps, {
        proposalId: "prop-inc-r4",
        action: "auto_publish",
        actor: { kind: "agent", actorId: AGENT_AUTO_PUBLISHER_ID },
        sourcePermission: "local_relaxed",
      });
      assert.equal(outcome.status, "queued");
      assert.ok(outcome.status === "queued" && outcome.reasons.includes("claim_source_link_missing"));
      assert.equal(publishedEvent("inc-r4"), null);
    });

    it("keeps moderator publication unchanged: local_relaxed never waives the moderator's rights check", async () => {
      await writer().persistProposal(
        proposal("prop-inc-r5", "inc-r5", { claims: [unpermittedClaim("inc-r5")] }),
        "live",
      );
      const outcome = await decideProposal(deps, {
        proposalId: "prop-inc-r5",
        action: "publish",
        actor: { kind: "moderator", actorId: "mod-1" },
        sourcePermission: "local_relaxed",
      });
      assert.equal(outcome.status, "denied");
      assert.ok(outcome.status === "denied" && outcome.code === "publication_not_authorized");
      assert.equal(publishedEvent("inc-r5"), null, "moderator approval still never overrides missing rights");
    });
  });

  it("reports an unknown proposal as not found", async () => {
    const outcome = await decideProposal(deps, {
      proposalId: "prop-does-not-exist",
      action: "auto_publish",
      actor: { kind: "agent", actorId: AGENT_AUTO_PUBLISHER_ID },
    });
    assert.deepEqual(outcome, { status: "denied", code: "proposal_not_found" });
  });
});
