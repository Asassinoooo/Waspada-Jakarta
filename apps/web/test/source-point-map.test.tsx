import assert from "node:assert/strict";
import test from "node:test";
import { createElement, Fragment } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { PreviewRecord } from "@waspada/worker/source-preview-contracts";
import type { EarthquakeContextRecord } from "@waspada/worker/context-sources-contracts";
import {
  buildSourceMapDisplayItems,
  clampMapZoom,
  clusterZoomTarget,
  coordinateToWorldPixels,
  createOsmTileUrl,
  getVisibleMapTiles,
  isValidOsmTileTemplate,
  layoutSourceMapClusterBadges,
  SourcePointMap,
  type SourceMapPoint,
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

const CLUSTER_POINTS: SourceMapPoint[] = [
  { ...SYNTHETIC_SOURCE_POINTS[0]!, id: "osm-hospital", coordinates: [106.831, -6.191] },
  { ...SYNTHETIC_SOURCE_POINTS[1]!, id: "osm-police", coordinates: [106.831, -6.191] },
  { ...SYNTHETIC_SOURCE_POINTS[2]!, id: "osm-fire", coordinates: [106.831, -6.191] },
  { ...SYNTHETIC_SOURCE_POINTS[3]!, id: "peta-first", coordinates: [106.831, -6.191] },
  { ...SYNTHETIC_SOURCE_POINTS[3]!, id: "peta-second", coordinates: [106.831, -6.191] },
  { ...SYNTHETIC_QUAKE, id: "usgs-first", coordinates: [106.831, -6.191] },
  { ...SYNTHETIC_QUAKE, id: "usgs-second", coordinates: [106.831, -6.191] },
];

test("unified world-grid groups are provider-separated, lossless, and stable when input order changes", () => {
  const summarize = (points: readonly SourceMapPoint[]) => buildSourceMapDisplayItems(points, null, 12, true).map((item) => item.type === "cluster"
    ? {
      type: item.type,
      key: item.key,
      source: item.cluster.source,
      count: item.cluster.count,
      memberIds: item.cluster.memberIds,
      anchor: item.cluster.anchor,
      osmCategoryCounts: item.cluster.osmCategoryCounts,
    }
    : { type: item.type, key: item.key, source: item.point.source, id: item.point.id });
  const groups = buildSourceMapDisplayItems(CLUSTER_POINTS, null, 12, true);
  const clusters = groups.filter((item) => item.type === "cluster");

  assert.deepEqual(summarize(CLUSTER_POINTS), summarize([...CLUSTER_POINTS].reverse()));
  assert.equal(clusters.length, 3);
  const bySource = new Map(clusters.map((item) => item.type === "cluster" ? [item.cluster.source, item.cluster] as const : ["", undefined] as const));
  const osm = bySource.get("osm");
  assert.ok(osm);
  assert.equal(osm.count, 3);
  assert.deepEqual(osm.osmCategoryCounts, { hospital: 1, police: 1, fire_station: 1 });
  assert.deepEqual(osm.memberIds, ["osm-fire", "osm-hospital", "osm-police"]);
  assert.equal(bySource.get("petabencana")?.count, 2);
  assert.equal(bySource.get("usgs")?.count, 2);
  assert.equal(groups.reduce((count, item) => count + (item.type === "cluster" ? item.cluster.count : 1), 0), CLUSTER_POINTS.length);
  assert.ok(clusters.every((item) => item.type === "cluster" && item.cluster.clusterId.startsWith(`display-${item.cluster.source}-12-`)));
});

test("coincident provider badges receive stable, bounded, non-overlapping display placements", () => {
  const clusters = buildSourceMapDisplayItems(CLUSTER_POINTS, null, 12, true)
    .flatMap((item) => item.type === "cluster" ? [item.cluster] : []);
  const placements = layoutSourceMapClusterBadges(clusters, 12);
  const reversedPlacements = layoutSourceMapClusterBadges([...clusters].reverse(), 12);
  const positioned = clusters.map((cluster) => {
    const placement = placements.get(cluster.clusterId);
    assert.ok(placement);
    return { cluster, placement };
  });

  assert.equal(positioned.length, 3);
  assert.deepEqual([...placements], [...reversedPlacements]);
  for (const { cluster, placement } of positioned) {
    const anchor = coordinateToWorldPixels(cluster.anchor, 12);
    assert.ok(Math.hypot(placement.x - anchor.x, placement.y - anchor.y) <= 336);
    assert.equal(Math.hypot(placement.offsetX, placement.offsetY), Math.hypot(placement.x - anchor.x, placement.y - anchor.y));
  }
  for (let left = 0; left < positioned.length; left += 1) {
    for (let right = left + 1; right < positioned.length; right += 1) {
      const a = positioned[left]!.placement;
      const b = positioned[right]!.placement;
      assert.ok(Math.hypot(a.x - b.x, a.y - b.y) >= 56);
    }
  }
});

test("cluster symbols stay clear of the selected individual marker", () => {
  const items = buildSourceMapDisplayItems(CLUSTER_POINTS, "osm-hospital", 12, true);
  const clusters = items.flatMap((item) => item.type === "cluster" ? [item.cluster] : []);
  const selected = items.find((item) => item.type === "point" && item.point.id === "osm-hospital");
  assert.ok(selected && selected.type === "point");
  const placements = layoutSourceMapClusterBadges(clusters, 12, selected.point.coordinates);
  const selectedPixels = coordinateToWorldPixels(selected.point.coordinates, 12);

  assert.equal(clusters.length, 3);
  for (const cluster of clusters) {
    const placement = placements.get(cluster.clusterId);
    assert.ok(placement);
    assert.ok(Math.abs(placement.x - selectedPixels.x) >= 149 || Math.abs(placement.y - selectedPixels.y) >= 47);
  }
});

test("nearby groups from adjacent world-grid cells get separate badges without moving their anchors", () => {
  const zoom = 12;
  const base = coordinateToWorldPixels([106.831, -6.191], zoom);
  const boundaryX = (Math.floor(base.x / 64) + 1) * 64;
  const leftCoordinate = worldPixelsToCoordinate(boundaryX - 1, base.y, zoom);
  const rightCoordinate = worldPixelsToCoordinate(boundaryX + 1, base.y, zoom);
  const adjacentCellPoints: SourceMapPoint[] = [
    { ...SYNTHETIC_SOURCE_POINTS[0]!, id: "osm-left-a", coordinates: [leftCoordinate[0], leftCoordinate[1]] },
    { ...SYNTHETIC_SOURCE_POINTS[1]!, id: "osm-left-b", coordinates: [leftCoordinate[0], leftCoordinate[1]] },
    { ...SYNTHETIC_SOURCE_POINTS[0]!, id: "osm-right-a", coordinates: [rightCoordinate[0], rightCoordinate[1]] },
    { ...SYNTHETIC_SOURCE_POINTS[1]!, id: "osm-right-b", coordinates: [rightCoordinate[0], rightCoordinate[1]] },
  ];
  const clusters = buildSourceMapDisplayItems(adjacentCellPoints, null, zoom, true)
    .flatMap((item) => item.type === "cluster" ? [item.cluster] : []);
  const anchorsBeforeLayout = clusters.map((cluster) => [...cluster.anchor]);
  const placements = layoutSourceMapClusterBadges(clusters, zoom);

  assert.equal(clusters.length, 2);
  assert.deepEqual(clusters.map((cluster) => cluster.count), [2, 2]);
  assert.equal(Math.abs(
    coordinateToWorldPixels(clusters[0]!.anchor, zoom).x - coordinateToWorldPixels(clusters[1]!.anchor, zoom).x,
  ), 2);
  assert.deepEqual(clusters.map((cluster) => cluster.memberIds), [
    ["osm-left-a", "osm-left-b"],
    ["osm-right-a", "osm-right-b"],
  ]);
  for (const cluster of clusters) {
    const memberPixels = cluster.members.map((member) => coordinateToWorldPixels(member.coordinates, zoom));
    const meanPixels = memberPixels.reduce(
      (mean, pixels) => ({ x: mean.x + pixels.x / memberPixels.length, y: mean.y + pixels.y / memberPixels.length }),
      { x: 0, y: 0 },
    );
    assert.deepEqual(cluster.anchor, worldPixelsToCoordinate(meanPixels.x, meanPixels.y, zoom));
  }
  assert.deepEqual(clusters.map((cluster) => [...cluster.anchor]), anchorsBeforeLayout);
  const first = placements.get(clusters[0]!.clusterId)!;
  const second = placements.get(clusters[1]!.clusterId)!;
  assert.ok(Math.hypot(first.x - second.x, first.y - second.y) >= 56);
});

test("selected unified points remain individual and do not affect the provider cluster count", () => {
  const items = buildSourceMapDisplayItems(CLUSTER_POINTS, "osm-hospital", 12, true);
  const selected = items.find((item) => item.type === "point" && item.point.id === "osm-hospital");
  const osm = items.find((item) => item.type === "cluster" && item.cluster.source === "osm");

  assert.ok(selected && selected.type === "point");
  assert.ok(osm && osm.type === "cluster");
  assert.equal(osm.cluster.count, 2);
  assert.deepEqual(osm.cluster.osmCategoryCounts, { hospital: 0, police: 1, fire_station: 1 });
  assert.deepEqual(osm.cluster.memberIds, ["osm-fire", "osm-police"]);
  assert.equal(items.reduce((count, item) => count + (item.type === "cluster" ? item.cluster.count : 1), 0), CLUSTER_POINTS.length);
});

test("unified clusters expand to individual records above zoom 15 and legacy mode never clusters", () => {
  assert.equal(buildSourceMapDisplayItems(CLUSTER_POINTS, null, 15, true).some((item) => item.type === "cluster"), true);
  const expanded = buildSourceMapDisplayItems(CLUSTER_POINTS, null, 17, true);
  assert.equal(expanded.some((item) => item.type === "cluster"), false);
  assert.deepEqual(expanded.map((item) => item.type === "point" ? item.point.id : ""), [
    "osm-fire", "osm-hospital", "osm-police", "peta-first", "peta-second", "usgs-first", "usgs-second",
  ]);
  assert.deepEqual(buildSourceMapDisplayItems(CLUSTER_POINTS, null, 12, false).map((item) => item.type), Array(7).fill("point"));
  assert.deepEqual([4, 15, 16, 18].map(clusterZoomTarget), [6, 17, 18, 18]);
});

test("invalid coordinates do not create display items", () => {
  const invalidPoints: SourceMapPoint[] = [
    { ...SYNTHETIC_SOURCE_POINTS[0]!, id: "invalid-nan", coordinates: [Number.NaN, -6.191] },
    { ...SYNTHETIC_SOURCE_POINTS[0]!, id: "invalid-range", coordinates: [181, 91] },
  ];
  assert.deepEqual(buildSourceMapDisplayItems(invalidPoints, null, 12, true), []);
});

test("unified SSR exposes display-group source, count, accessible category breakdown, and non-selection behavior", () => {
  const markup = renderToStaticMarkup(createElement(SourcePointMap, {
    points: CLUSTER_POINTS,
    selectedId: "osm-hospital",
    onSelect: () => {},
    viewMode: "unified",
  }));
  const clusterButtons = [...markup.matchAll(/<button\b[^>]*class="[^"]*source-point-map__cluster[^"]*"[^>]*>[\s\S]*?<\/button>/g)];

  assert.equal(clusterButtons.length, 3);
  const badgePositions = clusterButtons.map((match) => {
    const style = match[0].match(/style="([^"]+)"/)?.[1] ?? "";
    return style.match(/left:([^;]+);top:([^;]+)/)?.slice(1).join("|") ?? "";
  });
  assert.equal(new Set(badgePositions).size, 3);
  assert.ok(clusterButtons.every((match) => /data-layout-offset="/.test(match[0])));
  assert.match(clusterButtons.map((match) => match[0]).join(""), /<span class="source-point-map__cluster-source" aria-hidden="true">OSM<\/span>/);
  assert.match(clusterButtons.map((match) => match[0]).join(""), /<span class="source-point-map__cluster-source" aria-hidden="true">Peta<\/span>/);
  assert.match(clusterButtons.map((match) => match[0]).join(""), /<span class="source-point-map__cluster-source" aria-hidden="true">USGS<\/span>/);
  assert.match(markup, /data-source="osm"[^>]*data-count="2"[^>]*data-cluster-id="display-osm-12-/);
  assert.match(markup, /data-source="petabencana"[^>]*data-count="2"[^>]*data-cluster-id="display-petabencana-12-/);
  assert.match(markup, /data-source="usgs"[^>]*data-count="2"[^>]*data-cluster-id="display-usgs-12-/);
  assert.match(markup, /Kelompok tampilan berisi 2 catatan fasilitas rujukan OpenStreetMap/);
  assert.match(markup, /Rincian kategori: 1 kepolisian, 1 pemadam kebakaran/);
  assert.match(markup, /Aktifkan untuk memperbesar peta dua tingkat ke jangkar rata-rata anggota/);
  assert.match(markup, /data-record-id="osm-hospital"[^>]*data-selected="true"/);
  assert.match(markup, /Kelompok bernomor hanya untuk tampilan/);
  assert.match(markup, /simbol kelompok dapat bergeser otomatis agar setiap kelompok berdekatan dapat dipilih/);
  assert.doesNotMatch(clusterButtons.map((match) => match[0]).join(""), /aria-pressed|data-record-id|data-selected/);
  assert.ok(markup.indexOf('class="source-point-map__source-key"') < markup.indexOf('class="source-point-map__viewport"'));

  const legacy = renderToStaticMarkup(createElement(SourcePointMap, {
    points: CLUSTER_POINTS, selectedId: null, onSelect: () => {}, viewMode: "jakarta",
  }));
  assert.doesNotMatch(legacy, /source-point-map__cluster/);
  for (const point of CLUSTER_POINTS) assert.match(legacy, new RegExp(`data-record-id="${point.id}"`));
});

test("viewport culling applies after grouping while off-screen records remain counted as loaded", () => {
  const distantPoints: SourceMapPoint[] = [
    { ...SYNTHETIC_SOURCE_POINTS[3]!, id: "distant-peta-a", coordinates: [-73.98, 40.75] },
    { ...SYNTHETIC_SOURCE_POINTS[3]!, id: "distant-peta-b", coordinates: [-73.98, 40.75] },
  ];
  assert.equal(buildSourceMapDisplayItems(distantPoints, null, 12, true)[0]?.type, "cluster");
  const markup = renderToStaticMarkup(createElement(SourcePointMap, {
    points: distantPoints, selectedId: null, onSelect: () => {}, viewMode: "unified",
  }));

  assert.doesNotMatch(markup, /data-cluster-id=/);
  assert.match(markup, /Tidak ada titik sumber pada area peta yang terlihat/);
  assert.match(markup, /data-map-center="106\.83,-6\.19"/);
});

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

test("unified map renders all point sources with one viewport and an initially collapsed legend", () => {
  const quake: EarthquakeContextRecord = { ...SYNTHETIC_QUAKE, coordinates: [106.835, -6.195] };
  const markup = renderToStaticMarkup(createElement(SourcePointMap, {
    points: [...SYNTHETIC_SOURCE_POINTS, quake], selectedId: null, onSelect: () => {}, viewMode: "unified",
  }));
  assert.equal([...markup.matchAll(/data-map-zoom=/g)].length, 1);
  assert.match(markup, /data-map-center="106\.83,-6\.19"/);
  assert.match(markup, /data-map-zoom="12"/);
  for (const source of ["osm", "petabencana", "usgs"]) assert.match(markup, new RegExp(`data-source="${source}"`));
  assert.match(markup, /Peta terpadu fasilitas OpenStreetMap, laporan PetaBencana, dan episentrum USGS/);
  assert.match(markup, /<details class="source-point-map__legend-disclosure"><summary>/);
  assert.doesNotMatch(markup, /<details[^>]*\bopen/);
  assert.match(markup, /Jakarta awal/);
  assert.match(markup, /Kawasan gempa/);
  assert.match(markup, /Kesiapan layanan tidak diketahui/);
  assert.match(markup, /Pusat cakupan OSM adalah perkiraan, bukan pintu masuk/);
  assert.match(markup, /belum ditinjau Waspada/);
  assert.match(markup, /dampak di Jakarta belum ditetapkan/);
  assert.match(markup, /titik grid model tidak dipetakan sebagai kejadian/);
  assert.match(markup, /Jumlah mengikuti catatan yang dimuat dan filter daftar/);
  assert.match(markup, /© OpenStreetMap contributors/);
  assert.match(markup, /aria-label="Arti dan batas titik pada peta"[\s\S]*?kesiapan belum diketahui[\s\S]*?laporan belum ditinjau[\s\S]*?asal gempa, bukan dampak/);
  assert.ok(markup.indexOf('class="source-point-map__source-key"') < markup.indexOf('class="source-point-map__viewport"'));
});

test("unified selections use the source scale while legacy initial selections keep their mode", () => {
  for (const [point, zoom] of [[SYNTHETIC_QUAKE, 6], [SYNTHETIC_SOURCE_POINTS[0]!, 12]] as const) {
    const markup = renderToStaticMarkup(createElement(SourcePointMap, {
      points: [point], selectedId: point.id, onSelect: () => {}, viewMode: "unified",
    }));
    assert.match(markup, new RegExp(`data-map-zoom="${zoom}"`));
    assert.match(markup, new RegExp(`data-map-center="${point.coordinates.join(",")}"`));
    assert.match(markup, /data-selected="true"/);
  }
  const legacy = renderToStaticMarkup(createElement(SourcePointMap, {
    points: [SYNTHETIC_QUAKE], selectedId: SYNTHETIC_QUAKE.id, onSelect: () => {},
  }));
  assert.match(legacy, /data-map-zoom="12"/);
});

test("unified empty states retain every source legend without inventing safety or points", () => {
  const markup = renderToStaticMarkup(createElement(SourcePointMap, {
    points: [], selectedId: "missing", onSelect: () => {}, viewMode: "unified",
  }));
  assert.match(markup, /Hasil kosong tidak menyatakan bahwa wilayah aman/);
  assert.match(markup, /Fasilitas rujukan OSM/);
  assert.match(markup, /Laporan warga PetaBencana/);
  assert.match(markup, /Katalog gempa USGS/);
  assert.doesNotMatch(markup, /data-record-id=/);
  assert.doesNotMatch(markup, /data-kind="weather"|data-source="open_meteo"/);
});
