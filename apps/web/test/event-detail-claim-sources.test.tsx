import assert from "node:assert/strict";
import { createElement } from "react";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { EventDetail as EventDetailRecord, HistoryEntry, PublicClaim, PublicContext } from "@waspada/worker/public-contracts";
import { EventDetail } from "../src/EventDetail.js";
import { formatInstant } from "../src/display.js";
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

// POLISH-02 (19 Nov 2026): the source collection time is shown when a source gives one, and the history label reads
// "Diperbarui otomatis" only for an automatic refresh. A moderator correction keeps "Versi dikoreksi".
function renderWithHistory(data: EventDetailRecord, entries: HistoryEntry[]): string {
  return renderToStaticMarkup(createElement(EventDetail, {
    mode: "api-event",
    apiDetail: { eventId: data.event_id, status: "loaded", data } as never,
    apiHistory: { eventId: data.event_id, status: "loaded", data: { data: entries, page: { next_cursor: null, cursor_expires_at: null } } } as never,
    context: liveContext,
    variant: "sheet",
  }));
}

function historyEntry(overrides: Partial<HistoryEntry> = {}): HistoryEntry {
  return {
    event_id: "evt-24a-1",
    version: 2,
    change_type: "corrected",
    changed_at: "2026-11-12T09:05:00.000Z",
    summary: "Ringkasan perubahan fiktif.",
    ...overrides,
  };
}

test("POLISH-02: the collection time is shown in WIB, and Tidak disebutkan stays when no source gives one", () => {
  const withTime = renderLive(record([claim([
    source({ retrieved_at: "2026-11-12T02:45:00.000Z" }),
  ])]));
  const shown = formatInstant("2026-11-12T02:45:00.000Z");
  assert.ok(shown.endsWith(" WIB"));
  assert.equal(countOf(withTime, `<dt>Waktu pengambilan sumber</dt><dd>${shown}</dd>`), 1);

  const nullTime = renderLive(record([claim([source({ retrieved_at: null })])]));
  assert.equal(countOf(nullTime, "<dt>Waktu pengambilan sumber</dt><dd>Tidak disebutkan</dd>"), 1);

  const absentTime = renderLive(record([claim([source()])]));
  assert.equal(countOf(absentTime, "<dt>Waktu pengambilan sumber</dt><dd>Tidak disebutkan</dd>"), 1);
});

test("POLISH-02: the earliest collection time across the sources is shown, and the publish and event times are unchanged", () => {
  const html = renderLive(record([
    claim([source({ retrieved_at: "2026-11-12T04:00:00.000Z" })]),
    claim([source({ display_name: "ANTARA", url: "https://news.example/antara/c", retrieved_at: "2026-11-12T02:45:00.000Z" })]),
  ]));
  assert.equal(countOf(html, `<dt>Waktu pengambilan sumber</dt><dd>${formatInstant("2026-11-12T02:45:00.000Z")}</dd>`), 1);
  assert.equal(countOf(html, `<dd>${formatInstant("2026-11-12T04:00:00.000Z")}</dd>`), 0);
  assert.match(html, /<dt>Waktu kejadian<\/dt>/u);
});

test("POLISH-02: an automatic refresh reads Diperbarui otomatis, and a moderator correction keeps Versi dikoreksi", () => {
  const html = renderWithHistory(record([claim([source()])]), [
    historyEntry({ version: 2, automatic: true }),
    historyEntry({ version: 3 }),
  ]);
  assert.equal(countOf(html, "Diperbarui otomatis"), 1);
  assert.equal(countOf(html, "Versi dikoreksi"), 1);
});

const eventAt = "2026-11-12T02:30:00.000Z";
const issuerAt = "2026-11-12T01:50:00.000Z";
const collectedAt = "2026-11-12T02:45:00.000Z";
const publishedAt = "2026-11-12T09:05:00.000Z";
const observedAt = "2026-11-12T03:10:00.000Z";

