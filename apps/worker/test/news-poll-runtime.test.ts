import assert from "node:assert/strict";
import test from "node:test";
import {
  createNewsPollRuntime,
  DEFAULT_ANTARA_FEEDS,
  DEFAULT_POLL_TIMEOUT_MS,
  toStoredReportRevision,
  type StoredReportRevision,
} from "../src/runtime/news-poll-runtime.js";

function withResolvers<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const SAMPLE_METRO_XML = `<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0">
  <channel>
    <title>ANTARA News Metro</title>
    <link>https://www.antaranews.com/metro</link>
    <description>Berita seputar Jakarta dan sekitarnya</description>
    <item>
      <title>Kebakaran hebat di ruko Pasar Baru Jakarta Pusat berhasil dipadamkan</title>
      <link>https://www.antaranews.com/berita/7001/kebakaran-pasar-baru</link>
      <guid>https://www.antaranews.com/berita/7001/kebakaran-pasar-baru</guid>
      <pubDate>Mon, 26 Oct 2026 04:00:00 +0700</pubDate>
    </item>
    <item>
      <title>Gubernur DKI Jakarta resmikan taman kota terpadu di Tebet</title>
      <link>https://www.antaranews.com/berita/7002/taman-tebet</link>
      <guid>https://www.antaranews.com/berita/7002/taman-tebet</guid>
      <pubDate>Mon, 26 Oct 2026 04:30:00 +0700</pubDate>
    </item>
    <item>
      <title>Banjir bandang rendam ratusan rumah di Aceh Tenggara</title>
      <link>https://www.antaranews.com/berita/7003/banjir-aceh</link>
      <guid>https://www.antaranews.com/berita/7003/banjir-aceh</guid>
      <pubDate>Mon, 26 Oct 2026 05:00:00 +0700</pubDate>
    </item>
  </channel>
</rss>`;

const SAMPLE_CRIME_XML = `<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0">
  <channel>
    <title>ANTARA News Hukum dan Kriminalitas</title>
    <link>https://www.antaranews.com/hukum-kriminalitas</link>
    <description>Berita hukum dan kriminalitas</description>
    <item>
      <title>Polisi amankan pelaku tawuran di kawasan Matraman Jakarta Timur</title>
      <link>https://www.antaranews.com/berita/8001/tawuran-matraman</link>
      <guid>https://www.antaranews.com/berita/8001/tawuran-matraman</guid>
      <pubDate>Mon, 26 Oct 2026 05:30:00 +0700</pubDate>
    </item>
    <item>
      <title>Kebakaran hebat di ruko Pasar Baru Jakarta Pusat berhasil dipadamkan</title>
      <link>https://www.antaranews.com/berita/7001/kebakaran-pasar-baru</link>
      <guid>https://www.antaranews.com/berita/7001/kebakaran-pasar-baru</guid>
      <pubDate>Mon, 26 Oct 2026 04:00:00 +0700</pubDate>
    </item>
  </channel>
</rss>`;

test("default configuration contains two ANTARA feeds and 20s timeout", () => {
  assert.equal(DEFAULT_ANTARA_FEEDS.length, 2);
  assert.equal(DEFAULT_ANTARA_FEEDS[0]!.url, "https://www.antaranews.com/rss/metro.xml");
  assert.equal(DEFAULT_ANTARA_FEEDS[0]!.sourceId, "source-antara-metro");
  assert.equal(DEFAULT_ANTARA_FEEDS[1]!.url, "https://www.antaranews.com/rss/hukum-kriminalitas.xml");
  assert.equal(DEFAULT_ANTARA_FEEDS[1]!.sourceId, "source-antara-hukum-kriminalitas");
  assert.equal(DEFAULT_POLL_TIMEOUT_MS, 20_000);
});

