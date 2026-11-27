import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { createTestDatabase, type TestDatabase } from "../../db/test/harness.js";
import { seedProposalLineage, type ProposalLineage } from "../../db/test/proposal-lineage-fixture.js";
import { applyMigrations, readMigrations } from "../../db/src/migrations.js";
import { createEventProposalWriter, type EventProposalDto } from "../../db/src/event-proposal-writer.js";
import {
  createModerationApiHandler,
  type ModerationPrincipal,
} from "../src/layers/l4-application-integration/moderation-api.js";
import { resolvePublicationCategory } from "../src/layers/l4-application-integration/proposal-publication.js";
import type { WorkerEnvironment } from "../src/layers/l4-application-integration/api.js";
import { PublicReadModel } from "../src/layers/l4-application-integration/public-read-model.js";
import { checkSourcePublicDisplay, createModerationDecisionAdapters } from "../src/index.js";

/**
 * FIX-MOD-PARAMS: the moderator inputs that the moderation API validates must reach the publication decision.
 * Before the fix, the reason, the category resolution and the resolved category were validated and then dropped
 * at the Worker's publisher and reject adapters. These tests call the real adapters from apps/worker/src/index.ts
 * (createModerationDecisionAdapters) with a migrated PGlite database and the real rights check, so a regression in
 * that wiring fails here. Authored fictional data only.
 */

const APP_ORIGIN = "https://app.test";
const CSRF = "csrf-fix-mod-params";
const MODERATOR = "acc-mod-fix-params";
const SOURCE = "source-lineage-fixmod";
const DATASET = "live" as const;

let lineage: ProposalLineage | undefined;

function claim(): Record<string, unknown> {
  return {
    claim_id: "claim-1",
    claim_text: "Truk terguling menutup sebagian Tol Dalam Kota (fiktif)",
    evidence_label: "attributed_report",
    support_assessment: "supported",
    quote_text: "Truk terguling menutup sebagian Tol Dalam Kota",
    evidence_ref_id: "chk-fixmod-1",
    source_id: SOURCE,
    outlet: "Fictional lineage source",
    source_url: "https://lineage.invalid/fixmod",
  };
}

/** A proposal that passes the source gate. `overrides` replaces top-level fields. */
function proposal(key: string, overrides: Record<string, unknown> = {}): EventProposalDto {
  return {
    schema_version: "2.0",
    ...(lineage ?? {}),
    proposal_id: `prop-fixmod-${key}`,
    incident_id: `inc-fixmod-${key}`,
    title: "Truk terguling di Tol Dalam Kota",
    incident_type: "kecelakaan_truk",
    primary_category: "transport_road_incidents",
    severity: "high",
    event_time: { precision: "exact", value: "2026-11-10T08:00:00.000Z" },
    location_label: "Tol Dalam Kota, Jakarta",
    coordinates: null,
    claims: [claim()],
    impacts: [],
    caveats: [],
    has_discrepancy: false,
    discrepancies: [],
    correlation_relationship: "primary_initial",
    is_multi_source: false,
    source_count: 1,
    source_id: SOURCE,
    proposed_at: "2026-11-10T08:05:00.000Z",
    ...overrides,
  } as unknown as EventProposalDto;
}

function principal(): ModerationPrincipal {
  return { actorId: MODERATOR, role: "moderator", active: true, csrfToken: CSRF, channel: "web" };
}

function postDecision(id: string, body: Record<string, unknown>): Request {
  return new Request(`${APP_ORIGIN}/api/v1/moderation/proposals/${id}/publish`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: APP_ORIGIN, "x-csrf-token": CSRF },
    body: JSON.stringify(body),
  });
}

