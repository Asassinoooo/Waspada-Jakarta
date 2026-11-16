/**
 * HOSTED-17: a PetaBencana report gets the fixed source label "Laporan warga PetaBencana" (owner decision, 17 Nov 2026).
 * The label names no place, so it is never grounded against the report text, the model path cannot obtain it, and it
 * does not make a coordinate-less report count as "names a location". Pure: no database, no network.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ReportInterpretation } from "../src/agents/report-interpretation-agent.js";
import { correlateWithoutCandidates } from "../src/agents/incident-correlation-agent.js";
import {
  PETABENCANA_SOURCE_ID,
  PETABENCANA_SOURCE_LABEL,
  deterministicStructuredInterpretation,
  groundInterpretationLocation,
} from "../src/structured-interpretation.js";

const WITH_POINT = "Laporan banjir PetaBencana ID 123: status laporan verified. Koordinat lokasi [106.85000, -6.21000]. Waktu pembuatan laporan: 2026-11-16T10:00:00Z.";
const NO_POINT = "Laporan banjir PetaBencana ID 124: status laporan verified. Waktu pembuatan laporan: 2026-11-16T10:00:00Z.";

function petabencana(reportText: string): ReportInterpretation {
  const result = deterministicStructuredInterpretation({
    sourceId: PETABENCANA_SOURCE_ID,
    reportText,
    evidenceChunks: [{ chunkId: "chunk-1", text: reportText }],
  });
  assert.ok(result, "the structured PetaBencana path returns an interpretation");
  return result;
}

describe("HOSTED-17 fixed PetaBencana source label", () => {
  it("pins the label text the worker's publish rule relies on", () => {
    assert.equal(PETABENCANA_SOURCE_LABEL, "Laporan warga PetaBencana");
  });

  it("(a) a PetaBencana report with a point gets the fixed label, and its own point stays source-stated", () => {
    const interpretation = petabencana(WITH_POINT);
    assert.equal(interpretation.location.label, "Laporan warga PetaBencana");
    assert.deepEqual(interpretation.location.approximateCoordinates, [106.85, -6.21]);
    assert.equal(interpretation.location.precision, "approximate");
  });

  it("(a) the fixed label is not grounded: it passes even though the report text does not contain it", () => {
    assert.equal(WITH_POINT.toLowerCase().includes("laporan warga"), false);
    const interpretation = petabencana(NO_POINT);
    assert.equal(interpretation.location.label, "Laporan warga PetaBencana");
    assert.equal(interpretation.location.approximateCoordinates, null);
    assert.equal(interpretation.location.precision, "unknown", "no point means no location precision");
  });

  it("(b) the model path cannot keep the fixed label: grounding drops it unless the report text states it", () => {
    const modelOutput: ReportInterpretation = {
      ...petabencana(NO_POINT),
      location: { label: "Laporan warga PetaBencana", approximateCoordinates: null, precision: "unknown" },
    };
    const grounded = groundInterpretationLocation(modelOutput, NO_POINT);
    assert.equal(grounded.location.label, null);
  });

  it("the fixed label alone does not make a coordinate-less report name a location", () => {
    const correlation = correlateWithoutCandidates(petabencana(NO_POINT));
    assert.equal(correlation.decision, "unresolved");
  });

  it("a real place name still makes a report name a location", () => {
    const named: ReportInterpretation = {
      ...petabencana(NO_POINT),
      location: { label: "Kemang, Jakarta Selatan", approximateCoordinates: null, precision: "approximate" },
    };
    assert.equal(correlateWithoutCandidates(named).decision, "new_incident");
  });

  it("a PetaBencana report with its own point is still a located new incident", () => {
    assert.equal(correlateWithoutCandidates(petabencana(WITH_POINT)).decision, "new_incident");
  });
});
