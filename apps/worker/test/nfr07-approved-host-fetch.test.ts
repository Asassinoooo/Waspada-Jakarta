import assert from "node:assert/strict";
import test from "node:test";
import { createBmkgPollRuntime } from "../src/runtime/bmkg-poll-runtime.js";
import { checkOutboundHost, declaredHostsOf, URL_INVALID_ERROR, HOST_NOT_APPROVED_ERROR } from "../src/runtime/outbound-host-policy.js";
import { createLiveNewsPollRuntime, createNewsPollRuntime } from "../src/runtime/news-poll-runtime.js";
import { createPetaBencanaPollRuntime } from "../src/runtime/petabencana-poll-runtime.js";

/**
 * NFR-07 F-42: outbound acquisition sends a request only to a host the source registry approves for that source.
 * Each refusal is checked against a recording fetch that must see no request at all. Each fixture body is one the
 * poller would ingest, so a refusal cannot pass merely because the body is empty.
 */

interface Recorded {
  readonly url: string;
  readonly redirect: RequestRedirect | undefined;
}

interface RecordingFetch {
  readonly fetch: typeof fetch;
  readonly requests: Recorded[];
  readonly followed: string[];
}

const retrievedAt = "2026-11-19T12:00:00.000Z";
const approvedFeedHost = "feed.invalid";
const feedUrl = `https://${approvedFeedHost}/antara-metro.xml`;
const redirectTarget = "https://redirect-target.invalid/relocated";

const NEWS_XML = `<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0">
  <channel>
    <title>ANTARA News Metro</title>
    <link>https://www.antaranews.com/metro</link>
    <description>Berita seputar Jakarta dan sekitarnya</description>
    <item>
      <title>Kebakaran hebat di ruko Pasar Baru Jakarta Pusat berhasil dipadamkan</title>
      <link>https://www.antaranews.com/berita/7101/kebakaran-pasar-baru</link>
      <guid>https://www.antaranews.com/berita/7101/kebakaran-pasar-baru</guid>
      <pubDate>Thu, 19 Nov 2026 10:00:00 +0700</pubDate>
    </item>
  </channel>
</rss>`;

const bmkgGempa = {
  Tanggal: "19 Nov 2026",
  Jam: "08:15:30 WIB",
  DateTime: "2026-11-19T01:15:30+00:00",
  Coordinates: "-6.80,105.50",
  Lintang: "6.80 LS",
  Bujur: "105.50 BT",
  Magnitude: "5.3",
  Kedalaman: "10 km",
  Wilayah: "Pusat gempa berada di laut 85 km Barat Daya Sumur Banten",
  Potensi: "Tidak berpotensi TSUNAMI",
  Dirasakan: "III-IV Sumur, II-III Pandeglang, II Jakarta",
};

const petaBencanaBody = JSON.stringify({
  type: "FeatureCollection",
  features: [{
    type: "Feature",
    id: "flood-monas-nfr07",
    properties: { status: "tergenang", report_type: "banjir", created_at: "2026-11-19T10:00:00Z" },
    geometry: { type: "Point", coordinates: [106.82715, -6.1754] },
  }],
});

/** A fetch that records every request and follows nothing. A "manual" request gets the redirect, as Node returns it. */
function recordingFetch(body: () => Response, redirectTo?: string): RecordingFetch {
  const requests: Recorded[] = [];
  const followed: string[] = [];
  const fetchStub = (async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({ url: String(input), redirect: init?.redirect });
    if (init?.redirect === "manual" && redirectTo !== undefined) {
      return new Response(null, { status: 302, headers: { location: redirectTo } });
    }
    if (redirectTo !== undefined) followed.push(redirectTo);
    return body();
  }) as typeof fetch;
  return { fetch: fetchStub, requests, followed };
}

const newsBody = () => new Response(NEWS_XML, { status: 200, headers: { "content-type": "application/rss+xml" } });
const bmkgBody = () => Response.json({ Infogempa: { gempa: bmkgGempa } });
const petaBencanaResponse = () => new Response(petaBencanaBody, { status: 200, headers: { "Content-Type": "application/geo+json" } });

