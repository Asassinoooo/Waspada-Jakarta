// INTEL-02 B1: NINEROUTER_MODE=mock gives the Mastra agents a deterministic local model.
// Fake transports and a fetch spy only; the assertion is zero gateway requests for a full run.
import assert from "node:assert/strict";
import { after, afterEach, beforeEach, describe, it } from "node:test";
import type { TestDatabase } from "../../db/test/harness.js";
import { closeSharedTestDatabase, sharedTestDatabase } from "./shared-test-database.js";
import {
  createNineRouterRateGate,
  setNineRouterRateGate,
  type NineRouterFetch,
} from "../../db/src/ninerouter-rate-gate.js";
import { createEventProposalWriter } from "../../db/src/event-proposal-writer.js";
import {
  createIncidentIntelligenceWorkflow,
  IncidentWorkflowInputSchema,
} from "../src/workflows/incident-intelligence-workflow.js";
import { ReportInterpretationSchema } from "../src/agents/report-interpretation-agent.js";
import { IncidentCorrelationSchema, correlateIncident } from "../src/agents/incident-correlation-agent.js";
import { interpretReport } from "../src/agents/report-interpretation-agent.js";
import { createIncidentCorrelationAgent } from "../src/agents/incident-correlation-agent.js";
import { createMockChatModel, mockChatAnswer } from "../src/providers/mock-chat-model.js";
import { getNineRouterConfig, type NineRouterConfig } from "../src/providers/ninerouter-adapter.js";
import type { z } from "zod";

type IncidentWorkflowInput = z.infer<typeof IncidentWorkflowInputSchema>;

const NO_SLEEP_CLOCK = { now: () => Date.now(), sleep: async () => {} };
const MOCK_CONFIG: NineRouterConfig = {
  baseUrl: "http://nr.test",
  apiKey: "",
  chatModel: "Waspada-Jakarta",
  embeddingModel: "gemini/gemini-embedding-2-preview",
  embeddingDimensions: 768,
  executionMode: "mock",
  explicitMock: true,
};

const REPORT_TEXT = "Banjir setinggi 40 cm merendam Jalan Mampang Prapatan, Jakarta Selatan. Warga mengungsi sejak pagi.";

function workflowInput(overrides: Partial<IncidentWorkflowInput> = {}): IncidentWorkflowInput {
  return {
    reportRevisionId: "rev-mock-001",
    reportText: REPORT_TEXT,
    sourceKind: "rss",
    sourceDisplayName: "Fixture News",
    publishedAt: "2026-11-11T07:00:00.000Z",
    datasetKind: "synthetic",
    traceId: "trace-mock-001",
    evidenceChunks: [{ chunkId: "chk-mock-001", spanStart: 0, spanEnd: REPORT_TEXT.length, text: REPORT_TEXT }],
    ...overrides,
  };
}

