import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { PublicGeoJSONGeometry, PublicGeoJSONPosition } from "@waspada/worker/public-contracts";
import type { AdminItem, AdminMapProps } from "../src/admin-types.js";
import {
  ADMIN_MAP_DEFAULT_VIEW, AdminOperationsMap, adminGeometryBounds, adminGeometryPositions,
  adminItemGeometries, createAdminMapProjection, fitAdminMapBounds,
  isRenderableAdminGeometry, panAdminMapView, zoomAdminMapView,
} from "../src/AdminOperationsMap.js";

function item(overrides: Partial<AdminItem> = {}): AdminItem {
  return {
    id: "synthetic-map-record", title: "Contoh fiktif: alur geometri", summary: "Kasus buatan untuk pengujian.",
    category: "disasters_weather", layer: "L3", state: "held", operationalPriority: "attention",
    placeLabel: "Koordinat contoh", geometry: { type: "Point", coordinates: [106.8, -6.2] },
    geometryBasis: "synthetic_example", geometryNote: "Geometri sintetis; bukan lokasi kejadian.",
    sourceNames: ["Sumber fiktif"], eventVersion: null, publicEventId: null, datasetKind: "synthetic",
    observedAt: null, fetchedAt: null, publishedAt: null, evidenceSummary: "Bukti fiktif.",
    stopReason: "Anggaran contoh selesai", nextStep: "Tinjau contoh", budget: null, steps: [], ...overrides,
  };
}

function sourceItem(overrides: Partial<AdminItem> = {}): AdminItem {
  return item({ id: "source-map-record", title: "Record API untuk pengujian", geometryBasis: "source_supported",
    datasetKind: "historical", publicEventId: "public-event", eventVersion: 3,
    geometryNote: "Koordinat dari respons publik.", ...overrides });
}

function render(props: Partial<AdminMapProps> = {}): string {
  return renderToStaticMarkup(<AdminOperationsMap items={[item()]} selectedId={null} onSelect={() => {}} mode="simulation" {...props} />);
}

const geometries: PublicGeoJSONGeometry[] = [
  { type: "Point", coordinates: [106.8, -6.2] },
  { type: "MultiPoint", coordinates: [[106.7, -6.1], [106.85, -6.3]] },
  { type: "LineString", coordinates: [[106.7, -6.1], [106.8, -6.25], [106.9, -6.3]] },
  { type: "MultiLineString", coordinates: [[[106.7, -6.2], [106.8, -6.15]], [[106.82, -6.23], [106.9, -6.3]]] },
  { type: "Polygon", coordinates: [
    [[106.72, -6.13], [106.88, -6.13], [106.88, -6.29], [106.72, -6.29], [106.72, -6.13]],
    [[106.77, -6.18], [106.82, -6.18], [106.82, -6.23], [106.77, -6.23], [106.77, -6.18]],
  ] },
  { type: "MultiPolygon", coordinates: [
    [[[106.75, -6.15], [106.79, -6.15], [106.77, -6.19], [106.75, -6.15]]],
    [[[106.83, -6.23], [106.9, -6.23], [106.87, -6.28], [106.83, -6.23]]],
  ] },
];

