import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { EventView, PublicFeatureCollection } from "@waspada/worker/public-contracts";
import { routeFromHash } from "../src/App.js";
import { MapEventList, EMPTY_LIST_TITLE } from "../src/MapEventList.js";
import { MapFilterSheet, DEFAULT_MAP_FILTER_VALUE, FACILITY_NOTE } from "../src/MapFilterSheet.js";
import { MapHome } from "../src/MapHome.js";
import { buildEventHash, parseEventIdFromHash } from "../src/map-links.js";
import {
  countActiveFilters,
  deepLinkTarget,
  DEFAULT_PUBLISHED_FILTERS,
  filterPublishedEvents,
  markersFromGeoJSON,
  type PublishedFilters,
} from "../src/published-events.js";

/** UI-V2-B map home at #peta: toolbar, list states, filters, deep links and the public-only data rules. */

const NOW = Date.parse("2026-11-12T10:00:00.000Z");

function event(id: string, overrides: Record<string, unknown> = {}): EventView {
  return {
    event_id: id,
    version: 1,
    title: `Laporan ${id}`,
    summary: "Ringkasan singkat laporan.",
    category: "disasters_weather",
    tags: [],
    lifecycle: "ongoing",
    freshness: { status: "current", evaluated_at: "2026-11-12T09:00:00.000Z", review_due_at: null, basis: "fast_observation_review" },
    event_time: { start: "2026-11-12T08:00:00.000Z", end: null, precision: "exact" },
    validity: { valid_from: null, valid_until: null },
    scope: { places: ["Cawang, Jakarta Timur"], services: [], institutions: [], audiences: [] },
    claims: [
      {
        claim_id: `${id}-claim`,
        text: "Genangan di Cawang",
        event_time: { start: null, end: null, precision: "exact" },
        validity: { valid_from: null, valid_until: null },
        scope: { places: [], services: [], institutions: [], audiences: [] },
        qualifiers: [],
        evidence_label: "attributed_report",
        sources: [{ display_name: "Detik News", url: "https://news.example/a", published_at: null, observed_at: null, excerpt: null }],
      },
    ],
    impacts: [],
    published_at: "2026-11-12T09:05:00.000Z",
    ...overrides,
  } as unknown as EventView;
}

const markers = new Map([
  ["evt-1", { coordinate: [106.8786, -6.2549] as const, role: "incident_scene" }],
]);

test("#peta and the legacy #jelajah deep links keep the event id, and plain hashes stay on the map", () => {
  assert.deepEqual(routeFromHash("#peta?event=evt-1"), { screen: "discover", eventId: "evt-1" });
  assert.deepEqual(routeFromHash("#jelajah?event=evt-2"), { screen: "discover", eventId: "evt-2" });
  assert.deepEqual(routeFromHash("#peta"), { screen: "discover" });
  assert.deepEqual(routeFromHash("#jelajah?event="), { screen: "discover" }, "an empty id is ignored");
  assert.deepEqual(routeFromHash("#tidak-dikenal"), { screen: "discover" });
});

test("event ids survive a round trip through the map link", () => {
  assert.equal(parseEventIdFromHash("#peta?event=a%2Fb"), "a/b");
  assert.equal(buildEventHash("a/b"), "#peta?event=a%2Fb");
  assert.equal(parseEventIdFromHash(buildEventHash("evt 1")), "evt 1");
  assert.equal(parseEventIdFromHash("#peta"), null);
});

test("deep link resolves an event only when it is in the published list", () => {
  const events = [event("evt-1")];
  const target = deepLinkTarget(events, markers, "evt-1");
  assert.equal(target?.event.event_id, "evt-1");
  assert.deepEqual(target?.marker?.coordinate, [106.8786, -6.2549]);
  assert.equal(deepLinkTarget(events, markers, "unpublished"), null);
});

test("the toolbar and zoom group show at most five controls on the first screen", () => {
  const html = renderToStaticMarkup(createElement(MapHome, { initialEvents: [event("evt-1")], initialMarkers: markers }));
  const toolbar = html.match(/class="toolbar map-home__toolbar">([\s\S]*?)<\/div>/)?.[1] ?? "";
  const zoom = html.match(/class="map-zoom-controls"[^>]*>([\s\S]*?)<\/div>/)?.[1] ?? "";
  const controls = (toolbar.match(/<(button|input)\b/g) ?? []).length + (zoom.match(/<(button|input)\b/g) ?? []).length;
  assert.ok(controls >= 4 && controls <= 5, `found ${controls} controls`);
  assert.doesNotMatch(zoom, /Pusatkan/, "recentre is shown only once the view has moved");
});

