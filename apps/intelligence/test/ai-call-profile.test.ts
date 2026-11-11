import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Agent } from "@mastra/core/agent";
import { createTestDatabase, type TestDatabase } from "../../db/test/harness.js";
import { applyMigrations, readMigrations } from "../../db/src/migrations.js";
import {
  createNineRouterRateGate,
  getNineRouterCallCounts,
  setNineRouterRateGate,
  type NineRouterFetch,
} from "../../db/src/ninerouter-rate-gate.js";
import {
  createIncidentIntelligenceWorkflow,
  IncidentWorkflowInputSchema,
} from "../src/workflows/incident-intelligence-workflow.js";
import { generateMockVector, type NineRouterConfig } from "../src/providers/ninerouter-adapter.js";
import { ReportInterpretationSchema, type ReportInterpretation } from "../src/agents/report-interpretation-agent.js";
import { correlateWithoutCandidates, CORRELATION_MIN_SIMILARITY } from "../src/agents/incident-correlation-agent.js";
import {
  BMKG_GEMPA_SOURCE_ID,
  PETABENCANA_SOURCE_ID,
  deterministicStructuredInterpretation,
} from "../src/structured-interpretation.js";
import { PETABENCANA_SOURCE_ID as WORKER_PETABENCANA_SOURCE_ID } from "../../worker/src/layers/l1-data-knowledge/petabencana-ingest.js";
import { formatPetabencanaReportText } from "../../worker/src/layers/l1-data-knowledge/petabencana-ingest.js";
import type { PetabencanaReport } from "../../worker/src/layers/l1-data-knowledge/petabencana-geojson.js";
import { BMKG_GEMPA_SOURCE_ID as WORKER_BMKG_SOURCE_ID, mapBmkgGempaToRevision, type BmkgGempaRawItem } from "../../worker/src/runtime/bmkg-poll-runtime.js";
import type { z } from "zod";

type IncidentWorkflowInput = z.infer<typeof IncidentWorkflowInputSchema>;

// AI-RPM-01: call-profile checks. Fake transports and mock agents only; no network.

const LIVE_CONFIG: NineRouterConfig = {
  baseUrl: "http://nr.test",
  apiKey: "test-key",
  chatModel: "Waspada-Jakarta",
  embeddingModel: "gemini/gemini-embedding-2-preview",
  embeddingDimensions: 768,
  executionMode: "live",
};

const NO_SLEEP_CLOCK = { now: () => Date.now(), sleep: async () => {} };

function countingAgent(payload: unknown): { agent: Agent; calls: () => number } {
  let count = 0;
  const agent = {
    generate: async () => {
      count += 1;
      return { text: JSON.stringify(payload) };
    },
  } as unknown as Agent;
  return { agent, calls: () => count };
}

function interpretationFor(overrides: Partial<ReportInterpretation> = {}): ReportInterpretation {
  return {
    summary: "Banjir setinggi 40 cm merendam Jalan Mampang Prapatan, Jakarta Selatan",
    incidentType: "banjir",
    severity: "medium",
    primaryCategory: "disasters_weather",
    location: { label: "Mampang Prapatan, Jakarta Selatan", approximateCoordinates: null, precision: "district" },
    eventTime: { value: null, precision: "unknown" },
    entities: [],
    impacts: [],
    operationalStatus: "active",
    evidence: [],
    conflictingInfo: [],
    uncertaintyNotes: [],
    confidence: "high",
    ...overrides,
  };
}

const NEW_INCIDENT_CORRELATION = {
  decision: "new_incident",
  candidateIncidentId: null,
  reasoning: "Tidak ada kandidat.",
  supportingEvidence: [],
  contradictoryEvidence: [],
  distinctions: [],
  unresolvedQuestions: [],
  uncertainty: [],
};

