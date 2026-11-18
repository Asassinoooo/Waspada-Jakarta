import assert from "node:assert/strict";
import { createElement } from "react";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { EventDetail as EventDetailRecord, PublicClaim, PublicContext } from "@waspada/worker/public-contracts";
import { EventDetail } from "../src/EventDetail.js";
import { collapseClaimSources } from "../src/published-events.js";

// HOSTED-24A (R-10): the API writes one attribution per evidence item. Two quotes from the same article repeat the same
// source line, so the display shows that source once and keeps every distinct quote.

type Source = PublicClaim["sources"][number];

function source(overrides: Partial<Source> = {}): Source {
  return {
    display_name: "DETIK UTAMA",
    url: "https://news.example/detik/banjir-cawang",
    published_at: "2026-11-12T03:00:00.000Z",
    observed_at: "2026-11-12T03:10:00.000Z",
    excerpt: null,
    ...overrides,
  };
}

function claim(sources: Source[]): PublicClaim {
  return {
    claim_id: "claim-24a-1",
    text: "Genangan menutup jalur Cawang.",
    event_time: { start: "2026-11-12T02:30:00.000Z", end: null, precision: "exact" },
    validity: { valid_from: null, valid_until: null },
    scope: { places: [], services: [], institutions: [], audiences: [] },
    qualifiers: [],
    evidence_label: "attributed_report",
    sources,
  };
}

function record(claims: PublicClaim[], publication?: EventDetailRecord["publication"]): EventDetailRecord {
  return {
    event_id: "evt-24a-1",
    version: 1,
    title: "Genangan di Cawang",
    summary: "Ringkasan singkat laporan.",
    category: "disasters_weather",
    tags: [],
    lifecycle: "ongoing",
    freshness: { status: "current", evaluated_at: "2026-11-12T09:00:00.000Z", review_due_at: null, basis: "fast_observation_review" },
    event_time: { start: "2026-11-12T02:30:00.000Z", end: null, precision: "exact" },
    validity: { valid_from: null, valid_until: null },
    scope: { places: ["Cawang, Jakarta Timur"], services: [], institutions: [], audiences: [] },
    claims,
    impacts: [],
    published_at: "2026-11-12T09:05:00.000Z",
    geometries: [],
    ...(publication ? { publication } : {}),
  };
}

const liveContext: PublicContext = {
  dataset_mode: "live",
  dataset_label: "live",
  generated_at: "2026-11-12T08:00:00.000Z",
  sources: [],
};

function renderLive(data: EventDetailRecord): string {
  return renderToStaticMarkup(createElement(EventDetail, {
    mode: "api-event",
    apiDetail: { eventId: data.event_id, status: "loaded", data } as never,
    apiHistory: { eventId: data.event_id, status: "loaded", data: { data: [], page: { next_cursor: null, cursor_expires_at: null } } } as never,
    context: liveContext,
    variant: "sheet",
  }));
}

function countOf(html: string, text: string): number {
  return html.split(text).length - 1;
}

test("HOSTED-24A: two quotes from one article become one source line with both quotes kept", () => {
  const lines = collapseClaimSources([
    source({ excerpt: "Genangan setinggi 50 cm." }),
    source({ excerpt: "Air masuk ke permukiman warga." }),
  ]);
  assert.equal(lines.length, 1);
  assert.equal(lines[0]!.source.display_name, "DETIK UTAMA");
  assert.deepEqual(lines[0]!.excerpts, ["Genangan setinggi 50 cm.", "Air masuk ke permukiman warga."]);
});

test("HOSTED-24A: a repeated excerpt is shown once, and a missing or empty excerpt adds nothing", () => {
  const lines = collapseClaimSources([
    source({ excerpt: "Genangan setinggi 50 cm." }),
    source({ excerpt: "Genangan setinggi 50 cm." }),
    source({ excerpt: null }),
    source({ excerpt: "" }),
  ]);
  assert.equal(lines.length, 1);
  assert.deepEqual(lines[0]!.excerpts, ["Genangan setinggi 50 cm."]);
});

test("HOSTED-24A: identical attributions collapse and the first occurrence keeps its place in the order", () => {
  const detik = source({ display_name: "DETIK UTAMA", url: "https://news.example/detik/a" });
  const antara = source({ display_name: "ANTARA", url: "https://news.example/antara/b" });
  const lines = collapseClaimSources([detik, antara, { ...detik, excerpt: null }]);
  assert.deepEqual(lines.map((line) => line.source.url), [detik.url, antara.url]);
  assert.deepEqual(lines[0]!.excerpts, []);
});

test("HOSTED-24A: a different URL, display name or source publish time is a different source", () => {
  const base = source();
  const lines = collapseClaimSources([
    base,
    { ...base, url: "https://news.example/detik/banjir-cawang-2" },
    { ...base, display_name: "DETIK NEWS" },
    { ...base, published_at: "2026-11-12T04:00:00.000Z" },
  ]);
  assert.equal(lines.length, 4);
});

test("HOSTED-24A: entries with no source publish time are one source only when name and URL also match", () => {
  const unknownTime = source({ published_at: null });
  assert.equal(collapseClaimSources([unknownTime, { ...unknownTime }]).length, 1);
  assert.equal(collapseClaimSources([unknownTime, source()]).length, 2);
});

test("HOSTED-24A: an empty source list gives no lines and the input is not changed", () => {
  assert.deepEqual(collapseClaimSources([]), []);
  const input = [source(), source()];
  const before = JSON.stringify(input);
  collapseClaimSources(input);
  assert.equal(JSON.stringify(input), before);
});

test("HOSTED-24A: the claim renders the repeated DETIK source once, with both quotes", () => {
  const html = renderLive(record([claim([
    source({ excerpt: "Genangan setinggi 50 cm." }),
    source({ excerpt: "Air masuk ke permukiman warga." }),
  ])]));
  assert.equal(countOf(html, "<h3>DETIK UTAMA</h3>"), 1);
  assert.equal(countOf(html, "Buka sumber publik"), 1);
  assert.equal(countOf(html, "Waktu sumber diterbitkan: "), 1);
  assert.match(html, /Genangan setinggi 50 cm\./u);
  assert.match(html, /Air masuk ke permukiman warga\./u);
});

test("HOSTED-24A: different sources of one claim each keep their own line", () => {
  const html = renderLive(record([claim([
    source(),
    source({ display_name: "ANTARA", url: "https://news.example/antara/banjir" }),
  ])]));
  assert.equal(countOf(html, "Buka sumber publik"), 2);
  assert.equal(countOf(html, "<h3>DETIK UTAMA</h3>"), 1);
  assert.equal(countOf(html, "<h3>ANTARA</h3>"), 1);
});

// F-09 (18 Nov 2026): the detail page counts media with the card's helper. Two quotes from one outlet are one media.
test("F-09: two quotes from one outlet are one media on the detail page, whatever the server's own count says", () => {
  const html = renderLive(record([claim([source({ excerpt: "A" }), source({ excerpt: "B" })])], {
    mode: "agent_auto",
    source_count: 2,
  }));
  assert.equal(countOf(html, "Buka sumber publik"), 1);
  assert.match(html, /<dt>Cara penerbitan<\/dt><dd>Diringkas otomatis oleh agen AI · dilaporkan oleh 1 media<\/dd>/u);
});
