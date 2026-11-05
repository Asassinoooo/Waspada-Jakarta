import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";
import { createTestDatabase, type TestDatabase } from "../../db/test/harness.js";
import { applyMigrations, readMigrations } from "../../db/src/migrations.js";
import {
  createIncidentIntelligenceWorkflow,
  IncidentWorkflowInputSchema,
} from "../src/workflows/incident-intelligence-workflow.js";
import { createEventProposalWriter } from "../../db/src/event-proposal-writer.js";
import { createSqlIncidentRepository } from "../../db/src/incident-repository.js";
import { createMockInterpreterAgent, createMockCorrelatorAgent } from "./mock-agents.js";
import type { z } from "zod";
type IncidentWorkflowInput = z.infer<typeof IncidentWorkflowInputSchema>;
describe("Mastra Incident Intelligence Workflow", () => {
  let db: TestDatabase;

  before(async () => {
    db = await createTestDatabase();
    const migrations = await readMigrations(new URL("../../db/migrations/", import.meta.url));
    await applyMigrations(db.executor, migrations);
  });

  after(async () => {
    await db?.close();
  });

  it("executes the full 4-step workflow with mock agents: interpretation -> retrieval -> correlation -> persistence", async () => {
    const mockInterpreter = createMockInterpreterAgent({
      summary: "Banjir setinggi 50 cm merendam Jalan DI Panjaitan, Cawang",
      incidentType: "genangan_air_luapan_saluran",
      severity: "medium",
      primaryCategory: "disasters_weather",
      location: {
        label: "Jl. DI Panjaitan, Cawang, Jakarta Timur",
        approximateCoordinates: [106.871, -6.244],
        precision: "approximate",
      },
      evidence: [
        {
          chunkId: "chk-wf-001",
          exactQuote: "Banjir setinggi 50 cm merendam Jalan DI Panjaitan",
          supports: "Kedalaman genangan air di Cawang",
        },
      ],
    });

    const mockCorrelator = createMockCorrelatorAgent({
      decision: "new_incident",
      candidateIncidentId: null,
      reasoning: "Insiden pertama untuk luapan Cawang",
    });

    const workflow = createIncidentIntelligenceWorkflow({
      executor: db.executor,
      agentOverrides: {
        interpreter: mockInterpreter,
        correlator: mockCorrelator,
      },
    });

    const input: IncidentWorkflowInput = {
      reportRevisionId: "rev-wf-001",
      reportText: "Banjir setinggi 50 cm merendam Jalan DI Panjaitan, Cawang, Jakarta Timur pada sore hari.",
      sourceKind: "rss",
      sourceDisplayName: "Media Indonesia",
      publishedAt: "2026-10-30T16:00:00.000Z",
      datasetKind: "synthetic",
      traceId: "trace-wf-test-01",
      evidenceChunks: [
        {
          chunkId: "chk-wf-001",
          spanStart: 0,
          spanEnd: 92,
          text: "Banjir setinggi 50 cm merendam Jalan DI Panjaitan, Cawang, Jakarta Timur pada sore hari.",
        },
      ],
    };

    const run = await workflow.createRun();
    const execution = await run.start({ inputData: input });
    assert.equal(execution.status, "success");
    const result = execution.result as any;
    assert.equal(result.reportRevisionId, "rev-wf-001");
    assert.ok(result.interpretation.summary);
    assert.equal(result.interpretation.incidentType, "genangan_air_luapan_saluran");
    assert.equal(result.correlation.decision, "new_incident");
    assert.ok(result.incident.incidentId);

    // Verify incident was saved in database with open-ended incidentType
    const incidentRepo = createSqlIncidentRepository(db.executor);
    const savedIncident = await incidentRepo.getIncidentById("synthetic", result.incident.incidentId);
    assert.ok(savedIncident);
    assert.equal(savedIncident.incident.status, "active");
    assert.equal(savedIncident.incident.incidentType, "genangan_air_luapan_saluran");
    assert.equal(savedIncident.contributingReports.length, 1);
    assert.equal(savedIncident.decisions.length, 1);

    // Verify proposal was persisted for moderation preserving open-ended type
    const proposalWriter = createEventProposalWriter(db.executor);
    const pendingProposals = await proposalWriter.readPendingProposals("synthetic");
    assert.ok(pendingProposals.length >= 1);
    const matchedProp = pendingProposals.find((p) => p.proposal_id === result.proposal.proposal_id);
    assert.ok(matchedProp);
    assert.equal(matchedProp.incident_type, "genangan_air_luapan_saluran");
    assert.equal(matchedProp.compatibility_category, "flood");
  });

  it("uses the accepted triage category when the interpreter agrees", async () => {
    const workflow = createIncidentIntelligenceWorkflow({
      executor: db.executor,
      agentOverrides: {
        interpreter: createMockInterpreterAgent({ primaryCategory: "transport_road_incidents" }),
        correlator: createMockCorrelatorAgent(),
      },
    });
    const input: IncidentWorkflowInput = {
      reportRevisionId: "rev-wf-agree-001",
      reportText: "Kecelakaan beruntun menutup ruas tol dalam kota.",
      sourceKind: "rss",
      sourceDisplayName: "Media Indonesia",
      publishedAt: "2026-10-30T16:00:00.000Z",
      datasetKind: "synthetic",
      traceId: "trace-wf-agree-01",
      evidenceChunks: [{ chunkId: "chk-wf-agree-001", spanStart: 0, spanEnd: 10, text: "Kecelakaan" }],
      triage: {
        disposition: "ingest",
        primaryCategory: "transport_road_incidents",
        incidentType: "kecelakaan_beruntun",
        jakartaScope: "dki_jakarta",
        actionability: "actionable",
        confidence: "high",
      },
    };
    const run = await workflow.createRun();
    const execution = await run.start({ inputData: input });
    assert.equal(execution.status, "success");
    const result = execution.result as any;
    assert.equal(result.proposal.primary_category, "transport_road_incidents");
    const incidents = await db.executor.query<{ record_json: unknown }>(
      `SELECT record_json FROM waspada.incidents WHERE dataset_kind = 'synthetic' AND incident_id = 'inc-rev-wf-agree-001'`,
    );
    const recordJson = incidents.rows[0]?.record_json as unknown as Record<string, unknown>;
    assert.equal((recordJson.triage as Record<string, unknown>).primaryCategory, "transport_road_incidents");
    assert.equal(recordJson.triage_mismatch, undefined);
  });

  it("preserves both values and flags mismatch on disagreement", async () => {
    const workflow = createIncidentIntelligenceWorkflow({
      executor: db.executor,
      agentOverrides: {
        interpreter: createMockInterpreterAgent({ primaryCategory: "disasters_weather" }),
        correlator: createMockCorrelatorAgent(),
      },
    });
    const input: IncidentWorkflowInput = {
      reportRevisionId: "rev-wf-disagree-001",
      reportText: "Demonstrasi menutup jalan utama.",
      sourceKind: "rss",
      sourceDisplayName: "Media Indonesia",
      publishedAt: "2026-10-30T16:00:00.000Z",
      datasetKind: "synthetic",
      traceId: "trace-wf-disagree-01",
      evidenceChunks: [{ chunkId: "chk-wf-disagree-001", spanStart: 0, spanEnd: 10, text: "Demonstrasi" }],
      triage: {
        disposition: "ingest",
        primaryCategory: "demonstrations_public_gatherings",
        incidentType: "demonstrasi",
        jakartaScope: "dki_jakarta",
        actionability: "actionable",
        confidence: "high",
      },
    };
    const run = await workflow.createRun();
    const execution = await run.start({ inputData: input });
    assert.equal(execution.status, "success");
    const result = execution.result as any;
    // Triage authoritative; interpreter preserved for comparison only.
    assert.equal(result.proposal.primary_category, "demonstrations_public_gatherings");
    assert.ok((result.proposal.caveats as string[]).includes("category_mismatch_review"));
    const incidents = await db.executor.query<{ record_json: unknown }>(
      `SELECT record_json FROM waspada.incidents WHERE dataset_kind = 'synthetic' AND incident_id = 'inc-rev-wf-disagree-001'`,
    );
    const recordJson = incidents.rows[0]?.record_json as unknown as Record<string, unknown>;
    assert.equal(recordJson.triage_mismatch, true);
    assert.equal((recordJson.interpretation as Record<string, unknown>).primaryCategory, "disasters_weather");
  });

  it("keeps interpreter authorship for structured sources without triage", async () => {
    const workflow = createIncidentIntelligenceWorkflow({
      executor: db.executor,
      agentOverrides: {
        interpreter: createMockInterpreterAgent({ primaryCategory: "fires_infrastructure_hazards" }),
        correlator: createMockCorrelatorAgent(),
      },
    });
    const input: IncidentWorkflowInput = {
      reportRevisionId: "rev-wf-plain-001",
      reportText: "Kebakaran melanda pasar.",
      sourceKind: "api",
      sourceDisplayName: "BMKG",
      publishedAt: "2026-10-30T16:00:00.000Z",
      datasetKind: "synthetic",
      traceId: "trace-wf-plain-01",
      evidenceChunks: [{ chunkId: "chk-wf-plain-001", spanStart: 0, spanEnd: 10, text: "Kebakaran" }],
    };
    const run = await workflow.createRun();
    const execution = await run.start({ inputData: input });
    assert.equal(execution.status, "success");
    const result = execution.result as any;
    assert.equal(result.proposal.primary_category, "fires_infrastructure_hazards");
    assert.ok(!(result.proposal.caveats as string[]).includes("category_mismatch_review"));
  });

  it("consolidates corroborating multi-source reports into a single unified incident proposal with is_multi_source = true and merged claims", async () => {
    // 1. Report 1 (Detik) creates initial incident
    const interpreter1 = createMockInterpreterAgent({
      summary: "Ledakan gas di Duri Kepa Kebon Jeruk merusak 3 rumah warga",
      incidentType: "ledakan_gas",
      primaryCategory: "fires_infrastructure_hazards",
      severity: "high",
      evidence: [
        {
          chunkId: "chk-multi-001",
          exactQuote: "Ledakan gas di Duri Kepa merusak 3 rumah",
          supports: "3 rumah rusak akibat ledakan gas",
        },
      ],
    });

    const correlator1 = createMockCorrelatorAgent({
      decision: "new_incident",
      candidateIncidentId: null,
      reasoning: "Laporan pertama ledakan gas Duri Kepa",
    });

    const workflow1 = createIncidentIntelligenceWorkflow({
      executor: db.executor,
      agentOverrides: { interpreter: interpreter1, correlator: correlator1 },
    });

    const input1: IncidentWorkflowInput = {
      reportRevisionId: "rev-multi-001",
      reportText: "Ledakan gas di Duri Kepa merusak 3 rumah warga pada Kamis pagi.",
      sourceKind: "rss",
      sourceDisplayName: "Detik News",
      sourceId: "source-detik-multi",
      publishedAt: "2026-11-05T08:00:00.000Z",
      datasetKind: "synthetic",
      traceId: "trace-multi-01",
      evidenceChunks: [
        {
          chunkId: "chk-multi-001",
          spanStart: 0,
          spanEnd: 60,
          text: "Ledakan gas di Duri Kepa merusak 3 rumah warga pada Kamis pagi.",
        },
      ],
    };

    const run1 = await workflow1.createRun();
    const exec1 = await run1.start({ inputData: input1 });
    assert.equal(exec1.status, "success");
    const res1 = exec1.result as any;
    const initialIncidentId = res1.incident.incidentId;
    assert.ok(initialIncidentId);
    assert.equal(res1.proposal.is_multi_source, false);
    assert.equal(res1.proposal.source_count, 1);
    assert.equal(res1.proposal.claims.length, 1);
    assert.equal(res1.proposal.proposal_id, `prop-${initialIncidentId}`);

    // 2. Report 2 (Antara) reports same incident with conflicting casualty/damage count
    const interpreter2 = createMockInterpreterAgent({
      summary: "Polisi selidiki ledakan tabung gas di Duri Kepa Jakbar, 5 rumah terdampak",
      incidentType: "ledakan_gas",
      primaryCategory: "fires_infrastructure_hazards",
      severity: "high",
      evidence: [
        {
          chunkId: "chk-multi-002",
          exactQuote: "5 rumah terdampak ledakan tabung gas",
          supports: "5 rumah terdampak di Duri Kepa",
        },
      ],
    });

    const correlator2 = createMockCorrelatorAgent({
      decision: "same_incident",
      candidateIncidentId: initialIncidentId,
      reasoning: "Kedua berita meliput ledakan tabung gas di Duri Kepa Kebon Jeruk pada waktu yang sama.",
      contradictoryEvidence: [
        {
          field: "casualty_count",
          claimA: "merusak 3 rumah",
          claimB: "5 rumah terdampak",
        },
      ],
    });

    const workflow2 = createIncidentIntelligenceWorkflow({
      executor: db.executor,
      agentOverrides: { interpreter: interpreter2, correlator: correlator2 },
    });

    const input2: IncidentWorkflowInput = {
      reportRevisionId: "rev-multi-002",
      reportText: "Polisi selidiki ledakan tabung gas di Duri Kepa Jakbar, 5 rumah terdampak.",
      sourceKind: "rss",
      sourceDisplayName: "Antara News",
      sourceId: "source-antara-multi",
      publishedAt: "2026-11-05T08:30:00.000Z",
      datasetKind: "synthetic",
      traceId: "trace-multi-02",
      evidenceChunks: [
        {
          chunkId: "chk-multi-002",
          spanStart: 0,
          spanEnd: 60,
          text: "Polisi selidiki ledakan tabung gas di Duri Kepa Jakbar, 5 rumah terdampak.",
        },
      ],
    };

    const run2 = await workflow2.createRun();
    const exec2 = await run2.start({ inputData: input2 });
    assert.equal(exec2.status, "success");
    const res2 = exec2.result as any;

    // Verify consolidated proposal
    assert.equal(res2.proposal.proposal_id, `prop-${initialIncidentId}-v2`, "Proposal ID must remain keyed to the incident with version");
    assert.equal(res2.proposal.is_multi_source, true, "Must be flagged as multi-source");
    assert.equal(res2.proposal.source_count, 2, "Source count must be incremented to 2");
    assert.equal(res2.proposal.has_discrepancy, true, "Must flag discrepancy between 3 vs 5 houses");
    assert.equal(res2.proposal.discrepancies.length, 1);
    assert.equal(res2.proposal.discrepancies[0].kind, "casualty_count");
    assert.equal(res2.proposal.claims.length, 2, "Must contain claims from both sources");
    assert.equal(res2.proposal.claims[0].is_corroborated, true, "Existing claim must be corroborated");
    assert.equal(res2.proposal.claims[1].is_corroborated, true, "New claim must be corroborated");

    // Verify moderation queue: only 1 consolidated proposal for this incident in the DB!
    const proposalWriter = createEventProposalWriter(db.executor);
    const pending = await proposalWriter.readPendingProposals("synthetic");
    const matchingProposals = pending.filter((p) => p.incident_id === initialIncidentId || p.proposal_id.startsWith(`prop-${initialIncidentId}`));
    assert.equal(matchingProposals.length, 1, "There must be exactly ONE consolidated proposal in the queue");
    const singleProposal = matchingProposals[0]!;
    assert.equal(singleProposal.is_multi_source, true);
    assert.equal(singleProposal.source_count, 2);
    assert.equal(singleProposal.claims.length, 2);

    // Verify DB claims have evidence_label upgraded to independent_corroboration
    const dbClaims = await db.executor.query<{ claim_id: string; evidence_label: string }>(
      `SELECT claim_id, evidence_label FROM waspada.proposal_claims
       WHERE dataset_kind = 'synthetic' AND proposal_id = $1`,
      [singleProposal.proposal_id],
    );
    assert.equal(dbClaims.rows.length, 2);
    for (const c of dbClaims.rows) {
      assert.equal(c.evidence_label, "independent_corroboration");
    }
  });
});
