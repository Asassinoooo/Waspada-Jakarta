/**
 * HOSTED-14: a model's place and coordinate are kept only when the report text states the place. Pure, no network.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  BMKG_GEMPA_SOURCE_ID,
  PETABENCANA_SOURCE_ID,
  deterministicStructuredInterpretation,
  groundInterpretationLocation,
  labelIsStatedInText,
} from "../src/structured-interpretation.js";
import type { ReportInterpretation } from "../src/agents/report-interpretation-agent.js";

function interpretation(location: ReportInterpretation["location"]): ReportInterpretation {
  return {
    summary: "Banjir di Cawang.",
    incidentType: "banjir",
    severity: "unknown",
    primaryCategory: "disasters_weather",
    location,
    eventTime: { value: null, precision: "unknown" },
    entities: [],
    impacts: [],
    operationalStatus: "unknown",
    evidence: [],
    conflictingInfo: [],
    uncertaintyNotes: [],
    confidence: "medium",
  } as ReportInterpretation;
}

const CAWANG_TEXT = "Banjir setinggi lutut terjadi di Cawang, Jakarta Timur sejak siang.";

describe("HOSTED-14 intelligence location grounding", () => {
  it("keeps a model label and coordinate when the report text states the label", () => {
    const input = interpretation({ label: "Cawang, Jakarta Timur", approximateCoordinates: [106.871, -6.244], precision: "approximate" });
    const out = groundInterpretationLocation(input, CAWANG_TEXT);
    assert.equal(out, input, "nothing to change returns the same object");
  });

  it("drops a model coordinate when no place name appears in the text", () => {
    const input = interpretation({ label: null, approximateCoordinates: [106.871, -6.244], precision: "approximate" });
    const out = groundInterpretationLocation(input, "Banjir setinggi lutut merendam rumah warga sejak pagi.");
    assert.equal(out.location.approximateCoordinates, null);
    assert.equal(out.location.label, null);
    assert.equal(out.location.precision, "unknown");
  });

  it("drops a label that the text does not state, together with its coordinate", () => {
    const input = interpretation({ label: "Kemang, Jakarta Selatan", approximateCoordinates: [106.81, -6.26], precision: "approximate" });
    const out = groundInterpretationLocation(input, CAWANG_TEXT);
    assert.equal(out.location.label, null);
    assert.equal(out.location.approximateCoordinates, null);
  });

  it("accepts any comma-separated part of the label, case-insensitively", () => {
    assert.equal(labelIsStatedInText("Kemang, Jakarta Selatan", "banjir di KEMANG hari ini"), true);
    assert.equal(labelIsStatedInText("Kemang, Jakarta Selatan", "banjir di jakarta selatan"), true);
    assert.equal(labelIsStatedInText("Kemang", "banjir di Cawang"), false);
    assert.equal(labelIsStatedInText("Ab", "ab ab ab"), false, "parts under three characters do not count");
    assert.equal(labelIsStatedInText(null, CAWANG_TEXT), false);
  });

  it("never invents a region: a null label stays null, with no default", () => {
    const input = interpretation({ label: null, approximateCoordinates: null, precision: "unknown" });
    assert.equal(groundInterpretationLocation(input, CAWANG_TEXT), input);
  });
});

describe("HOSTED-14 source-stated constants", () => {
  it("pins the intelligence source ids to the worker's source-stated set", () => {
    assert.equal(PETABENCANA_SOURCE_ID, "petabencana");
    assert.equal(BMKG_GEMPA_SOURCE_ID, "source-bmkg-gempa");
  });

  it("does not ground the deterministic PetaBencana coordinate, which comes from the source text", () => {
    const result = deterministicStructuredInterpretation({
      sourceId: PETABENCANA_SOURCE_ID,
      reportText: "Laporan banjir PetaBencana ID 123. Koordinat lokasi [106.85, -6.21]. Waktu pembuatan laporan: 2026-11-16T10:00:00Z.",
      evidenceChunks: [],
    });
    assert.ok(result, "the structured path returns an interpretation");
    assert.deepEqual(result.location.approximateCoordinates, [106.85, -6.21]);
    assert.equal(result.location.precision, "approximate");
  });
});