describe("FIX-MOD-PARAMS: category resolution rule", () => {
  const mismatched = {
    primary_category: "disasters_weather",
    interpretation_category: "transport_road_incidents",
    caveats: ["category_mismatch_review"],
  };

  it("with no moderator choice and no mismatch, the stored category stands", () => {
    assert.deepEqual(
      resolvePublicationCategory({ primary_category: "transport_road_incidents", caveats: [] }, {}),
      { ok: true, category: null },
    );
  });

  it("a recorded mismatch without category_resolution is refused", () => {
    assert.deepEqual(resolvePublicationCategory(mismatched, {}), { ok: false, code: "category_mismatch_unresolved" });
  });

  it("accept_interpretation picks the interpreter category, accept_triage the triage category", () => {
    assert.deepEqual(
      resolvePublicationCategory(mismatched, { categoryResolution: "accept_interpretation" }),
      { ok: true, category: "transport_road_incidents" },
    );
    assert.deepEqual(
      resolvePublicationCategory(mismatched, { categoryResolution: "accept_triage" }),
      { ok: true, category: "disasters_weather" },
    );
  });

  it("a choice whose candidate is not recorded is refused with a clear code", () => {
    const noInterpretation = { primary_category: "disasters_weather", caveats: [] };
    assert.deepEqual(
      resolvePublicationCategory(noInterpretation, { categoryResolution: "accept_interpretation" }),
      { ok: false, code: "category_candidates_unrecorded" },
    );
    assert.deepEqual(
      resolvePublicationCategory({ caveats: [] }, { resolvedCategory: "disasters_weather" }),
      { ok: false, code: "category_candidates_unrecorded" },
    );
  });

  it("a resolved category outside the candidates, or contradicting the resolution, is refused", () => {
    assert.deepEqual(
      resolvePublicationCategory(mismatched, { categoryResolution: "accept_triage", resolvedCategory: "fires_infrastructure_hazards" }),
      { ok: false, code: "category_not_candidate" },
    );
    assert.deepEqual(
      resolvePublicationCategory(mismatched, { categoryResolution: "accept_triage", resolvedCategory: "transport_road_incidents" }),
      { ok: false, code: "category_not_candidate" },
    );
    assert.deepEqual(
      resolvePublicationCategory(mismatched, { categoryResolution: "accept_other" }),
      { ok: false, code: "category_not_candidate" },
    );
  });
});

describe("FIX-MOD-PARAMS: 500 response carries no internal error text", () => {
  it("a publisher failure answers a generic 500 with a request id and no internal message", async () => {
    const secretText = 'relation "waspada.publication_decisions" does not exist at db-internal-host:5432';
    const handler = createModerationApiHandler({
      datasetScope: "live",
      principal: principal(),
      proposals: [proposal("plain-500", { primary_category: "transport_road_incidents" })],
      publicationService: {
        publish: async () => {
          throw new Error(secretText);
        },
      },
    });
    const originalError = console.error;
    console.error = () => undefined;
    let response: Response | undefined;
    try {
      response = await handler(new Request("http://localhost/api/v1/moderation/proposals/prop-fixmod-plain-500/publish", {
        method: "POST",
        headers: { "content-type": "application/json", "x-csrf-token": CSRF },
        body: JSON.stringify({ action: "publish", evidence_label: "attributed_report" }),
      }));
    } finally {
      console.error = originalError;
    }
    assert.equal(response?.status, 500);
    const text = await response!.text();
    const body = JSON.parse(text) as { code: string; message: string; request_id: string };
    assert.equal(body.code, "PUBLICATION_FAILED");
    assert.match(body.request_id, /^[0-9a-f-]{36}$/u, "a request id is returned for the report");
    for (const leaked of ["relation", "waspada", "db-internal-host", "5432", secretText]) {
      assert.equal(text.includes(leaked), false, `the 500 body must not contain "${leaked}"`);
    }
  });
});