test("createNewsPollRuntime polls feeds, filters Jakarta incident news, and returns StoredReportRevision items", async () => {
  const mockFetch: typeof fetch = async (input) => {
    const url = String(input);
    if (url.includes("metro.xml")) {
      return new Response(SAMPLE_METRO_XML, {
        status: 200,
        headers: { "Content-Type": "application/xml" },
      });
    }
    if (url.includes("hukum-kriminalitas.xml")) {
      return new Response(SAMPLE_CRIME_XML, {
        status: 200,
        headers: { "Content-Type": "application/xml" },
      });
    }
    return new Response("Not found", { status: 404 });
  };

  const fixedNow = "2026-10-26T08:00:00.000Z";
  const callbackRevisions: StoredReportRevision[] = [];

  const runtime = createNewsPollRuntime({
    fetchFn: mockFetch,
    now: () => fixedNow,
    onRevisions: (revs) => {
      callbackRevisions.push(...revs);
    },
  });

  const result = await runtime.poll();

  // Verification of summary
  assert.equal(result.success, true);
  assert.equal(result.polledAt, fixedNow);
  assert.equal(result.totalFeeds, 2);
  assert.equal(result.successfulFeeds, 2);
  assert.equal(result.failedFeeds, 0);
  assert.equal(result.totalItemsParsed, 5); // 3 from metro + 2 from crime

  // Revisions should be filtered and deduplicated:
  // Item 1 (kebakaran Pasar Baru Jakarta Pusat) -> matched
  // Item 2 (taman Tebet Jakarta - non incident) -> filtered out
  // Item 3 (banjir Aceh - non Jakarta) -> filtered out
  // Item 4 (tawuran Matraman Jakarta Timur) -> matched
  // Item 5 (duplicate kebakaran Pasar Baru) -> matched by feed, but deduplicated in aggregate revisions
  assert.equal(result.revisions.length, 2);
  assert.equal(result.length, 2); // Array-like access
  assert.equal(callbackRevisions.length, 2);

  // Check first revision adherence to Frozen Contract (StoredReportRevision)
  const rev1 = result.revisions[0]!;
  assert.ok(rev1.report_revision_id.startsWith("rep-source-antara-metro-"));
  assert.equal(rev1.source_id, "source-antara-metro");
  assert.equal(rev1.canonical_url, "https://www.antaranews.com/berita/7001/kebakaran-pasar-baru");
  assert.equal(rev1.permitted_text, "Kebakaran hebat di ruko Pasar Baru Jakarta Pusat berhasil dipadamkan");
  assert.equal(rev1.revision_status, "unreviewed");
  assert.equal(rev1.retrieved_at, fixedNow);
  assert.ok(rev1.published_at !== null);

  // Check chunks contract (StoredEvidenceChunk)
  assert.equal(rev1.chunks.length, 1);
  const chunk1 = rev1.chunks[0]!;
  assert.equal(chunk1.chunk_index, 0);
  assert.equal(chunk1.text, rev1.permitted_text);
  assert.equal(chunk1.span_start, 0);
  assert.equal(chunk1.span_end, Array.from(rev1.permitted_text).length);

  // Check second revision
  const rev2 = result.revisions[1]!;
  assert.ok(rev2.report_revision_id.startsWith("rep-source-antara-hukum-kriminalitas-"));
  assert.equal(rev2.source_id, "source-antara-hukum-kriminalitas");
  assert.equal(rev2.canonical_url, "https://www.antaranews.com/berita/8001/tawuran-matraman");
  assert.equal(rev2.permitted_text, "Polisi amankan pelaku tawuran di kawasan Matraman Jakarta Timur");
  assert.equal(rev2.revision_status, "unreviewed");
});

test("pollFeed executes polling on an individual feed config", async () => {
  const mockFetch: typeof fetch = async () => {
    return new Response(SAMPLE_METRO_XML, {
      status: 200,
      headers: { "Content-Type": "application/xml" },
    });
  };

  const runtime = createNewsPollRuntime({ fetchFn: mockFetch });
  const feedResult = await runtime.pollFeed(
    { url: "https://example.com/metro.xml", sourceId: "custom-metro" },
    "2026-10-26T09:00:00Z",
  );

  assert.equal(feedResult.status, "success");
  assert.equal(feedResult.sourceId, "custom-metro");
  assert.equal(feedResult.totalParsed, 3);
  assert.equal(feedResult.matchedCount, 1);
  assert.equal(feedResult.rejectedCount, 2);
  assert.equal(feedResult.revisions.length, 1);
  assert.equal(feedResult.revisions[0]!.source_id, "custom-metro");
});

