import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";
import { createTestDatabase, type TestDatabase } from "../../db/test/harness.js";
import { applyMigrations, readMigrations } from "../../db/src/migrations.js";
import {
  createIncidentIntelligenceWorkflow,
  IncidentWorkflowInputSchema,
} from "../src/workflows/incident-intelligence-workflow.js";
import type { EventProposalDto } from "../../db/src/event-proposal-writer.js";
import { assessAutoPublication } from "../../worker/src/layers/l4-application-integration/publication-policy.js";
import { createMockInterpreterAgent, createMockCorrelatorAgent } from "./mock-agents.js";
import type { z } from "zod";

type IncidentWorkflowInput = z.infer<typeof IncidentWorkflowInputSchema>;

/** MERGE-REVIEW-01: merge rules for the AI-driven proposal pipeline (ADR-061). */

const PERMITTED_SOURCES = new Set(["source-detik-m", "source-antara-m", "source-kompas-m"]);
const GATE = { publicDisplaySourceIds: PERMITTED_SOURCES };

interface ReportSpec {
  readonly id: string;
  readonly sourceId: string;
  readonly outlet: string;
  readonly claim: string;
  readonly decision: "new_incident" | "same_incident" | "unresolved";
  readonly candidateIncidentId?: string | null;
  readonly hasDiscrepancy?: boolean;
  readonly discrepancySummary?: string | null;
}

