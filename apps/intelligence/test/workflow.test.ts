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
});