test("handles network timeout gracefully without throwing", async () => {
  const mockFetch: typeof fetch = async (_input, init) => {
    const { promise, reject } = withResolvers<Response>();
    const signal = init?.signal;
    if (signal?.aborted) {
      const err = new Error("This operation was aborted");
      err.name = "AbortError";
      reject(err);
    } else if (signal) {
      signal.addEventListener(
        "abort",
        () => {
          const err = new Error("This operation was aborted");
          err.name = "AbortError";
          reject(err);
        },
        { once: true },
      );
    }
    return promise;
  };

  const runtime = createNewsPollRuntime({
    fetchFn: mockFetch,
    timeoutMs: 25, // Quick timeout for test
  });

  const result = await runtime.poll();

  assert.equal(result.success, false);
  assert.equal(result.totalFeeds, 2);
  assert.equal(result.successfulFeeds, 0);
  assert.equal(result.failedFeeds, 2);
  assert.equal(result.revisions.length, 0);

  for (const feedResult of result.feedResults) {
    assert.equal(feedResult.status, "timeout");
    assert.ok(feedResult.error?.includes("aborted") || feedResult.error?.includes("timed out"));
    assert.equal(feedResult.revisions.length, 0);
  }
});

test("handles malformed XML gracefully without throwing", async () => {
  const mockFetch: typeof fetch = async () => {
    return new Response("<malformed><unclosed-tag>", {
      status: 200,
      headers: { "Content-Type": "application/xml" },
    });
  };

  const runtime = createNewsPollRuntime({ fetchFn: mockFetch });
  const result = await runtime.poll();

  assert.equal(result.success, false);
  assert.equal(result.successfulFeeds, 0);
  assert.equal(result.failedFeeds, 2);
  assert.equal(result.revisions.length, 0);

  for (const feedResult of result.feedResults) {
    assert.equal(feedResult.status, "parse_error");
    assert.ok(feedResult.error !== undefined);
  }
});

test("handles HTTP errors (e.g. 500, 404) gracefully", async () => {
  const mockFetch: typeof fetch = async (input) => {
    const url = String(input);
    if (url.includes("metro.xml")) {
      return new Response("Internal Server Error", { status: 500, statusText: "Internal Server Error" });
    }
    return new Response("Not Found", { status: 404, statusText: "Not Found" });
  };

  const runtime = createNewsPollRuntime({ fetchFn: mockFetch });
  const result = await runtime.poll();

  assert.equal(result.success, false);
  assert.equal(result.successfulFeeds, 0);
  assert.equal(result.failedFeeds, 2);
  assert.equal(result.revisions.length, 0);

  assert.equal(result.feedResults[0]!.status, "fetch_error");
  assert.equal(result.feedResults[0]!.error, "HTTP 500 Internal Server Error");
  assert.equal(result.feedResults[1]!.status, "fetch_error");
  assert.equal(result.feedResults[1]!.error, "HTTP 404 Not Found");
});

test("handles partial feed failures: collects revisions from succeeding feed", async () => {
  const mockFetch: typeof fetch = async (input) => {
    const url = String(input);
    if (url.includes("metro.xml")) {
      return new Response(SAMPLE_METRO_XML, {
        status: 200,
        headers: { "Content-Type": "application/xml" },
      });
    }
    // hukum-kriminalitas fails
    return new Response("Service Unavailable", { status: 503, statusText: "Service Unavailable" });
  };

  const runtime = createNewsPollRuntime({ fetchFn: mockFetch });
  const result = await runtime.poll();

  // One succeeded, one failed
  assert.equal(result.success, false); // overall not all feeds succeeded
  assert.equal(result.successfulFeeds, 1);
  assert.equal(result.failedFeeds, 1);

  // Successfully collected revisions from metro feed
  assert.equal(result.revisions.length, 1);
  assert.equal(result.revisions[0]!.source_id, "source-antara-metro");
  assert.equal(result.revisions[0]!.permitted_text, "Kebakaran hebat di ruko Pasar Baru Jakarta Pusat berhasil dipadamkan");
});