describe("MERGE-REVIEW-01 merge rules", () => {
  let db: TestDatabase;

  before(async () => {
    db = await createTestDatabase();
    const migrations = await readMigrations(new URL("../../db/migrations/", import.meta.url));
    await applyMigrations(db.executor, migrations);
  });

  after(async () => {
    await db?.close();
  });

  async function runReport(spec: ReportSpec) {
    const interpreter = createMockInterpreterAgent({
      summary: spec.claim,
      incidentType: "genangan_air_luapan_saluran",
      primaryCategory: "disasters_weather",
      severity: "medium",
      location: { label: "Jl. DI Panjaitan, Cawang, Jakarta Timur", approximateCoordinates: [106.871, -6.244], precision: "approximate" },
      eventTime: { value: "2026-11-10T08:00:00.000Z", precision: "exact" },
      evidence: [{ chunkId: `chk-${spec.id}`, exactQuote: spec.claim, supports: spec.claim }],
    });
    const correlator = createMockCorrelatorAgent({
      decision: spec.decision,
      candidateIncidentId: spec.candidateIncidentId ?? null,
      reasoning: `Keputusan uji untuk ${spec.id}.`,
      has_discrepancy: spec.hasDiscrepancy ?? false,
      discrepancy_summary: spec.discrepancySummary ?? null,
    });
    const workflow = createIncidentIntelligenceWorkflow({
      executor: db.executor,
      agentOverrides: { interpreter, correlator },
    });
    const input: IncidentWorkflowInput = {
      reportRevisionId: `rev-${spec.id}`,
      reportText: `${spec.claim}. Sumber ${spec.outlet}.`,
      sourceKind: "rss",
      sourceDisplayName: spec.outlet,
      sourceId: spec.sourceId,
      sourceUrl: `https://example.test/berita/${spec.id}`,
      publishedAt: "2026-11-10T08:00:00.000Z",
      datasetKind: "synthetic",
      traceId: `trace-${spec.id}`,
      evidenceChunks: [{ chunkId: `chk-${spec.id}`, spanStart: 0, spanEnd: 10, text: spec.claim }],
    };
    const execution = await (await workflow.createRun()).start({ inputData: input });
    assert.equal(execution.status, "success");
    return execution.result as unknown as { proposal: EventProposalDto; incident: { incidentId: string } };
  }

  it("merges reports without a discrepancy: each claim keeps its publisher, and the auto gate passes", async () => {
    const first = await runReport({ id: "mr-a1", sourceId: "source-detik-m", outlet: "Detik News", claim: "Genangan 50 cm di Cawang", decision: "new_incident" });
    const incidentId = first.incident.incidentId;
    const second = await runReport({
      id: "mr-a2", sourceId: "source-antara-m", outlet: "Antara News", claim: "Banjir merendam Jalan DI Panjaitan",
      decision: "same_incident", candidateIncidentId: incidentId,
    });

    assert.equal(second.proposal.has_discrepancy, false);
    assert.equal(second.proposal.discrepancy_summary, null);
    assert.equal(second.proposal.source_count, 2);
    assert.equal(second.proposal.correlation_relationship, "corroborating");
    assert.equal(second.proposal.claims.length, 2);
    assert.deepEqual(second.proposal.claims.map((c) => c.source_id), ["source-detik-m", "source-antara-m"]);
    assert.deepEqual(second.proposal.claims.map((c) => c.outlet), ["Detik News", "Antara News"]);
    assert.ok(second.proposal.claims.every((c) => c.source_url?.startsWith("https://example.test/berita/")));
    assert.ok(second.proposal.claims.every((c) => c.evidence_label === "attributed_report"));

    assert.deepEqual(assessAutoPublication(second.proposal, GATE), []);
  });

  it("flags a merge with a discrepancy and keeps the AI summary, so the auto gate queues it", async () => {
    const first = await runReport({ id: "mr-b1", sourceId: "source-detik-m", outlet: "Detik News", claim: "Ledakan merusak 3 rumah", decision: "new_incident" });
    const second = await runReport({
      id: "mr-b2", sourceId: "source-kompas-m", outlet: "Kompas", claim: "Ledakan merusak 5 rumah",
      decision: "same_incident", candidateIncidentId: first.incident.incidentId,
      hasDiscrepancy: true,
      discrepancySummary: "Laporan rev-mr-b1 menyebut 3 rumah, laporan rev-mr-b2 menyebut 5 rumah.",
    });

    assert.equal(second.proposal.has_discrepancy, true);
    assert.equal(second.proposal.discrepancy_summary, "Laporan rev-mr-b1 menyebut 3 rumah, laporan rev-mr-b2 menyebut 5 rumah.");
    assert.ok(assessAutoPublication(second.proposal, GATE).includes("discrepancy_flagged"));
  });

  it("keeps every accepted claim when publisher counts tie, so the chain head is the latest version", async () => {
    const a = await runReport({ id: "mr-c1", sourceId: "source-detik-m", outlet: "Detik News", claim: "Klaim pertama", decision: "new_incident" });
    const incidentId = a.incident.incidentId;
    await runReport({ id: "mr-c2", sourceId: "source-antara-m", outlet: "Antara News", claim: "Klaim kedua", decision: "same_incident", candidateIncidentId: incidentId });
    // Same publisher as the first report: source_count stays 2 while the claim count grows.
    await runReport({ id: "mr-c3", sourceId: "source-detik-m", outlet: "Detik News", claim: "Klaim ketiga", decision: "same_incident", candidateIncidentId: incidentId });
    const latest = await runReport({ id: "mr-c4", sourceId: "source-kompas-m", outlet: "Kompas", claim: "Klaim keempat", decision: "same_incident", candidateIncidentId: incidentId });

    assert.equal(latest.proposal.source_count, 3);
    assert.deepEqual(
      latest.proposal.claims.map((c) => c.claim_text),
      ["Klaim pertama", "Klaim kedua", "Klaim ketiga", "Klaim keempat"],
    );
    assert.deepEqual(latest.proposal.claims.map((c) => c.claim_id), ["claim-1", "claim-2", "claim-3", "claim-4"]);
  });

  it("does not chain an unresolved report into the event, and marks it unresolved", async () => {
    const a = await runReport({ id: "mr-d1", sourceId: "source-detik-m", outlet: "Detik News", claim: "Genangan di Cawang", decision: "new_incident" });
    const incidentId = a.incident.incidentId;
    const unresolved = await runReport({
      id: "mr-d2", sourceId: "source-antara-m", outlet: "Antara News", claim: "Ada genangan di sekitar sana",
      decision: "unresolved", candidateIncidentId: incidentId,
    });
    assert.equal(unresolved.proposal.correlation_relationship, "unresolved");
    assert.ok(assessAutoPublication(unresolved.proposal, GATE).includes("correlation_unresolved"));

    const next = await runReport({ id: "mr-d3", sourceId: "source-kompas-m", outlet: "Kompas", claim: "Genangan 40 cm di Cawang", decision: "same_incident", candidateIncidentId: incidentId });
    assert.deepEqual(next.proposal.claims.map((c) => c.claim_text), ["Genangan di Cawang", "Genangan 40 cm di Cawang"]);
  });

  it("skips a rejected version as the chain head, so its claims never return", async () => {
    const a = await runReport({ id: "mr-e1", sourceId: "source-detik-m", outlet: "Detik News", claim: "Klaim dasar", decision: "new_incident" });
    const incidentId = a.incident.incidentId;
    const rejectedRun = await runReport({ id: "mr-e2", sourceId: "source-antara-m", outlet: "Antara News", claim: "Klaim ditolak", decision: "same_incident", candidateIncidentId: incidentId });
    const traceRow = await db.executor.query<{ trace_id: string }>(
      `SELECT trace_id FROM waspada.event_proposals WHERE dataset_kind = 'synthetic' AND proposal_id = $1`,
      [rejectedRun.proposal.proposal_id],
    );
    // A moderator rejection is recorded as a decision row and never publishes.
    await db.executor.query(
      `INSERT INTO waspada.publication_decisions (dataset_kind, decision_id, trace_id, proposal_id, policy_version, event_id, event_version, reviewer_id, decided_at, record_json)
       VALUES ('synthetic', 'dec-mr-e2-reject', $1, $2, 'merge-review-v1', NULL, NULL, 'mod-test', now(), '{"disposition":"reject"}'::jsonb)`,
      [traceRow.rows[0]!.trace_id, rejectedRun.proposal.proposal_id],
    );

    const next = await runReport({ id: "mr-e3", sourceId: "source-kompas-m", outlet: "Kompas", claim: "Klaim baru", decision: "same_incident", candidateIncidentId: incidentId });
    assert.deepEqual(next.proposal.claims.map((c) => c.claim_text), ["Klaim dasar", "Klaim baru"]);
    assert.ok(!next.proposal.claims.some((c) => c.claim_text === "Klaim ditolak"));
  });

  it("never writes independent_corroboration for AI claims, even when several publishers agree", async () => {
    const a = await runReport({ id: "mr-f1", sourceId: "source-detik-m", outlet: "Detik News", claim: "Kebakaran di Tanah Abang", decision: "new_incident" });
    const b = await runReport({ id: "mr-f2", sourceId: "source-antara-m", outlet: "Antara News", claim: "Api di Tanah Abang", decision: "same_incident", candidateIncidentId: a.incident.incidentId });
    const rows = await db.executor.query<{ evidence_label: string }>(
      `SELECT evidence_label FROM waspada.proposal_claims WHERE dataset_kind = 'synthetic' AND proposal_id = $1`,
      [b.proposal.proposal_id],
    );
    assert.equal(rows.rows.length, 2);
    assert.ok(rows.rows.every((row) => row.evidence_label === "attributed_report"));
  });
});
