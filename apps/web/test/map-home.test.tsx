import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { EventView, PublicContext, PublicFeatureCollection } from "@waspada/worker/public-contracts";
import { SiteHeader } from "../src/AppShell.js";
import { routeFromHash } from "../src/App.js";
import { MapEventList, EMPTY_LIST_NOTE, EMPTY_LIST_TITLE, EMPTY_RECENT_TITLE, RECENT_SCOPE_TEXT, showAllText } from "../src/MapEventList.js";
import { MapFilterSheet, DEFAULT_MAP_FILTER_VALUE, FACILITY_NOTE, RECENCY_NOTE } from "../src/MapFilterSheet.js";
import { MapHome } from "../src/MapHome.js";
import { buildEventHash, parseEventIdFromHash } from "../src/map-links.js";
import {
  countActiveFilters,
  deepLinkTarget,
  DEFAULT_PUBLISHED_FILTERS,
  filterPublishedEvents,
  markersFromGeoJSON,
  publishedRecently,
  type PublishedFilters,
} from "../src/published-events.js";

/** MAP-RECENT-01: the map defaults to events published or updated in the last 24 hours; this clock sits inside that window. */
const FIXTURE_NOW = Date.parse("2026-11-12T12:00:00.000Z");

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
  const html = renderToStaticMarkup(createElement(MapHome, { now: FIXTURE_NOW, initialEvents: [event("evt-1")], initialMarkers: markers }));
  const toolbar = html.match(/class="toolbar map-home__toolbar">([\s\S]*?)<\/div>/)?.[1] ?? "";
  const zoom = html.match(/class="map-zoom-controls"[^>]*>([\s\S]*?)<\/div>/)?.[1] ?? "";
  const controls = (toolbar.match(/<(button|input)\b/g) ?? []).length + (zoom.match(/<(button|input)\b/g) ?? []).length;
  assert.ok(controls >= 4 && controls <= 5, `found ${controls} controls`);
  assert.doesNotMatch(zoom, /Pusatkan/, "recentre is shown only once the view has moved");
});

test("the toolbar buttons keep their names on phones, where their text is hidden", () => {
  const html = renderToStaticMarkup(createElement(MapHome, { now: FIXTURE_NOW, initialEvents: [event("evt-1")], initialMarkers: markers }));
  assert.match(html, /aria-label="Filter"/);
  assert.match(html, /aria-label="Daftar 1 laporan"/);
  assert.match(html, /aria-label="Cari laporan"/);
});

test("the empty list says the exact message, and never claims an area is safe", () => {
  const html = renderToStaticMarkup(createElement(MapHome, { now: FIXTURE_NOW, initialEvents: [] }));
  // MAP-RECENT-01: the map opens on the 24-hour window, so its empty message names that window.
  assert.ok(html.includes(EMPTY_RECENT_TITLE));
  assert.equal(EMPTY_RECENT_TITLE, "Tidak ada laporan yang terbit atau diperbarui dalam 24 jam terakhir.");
  assert.equal(EMPTY_LIST_TITLE, "Belum ada laporan terbit di area ini dalam rentang waktu ini.");
  assert.ok(html.includes(EMPTY_LIST_NOTE), "the note says an empty result does not mean nothing happened");
  assert.doesNotMatch(html, /\baman\b/iu);
  assert.doesNotMatch(html, /Reset filter/, "no reset button without an active filter");
});