test("toStoredReportRevision maps PreparedNewsReportRevision correctly to StoredReportRevision", () => {
  const mapped = toStoredReportRevision({
    report_revision_id: "rep-test-1",
    source_id: "source-test",
    canonical_url: "https://example.com/test",
    source_revision_key: "key-1",
    content_hash: "hash-1",
    permitted_text: "Banjir di Kebon Jeruk Jakarta Barat",
    permitted_text_hash: "hash-2",
    normalization_version: "nfkc_v1",
    published_at: "2026-10-26T07:00:00.000Z",
    retrieved_at: "2026-10-26T08:00:00.000Z",
    revision_status: "unreviewed",
    evidence_chunks: [
      {
        chunk_index: 0,
        text: "Banjir di Kebon Jeruk Jakarta Barat",
        span_start: 0,
        span_end: 35,
      },
    ],
  });

  assert.equal(mapped.report_revision_id, "rep-test-1");
  assert.equal(mapped.source_id, "source-test");
  assert.equal(mapped.canonical_url, "https://example.com/test");
  assert.equal(mapped.permitted_text, "Banjir di Kebon Jeruk Jakarta Barat");
  assert.equal(mapped.revision_status, "unreviewed");
  assert.equal(mapped.chunks.length, 1);
  assert.equal(mapped.chunks[0]!.chunk_index, 0);
  assert.equal(mapped.chunks[0]!.text, "Banjir di Kebon Jeruk Jakarta Barat");
  assert.equal(mapped.chunks[0]!.span_start, 0);
  assert.equal(mapped.chunks[0]!.span_end, 35);
  // Also backward compatible with evidence_chunks
  assert.equal(mapped.evidence_chunks?.length, 1);
});

test("handles empty feed without incident items", async () => {
  const emptyFeedXml = `<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0">
  <channel>
    <title>Empty Feed</title>
    <link>https://example.com</link>
    <description>No items here</description>
  </channel>
</rss>`;

  const mockFetch: typeof fetch = async () => {
    return new Response(emptyFeedXml, {
      status: 200,
      headers: { "Content-Type": "application/xml" },
    });
  };

  const runtime = createNewsPollRuntime({
    feeds: [{ url: "https://example.com/empty.xml", sourceId: "source-empty" }],
    fetchFn: mockFetch,
  });
  const result = await runtime.poll();

  assert.equal(result.success, true);
  assert.equal(result.revisions.length, 0);
  assert.equal(result.totalItemsParsed, 0);
  assert.equal(result.totalMatched, 0);
});

test("handles unexpected network fetch rejection (e.g. DNS failure) gracefully", async () => {
  const mockFetch: typeof fetch = async () => {
    throw new TypeError("fetch failed: ENOTFOUND www.antaranews.com");
  };

  const runtime = createNewsPollRuntime({ fetchFn: mockFetch });
  const result = await runtime.poll();

  assert.equal(result.success, false);
  assert.equal(result.successfulFeeds, 0);
  assert.equal(result.failedFeeds, 2);
  assert.equal(result.revisions.length, 0);
  assert.equal(result.feedResults[0]!.status, "fetch_error");
  assert.ok(result.feedResults[0]!.error?.includes("ENOTFOUND"));
});

test("NewsPollResult supports iterable for..of loop and array index access", async () => {
  const mockFetch: typeof fetch = async () => {
    return new Response(SAMPLE_METRO_XML, {
      status: 200,
      headers: { "Content-Type": "application/xml" },
    });
  };

  const runtime = createNewsPollRuntime({
    feeds: [{ url: "https://example.com/single.xml", sourceId: "source-single" }],
    fetchFn: mockFetch,
  });
  const result = await runtime.poll();

  assert.equal(Array.isArray(result), true);
  assert.equal(result.length, 1);

  // Array indexing
  const firstRev = result[0]!;
  assert.equal(firstRev.source_id, "source-single");

  // for..of iteration
  let iteratedCount = 0;
  for (const rev of result) {
    assert.equal(rev.revision_status, "unreviewed");
    iteratedCount += 1;
  }
  assert.equal(iteratedCount, 1);
});
