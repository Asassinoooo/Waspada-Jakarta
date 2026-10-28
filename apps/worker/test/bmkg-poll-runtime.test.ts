import assert from "node:assert/strict";
import test from "node:test";
import {
  createBmkgPollRuntime,
  isSeismicEventRelevant,
  mapBmkgGempaToRevision,
  BMKG_GEMPA_SOURCE_ID,
  type BmkgGempaRawItem,
} from "../src/runtime/bmkg-poll-runtime.js";

const SAMPLE_AUTOGEMPA: BmkgGempaRawItem = {
  Tanggal: "28 Okt 2026",
  Jam: "08:15:30 WIB",
  DateTime: "2026-10-28T01:15:30+00:00",
  Coordinates: "-6.80,105.50",
  Lintang: "6.80 LS",
  Bujur: "105.50 BT",
  Magnitude: "5.3",
  Kedalaman: "10 km",
  Wilayah: "Pusat gempa berada di laut 85 km Barat Daya Sumur Banten",
  Potensi: "Tidak berpotensi TSUNAMI",
  Dirasakan: "III-IV Sumur, II-III Pandeglang, II Jakarta",
};

const SAMPLE_DISTANT_GEMPA: BmkgGempaRawItem = {
  Tanggal: "28 Okt 2026",
  Jam: "04:10:00 WIB",
  DateTime: "2026-10-27T21:10:00+00:00",
  Coordinates: "1.50,126.80",
  Lintang: "1.50 LU",
  Bujur: "126.80 BT",
  Magnitude: "3.8",
  Kedalaman: "15 km",
  Wilayah: "Pusat gempa di laut 65 km Barat Laut Halmahera Barat",
  Potensi: "Tidak berpotensi TSUNAMI",
};

test("isSeismicEventRelevant identifies earthquakes affecting Jakarta or Western Java", () => {
  assert.equal(isSeismicEventRelevant(SAMPLE_AUTOGEMPA), true);
  assert.equal(isSeismicEventRelevant(SAMPLE_DISTANT_GEMPA), false);
});

test("mapBmkgGempaToRevision maps relevant earthquake to valid L1 StoredReportRevision", () => {
  const retrievedAt = "2026-10-28T02:00:00.000Z";
  const rev = mapBmkgGempaToRevision(SAMPLE_AUTOGEMPA, retrievedAt);
  assert.ok(rev !== null);
  assert.equal(rev.source_id, BMKG_GEMPA_SOURCE_ID);
  assert.ok(rev.permitted_text.includes("BMKG: Gempa bumi M 5.3"));
  assert.ok(rev.permitted_text.includes("Dirasakan (MMI): III-IV Sumur, II-III Pandeglang, II Jakarta"));
  assert.equal(rev.chunks.length, 1);
  assert.equal(rev.chunks[0]!.chunk_index, 0);
  assert.equal(rev.chunks[0]!.text, rev.permitted_text);
  assert.equal(rev.chunks[0]!.span_end, Array.from(rev.permitted_text).length);
});

test("createBmkgPollRuntime polls autogempa and gempaterkini endpoints and returns revisions", async () => {
  const mockFetch: typeof fetch = async (input) => {
    const url = String(input);
    if (url.includes("autogempa")) {
      return new Response(JSON.stringify({ Infogempa: { gempa: SAMPLE_AUTOGEMPA } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ Infogempa: { gempa: [SAMPLE_AUTOGEMPA, SAMPLE_DISTANT_GEMPA] } }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  const poller = createBmkgPollRuntime({ fetch: mockFetch });
  const result = await poller.poll();
  assert.equal(result.outcome, "success");
  assert.equal(result.revisions.length, 1); // Deduplicated between autogempa and gempaterkini
  assert.equal(result.revisions[0]!.source_id, BMKG_GEMPA_SOURCE_ID);
});

test("createBmkgPollRuntime handles network failure gracefully without throwing", async () => {
  const failingFetch: typeof fetch = async () => {
    throw new Error("Network unreachable");
  };

  const poller = createBmkgPollRuntime({ fetch: failingFetch });
  const result = await poller.poll();
  assert.equal(result.outcome, "empty");
  assert.equal(result.revisions.length, 0);
});
