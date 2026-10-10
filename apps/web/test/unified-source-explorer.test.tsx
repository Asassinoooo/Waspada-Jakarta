import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  CONTEXT_SOURCE_POLICY,
  type ContextSourcesPayload,
  type EarthquakeContextRecord,
  type EarthquakeContextSource,
  type WeatherContextSource,
} from "@waspada/worker/context-sources-contracts";
import type { PreviewRecord, PreviewSource, SourcePreviewPayload } from "@waspada/worker/source-preview-contracts";
import {
  collectUnifiedSourcePoints,
  filterUnifiedSourcePoints,
  resolveVisibleSourceSelection,
  retainVisibleSourceSelection,
  UnifiedSourceExplorerView,
  type UnifiedSourceExplorerViewProps,
} from "../src/UnifiedSourceExplorer.js";

const generatedAt = "2026-10-10T05:10:00.000Z";
const fetchedAt = "2026-10-10T05:05:00.000Z";
const osmRecord: PreviewRecord = {
  id: "osm:node/123", source: "osm", kind: "hospital", title: "Rumah Sakit Contoh",
  coordinates: [106.82, -6.2], coordinate_kind: "source_point", source_created_at: null,
  source_status: null, source_url: "https://www.openstreetmap.org/node/123",
};
const floodRecord: PreviewRecord = {
  id: "petabencana:report_123", source: "petabencana", kind: "flood_report", title: "Laporan banjir warga",
  coordinates: [106.83, -6.19], coordinate_kind: "source_point", source_created_at: fetchedAt,
  source_status: "reported", source_url: "https://petabencana.id/",
};
const quakeRecord: EarthquakeContextRecord = {
  id: "usgs:us7000sample", source: "usgs", kind: "earthquake", title: "Gempa bumi · Lampung",
  coordinates: [105.25, -5.4], coordinate_kind: "source_point", event_time: "2026-10-09T03:12:00.000Z",
  updated_at: "2026-10-10T04:59:00.000Z", magnitude: 4.2, magnitude_type: "mb", depth_km: 35.4,
  source_status: "reviewed", source_url: "https://earthquake.usgs.gov/earthquakes/eventpage/us7000sample",
};

function previewSource(id: PreviewSource["id"]): PreviewSource {
  return id === "osm" ? {
    id, status: "available", data_mode: "snapshot", fetched_at: fetchedAt, source_updated_at: fetchedAt,
    attribution: "© OpenStreetMap contributors · ODbL 1.0", license_url: "https://opendatacommons.org/licenses/odbl/1-0/",
    records: [osmRecord], rejected_count: 0, limited: false, error: null,
  } : {
    id, status: "available", data_mode: "fetched", fetched_at: fetchedAt, source_updated_at: null,
    attribution: "Data disediakan oleh PetaBencana.id, dilisensikan di bawah CC BY-NC 4.0.",
    license_url: "https://creativecommons.org/licenses/by-nc/4.0/", records: [floodRecord],
    rejected_count: 0, limited: false, error: null,
  };
}
const previewPayload: SourcePreviewPayload = {
  schema_version: "source-preview-v1", mode: "source_preview", generated_at: generatedAt, cached: false,
  sources: [previewSource("osm"), previewSource("petabencana")],
};

function weatherSource(): WeatherContextSource {
  return {
    id: "openmeteo", status: "available", data_mode: "fetched", fetched_at: fetchedAt,
    source_updated_at: null, attribution: CONTEXT_SOURCE_POLICY.weatherAttribution,
    license_url: CONTEXT_SOURCE_POLICY.weatherLicenseUrl, source_url: CONTEXT_SOURCE_POLICY.weatherSourceUrl,
    rejected_count: 0, limited: false, error: null,
    forecast: {
      requested_coordinates: [106.82, -6.2], model_coordinates: [106.856186, -6.221441],
      hours: [
        { valid_at: "2026-10-10T05:00:00.000Z", temperature_c: 26.5, precipitation_probability_pct: null, precipitation_mm: 0.2, weather_code: 61, wind_speed_kmh: null },
        { valid_at: "2026-10-10T06:00:00.000Z", temperature_c: null, precipitation_probability_pct: 40, precipitation_mm: null, weather_code: 3, wind_speed_kmh: 10 },
      ],
    },
  };
}
function quakeSource(): EarthquakeContextSource {
  return {
    id: "usgs", status: "available", data_mode: "fetched", fetched_at: fetchedAt,
    source_updated_at: "2026-10-10T05:04:00.000Z", attribution: CONTEXT_SOURCE_POLICY.earthquakeAttribution,
    license_url: CONTEXT_SOURCE_POLICY.earthquakeLicenseUrl, source_url: CONTEXT_SOURCE_POLICY.earthquakeSourceUrl,
    rejected_count: 0, limited: false, error: null, records: [quakeRecord],
    window_start: "2026-10-03T05:05:00.000Z", window_end: fetchedAt,
  };
}
const contextPayload: ContextSourcesPayload = {
  schema_version: "context-sources-v1", mode: "source_context", generated_at: generatedAt, cached: false,
  sources: [weatherSource(), quakeSource()],
};

