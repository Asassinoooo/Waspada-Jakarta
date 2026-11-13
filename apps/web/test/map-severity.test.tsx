import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { EventView } from "@waspada/worker/public-contracts";
import { EventDetail } from "../src/EventDetail.js";
import { EventMapCanvas, MAP_DEFAULT_VIEW, severityMarkerStyle, type CanvasMarker } from "../src/EventMapCanvas.js";
import { MapEventList } from "../src/MapEventList.js";
import { MapHome } from "../src/MapHome.js";
import { MapLegend, SeverityChip } from "../src/MapSeverity.js";
import {
  SEVERITY_NOTE,
  severityAriaSuffix,
  severityLabel,
  severityOf,
  type PublicSeverity,
} from "../src/published-events.js";

/** SEV-01: a public estimate of impact, shown as icon size, a chip and a key. It is never a radius and never a safety claim. */

const MAP_CSS = readFileSync(new URL("../src/map-home.css", import.meta.url), "utf8");

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
    claims: [],
    impacts: [],
    published_at: "2026-11-12T09:05:00.000Z",
    ...overrides,
  } as unknown as EventView;
}

function marker(overrides: Partial<CanvasMarker> = {}): CanvasMarker {
  return {
    id: "evt-1",
    coordinate: MAP_DEFAULT_VIEW.center,
    label: "Banjir: Laporan uji",
    icon: "🌊",
    selected: false,
    ...overrides,
  };
}

/** The canvas at the default view. A marker at the view centre always lands inside the fallback size. */
function canvasWith(markers: CanvasMarker[]): string {
  return renderToStaticMarkup(createElement(EventMapCanvas, {
    label: "Peta uji",
    view: MAP_DEFAULT_VIEW,
    onViewChange: () => {},
    markers,
    onSelectMarker: () => {},
    facilities: [],
    showRecenter: false,
    onRecenter: () => {},
  }));
}

function markerButton(html: string): string {
  const match = html.match(/<button[^>]*class="map-marker[ "][\s\S]*?<\/button>/u);
  assert.ok(match, "the marker button renders");
  return match[0];
}