function nearly(actual: number, expected: number): void { assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} ≈ ${expected}`); }

test("CRS84 projection preserves order, north orientation, local aspect and reversible coordinates at wide/narrow sizes", () => {
  for (const size of [{ width: 900, height: 520 }, { width: 288, height: 416 }, { width: 288, height: 832, textScale: 2 }]) {
    const projection = createAdminMapProjection(ADMIN_MAP_DEFAULT_VIEW, size);
    const center: PublicGeoJSONPosition = [(ADMIN_MAP_DEFAULT_VIEW.west + ADMIN_MAP_DEFAULT_VIEW.east) / 2, (ADMIN_MAP_DEFAULT_VIEW.south + ADMIN_MAP_DEFAULT_VIEW.north) / 2];
    const [cx, cy] = projection.project(center);
    nearly(cx, projection.plot.left + projection.plot.width / 2);
    nearly(cy, projection.plot.top + projection.plot.height / 2);
    const east = projection.project([center[0] + 0.1, center[1]]);
    const north = projection.project([center[0], center[1] + 0.1]);
    assert.ok(east[0] > cx && north[1] < cy);
    nearly((east[0] - cx) / (cy - north[1]), Math.cos(-6.2 * Math.PI / 180));
    for (const coordinate of [[106.32, -5.16], [106.98, -6.4], [106.8, -6.2]] as PublicGeoJSONPosition[]) {
      const [x, y] = projection.project(coordinate);
      const [longitude, latitude] = projection.unproject(x, y);
      nearly(longitude, coordinate[0]); nearly(latitude, coordinate[1]);
    }
    assert.ok(projection.visibleBounds.west <= ADMIN_MAP_DEFAULT_VIEW.west + 1e-9);
    assert.ok(projection.visibleBounds.east >= ADMIN_MAP_DEFAULT_VIEW.east - 1e-9);
    assert.ok(projection.visibleBounds.south <= ADMIN_MAP_DEFAULT_VIEW.south + 1e-9);
    assert.ok(projection.visibleBounds.north >= ADMIN_MAP_DEFAULT_VIEW.north - 1e-9);
  }
});

test("all six public geometry variants, polygon holes and additional geometries render under their exact record selection", () => {
  const record = sourceItem({ geometry: geometries[0], additionalGeometries: geometries.slice(1) });
  const markup = render({ mode: "public_api", items: [record], selectedId: record.id });
  assert.equal((markup.match(/data-admin-map-item=/g) ?? []).length, 1);
  assert.match(markup, /data-admin-map-item="source-map-record" data-geometry-basis="source_supported"/);
  assert.match(markup, /aria-pressed="true"/);
  assert.match(markup, /6 geometri · Didukung sumber/);
  assert.equal((markup.match(/data-geometry="Point"/g) ?? []).length, 3);
  assert.equal((markup.match(/data-geometry="LineString"/g) ?? []).length, 3);
  assert.equal((markup.match(/data-geometry="Polygon"/g) ?? []).length, 3);
  assert.equal((markup.match(/fill-rule="evenodd"/g) ?? []).length, 3);
  const polygon = markup.match(/data-geometry="Polygon"[^>]*d="([^"]+)"/)?.[1];
  assert.ok(polygon);
  assert.equal((polygon.match(/ Z/g) ?? []).length, 2, "exterior and interior remain separate closed paths");
  assert.match(markup, /data-source-coordinate="106\.8,-6\.2"/);
});

test("geometry validation rejects malformed, incomplete, nonfinite and out-of-envelope shapes without guessing geometry", () => {
  const rejected: unknown[] = [
    null, {}, { type: "GeometryCollection", geometries: [] }, { type: "Point", coordinates: [106.8, -6.2, 20] },
    { type: "Point", coordinates: [NaN, -6.2] }, { type: "Point", coordinates: [106.8, Infinity] },
    { type: "Point", coordinates: [106.319, -6.2] }, { type: "Point", coordinates: [106.981, -6.2] },
    { type: "Point", coordinates: [106.8, -6.401] }, { type: "Point", coordinates: [106.8, -5.159] },
    { type: "MultiPoint", coordinates: [] }, { type: "LineString", coordinates: [[106.8, -6.2]] },
    { type: "MultiLineString", coordinates: [[]] }, { type: "Polygon", coordinates: [] },
    { type: "Polygon", coordinates: [[[106.7, -6.1], [106.8, -6.1], [106.8, -6.2], [106.71, -6.11]]] },
    { type: "Polygon", coordinates: [[[106.7, -6.1], [106.8, -6.1], [106.7, -6.1]]] },
    { type: "MultiPolygon", coordinates: [[[]]] },
  ];
  for (const geometry of rejected) assert.equal(isRenderableAdminGeometry(geometry), false);
  for (const geometry of geometries) assert.equal(isRenderableAdminGeometry(geometry), true);
  assert.equal(isRenderableAdminGeometry({ type: "MultiPoint", coordinates: [[106.32, -6.4], [106.98, -5.16]] }), true);
  const bad = item({ additionalGeometries: [{ type: "Point", coordinates: [107, -6.2] }] });
  assert.deepEqual(adminItemGeometries(bad, "simulation"), [], "one invalid part cannot silently disappear");
  const malformedExtras = item({ additionalGeometries: {} as PublicGeoJSONGeometry[] });
  assert.deepEqual(adminItemGeometries(malformedExtras, "simulation"), []);
  assert.doesNotMatch(render({ items: [bad], selectedId: bad.id }), /data-admin-map-item=/);
});

test("API and simulation provenance stay separate and public geometry requires an exact public event identity", () => {
  const demo = item();
  const source = sourceItem();
  assert.deepEqual(adminItemGeometries(demo, "public_api"), []);
  assert.deepEqual(adminItemGeometries(source, "simulation"), []);
  assert.deepEqual(adminItemGeometries(sourceItem({ publicEventId: null }), "public_api"), []);
  assert.deepEqual(adminItemGeometries(sourceItem({ eventVersion: 1.1 }), "public_api"), []);
  assert.equal(adminItemGeometries(sourceItem({ datasetKind: "synthetic" }), "public_api").length, 1);
  assert.deepEqual(adminItemGeometries(item({ datasetKind: "live" }), "simulation"), []);
  const apiMarkup = render({ mode: "public_api", items: [demo, source] });
  assert.match(apiMarkup, /data-admin-map-item="source-map-record"/);
  assert.doesNotMatch(apiMarkup, /data-admin-map-item="synthetic-map-record"/);
  assert.match(apiMarkup, /Geometri respons API/);
  assert.match(apiMarkup, /1 tidak dipetakan · tetap di antrean/);
  const simulationMarkup = render({ items: [demo, source] });
  assert.match(simulationMarkup, /data-admin-map-item="synthetic-map-record"/);
  assert.doesNotMatch(simulationMarkup, /data-admin-map-item="source-map-record"/);
  assert.match(simulationMarkup, /Geometri fiktif/);
  assert.match(simulationMarkup, /Bidang sintetis/);
});

test("synthetic API records retain returned geometry, dataset labels and public-projection semantics without simulator overlays", () => {
  const syntheticApi = sourceItem({ id: "api-synthetic", datasetKind: "synthetic", geometry: { type: "Point", coordinates: [106.88, -6.31] } });
  const markup = render({ mode: "public_api", items: [item(), syntheticApi], selectedId: syntheticApi.id });
  assert.match(markup, /data-admin-map-item="api-synthetic"/);
  assert.match(markup, /data-source-coordinate="106\.88,-6\.31"/);
  assert.doesNotMatch(markup, /data-source-coordinate="106\.8,-6\.2"/);
  assert.match(markup, /Proyeksi event publik · Record tersedia/);
  assert.match(markup, /Dataset record: Sintetis API · bukan peringatan langsung/);
  assert.match(markup, /geometri didukung sumber; dataset Sintetis API/);
  assert.match(markup, /Tahap internal dan status pemrosesan tidak tersedia/);
  assert.doesNotMatch(markup, /Tahap operasi|Status pemrosesan|Selesai diproses|Pemrosesan:/);
});

test("positions, rings and bounds are preserved through repeated rendering, fit and projection", () => {
  const record = sourceItem({ geometry: geometries[0], additionalGeometries: geometries.slice(1) });
  const original = JSON.stringify(record);
  const freeze = (value: unknown): void => {
    if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); }
  };
  freeze(record);
  const supported = adminItemGeometries(record, "public_api");
  const bounds = adminGeometryBounds(supported);
  assert.deepEqual(bounds, { west: 106.7, south: -6.3, east: 106.9, north: -6.1 });
  const fitted = fitAdminMapBounds(bounds!);
  const projection = createAdminMapProjection(fitted, { width: 760, height: 520 });
  for (const geometry of supported) for (const position of adminGeometryPositions(geometry)) projection.project(position);
  render({ mode: "public_api", items: [record], selectedId: record.id });
  render({ mode: "public_api", items: [record] });
  assert.equal(JSON.stringify(record), original);
});

test("fit includes island positions beyond the mainland default and remains usable for a single point", () => {
  const island: PublicGeoJSONGeometry = { type: "Point", coordinates: [106.45, -5.3] };
  const bounds = adminGeometryBounds([geometries[0]!, island])!;
  const fitted = fitAdminMapBounds(bounds);
  const projection = createAdminMapProjection(fitted, { width: 288, height: 416 });
  for (const position of [[106.8, -6.2], [106.45, -5.3]] as PublicGeoJSONPosition[]) {
    const [x, y] = projection.project(position);
    assert.ok(x >= projection.plot.left && x <= projection.plot.left + projection.plot.width);
    assert.ok(y >= projection.plot.top && y <= projection.plot.top + projection.plot.height);
  }
  assert.ok(fitted.north > ADMIN_MAP_DEFAULT_VIEW.north);
  const single = fitAdminMapBounds({ west: 106.8, east: 106.8, south: -6.2, north: -6.2 });
  assert.ok(single.east > single.west && single.north > single.south);
  assert.deepEqual(adminGeometryBounds([]), null);
  const islandMarkup = render({ items: [item({ geometry: island })] });
  assert.match(islandMarkup, /Geometri di luar tampilan/);
  assert.match(islandMarkup, /0 dalam bingkai · 1 di luar/);
  assert.match(islandMarkup, /Muat di bingkai/);
});

test("camera pan and bounded zoom preserve geometry-independent center and finite spans", () => {
  const view = { ...ADMIN_MAP_DEFAULT_VIEW };
  const moved = panAdminMapView(view, 0.1, -0.2);
  nearly(moved.west - view.west, 0.1); nearly(moved.south - view.south, -0.2);
  nearly(moved.east - moved.west, view.east - view.west);
  const zoomed = zoomAdminMapView(view, 1.5);
  nearly((zoomed.west + zoomed.east) / 2, (view.west + view.east) / 2);
  nearly((zoomed.south + zoomed.north) / 2, (view.south + view.north) / 2);
  nearly(zoomed.north - zoomed.south, (view.north - view.south) / 1.5);
  assert.ok(zoomAdminMapView(view, 1e9).north - zoomAdminMapView(view, 1e9).south >= 0.008 - 1e-9);
  assert.ok(zoomAdminMapView(view, 1e-9).north - zoomAdminMapView(view, 1e-9).south <= 2.4 + 1e-9);
});

test("selection labels expose title, category, processing state, stage and provenance with accessible controls", () => {
  const chosen = item({ title: "Judul pilihan sangat panjang ".repeat(12) });
  const markup = render({ items: [chosen, item({ id: "other", layer: "L4", state: "done", geometry: { type: "Point", coordinates: [106.9, -6.1] } })], selectedId: chosen.id });
  assert.match(markup, /role="button" tabindex="0" aria-label="Judul pilihan/);
  assert.match(markup, /kategori Bencana dan cuaca; tahap L3 Investigasi; status pemrosesan Ditahan; geometri contoh sintetis/);
  assert.match(markup, /aria-pressed="true"/);
  assert.match(markup, /aria-pressed="false"/);
  assert.match(markup, /Status pemrosesan/);
  assert.match(markup, /Tahap operasi/);
  for (const label of ["Perkecil koordinat", "Perbesar koordinat", "Geser ke barat", "Geser ke utara", "Geser ke selatan", "Geser ke timur", "Cakupan tampilan koordinat"]) assert.ok(markup.includes(label));
  assert.match(markup, /Fokus pilihan/);
  assert.match(markup, /tabindex="0" aria-label="Kanvas koordinat geografis/);
  assert.match(markup, /Enter \/ Spasi memilih geometri/);
  assert.match(markup, /bukan batas wilayah/);
  assert.match(markup, /tidak menilai bahaya atau membuat radius/);
  assert.doesNotMatch(markup, /<image|https?:|geolocation|heatmap|severity/);
});

test("empty, selected unmapped and stale selection states remain honest and useful", () => {
  const noItems = render({ items: [], selectedId: "no-longer-loaded" });
  assert.match(noItems, /Belum ada record pada subset ini/);
  assert.match(noItems, /Hasil kosong bukan pernyataan bahwa area aman/);
  assert.match(noItems, /Belum ada pilihan/);
  assert.doesNotMatch(noItems, /aria-pressed="true"/);
  const unmapped = item({ id: "non-geographic", geometry: null, geometryBasis: "none", title: "Pemberitahuan kelompok contoh", category: "group_specific_critical_notices" });
  const markup = render({ items: [unmapped], selectedId: unmapped.id });
  assert.match(markup, /Geometri belum tersedia/);
  assert.match(markup, /Pemberitahuan kelompok contoh/);
  assert.match(markup, /Tidak dipetakan — geometri yang sesuai mode belum tersedia/);
  assert.match(markup, /Koordinat tidak ditebak/);
  assert.match(markup, /disabled="">Fokus pilihan/);
  assert.doesNotMatch(markup, /data-admin-map-item=/);
  const onlyExtras = item({ geometry: null, additionalGeometries: [geometries[0]!] });
  assert.equal(adminItemGeometries(onlyExtras, "simulation").length, 1);
});
