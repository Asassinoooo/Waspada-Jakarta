import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { createTestDatabase, type TestDatabase } from "../../db/test/harness.js";
import { seedProposalLineage, type ProposalLineage } from "../../db/test/proposal-lineage-fixture.js";
import { applyMigrations, readMigrations } from "../../db/src/migrations.js";
import { createEventProposalWriter, type EventProposalDto } from "../../db/src/event-proposal-writer.js";
import {
  AGENT_AUTO_PUBLISHER_ID,
  AGENT_REVIEW_EXPIRY_ID,
  decideProposal,
  expireStaleProposals,
  type ProposalDecisionDependencies,
} from "../src/layers/l4-application-integration/proposal-publication.js";
import {
  DEFAULT_PROPOSAL_REVIEW_TTL_HOURS,
  isValidProposalReviewTtlHours,
  parseProposalReviewTtlHours,
} from "../src/layers/l4-application-integration/publication-policy.js";
import { PublicReadModel } from "../src/layers/l4-application-integration/public-read-model.js";
import { runScheduledReviewExpiry } from "../src/runtime/review-expiry-runtime.js";

/**
 * REVIEW-EXPIRY-01 (ADR-062): an undecided proposal older than the review TTL is marked expired by
 * one decision row. It never publishes. These tests use the real proposal and decision tables (PGlite).
 */

const PERMITTED_SOURCES = new Set(["source-detik", "source-antara"]);
const NOW = new Date("2026-11-12T12:00:00.000Z");
const HOUR = 3_600_000;
const hoursBefore = (hours: number) => new Date(NOW.getTime() - hours * HOUR).toISOString();

let lineage: ProposalLineage | undefined;

function proposal(proposalId: string, incidentId: string, proposedAt: string, sourceId = "source-detik"): EventProposalDto {
  const claim = {
    claim_id: `claim-${proposalId}`,
    claim_text: `Genangan di Cawang (${proposalId})`,
    evidence_label: "attributed_report" as const,
    support_assessment: "supported" as const,
    quote_text: `Genangan di Cawang (${proposalId})`,
    evidence_ref_id: `chk-${proposalId}`,
    source_id: sourceId,
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
    correlation_relationship: "primary_initial",
    proposed_at: proposedAt,
  } as EventProposalDto;
}

describe("REVIEW-EXPIRY-01 review TTL parsing", () => {
  it("defaults to 48 hours and falls back to 48 for any value that is not an integer from 1 to 720", () => {
    assert.equal(DEFAULT_PROPOSAL_REVIEW_TTL_HOURS, 48);
    assert.equal(parseProposalReviewTtlHours(undefined), 48);
    assert.equal(parseProposalReviewTtlHours(""), 48);
    for (const invalid of ["0", "721", "-5", "1.5", "abc", "24h", "99999", NaN, -1, 0.5, null, {}]) {
      assert.equal(parseProposalReviewTtlHours(invalid), 48, `fallback for ${String(invalid)}`);
      assert.equal(isValidProposalReviewTtlHours(invalid), false);
    }
  });

  it("accepts integers from 1 to 720, as a string with spaces or as a number", () => {
    assert.equal(parseProposalReviewTtlHours("1"), 1);
    assert.equal(parseProposalReviewTtlHours(" 24 "), 24);
    assert.equal(parseProposalReviewTtlHours("720"), 720);
    assert.equal(parseProposalReviewTtlHours(72), 72);
    assert.equal(isValidProposalReviewTtlHours("720"), true);
  });
});

