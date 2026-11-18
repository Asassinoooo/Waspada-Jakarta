/**
 * HOSTED-35a: the public claim text. The interpreter and correlator prompts ask for Bahasa Indonesia free text and
 * a factual "supports" statement, and one article's repeated statement becomes one claim. Pure: no database, no network.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { REPORT_INTERPRETER_INSTRUCTIONS } from "../src/agents/report-interpretation-agent.js";
import { INCIDENT_CORRELATOR_INSTRUCTIONS } from "../src/agents/incident-correlation-agent.js";
import { distinctEvidenceForClaims } from "../src/workflows/incident-intelligence-workflow.js";

describe("HOSTED-35a interpreter prompt", () => {
  it("asks for Bahasa Indonesia free text and keeps the quote verbatim", () => {
    assert.ok(REPORT_INTERPRETER_INSTRUCTIONS.includes("Write 'summary', every evidence 'supports' statement and all other free text in Bahasa Indonesia."));
    assert.ok(REPORT_INTERPRETER_INSTRUCTIONS.includes("Keep 'exactQuote' verbatim from the report"));
  });

  it("defines 'supports' as a short factual sentence, and forbids the meta openings", () => {
    assert.ok(REPORT_INTERPRETER_INSTRUCTIONS.includes("one short factual sentence about the event (who, what, where)"));
    assert.ok(REPORT_INTERPRETER_INSTRUCTIONS.includes('Do not start it with "Menjelaskan", "Menyebutkan", "Memberikan" or "Describes".'));
  });

  it("states that the publish time is not the event time, and that event_time needs a stated date or time", () => {
    assert.ok(REPORT_INTERPRETER_INSTRUCTIONS.includes("Published At adalah waktu terbit artikel, bukan waktu kejadian."));
    assert.ok(REPORT_INTERPRETER_INSTRUCTIONS.includes("Isi event_time hanya bila teks laporan menyebut tanggal atau jam kejadian"));
  });
});

describe("HOSTED-35a correlator prompt", () => {
  it("asks for Bahasa Indonesia free text and keeps quotes verbatim, so the quote check still passes", () => {
    assert.ok(INCIDENT_CORRELATOR_INSTRUCTIONS.includes("Bahasa Indonesia Output (HOSTED-35a)"));
    assert.ok(INCIDENT_CORRELATOR_INSTRUCTIONS.includes("verbatim from the report text"));
  });
});

describe("HOSTED-35a claim per distinct statement", () => {
  const url = "https://example.test/berita/pohon-tumbang";

  it("one article cited by several chunks with the same statement becomes one claim, from its first chunk", () => {
    const evidence = [
      { chunkId: "chk-1", supports: "Pohon tumbang menutup jalur" },
      { chunkId: "chk-2", supports: "pohon tumbang menutup jalur." },
      { chunkId: "chk-3", supports: "  Pohon   tumbang menutup jalur " },
    ];
    const kept = distinctEvidenceForClaims(evidence, url);
    assert.deepEqual(kept.map((item) => item.chunkId), ["chk-1"]);
    assert.equal(kept[0], evidence[0], "the item itself is kept, not a copy");
  });

  it("different statements from the same article each stay a claim, with their own chunk", () => {
    const evidence = [
      { chunkId: "chk-1", supports: "Pohon tumbang menutup jalur" },
      { chunkId: "chk-2", supports: "Lalu lintas dialihkan ke jalan alternatif" },
      { chunkId: "chk-3", supports: "pohon tumbang menutup jalur" },
    ];
    assert.deepEqual(distinctEvidenceForClaims(evidence, url).map((item) => item.chunkId), ["chk-1", "chk-2"]);
  });

  it("with no article URL, the same statement still counts once", () => {
    const evidence = [
      { chunkId: "chk-1", supports: "Banjir di Cawang" },
      { chunkId: "chk-2", supports: "Banjir di Cawang" },
    ];
    assert.deepEqual(distinctEvidenceForClaims(evidence, null).map((item) => item.chunkId), ["chk-1"]);
  });

  it("keeps the original order of the statements", () => {
    const evidence = [
      { chunkId: "chk-b", supports: "Kedua" },
      { chunkId: "chk-a", supports: "Pertama" },
      { chunkId: "chk-c", supports: "kedua" },
    ];
    assert.deepEqual(distinctEvidenceForClaims(evidence, url).map((item) => item.chunkId), ["chk-b", "chk-a"]);
  });

  it("returns an empty list for no evidence", () => {
    assert.deepEqual(distinctEvidenceForClaims([], url), []);
  });
});
