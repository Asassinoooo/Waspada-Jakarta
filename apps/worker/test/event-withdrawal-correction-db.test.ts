import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { createTestDatabase, type TestDatabase } from "../../db/test/harness.js";
import { applyMigrations, readMigrations } from "../../db/src/migrations.js";
import { seedProposalLineage, type ProposalLineage } from "../../db/test/proposal-lineage-fixture.js";
import { createEventProposalWriter, type EventProposalDto } from "../../db/src/event-proposal-writer.js";
import {
  decideProposal,
  submitEventCorrection,
  withdrawPublishedEvent,
  type ProposalDecisionDependencies,
} from "../src/layers/l4-application-integration/proposal-publication.js";
import { PublicReadModel } from "../src/layers/l4-application-integration/public-read-model.js";

/**
 * TG-FR12 (FR-12), database level. A moderator withdraws a published event or corrects it. Each action
 * writes one new event version, one publication decision and one audit record, in one transaction.
 * The tests read those rows back. They do not assume the writes happened because the function returned.
 */

const PERMITTED = new Set(["source-detik"]);
const MODERATOR = "acc-mod-1";
const EVENT = "evt-corr-a";
/** F-TRACE-02: a live proposal must reference real lineage. Seeded once per database, as the gate tests do. */
let lineage: ProposalLineage | undefined;

function claim(overrides: Record<string, unknown> = {}) {
  return {
    claim_id: "claim-1",
    claim_text: "Genangan 50 cm di Cawang",
    evidence_label: "attributed_report",
    support_assessment: "supported",
    quote_text: "Genangan setinggi 50 cm",
    evidence_ref_id: "chk-claim-1",
    source_id: "source-detik",
    outlet: "Detik News",
    source_url: "https://news.example/cawang",
    ...overrides,
  };
}

/** A proposal the moderator gate accepts. `fields` replaces top-level fields (undefined drops a key). */
function proposal(incidentId: string, fields: Record<string, unknown> = {}): EventProposalDto {
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
    claims: [claim()],
    impacts: [],
    caveats: [],
    has_discrepancy: false,
    discrepancies: [],
    correlation_relationship: "primary_initial",
    is_multi_source: false,
    source_count: 1,
    source_id: "source-detik",
    proposed_at: "2026-11-10T08:05:00.000Z",
    ...fields,
  } as unknown as EventProposalDto;
}

