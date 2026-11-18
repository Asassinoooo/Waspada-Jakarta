import assert from "node:assert/strict";
import test from "node:test";
import {
  createBmkgPollRuntime,
  isSeismicEventRelevant,
  mapBmkgGempaToRevision,
  BMKG_CANONICAL_BASE,
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

/** HOSTED-36: an earthquake in the eastern islands, felt only there, with no Jakarta name and an epicentre far outside the envelope. */
const NTT_GEMPA: BmkgGempaRawItem = {
  Tanggal: "18 Nov 2026",
  Jam: "10:02:11 WIB",
  DateTime: "2026-11-18T03:02:11+00:00",
  Coordinates: "-9.52,124.31",
  Lintang: "9.52 LS",
  Bujur: "124.31 BT",
  Magnitude: "5.1",
  Kedalaman: "12 km",
  Wilayah: "Pusat gempa berada di darat 25 km Barat Daya Kupang",
  Potensi: "Tidak berpotensi TSUNAMI",
  Dirasakan: "III Kupang, II-III Rote Ndao",
};

/** HOSTED-36: a Lampung quake of M 5.3 whose text mentions "Jawa" and a felt entry. Neither keeps it any more. */
const LAMPUNG_GEMPA: BmkgGempaRawItem = {
  Tanggal: "18 Nov 2026",
  Jam: "06:40:00 WIB",
  DateTime: "2026-11-17T23:40:00+00:00",
  Coordinates: "-6.02,104.10",
  Lintang: "6.02 LS",
  Bujur: "104.10 BT",
  Magnitude: "5.3",
  Kedalaman: "20 km",
  Wilayah: "Pusat gempa berada di laut 110 km Barat Daya Lampung Barat, Laut Jawa",
  Potensi: "Tidak berpotensi TSUNAMI",
  Dirasakan: "III Lampung Barat, II Lampung Selatan",
};

test("isSeismicEventRelevant keeps only earthquakes felt in or affecting Jakarta (HOSTED-36)", () => {
  assert.equal(isSeismicEventRelevant(SAMPLE_AUTOGEMPA), true, "a felt entry names Jakarta");
  assert.equal(isSeismicEventRelevant(SAMPLE_DISTANT_GEMPA), false);
});

test("HOSTED-36: an NTT quake that is not felt in Jakarta is dropped, even at M 5.1", () => {
  assert.equal(isSeismicEventRelevant(NTT_GEMPA), false);
  assert.equal(mapBmkgGempaToRevision(NTT_GEMPA, "2026-11-18T04:00:00.000Z"), null);
});

test("HOSTED-36: a Lampung M 5.3 quake with 'Jawa' and a felt entry is no longer kept", () => {
  assert.equal(isSeismicEventRelevant(LAMPUNG_GEMPA), false);
});

test("HOSTED-36: a quake felt as 'III Jakarta' is kept even when its epicentre is far away", () => {
  const farFromJakarta: BmkgGempaRawItem = {
    ...SAMPLE_DISTANT_GEMPA,
    Coordinates: "-9.10,110.80",
    Wilayah: "Pusat gempa di laut 150 km Selatan Pacitan",
    Dirasakan: "III Jakarta",
  };
  assert.equal(isSeismicEventRelevant(farFromJakarta), true);
});

test("HOSTED-36: a Wilayah that names a Jakarta city or regency keeps the quake", () => {
  const wilayahJakarta: BmkgGempaRawItem = {
    ...NTT_GEMPA,
    Wilayah: "Pusat gempa berada di darat 40 km Tenggara Jakarta Selatan",
    Dirasakan: undefined,
  };
  const kepulauanSeribu: BmkgGempaRawItem = { ...wilayahJakarta, Wilayah: "Laut 30 km Utara Kepulauan Seribu" };
  assert.equal(isSeismicEventRelevant(wilayahJakarta), true);
  assert.equal(isSeismicEventRelevant(kepulauanSeribu), true);
});

test("HOSTED-36: the place name is a whole word, case-insensitive, and Jakarta sub-areas count", () => {
  const withSubArea = (dirasakan: string): BmkgGempaRawItem => ({ ...NTT_GEMPA, Dirasakan: dirasakan });
  assert.equal(isSeismicEventRelevant(withSubArea("IV JAKARTA PUSAT")), true);
  assert.equal(isSeismicEventRelevant(withSubArea("II jakarta utara")), true);
  assert.equal(isSeismicEventRelevant(withSubArea("II Jakartaku")), false, "a longer word does not match");
});

test("HOSTED-36: an epicentre inside the Jakarta envelope keeps the quake without any place name", () => {
  const inside: BmkgGempaRawItem = { ...NTT_GEMPA, Coordinates: "-6.25,106.90", Wilayah: "Pusat gempa di laut", Dirasakan: undefined };
  assert.equal(isSeismicEventRelevant(inside), true);
  assert.equal(isSeismicEventRelevant({ ...inside, Coordinates: "-6.40,106.65" }), true, "south-west corner is inside");
  assert.equal(isSeismicEventRelevant({ ...inside, Coordinates: "-6.05,107.05" }), true, "north-east corner is inside");
});

test("HOSTED-36: an epicentre just outside the Jakarta envelope does not keep the quake", () => {
  const base: BmkgGempaRawItem = { ...NTT_GEMPA, Wilayah: "Pusat gempa di laut", Dirasakan: undefined };
  assert.equal(isSeismicEventRelevant({ ...base, Coordinates: "-6.41,106.90" }), false, "south of -6.40");
  assert.equal(isSeismicEventRelevant({ ...base, Coordinates: "-6.00,106.90" }), false, "north of -6.05");
  assert.equal(isSeismicEventRelevant({ ...base, Coordinates: "-6.25,106.64" }), false, "west of 106.65");
  assert.equal(isSeismicEventRelevant({ ...base, Coordinates: "-6.25,107.06" }), false, "east of 107.05");
  assert.equal(isSeismicEventRelevant({ ...base, Coordinates: "not,coords" }), false, "an unparseable epicentre keeps nothing");
});

test("HOSTED-36: the canonical URL is the BMKG page with no fragment", () => {
  const rev = mapBmkgGempaToRevision(SAMPLE_AUTOGEMPA, "2026-10-28T02:00:00.000Z");
  assert.ok(rev !== null);
  assert.equal(rev.canonical_url, BMKG_CANONICAL_BASE);
  assert.equal(rev.canonical_url.includes("#"), false);
});

test("HOSTED-36: two quakes share the page URL but keep distinct report identity and text", () => {
  const retrievedAt = "2026-10-28T02:00:00.000Z";
  const first = mapBmkgGempaToRevision(SAMPLE_AUTOGEMPA, retrievedAt);
  const second = mapBmkgGempaToRevision({ ...SAMPLE_AUTOGEMPA, DateTime: "2026-10-28T05:45:00+00:00", Magnitude: "4.9" }, retrievedAt);
  assert.ok(first !== null && second !== null);
  assert.equal(first.canonical_url, second.canonical_url);
  assert.notEqual(first.report_revision_id, second.report_revision_id);
  assert.notEqual(first.permitted_text_hash, second.permitted_text_hash);
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

test("an unparseable BMKG DateTime gives a null publish time: no throw, no retrieval-time fallback, the item still flows", async () => {
  const retrievedAt = "2026-10-28T02:00:00.000Z";
  const unparseable: BmkgGempaRawItem = { ...SAMPLE_AUTOGEMPA, DateTime: "not-a-date" };

  const rev = mapBmkgGempaToRevision(unparseable, retrievedAt);
  assert.ok(rev !== null, "the item is still mapped");
  assert.equal(rev.published_at, null);
  assert.equal(rev.retrieved_at, retrievedAt);

  const mockFetch: typeof fetch = async (input) => {
    const body = String(input).includes("autogempa")
      ? { Infogempa: { gempa: unparseable } }
      : { Infogempa: { gempa: [] } };
    return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  const result = await createBmkgPollRuntime({ fetch: mockFetch, now: () => retrievedAt }).poll();
  assert.equal(result.outcome, "success");
  assert.equal(result.revisions.length, 1, "the poll keeps the item");
  assert.equal(result.revisions[0]!.published_at, null);
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