test("the toolbar buttons keep their names on phones, where their text is hidden", () => {
  const html = renderToStaticMarkup(createElement(MapHome, { initialEvents: [event("evt-1")], initialMarkers: markers }));
  assert.match(html, /aria-label="Filter"/);
  assert.match(html, /aria-label="Daftar laporan, 1"/);
  assert.match(html, /aria-label="Cari laporan"/);
});

test("the empty list says the exact message, and never claims an area is safe", () => {
  const html = renderToStaticMarkup(createElement(MapHome, { initialEvents: [] }));
  assert.ok(html.includes(EMPTY_LIST_TITLE));
  assert.equal(EMPTY_LIST_TITLE, "Belum ada laporan terbit di area ini dalam rentang waktu ini.");
  assert.doesNotMatch(html, /\baman\b/iu);
  assert.doesNotMatch(html, /Reset filter/, "no reset button without an active filter");
});

test("an empty filtered list offers Reset filter", () => {
  const html = renderToStaticMarkup(createElement(MapEventList, {
    headingId: "t",
    status: "loaded",
    events: [],
    markers: new Map(),
    selectedId: null,
    filtersActive: true,
    errorMessage: null,
    onSelect: () => {},
    onReset: () => {},
    onRetry: () => {},
  }));
  assert.match(html, /Reset filter/);
  assert.ok(html.includes(EMPTY_LIST_TITLE));
});

test("a failed list load shows an inline error with a retry", () => {
  const html = renderToStaticMarkup(createElement(MapEventList, {
    headingId: "t",
    status: "unavailable",
    events: [],
    markers: new Map(),
    selectedId: null,
    filtersActive: false,
    errorMessage: "Gagal memuat laporan publik: Public API request failed with status 503",
    onSelect: () => {},
    onReset: () => {},
    onRetry: () => {},
  }));
  assert.match(html, /role="alert"/);
  assert.match(html, /Gagal memuat laporan publik: Public API request failed with status 503/);
  assert.match(html, />Coba lagi</);
});

test("a loading list shows skeleton cards with a status message", () => {
  const html = renderToStaticMarkup(createElement(MapEventList, {
    headingId: "t",
    status: "loading",
    events: [],
    markers: new Map(),
    selectedId: null,
    filtersActive: false,
    errorMessage: null,
    onSelect: () => {},
    onReset: () => {},
    onRetry: () => {},
  }));
  assert.match(html, /Memuat laporan terbit…/);
  assert.match(html, /skeleton/);
});

test("each card names its category, event time and source count, and buttons are keyboard reachable", () => {
  const html = renderToStaticMarkup(createElement(MapHome, { initialEvents: [event("evt-1")], initialMarkers: markers }));
  assert.match(html, /Waktu kejadian: /);
  assert.match(html, /1 sumber/);
  assert.match(html, /<button type="button" class="map-marker[^"]*" style="[^"]*" aria-label="Bencana dan cuaca: Laporan evt-1"/);
});

test("filters reduce the list by category, time range, source and search, and combine", () => {
  const events = [
    event("recent", { category: "disasters_weather", event_time: { start: "2026-11-12T08:00:00.000Z", end: null, precision: "exact" } }),
    event("old", {
      category: "disasters_weather",
      event_time: { start: "2026-10-01T08:00:00.000Z", end: null, precision: "exact" },
      claims: [{ ...(event("old").claims[0] as object), evidence_label: "issuer_notice" }],
    }),
    event("unknown-time", {
      category: "transport_road_incidents",
      title: "Kemacetan Gatot Subroto",
      event_time: { start: null, end: null, precision: "unknown" },
    }),
  ];
  const run = (filters: Partial<PublishedFilters>, query = "") =>
    filterPublishedEvents(events, query, { ...DEFAULT_PUBLISHED_FILTERS, ...filters }, NOW).map((item) => item.event_id);

  assert.deepEqual(run({}), ["recent", "old", "unknown-time"], "the default keeps every event, including unknown times");
  assert.deepEqual(run({ category: "transport_road_incidents" }), ["unknown-time"]);
  assert.deepEqual(run({ timeRange: "24h" }), ["recent"], "a time range never includes events with an unknown time");
  assert.deepEqual(run({ timeRange: "30d" }), ["recent"], "an event 42 days old falls outside 30 days");
  assert.deepEqual(run({ source: "issuer_notice" }), ["old"]);
  assert.deepEqual(run({}, "gatot"), ["unknown-time"]);
  assert.deepEqual(run({ category: "disasters_weather", timeRange: "24h" }, "laporan"), ["recent"], "filters combine with AND");
});

test("active filter count counts each non-default group and the facility layer", () => {
  assert.equal(countActiveFilters(DEFAULT_PUBLISHED_FILTERS, false), 0);
  assert.equal(countActiveFilters({ category: "disasters_weather", timeRange: "7d", source: "all" }, true), 3);
});