function renderView(overrides: Partial<UnifiedSourceExplorerViewProps> = {}): string {
  const props: UnifiedSourceExplorerViewProps = {
    datasetMode: "demo", sourcePayload: previewPayload, sourceRequest: { status: "loaded", mode: "snapshot" },
    contextPayload, contextRequest: { status: "loaded", mode: "local" },
    onSourceRequest: () => {}, onContextRequest: () => {}, ...overrides,
  };
  return renderToStaticMarkup(createElement(UnifiedSourceExplorerView, props));
}
test("mixed providers share source, kind, and search filtering and hidden selections resolve to null", () => {
  const points = collectUnifiedSourcePoints(previewPayload, contextPayload);
  assert.deepEqual(points.map((point) => point.source), ["osm", "petabencana", "usgs"]);
  assert.deepEqual(filterUnifiedSourcePoints(points, { source: "usgs" }).map((point) => point.id), [quakeRecord.id]);
  assert.deepEqual(filterUnifiedSourcePoints(points, { kind: "hospital" }).map((point) => point.id), [osmRecord.id]);
  assert.deepEqual(filterUnifiedSourcePoints(points, { query: "  LAMPUNG  " }).map((point) => point.id), [quakeRecord.id]);
  assert.deepEqual(filterUnifiedSourcePoints(points, { source: "petabencana", kind: "earthquake" }), []);
  const visible = filterUnifiedSourcePoints(points, { source: "osm" });
  assert.equal(resolveVisibleSourceSelection(visible, osmRecord.id), osmRecord);
  assert.equal(resolveVisibleSourceSelection(visible, quakeRecord.id), null);
  assert.equal(resolveVisibleSourceSelection(visible, null), null);
});

test("selection clears when filtered out and stays cleared after the filter is restored", () => {
  const points = collectUnifiedSourcePoints(previewPayload, contextPayload);
  const selectedId = quakeRecord.id;

  assert.equal(retainVisibleSourceSelection(points, selectedId), selectedId);
  assert.equal(retainVisibleSourceSelection(filterUnifiedSourcePoints(points, { source: "osm" }), selectedId), null);
  assert.equal(retainVisibleSourceSelection(points, null), null);
  assert.equal(retainVisibleSourceSelection(filterUnifiedSourcePoints(points, { source: "usgs" }), selectedId), selectedId);
});

test("renders one map callback before one companion panel with only supported point records", () => {
  const mapCalls: string[][] = [];
  let selectedAtMap: string | null = "unset";
  const markup = renderView({
    renderMap(points, selectedId) {
      mapCalls.push(points.map((point) => point.id));
      selectedAtMap = selectedId;
      return createElement("div", { "data-testid": "map" }, points.map((point) => point.source).join(","));
    },
  });
  assert.equal(mapCalls.length, 1);
  assert.deepEqual(mapCalls[0], [osmRecord.id, floodRecord.id, quakeRecord.id]);
  assert.equal(selectedAtMap, null);
  assert.ok(markup.includes('data-testid="map"'));
  assert.ok(markup.indexOf("data-testid=\"map\"") < markup.indexOf("aria-label=\"Panel sumber\""));
  assert.equal((markup.match(/data-testid="map"/gu) ?? []).length, 1);
  assert.match(markup, /OpenStreetMap/);
  assert.match(markup, /PetaBencana\.id/);
  assert.match(markup, /USGS/);
  assert.doesNotMatch(markup, /106\.856186/);
});

