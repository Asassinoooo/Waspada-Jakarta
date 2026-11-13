import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { createTestDatabase, type TestDatabase } from "../../db/test/harness.js";
import { seedProposalLineage, type ProposalLineage } from "../../db/test/proposal-lineage-fixture.js";
import { applyMigrations, readMigrations } from "../../db/src/migrations.js";
import { createEventProposalWriter, type EventProposalDto } from "../../db/src/event-proposal-writer.js";
import type { SqlExecutor, TransactionalSqlExecutor } from "../../db/src/sql.js";
import {
  AGENT_AUTO_PUBLISHER_ID,
  decideProposal,
  type ProposalDecisionDependencies,
} from "../src/layers/l4-application-integration/proposal-publication.js";
import { PublicReadModel } from "../src/layers/l4-application-integration/public-read-model.js";

/**
 * ADR-061 automatic gate, database level. Each failing test changes exactly one field of a proposal
 * that otherwise passes every check, persists it, and runs the real agent path (decideProposal with
 * auto_publish). The control test shows the unchanged template publishes, so every failure is
 * attributable to the one changed field. The concurrency tests cover the duplicate-decision race that
 * ADR-061 records as unlocked (F-CONC-01).
 */

const PERMITTED_SOURCES = new Set(["source-detik", "source-antara"]);
const AGENT = { kind: "agent", actorId: AGENT_AUTO_PUBLISHER_ID } as const;
const MODERATOR = { kind: "moderator", actorId: "mod-race-fixture" } as const;
const DECISION_INSERT = "INSERT INTO waspada.publication_decisions";

type Fields = Record<string, unknown>;

/** Opens once, when `open` is called. Orders two calls without depending on timing. */
function oneShot(): { readonly wait: () => Promise<void>; readonly open: () => void } {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => { open = resolve; });
  return { wait: () => opened, open };
}

function decisionDispositions(rows: readonly { readonly record_json: Record<string, unknown> }[]): unknown[] {
  return rows.map((row) => row.record_json.disposition);
}

function claim(id: string, overrides: Fields = {}): Fields {
  return {
    claim_id: id,
    claim_text: "Genangan 50 cm di Cawang",
    evidence_label: "attributed_report",
    support_assessment: "supported",
    quote_text: "Genangan setinggi 50 cm",
    evidence_ref_id: `chk-${id}`,
    source_id: "source-detik",
    outlet: "Detik News",
    source_url: "https://news.example/cawang",
    ...overrides,
  };
}

/** Passes every ADR-061 automatic check. `fields` replaces top-level fields (undefined drops a key). */
let lineage: ProposalLineage | undefined;

function validProposal(incidentId: string, fields: Fields = {}): EventProposalDto {
  return {
    schema_version: "2.0",
    ...(lineage ?? {}),
    proposal_id: `prop-${incidentId}`,
    incident_id: incidentId,
    title: "Genangan di Cawang",
    incident_type: "genangan_air_luapan_saluran",
    primary_category: "disasters_weather",
    severity: "medium",
    event_time: { precision: "exact", value: "2026-11-10T08:00:00.000Z" },
    location_label: "Cawang, Jakarta Timur",
    coordinates: null,
    claims: [claim("claim-1")],
    impacts: [],
    caveats: [],
    has_discrepancy: false,
    discrepancy_summary: null,
    discrepancies: [],
    correlation_relationship: "primary_initial",
    is_multi_source: false,
    source_count: 1,
    source_id: "source-detik",
    proposed_at: "2026-11-10T08:05:00.000Z",
    ...fields,
  } as unknown as EventProposalDto;
}