test("the filter sheet explains the OSM facility limit and offers Terapkan and Reset", () => {
  const html = renderToStaticMarkup(createElement(MapFilterSheet, {
    applied: DEFAULT_MAP_FILTER_VALUE,
    onApply: () => {},
    onClose: () => {},
  }));
  assert.ok(html.includes(FACILITY_NOTE));
  assert.equal(FACILITY_NOTE, "Lokasi fasilitas dari OSM; tidak menunjukkan kesiapan layanan.");
  assert.match(html, />Terapkan</);
  assert.match(html, />Reset</);
  assert.match(html, /Semua waktu/);
  assert.match(html, /role="dialog"/);
});

test("markers come only from API geometry: the incident point wins and polygons are never turned into circles", () => {
  const collection = {
    type: "FeatureCollection",
    features: [
      { type: "Feature", id: "a", geometry: { type: "Point", coordinates: [106.8, -6.2] }, properties: { event_id: "evt-a", version: 1, title: "A", category: "disasters_weather", lifecycle: "ongoing", freshness: "current", geometry_role: "facility" } },
      { type: "Feature", id: "b", geometry: { type: "Point", coordinates: [106.9, -6.3] }, properties: { event_id: "evt-a", version: 1, title: "A", category: "disasters_weather", lifecycle: "ongoing", freshness: "current", geometry_role: "incident_scene" } },
      { type: "Feature", id: "c", geometry: { type: "Polygon", coordinates: [[[106.7, -6.1], [106.8, -6.1], [106.8, -6.2], [106.7, -6.1]]] }, properties: { event_id: "evt-poly", version: 1, title: "P", category: "disasters_weather", lifecycle: "ongoing", freshness: "current", geometry_role: "affected_area" } },
      { type: "Feature", id: "d", geometry: { type: "Point", coordinates: [Number.NaN, -6.2] }, properties: { event_id: "evt-nan", version: 1, title: "N", category: "disasters_weather", lifecycle: "ongoing", freshness: "current", geometry_role: "incident_scene" } },
    ],
  } as unknown as PublicFeatureCollection;
  const result = markersFromGeoJSON(collection);
  assert.deepEqual(result.get("evt-a")?.coordinate, [106.9, -6.3]);
  assert.equal(result.get("evt-a")?.role, "incident_scene");
  assert.equal(result.has("evt-poly"), false, "a polygon-only event gets no invented point");
  assert.equal(result.has("evt-nan"), false);
});

test("the map home stylesheet uses design tokens only, with no hex colour literal", () => {
  const css = readFileSync(new URL("../src/map-home.css", import.meta.url), "utf8");
  assert.doesNotMatch(css, /#[0-9a-fA-F]{3,8}\b/u);
  assert.match(css, /\.app-shell--map\s*\{[^}]*100dvh/su, "the map screen is one viewport tall, so the page does not scroll");
});

test("the phone list and popup use a bottom sheet, and the desktop list is a left panel from 900px", () => {
  const source = readFileSync(new URL("../src/MapHome.tsx", import.meta.url), "utf8");
  assert.match(source, /"\(min-width: 900px\)"/);
  assert.match(source, /className="map-home__panel"/);
  assert.match(source, /className="map-list-sheet"/);
});

test("the filters type stays a value type, so a default is never mutated", () => {
  const before = JSON.stringify(DEFAULT_PUBLISHED_FILTERS);
  filterPublishedEvents([event("x")], "", { ...DEFAULT_PUBLISHED_FILTERS, timeRange: "24h" }, NOW);
  assert.equal(JSON.stringify(DEFAULT_PUBLISHED_FILTERS), before);
});

test("the map canvas loads the tile stylesheet and places whole-pixel tiles, not the legacy grid canvas", () => {
  const html = renderToStaticMarkup(createElement(MapHome, { initialEvents: [event("evt-1")], initialMarkers: markers }));
  assert.match(html, /class="interactive-incident-map event-map-canvas"/u);
  assert.doesNotMatch(html, /class="(?:[^"]*\s)?map-canvas(?:\s[^"]*)?"/u, "styles.css styles .map-canvas as a gridded placeholder");
  const tiles = html.match(/<img[^>]*class="map-tile-img"[^>]*>/gu) ?? [];
  assert.ok(tiles.length > 0, "tiles render");
  for (const tile of tiles) {
    assert.doesNotMatch(tile, /loading="lazy"/u, "lazy tiles leave blank squares after a zoom");
    assert.match(tile, /draggable="false"/u);
    assert.match(tile, /style="left:-?\d+px;top:-?\d+px"/u, "tile offsets are rounded to whole pixels");
  }
  const canvas = readFileSync(new URL("../src/EventMapCanvas.tsx", import.meta.url), "utf8");
  assert.match(canvas, /import\("\.\/incident-map\.css"\)/u, "the absolute tile layout lives in incident-map.css");
});
