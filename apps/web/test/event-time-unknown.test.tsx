import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { EventView } from "@waspada/worker/public-contracts";
import { AnchoredMapPopup } from "../src/MapPopup.js";
import { formatEventTime } from "../src/display.js";
import { eventTimeText } from "../src/published-events.js";

/** F-14: an event without an event start reads as an unknown time. It never shows "Invalid Date" or its publish time as the event time. */

const publishedAt = "2026-11-13T02:00:00.000Z";

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

test("F-14: an event with no start reads as an unknown event time", () => {
  assert.equal(formatEventTime(event()), "Waktu kejadian tidak diketahui");
  assert.equal(eventTimeText(event()), "Tidak diketahui");
});

test("F-14: a null start with a non-unknown precision still reads as unknown, not as Invalid Date", () => {
  const dated = event({ event_time: { start: null, end: null, precision: "exact" } });
  assert.equal(formatEventTime(dated), "Waktu kejadian tidak diketahui");
  assert.equal(eventTimeText(dated), "Tidak diketahui");
});

test("F-14: the popup time row of an event with no start shows an unknown time, not the publish time", () => {
  const markup = renderToStaticMarkup(createElement(AnchoredMapPopup, {
    event: event(),
    marker: null,
    titleId: "map-popup-title-f14",
    copyMessage: null,
    onClose: () => {},
    onViewDetail: () => {},
    onCopyLink: () => {},
    anchor: { left: 400, top: 300, placement: "above" },
  }));
  assert.match(markup, /<dt>Waktu kejadian<\/dt><dd>Tidak diketahui<\/dd>/u);
  assert.doesNotMatch(markup, /Invalid Date|Waktu tidak valid/u);
});

test("F-14 control: an event with a start still shows its event time", () => {
  const dated = event({ event_time: { start: "2026-11-12T08:30:00.000Z", end: null, precision: "exact" } });
  assert.notEqual(eventTimeText(dated), "Tidak diketahui");
  assert.match(formatEventTime(dated), /WIB/u);
});