describe("INTEL-02 mock chat model (unit)", () => {
  it("the interpreter answer is schema-valid and quotes only text from the prompt", async () => {
    const prompt = [
      "=== REPORT TEXT ===",
      REPORT_TEXT,
      "",
      "=== EVIDENCE CHUNKS ===",
      `[Chunk ID: chk-a] (offset 0-${REPORT_TEXT.length}): "${REPORT_TEXT}"`,
      "",
      "Format your output as a single JSON object with these keys:",
    ].join("\n");
    const parsed = ReportInterpretationSchema.parse(JSON.parse(mockChatAnswer("interpreter", prompt)));
    assert.equal(parsed.primaryCategory, "disasters_weather");
    assert.equal(parsed.evidence[0]!.chunkId, "chk-a");
    assert.ok(REPORT_TEXT.includes(parsed.evidence[0]!.exactQuote));
    assert.equal(parsed.location.label, "Jalan Mampang Prapatan", "the stated street is copied, not inferred");
    assert.equal(parsed.location.approximateCoordinates, null, "mock mode never invents coordinates");
  });

  it("the mock interpreter maps report keywords to low, medium or high severity, with high checked first", () => {
    const severityFor = (reportText: string) => {
      const prompt = [
        "=== REPORT TEXT ===",
        reportText,
        "",
        "=== EVIDENCE CHUNKS ===",
        "",
        "Format your output as a single JSON object with these keys:",
      ].join("\n");
      return ReportInterpretationSchema.parse(JSON.parse(mockChatAnswer("interpreter", prompt))).severity;
    };
    assert.equal(severityFor("Satu orang tewas setelah tiang listrik roboh di Jalan Sudirman."), "high");
    assert.equal(severityFor("Lalu lintas macet parah di Jalan Gatot Subroto."), "medium");
    assert.equal(severityFor("Kendaraan mogok di Jalan Sudirman sudah diderek ke bengkel."), "low");
    assert.equal(severityFor("Kebakaran di Jalan Mangga Dua, satu orang tewas."), "high", "a high keyword outranks a medium one");
  });

  it("the correlator answer names the first candidate when one is listed, otherwise a new incident", () => {
    const withCandidate = "[Candidate #1] ID: inc-existing-1 (Similarity Score: 0.912)\nTitle: x";
    const same = IncidentCorrelationSchema.parse(JSON.parse(mockChatAnswer("correlator", withCandidate)));
    assert.equal(same.decision, "same_incident");
    assert.equal(same.candidateIncidentId, "inc-existing-1");
    const fresh = IncidentCorrelationSchema.parse(JSON.parse(mockChatAnswer("correlator", "No active candidate incidents retrieved from database.")));
    assert.equal(fresh.decision, "new_incident");
    assert.equal(fresh.candidateIncidentId, null);
  });

  it("the mock model object is a v2 language model that answers through doGenerate and doStream", async () => {
    const model = createMockChatModel("interpreter");
    assert.equal(model.specificationVersion, "v2");
    const prompt = [{ role: "user", content: [{ type: "text", text: "=== REPORT TEXT ===\nBanjir di Jl. Mampang.\n\n=== EVIDENCE CHUNKS ===\n[Chunk ID: c1] (offset 0-5): \"Banjir\"\n\nFormat your output as a single JSON object with these keys:" }] }];
    const generated = await model.doGenerate({ prompt } as never);
    const text = (generated.content[0] as { text: string }).text;
    assert.equal(ReportInterpretationSchema.parse(JSON.parse(text)).evidence[0]!.chunkId, "c1");
    const streamed = await model.doStream({ prompt } as never);
    const reader = streamed.stream.getReader();
    let sawDelta = false;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value.type === "text-delta") sawDelta = true;
    }
    assert.equal(sawDelta, true);
  });

  it("with NINEROUTER_MODE=mock the agent factories and interpretReport/correlateIncident need no gateway", async () => {
    const saved = process.env.NINEROUTER_MODE;
    process.env.NINEROUTER_MODE = "mock";
    const fetchCalls: string[] = [];
    const savedFetch = globalThis.fetch;
    globalThis.fetch = (async (input: unknown) => {
      fetchCalls.push(String(input));
      throw new Error("gateway must not be called in mock mode");
    }) as typeof fetch;
    try {
      assert.equal(getNineRouterConfig().explicitMock, true);
      const interpretation = await interpretReport({
        reportRevisionId: "rev-direct-1",
        reportText: REPORT_TEXT,
        sourceKind: "rss",
        sourceDisplayName: "Fixture News",
        evidenceChunks: [{ chunkId: "chk-direct-1", spanStart: 0, spanEnd: REPORT_TEXT.length, text: REPORT_TEXT }],
      });
      assert.equal(interpretation.primaryCategory, "disasters_weather");
      const correlation = await correlateIncident({
        incomingReportRevisionId: "rev-direct-1",
        incomingReportText: REPORT_TEXT,
        incomingInterpretation: interpretation,
        candidateIncidents: [],
      }, { agent: createIncidentCorrelationAgent() });
      assert.equal(correlation.decision, "new_incident");
      assert.deepEqual(fetchCalls, []);
    } finally {
      globalThis.fetch = savedFetch;
      if (saved === undefined) delete process.env.NINEROUTER_MODE;
      else process.env.NINEROUTER_MODE = saved;
    }
  });

  it("without an explicit NINEROUTER_MODE=mock a missing key does not select the mock chat model", () => {
    const saved = { mode: process.env.NINEROUTER_MODE, key: process.env.NINEROUTER_KEY };
    delete process.env.NINEROUTER_MODE;
    delete process.env.NINEROUTER_KEY;
    try {
      const config = getNineRouterConfig();
      assert.equal(config.executionMode, "mock", "embeddings keep their existing mock fallback");
      assert.equal(config.explicitMock, false, "chat stays on the gateway path, which then fails without credentials");
    } finally {
      if (saved.mode !== undefined) process.env.NINEROUTER_MODE = saved.mode;
      if (saved.key !== undefined) process.env.NINEROUTER_KEY = saved.key;
    }
  });
});