/** The live RSS runtime with an authorization answer for the one feed. Only the request is under test. */
function liveFeedRuntime(approvedHosts: readonly string[], fetchFn: typeof fetch) {
  return createLiveNewsPollRuntime({
    feeds: [{ url: feedUrl, sourceId: "source-nfr07-host" }],
    fetchFn,
    now: () => retrievedAt,
    maxAgeHours: 48,
    triage: {
      checkAuthorization: async () => ({ cleared: true, approvedHosts }),
      findPriorDecision: async () => null,
    },
  });
}

test("NFR-07: an approved host is fetched, and the feed it serves is ingested past the host check", async () => {
  const stand = recordingFetch(newsBody);
  const result = await liveFeedRuntime([approvedFeedHost], stand.fetch).pollFeed({ url: feedUrl, sourceId: "source-nfr07-host" }, retrievedAt);
  assert.equal(stand.requests.length, 1, "the approved host receives exactly one request");
  assert.equal(stand.requests[0]?.url, feedUrl);
  assert.equal(stand.requests[0]?.redirect, "manual", "the request is made with redirects refused");
  assert.equal(result.status, "success");
  assert.equal(result.error, undefined);
});

test("NFR-07: an unapproved host is refused without a network call, and the feed is recorded as a failed fetch", async () => {
  const stand = recordingFetch(newsBody);
  const result = await liveFeedRuntime(["other-feed.invalid"], stand.fetch).pollFeed({ url: feedUrl, sourceId: "source-nfr07-host" }, retrievedAt);
  assert.equal(stand.requests.length, 0, "no request is sent to an unapproved host");
  assert.equal(result.status, "fetch_error");
  assert.equal(result.error, HOST_NOT_APPROVED_ERROR);
  assert.equal(result.revisions.length, 0);
});

test("NFR-07: a source whose registry row declares no host is refused (fail closed), with no request", async () => {
  const stand = recordingFetch(newsBody);
  const result = await liveFeedRuntime([], stand.fetch).pollFeed({ url: feedUrl, sourceId: "source-nfr07-host" }, retrievedAt);
  assert.equal(stand.requests.length, 0);
  assert.equal(result.error, HOST_NOT_APPROVED_ERROR);
});

test("NFR-07: a redirect to an unapproved host is refused, and the redirect target is never requested", async () => {
  const stand = recordingFetch(newsBody, redirectTarget);
  const result = await liveFeedRuntime([approvedFeedHost], stand.fetch).pollFeed({ url: feedUrl, sourceId: "source-nfr07-host" }, retrievedAt);
  assert.equal(stand.requests.length, 1, "only the approved feed is requested");
  assert.equal(stand.requests[0]?.redirect, "manual");
  assert.deepEqual(stand.followed, [], "the redirect target is never fetched");
  assert.equal(result.status, "fetch_error");
  assert.equal(result.error, "redirect_blocked");
  assert.equal(result.revisions.length, 0);
});

test("NFR-07: a redirect to a host the registry also approves is still not followed", async () => {
  const stand = recordingFetch(newsBody, redirectTarget);
  const result = await liveFeedRuntime([approvedFeedHost, "redirect-target.invalid"], stand.fetch)
    .pollFeed({ url: feedUrl, sourceId: "source-nfr07-host" }, retrievedAt);
  assert.equal(stand.requests.length, 1);
  assert.deepEqual(stand.followed, []);
  assert.equal(result.error, "redirect_blocked");
});

test("NFR-07: BMKG sends no request to an endpoint whose host is not approved", async () => {
  const stand = recordingFetch(bmkgBody);
  const result = await createBmkgPollRuntime({ fetch: stand.fetch, now: () => retrievedAt, approvedHosts: ["other-feed.invalid"] }).poll();
  assert.equal(stand.requests.length, 0, "neither BMKG endpoint is requested");
  assert.equal(result.outcome, "error");
  assert.equal(result.error, HOST_NOT_APPROVED_ERROR);
  assert.equal(result.revisions.length, 0);
});

