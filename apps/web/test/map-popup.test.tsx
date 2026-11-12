import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { EventView } from "@waspada/worker/public-contracts";
import { AnchoredMapPopup, PeekMapPopup, POPUP_WIDTH_PX, popupAnchor, unmappedPopupAnchor, type MapPopupProps } from "../src/MapPopup.js";
import { copyText, eventShareUrl } from "../src/map-links.js";

/** UI-V2-B map popup: time rows stay separate, missing values read "Tidak diketahui", and nothing is drawn as a radius. */

function event(overrides: Record<string, unknown> = {}): EventView {
  return {
    event_id: "evt-popup",
    version: 2,
    title: "Genangan di Cawang",
    summary: "Ringkasan.",
    category: "disasters_weather",
    tags: [],
    lifecycle: "ongoing",
    freshness: { status: "needs_update", evaluated_at: "2026-11-12T09:00:00.000Z", review_due_at: "2026-11-11T09:00:00.000Z", basis: "fast_observation_review" },
    event_time: { start: "2026-11-12T08:00:00.000Z", end: null, precision: "exact" },
    validity: { valid_from: null, valid_until: null },
    scope: { places: ["Cawang, Jakarta Timur"], services: [], institutions: [], audiences: [] },
    claims: [
      {
        claim_id: "c1",
        text: "Genangan 50 cm",
        event_time: { start: null, end: null, precision: "exact" },
        validity: { valid_from: null, valid_until: null },
        scope: { places: [], services: [], institutions: [], audiences: [] },
        qualifiers: [],
        evidence_label: "attributed_report",
        sources: [{ display_name: "Detik News", url: "https://news.example/a", published_at: null, observed_at: null, excerpt: null }],
      },
      {
        claim_id: "c2",
        text: "Banjir merendam jalan",
        event_time: { start: null, end: null, precision: "exact" },
        validity: { valid_from: null, valid_until: null },
        scope: { places: [], services: [], institutions: [], audiences: [] },
        qualifiers: [],
        evidence_label: "attributed_report",
        sources: [{ display_name: "Antara News", url: "https://news.example/b", published_at: null, observed_at: null, excerpt: null }],
      },
    ],
    impacts: [],
    published_at: "2026-11-12T09:05:00.000Z",
    ...overrides,
  } as unknown as EventView;
}

function props(overrides: Partial<MapPopupProps> = {}): MapPopupProps {
  return {
    event: event(),
    marker: { coordinate: [106.8786, -6.2549], role: "incident_scene" },
    titleId: "map-popup-title",
    copyMessage: null,
    onClose: () => {},
    onViewDetail: () => {},
    onCopyLink: () => {},
    ...overrides,
  };
}

function anchored(overrides: Partial<MapPopupProps> = {}) {
  return renderToStaticMarkup(createElement(AnchoredMapPopup, {
    ...props(overrides),
    anchor: { left: 400, top: 300, placement: "above" },
  }));
}

test("the popup shows event time and publication time as separate rows", () => {
  const html = anchored();
  assert.match(html, /<dt>Waktu kejadian<\/dt><dd>[^<]+<\/dd>/);
  assert.match(html, /<dt>Diterbitkan<\/dt><dd>[^<]+<\/dd>/);
  assert.ok(html.indexOf("Waktu kejadian") < html.indexOf("Diterbitkan"), "event time comes before publication time");
});

test("missing times read Tidak diketahui and are never filled in", () => {
  const html = anchored({ event: event({ event_time: { start: null, end: null, precision: "unknown" }, published_at: "" }) });
  assert.match(html, /<dt>Waktu kejadian<\/dt><dd>Tidak diketahui<\/dd>/);
  assert.match(html, /<dt>Diterbitkan<\/dt><dd>Tidak diketahui<\/dd>/);
});

test("the popup states the number of distinct named sources, not a verification", () => {
  const html = anchored();
  assert.match(html, /<strong>2 sumber<\/strong>/);
  assert.match(html, /Jumlah sumber bukan bukti kebenaran\./);
  const none = anchored({ event: event({ claims: [] }) });
  assert.match(none, /Sumber tidak tercatat/);
});

test("the popup never says verified or safe", () => {
  for (const html of [
    anchored(),
    anchored({ event: event({ freshness: { status: "expired", evaluated_at: "2026-11-12T09:00:00.000Z", review_due_at: null, basis: "source_validity" } }) }),
    anchored({ marker: null }),
  ]) {
    assert.doesNotMatch(html, /terverifikasi|terkonfirmasi/iu);
    assert.doesNotMatch(html, /\baman\b/iu);
  }
});

test("the popup offers one primary action, Lihat detail, and a quiet copy-link action", () => {
  const html = anchored();
  assert.match(html, /<button type="button" class="button button--primary"[^>]*>Lihat detail<\/button>/);
  assert.match(html, /<button type="button" class="button button--quiet"[^>]*>Salin tautan<\/button>/);
  assert.equal((html.match(/button--primary/g) ?? []).length, 1);
});

test("the popup draws no radius and no circle", () => {
  const html = anchored();
  assert.doesNotMatch(html, /<circle/);
  assert.doesNotMatch(html, /radius/iu);
  const peek = renderToStaticMarkup(createElement(PeekMapPopup, props()));
  assert.doesNotMatch(peek, /<circle/);
  assert.doesNotMatch(peek, /radius/iu);
});

test("a marker from an approximate place says so, and an unmapped event says it has no location", () => {
  assert.match(anchored({ marker: { coordinate: [106.8, -6.2], role: "approximate_place" } }), /Titik lokasi perkiraan dari sumber\./);
  assert.match(anchored({ marker: null }), /Lokasi belum dipetakan dari sumber\./);
});

test("the phone popup is a peek sheet that names the dialog and keeps the same actions", () => {
  const peek = renderToStaticMarkup(createElement(PeekMapPopup, props()));
  assert.match(peek, /role="dialog"/);
  assert.match(peek, /map-popup--peek/);
  assert.match(peek, />Lihat detail</);
});

test("the anchored popup stays inside the map and opens downward near the top edge", () => {
  const high = popupAnchor({ x: 320, y: 500 }, 640, 480);
  assert.equal(high.placement, "above");
  const top = popupAnchor({ x: 320, y: 40 }, 640, 480);
  assert.equal(top.placement, "below");
  const leftEdge = popupAnchor({ x: 2, y: 200 }, 640, 480);
  assert.ok(leftEdge.left >= POPUP_WIDTH_PX / 2, "the popup is not cut off at the left edge");
  const rightEdge = popupAnchor({ x: 900, y: 200 }, 640, 480);
  assert.ok(rightEdge.left <= 640 - POPUP_WIDTH_PX / 2, "the popup is not cut off at the right edge");
  assert.deepEqual(unmappedPopupAnchor(640, 480), { left: 320, top: 472, placement: "above" });
});

test("the copied link is a map link to the event, and it encodes the id", () => {
  assert.equal(
    eventShareUrl("evt/1", "https://waspada.example/app/?x=1#jelajah"),
    "https://waspada.example/app/?x=1#peta?event=evt%2F1",
  );
});

test("copy reports failure instead of throwing when the clipboard is not available", async () => {
  assert.equal(await copyText("tautan"), false);
});
