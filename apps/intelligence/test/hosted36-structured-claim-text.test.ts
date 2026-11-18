/**
 * HOSTED-36 (owner decision, 18 Nov 2026): the claim text of a structured BMKG or PetaBencana interpretation is the report's
 * own sentence, not the placeholder "Teks gempa BMKG." or "Teks laporan PetaBencana.". The quote stays the chunk verbatim,
 * and the claim text is a substring of that quote, so the support still matches the chunk. Pure: no database, no network.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  BMKG_GEMPA_SOURCE_ID,
  PETABENCANA_SOURCE_ID,
  deterministicStructuredInterpretation,
} from "../src/structured-interpretation.js";
import { mapBmkgGempaToRevision, type BmkgGempaRawItem } from "../../worker/src/runtime/bmkg-poll-runtime.js";

const PLACEHOLDERS = ["Teks gempa BMKG.", "Teks laporan PetaBencana."];

const QUAKE: BmkgGempaRawItem = {
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

const PETABENCANA_WITH_POINT = "Laporan banjir PetaBencana ID 123: status laporan verified. Koordinat lokasi [106.85000, -6.21000]. Waktu pembuatan laporan: 2026-11-16T10:00:00Z.";

describe("HOSTED-36 structured claim text", () => {
  it("BMKG: the claim text is the quake's own sentence, without the coordinate prefix", () => {
    const revision = mapBmkgGempaToRevision(QUAKE, "2026-11-11T08:00:00.000Z");
    assert.ok(revision, "the fixture is kept: it is felt in Jakarta");
    const text = revision.permitted_text;
    const interpretation = deterministicStructuredInterpretation({
      sourceId: BMKG_GEMPA_SOURCE_ID,
      reportText: text,
      evidenceChunks: [{ chunkId: "chk-bmkg", text }],
    });
    assert.ok(interpretation);
    const [evidence] = interpretation.evidence;
    assert.ok(evidence);
    assert.equal(evidence.supports, "BMKG: Gempa bumi M 5.2 di 80 km Barat Daya Sukabumi, kedalaman 10 km. Tidak berpotensi tsunami. Dirasakan (MMI): III Jakarta.");
    assert.equal(PLACEHOLDERS.includes(evidence.supports), false);
    assert.equal(evidence.exactQuote, text, "the quote is still the chunk, verbatim");
    assert.equal(text.includes(evidence.supports), true, "the claim text is found in the chunk");
  });

  it("PetaBencana: the claim text is the report's own sentence, before the coordinate clause", () => {
    const interpretation = deterministicStructuredInterpretation({
      sourceId: PETABENCANA_SOURCE_ID,
      reportText: PETABENCANA_WITH_POINT,
      evidenceChunks: [{ chunkId: "chk-pb", text: PETABENCANA_WITH_POINT }],
    });
    assert.ok(interpretation);
    const [evidence] = interpretation.evidence;
    assert.ok(evidence);
    assert.equal(evidence.supports, "Laporan banjir PetaBencana ID 123: status laporan verified.");
    assert.equal(PLACEHOLDERS.includes(evidence.supports), false);
    assert.equal(evidence.exactQuote, PETABENCANA_WITH_POINT);
    assert.equal(PETABENCANA_WITH_POINT.includes(evidence.supports), true);
  });

  it("a report with no coordinate clause still uses its whole text as the claim", () => {
    const text = "Laporan banjir PetaBencana ID 124: status laporan verified. Waktu pembuatan laporan: 2026-11-16T10:00:00Z.";
    const interpretation = deterministicStructuredInterpretation({
      sourceId: PETABENCANA_SOURCE_ID,
      reportText: text,
      evidenceChunks: [{ chunkId: "chk-pb-2", text }],
    });
    assert.equal(interpretation?.evidence[0]?.supports, text.split(" Koordinat lokasi ")[0]!.trim());
    assert.equal(PLACEHOLDERS.includes(interpretation?.evidence[0]?.supports ?? ""), false);
  });
});