describe("ADR-061 automatic gate: database-level checks", () => {
  let db: TestDatabase;
  let deps: ProposalDecisionDependencies;
  const writer = () => createEventProposalWriter(db.executor);

  before(async () => {
    db = await createTestDatabase();
    const migrations = await readMigrations(new URL("../../db/migrations/", import.meta.url));
    await applyMigrations(db.executor, migrations);
    lineage = await seedProposalLineage(db.executor, "adr061");
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
    const result = await db.executor.query<{ record_json: Record<string, unknown> }>(
      `SELECT record_json FROM waspada.publication_decisions
       WHERE dataset_kind = 'live' AND proposal_id = $1 ORDER BY decided_at ASC`,
      [proposalId],
    );
    return result.rows;
  }

  async function versionCount(eventId: string): Promise<number> {
    const result = await db.executor.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM waspada.event_versions
       WHERE dataset_kind = 'live' AND event_id = $1`,
      [eventId],
    );
    return result.rows[0]?.count ?? 0;
  }

  /** Runs the agent path on a persisted proposal and asserts it queues with exactly `reason`, writes nothing, and stays pending. */
  async function assertQueuedOnly(incidentId: string, reason: string): Promise<void> {
    const proposalId = `prop-${incidentId}`;
    const outcome = await decideProposal(deps, { proposalId, action: "auto_publish", actor: AGENT });
    assert.deepEqual(outcome, { status: "queued", reasons: [reason] });
    assert.equal((await decisionsFor(proposalId)).length, 0, "no publication decision is written");
    assert.equal(await versionCount(incidentId), 0, "no event version is written");
    assert.equal(publishedEvent(incidentId), null, "nothing is public");
    const pending = await writer().readPendingProposals("live");
    assert.ok(pending.some((item) => item.proposal_id === proposalId), "the proposal stays in the moderator queue");
  }

  it("control: a fully valid proposal passes every automatic check and publishes as agent_auto", async () => {
    await writer().persistProposal(validProposal("inc-ctl-1"), "live");
    const outcome = await decideProposal(deps, { proposalId: "prop-inc-ctl-1", action: "auto_publish", actor: AGENT });
    assert.equal(outcome.status, "published");
    const [decision] = await decisionsFor("prop-inc-ctl-1");
    assert.equal(decision?.record_json.gate, "agent_auto_publication");
    assert.equal(decision?.record_json.disposition, "publish");
    const event = publishedEvent("inc-ctl-1");
    assert.ok(event, "the control event is public");
    assert.equal(event.publication?.mode, "agent_auto");
    assert.equal(event.publication?.waivers, undefined, "no waiver is recorded when every source is permitted");
  });

  describe("check 1: discrepancy status (has_discrepancy exactly false, no discrepancy listed)", () => {
    it("queues a proposal whose has_discrepancy is absent, because an unknown status fails closed", async () => {
      await writer().persistProposal(validProposal("inc-disc-unknown", { has_discrepancy: undefined }), "live");
      await assertQueuedOnly("inc-disc-unknown", "discrepancy_status_unknown");
    });

    it("queues a proposal with has_discrepancy false that still lists a discrepancy", async () => {
      await writer().persistProposal(
        validProposal("inc-disc-listed", {
          discrepancies: [{ kind: "water_height", description: "50 cm vs 30 cm" }],
        }),
        "live",
      );
      await assertQueuedOnly("inc-disc-listed", "discrepancy_flagged");
    });
  });

  it("check 2 (correlation): an unresolved correlation queues and never publishes", async () => {
    await writer().persistProposal(validProposal("inc-corr", { correlation_relationship: "unresolved" }), "live");
    await assertQueuedOnly("inc-corr", "correlation_unresolved");
  });

  it("check 3 (claim support): a claim that is not supported queues and never publishes", async () => {
    await writer().persistProposal(
      validProposal("inc-support", { claims: [claim("claim-1", { support_assessment: "uncertain" })] }),
      "live",
    );
    await assertQueuedOnly("inc-support", "claim_unsupported");
  });

  it("check 4 (claim quote): a claim with no quote queues and never publishes", async () => {
    await writer().persistProposal(
      validProposal("inc-quote", { claims: [claim("claim-1", { quote_text: null })] }),
      "live",
    );
    await assertQueuedOnly("inc-quote", "claim_quote_missing");
  });

  describe("check 8 (schema): a registry category, a title and a proposal time", () => {
    it("queues a proposal with a blank title", async () => {
      await writer().persistProposal(validProposal("inc-schema-title", { title: "" }), "live");
      await assertQueuedOnly("inc-schema-title", "schema_invalid");
    });

    it("queues a proposal with no claims", async () => {
      await writer().persistProposal(validProposal("inc-schema-claims", { claims: [] }), "live");
      await assertQueuedOnly("inc-schema-claims", "claims_missing");
    });
  });

  describe("check 9 (location and event time): both come from the source", () => {
    it("queues a proposal with no location", async () => {
      await writer().persistProposal(
        validProposal("inc-no-place", { location_label: null, coordinates: null }),
        "live",
      );
      await assertQueuedOnly("inc-no-place", "location_missing");
    });

    it("queues a proposal whose event time is unknown", async () => {
      await writer().persistProposal(
        validProposal("inc-no-time", { event_time: { precision: "unknown", value: null } }),
        "live",
      );
      await assertQueuedOnly("inc-no-time", "time_missing");
    });
  });

  describe("concurrent decisions on one proposal (F-CONC-01, ADR-061 line 49)", () => {
    /**
     * Test-only executor wrapper. It delegates every call to the one PGlite connection and adds a hook
     * before a query or a transaction. Production code is not changed.
     */
    function withHooks(hooks: {
      readonly beforeQuery?: (sql: string) => Promise<void>;
      readonly beforeTransaction?: () => Promise<void>;
    }): TransactionalSqlExecutor {
      return {
        async query<Row extends object>(statement: string, parameters?: readonly unknown[]) {
          await hooks.beforeQuery?.(statement);
          return db.executor.query<Row>(statement, parameters);
        },
        async execute(statement: string) {
          await db.executor.execute(statement);
        },
        async transaction<Result>(work: (transaction: SqlExecutor) => Promise<Result>): Promise<Result> {
          await hooks.beforeTransaction?.();
          return db.executor.transaction(work);
        },
      };
    }

    it("two overlapping auto-publish calls for one proposal leave one decision and one version", async () => {
      // PGlite 0.5.8 runs every query and transaction under one exclusive lock, so these calls are
      // serialized here. This shows the PGlite behaviour only. It does not exercise a hosted interleaving.
      await writer().persistProposal(validProposal("inc-conc-natural"), "live");
      const input = { proposalId: "prop-inc-conc-natural", action: "auto_publish" as const, actor: AGENT };
      const outcomes = await Promise.all([decideProposal(deps, input), decideProposal(deps, input)]);
      assert.equal(outcomes.filter((outcome) => outcome.status === "published").length, 1, "exactly one call publishes");
      const loser = outcomes.find((outcome) => outcome.status !== "published");
      assert.ok(
        loser && (loser.status === "already_decided" || (loser.status === "denied" && loser.code === "publication_failed")),
        `the other call is refused, not published: ${JSON.stringify(loser)}`,
      );
      assert.equal((await decisionsFor("prop-inc-conc-natural")).length, 1, "exactly one decision row");
      assert.equal(await versionCount("inc-conc-natural"), 1, "exactly one event version");
    });

    it("a publish that passed its pre-check before another publish committed publishes nothing (F-CONC-01)", async () => {
      await writer().persistProposal(validProposal("inc-conc-forced"), "live");
      const input = { proposalId: "prop-inc-conc-forced", action: "auto_publish" as const, actor: AGENT };

      // The second call reads the proposal, then pauses before its transaction. The first call runs to completion.
      const firstPublished = oneShot();
      const second = withHooks({ beforeTransaction: firstPublished.wait });
      const secondRun = decideProposal({ ...deps, executor: second }, input);
      const firstOutcome = await decideProposal(deps, input).finally(firstPublished.open);
      const secondOutcome = await secondRun;

      assert.equal(firstOutcome.status, "published", "the first call publishes");
      assert.deepEqual(
        secondOutcome,
        { status: "already_decided", disposition: "publish" },
        "the second call re-checks inside its transaction and finds the committed publication",
      );
      assert.equal((await decisionsFor("prop-inc-conc-forced")).length, 1, "exactly one decision row");
      assert.equal(await versionCount("inc-conc-forced"), 1, "exactly one event version");
    });

    it("a reject that is recorded before a publish's transaction stops the publish: one decision, no version (F-CONC-01)", async () => {
      await writer().persistProposal(validProposal("inc-race-reject-first"), "live");
      const proposalId = "prop-inc-race-reject-first";

      // The publish reads the proposal, then pauses before its transaction. The reject runs to completion.
      const rejectRecorded = oneShot();
      const publish = withHooks({ beforeTransaction: rejectRecorded.wait });
      const publishRun = decideProposal({ ...deps, executor: publish }, { proposalId, action: "auto_publish", actor: AGENT });
      const rejectOutcome = await decideProposal(deps, { proposalId, action: "reject", actor: MODERATOR })
        .finally(rejectRecorded.open);
      const publishOutcome = await publishRun;

      assert.equal(rejectOutcome.status, "rejected");
      assert.deepEqual(publishOutcome, { status: "already_decided", disposition: "reject" });
      assert.deepEqual(decisionDispositions(await decisionsFor(proposalId)), ["reject"], "exactly one decision, the reject");
      assert.equal(await versionCount("inc-race-reject-first"), 0, "a lost publish writes no event version");
      assert.equal(publishedEvent("inc-race-reject-first"), null, "nothing is public");
    });

    it("a publish that is recorded before a reject stops the reject: one decision, one version (F-CONC-01)", async () => {
      await writer().persistProposal(validProposal("inc-race-publish-first"), "live");
      const proposalId = "prop-inc-race-publish-first";

      // The reject pauses after its reads: before its transaction on the locked path, and before its insert on the older path.
      const publishRecorded = oneShot();
      const reject = withHooks({
        beforeTransaction: publishRecorded.wait,
        beforeQuery: async (statement) => { if (statement.includes(DECISION_INSERT)) await publishRecorded.wait(); },
      });
      const rejectRun = decideProposal({ ...deps, executor: reject }, { proposalId, action: "reject", actor: MODERATOR });
      const publishOutcome = await decideProposal(deps, { proposalId, action: "auto_publish", actor: AGENT })
        .finally(publishRecorded.open);
      const rejectOutcome = await rejectRun;

      assert.equal(publishOutcome.status, "published");
      assert.deepEqual(rejectOutcome, { status: "already_decided", disposition: "publish" });
      assert.deepEqual(decisionDispositions(await decisionsFor(proposalId)), ["publish"], "exactly one decision, the publish");
      assert.equal(await versionCount("inc-race-publish-first"), 1, "exactly one event version");
    });
  });
});