function cssBlock(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const match = MAP_CSS.match(new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`, "u"));
  assert.ok(match, `${selector} is styled`);
  return match[1] ?? "";
}

test("severityOf reads only the three API values and never guesses a level", () => {
  assert.equal(severityOf(event("a", { severity: "low" })), "low");
  assert.equal(severityOf(event("a", { severity: "medium" })), "medium");
  assert.equal(severityOf(event("a", { severity: "high" })), "high");
  for (const value of ["critical", "unknown", "HIGH", "", null]) {
    assert.equal(severityOf(event("a", { severity: value })), null, `value ${JSON.stringify(value)} is not shown`);
  }
  assert.equal(severityOf(event("a")), null);
});

test("severityLabel gives the Indonesian names Rendah, Sedang and Tinggi", () => {
  const levels: PublicSeverity[] = ["low", "medium", "high"];
  assert.deepEqual(levels.map(severityLabel), ["Rendah", "Sedang", "Tinggi"]);
});

test("the public note is fixed text and never says an area is safe or verified", () => {
  assert.equal(SEVERITY_NOTE, "Perkiraan otomatis dari laporan; bukan jaminan keamanan.");
  assert.doesNotMatch(SEVERITY_NOTE, /\baman\b|terverifikasi|terkonfirmasi/iu);
});

test("the screen-reader suffix names the level in words, and is empty when not assessed", () => {
  assert.equal(severityAriaSuffix(null), "");
  assert.equal(severityAriaSuffix("low"), ", tingkat dampak Rendah");
  assert.equal(severityAriaSuffix("medium"), ", tingkat dampak Sedang");
  assert.equal(severityAriaSuffix("high"), ", tingkat dampak Tinggi");
});

test("the core radius is 9, 12 or 15 for low, medium and high, and 10 when not assessed", () => {
  assert.equal(severityMarkerStyle("low").coreRadius, 9);
  assert.equal(severityMarkerStyle("medium").coreRadius, 12);
  assert.equal(severityMarkerStyle("high").coreRadius, 15);
  assert.equal(severityMarkerStyle(null).coreRadius, 10);
  assert.equal(severityMarkerStyle(undefined).coreRadius, 10);
});

test("the emoji grows with the core, and the selected ring stays outside the core at every level", () => {
  const levels = [severityMarkerStyle("low"), severityMarkerStyle("medium"), severityMarkerStyle("high")];
  assert.ok(levels[0]!.iconFontSize < levels[1]!.iconFontSize && levels[1]!.iconFontSize < levels[2]!.iconFontSize);
  for (const style of [...levels, severityMarkerStyle(null)]) {
    assert.equal(style.selectedRingRadius, style.coreRadius + 10);
  }
});

test("only high adds a pulse ring, and every level keeps the marker class it is styled by", () => {
  assert.equal(severityMarkerStyle("high").pulseRadius, 20);
  for (const level of ["low", "medium", null] as const) assert.equal(severityMarkerStyle(level).pulseRadius, null);
  assert.equal(severityMarkerStyle("low").className, "map-marker--sev-low");
  assert.equal(severityMarkerStyle("medium").className, "map-marker--sev-medium");
  assert.equal(severityMarkerStyle("high").className, "map-marker--sev-high");
  assert.equal(severityMarkerStyle(null).className, null);
});

test("a low marker renders its class, its radius and an aria label that says the level in words", () => {
  const button = markerButton(canvasWith([marker({ severity: "low" })]));
  assert.match(button, /class="map-marker map-marker--sev-low"/u);
  assert.match(button, /class="incident-beacon-core" r="9"/u);
  assert.match(button, /aria-label="Banjir: Laporan uji, tingkat dampak Rendah"/u);
});

test("medium and high markers scale up, and only the high marker draws the pulse ring", () => {
  const medium = markerButton(canvasWith([marker({ severity: "medium" })]));
  assert.match(medium, /class="map-marker map-marker--sev-medium"/u);
  assert.match(medium, /class="incident-beacon-core" r="12"/u);
  assert.doesNotMatch(medium, /map-marker__pulse/u);

  const high = markerButton(canvasWith([marker({ severity: "high" })]));
  assert.match(high, /class="map-marker map-marker--sev-high"/u);
  assert.match(high, /class="incident-beacon-core" r="15"/u);
  assert.match(high, /class="map-marker__pulse" r="20"/u);
  assert.match(high, /aria-label="Banjir: Laporan uji, tingkat dampak Tinggi"/u);
});

test("an unassessed marker keeps the base class and radius, and says nothing about a level", () => {
  const button = markerButton(canvasWith([marker()]));
  assert.match(button, /class="map-marker"/u);
  assert.match(button, /class="incident-beacon-core" r="10"/u);
  assert.doesNotMatch(button, /map-marker--sev|tingkat dampak|map-marker__pulse/u);
});

test("the selected marker keeps a ring outside its core, and its ring follows the level", () => {
  const button = markerButton(canvasWith([marker({ severity: "high", selected: true })]));
  assert.match(button, /class="map-marker map-marker--sev-high map-marker--selected"/u);
  assert.match(button, /class="map-marker__ring" r="25"/u);
});

test("markers stack low, medium, high, with the selected marker on top and all under the toolbar and popup", () => {
  const zIndex = (selector: string) => Number(cssBlock(selector).match(/z-index:\s*(\d+)/u)?.[1]);
  const low = zIndex(".map-marker--sev-low");
  const medium = zIndex(".map-marker--sev-medium");
  const high = zIndex(".map-marker--sev-high");
  const selected = zIndex(".map-marker--selected");
  assert.ok(low < medium && medium < high && high < selected, "low < medium < high < selected");
  assert.ok(zIndex(".map-marker") < low, "an unassessed marker sits below every assessed one");
  const layer = zIndex(".map-marker-layer");
  assert.ok(layer < zIndex(".map-home__toolbar"), "markers stay under the toolbar");
  assert.ok(layer < zIndex(".map-overlay-layer"), "markers stay under the popup");
});

test("every marker keeps a hit target of at least 2.75rem", () => {
  assert.match(cssBlock(".map-marker"), /width:\s*2\.75rem;\s*height:\s*2\.75rem;/u);
});

test("the high-severity pulse is a fading scale of about 1.8 seconds, and reduced motion turns it off", () => {
  assert.match(cssBlock(".map-marker__pulse"), /animation:\s*map-marker-pulse\s+1\.8s/u);
  assert.match(cssBlock(".map-marker__pulse"), /stroke-width:\s*3;/u, "the high ring has a stronger stroke than the core outline");
  assert.match(
    MAP_CSS,
    /@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\.map-marker__pulse \{\s*animation: none;\s*\}/u,
  );
});

test("the map draws no radius, area or circle from severity: the only circles are the icon, its ring and its pulse", () => {
  const html = canvasWith([marker({ severity: "high", selected: true })]);
  const circles = html.match(/<circle[^>]*>/gu) ?? [];
  assert.equal(circles.length, 3, "a selected high marker draws its ring, its pulse and its core, and nothing else");
  assert.ok(circles.every((circle) => /class="(map-marker__ring|map-marker__pulse|incident-beacon-core)"/u.test(circle)));
});

test("the legend says what the icon size means, names the three levels, and sits in a corner", () => {
  const html = renderToStaticMarkup(createElement(MapLegend));
  assert.match(html, /title="Ukuran ikon = tingkat dampak"/u);
  assert.ok(html.includes(">Ukuran ikon = tingkat dampak</p>"));
  for (const label of ["Rendah", "Sedang", "Tinggi"]) assert.ok(html.includes(`<span>${label}</span>`), label);
  assert.match(cssBlock(".map-legend"), /position:\s*absolute;/u);
  assert.match(cssBlock(".map-legend"), /pointer-events:\s*none;/u, "the key takes no pointer input");
});

test("the map home renders the legend and the assessed marker class together", () => {
  const html = renderToStaticMarkup(createElement(MapHome, {
    initialEvents: [event("evt-1", { severity: "high" })],
    initialMarkers: new Map([["evt-1", { coordinate: [106.8786, -6.2549] as const, role: "incident_scene" }]]),
  }));
  assert.match(html, /class="map-legend"/u);
  assert.match(html, /class="map-marker map-marker--sev-high"/u);
});

test("a chip reads Tingkat dampak with the level, and its note is the tooltip", () => {
  assert.equal(
    renderToStaticMarkup(createElement(SeverityChip, { level: "low" })),
    `<span class="map-severity-chip map-severity-chip--low" title="${SEVERITY_NOTE}">Tingkat dampak: Rendah</span>`,
  );
});

test("each list card shows its chip, and an unassessed or legacy severity shows none", () => {
  const html = renderToStaticMarkup(createElement(MapEventList, {
    headingId: "t",
    status: "loaded",
    events: [
      event("evt-high", { severity: "high" }),
      event("evt-none"),
      event("evt-legacy", { severity: "critical" }),
    ],
    markers: new Map(),
    selectedId: null,
    filtersActive: false,
    errorMessage: null,
    onSelect: () => {},
    onReset: () => {},
    onRetry: () => {},
  }));
  assert.equal(html.match(/class="map-severity-chip /gu)?.length, 1);
  assert.equal(html.match(/Tingkat dampak: Tinggi/gu)?.length, 1);
  assert.ok(html.includes(`title="${SEVERITY_NOTE}"`));
});

test("the detail sheet shows the chip and prints the note as text", () => {
  const html = renderToStaticMarkup(createElement(EventDetail, {
    mode: "api-event",
    apiDetail: { eventId: "evt-1", status: "loaded", data: event("evt-1", { severity: "medium", geometries: [] }) as never },
    apiHistory: { eventId: "evt-1", status: "loaded", data: { data: [], page: { next_cursor: null, cursor_expires_at: null } } },
    context: null,
    variant: "sheet",
  }));
  assert.match(html, /Tingkat dampak: Sedang/u);
  assert.ok(html.includes(`<small>${SEVERITY_NOTE}</small>`));
});

test("the detail sheet shows no severity block when the record carries no assessed level", () => {
  const html = renderToStaticMarkup(createElement(EventDetail, {
    mode: "api-event",
    apiDetail: { eventId: "evt-1", status: "loaded", data: event("evt-1", { geometries: [] }) as never },
    apiHistory: { eventId: "evt-1", status: "loaded", data: { data: [], page: { next_cursor: null, cursor_expires_at: null } } },
    context: null,
    variant: "sheet",
  }));
  assert.doesNotMatch(html, /map-severity|Tingkat dampak/u);
});