test("a whole_view event in the list says it covers the whole map, and an event without the flag keeps its not-mapped badge", () => {
  const html = renderToStaticMarkup(createElement(MapEventList, {
    headingId: "t",
    status: "loaded",
    events: [event("whole-list-1", { location_display: "whole_view" }), event("plain-list-1")],
    markers: new Map(),
    selectedId: null,
    filtersActive: false,
    errorMessage: null,
    onSelect: () => {},
    onReset: () => {},
    onRetry: () => {},
  }));
  assert.match(html, /map-card__unmapped">Tanpa titik</u);
  assert.equal((html.match(/Belum dipetakan/g) ?? []).length, 1, "only the event without the flag keeps the not-mapped badge");
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
  const html = renderToStaticMarkup(createElement(MapHome, { now: FIXTURE_NOW, initialEvents: [event("evt-1")], initialMarkers: markers }));
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
  assert.equal(countActiveFilters({ category: "disasters_weather", timeRange: "7d", source: "all", recency: "24h" }, true), 3);
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

test("selecting a whole_view event glides to the default Jakarta view, never to another event's pin", () => {
  // MapHome selection is hook-bound, so this pins the source: a whole_view event with no marker takes the fly to the default view.
  const source = readFileSync(new URL("../src/MapHome.tsx", import.meta.url), "utf8");
  assert.match(source, /else if \(eventsById\.get\(eventId\)\?\.location_display === "whole_view"\) flyTo\(MAP_DEFAULT_VIEW\.center, MAP_DEFAULT_VIEW\.zoom, false\)/u);
  assert.match(source, /else if \(target\.event\.location_display === "whole_view"\) flyTo\(MAP_DEFAULT_VIEW\.center, MAP_DEFAULT_VIEW\.zoom, false\)/u);
});

test("the filters type stays a value type, so a default is never mutated", () => {
  const before = JSON.stringify(DEFAULT_PUBLISHED_FILTERS);
  filterPublishedEvents([event("x")], "", { ...DEFAULT_PUBLISHED_FILTERS, timeRange: "24h" }, NOW);
  assert.equal(JSON.stringify(DEFAULT_PUBLISHED_FILTERS), before);
});

test("the map canvas loads the tile stylesheet and places whole-pixel tiles, not the legacy grid canvas", () => {
  const html = renderToStaticMarkup(createElement(MapHome, { now: FIXTURE_NOW, initialEvents: [event("evt-1")], initialMarkers: markers }));
  assert.match(html, /class="interactive-incident-map event-map-canvas"/u);
  assert.doesNotMatch(html, /class="(?:[^"]*\s)?map-canvas(?:\s[^"]*)?"/u, "styles.css styles .map-canvas as a gridded placeholder");
  const tiles = html.match(/<img[^>]*class="map-tile-img(?: map-tile-img--backdrop)?"[^>]*>/gu) ?? [];
  assert.ok(tiles.length > 0, "tiles render");
  for (const tile of tiles) {
    assert.doesNotMatch(tile, /loading="lazy"/u, "lazy tiles leave blank squares after a zoom");
    assert.match(tile, /draggable="false"/u);
    assert.match(tile, /style="left:-?\d+px;top:-?\d+px;width:\d+px;height:\d+px"/u, "tile edges are rounded to whole pixels");
  }
  const canvas = readFileSync(new URL("../src/EventMapCanvas.tsx", import.meta.url), "utf8");
  assert.match(canvas, /import\("\.\/incident-map\.css"\)/u, "the absolute tile layout lives in incident-map.css");
});

test("the map screen has no page footer strip: the emergency notice floats over the map", () => {
  const html = renderToStaticMarkup(createElement(MapHome, { now: FIXTURE_NOW, initialEvents: [event("evt-1")], initialMarkers: markers }));
  const footer = html.match(/<footer class="map-home__footer">([\s\S]*?)<\/footer>/u)?.[1] ?? "";
  assert.match(footer, /bukan layanan darurat\. Darurat: 112\./u);
  assert.match(footer, /Bukan layanan darurat\. Darurat: 112\./u);
  assert.match(footer, /href="#bantuan"/u);
  assert.match(footer, /href="#privasi"/u);
});

test("ST-F-04: the map markers and the list draw from one filtered set, and an event without a point is listed but never pinned", () => {
  const events = [event("evt-pin-a"), event("evt-pin-b"), event("evt-unpinned")];
  const pins = new Map([
    ["evt-pin-a", { coordinate: [106.8786, -6.2549] as const, role: "incident_scene" }],
    ["evt-pin-b", { coordinate: [106.8801, -6.2561] as const, role: "incident_scene" }],
  ]);
  const html = renderToStaticMarkup(createElement(MapHome, { now: FIXTURE_NOW, initialEvents: events, initialMarkers: pins }));

  assert.match(html, /aria-label="Daftar 3 laporan"/, "the list counts every event that passes the filters");
  const pinLabels = [...html.matchAll(/<button type="button" class="map-marker[^"]*"[^>]*aria-label="([^"]+)"/g)]
    .map((match) => match[1] ?? "");
  assert.equal(pinLabels.length, 2, "only events with a point from the API geometry are pinned");
  assert.ok(pinLabels.some((label) => label.includes("Laporan evt-pin-a")));
  assert.ok(pinLabels.some((label) => label.includes("Laporan evt-pin-b")));
  assert.equal(pinLabels.some((label) => label.includes("evt-unpinned")), false, "the unpinned event never gets a marker");
  assert.match(html, /Laporan evt-unpinned/, "the unpinned event is still listed");

  const source = readFileSync(new URL("../src/MapHome.tsx", import.meta.url), "utf8");
  assert.match(source, /const visibleEvents = useMemo\(\s*\(\) => filterPublishedEvents\(data\.events, query, applied\.filters, now\)/u,
    "one filter call produces the visible set");
  assert.match(source, /const canvasMarkers = useMemo<CanvasMarker\[\]>\(\(\) => visibleEvents\.flatMap\(/u,
    "the canvas markers are built from the filtered set, not from every event");
  assert.match(source, /<MapEventList[\s\S]*?events=\{visibleEvents\}/u, "the list receives the same filtered set");
});

const demoScreenContext: PublicContext = { dataset_mode: "demo", dataset_label: "synthetic", generated_at: "2026-11-12T08:00:00.000Z", sources: [] };
const liveScreenContext: PublicContext = { dataset_mode: "live", dataset_label: "live", generated_at: "2026-11-12T08:00:00.000Z", sources: [] };

/** The map screen as App renders it for #peta: the header with its dataset badge, then the map home with its list. */
function mapScreen(context: PublicContext, events: readonly EventView[], pins: typeof markers = markers): string {
  return renderToStaticMarkup(createElement(SiteHeader, { route: { screen: "discover" }, context }))
    + renderToStaticMarkup(createElement(MapHome, { now: FIXTURE_NOW, initialEvents: events, initialMarkers: pins, context }));
}

function minWidthMatches(query: string, width: number): boolean {
  const minimum = /^\(min-width:\s*(\d+)px\)$/u.exec(query);
  return minimum !== null && width >= Number(minimum[1]);
}

/** Runs a render with window.matchMedia answering the min-width queries of a viewport this wide. The tests have no DOM. */
function atViewportWidth<T>(width: number, render: () => T): T {
  const scope = globalThis as { window?: unknown };
  const hadWindow = Object.prototype.hasOwnProperty.call(globalThis, "window");
  const previous = scope.window;
  scope.window = {
    matchMedia: (query: string) => ({
      matches: minWidthMatches(query, width),
      media: query,
      addEventListener() {},
      removeEventListener() {},
    }),
  };
  try {
    return render();
  } finally {
    if (hadWindow) scope.window = previous;
    else delete scope.window;
  }
}

test("ST-F-04: the demo or live label sits on the map screen that holds the list, and each mode shows only its own", () => {
  const demo = mapScreen(demoScreenContext, [event("evt-1")]);
  assert.match(demo, /<span class="site-header__badge-label">Data contoh<\/span>/u);
  assert.match(demo, /aria-label="Daftar 1 laporan"/u);
  assert.match(demo, /aria-label="Laporan terbit"/u, "the list is on the same screen as the label");
  assert.doesNotMatch(demo, /site-header__badge-label">Langsung</u);

  const live = mapScreen(liveScreenContext, [event("evt-1")]);
  assert.match(live, /<span class="site-header__badge-label">Langsung<\/span>/u);
  assert.match(live, /aria-label="Laporan terbit"/u, "the live list is on the same screen as the label");
  assert.doesNotMatch(live, /Data contoh/u);
});

test("ST-F-04: at 390 px the list is a closed bottom sheet behind the Daftar toggle, and the side panel opens only from 900 px", () => {
  const render = (width: number) => atViewportWidth(width, () => renderToStaticMarkup(
    createElement(MapHome, { now: FIXTURE_NOW, initialEvents: [event("evt-1")], initialMarkers: markers }),
  ));
  const toggleOf = (html: string) => html.match(/<button[^>]*aria-label="Daftar 1 laporan"[^>]*>/u)?.[0] ?? "";

  const phone = render(390);
  assert.match(toggleOf(phone), /aria-expanded="false"/u, "the toggle reads closed on a phone");
  assert.doesNotMatch(phone, /class="map-home__panel"/u, "no side panel on a phone");
  assert.doesNotMatch(phone, /aria-label="Laporan terbit"/u, "the list is not in the page until the toggle opens it");
  assert.doesNotMatch(phone, /class="sheet map-list-sheet"/u, "the bottom sheet starts closed");

  assert.doesNotMatch(render(899), /class="map-home__panel"/u, "899 px is still the phone layout");

  const atBreakpoint = render(900);
  assert.match(atBreakpoint, /class="map-home__panel"/u, "from 900 px the list is a left panel");
  assert.match(atBreakpoint, /class="map-home map-home--island"/u);
  assert.match(toggleOf(atBreakpoint), /aria-expanded="true"/u);

  const source = readFileSync(new URL("../src/MapHome.tsx", import.meta.url), "utf8");
  assert.match(source, /onClick=\{\(\) => setListOpen\(\(open\) => !open\)\}/u, "the Daftar toggle opens and closes the list");
  assert.match(source, /onClose=\{\(\) => setListOpen\(false\)\}/u, "the bottom sheet closes back to the map");
});

test("ST-F-15: a live map with no published events says an empty list is not an all-clear, and carries the live label", () => {
  const html = mapScreen(liveScreenContext, []);
  assert.ok(html.includes(EMPTY_RECENT_TITLE));
  assert.ok(html.includes(EMPTY_LIST_NOTE), "the note says an empty result does not mean nothing happened");
  assert.doesNotMatch(html, /\baman\b/iu);
  assert.doesNotMatch(html, /semua baik|tidak ada bahaya|situasi normal|kondisi normal/iu);
  assert.match(html, /<span class="site-header__badge-label">Langsung<\/span>/u);
  assert.doesNotMatch(html, /Data contoh|DEMO —/u, "no demo label on a live map");
});

test("ST-F-15: a demo map with no published events carries the demo label and never the live one", () => {
  const html = mapScreen(demoScreenContext, []);
  assert.match(html, /<span class="site-header__badge-label">Data contoh<\/span>/u);
  assert.doesNotMatch(html, /site-header__badge-label">Langsung</u);
  assert.ok(html.includes(EMPTY_RECENT_TITLE));
});

// MAP-RECENT-01 (owner, 23 Nov 2026): the map opens on events published or updated in the last 24 hours.

const HOUR = 60 * 60 * 1000;

function publishedHoursAgo(id: string, hours: number): EventView {
  return event(id, { published_at: new Date(FIXTURE_NOW - hours * HOUR).toISOString() });
}

test("MAP-RECENT-01: the publication window keeps versions published or updated within 24 hours and drops older ones", () => {
  assert.equal(publishedRecently(publishedHoursAgo("a", 23.9), FIXTURE_NOW), true);
  assert.equal(publishedRecently(publishedHoursAgo("b", 24.1), FIXTURE_NOW), false);
  assert.equal(publishedRecently(publishedHoursAgo("c", -0.5), FIXTURE_NOW), true, "a version newer than the page clock is recent");
  assert.equal(publishedRecently(event("d", { published_at: "not a time" }), FIXTURE_NOW), false, "an unreadable time is never recent");
  // An update publishes a new version, so an old event updated an hour ago carries a recent published_at.
  const updated = event("e", { version: 4, published_at: new Date(FIXTURE_NOW - HOUR).toISOString() });
  const events = [publishedHoursAgo("old", 72), updated, publishedHoursAgo("new", 2)];
  const ids = (recency: "24h" | "all") =>
    filterPublishedEvents(events, "", { ...DEFAULT_PUBLISHED_FILTERS, recency }, FIXTURE_NOW).map((item) => item.event_id);
  assert.deepEqual(ids("24h"), ["e", "new"]);
  assert.deepEqual(ids("all"), ["old", "e", "new"]);
});

test("MAP-RECENT-01: the map defaults to 24 hours, the window is not counted as an active filter, and reset keeps it", () => {
  assert.equal(DEFAULT_MAP_FILTER_VALUE.filters.recency, "24h");
  assert.equal(DEFAULT_PUBLISHED_FILTERS.recency, "all", "other lists keep every published event");
  assert.equal(countActiveFilters(DEFAULT_MAP_FILTER_VALUE.filters, false), 0);
  const sheet = renderToStaticMarkup(createElement(MapFilterSheet, { applied: DEFAULT_MAP_FILTER_VALUE, onApply: () => {}, onClose: () => {} }));
  assert.match(sheet, /<legend>Terbit atau diperbarui<\/legend>/u);
  assert.match(sheet, /aria-pressed="true"[^>]*>24 jam terakhir</u);
  assert.match(sheet, />Kapan saja</u);
  assert.ok(sheet.includes(RECENCY_NOTE), "the sheet says this is the publication time, not the event time");
});

test("MAP-RECENT-01: an older event is hidden by default, counted, and one action shows it; no pin is drawn for it", () => {
  const events = [publishedHoursAgo("old-1", 30), publishedHoursAgo("fresh-1", 1)];
  const pins = new Map([
    ["old-1", { coordinate: [106.85, -6.2] as const, role: "incident_scene" }],
    ["fresh-1", { coordinate: [106.8, -6.18] as const, role: "incident_scene" }],
  ]);
  const html = renderToStaticMarkup(createElement(MapHome, { now: FIXTURE_NOW, initialEvents: events, initialMarkers: pins }));
  assert.match(html, /aria-label="Daftar 1 laporan"/u);
  assert.ok(html.includes(RECENT_SCOPE_TEXT), "the list and the map caption name the window");
  assert.ok(html.includes(showAllText(1)));
  // The desktop side panel already shows the window line, so the map caption stays hidden while it is open.
  assert.doesNotMatch(html, /class="map-home__scope"/u);
  assert.doesNotMatch(html, /\baman\b/iu);
});

test("MAP-RECENT-01: an empty 24-hour window with older events offers to show them and still says empty is not an all-clear", () => {
  const html = renderToStaticMarkup(createElement(MapHome, { now: FIXTURE_NOW, initialEvents: [publishedHoursAgo("old-1", 48)] }));
  assert.ok(html.includes(EMPTY_RECENT_TITLE));
  assert.ok(html.includes(EMPTY_LIST_NOTE));
  assert.ok(html.includes(showAllText(1)));
  assert.doesNotMatch(html, /\baman\b/iu);
});

test("MAP-RECENT-01: a deep link to an older event widens the window so the linked event is shown", () => {
  const source = readFileSync(new URL("../src/MapHome.tsx", import.meta.url), "utf8");
  assert.match(source, /publishedRecently\(target\.event, now\) \? DEFAULT_MAP_FILTER_VALUE : withRecency\(DEFAULT_MAP_FILTER_VALUE, "all"\)/u);
});
