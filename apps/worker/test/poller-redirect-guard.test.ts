import assert from "node:assert/strict";
import test from "node:test";
import { createBmkgPollRuntime, type BmkgGempaRawItem } from "../src/runtime/bmkg-poll-runtime.js";
import { createNewsPollRuntime } from "../src/runtime/news-poll-runtime.js";
import { createPetaBencanaPollRuntime } from "../src/runtime/petabencana-poll-runtime.js";

/**
 * NFR-07: outbound acquisition never follows a redirect. The stand-in platform fetch mirrors fetch
 * semantics. The default (follow) takes the 302 and returns the target body, which is recorded in
 * `followed`. "manual" returns the redirect itself, as a 302 with Location or as an opaqueredirect.
 * Each target body is one the poller would ingest, and a control test serves that same body
 * directly, so a refusal test cannot pass merely because the fixture is empty.
 */

const retrievedAt = "2026-10-26T12:00:00.000Z";
const redirectTarget = "https://redirect-target.invalid/relocated";
const variants = ["status", "opaqueredirect"] as const;
type Variant = (typeof variants)[number];

interface Platform {
  readonly fetch: typeof fetch;
  readonly requests: Array<{ readonly url: string; readonly redirect: RequestRedirect | undefined }>;
  readonly followed: string[];
}

function opaqueRedirect(): Response {
  // An opaqueredirect has status 0 and hides its Location, as browsers and some runtimes return it.
  return Object.defineProperties(new Response(null, { status: 200 }), {
    status: { value: 0 },
    ok: { value: false },
    type: { value: "opaqueredirect" },
  });
}

function platform(variant: Variant, targetBody: () => Response): Platform {
  const requests: Platform["requests"] = [];
  const followed: string[] = [];
  const stub = (async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({ url: String(input), redirect: init?.redirect });
    if (init?.redirect === "manual") {
      return variant === "status"
        ? new Response(null, { status: 302, headers: { location: redirectTarget } })
        : opaqueRedirect();
    }
    followed.push(redirectTarget);
    return targetBody();
  }) as typeof fetch;
  return { fetch: stub, requests, followed };
}

function direct(targetBody: () => Response): typeof fetch {
  return (async () => targetBody()) as typeof fetch;
}

function assertRedirectRefused(stand: Platform): void {
  assert.ok(stand.requests.length > 0, "the poller made at least one request");
  for (const request of stand.requests) {
    assert.equal(request.redirect, "manual", `${request.url} must be fetched with redirect "manual"`);
  }
  assert.deepEqual(stand.followed, [], "the redirect target must never be fetched");
}

const newsFeed = { url: "https://feed.invalid/antara-metro.xml", sourceId: "source-antara-metro" };
const NEWS_XML = `<?xml version="1.0" encoding="utf-8"?>
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
  </channel>
</rss>`;
const newsBody = () => new Response(NEWS_XML, { status: 200, headers: { "content-type": "application/rss+xml" } });

const bmkgGempa: BmkgGempaRawItem = {
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
const bmkgBody = () => Response.json({ Infogempa: { gempa: bmkgGempa } });

const petaBencanaBody = () => new Response(JSON.stringify({
  type: "FeatureCollection",
  features: [{
    type: "Feature",
    id: "flood-monas-1",
    properties: { status: "tergenang", report_type: "banjir", created_at: "2026-10-26T10:00:00Z" },
    geometry: { type: "Point", coordinates: [106.82715, -6.1754] },
  }],
}), { status: 200, headers: { "Content-Type": "application/geo+json" } });

test("control: the news RSS fixture is ingestible when served directly", async () => {
  const runtime = createNewsPollRuntime({ feeds: [newsFeed], fetchFn: direct(newsBody), now: () => retrievedAt, maxAgeHours: 48 });
  const result = await runtime.poll();
  assert.ok(result.revisions.length >= 1);
});

test("control: the BMKG fixture is ingestible when served directly", async () => {
  const result = await createBmkgPollRuntime({ fetch: direct(bmkgBody), now: () => retrievedAt }).poll();
  assert.ok(result.revisions.length >= 1);
});

test("control: the PetaBencana fixture is ingestible when served directly", async () => {
  const result = await createPetaBencanaPollRuntime({ fetch: direct(petaBencanaBody), now: () => retrievedAt }).poll();
  assert.ok(result.revisions.length >= 1);
});

for (const variant of variants) {
  test(`news RSS: redirect manual, a ${variant} redirect is not followed and is recorded as a blocked fetch`, async () => {
    const stand = platform(variant, newsBody);
    const runtime = createNewsPollRuntime({ feeds: [newsFeed], fetchFn: stand.fetch, now: () => retrievedAt, maxAgeHours: 48 });
    const result = await runtime.poll();
    assertRedirectRefused(stand);
    assert.equal(result.revisions.length, 0);
    assert.equal(result.feedResults[0]?.status, "fetch_error");
    assert.equal(result.feedResults[0]?.error, "redirect_blocked");
  });

  test(`BMKG: redirect manual, a ${variant} redirect is not followed and is recorded as a blocked fetch`, async () => {
    const stand = platform(variant, bmkgBody);
    const result = await createBmkgPollRuntime({ fetch: stand.fetch, now: () => retrievedAt }).poll();
    assertRedirectRefused(stand);
    assert.equal(result.revisions.length, 0);
    assert.equal(result.outcome, "error");
    assert.equal(result.error, "redirect_blocked");
  });

  test(`PetaBencana: redirect manual, a ${variant} redirect is not followed and is recorded as a blocked fetch`, async () => {
    const stand = platform(variant, petaBencanaBody);
    const result = await createPetaBencanaPollRuntime({ fetch: stand.fetch, now: () => retrievedAt }).poll();
    assertRedirectRefused(stand);
    assert.equal(result.revisions.length, 0);
    assert.equal(result.outcome, "error");
    assert.equal(result.error, "redirect_blocked");
  });
}
