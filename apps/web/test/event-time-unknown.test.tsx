import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { EventView, PublicClaim } from "@waspada/worker/public-contracts";
import { AnchoredMapPopup } from "../src/MapPopup.js";
import { EventDetail } from "../src/EventDetail.js";
import { MapEventList } from "../src/MapEventList.js";
import { formatEventTime, formatInstant } from "../src/display.js";
import {
  eventTimeText,
  sourcePublishedAtText,
  UNKNOWN_EVENT_TIME_TEXT,
} from "../src/published-events.js";

/** F-14: an event without an event start reads as an unknown time. It never shows "Invalid Date" or its publish time as the event time. */
/** HOSTED-21 (owner decision 17 Nov 2026): the wording for an unknown event time is "Waktu kejadian tidak disebutkan". */

const publishedAt = "2026-11-13T02:00:00.000Z";
const sourceAt = "2026-11-12T03:00:00.000Z";

function event(overrides: Partial<EventView> = {}): EventView {
  return {
    event_id: "evt-f14-no-time",
    version: 1,
    title: "Pohon tumbang di Kebayoran Baru",
    summary: "Ringkasan laporan tanpa waktu kejadian.",
    category: "fires_infrastructure_hazards",
    tags: [],
    lifecycle: "ongoing",
    freshness: { status: "needs_update", evaluated_at: publishedAt, review_due_at: null, basis: "unknown" },
    event_time: { start: null, end: null, precision: "unknown" },
    validity: { valid_from: null, valid_until: null },
    scope: { places: ["Kebayoran Baru, Jakarta Selatan"], services: [], institutions: [], audiences: [] },
    claims: [],
    impacts: [],
    published_at: publishedAt,
    ...overrides,
  };
}

/** One claim whose sources carry the given source publish times (null when the source gives none). */
function claimWithSources(publishTimes: readonly (string | null)[]): PublicClaim {
  return {
    claim_id: "claim-1",
    text: "Pohon tumbang menutup jalur.",
    event_time: { start: null, end: null, precision: "unknown" },
    validity: { valid_from: null, valid_until: null },
    scope: { places: [], services: [], institutions: [], audiences: [] },
    qualifiers: [],
    evidence_label: "attributed_report",
    sources: publishTimes.map((published_at, index) => ({
      display_name: `Contoh Berita ${index + 1}`,
      url: `https://example.invalid/berita/${index + 1}`,
      published_at,
      observed_at: null,
      excerpt: null,
    })),
  };
}

function popup(overrides: Partial<EventView> = {}) {
  return renderToStaticMarkup(createElement(AnchoredMapPopup, {
    event: event(overrides),
    marker: null,
    titleId: "map-popup-title-f14",
    copyMessage: null,
    onClose: () => {},
    onViewDetail: () => {},
    onCopyLink: () => {},
    anchor: { left: 400, top: 300, placement: "above" },
  }));
}

test("F-14: an event with no start reads as an unknown event time", () => {
  assert.equal(formatEventTime(event()), "Waktu kejadian tidak diketahui");
  assert.equal(UNKNOWN_EVENT_TIME_TEXT, "Waktu kejadian tidak disebutkan");
  assert.equal(eventTimeText(event()), UNKNOWN_EVENT_TIME_TEXT);
});

test("F-14: a null start with a non-unknown precision still reads as unknown, not as Invalid Date", () => {
  const dated = event({ event_time: { start: null, end: null, precision: "exact" } });
  assert.equal(formatEventTime(dated), "Waktu kejadian tidak diketahui");
  assert.equal(eventTimeText(dated), UNKNOWN_EVENT_TIME_TEXT);
});

test("F-14: the popup time row of an event with no start shows the unknown wording, not the publish time", () => {
  const markup = popup();
  assert.match(markup, /<dt>Waktu kejadian<\/dt><dd>Waktu kejadian tidak disebutkan<\/dd>/u);
  assert.doesNotMatch(markup, /Invalid Date|Waktu tidak valid/u);
  assert.doesNotMatch(markup, /Dipublikasikan sumber/u, "no source time is shown when no source gives one");
});

