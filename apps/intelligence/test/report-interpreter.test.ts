import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ReportInterpretationSchema,
  interpretReport,
  generateFallbackInterpretation,
  type InterpretReportInput,
} from "../src/agents/report-interpretation-agent.js";

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
    assert.equal(parsed.location.precision, "approximate");
    assert.equal(parsed.evidence.length, 1);
  });

  it("generates fallback deterministic interpretation when mock requested", async () => {
    const fallback = await interpretReport(sampleInput, { fallbackMock: true });
    assert.ok(fallback.summary.length > 0);
    assert.ok(fallback.incidentType.length > 0);
    assert.ok(fallback.evidence.length >= 1);
    assert.equal(fallback.evidence[0].chunkId, "chk-001");
  });

  it("extracts verbatim quote substrings from source chunks", () => {
    const fallback = generateFallbackInterpretation(sampleInput);
    assert.ok(sampleInput.reportText.includes(fallback.evidence[0].exactQuote));
  });
});
