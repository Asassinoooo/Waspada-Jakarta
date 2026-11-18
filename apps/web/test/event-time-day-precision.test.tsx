import assert from "node:assert/strict";
import { createElement } from "react";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { BriefingResponse, EventDetail as EventDetailRecord, PublicClaim, PublicContext } from "@waspada/worker/public-contracts";
import { BriefingResultsView } from "../src/BriefingResults.js";
import { freshnessLabel, formatEventTime, eventTimeText as displayEventTimeText, UNKNOWN_EVENT_TIME_TEXT as displayUnknownText } from "../src/display.js";
import { EventDetail } from "../src/EventDetail.js";
import { AnchoredMapPopup } from "../src/MapPopup.js";
import { MapEventList } from "../src/MapEventList.js";
import {
  countIndependentSources,
  eventTimeText,
  freshnessText,
  UNKNOWN_EVENT_TIME_TEXT,
} from "../src/published-events.js";

// Owner decisions 18 Nov 2026. HOSTED-27 (web part):
// F-11 one wording for an unknown event time; F-10 "expired" reads "Lewat masa berlaku sumber";
// F-09 the detail page counts media like the card; a date-only event time never shows an hour.
// Expected strings are the real id-ID output: Intl writes the time with a dot ("07.00").

type Source = PublicClaim["sources"][number];

const liveContext: PublicContext = {
  dataset_mode: "live",
  dataset_label: "live",
  generated_at: "2026-11-12T08:00:00.000Z",
  sources: [],
};

function countOf(html: string, text: string): number {
  return html.split(text).length - 1;
}

function source(displayName: string, excerpt: string | null = null): Source {
  return {
    display_name: displayName,
    url: `https://news.example/${displayName.toLowerCase().replaceAll(" ", "-")}/cawang`,
    published_at: "2026-11-12T03:00:00.000Z",
    observed_at: "2026-11-12T03:10:00.000Z",
    excerpt,
  };
}

function claim(claimId: string, sources: Source[], text = "Genangan menutup jalur Cawang."): PublicClaim {
  return {
    claim_id: claimId,
    text,
    event_time: { start: null, end: null, precision: "unknown" },
    validity: { valid_from: null, valid_until: null },
    scope: { places: [], services: [], institutions: [], audiences: [] },
    qualifiers: [],
    evidence_label: "attributed_report",
    sources,
  };
}

/** A published event with a date-only event time, unless the test overrides it. */
function detail(overrides: Partial<EventDetailRecord> = {}): EventDetailRecord {
  return {
    event_id: "evt-day-precision-1",
    version: 1,
    title: "Genangan di Cawang",
    summary: "Ringkasan singkat laporan.",
    category: "disasters_weather",
    tags: [],
    lifecycle: "ongoing",
    freshness: { status: "current", evaluated_at: "2026-11-12T02:00:00.000Z", review_due_at: null, basis: "fast_observation_review" },
    event_time: { start: "2026-11-17", end: null, precision: "date" },
    validity: { valid_from: null, valid_until: null },
    scope: { places: ["Cawang, Jakarta Timur"], services: [], institutions: [], audiences: [] },
    claims: [],
    impacts: [],
    published_at: "2026-11-12T02:05:00.000Z",
    geometries: [],
    ...overrides,
  };
}

function renderDetail(data: EventDetailRecord): string {
  return renderToStaticMarkup(createElement(EventDetail, {
    mode: "api-event",
    apiDetail: { eventId: data.event_id, status: "loaded", data } as never,
    apiHistory: { eventId: data.event_id, status: "loaded", data: { data: [], page: { next_cursor: null, cursor_expires_at: null } } } as never,
    context: liveContext,
    variant: "sheet",
  }));
}

function renderPopup(data: EventDetailRecord): string {
  return renderToStaticMarkup(createElement(AnchoredMapPopup, {
    event: data,
    marker: null,
    titleId: "map-popup-title-day-precision",
    copyMessage: null,
    onClose: () => {},
    onViewDetail: () => {},
    onCopyLink: () => {},
    anchor: { left: 400, top: 300, placement: "above" },
  }));
}

function renderList(data: EventDetailRecord): string {
  return renderToStaticMarkup(createElement(MapEventList, {
    headingId: "list-day-precision",
    status: "loaded",
    events: [data],
    markers: new Map(),
    selectedId: null,
    filtersActive: false,
    errorMessage: null,
    onSelect: () => {},
    onReset: () => {},
    onRetry: () => {},
  }));
}

