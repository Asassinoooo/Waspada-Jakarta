import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";
import { createTestDatabase, type TestDatabase } from "../../db/test/harness.js";
import { applyMigrations, readMigrations } from "../../db/src/migrations.js";
import {
  createIncidentIntelligenceWorkflow,
  type IncidentWorkflowInput,
} from "../src/workflows/incident-intelligence-workflow.js";
import { createEventProposalWriter } from "../../db/src/event-proposal-writer.js";
import { createSqlIncidentRepository } from "../../db/src/incident-repository.js";
import { createMockInterpreterAgent, createMockCorrelatorAgent } from "./mock-agents.js";

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
});
