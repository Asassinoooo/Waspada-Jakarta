import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Agent } from "@mastra/core/agent";
import {
  REPORT_INTERPRETER_INSTRUCTIONS,
  ReportInterpretationSchema,
  ReportModelSeveritySchema,
  interpretReport,
  normalizeReportSeverity,
  type InterpretReportInput,
  type ReportSeverity,
} from "../src/agents/report-interpretation-agent.js";
import { createMockInterpreterAgent, createFailingAgent } from "./mock-agents.js";

describe("Mastra Report Interpretation Agent", () => {
  const sampleInput: InterpretReportInput = {
    reportRevisionId: "rev-flood-test-01",
    reportText: "Hujan deras sejak siang menyebabkan banjir setinggi 60 cm di Jalan Kemang Raya, Mampang Prapatan, Jakarta Selatan. Sejumlah kendaraan mogok.",
    sourceKind: "rss",
    sourceDisplayName: "Kompas News Feed",
    publishedAt: "2026-10-30T14:30:00.000Z",
    evidenceChunks: [
      {
        chunkId: "chk-001",
        spanStart: 0,
        spanEnd: 104,
        text: "Hujan deras sejak siang menyebabkan banjir setinggi 60 cm di Jalan Kemang Raya, Mampang Prapatan, Jakarta Selatan.",
      },
      {
        chunkId: "chk-002",
        spanStart: 105,
        spanEnd: 129,
        text: "Sejumlah kendaraan mogok.",
      },
    ],
  };

  it("validates valid interpretation object against ReportInterpretationSchema", () => {
    const raw = {
      summary: "Banjir 60 cm di Jalan Kemang Raya akibat hujan deras",
      incidentType: "genangan air luapan drainase",
      severity: "medium",
      primaryCategory: "disasters_weather",
      location: {
        label: "Jl. Kemang Raya, Mampang Prapatan, Jakarta Selatan",
        approximateCoordinates: [106.815, -6.273],
        precision: "approximate",
      },
      eventTime: {
        value: "2026-10-30T14:30:00.000Z",
        precision: "exact",
      },
      entities: [
        { name: "Jalan Kemang Raya", kind: "infrastructure" },
      ],
      impacts: ["Banjir 60 cm", "Kendaraan mogok"],
      operationalStatus: "active",
      evidence: [
        {
          chunkId: "chk-001",
          exactQuote: "banjir setinggi 60 cm di Jalan Kemang Raya",
          supports: "water_depth",
        },
      ],
      conflictingInfo: [],
      uncertaintyNotes: [],
      confidence: "high",
    };

    const parsed = ReportInterpretationSchema.parse(raw);
    assert.equal(parsed.summary, raw.summary);
    assert.equal(parsed.incidentType, "genangan air luapan drainase");
    assert.equal(parsed.severity, "medium");
    assert.equal(parsed.location.precision, "approximate");
    assert.equal(parsed.evidence.length, 1);
  });

  it("parses open-ended incident types without enums", () => {
    const raw = {
      summary: "Pipa air PDAM pecah menyebabkan semburan air dan aspal terangkat",
      incidentType: "pipa_air_pdam_bocor",
      severity: "high",
      primaryCategory: "disasters_weather",
      location: {
        label: "Jl. Rasuna Said Kav. 5",
        approximateCoordinates: null,
        precision: "corridor",
      },
      eventTime: {
        value: null,
        precision: "unknown",
      },
      entities: [],
      impacts: ["aspal_terangkat", "jalur_lambat_ditutup"],
      operationalStatus: "active",
      evidence: [],
      conflictingInfo: [],
      uncertaintyNotes: ["Tekanan air belum dimatikan"],
      confidence: "medium",
    };

    const parsed = ReportInterpretationSchema.parse(raw);
    assert.equal(parsed.incidentType, "pipa_air_pdam_bocor");
    assert.equal(parsed.location.approximateCoordinates, null);
    assert.equal(parsed.eventTime.precision, "unknown");
    assert.deepEqual(parsed.impacts, ["aspal_terangkat", "jalur_lambat_ditutup"]);
  });

  it("interprets report using provided mock agent", async () => {
    const mockAgent = createMockInterpreterAgent({
      incidentType: "fallen_electrical_pole",
      severity: "high",
      primaryCategory: "disasters_weather",
    });

    const result = await interpretReport(sampleInput, { agent: mockAgent });
    assert.equal(result.incidentType, "fallen_electrical_pole");
    assert.equal(result.severity, "high");
    assert.ok(result.evidence.length >= 1);
  });

  it("fails cleanly when agent throws (no fabricated fallback)", async () => {
    const failingAgent = createFailingAgent(new Error("NineRouter model timeout"));
    await assert.rejects(
      async () => {
        await interpretReport(sampleInput, { agent: failingAgent });
      },
      /model timeout/,
    );
  });
});