// The file's PGlite database is shared across its tests and closed once here (see shared-test-database.ts).
after(async () => {
  await closeSharedTestDatabase();
});

describe("INTEL-02 mock mode full workflow (zero gateway requests)", () => {
  let db: TestDatabase;
  let savedMode: string | undefined;
  let gatewayRequests: string[];
  let savedFetch: typeof fetch;

  beforeEach(async () => {
    db = await sharedTestDatabase();
    savedMode = process.env.NINEROUTER_MODE;
    process.env.NINEROUTER_MODE = "mock";
    gatewayRequests = [];
    const transport: NineRouterFetch = async (input) => {
      gatewayRequests.push(String(input));
      throw new Error("gateway transport must not be called in mock mode");
    };
    setNineRouterRateGate(createNineRouterRateGate({ transport, clock: NO_SLEEP_CLOCK, log: () => {} }));
    savedFetch = globalThis.fetch;
    globalThis.fetch = (async (input: unknown) => {
      gatewayRequests.push(String(input));
      throw new Error("global fetch must not be called in mock mode");
    }) as typeof fetch;
  });

  afterEach(async () => {
    globalThis.fetch = savedFetch;
    setNineRouterRateGate(undefined);
    if (savedMode === undefined) delete process.env.NINEROUTER_MODE;
    else process.env.NINEROUTER_MODE = savedMode;
  });

  it("a full run (new incident, then a corroborating report) makes zero gateway requests", async () => {
    const workflow = createIncidentIntelligenceWorkflow({ syntheticFixtureLineage: true, executor: db.executor, config: MOCK_CONFIG });

    const first = await (await workflow.createRun()).start({ inputData: workflowInput() });
    assert.equal(first.status, "success");
    const firstResult = first.result as any;
    assert.equal(firstResult.correlation.decision, "new_incident");
    assert.equal(firstResult.proposal.proposal_id, `prop-${firstResult.incident.incidentId}`);

    // Same text again: identical chunk vector, similarity 1.0, so the mock correlator sees a candidate.
    const second = await (await workflow.createRun()).start({
      inputData: workflowInput({ reportRevisionId: "rev-mock-002", traceId: "trace-mock-002", evidenceChunks: [
        { chunkId: "chk-mock-002", spanStart: 0, spanEnd: REPORT_TEXT.length, text: REPORT_TEXT },
      ] }),
    });
    assert.equal(second.status, "success");
    const secondResult = second.result as any;
    assert.equal(secondResult.correlation.decision, "same_incident");
    assert.equal(secondResult.correlation.candidateIncidentId, firstResult.incident.incidentId);

    const pending = await createEventProposalWriter(db.executor).readPendingProposals("synthetic");
    assert.ok(pending.length >= 1);

    assert.deepEqual(gatewayRequests, [], "no request reached the gateway, the global fetch or the rate-gate transport");
  });
});