test("F-11 day precision: the one event-time helper gives exact, date, range and unknown wording", () => {
  assert.equal(eventTimeText({ start: "2026-11-17T00:00:00.000Z", end: null, precision: "exact" }), "17 Nov 2026, 07.00 WIB");
  assert.equal(eventTimeText({ start: "2026-11-17", end: null, precision: "date" }), "17 Nov 2026, jam tidak disebutkan");
  assert.equal(
    eventTimeText({ start: "2026-11-17T01:00:00.000Z", end: "2026-11-17T03:00:00.000Z", precision: "range" }),
    "17 Nov 2026, 08.00 WIB – 17 Nov 2026, 10.00 WIB",
  );
  assert.equal(eventTimeText({ start: null, end: null, precision: "unknown" }), UNKNOWN_EVENT_TIME_TEXT);
  assert.equal(eventTimeText({ start: "2026-11-17", end: null, precision: "unknown" }), UNKNOWN_EVENT_TIME_TEXT, "unknown precision wins over a start");
  assert.equal(UNKNOWN_EVENT_TIME_TEXT, "Waktu kejadian tidak disebutkan");
});

test("F-11 day precision: published-events re-exports the same helper and wording as display.ts", () => {
  assert.equal(eventTimeText, displayEventTimeText);
  assert.equal(UNKNOWN_EVENT_TIME_TEXT, displayUnknownText);
  assert.equal(formatEventTime(detail()), "17 Nov 2026, jam tidak disebutkan");
});

test("F-11 day precision: a calendar day is read as its own Jakarta day and never moves", () => {
  assert.equal(eventTimeText({ start: "2026-01-01", end: null, precision: "date" }), "1 Jan 2026, jam tidak disebutkan");
  assert.equal(eventTimeText({ start: "2026-12-31", end: null, precision: "date" }), "31 Des 2026, jam tidak disebutkan");
  assert.equal(
    eventTimeText({ start: "2026-11-17", end: "2026-11-18", precision: "date" }),
    "17 Nov 2026 – 18 Nov 2026, jam tidak disebutkan",
  );
});

test("F-11 day precision: a date-only event shows the day with jam tidak disebutkan in the detail, never an hour", () => {
  const html = renderDetail(detail());
  assert.match(html, /<dt>Waktu kejadian<\/dt><dd>17 Nov 2026, jam tidak disebutkan<\/dd>/u);
  assert.doesNotMatch(html, /07[.:]00/u, "no invented hour");
  assert.doesNotMatch(html, /tanggal saja|waktu tepat|Waktu kejadian tidak diketahui/u);
});

test("F-11 day precision: the card, the map popup and the detail show the same date-only text", () => {
  const data = detail();
  for (const markup of [renderPopup(data), renderList(data), renderDetail(data)]) {
    assert.ok(markup.includes("17 Nov 2026, jam tidak disebutkan"), "the date-only wording");
    assert.doesNotMatch(markup, /07[.:]00/u);
  }
  assert.ok(renderPopup(data).includes("<dt>Waktu kejadian</dt><dd>17 Nov 2026, jam tidak disebutkan</dd>"));
  assert.ok(renderList(data).includes("Waktu kejadian: 17 Nov 2026, jam tidak disebutkan"));
});

test("F-11 day precision: the briefing result shows the date-only wording too", () => {
  const response: BriefingResponse = {
    items: [{ event: detail(), relevance_reasons: ["Cocok dengan lokasi yang Anda pilih."] }],
    generated_at: "2026-11-12T08:00:00.000Z",
  };
  const markup = renderToStaticMarkup(createElement(BriefingResultsView, {
    context: liveContext,
    interests: { places: ["Cawang"], services: [], institutions: [], audiences: [], categories: [] },
    state: { status: "loaded", data: response },
    onRequest: () => {},
  }));
  assert.match(markup, /<dt>Waktu kejadian<\/dt><dd>17 Nov 2026, jam tidak disebutkan<\/dd>/u);
  assert.doesNotMatch(markup, /07[.:]00/u);
});

test("F-11 day precision: an unknown time reads the one wording in the detail", () => {
  const html = renderDetail(detail({ event_time: { start: null, end: null, precision: "unknown" } }));
  assert.match(html, /<dt>Waktu kejadian<\/dt><dd>Waktu kejadian tidak disebutkan<\/dd>/u);
  assert.doesNotMatch(html, /Waktu kejadian tidak diketahui/u);
});