describe("Severity rubric: the model answers low, medium or high", () => {
  /** Fake interpreter: records each prompt it receives and answers with the given object as JSON. */
  function answerAgent(answer: Record<string, unknown>, prompts: string[] = []): Agent {
    return {
      generate: async (prompt: string) => {
        prompts.push(prompt);
        return { text: JSON.stringify(answer) };
      },
    } as unknown as Agent;
  }

  // A complete answer with no severity key. Tests add the severity they need.
  const VALID_ANSWER = {
    summary: "Genangan air di Jalan Kemang Raya akibat hujan deras",
    incidentType: "genangan air luapan drainase",
    primaryCategory: "disasters_weather",
    location: { label: null, approximateCoordinates: null, precision: "unknown" },
    eventTime: { value: null, precision: "unknown" },
    entities: [],
    impacts: [],
    operationalStatus: "active",
    evidence: [],
    conflictingInfo: [],
    uncertaintyNotes: [],
    confidence: "medium",
  };

  const sampleInput: InterpretReportInput = {
    reportRevisionId: "rev-severity-01",
    reportText: "Hujan deras sejak siang menyebabkan genangan air di Jalan Kemang Raya.",
    sourceKind: "rss",
    sourceDisplayName: "Fixture News",
    evidenceChunks: [],
  };

  it("the output template offers the model exactly low, medium and high for severity", async () => {
    assert.deepEqual([...ReportModelSeveritySchema.options], ["low", "medium", "high"]);
    const prompts: string[] = [];
    await interpretReport(sampleInput, { agent: answerAgent({ ...VALID_ANSWER, severity: "low" }, prompts) });
    const severityLine = prompts[0]!.split("\n").find((line) => line.trim().startsWith('"severity"'));
    assert.equal(severityLine?.trim(), '"severity": "low"|"medium"|"high",');
  });

  it("the rubric names the reported facts for each level and rules out critical and unknown as choices", () => {
    const rubric = REPORT_INTERPRETER_INSTRUCTIONS;
    const levels: Record<"high" | "medium" | "low", string[]> = {
      high: ["deaths or injuries", "evacuation", "70 cm", "riot", "collapse", "KRL/MRT/LRT", "toll road"],
      medium: ["road partly closed", "heavy congestion", "10-70 cm", "demonstration blocking roads", "transit delays", "power or water outage", "contained fire"],
      low: ["brief delay", "small fire already extinguished", "foiled tawuran", "light water pooling", "stalled vehicle"],
    };
    for (const [level, keywords] of Object.entries(levels)) {
      assert.ok(rubric.includes(`- ${level}: `), `the rubric has a ${level} line`);
      for (const keyword of keywords) {
        assert.ok(rubric.includes(keyword), `the ${level} rubric names "${keyword}"`);
      }
    }
    assert.ok(rubric.includes("Never infer it from the category alone"));
    assert.ok(rubric.includes("'critical' and 'unknown' are not valid severity values"));
  });

  it("normalizeReportSeverity keeps low, medium and high, maps critical to high, and falls back to unknown", () => {
    const cases: Array<readonly [unknown, ReportSeverity]> = [
      ["low", "low"],
      [" MEDIUM ", "medium"],
      ["high", "high"],
      ["critical", "high"],
      ["unknown", "unknown"],
      ["catastrophic", "unknown"],
      ["", "unknown"],
      [7, "unknown"],
      [null, "unknown"],
      [undefined, "unknown"],
    ];
    for (const [raw, expected] of cases) {
      assert.equal(normalizeReportSeverity(raw), expected, `raw ${JSON.stringify(raw)}`);
    }
  });

  it("a model answer goes through the normalizer: critical becomes high, and unknown, invalid or missing becomes unknown", async () => {
    const cases: Array<readonly [string, unknown, ReportSeverity]> = [
      ["critical", "critical", "high"],
      ["unknown", "unknown", "unknown"],
      ["invalid word", "catastrophic", "unknown"],
      ["missing key", undefined, "unknown"],
      ["medium", "medium", "medium"],
    ];
    for (const [label, raw, expected] of cases) {
      const result = await interpretReport(sampleInput, { agent: answerAgent({ ...VALID_ANSWER, severity: raw }) });
      assert.equal(result.severity, expected, label);
    }
  });
});