describe("REVIEW-EXPIRY-01 expiry sweep", () => {
  let db: TestDatabase;
  let deps: ProposalDecisionDependencies;
  const writer = () => createEventProposalWriter(db.executor);

  before(async () => {
    db = await createTestDatabase();
    const migrations = await readMigrations(new URL("../../db/migrations/", import.meta.url));
    await applyMigrations(db.executor, migrations);
    lineage = await seedProposalLineage(db.executor, "review-expiry");
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

  const sweep = (ttlHours = 48) => expireStaleProposals({
    executor: db.executor,
    writer: writer(),
    datasetKind: "live",
    now: NOW,
    ttlHours,
  });

  async function decisionsFor(proposalId: string) {
    const result = await db.executor.query<{
      reviewer_id: string | null;
      event_id: string | null;
      event_version: number | null;
      record_json: Record<string, unknown>;
    }>(
      `SELECT reviewer_id, event_id, event_version, record_json FROM waspada.publication_decisions
       WHERE dataset_kind = 'live' AND proposal_id = $1 ORDER BY decided_at ASC, decision_id ASC`,
      [proposalId],
    );
    return result.rows;
  }

  async function count(table: "event_versions" | "event_claims"): Promise<number> {
    const result = await db.executor.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM waspada.${table} WHERE dataset_kind = 'live'`,
    );
    return result.rows[0]!.n;
  }

  it("marks a 49-hour-old undecided proposal expired with one decision row, and leaves a 47-hour-old one pending", async () => {
    await writer().persistProposal(proposal("exp-w-47", "inc-exp-w-47", hoursBefore(47)), "live");
    await writer().persistProposal(proposal("exp-w-49", "inc-exp-w-49", hoursBefore(49)), "live");
    const publicBefore = PublicReadModel.getPublishedEvents().length;
    const versionsBefore = await count("event_versions");
    const claimsBefore = await count("event_claims");
    const recordBefore = await db.executor.query<{ record_json: unknown }>(
      `SELECT record_json FROM waspada.event_proposals WHERE dataset_kind = 'live' AND proposal_id = 'exp-w-49'`,
    );

    const outcome = await sweep();
    assert.deepEqual(outcome, { expired: 1, skipped_already_decided: 0, failed: 0 });

    const [decision] = await decisionsFor("exp-w-49");
    assert.equal(decision?.reviewer_id, AGENT_REVIEW_EXPIRY_ID);
    assert.equal(decision?.event_id, null, "no event is linked");
    assert.equal(decision?.event_version, null, "no event version is linked");
    assert.equal(decision?.record_json.disposition, "expire");
    assert.equal(decision?.record_json.actor_kind, "agent");
    assert.equal(decision?.record_json.actor_id, AGENT_REVIEW_EXPIRY_ID);
    assert.equal(decision?.record_json.reason, "review_ttl_elapsed");
    assert.equal(decision?.record_json.ttl_hours, 48);
    assert.equal(decision?.record_json.proposed_at, hoursBefore(49));
    assert.equal(decision?.record_json.expired_at, NOW.toISOString());

    assert.equal((await decisionsFor("exp-w-47")).length, 0, "a 47-hour-old proposal is still inside the window");

    assert.equal(PublicReadModel.getPublishedEvents().length, publicBefore, "the public read model is unchanged");
    assert.equal(await count("event_versions"), versionsBefore, "no event version is written");
    assert.equal(await count("event_claims"), claimsBefore, "no event claim is written");
    const recordAfter = await db.executor.query<{ record_json: unknown }>(
      `SELECT record_json FROM waspada.event_proposals WHERE dataset_kind = 'live' AND proposal_id = 'exp-w-49'`,
    );
    assert.deepEqual(recordAfter.rows[0]?.record_json, recordBefore.rows[0]?.record_json, "the proposal itself is not edited");

    const pending = await writer().readPendingProposals("live");
    assert.equal(pending.some((item) => item.proposal_id === "exp-w-49"), false, "the expired proposal leaves the moderator queue");
    assert.equal(pending.some((item) => item.proposal_id === "exp-w-47"), true, "the 47-hour-old proposal is still pending");
  });

  it("finds nothing new on a second sweep", async () => {
    assert.deepEqual(await sweep(), { expired: 0, skipped_already_decided: 0, failed: 0 });
  });

  it("refuses a later moderator publish or reject of an expired proposal as already_decided, and publishes nothing", async () => {
    const publicBefore = PublicReadModel.getPublishedEvents().length;

    const published = await decideProposal(deps, {
      proposalId: "exp-w-49",
      action: "publish",
      actor: { kind: "moderator", actorId: "mod-1" },
    });
    assert.deepEqual(published, { status: "already_decided", disposition: "expire" });

    const rejected = await decideProposal(deps, {
      proposalId: "exp-w-49",
      action: "reject",
      actor: { kind: "moderator", actorId: "mod-1" },
      reason: "terlambat",
    });
    assert.deepEqual(rejected, { status: "already_decided", disposition: "expire" });

    const agent = await decideProposal(deps, {
      proposalId: "exp-w-49",
      action: "auto_publish",
      actor: { kind: "agent", actorId: AGENT_AUTO_PUBLISHER_ID },
      sourcePermission: "required",
    });
    assert.deepEqual(agent, { status: "already_decided", disposition: "expire" });

    assert.equal(PublicReadModel.getPublishedEvents().length, publicBefore);
    const decisions = await decisionsFor("exp-w-49");
    assert.equal(decisions.length, 1, "no publish or reject row was added after the expiry");
  });

  it("never expires a proposal that was already published, even when it is older than the TTL", async () => {
    await writer().persistProposal(proposal("exp-w-approved", "inc-exp-w-approved", hoursBefore(60)), "live");
    const outcome = await decideProposal(deps, {
      proposalId: "exp-w-approved",
      action: "auto_publish",
      actor: { kind: "agent", actorId: AGENT_AUTO_PUBLISHER_ID },
      sourcePermission: "required",
    });
    assert.equal(outcome.status, "published");

    const result = await sweep();
    assert.equal(result.expired, 0);
    const decisions = await decisionsFor("exp-w-approved");
    assert.equal(decisions.length, 1);
    assert.equal(decisions[0]?.record_json.disposition, "publish");
    assert.ok(PublicReadModel.getPublishedEvents().some((event) => event.version === 1 && event.event_id.length > 0));
  });

  it("never overrides a moderator's earlier reject: the sweep counts it as already decided and writes nothing", async () => {
    await writer().persistProposal(proposal("exp-w-rej", "inc-exp-w-rej", hoursBefore(49)), "live");
    await decideProposal(deps, {
      proposalId: "exp-w-rej",
      action: "reject",
      actor: { kind: "moderator", actorId: "mod-2" },
    });
    // A reject row is written, so the candidate query never returns this proposal.
    assert.deepEqual(await sweep(), { expired: 0, skipped_already_decided: 0, failed: 0 });
    const decisions = await decisionsFor("exp-w-rej");
    assert.deepEqual(decisions.map((row) => row.record_json.disposition), ["reject"]);
  });

  it("lists a new report on the same incident as pending after its earlier proposal expired", async () => {
    await writer().persistProposal(proposal("exp-w-new", "inc-exp-w-49", hoursBefore(1)), "live");
    const pending = await writer().readPendingProposals("live");
    assert.equal(pending.some((item) => item.proposal_id === "exp-w-new"), true, "a new report produces a normal pending proposal");
    assert.equal(pending.some((item) => item.proposal_id === "exp-w-49"), false);
  });

  it("rejects an invalid TTL before any row is read", async () => {
    await assert.rejects(sweep(0), TypeError);
    await assert.rejects(sweep(721), TypeError);
  });

  it("the scheduled runtime does nothing in demo mode and never opens the database", async () => {
    let opened = 0;
    const outcome = await runScheduledReviewExpiry({
      env: { DATASET_MODE: "demo", SQL_EXECUTOR: db.executor },
      now: NOW,
      withSqlExecutor: async (operation) => {
        opened += 1;
        return operation(db.executor);
      },
    });
    assert.deepEqual(outcome, { ran: false, reason: "not_live" });
    assert.equal(opened, 0);
  });

  it("the scheduled runtime needs an explicit live DATASET_MODE, so an unset value does nothing", async () => {
    const outcome = await runScheduledReviewExpiry({
      env: { SQL_EXECUTOR: db.executor },
      now: NOW,
      withSqlExecutor: async (operation) => operation(db.executor),
    });
    assert.deepEqual(outcome, { ran: false, reason: "not_live" });
  });

  it("the scheduled runtime does nothing without a database source, even in live mode", async () => {
    const outcome = await runScheduledReviewExpiry({
      env: { DATASET_MODE: "live" },
      now: NOW,
      withSqlExecutor: async (operation) => operation(db.executor),
    });
    assert.deepEqual(outcome, { ran: false, reason: "no_database" });
  });

  it("the scheduled runtime sweeps live data with the TTL from PROPOSAL_REVIEW_TTL_HOURS", async () => {
    await writer().persistProposal(proposal("exp-w-live25", "inc-exp-w-live25", hoursBefore(25)), "live");
    await writer().persistProposal(proposal("exp-w-live13", "inc-exp-w-live13", hoursBefore(13)), "live");

    const outcome = await runScheduledReviewExpiry({
      env: { DATASET_MODE: "live", PROPOSAL_REVIEW_TTL_HOURS: "24", SQL_EXECUTOR: db.executor },
      now: NOW,
      withSqlExecutor: async (operation) => operation(db.executor),
    });
    assert.equal(outcome.ran, true);
    assert.equal(outcome.ran && outcome.ttl_hours, 24);
    assert.equal((await decisionsFor("exp-w-live25"))[0]?.record_json.disposition, "expire");
    assert.equal((await decisionsFor("exp-w-live13")).length, 0, "a 13-hour-old proposal is inside a 24-hour window");
  });
});