test("NFR-07: BMKG fetches both endpoints when the registry approves their host, and ingests the earthquake", async () => {
  const stand = recordingFetch(bmkgBody);
  const result = await createBmkgPollRuntime({ fetch: stand.fetch, now: () => retrievedAt, approvedHosts: ["data.bmkg.go.id"] }).poll();
  assert.equal(stand.requests.length, 2, "autogempa and gempaterkini are both approved");
  assert.equal(result.outcome, "success");
  assert.ok(result.revisions.length >= 1);
});

test("NFR-07: PetaBencana sends no request to an endpoint whose host is not approved", async () => {
  const stand = recordingFetch(petaBencanaResponse);
  const result = await createPetaBencanaPollRuntime({ fetch: stand.fetch, now: () => retrievedAt, approvedHosts: ["other-feed.invalid"] }).poll();
  assert.equal(stand.requests.length, 0);
  assert.equal(result.outcome, "error");
  assert.equal(result.error, HOST_NOT_APPROVED_ERROR);
});

test("NFR-07: PetaBencana fetches its endpoint when the registry approves its host, and ingests the flood report", async () => {
  const stand = recordingFetch(petaBencanaResponse);
  const result = await createPetaBencanaPollRuntime({ fetch: stand.fetch, now: () => retrievedAt, approvedHosts: ["api.petabencana.id"] }).poll();
  assert.equal(stand.requests.length, 1);
  assert.equal(stand.requests[0]?.redirect, "manual");
  assert.equal(result.outcome, "success");
  assert.ok(result.revisions.length >= 1);
});

test("NFR-07: without a registry list, the configured feed's own host is the allow-list", async () => {
  const stand = recordingFetch(newsBody);
  const result = await createNewsPollRuntime({
    feeds: [{ url: feedUrl, sourceId: "source-nfr07-host" }],
    fetchFn: stand.fetch,
    now: () => retrievedAt,
    maxAgeHours: 48,
  }).pollFeed({ url: feedUrl, sourceId: "source-nfr07-host" }, retrievedAt);
  assert.equal(stand.requests.length, 1, "the configured host is approved by configuration");
  assert.equal(result.status, "success");
});

test("NFR-07: the host check reads the parsed host, so credential-style, look-alike and case-variant URLs are judged on it", () => {
  const approved = ["approved.invalid"];
  assert.deepEqual(checkOutboundHost("https://APPROVED.invalid/x", approved), { allowed: true, host: "approved.invalid" });
  assert.deepEqual(checkOutboundHost("https://approved.invalid/x", approved), { allowed: true, host: "approved.invalid" });
  assert.deepEqual(checkOutboundHost("https://approved.invalid@evil.invalid/x", approved), { allowed: false, error: HOST_NOT_APPROVED_ERROR });
  assert.deepEqual(checkOutboundHost("https://approved.invalid.evil.invalid/x", approved), { allowed: false, error: HOST_NOT_APPROVED_ERROR });
  assert.deepEqual(checkOutboundHost("https://approved.invalid:8443/x", approved), { allowed: false, error: HOST_NOT_APPROVED_ERROR }, "the port is part of the host");
  assert.deepEqual(checkOutboundHost("https://approved.invalid/x", []), { allowed: false, error: HOST_NOT_APPROVED_ERROR }, "an empty list refuses everything");
  assert.deepEqual(checkOutboundHost("not a url", approved), { allowed: false, error: URL_INVALID_ERROR });
});

test("NFR-07: the declared hosts of the configured endpoints are the hosts of those endpoints, without duplicates", () => {
  assert.deepEqual(
    declaredHostsOf(["https://data.bmkg.go.id/a.json", "https://data.bmkg.go.id/b.json", "not a url"]),
    ["data.bmkg.go.id"],
  );
});
