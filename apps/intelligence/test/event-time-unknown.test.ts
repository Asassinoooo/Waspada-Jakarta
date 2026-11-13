import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { createTestDatabase, type TestDatabase } from "../../db/test/harness.js";
import { applyMigrations, readMigrations } from "../../db/src/migrations.js";
import {
  createIncidentIntelligenceWorkflow,
  IncidentWorkflowInputSchema,
} from "../src/workflows/incident-intelligence-workflow.js";
import { createSqlIncidentRepository } from "../../db/src/incident-repository.js";
import { createMockInterpreterAgent, createMockCorrelatorAgent } from "./mock-agents.js";
import type { ReportInterpretation } from "../src/agents/report-interpretation-agent.js";
import type { z } from "zod";

type IncidentWorkflowInput = z.infer<typeof IncidentWorkflowInputSchema>;

// F-14: the source publish time is not an event time. Only a time the report itself gives may
// become the incident start or the proposal event time.
const publishedAt = "2026-10-30T16:00:00.000Z";
const reportText = "Pohon tumbang menutup jalur di Kebayoran Baru, Jakarta Selatan.";
const exactQuote = "Pohon tumbang menutup jalur";

function workflowInput(reportRevisionId: string): IncidentWorkflowInput {
  return {
    reportRevisionId,
    reportText,
    sourceKind: "rss",
    sourceDisplayName: "Media Indonesia",
    publishedAt,
    datasetKind: "synthetic",
    traceId: `trace-${reportRevisionId}`,
    evidenceChunks: [
      { chunkId: `chk-${reportRevisionId}`, spanStart: 0, spanEnd: reportText.length, text: reportText },
    ],
  };
}

function interpreterWithEventTime(eventTime: ReportInterpretation["eventTime"], chunkId: string) {
  return createMockInterpreterAgent({
    summary: "Pohon tumbang menutup jalur di Kebayoran Baru",
    incidentType: "pohon_tumbang",
    primaryCategory: "fires_infrastructure_hazards",
    eventTime,
    evidence: [{ chunkId, exactQuote, supports: "Pohon tumbang menutup jalur" }],
  });
}

describe("F-14 incident event time", () => {
  let db: TestDatabase;

  before(async () => {
    db = await createTestDatabase();
    const migrations = await readMigrations(new URL("../../db/migrations/", import.meta.url));
    await applyMigrations(db.executor, migrations);
  });

  after(async () => {
    await db?.close();
  });

  it("stores no incident start and no proposal event time when the report gives no event time", async () => {
    const reportRevisionId = "rev-f14-no-time-001";
    const input = workflowInput(reportRevisionId);
    const interpreter = createMockInterpreterAgent({
      summary: "Pohon tumbang menutup jalur di Kebayoran Baru",
      incidentType: "pohon_tumbang",
      primaryCategory: "fires_infrastructure_hazards",
      eventTime: { value: null, precision: "unknown" },
      evidence: [{ chunkId: input.evidenceChunks[0]!.chunkId, exactQuote, supports: "Pohon tumbang menutup jalur" }],
    });
    const workflow = createIncidentIntelligenceWorkflow({
      executor: db.executor,
      agentOverrides: {
        interpreter,
        correlator: createMockCorrelatorAgent({
          decision: "new_incident",
          candidateIncidentId: null,
          reasoning: "Insiden pertama untuk pohon tumbang Kebayoran Baru",
        }),
      },
    });

    const run = await workflow.createRun();
    const execution = await run.start({ inputData: input });
    assert.equal(execution.status, "success");
    const result = execution.result as any;

    assert.deepEqual(result.proposal.event_time, { precision: "unknown", value: null });

    const row = await db.executor.query<{ first_observed_at: Date | string | null }>(
      `SELECT first_observed_at FROM waspada.incidents
       WHERE dataset_kind = 'synthetic' AND incident_id = $1`,
      [result.incident.incidentId],
    );
    assert.equal(row.rows.length, 1);
    assert.equal(row.rows[0]?.first_observed_at, null, "the publish time is not stored as the incident start");

    const saved = await createSqlIncidentRepository(db.executor).getIncidentById(
      "synthetic",
      result.incident.incidentId,
    );
    assert.ok(saved);
    assert.equal(saved.incident.firstObservedAt, null);
  });

  it("F-14 control: a report with a source event time keeps it as the incident start and proposal event time", async () => {
    const reportRevisionId = "rev-f14-control-001";
    const input = workflowInput(reportRevisionId);
    const eventTimeValue = "2026-10-30T09:15:00.000Z";
    const workflow = createIncidentIntelligenceWorkflow({
      executor: db.executor,
      agentOverrides: {
        interpreter: interpreterWithEventTime(
          { value: eventTimeValue, precision: "exact" },
          input.evidenceChunks[0]!.chunkId,
        ),
        correlator: createMockCorrelatorAgent({
          decision: "new_incident",
          candidateIncidentId: null,
          reasoning: "Insiden pertama untuk pohon tumbang Kebayoran Baru",
        }),
      },
    });

    const run = await workflow.createRun();
    const execution = await run.start({ inputData: input });
    assert.equal(execution.status, "success");
    const result = execution.result as any;

    assert.deepEqual(result.proposal.event_time, { precision: "exact", value: eventTimeValue });
    const saved = await createSqlIncidentRepository(db.executor).getIncidentById(
      "synthetic",
      result.incident.incidentId,
    );
    assert.ok(saved);
    assert.equal(saved.incident.firstObservedAt, eventTimeValue);
  });
});
