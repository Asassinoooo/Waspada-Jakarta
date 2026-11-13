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
  type ProposalDecisionOutcome,
} from "../src/layers/l4-application-integration/proposal-publication.js";
import { PublicReadModel } from "../src/layers/l4-application-integration/public-read-model.js";

/**
 * FR-11, repeated coverage. The first delivery of a proposal publishes once, and a re-delivery writes nothing.
 * A repeated report of facts that are already public, from the same or another outlet, adds no version and no
 * update (F-ALERT-01). A material change publishes the next version. A published version must reach the public
 * updates feed (F-ALERT-02). That last test is a todo finding until the owner decides how review rows are written.
 * Authored fictional data, real PGlite tables and the real decision writer.
 */

const PERMITTED = new Set(["source-detik", "source-antara"]);
const CLAIM_TEXT = "Genangan 50 cm di Cawang";
const MODERATOR_ID = "fictional-moderator-rep";

interface ProposalOptions {
  readonly relationship?: "primary_initial" | "corroborating";
  readonly proposedAt?: string;
  readonly claimText?: string;
  readonly severity?: string;
  readonly eventTime?: string;
}

function proposal(
  proposalId: string,
  incidentId: string,
  sourceId = "source-detik",
  options: ProposalOptions = {},
): EventProposalDto {
  const claimText = options.claimText ?? CLAIM_TEXT;
  const claim = {
    claim_id: "claim-1",
    claim_text: claimText,
    evidence_label: "attributed_report" as const,
    support_assessment: "supported" as const,
    quote_text: claimText,
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
    severity: options.severity ?? "medium",
    event_time: { precision: "exact", value: options.eventTime ?? "2026-11-10T08:00:00.000Z" },
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

/** The fields a test asserts on, without the publication mode or the projected detail. */
function outcomeSummary(outcome: ProposalDecisionOutcome): Record<string, unknown> {
  return outcome.status === "published" || outcome.status === "unchanged"
    ? { status: outcome.status, eventId: outcome.eventId, version: outcome.version }
    : { status: outcome.status };
}

describe("FR-11 repeated coverage and re-delivery", () => {
  let db: TestDatabase;
  let deps: ProposalDecisionDependencies;
  const persist = (value: EventProposalDto) => createEventProposalWriter(db.executor).persistProposal(value, "live");
  const auto = (proposalId: string) => decideProposal(deps, {
    proposalId,
    action: "auto_publish",
    actor: { kind: "agent", actorId: AGENT_AUTO_PUBLISHER_ID },
  });
  const moderate = (proposalId: string) => decideProposal(deps, {
    proposalId,
    action: "publish",
    actor: { kind: "moderator", actorId: MODERATOR_ID },
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

  async function decisionRows(proposalId: string) {
    const result = await db.executor.query<{
      disposition: string;
      event_id: string | null;
      event_version: number | null;
    }>(
      `SELECT record_json->>'disposition' AS disposition, event_id, event_version
       FROM waspada.publication_decisions WHERE dataset_kind = 'live' AND proposal_id = $1`,
      [proposalId],
    );
    return result.rows;
  }

  /** The event ids the public updates feed lists, read through the real DB reader. */
  async function feedEventIds(): Promise<string[]> {
    const reader = createPublicEventUpdatesReader(db.executor);
    const watermark = await reader.readWatermark();
    const page = await reader.readCandidates({ afterSequence: "0", throughSequence: watermark, limit: 100 });
    return page.candidates.map((candidate) => candidate.eventId);
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
    await persist(proposal("prop-rep-redeliver", "inc-rep-redeliver"));

    const first = await auto("prop-rep-redeliver");
    assert.equal(first.status, "published", JSON.stringify(first));
    assert.equal(await versionCount("inc-rep-redeliver"), 1);

    const again = await auto("prop-rep-redeliver");
    assert.equal(again.status, "already_decided");
    assert.equal(await decisionCount("prop-rep-redeliver"), 1);
    assert.equal(await versionCount("inc-rep-redeliver"), 1, "re-delivery adds no version");
  });

  it("a repeated report of the same facts from another outlet adds no version and no update (F-ALERT-01)",
    async () => {
      await persist(proposal("prop-rep-dup-a", "inc-rep-dup", "source-detik"));
      assert.deepEqual(outcomeSummary(await auto("prop-rep-dup-a")), {
        status: "published", eventId: "inc-rep-dup", version: 1,
      });
      const feedBefore = await feedEventIds();

      await persist(proposal("prop-rep-dup-b", "inc-rep-dup", "source-antara", {
        relationship: "corroborating",
        proposedAt: "2026-11-10T09:00:00.000Z",
      }));
      assert.deepEqual(outcomeSummary(await auto("prop-rep-dup-b")), {
        status: "unchanged", eventId: "inc-rep-dup", version: 1,
      });
      assert.equal(await versionCount("inc-rep-dup"), 1, "the same facts from a second outlet add no public version");
      assert.deepEqual(await decisionRows("prop-rep-dup-b"), [
        { disposition: "no_material_change", event_id: null, event_version: null },
      ], "the decision is recorded without a version link");
      assert.deepEqual(await feedEventIds(), feedBefore, "the second delivery adds no update");
    });

  it("a moderator publish of the same facts from another outlet adds no version (F-ALERT-01)", async () => {
    await persist(proposal("prop-rep-mod-a", "inc-rep-mod", "source-detik"));
    assert.equal((await auto("prop-rep-mod-a")).status, "published");

    await persist(proposal("prop-rep-mod-b", "inc-rep-mod", "source-antara", { relationship: "corroborating" }));
    assert.deepEqual(outcomeSummary(await moderate("prop-rep-mod-b")), {
      status: "unchanged", eventId: "inc-rep-mod", version: 1,
    });
    assert.equal(await versionCount("inc-rep-mod"), 1, "a moderator publish of unchanged facts adds no version");
    assert.deepEqual(await decisionRows("prop-rep-mod-b"), [
      { disposition: "no_material_change", event_id: null, event_version: null },
    ]);
  });

  it("a material change in a claim publishes the next version (F-ALERT-01)", async () => {
    await persist(proposal("prop-rep-claim-a", "inc-rep-claim", "source-detik"));
    assert.deepEqual(outcomeSummary(await auto("prop-rep-claim-a")), {
      status: "published", eventId: "inc-rep-claim", version: 1,
    });

    await persist(proposal("prop-rep-claim-b", "inc-rep-claim", "source-antara", {
      relationship: "corroborating",
      claimText: "Genangan 80 cm di Cawang, satu orang terluka",
    }));
    assert.deepEqual(outcomeSummary(await auto("prop-rep-claim-b")), {
      status: "published", eventId: "inc-rep-claim", version: 2,
    });
    assert.equal(await versionCount("inc-rep-claim"), 2, "the changed claim adds version 2");
    assert.deepEqual(await decisionRows("prop-rep-claim-b"), [
      { disposition: "publish", event_id: "inc-rep-claim", event_version: 2 },
    ]);
  });

  it("a changed event time or severity is material and publishes the next version (F-ALERT-01)", async () => {
    await persist(proposal("prop-rep-fact-a", "inc-rep-fact", "source-detik"));
    assert.equal((await auto("prop-rep-fact-a")).status, "published");

    await persist(proposal("prop-rep-fact-b", "inc-rep-fact", "source-antara", {
      relationship: "corroborating",
      eventTime: "2026-11-10T09:30:00.000Z",
    }));
    assert.deepEqual(outcomeSummary(await auto("prop-rep-fact-b")), {
      status: "published", eventId: "inc-rep-fact", version: 2,
    });

    await persist(proposal("prop-rep-fact-c", "inc-rep-fact", "source-antara", {
      relationship: "corroborating",
      eventTime: "2026-11-10T09:30:00.000Z",
      severity: "high",
    }));
    assert.deepEqual(outcomeSummary(await auto("prop-rep-fact-c")), {
      status: "published", eventId: "inc-rep-fact", version: 3,
    });
    assert.equal(await versionCount("inc-rep-fact"), 3);
  });

  it("a moderator publish of a material change publishes the next version (F-ALERT-01)", async () => {
    await persist(proposal("prop-rep-modc-a", "inc-rep-modc", "source-detik"));
    assert.equal((await auto("prop-rep-modc-a")).status, "published");

    await persist(proposal("prop-rep-modc-b", "inc-rep-modc", "source-antara", {
      relationship: "corroborating",
      claimText: "Genangan 80 cm di Cawang, satu orang terluka",
    }));
    assert.deepEqual(outcomeSummary(await moderate("prop-rep-modc-b")), {
      status: "published", eventId: "inc-rep-modc", version: 2,
    });
    assert.equal(await versionCount("inc-rep-modc"), 2);
    assert.deepEqual(await decisionRows("prop-rep-modc-b"), [
      { disposition: "publish", event_id: "inc-rep-modc", event_version: 2 },
    ]);
  });

  it("a newly published version appears in the public updates feed (F-ALERT-02)", { todo: "F-ALERT-02 blocked: ADR-020 moderator-selected change summaries, no INSERT grant on public_event_history_review_decisions, and decideProposal record_json lacks the v2.0 Event shape" }, async () => {
    await persist(proposal("prop-rep-feed", "inc-rep-feed"));
    const decided = await auto("prop-rep-feed");
    assert.equal(decided.status, "published", JSON.stringify(decided));

    const feed = await feedEventIds();
    assert.equal(feed.includes("inc-rep-feed"), true, "the published version is listed as a material update");
  });
});