test("HOSTED-21: the popup shows the source publish time on its own row, and the publication time stays separate", () => {
  const markup = popup({ claims: [claimWithSources([sourceAt])] });
  assert.match(markup, /<dt>Waktu kejadian<\/dt><dd>Waktu kejadian tidak disebutkan<\/dd>/u);
  assert.ok(markup.includes(`<dt>Dipublikasikan sumber</dt><dd>${formatInstant(sourceAt)}</dd>`), "source time row");
  assert.ok(markup.includes(`<dt>Diterbitkan</dt><dd>${formatInstant(publishedAt)}</dd>`), "publication time row is unchanged");
});

test("HOSTED-21: the source time is the earliest source publish time, never the publication time", () => {
  const later = "2026-11-12T09:00:00.000Z";
  const many = event({ claims: [claimWithSources([later, null]), claimWithSources([sourceAt])] });
  assert.equal(sourcePublishedAtText(many), formatInstant(sourceAt));
  assert.equal(sourcePublishedAtText(event()), null, "a publication time alone is not a source time");
  assert.equal(sourcePublishedAtText(event({ claims: [claimWithSources([null])] })), null);
  assert.notEqual(sourcePublishedAtText(many), formatInstant(publishedAt));
});

test("HOSTED-21: the event detail of an unknown-time event shows the unknown wording and the separate source time", () => {
  const unknown = { ...event({ claims: [claimWithSources([sourceAt])] }), geometries: [] };
  const markup = renderToStaticMarkup(createElement(EventDetail, {
    mode: "api-event",
    apiDetail: { eventId: unknown.event_id, status: "loaded", data: unknown },
    apiHistory: { eventId: unknown.event_id, status: "loaded", data: { data: [], page: { next_cursor: null, cursor_expires_at: null } } },
    onRetryDetail: () => {},
    onRetryHistory: () => {},
    context: null,
  }));
  assert.match(markup, /<dt>Waktu kejadian<\/dt><dd>Waktu kejadian tidak disebutkan<\/dd>/u);
  assert.ok(markup.includes(`<dt>Dipublikasikan sumber</dt><dd>${formatInstant(sourceAt)}</dd>`));
  assert.doesNotMatch(markup, /Invalid Date|Waktu tidak valid/u);
});

test("HOSTED-21 control: a dated event keeps its event time and shows no separate source row", () => {
  const dated = event({
    event_time: { start: "2026-11-12T08:30:00.000Z", end: null, precision: "exact" },
    claims: [claimWithSources([sourceAt])],
  });
  assert.notEqual(eventTimeText(dated), UNKNOWN_EVENT_TIME_TEXT);
  assert.match(formatEventTime(dated), /WIB/u);
  const list = renderToStaticMarkup(createElement(MapEventList, {
    headingId: "list-f14",
    status: "loaded",
    events: [dated],
    markers: new Map(),
    selectedId: null,
    filtersActive: false,
    errorMessage: null,
    onSelect: () => {},
    onReset: () => {},
    onRetry: () => {},
  }));
  assert.match(list, /Waktu kejadian: /u);
  assert.doesNotMatch(list, /Dipublikasikan sumber/u);
});

test("HOSTED-21: the list card of an unknown-time event reads the unknown wording and its source time", () => {
  const list = renderToStaticMarkup(createElement(MapEventList, {
    headingId: "list-f14-unknown",
    status: "loaded",
    events: [event({ claims: [claimWithSources([sourceAt])] })],
    markers: new Map(),
    selectedId: null,
    filtersActive: false,
    errorMessage: null,
    onSelect: () => {},
    onReset: () => {},
    onRetry: () => {},
  }));
  assert.ok(list.includes(`<span class="map-card__meta">${UNKNOWN_EVENT_TIME_TEXT}</span>`), "unknown wording without the dated prefix");
  assert.ok(list.includes(`Dipublikasikan sumber: ${formatInstant(sourceAt)}`), "source time on its own line");
  assert.doesNotMatch(list, /Waktu kejadian: Waktu kejadian/u);
});

test("F-14 control: an event with a start still shows its event time", () => {
  const dated = event({ event_time: { start: "2026-11-12T08:30:00.000Z", end: null, precision: "exact" } });
  assert.notEqual(eventTimeText(dated), UNKNOWN_EVENT_TIME_TEXT);
  assert.match(formatEventTime(dated), /WIB/u);
});