test("a context-group error preserves the loaded source group and reports partial availability", () => {
  const mapPoints: string[][] = [];
  const markup = renderView({
    contextPayload: null,
    contextRequest: { status: "error", mode: "fetch", message: "Permintaan konteks gagal." },
    renderMap(points) {
      mapPoints.push(points.map((point) => point.id));
      return createElement("div", { "data-testid": "map" }, "peta");
    },
  });
  assert.deepEqual(mapPoints, [[osmRecord.id, floodRecord.id]]);
  assert.match(markup, /Permintaan konteks gagal\./);
  assert.match(markup, /Open-Meteo[\s\S]*?Gagal dimuat/);
  assert.match(markup, /OSM[\s\S]*?Ada record/);
  assert.match(markup, /PetaBencana[\s\S]*?Ada record/);
});

test("a source-group error leaves loaded regional catalog points usable", () => {
  const mapPoints: string[][] = [];
  const markup = renderView({
    sourcePayload: null,
    sourceRequest: { status: "error", mode: "fetch", message: "Permintaan fasilitas gagal." },
    renderMap(points) {
      mapPoints.push(points.map((point) => point.id));
      return createElement("div", { "data-testid": "map" }, "peta");
    },
  });
  assert.deepEqual(mapPoints, [[quakeRecord.id]]);
  assert.match(markup, /Permintaan fasilitas gagal\./);
  assert.match(markup, /USGS[\s\S]*?Ada record/);
});
test("the source panel keeps snapshot mode, provider times, attribution, and licence links inspectable", () => {
  const markup = renderView({ defaultPanel: "sumber" });
  assert.match(markup, /Snapshot lokal/);
  assert.match(markup, /Respons dibuat/);
  assert.match(markup, /Waktu basis data OpenStreetMap/);
  assert.match(markup, /ODbL 1\.0/);
  assert.match(markup, /CC BY-NC 4\.0/);
  assert.match(markup, /Lisensi \/ kredit/);
  assert.match(markup, /Tidak tersedia dari penyedia/);
});

test("the Sumber panel shows USGS scope and its time window for an empty fetched catalogue", () => {
  const emptyEarthquakeSource: EarthquakeContextSource = { ...quakeSource(), status: "empty", records: [] };
  const emptyContextPayload: ContextSourcesPayload = {
    ...contextPayload,
    sources: [weatherSource(), emptyEarthquakeSource],
  };
  const markup = renderView({ defaultPanel: "sumber", contextPayload: emptyContextPayload });

  assert.match(markup, /Respons kosong/);
  assert.match(markup, /Jendela katalog USGS/);
  assert.match(markup, /Kueri katalog USGS/);
  assert.match(markup, /magnitudo ≥ 2,5/);
  assert.match(markup, /7 hari · maksimal 30 record/);
  assert.match(markup, /104° BT–110° BT/);
  assert.match(markup, /4°–9,5° LS/);
  assert.match(markup, /bukan batas bahaya resmi atau area dampak Jakarta/);
});

test("the weather panel preserves unknown forecast fields and never adds a weather point", () => {
  const mapPoints: string[][] = [];
  const markup = renderView({
    defaultPanel: "cuaca",
    renderMap(points) {
      mapPoints.push(points.map((point) => point.id));
      return createElement("div", { "data-testid": "map" }, points.map((point) => point.source).join(","));
    },
  });
  assert.deepEqual(mapPoints, [[osmRecord.id, floodRecord.id, quakeRecord.id]]);
  assert.match(markup, /Tidak diketahui/);
  assert.match(markup, /Data model ini bukan peringatan banjir atau kejadian yang diamati\./);
  assert.match(markup, /Koordinat grid model dijelaskan di tabel/);
  assert.doesNotMatch(mapPoints[0]?.join(" ") ?? "", /openmeteo|weather|106\.856186/u);
});

test("live and unknown modes ignore even supplied demo payloads and keep the single map empty", () => {
  for (const datasetMode of ["live", null] as const) {
    const mapPoints: string[][] = [];
    const markup = renderView({
      datasetMode,
      renderMap(points) {
        mapPoints.push(points.map((point) => point.id));
        return createElement("div", { "data-testid": "map" }, "peta");
      },
    });
    assert.deepEqual(mapPoints, [[]]);
    assert.doesNotMatch(markup, /Rumah Sakit Contoh|Gempa bumi · Lampung/);
    assert.match(markup, /tidak ada permintaan sumber yang dilakukan|Tidak ada data atau permintaan/i);
    assert.equal((markup.match(/data-testid="map"/gu) ?? []).length, 1);
  }
});
