import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyNewsItem,
  parseAndFilterNewsRss,
  JAKARTA_TOPONYMS,
  INCIDENT_KEYWORDS,
} from "../src/layers/l1-data-knowledge/rss-news-ingest.js";

test("toponyms and keywords arrays are populated", () => {
  assert.ok(JAKARTA_TOPONYMS.length >= 44);
  assert.ok(INCIDENT_KEYWORDS.length >= 15);
  assert.ok(JAKARTA_TOPONYMS.includes("jakarta"));
  assert.ok(JAKARTA_TOPONYMS.includes("senen"));
  assert.ok(INCIDENT_KEYWORDS.includes("kebakaran"));
  assert.ok(INCIDENT_KEYWORDS.includes("banjir"));
});

test("classifyNewsItem identifies relevant Jakarta safety incidents and filters out off-topic items", () => {
  // Case 1: Relevant fire incident in Jakarta Pusat
  const fire = classifyNewsItem({
    title: "Kebakaran hanguskan puluhan kios di kawasan Pasar Senen Jakarta Pusat",
    link: "https://www.antaranews.com/berita/1001/kebakaran-senen",
    guid: "antara-1001",
    pubDate: "Mon, 26 Oct 2026 03:00:00 +0700",
  });
  assert.equal(fire.isRelevant, true);
  assert.ok(fire.matchedToponyms.includes("senen"));
  assert.ok(fire.matchedKeywords.includes("kebakaran"));

  // Case 2: Relevant flood incident in Jakarta Selatan
  const flood = classifyNewsItem({
    title: "Banjir tergenang hingga 50 cm di Mampang Prapatan Jakarta Selatan akibat hujan lebat",
    link: "https://www.antaranews.com/berita/1002/banjir-mampang",
    guid: "antara-1002",
    pubDate: "Mon, 26 Oct 2026 04:00:00 +0700",
  });
  assert.equal(flood.isRelevant, true);
  assert.ok(flood.matchedToponyms.includes("mampang prapatan"));
  assert.ok(flood.matchedKeywords.includes("banjir"));

  // Case 3: Incident outside Jakarta (must be rejected)
  const outsideJakarta = classifyNewsItem({
    title: "Banjir bandang terjang ratusan rumah warga di Padang Pariaman",
    link: "https://www.antaranews.com/berita/1003/banjir-padang",
    guid: "antara-1003",
    pubDate: "Mon, 26 Oct 2026 05:00:00 +0700",
  });
  assert.equal(outsideJakarta.isRelevant, false);
  assert.equal(outsideJakarta.matchedToponyms.length, 0);

  // Case 4: Jakarta news but unrelated to safety/incidents (must be rejected)
  const politicalNews = classifyNewsItem({
    title: "Pemerintah Provinsi DKI Jakarta luncurkan program beasiswa baru bagi pelajar berprestasi",
    link: "https://www.antaranews.com/berita/1004/beasiswa-jakarta",
    guid: "antara-1004",
    pubDate: "Mon, 26 Oct 2026 06:00:00 +0700",
  });
  assert.equal(politicalNews.isRelevant, false);
  assert.ok(politicalNews.matchedToponyms.includes("dki jakarta"));
  assert.equal(politicalNews.matchedKeywords.length, 0);
});

test("parseAndFilterNewsRss extracts valid report_revisions and evidence_chunks for L1 persistence", () => {
  const xml = `<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0">
  <channel>
    <title>ANTARA News Metro</title>
    <link>https://www.antaranews.com/metro</link>
    <description>Berita seputar Jakarta dan sekitarnya</description>
    <item>
      <title>Petugas damkar padamkan kebakaran rumah di Tebet Jakarta Selatan</title>
      <link>https://www.antaranews.com/berita/5001/kebakaran-tebet</link>
      <guid>https://www.antaranews.com/berita/5001/kebakaran-tebet</guid>
      <pubDate>Mon, 26 Oct 2026 02:00:00 +0700</pubDate>
    </item>
    <item>
      <title>IHSG ditutup menguat pada perdagangan awal pekan di Jakarta</title>
      <link>https://www.antaranews.com/berita/5002/ihsg-menguat</link>
      <guid>https://www.antaranews.com/berita/5002/ihsg-menguat</guid>
      <pubDate>Mon, 26 Oct 2026 02:15:00 +0700</pubDate>
    </item>
    <item>
      <title>Pohon tumbang timpa minibus di Jalan Gatot Subroto Jakarta</title>
      <link>https://www.antaranews.com/berita/5003/pohon-tumbang-gatot-subroto</link>
      <guid>https://www.antaranews.com/berita/5003/pohon-tumbang-gatot-subroto</guid>
      <pubDate>Mon, 26 Oct 2026 02:30:00 +0700</pubDate>
    </item>
  </channel>
</rss>`;

  const retrievedAt = "2026-10-26T08:00:00Z";
  const result = parseAndFilterNewsRss(xml, retrievedAt, "source-antara-metro");

  assert.ok("totalParsed" in result);
  assert.equal(result.totalParsed, 3);
  assert.equal(result.matchedCount, 2);
  assert.equal(result.rejectedCount, 1);

  // Inspect generated L1 report revisions
  assert.equal(result.revisions.length, 2);
  const rev1 = result.revisions[0]!;
  assert.equal(rev1.source_id, "source-antara-metro");
  assert.equal(rev1.canonical_url, "https://www.antaranews.com/berita/5001/kebakaran-tebet");
  assert.equal(rev1.revision_status, "unreviewed");
  assert.equal(rev1.retrieved_at, retrievedAt);
  assert.ok(rev1.permitted_text_hash.length === 64);
  assert.ok(rev1.content_hash.length === 64);

  // Check evidence chunk
  assert.equal(rev1.evidence_chunks.length, 1);
  const chunk = rev1.evidence_chunks[0]!;
  assert.equal(chunk.chunk_index, 0);
  assert.equal(chunk.span_start, 0);
  assert.equal(chunk.span_end, Array.from(rev1.permitted_text).length);
  assert.equal(chunk.text, rev1.permitted_text);
});

