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

// HOSTED-35a: the control's time must be stated in the text to be kept. 09:15Z is 16:15 WIB on 30 October 2026.
const statedTimeText = "Pohon tumbang menutup jalur di Kebayoran Baru, Jakarta Selatan pada 30 Oktober 2026 pukul 16.15 WIB.";

function workflowInput(reportRevisionId: string, text: string = reportText): IncidentWorkflowInput {
  return {
    reportRevisionId,
    reportText: text,
    sourceKind: "rss",
    sourceDisplayName: "Media Indonesia",
    publishedAt,
    datasetKind: "synthetic",
    traceId: `trace-${reportRevisionId}`,
    evidenceChunks: [
      { chunkId: `chk-${reportRevisionId}`, spanStart: 0, spanEnd: text.length, text },
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
    const workflow = createIncidentIntelligenceWorkflow({ syntheticFixtureLineage: true,
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
    const input = workflowInput(reportRevisionId, statedTimeText);
    const eventTimeValue = "2026-10-30T09:15:00.000Z";
    const workflow = createIncidentIntelligenceWorkflow({ syntheticFixtureLineage: true,
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

  it("HOSTED-35a: a time the report does not state is not stored, even when the model gives one", async () => {
    const reportRevisionId = "rev-hosted35a-time-001";
    const input = workflowInput(reportRevisionId);
    const workflow = createIncidentIntelligenceWorkflow({ syntheticFixtureLineage: true,
      executor: db.executor,
      agentOverrides: {
        // The value is on the publish day, and the text has neither a date nor a clock time.
        interpreter: interpreterWithEventTime({ value: "2026-10-30T09:15:00.000Z", precision: "exact" }, input.evidenceChunks[0]!.chunkId),
        correlator: createMockCorrelatorAgent({
          decision: "new_incident",
          candidateIncidentId: null,
          reasoning: "Insiden pertama untuk pohon tumbang Kebayoran Baru",
        }),
      },
    });

    const execution = await (await workflow.createRun()).start({ inputData: input });
    assert.equal(execution.status, "success");
    const result = execution.result as any;

    assert.deepEqual(result.proposal.event_time, { precision: "unknown", value: null });
    const saved = await createSqlIncidentRepository(db.executor).getIncidentById("synthetic", result.incident.incidentId);
    assert.ok(saved);
    assert.equal(saved.incident.firstObservedAt, null);
  });

  it("HOSTED-35a: a long title is cut at a word, and a statement cited from two chunks of one article is one claim", async () => {
    const reportRevisionId = "rev-hosted35a-claims-001";
    const chunkA = "Pohon tumbang menutup jalur di Kebayoran Baru, Jakarta Selatan.";
    const chunkB = "Pohon tumbang menutup jalur. Lalu lintas dialihkan ke jalan alternatif.";
    const text = `${chunkA} ${chunkB}`;
    const input: IncidentWorkflowInput = {
      ...workflowInput(reportRevisionId, text),
      evidenceChunks: [
        { chunkId: "chk-hosted35a-a", spanStart: 0, spanEnd: chunkA.length, text: chunkA },
        { chunkId: "chk-hosted35a-b", spanStart: chunkA.length + 1, spanEnd: text.length, text: chunkB },
      ],
    };
    const summary = "Pohon tumbang menutup jalur di Kebayoran Baru, Jakarta Selatan setelah hujan deras semalam dan membuat arus lalu lintas dari arah Blok M menuju Fatmawati tersendat hingga siang hari";
    const interpreter = createMockInterpreterAgent({
      summary,
      incidentType: "pohon_tumbang",
      primaryCategory: "fires_infrastructure_hazards",
      eventTime: { value: null, precision: "unknown" },
      evidence: [
        { chunkId: "chk-hosted35a-a", exactQuote: "Pohon tumbang menutup jalur", supports: "Pohon tumbang menutup jalur di Kebayoran Baru" },
        { chunkId: "chk-hosted35a-b", exactQuote: "Pohon tumbang menutup jalur", supports: "pohon tumbang menutup jalur di Kebayoran Baru." },
        { chunkId: "chk-hosted35a-b", exactQuote: "Lalu lintas dialihkan ke jalan alternatif", supports: "Lalu lintas dialihkan ke jalan alternatif" },
      ],
    });
    const workflow = createIncidentIntelligenceWorkflow({ syntheticFixtureLineage: true,
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

    const execution = await (await workflow.createRun()).start({ inputData: input });
    assert.equal(execution.status, "success");
    const result = execution.result as any;

    const proposalTitle: string = result.proposal.title;
    assert.ok(Array.from(proposalTitle).length <= 120, "the proposal title is at most 120 code points");
    assert.ok(proposalTitle.endsWith("…"));
    assert.ok(summary.startsWith(proposalTitle.slice(0, -1)), "the title is cut at a word of the summary");
    const incidentTitle: string = result.incident.title;
    assert.ok(Array.from(incidentTitle).length <= 150, "the incident title is at most 150 code points");
    assert.ok(incidentTitle.endsWith("…"));

    assert.deepEqual(
      result.proposal.claims.map((claim: { claim_text: string; evidence_ref_id: string }) => [claim.claim_text, claim.evidence_ref_id]),
      [
        ["Pohon tumbang menutup jalur di Kebayoran Baru", "chk-hosted35a-a"],
        ["Lalu lintas dialihkan ke jalan alternatif", "chk-hosted35a-b"],
      ],
      "the repeated statement is one claim, from its first chunk",
    );
  });
});