describe("FIX-MOD-PARAMS: moderator inputs reach the publication decision (database)", () => {
  let db: TestDatabase;
  let env: WorkerEnvironment;
  let adapters: ReturnType<typeof createModerationDecisionAdapters>;
  let publishedMarks = 0;
  const writer = () => createEventProposalWriter(db.executor);

  function handler() {
    return createModerationApiHandler({
      authenticate: async () => principal(),
      appOrigin: APP_ORIGIN,
      csrfProtection: true,
      datasetScope: DATASET,
      getProposalDetail: async (id: string) => {
        const found = await writer().readProposalById(id, DATASET);
        return found ? { proposal: found, chunks: [] } : null;
      },
      checkPublicDisplay: (sourceId: string) => checkSourcePublicDisplay(env, sourceId),
      rejectProposal: adapters.rejectProposal,
      publisher: adapters.publisher,
    });
  }

  async function decisionsFor(proposalId: string): Promise<Array<{ record_json: Record<string, unknown>; event_id: string | null }>> {
    const result = await db.executor.query<{ record_json: Record<string, unknown>; event_id: string | null }>(
      `SELECT record_json, event_id FROM waspada.publication_decisions
       WHERE dataset_kind = 'live' AND proposal_id = $1 ORDER BY decided_at`,
      [proposalId],
    );
    return [...result.rows];
  }

  async function versionsFor(eventId: string): Promise<Array<{ version: number; category: string }>> {
    const result = await db.executor.query<{ version: number; category: string }>(
      `SELECT version, category FROM waspada.event_versions
       WHERE dataset_kind = 'live' AND event_id = $1 ORDER BY version`,
      [eventId],
    );
    return [...result.rows];
  }

  before(async () => {
    db = await createTestDatabase();
    await applyMigrations(db.executor, await readMigrations(new URL("../../db/migrations/", import.meta.url)));
    lineage = await seedProposalLineage(db.executor, "fixmod");
    env = { SQL_EXECUTOR: db.executor } as unknown as WorkerEnvironment;
    adapters = createModerationDecisionAdapters(env, DATASET, () => { publishedMarks += 1; });
    PublicReadModel.clearPublishedEvents();
  });

  after(async () => {
    await db?.close();
  });

  it("reject: the moderator's reason is stored on the reject decision and its audit record", async () => {
    const reason = "Laporan ini bukan insiden di Jakarta.";
    await writer().persistProposal(proposal("reject"), DATASET);
    const response = await handler()(postDecision("prop-fixmod-reject", { action: "reject", reason }));
    assert.equal(response?.status, 200);
    assert.deepEqual(await response?.json(), { ok: true, status: "rejected", proposal_id: "prop-fixmod-reject" });

    const decisions = await decisionsFor("prop-fixmod-reject");
    assert.equal(decisions.length, 1, "one decision is recorded");
    assert.equal(decisions[0]?.record_json.disposition, "reject");
    assert.equal(decisions[0]?.record_json.reason, reason, "the reject record carries the reason");

    const audit = await db.executor.query<{ reason: string | null }>(
      `SELECT reason FROM waspada.audit_records
       WHERE dataset_kind = 'live' AND action = 'proposal_rejected' AND details->>'proposal_id' = $1`,
      ["prop-fixmod-reject"],
    );
    assert.equal(audit.rows.length, 1);
    assert.equal(audit.rows[0]?.reason, reason);
  });

  it("publish: a mismatch needs category_resolution, and accept_interpretation publishes the interpreter category", async () => {
    const reason = "Truk terguling, kategori lalu lintas sesuai laporan.";
    await writer().persistProposal(proposal("mismatch", {
      primary_category: "disasters_weather",
      interpretation_category: "transport_road_incidents",
      caveats: ["category_mismatch_review"],
    }), DATASET);

    const blocked = await handler()(postDecision("prop-fixmod-mismatch", { action: "publish", evidence_label: "attributed_report" }));
    assert.equal(blocked?.status, 409);
    assert.equal(((await blocked?.json()) as { code: string }).code, "CATEGORY_MISMATCH_UNRESOLVED");
    assert.equal((await decisionsFor("prop-fixmod-mismatch")).length, 0, "a refused request writes no decision");

    const published = await handler()(postDecision("prop-fixmod-mismatch", {
      action: "publish",
      evidence_label: "attributed_report",
      reason,
      category_resolution: "accept_interpretation",
    }));
    assert.equal(published?.status, 200, JSON.stringify(await published?.clone().json()));

    const decisions = await decisionsFor("prop-fixmod-mismatch");
    assert.equal(decisions.length, 1);
    const record = decisions[0]!.record_json;
    assert.equal(record.disposition, "publish");
    assert.equal(record.reason, reason, "the publish decision carries the reason");
    assert.equal(record.category_resolution, "accept_interpretation");
    assert.equal(record.resolved_category, "transport_road_incidents");
    assert.equal(record.moderator_evidence_label, "attributed_report");

    const eventId = decisions[0]!.event_id;
    assert.ok(eventId, "the publish decision names its event");
    assert.deepEqual(await versionsFor(eventId), [{ version: 1, category: "transport_road_incidents" }]);
    assert.ok(publishedMarks >= 1, "the publish hook ran after commit");
  });

  it("publish: a resolved category outside the recorded candidates is refused and nothing is written", async () => {
    await writer().persistProposal(proposal("candidates"), DATASET);

    const refused = await handler()(postDecision("prop-fixmod-candidates", {
      action: "publish",
      evidence_label: "attributed_report",
      resolved_category: "fires_infrastructure_hazards",
    }));
    assert.equal(refused?.status, 400);
    assert.equal(((await refused?.json()) as { code: string }).code, "CATEGORY_NOT_CANDIDATE");
    assert.equal((await decisionsFor("prop-fixmod-candidates")).length, 0);

    // The gate itself refuses too, so a caller that skips the handler cannot publish the value.
    const direct = await adapters.publisher.publish({
      proposalId: "prop-fixmod-candidates",
      actorId: MODERATOR,
      action: "publish",
      evidence_label: "attributed_report",
      resolved_category: "fires_infrastructure_hazards",
    });
    assert.deepEqual(direct, { status: "denied", code: "category_not_candidate" });
    assert.equal((await decisionsFor("prop-fixmod-candidates")).length, 0, "the gate writes no decision");
  });

  it("publish: a category_resolution outside the two allowed values is refused, not dropped", async () => {
    const response = await handler()(postDecision("prop-fixmod-candidates", {
      action: "publish",
      evidence_label: "attributed_report",
      category_resolution: "accept_guess",
    }));
    assert.equal(response?.status, 400);
    assert.equal(((await response?.json()) as { code: string }).code, "INVALID_CATEGORY_RESOLUTION");
    assert.equal((await decisionsFor("prop-fixmod-candidates")).length, 0);
  });
});