test("parseAndFilterNewsRss returns error on malformed XML", () => {
  const result = parseAndFilterNewsRss("<not-valid-xml>", "2026-10-26T08:00:00Z");
  assert.ok("error" in result);
  assert.equal(result.error, "invalid_root");
});

test("parseAndFilterNewsRss accepts articles within max age (2h) and rejects stale articles (50h, 2 months)", () => {
  const xml = `<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0">
  <channel>
    <title>ANTARA News Metro</title>
    <link>https://www.antaranews.com/metro</link>
    <description>Berita seputar Jakarta dan sekitarnya</description>
    <!-- Item 1: 2 hours old (fresh, accepted) -->
    <item>
      <title>Petugas damkar padamkan kebakaran rumah di Tebet Jakarta Selatan</title>
      <link>https://www.antaranews.com/berita/6001/kebakaran-tebet-2h</link>
      <guid>https://www.antaranews.com/berita/6001/kebakaran-tebet-2h</guid>
      <pubDate>Tue, 27 Oct 2026 08:00:00 +0000</pubDate>
    </item>
    <!-- Item 2: 50 hours old (stale, rejected) -->
    <item>
      <title>Pohon tumbang timpa minibus di Jalan Gatot Subroto Jakarta</title>
      <link>https://www.antaranews.com/berita/6002/pohon-gatot-subroto-50h</link>
      <guid>https://www.antaranews.com/berita/6002/pohon-gatot-subroto-50h</guid>
      <pubDate>Sun, 25 Oct 2026 08:00:00 +0000</pubDate>
    </item>
    <!-- Item 3: 2 months old from August 2026 (stale, rejected) -->
    <item>
      <title>Banjir setinggi 50 cm genangi kawasan Senen Jakarta Pusat</title>
      <link>https://www.antaranews.com/berita/6003/banjir-senen-august</link>
      <guid>https://www.antaranews.com/berita/6003/banjir-senen-august</guid>
      <pubDate>Tue, 25 Aug 2026 10:00:00 +0000</pubDate>
    </item>
  </channel>
</rss>`;

  const retrievedAt = "2026-10-27T10:00:00Z";
  const result = parseAndFilterNewsRss(xml, retrievedAt, "source-antara-metro", { maxAgeHours: 48 });

  assert.ok("totalParsed" in result);
  assert.equal(result.totalParsed, 3);
  assert.equal(result.matchedCount, 1);
  assert.equal(result.rejectedCount, 2);
  assert.equal(result.revisions.length, 1);
  assert.equal(result.revisions[0]!.canonical_url, "https://www.antaranews.com/berita/6001/kebakaran-tebet-2h");
  assert.equal(result.revisions[0]!.source_revision_key, "https://www.antaranews.com/berita/6001/kebakaran-tebet-2h");
});

test("parseAndFilterNewsRss respects NEWS_MAX_AGE_HOURS env variable and NODE_ENV production default", () => {
  const xml = `<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0">
  <channel>
    <title>ANTARA News Metro</title>
    <link>https://www.antaranews.com/metro</link>
    <description>Berita seputar Jakarta dan sekitarnya</description>
    <!-- 8 hours old -->
    <item>
      <title>Petugas damkar padamkan kebakaran rumah di Tebet Jakarta Selatan</title>
      <link>https://www.antaranews.com/berita/6010/kebakaran-tebet-8h</link>
      <guid>https://www.antaranews.com/berita/6010/kebakaran-tebet-8h</guid>
      <pubDate>Tue, 27 Oct 2026 02:00:00 +0000</pubDate>
    </item>
  </channel>
</rss>`;

  const retrievedAt = "2026-10-27T10:00:00Z";

  // Default in test/dev is 48 hours -> 8 hours old is accepted
  const defaultResult = parseAndFilterNewsRss(xml, retrievedAt, "source-antara-metro");
  assert.ok("totalParsed" in defaultResult);
  assert.equal(defaultResult.matchedCount, 1);
  assert.equal(defaultResult.rejectedCount, 0);

  // NEWS_MAX_AGE_HOURS=6 -> 8 hours old is rejected
  const origEnv = process.env.NEWS_MAX_AGE_HOURS;
  try {
    process.env.NEWS_MAX_AGE_HOURS = "6";
    const envResult = parseAndFilterNewsRss(xml, retrievedAt, "source-antara-metro");
    assert.ok("totalParsed" in envResult);
    assert.equal(envResult.matchedCount, 0);
    assert.equal(envResult.rejectedCount, 1);
  } finally {
    if (origEnv === undefined) {
      delete process.env.NEWS_MAX_AGE_HOURS;
    } else {
      process.env.NEWS_MAX_AGE_HOURS = origEnv;
    }
  }

  // NODE_ENV=production -> default is 6 hours -> 8 hours old is rejected
  const origNodeEnv = process.env.NODE_ENV;
  try {
    process.env.NODE_ENV = "production";
    delete process.env.NEWS_MAX_AGE_HOURS;
    const prodResult = parseAndFilterNewsRss(xml, retrievedAt, "source-antara-metro");
    assert.ok("totalParsed" in prodResult);
    assert.equal(prodResult.matchedCount, 0);
    assert.equal(prodResult.rejectedCount, 1);
  } finally {
    if (origNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = origNodeEnv;
    }
  }
});