describe("TG-FR12: withdrawal and correction of a published event (database)", () => {
  let db: TestDatabase;
  let deps: ProposalDecisionDependencies;
  const writer = () => createEventProposalWriter(db.executor);

  before(async () => {
    db = await createTestDatabase();
    const migrations = await readMigrations(new URL("../../db/migrations/", import.meta.url));
    await applyMigrations(db.executor, migrations);
    lineage = await seedProposalLineage(db.executor, "fr12-db");
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

  async function publishFirstVersion(incidentId: string, fields: Record<string, unknown> = {}): Promise<void> {
    await writer().persistProposal(proposal(incidentId, fields), "live");
    const outcome = await decideProposal(deps, {
      proposalId: `prop-${incidentId}`,
      action: "publish",
      actor: { kind: "moderator", actorId: MODERATOR },
    });
    assert.equal(outcome.status, "published", "the fixture event is published by a moderator first");
  }

  async function versions(eventId: string) {
    const result = await db.executor.query<{
      version: number;
      publication_status: string;
      withdrawal_reason: string | null;
      published_at: string | null;
      withdrawn_at: string | null;
      lifecycle: string;
      title: string;
      claims_length: number;
      supersedes_version: number | null;
    }>(
      `SELECT version, publication_status, withdrawal_reason, published_at::text AS published_at,
              withdrawn_at::text AS withdrawn_at, lifecycle, title, supersedes_version,
              jsonb_array_length(record_json->'claims') AS claims_length
       FROM waspada.event_versions
       WHERE dataset_kind = 'live' AND event_id = $1
       ORDER BY version ASC`,
      [eventId],
    );
    return result.rows;
  }

  async function decisionsFor(eventId: string) {
    const result = await db.executor.query<{
      decision_id: string;
      event_version: number | null;
      reviewer_id: string | null;
      record_json: Record<string, unknown>;
    }>(
      `SELECT decision_id, event_version, reviewer_id, record_json FROM waspada.publication_decisions
       WHERE dataset_kind = 'live' AND event_id = $1 ORDER BY event_version ASC, decided_at ASC`,
      [eventId],
    );
    return result.rows;
  }

  async function auditFor(eventId: string) {
    const result = await db.executor.query<{
      action: string;
      actor_id: string | null;
      entity_type: string;
      entity_id: string;
      reason: string | null;
      details: Record<string, unknown>;
    }>(
      `SELECT action, actor_id, entity_type, entity_id, reason, details FROM waspada.audit_records
       WHERE dataset_kind = 'live' AND entity_id = $1 ORDER BY occurred_at ASC, audit_id ASC`,
      [eventId],
    );
    return result.rows;
  }

  async function publicVersionRows(eventId: string): Promise<number> {
    const result = await db.executor.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM waspada.public_event_versions
       WHERE dataset_kind = 'live' AND event_id = $1`,
      [eventId],
    );
    return result.rows[0]?.count ?? 0;
  }

  function publicTitle(eventId: string): string | null {
    return PublicReadModel.getPublishedEvents().find((event) => event.event_id === eventId)?.title ?? null;
  }

  function isInPublicList(eventId: string): boolean {
    const model = new PublicReadModel({ listPublicSourceStatus: () => [] } as never, []);
    return model.events(new URLSearchParams()).data.some((event) => event.event_id === eventId);
  }

  describe("withdrawal", () => {
    before(async () => {
      await publishFirstVersion(EVENT);
    });

    it("control: the event is public and listed before withdrawal", () => {
      assert.ok(publicTitle(EVENT), "the in-memory read model holds the published event");
      assert.equal(isInPublicList(EVENT), true);
    });

    it("writes a withdrawn tombstone version, a withdraw decision and an audit record, then drops the event from public reads", async () => {
      const outcome = await withdrawPublishedEvent(deps, {
        eventId: EVENT,
        actorId: MODERATOR,
        reasonCategory: "source_retracted",
        reason: "Sumber asli menarik kembali laporan ini.",
      });
      assert.equal(outcome.status, "withdrawn");
      if (outcome.status !== "withdrawn") return;
      assert.equal(outcome.version, 2);

      const rows = await versions(EVENT);
      assert.equal(rows.length, 2);
      const tombstone = rows[1]!;
      assert.equal(tombstone.version, 2);
      assert.equal(tombstone.supersedes_version, 1);
      assert.equal(tombstone.publication_status, "withdrawn");
      assert.equal(tombstone.withdrawal_reason, "source_retracted");
      assert.ok(tombstone.withdrawn_at, "withdrawn_at is set");
      assert.equal(tombstone.published_at, null, "a withdrawn version has no publication time");
      assert.equal(tombstone.claims_length, 0, "a tombstone carries no claims");
      assert.equal(tombstone.lifecycle, "ongoing", "withdrawal does not change the incident lifecycle");

      const decisions = await decisionsFor(EVENT);
      const withdrawal = decisions.find((row) => row.event_version === 2);
      assert.ok(withdrawal, "a decision row exists for the withdrawn version");
      assert.equal(withdrawal.record_json.disposition, "withdraw");
      assert.equal(withdrawal.record_json.reason_category, "source_retracted");
      assert.equal(withdrawal.reviewer_id, MODERATOR);

      const audit = await auditFor(EVENT);
      const record = audit.find((row) => row.action === "event_withdrawn");
      assert.ok(record, "an audit record for the withdrawal is read back");
      assert.equal(record.actor_id, MODERATOR);
      assert.equal(record.entity_type, "event");
      assert.equal(record.reason, "Sumber asli menarik kembali laporan ini.");
      assert.equal(record.details.reason_category, "source_retracted");
      assert.equal(record.details.event_version, 2);
      assert.equal(record.details.decision_id, withdrawal.decision_id);

      assert.equal(publicTitle(EVENT), null, "the in-memory read model no longer lists the event as active");
      assert.equal(isInPublicList(EVENT), false, "the public list no longer shows the event");
      assert.equal(await publicVersionRows(EVENT), 0, "the database public view excludes the withdrawn event");
    });

    it("a second withdrawal is already_withdrawn and writes nothing", async () => {
      const before = { versions: (await versions(EVENT)).length, decisions: (await decisionsFor(EVENT)).length, audit: (await auditFor(EVENT)).length };
      const outcome = await withdrawPublishedEvent(deps, {
        eventId: EVENT,
        actorId: MODERATOR,
        reasonCategory: "other",
        reason: "Penarikan kedua untuk peristiwa yang sama.",
      });
      assert.equal(outcome.status, "already_withdrawn");
      assert.equal((await versions(EVENT)).length, before.versions);
      assert.equal((await decisionsFor(EVENT)).length, before.decisions);
      assert.equal((await auditFor(EVENT)).length, before.audit);
    });

    it("an agent re-publication of a proposal into a withdrawn event is denied, so withdrawal is not undone", async () => {
      await writer().persistProposal(proposal(EVENT, { proposal_id: "prop-evt-corr-a-later", proposed_at: "2026-11-11T08:00:00.000Z" }), "live");
      const outcome = await decideProposal(deps, {
        proposalId: "prop-evt-corr-a-later",
        action: "auto_publish",
        actor: { kind: "agent", actorId: "agent:auto-publisher" },
      });
      assert.deepEqual(outcome, { status: "denied", code: "event_withdrawn" });
      assert.equal((await versions(EVENT)).length, 2, "no new version is written");
      assert.equal(publicTitle(EVENT), null);
    });

    it("a moderator publish into a withdrawn event is denied and leaves the proposal undecided", async () => {
      const outcome = await decideProposal(deps, {
        proposalId: "prop-evt-corr-a-later",
        action: "publish",
        actor: { kind: "moderator", actorId: MODERATOR },
      });
      assert.deepEqual(outcome, { status: "denied", code: "event_withdrawn" });
      assert.equal((await versions(EVENT)).length, 2);
    });
  });

  describe("correction", () => {
    const CORR = "evt-corr-b";

    before(async () => {
      await publishFirstVersion(CORR);
    });

    it("identical facts are unchanged: no version, and the request is recorded with an audit row", async () => {
      const outcome = await submitEventCorrection(deps, {
        eventId: CORR,
        baseVersion: 1,
        actorId: MODERATOR,
        edits: {},
        reason: "Periksa ulang, tidak ada perubahan.",
      });
      assert.equal(outcome.status, "unchanged");
      assert.equal((await versions(CORR)).length, 1, "no new version is written");
      const audit = (await auditFor(CORR)).filter((row) => row.action === "event_correction");
      assert.equal(audit.length, 1);
      assert.equal(audit[0]?.details.outcome, "unchanged");
      assert.equal(audit[0]?.actor_id, MODERATOR);
    });

    it("a title correction that passes the gate publishes version 2 with the same claims, and the audit row says so", async () => {
      const outcome = await submitEventCorrection(deps, {
        eventId: CORR,
        baseVersion: 1,
        actorId: MODERATOR,
        edits: { title: "Genangan 50 cm di Cawang, Jakarta Timur" },
        reason: "Judul diperbaiki sesuai laporan asli.",
      });
      assert.equal(outcome.status, "published");
      if (outcome.status !== "published") return;
      assert.equal(outcome.version, 2);

      const rows = await versions(CORR);
      assert.equal(rows.length, 2);
      assert.equal(rows[1]?.publication_status, "published");
      assert.equal(rows[1]?.title, "Genangan 50 cm di Cawang, Jakarta Timur");
      assert.equal(rows[1]?.supersedes_version, 1);
      assert.equal(publicTitle(CORR), "Genangan 50 cm di Cawang, Jakarta Timur", "the public read model shows the corrected version");

      const proposalRows = await db.executor.query<{ event_id: string; base_event_version: number; record_json: Record<string, unknown> }>(
        `SELECT event_id, base_event_version, record_json FROM waspada.event_proposals
         WHERE dataset_kind = 'live' AND event_id = $1 AND base_event_version = 1
           AND record_json->>'title' = $2`,
        [CORR, "Genangan 50 cm di Cawang, Jakarta Timur"],
      );
      assert.equal(proposalRows.rows.length, 1, "the correction is stored as a proposal linked to the event");
      assert.equal(proposalRows.rows[0]?.record_json.kind, "correction");
      const correctionProposalId = String(proposalRows.rows[0]?.record_json.proposal_id);

      const decision = await db.executor.query<{ record_json: Record<string, unknown>; event_version: number }>(
        `SELECT record_json, event_version FROM waspada.publication_decisions
         WHERE dataset_kind = 'live' AND proposal_id = $1`,
        [correctionProposalId],
      );
      assert.equal(decision.rows.length, 1);
      assert.equal(decision.rows[0]?.record_json.disposition, "publish");
      assert.equal(decision.rows[0]?.record_json.publication_mode, "moderator_reviewed");
      assert.equal(decision.rows[0]?.event_version, 2);

      const audit = (await auditFor(CORR)).filter((row) => row.action === "event_correction");
      const published = audit.find((row) => row.details.outcome === "published");
      assert.ok(published, "the published correction is in the audit trail");
      assert.equal(published?.actor_id, MODERATOR);
      assert.equal(published?.reason, "Judul diperbaiki sesuai laporan asli.");
      assert.equal(published?.details.event_version, 2);
    });

    it("a correction that removes the event time is refused with time_missing: nothing is published, the request is recorded as rejected", async () => {
      const outcome = await submitEventCorrection(deps, {
        eventId: CORR,
        baseVersion: 2,
        actorId: MODERATOR,
        edits: { eventTime: { precision: "unknown", value: "" } },
      });
      assert.deepEqual(
        { status: outcome.status, code: outcome.status === "refused" ? outcome.code : null, reasons: outcome.status === "refused" ? outcome.reasons : null },
        { status: "refused", code: "publication_not_authorized", reasons: ["time_missing"] },
      );
      assert.equal((await versions(CORR)).length, 2, "no version is written");
      // A refusal has no event version, so its decision is found by refusal code, not by event id.
      const rejected = await db.executor.query<{ record_json: Record<string, unknown> }>(
        `SELECT record_json FROM waspada.publication_decisions
         WHERE dataset_kind = 'live' AND record_json->>'disposition' = 'reject'
           AND record_json->>'refusal_code' = 'publication_not_authorized'
           AND record_json->'gate_reasons' = '["time_missing"]'::jsonb`,
      );
      assert.equal(rejected.rows.length, 1, "the refused correction is recorded as a rejected decision");
      const audit = (await auditFor(CORR)).filter((row) => row.action === "event_correction" && row.details.outcome === "refused");
      assert.equal(audit.length, 1);
      assert.deepEqual(audit[0]?.details.gate_reasons, ["time_missing"]);
    });

    it("a correction on a stale base version is refused with stale_base_version and writes no version", async () => {
      const outcome = await submitEventCorrection(deps, {
        eventId: CORR,
        baseVersion: 1,
        actorId: MODERATOR,
        edits: { title: "Judul dari versi lama" },
      });
      assert.equal(outcome.status, "refused");
      assert.equal(outcome.status === "refused" ? outcome.code : null, "stale_base_version");
      assert.equal((await versions(CORR)).length, 2);
      assert.notEqual(publicTitle(CORR), "Judul dari versi lama");
    });

    it("a claim edit that names no claim of the event is refused as invalid", async () => {
      const outcome = await submitEventCorrection(deps, {
        eventId: CORR,
        baseVersion: 2,
        actorId: MODERATOR,
        edits: { claims: [{ claimId: "claim-tidak-ada", text: "Teks baru" }] },
      });
      assert.equal(outcome.status, "invalid");
      assert.equal(outcome.status === "invalid" ? outcome.code : null, "claim_not_found");
      assert.equal((await versions(CORR)).length, 2);
    });

    it("an unknown event is not found and writes nothing", async () => {
      const outcome = await submitEventCorrection(deps, {
        eventId: "evt-tidak-ada",
        baseVersion: 1,
        actorId: MODERATOR,
        edits: { title: "Judul" },
      });
      assert.equal(outcome.status, "refused");
      assert.equal(outcome.status === "refused" ? outcome.code : null, "event_not_found");
      assert.equal((await auditFor("evt-tidak-ada")).length, 0);
    });

    it("a withdrawn event cannot be corrected: refused with event_withdrawn, and the event stays withdrawn", async () => {
      const withdrawal = await withdrawPublishedEvent(deps, {
        eventId: CORR,
        actorId: MODERATOR,
        reasonCategory: "incorrect_event_match",
        reason: "Laporan ini salah dikaitkan dengan peristiwa lain.",
      });
      assert.equal(withdrawal.status, "withdrawn");
      const outcome = await submitEventCorrection(deps, {
        eventId: CORR,
        baseVersion: 2,
        actorId: MODERATOR,
        edits: { title: "Koreksi setelah penarikan" },
      });
      assert.equal(outcome.status, "refused");
      assert.equal(outcome.status === "refused" ? outcome.code : null, "event_withdrawn");
      const rows = await versions(CORR);
      assert.equal(rows[rows.length - 1]?.publication_status, "withdrawn");
      assert.equal(publicTitle(CORR), null);
    });
  });
});
