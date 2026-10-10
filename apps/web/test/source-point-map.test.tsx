import assert from "node:assert/strict";
import test from "node:test";
import { createElement, Fragment } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { PreviewRecord } from "@waspada/worker/source-preview-contracts";
import type { EarthquakeContextRecord } from "@waspada/worker/context-sources-contracts";
import {
  clampMapZoom,
  coordinateToWorldPixels,
  createOsmTileUrl,
  getVisibleMapTiles,
  isValidOsmTileTemplate,
  SourcePointMap,
  worldPixelsToCoordinate,
} from "../src/SourcePointMap.js";

const SYNTHETIC_SOURCE_POINTS: PreviewRecord[] = [
  {
    id: "synthetic-osm-hospital-1",
    source: "osm",
    kind: "hospital",
    title: "Rumah Sakit Contoh",
    coordinates: [106.831, -6.191],
    coordinate_kind: "source_extent_center",
    source_created_at: null,
    source_status: null,
    source_url: "https://www.openstreetmap.org/",
  },
  {
    id: "synthetic-osm-police-1",
    source: "osm",
    kind: "police",
    title: "Polsek Contoh",
    coordinates: [106.832, -6.192],
    coordinate_kind: "source_point",
    source_created_at: null,
    source_status: null,
    source_url: "https://www.openstreetmap.org/",
  },
  {
    id: "synthetic-osm-fire-1",
    source: "osm",
    kind: "fire_station",
    title: "Pos Pemadam Contoh",
    coordinates: [106.833, -6.193],
    coordinate_kind: "source_point",
    source_created_at: null,
    source_status: null,
    source_url: "https://www.openstreetmap.org/",
  },
  {
    id: "synthetic-report-flood-1",
    source: "petabencana",
    kind: "flood_report",
    title: "Laporan Banjir Contoh",
    coordinates: [106.834, -6.194],
    coordinate_kind: "source_point",
    source_created_at: "2026-10-10T02:00:00Z",
    source_status: "reported",
    source_url: "https://petabencana.id/",
  },
];

test("Web Mercator projection maps the world center and round-trips Jakarta coordinates", () => {
  const zoom = 12;
  const worldSize = 256 * 2 ** zoom;
  assert.deepEqual(coordinateToWorldPixels([0, 0], zoom), { x: worldSize / 2, y: worldSize / 2 });

  for (const currentZoom of [4, 12, 18]) {
    const source: [number, number] = [106.83, -6.19];
    const pixels = coordinateToWorldPixels(source, currentZoom);
    const result = worldPixelsToCoordinate(pixels.x, pixels.y, currentZoom);
    assert.ok(Math.abs(result[0] - source[0]) < 1e-9);
    assert.ok(Math.abs(result[1] - source[1]) < 1e-9);
  }
});

test("world projection and zoom stay within Web Mercator bounds", () => {
  assert.equal(clampMapZoom(-20), 4);
  assert.equal(clampMapZoom(40), 18);
  assert.equal(clampMapZoom(12.4), 12);

  const northWest = coordinateToWorldPixels([-181, 90], 12);
  const northWestBound = coordinateToWorldPixels([-180, 85.0511287798066], 12);
  assert.deepEqual(northWest, northWestBound);
  const clippedNorthWest = worldPixelsToCoordinate(-500, -500, 12);
  assert.equal(clippedNorthWest[0], -180);
  assert.ok(Math.abs(clippedNorthWest[1] - 85.0511287798066) < 1e-12);
});

test("viewport tile selection stays visible, within XYZ world bounds, and capped", () => {
  const tiles = getVisibleMapTiles(640, 400, [106.83, -6.19], 12);
  const tileCount = 2 ** 12;
  assert.ok(tiles.length > 0 && tiles.length <= 100);
  assert.ok(tiles.every((tile) => tile.x >= 0 && tile.y >= 0 && tile.x < tileCount && tile.y < tileCount));
  assert.ok(tiles.every((tile) => tile.left < 640 && tile.left + 256 > 0 && tile.top < 400 && tile.top + 256 > 0));

  const oversizedViewport = getVisibleMapTiles(100_000, 100_000, [106.83, -6.19], 12);
  assert.equal(oversizedViewport.length, 100);
  assert.deepEqual(getVisibleMapTiles(0, 400, [106.83, -6.19], 12), []);
});

test("custom OSM tiles require a credential-free HTTPS XYZ template", () => {
  const template = "https://tiles.example.test/{z}/{x}/{y}.png";
  assert.equal(isValidOsmTileTemplate(template), true);
  assert.equal(createOsmTileUrl(template, { zoom: 12, x: 3210, y: 2047 }), "https://tiles.example.test/12/3210/2047.png");
  assert.equal(isValidOsmTileTemplate("http://tiles.example.test/{z}/{x}/{y}.png"), false);
  assert.equal(isValidOsmTileTemplate("https://tiles.example.test/{z}/{x}.png"), false);
  assert.equal(isValidOsmTileTemplate("https://user:secret@tiles.example.test/{z}/{x}/{y}.png"), false);
  assert.equal(isValidOsmTileTemplate("https://tiles.example.test/{z}/{x}/{y}.png?token=secret"), false);
  assert.throws(() => createOsmTileUrl("http://tiles.example.test/{z}/{x}/{y}.png", { zoom: 12, x: 1, y: 1 }), TypeError);
});