test("ST-F-05: the record page shows the event, issuer, collection and publication times, each from its own field", () => {
  const html = renderLive(record([claim([source({ published_at: issuerAt, observed_at: observedAt, retrieved_at: collectedAt })])]));

  assert.equal(countOf(html, `<dt>Waktu kejadian</dt><dd>${formatInstant(eventAt)}</dd>`), 1, "event time row");
  assert.equal(
    countOf(html, `Waktu sumber diterbitkan: ${formatInstant(issuerAt)} · waktu observasi: ${formatInstant(observedAt)}`),
    1,
    "issuer time on its own source line",
  );
  assert.equal(countOf(html, `<dt>Waktu pengambilan sumber</dt><dd>${formatInstant(collectedAt)}</dd>`), 1, "collection time row");
  assert.equal(
    countOf(html, `<dt>Versi publik diterbitkan</dt><dd><time dateTime="${publishedAt}">${formatInstant(publishedAt)}</time></dd>`),
    1,
    "publication time row",
  );
  assert.equal(new Set([eventAt, issuerAt, collectedAt, publishedAt].map(formatInstant)).size, 4, "four different instants, so a swapped field would show");
  assert.equal(countOf(html, "<dt>Dipublikasikan sumber</dt>"), 0,"the source time is not repeated as an event-level row when the event has a time");
});

test("ST-F-05: a null collection time reads Tidak disebutkan, and no other time fills that row", () => {
  const html = renderLive(record([claim([source({ published_at: issuerAt, retrieved_at: null })])]));
  assert.equal(countOf(html, "<dt>Waktu pengambilan sumber</dt><dd>Tidak disebutkan</dd>"), 1);
  assert.equal(countOf(html, `<dt>Waktu pengambilan sumber</dt><dd>${formatInstant(issuerAt)}</dd>`), 0, "the issuer time is not used");
  assert.equal(countOf(html, `<dt>Waktu pengambilan sumber</dt><dd>${formatInstant(publishedAt)}</dd>`), 0, "the publication time is not used");
  assert.equal(countOf(html, `<dt>Waktu kejadian</dt><dd>${formatInstant(eventAt)}</dd>`), 1, "the event time keeps its own row");
  assert.equal(countOf(html, `<dt>Versi publik diterbitkan</dt><dd><time dateTime="${publishedAt}">`), 1, "the publication time keeps its own row");
});

test("ST-F-05: a null source publish time reads Tidak disebutkan on its source line", () => {
  const html = renderLive(record([claim([source({ published_at: null, retrieved_at: null })])]));
  assert.equal(countOf(html, "Waktu sumber diterbitkan: Tidak disebutkan"), 1);
  assert.equal(countOf(html, `Waktu sumber diterbitkan: ${formatInstant(eventAt)}`), 0, "the event time does not fill the issuer line");
});

// GUI-03 (27 Nov 2026): a long record stays short. Three claims and three versions show; the rest wait in a disclosure.
test("GUI-03: claims past the third and versions past the third sit in closed disclosures, newest version first", () => {
  const claims = Array.from({ length: 7 }, (_, index) => ({ ...claim([source({ url: `https://news.example/${index}` })]), claim_id: `c-${index}`, text: `Klaim nomor ${index}.` }));
  const entries = Array.from({ length: 5 }, (_, index) => historyEntry({ version: index + 1, changed_at: `2026-11-1${index}T09:05:00.000Z`, summary: `Versi ${index + 1} terbit.` }));
  const html = renderWithHistory(record(claims), entries);
  assert.match(html, /<span class="count-chip">7 klaim<\/span>/u);
  assert.match(html, /<summary>Tampilkan 4 klaim lainnya<\/summary>/u);
  assert.match(html, /<summary>Lihat 2 versi sebelumnya<\/summary>/u);
  assert.doesNotMatch(html, /<details[^>]* open/u, "disclosures start closed");
  assert.ok(html.indexOf("Versi 5 terbit.") < html.indexOf("Versi 4 terbit."), "newest version first");
  assert.ok(html.indexOf("Versi 3 terbit.") < html.indexOf("Lihat 2 versi sebelumnya"), "three newest versions before the disclosure");
  for (let index = 0; index < 7; index += 1) assert.match(html, new RegExp(`Klaim nomor ${index}\\.`), "every claim is still in the page");
});

test("GUI-03: an unknown claim time is not repeated on every claim card", () => {
  const html = renderLive(record([{ ...claim([source()]), event_time: null as never }]));
  assert.doesNotMatch(html, /Waktu kejadian klaim/u);
});
