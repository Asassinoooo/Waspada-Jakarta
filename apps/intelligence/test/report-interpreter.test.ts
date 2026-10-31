import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ReportInterpretationSchema,
  interpretReport,
  type InterpretReportInput,
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