/** Fake NineRouter transport: answers embeddings, records each embedded input, rejects chat. */
function embeddingTransport(embedInputs: string[]): NineRouterFetch {
  return async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (!url.endsWith("/v1/embeddings")) {
      throw new Error(`unexpected gateway request in this test: ${url}`);
    }
    const body = JSON.parse(String(init?.body ?? "{}")) as { input?: string };
    const text = body.input ?? "";
    embedInputs.push(text);
    return new Response(JSON.stringify({ data: [{ embedding: generateMockVector(text) }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
}

/**
 * Every test gets the fake embedding transport, so no test can reach the network.
 * The recorded embedding inputs are passed to the test body.
 */
async function withDatabase(run: (db: TestDatabase, embedInputs: string[]) => Promise<void>): Promise<void> {
  const db = await createTestDatabase();
  try {
    const migrations = await readMigrations(new URL("../../db/migrations/", import.meta.url));
    await applyMigrations(db.executor, migrations);
    const embedInputs: string[] = [];
    setNineRouterRateGate(createNineRouterRateGate({ transport: embeddingTransport(embedInputs), clock: NO_SLEEP_CLOCK, log: () => {} }));
    await run(db, embedInputs);
  } finally {
    setNineRouterRateGate(undefined);
    await db.close();
  }
}

function baseInput(overrides: Partial<IncidentWorkflowInput>): IncidentWorkflowInput {
  return {
    reportRevisionId: "rev-profile-001",
    reportText: "Banjir setinggi 40 cm merendam Jalan Mampang Prapatan, Jakarta Selatan.",
    sourceKind: "rss",
    sourceDisplayName: "Fixture News",
    publishedAt: "2026-11-11T07:00:00.000Z",
    datasetKind: "synthetic",
    traceId: "trace-profile-001",
    evidenceChunks: [
      {
        chunkId: "chk-profile-001",
        spanStart: 0,
        spanEnd: 72,
        text: "Banjir setinggi 40 cm merendam Jalan Mampang Prapatan, Jakarta Selatan.",
      },
    ],
    ...overrides,
  };
}

const RSS_TRIAGE = {
  disposition: "ingest" as const,
  primaryCategory: "disasters_weather",
  incidentType: "banjir",
  jakartaScope: "dki_jakarta",
  actionability: "actionable",
  confidence: "high",
};

describe("AI-RPM-01 call profile (intelligence workflow)", () => {
  it("zero candidates: the correlator is not called and the decision is a deterministic new_incident", async () => {
    await withDatabase(async (db) => {
      const correlator = countingAgent(NEW_INCIDENT_CORRELATION);
      const workflow = createIncidentIntelligenceWorkflow({
        executor: db.executor,
        config: LIVE_CONFIG,
        agentOverrides: { interpreter: countingAgent(interpretationFor()).agent, correlator: correlator.agent },
      });
      const run = await workflow.createRun();
      const execution = await run.start({ inputData: baseInput({ reportRevisionId: "rev-zero-001" }) });
      assert.equal(execution.status, "success");
      const result = execution.result as any;
      assert.equal(correlator.calls(), 0, "no correlation model call without candidates");
      assert.equal(result.correlation.decision, "new_incident");
      assert.equal(result.correlation.candidateIncidentId, null);
      assert.deepEqual(result.correlation.contradictoryEvidence, []);
      assert.match(result.correlation.reasoning, /Deterministic correlation, no model call/);
    });
  });

  it("zero candidates with no stated location: the deterministic result is unresolved, not a new incident", async () => {
    await withDatabase(async (db) => {
      const correlator = countingAgent(NEW_INCIDENT_CORRELATION);
      const vague = interpretationFor({
        location: { label: null, approximateCoordinates: null, precision: "unknown" },
      });
      const workflow = createIncidentIntelligenceWorkflow({
        executor: db.executor,
        config: LIVE_CONFIG,
        agentOverrides: { interpreter: countingAgent(vague).agent, correlator: correlator.agent },
      });
      const run = await workflow.createRun();
      const execution = await run.start({ inputData: baseInput({ reportRevisionId: "rev-vague-001" }) });
      assert.equal(execution.status, "success");
      const result = execution.result as any;
      assert.equal(correlator.calls(), 0);
      assert.equal(result.correlation.decision, "unresolved");
      assert.equal(result.correlation.candidateIncidentId, null);
    });
  });

  it("a candidate at or above the similarity threshold still reaches the correlator", async () => {
    await withDatabase(async (db) => {
      const first = createIncidentIntelligenceWorkflow({
        executor: db.executor,
        config: LIVE_CONFIG,
        agentOverrides: {
          interpreter: countingAgent(interpretationFor()).agent,
          correlator: countingAgent(NEW_INCIDENT_CORRELATION).agent,
        },
      });
      const firstRun = await (await first.createRun()).start({
        inputData: baseInput({ reportRevisionId: "rev-cand-001" }),
      });
      assert.equal(firstRun.status, "success");

      const correlator = countingAgent({ ...NEW_INCIDENT_CORRELATION, reasoning: "Kandidat sama." });
      const second = createIncidentIntelligenceWorkflow({
        executor: db.executor,
        config: LIVE_CONFIG,
        agentOverrides: { interpreter: countingAgent(interpretationFor()).agent, correlator: correlator.agent },
      });
      const secondRun = await (await second.createRun()).start({
        inputData: baseInput({ reportRevisionId: "rev-cand-002", traceId: "trace-profile-002" }),
      });
      assert.equal(secondRun.status, "success");
      assert.equal(correlator.calls(), 1, "a candidate above the threshold is correlated by the model");
      assert.equal(CORRELATION_MIN_SIMILARITY, 0.6);
    });
  });

  it("RSS revision: only the title is embedded and that vector is the retrieval query (one embedding call)", async () => {
    await withDatabase(async (db, embedInputs) => {
      const title = "Banjir rendam Jalan Mampang Prapatan Jakarta Selatan";
      const excerpt = "Air setinggi 40 cm merendam jalan dan puluhan rumah warga sejak pagi.";
      const workflow = createIncidentIntelligenceWorkflow({
        executor: db.executor,
        config: LIVE_CONFIG,
        agentOverrides: { interpreter: countingAgent(interpretationFor()).agent, correlator: countingAgent(NEW_INCIDENT_CORRELATION).agent },
      });
      const execution = await (await workflow.createRun()).start({
        inputData: baseInput({
          reportRevisionId: "rev-rss-embed-001",
          reportText: `${title}\n\n${excerpt}`,
          triage: RSS_TRIAGE,
          evidenceChunks: [
            { chunkId: "chk-rss-title", spanStart: 0, spanEnd: title.length, text: title },
            { chunkId: "chk-rss-excerpt", spanStart: title.length + 2, spanEnd: title.length + 2 + excerpt.length, text: excerpt },
          ],
        }),
      });
      assert.equal(execution.status, "success");
      assert.deepEqual(embedInputs, [title], "only the title chunk is embedded; the query is not embedded again");
      assert.deepEqual(getNineRouterCallCounts(), { chat: 0, embed: 1 });
    });
  });

  it("non-RSS revision: every chunk is embedded, and no separate query embedding is added", async () => {
    await withDatabase(async (db, embedInputs) => {
      const first = "Laporan warga pertama tentang genangan air.";
      const second = "Laporan warga kedua tentang jalan yang tertutup.";
      const workflow = createIncidentIntelligenceWorkflow({
        executor: db.executor,
        config: LIVE_CONFIG,
        agentOverrides: { interpreter: countingAgent(interpretationFor()).agent, correlator: countingAgent(NEW_INCIDENT_CORRELATION).agent },
      });
      const execution = await (await workflow.createRun()).start({
        inputData: baseInput({
          reportRevisionId: "rev-webhook-embed-001",
          reportText: `${first} ${second}`,
          sourceKind: "webhook",
          evidenceChunks: [
            { chunkId: "chk-w-1", spanStart: 0, spanEnd: first.length, text: first },
            { chunkId: "chk-w-2", spanStart: first.length + 1, spanEnd: first.length + 1 + second.length, text: second },
          ],
        }),
      });
      assert.equal(execution.status, "success");
      assert.deepEqual(embedInputs, [first, second]);
    });
  });

  it("PetaBencana and BMKG fixtures interpret with no model call and pass the interpretation schema", async () => {
    await withDatabase(async (db) => {
      const pbReport = {
        featureId: "98765",
        providerStatus: "verified",
        reportType: "banjir",
        sourceCreatedAt: "2026-11-11T07:30:00.000Z",
        sourceCreatedAtState: "valid",
        retrievedAt: "2026-11-11T08:00:00.000Z",
        geometry: { type: "Point", coordinates: [106.85, -6.21] },
      } as unknown as PetabencanaReport;
      const pbText = formatPetabencanaReportText(pbReport);

      const bmkgItem: BmkgGempaRawItem = {
        Tanggal: "11 Nov 2026",
        Jam: "07:12:00 WIB",
        DateTime: "2026-11-11T00:12:00+00:00",
        Coordinates: "-6.21,106.84",
        Lintang: "6.21 LS",
        Bujur: "106.84 BT",
        Magnitude: "5.2",
        Kedalaman: "10 km",
        Wilayah: "80 km Barat Daya Sukabumi",
        Potensi: "Tidak berpotensi tsunami",
        Dirasakan: "III Jakarta",
      };
      const bmkgRevision = mapBmkgGempaToRevision(bmkgItem, "2026-11-11T08:00:00.000Z");
      assert.ok(bmkgRevision, "fixture is relevant to Jakarta");

      const cases = [
        { label: "petabencana", sourceId: PETABENCANA_SOURCE_ID, text: pbText, expectType: "banjir", expectTime: "2026-11-11T07:30:00.000Z", expectLabel: null, expectCoords: [106.85, -6.21] },
        { label: "bmkg", sourceId: BMKG_GEMPA_SOURCE_ID, text: bmkgRevision!.permitted_text, expectType: "gempa bumi", expectTime: null, expectLabel: "80 km Barat Daya Sukabumi", expectCoords: [106.84, -6.21] },
      ] as const;

      for (const fixture of cases) {
        const interpreter = countingAgent(interpretationFor());
        const workflow = createIncidentIntelligenceWorkflow({
          executor: db.executor,
          config: LIVE_CONFIG,
          agentOverrides: { interpreter: interpreter.agent, correlator: countingAgent(NEW_INCIDENT_CORRELATION).agent },
        });
        const execution = await (await workflow.createRun()).start({
          inputData: baseInput({
            reportRevisionId: `rev-structured-${fixture.label}`,
            sourceKind: "api",
            sourceId: fixture.sourceId,
            reportText: fixture.text,
            evidenceChunks: [{ chunkId: `chk-${fixture.label}`, spanStart: 0, spanEnd: [...fixture.text].length, text: fixture.text }],
          }),
        });
        assert.equal(execution.status, "success", `${fixture.label} workflow succeeds`);
        assert.equal(interpreter.calls(), 0, `${fixture.label} makes no interpretation model call`);
        const result = execution.result as any;
        ReportInterpretationSchema.parse(result.interpretation);
        assert.equal(result.interpretation.primaryCategory, "disasters_weather");
        assert.equal(result.interpretation.severity, "unknown");
        assert.equal(result.interpretation.incidentType, fixture.expectType);
        assert.deepEqual(result.interpretation.location.approximateCoordinates, fixture.expectCoords);
        assert.equal(result.interpretation.location.label, fixture.expectLabel);
        assert.equal(result.interpretation.eventTime.value, fixture.expectTime);
        assert.equal(result.interpretation.evidence[0].exactQuote, fixture.text, "evidence quote is verbatim chunk text");
      }
    });
  });
});

describe("AI-RPM-01 structured interpretation (unit)", () => {
  it("the structured source ids equal the worker source ids", () => {
    assert.equal(PETABENCANA_SOURCE_ID, WORKER_PETABENCANA_SOURCE_ID);
    assert.equal(BMKG_GEMPA_SOURCE_ID, WORKER_BMKG_SOURCE_ID);
  });

  it("returns null for any other source, including RSS and webhook sources", () => {
    const chunks = [{ chunkId: "c", text: "Teks" }];
    assert.equal(deterministicStructuredInterpretation({ sourceId: "source-antara-metro", reportText: "Teks", evidenceChunks: chunks }), null);
    assert.equal(deterministicStructuredInterpretation({ sourceId: undefined, reportText: "Teks", evidenceChunks: chunks }), null);
  });

  it("an unparseable PetaBencana text keeps coordinates and time unknown instead of inventing them", () => {
    const interpretation = deterministicStructuredInterpretation({
      sourceId: PETABENCANA_SOURCE_ID,
      reportText: "Laporan banjir tanpa koordinat.",
      evidenceChunks: [{ chunkId: "c1", text: "Laporan banjir tanpa koordinat." }],
    });
    assert.ok(interpretation);
    assert.equal(interpretation.location.approximateCoordinates, null);
    assert.equal(interpretation.location.precision, "unknown");
    assert.equal(interpretation.eventTime.value, null);
    assert.equal(interpretation.eventTime.precision, "unknown");
  });

  it("correlateWithoutCandidates is new_incident only when a location is stated", () => {
    const located = correlateWithoutCandidates(interpretationFor());
    assert.equal(located.decision, "new_incident");
    const unlocated = correlateWithoutCandidates(interpretationFor({ location: { label: null, approximateCoordinates: null, precision: "unknown" } }));
    assert.equal(unlocated.decision, "unresolved");
  });
});