test("F-10: an expired freshness reads Lewat masa berlaku sumber, and the other states keep their wording", () => {
  assert.equal(freshnessLabel("expired"), "Lewat masa berlaku sumber");
  assert.equal(freshnessText("expired"), "Lewat masa berlaku sumber");
  assert.equal(freshnessLabel("needs_update"), "Perlu diperbarui");
  assert.equal(freshnessText("needs_update"), "Perlu diperbarui");
  assert.equal(freshnessLabel("current", { fixtureWording: false }), "Dalam batas tinjau saat evaluasi");
  assert.equal(freshnessText("current"), "Dalam batas tinjau");
});

test("F-10: the briefing result reads the expired wording and never Batas tinjau lewat", () => {
  const expired = detail({ freshness: { status: "expired", evaluated_at: "2026-11-12T02:00:00.000Z", review_due_at: null, basis: "source_validity" } });
  const response: BriefingResponse = {
    items: [{ event: expired, relevance_reasons: ["Cocok dengan lokasi yang Anda pilih."] }],
    generated_at: "2026-11-12T08:00:00.000Z",
  };
  const markup = renderToStaticMarkup(createElement(BriefingResultsView, {
    context: liveContext,
    interests: { places: ["Cawang"], services: [], institutions: [], audiences: [], categories: [] },
    state: { status: "loaded", data: response },
    onRequest: () => {},
  }));
  assert.match(markup, /<dt>Kesegaran<\/dt><dd>Lewat masa berlaku sumber<\/dd>/u);
  assert.doesNotMatch(markup, /Batas tinjau lewat|Lewat batas tinjau/u);
});

test("excerpts: the first excerpt shows and the rest sit in a native disclosure under the same source", () => {
  const html = renderDetail(detail({
    claims: [claim("claim-excerpts", [
      source("DETIK UTAMA", "Kutipan pertama."),
      source("DETIK UTAMA", "Kutipan kedua."),
      source("DETIK UTAMA", "Kutipan ketiga."),
    ])],
  }));
  assert.equal(countOf(html, "<h3>DETIK UTAMA</h3>"), 1, "one source line");
  assert.equal(countOf(html, "<details>"), 1, "one disclosure for the extra quotes");
  assert.ok(html.includes("<details><summary>Lihat 2 kutipan lainnya</summary>"), "the summary counts the remaining quotes");
  assert.ok(html.includes('<blockquote class="source-excerpt">Kutipan pertama.</blockquote>'));
  assert.ok(html.includes('<blockquote class="source-excerpt">Kutipan kedua.</blockquote>'));
  assert.ok(html.includes('<blockquote class="source-excerpt">Kutipan ketiga.</blockquote>'));
  assert.ok(html.indexOf("Kutipan pertama.") < html.indexOf("<details>"), "the first quote is outside the disclosure");
  assert.ok(html.indexOf("<details>") < html.indexOf("Kutipan kedua."), "the second quote is inside the disclosure");
});

test("excerpts: a single excerpt shows no disclosure", () => {
  const html = renderDetail(detail({
    claims: [claim("claim-one-excerpt", [source("ANTARA", "Satu kutipan saja.")])],
  }));
  assert.ok(html.includes('<blockquote class="source-excerpt">Satu kutipan saja.</blockquote>'));
  assert.doesNotMatch(html, /<details>/u);
  assert.doesNotMatch(html, /kutipan lainnya/u);
});

test("F-09: the detail counts media like the card, and a syndicated copy is labelled, not counted", () => {
  const copies = detail({
    claims: [
      claim("claim-detik", [source("DETIK UTAMA")]),
      claim("claim-antara", [source("ANTARA")]),
    ],
    publication: { mode: "agent_auto", source_count: 2 },
  });
  assert.deepEqual(countIndependentSources(copies), { outlets: 1, copies: 1 });
  const html = renderDetail(copies);
  assert.match(html, /<dt>Cara penerbitan<\/dt><dd>Diringkas otomatis oleh agen AI · dilaporkan oleh 1 media \(1 salinan\)<\/dd>/u);
  assert.ok(renderList(copies).includes("1 sumber (1 salinan)"), "the card shows the same count");
});

test("F-09: two outlets with different reports are two media on the detail page, with no copy note", () => {
  const distinct = detail({
    claims: [
      claim("claim-detik-2", [source("DETIK UTAMA")], "Genangan menutup jalur Cawang."),
      claim("claim-antara-2", [source("ANTARA")], "Banjir merendam Jalan DI Panjaitan."),
    ],
    publication: { mode: "agent_auto", source_count: 2 },
  });
  const html = renderDetail(distinct);
  assert.match(html, /<dt>Cara penerbitan<\/dt><dd>Diringkas otomatis oleh agen AI · dilaporkan oleh 2 media<\/dd>/u);
  assert.doesNotMatch(html, /salinan/u);
});