test("map renders synthetic point categories, source distinctions, attribution, and selected state", () => {
  const markup = renderToStaticMarkup(
    createElement(SourcePointMap, {
      points: SYNTHETIC_SOURCE_POINTS,
      selectedId: "synthetic-report-flood-1",
      onSelect: () => {},
      onReturnToList: () => {},
    }),
  );

  for (const id of [
    "synthetic-osm-hospital-1",
    "synthetic-osm-police-1",
    "synthetic-osm-fire-1",
    "synthetic-report-flood-1",
  ]) {
    assert.match(markup, new RegExp(`data-record-id="${id}"`));
  }
  assert.match(markup, /data-map-center="106\.834,-6\.194"/);
  assert.match(markup, /data-selected="true"/);
  assert.match(markup, /aria-pressed="true"/);
  assert.match(markup, /data-kind="hospital"/);
  assert.match(markup, /data-kind="police"/);
  assert.match(markup, /data-kind="fire_station"/);
  assert.match(markup, /data-kind="flood_report"/);
  assert.match(markup, /Rumah sakit/);
  assert.match(markup, /Kepolisian/);
  assert.match(markup, /Pemadam kebakaran/);
  assert.match(markup, /Laporan banjir/);
  assert.match(markup, /Fasilitas:.*kesiapan layanan tidak diketahui/);
  assert.match(markup, /Laporan warga:.*belum ditinjau Waspada/);
  assert.match(markup, /Pusat cakupan OSM:.*perkiraan/);
  assert.match(markup, /Fasilitas referensi OpenStreetMap/);
  assert.match(markup, /belum ditinjau Waspada/);
  assert.match(markup, /Titik tengah cakupan OSM yang diperkirakan/);
  assert.match(markup, /referrerPolicy="strict-origin-when-cross-origin"/);
  assert.match(markup, /https:\/\/www\.openstreetmap\.org\/copyright/);
  assert.match(markup, /© OpenStreetMap contributors/);
  assert.match(markup, /Kembali ke daftar/);
  assert.doesNotMatch(markup, /radius|tingkat bahaya|ketersediaan layanan ditampilkan/i);
});

test("an empty synthetic preview has an explicit non-safety empty state", () => {
  const markup = renderToStaticMarkup(
    createElement(SourcePointMap, { points: [], selectedId: null, onSelect: () => {} }),
  );

  assert.match(markup, /Tidak ada titik sumber untuk ditampilkan/);
  assert.match(markup, /Hasil kosong tidak menyatakan bahwa wilayah aman/);
  assert.match(markup, /data-map-center="106\.83,-6\.19"/);
  assert.match(markup, /data-map-zoom="12"/);
  assert.match(markup, /© OpenStreetMap contributors/);
});

const SYNTHETIC_QUAKE: EarthquakeContextRecord = {
  id: "usgs:synthetic1", source: "usgs", kind: "earthquake",
  title: "Gempa contoh uji, Selat Sunda", coordinates: [105.8, -6.8],
  coordinate_kind: "source_point", event_time: "2026-10-10T02:00:00Z",
  updated_at: "2026-10-10T03:00:00Z", magnitude: 3.4, magnitude_type: "mb",
  depth_km: 12, source_status: "reviewed",
  source_url: "https://earthquake.usgs.gov/earthquakes/eventpage/synthetic1",
};

test("regional quake map uses source origins and region-specific defaults without inferred impact", () => {
  const markup = renderToStaticMarkup(createElement(SourcePointMap, {
    points: [SYNTHETIC_QUAKE], selectedId: null, onSelect: () => {}, viewMode: "regional_earthquakes",
  }));
  assert.match(markup, /data-map-center="106\.8,-6\.8"/);
  assert.match(markup, /data-map-zoom="6"/);
  assert.match(markup, /data-source="usgs"/);
  assert.match(markup, /data-kind="earthquake"/);
  assert.match(markup, /episentrum dari katalog USGS/);
  assert.match(markup, /dampak di Jakarta belum ditetapkan/i);
  assert.match(markup, /bukan batas resmi atau area bahaya/);
  assert.match(markup, /Regional awal/);
  assert.match(markup, /© OpenStreetMap contributors/);
  assert.doesNotMatch(markup, /PetaBencana|kesiapan layanan|Fasilitas rujukan|Pusat cakupan/);
});

test("quake origins retain their source description when passed to the default map", () => {
  const markup = renderToStaticMarkup(createElement(SourcePointMap, {
    points: [SYNTHETIC_QUAKE], selectedId: SYNTHETIC_QUAKE.id, onSelect: () => {},
  }));
  assert.match(markup, /data-map-center="105\.8,-6\.8"/);
  assert.match(markup, /data-source="usgs"/);
  assert.match(markup, /episentrum dari katalog USGS/);
  assert.match(markup, /Katalog gempa USGS/);
  assert.doesNotMatch(markup, /aria-label="Gempa contoh uji, Selat Sunda,[^"]*Laporan warga/);
});

test("two map instances have unique headings and help IDs", () => {
  const markup = renderToStaticMarkup(createElement(Fragment, null,
    createElement(SourcePointMap, { points: [], selectedId: null, onSelect: () => {} }),
    createElement(SourcePointMap, { points: [], selectedId: null, onSelect: () => {}, viewMode: "regional_earthquakes" }),
  ));
  const ids = [...markup.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
  assert.equal(ids.length, 4);
  assert.equal(new Set(ids).size, ids.length);
  assert.match(markup, /Hasil kosong tidak menyatakan bahwa wilayah aman/);
});
