import assert from "node:assert/strict";
import test from "node:test";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  CONTEXT_SOURCE_POLICY,
  type ContextSourcesPayload,
  type EarthquakeContextRecord,
  type EarthquakeContextSource,
  type WeatherContextSource,
} from "@waspada/worker/context-sources-contracts";
import {
  ContextSourcesHttpError,
  ContextSourcesPayloadError,
  ContextSourcesTimeoutError,
  getContextSources,
  validateContextSourcesPayload,
  type ContextSourcesClock,
} from "../src/context-sources-client.js";
import {
  ContextSources,
  EarthquakeContextCard,
  EarthquakeRecordDetails,
  WeatherContextCard,
} from "../src/ContextSources.js";

const generatedAt = "2026-10-10T05:10:00.000Z";
const fetchedAt = "2026-10-10T05:05:00.000Z";
const windowEnd = fetchedAt;
const windowStart = "2026-10-03T05:05:00.000Z";

const quakeRecord: EarthquakeContextRecord = {
  id: "usgs:us7000sample",
  source: "usgs",
  kind: "earthquake",
  title: "Gempa bumi · 18 km southeast of Bandar Lampung, Indonesia",
  coordinates: [105.25, -5.4],
  coordinate_kind: "source_point",
  event_time: "2026-10-09T03:12:00.000Z",
  updated_at: "2026-10-10T04:59:00.000Z",
  magnitude: 4.2,
  magnitude_type: "mb",
  depth_km: 35.4,
  source_status: "reviewed",
  source_url: "https://earthquake.usgs.gov/earthquakes/eventpage/us7000sample",
};

function weatherSource(overrides: Partial<WeatherContextSource> = {}): WeatherContextSource {
  return {
    id: "openmeteo",
    status: "not_requested",
    data_mode: "none",
    fetched_at: null,
    source_updated_at: null,
    attribution: CONTEXT_SOURCE_POLICY.weatherAttribution,
    license_url: CONTEXT_SOURCE_POLICY.weatherLicenseUrl,
    source_url: CONTEXT_SOURCE_POLICY.weatherSourceUrl,
    rejected_count: 0,
    limited: false,
    error: null,
    forecast: null,
    ...overrides,
  };
}

function quakeSource(overrides: Partial<EarthquakeContextSource> = {}): EarthquakeContextSource {
  return {
    id: "usgs",
    status: "not_requested",
    data_mode: "none",
    fetched_at: null,
    source_updated_at: null,
    attribution: CONTEXT_SOURCE_POLICY.earthquakeAttribution,
    license_url: CONTEXT_SOURCE_POLICY.earthquakeLicenseUrl,
    source_url: CONTEXT_SOURCE_POLICY.earthquakeSourceUrl,
    rejected_count: 0,
    limited: false,
    error: null,
    records: [],
    window_start: null,
    window_end: null,
    ...overrides,
  };
}

function availableWeather(overrides: Partial<WeatherContextSource> = {}): WeatherContextSource {
  return weatherSource({
    status: "available",
    data_mode: "fetched",
    fetched_at: fetchedAt,
    forecast: {
      requested_coordinates: [106.82, -6.2],
      model_coordinates: [106.856186, -6.221441],
      hours: [
        {
          valid_at: "2026-10-10T05:00:00.000Z",
          temperature_c: 26.5,
          precipitation_probability_pct: null,
          precipitation_mm: 0.2,
          weather_code: 61,
          wind_speed_kmh: null,
        },
        {
          valid_at: "2026-10-10T06:00:00.000Z",
          temperature_c: null,
          precipitation_probability_pct: 40,
          precipitation_mm: null,
          weather_code: 3,
          wind_speed_kmh: 10,
        },
      ],
    },
    ...overrides,
  });
}

function availableQuakes(overrides: Partial<EarthquakeContextSource> = {}): EarthquakeContextSource {
  return quakeSource({
    status: "available",
    data_mode: "fetched",
    fetched_at: fetchedAt,
    source_updated_at: "2026-10-10T05:04:00.000Z",
    records: [quakeRecord],
    window_start: windowStart,
    window_end: windowEnd,
    ...overrides,
  });
}

function payload(sources: [WeatherContextSource, EarthquakeContextSource], cached = false): ContextSourcesPayload {
  return { schema_version: "context-sources-v1", mode: "source_context", generated_at: generatedAt, cached, sources };
}

function localPayload(): ContextSourcesPayload {
  return payload([weatherSource(), quakeSource()]);
}

function fetchedPayload(): ContextSourcesPayload {
  return payload([availableWeather(), availableQuakes()]);
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function jsonResponse(value: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });
}

function createManualClock() {
  let callback: (() => void) | null = null;
  let delay = 0;
  const clock: ContextSourcesClock = {
    setTimeout(next, delayMs) {
      callback = next;
      delay = delayMs;
      return 1;
    },
    clearTimeout() {
      callback = null;
    },
  };
  return {
    clock,
    get delayMs() { return delay; },
    expire() {
      const deadline = callback;
      if (!deadline) throw new Error("No active context request deadline");
      callback = null;
      deadline();
    },
  };
}

function markup(node: ReactNode): string {
  return renderToStaticMarkup(node);
}

test("validates and copies the not_requested default with closed metadata and provenance", () => {
  const input = localPayload();
  const result = validateContextSourcesPayload(input);
  assert.deepEqual(result, input);
  assert.notEqual(result, input);
  assert.notEqual(result.sources[0], input.sources[0]);
  assert.equal(result.sources[0].status, "not_requested");
  assert.equal(result.sources[1].status, "not_requested");
  assert.equal(result.sources[0].forecast, null);
  assert.deepEqual(result.sources[1].records, []);
});

test("validates bounded model hours and USGS provenance while preserving null values", () => {
  const input = fetchedPayload();
  const result = validateContextSourcesPayload(input);
  const hour = result.sources[0].forecast?.hours[0];
  assert.equal(hour?.temperature_c, 26.5);
  assert.equal(hour?.precipitation_probability_pct, null);
  assert.equal(hour?.precipitation_mm, 0.2);
  assert.equal(hour?.wind_speed_kmh, null);
  assert.equal(result.sources[1].records[0]?.event_time, quakeRecord.event_time);
  assert.equal(result.sources[1].records[0]?.updated_at, quakeRecord.updated_at);
  assert.equal(result.sources[1].fetched_at, fetchedAt);
});

test("rejects unknown keys, altered attribution, and unsafe provider or licence URLs", () => {
  const extraKey = clone(localPayload()) as ContextSourcesPayload & { injected: string };
  extraKey.injected = "not allowed";
  assert.throws(() => validateContextSourcesPayload(extraKey), ContextSourcesPayloadError);

  const wrongAttribution = clone(localPayload());
  wrongAttribution.sources[0].attribution = "A different source";
  assert.throws(() => validateContextSourcesPayload(wrongAttribution), ContextSourcesPayloadError);

  const unsafeLicense = clone(fetchedPayload());
  unsafeLicense.sources[1].license_url = "javascript:alert(1)";
  assert.throws(() => validateContextSourcesPayload(unsafeLicense), ContextSourcesPayloadError);

  const wrongEventUrl = clone(fetchedPayload());
  wrongEventUrl.sources[1].records[0]!.source_url = "https://example.com/fake-event";
  assert.throws(() => validateContextSourcesPayload(wrongEventUrl), ContextSourcesPayloadError);
});

test("rejects weather hour gaps, out-of-range units, unknown codes and a nonmatching sample", () => {
  const gap = clone(fetchedPayload());
  gap.sources[0].forecast!.hours[1]!.valid_at = "2026-10-10T07:00:00.000Z";
  assert.throws(() => validateContextSourcesPayload(gap), ContextSourcesPayloadError);

  const badTemperature = clone(fetchedPayload());
  badTemperature.sources[0].forecast!.hours[0]!.temperature_c = 99;
  assert.throws(() => validateContextSourcesPayload(badTemperature), ContextSourcesPayloadError);

  const badCode = clone(fetchedPayload());
  badCode.sources[0].forecast!.hours[0]!.weather_code = 4;
  assert.throws(() => validateContextSourcesPayload(badCode), ContextSourcesPayloadError);

  const wrongSample = clone(fetchedPayload());
  wrongSample.sources[0].forecast!.requested_coordinates = [106.9, -6.2];
  assert.throws(() => validateContextSourcesPayload(wrongSample), ContextSourcesPayloadError);
});

test("requires independent source statuses and source-consistent timestamps", () => {
  const mixed = payload([
    weatherSource({ status: "unavailable", data_mode: "fetched", fetched_at: fetchedAt, error: "timeout" }),
    availableQuakes(),
  ]);
  assert.deepEqual(validateContextSourcesPayload(mixed).sources.map((source) => source.status), ["unavailable", "available"]);

  const badQuakeOrder = clone(fetchedPayload());
  badQuakeOrder.sources[1].records[0]!.updated_at = "2026-10-10T05:06:00.000Z";
  assert.throws(() => validateContextSourcesPayload(badQuakeOrder), ContextSourcesPayloadError);

  const badWindow = clone(fetchedPayload());
  badWindow.sources[1].window_start = "2026-10-02T05:05:00.000Z";
  assert.throws(() => validateContextSourcesPayload(badWindow), ContextSourcesPayloadError);
});

test("rejects duplicate earthquake IDs and provider titles containing markup", () => {
  const duplicate = clone(fetchedPayload());
  duplicate.sources[1].records.push(clone(duplicate.sources[1].records[0]!));
  assert.throws(() => validateContextSourcesPayload(duplicate), ContextSourcesPayloadError);

  const markupTitle = clone(fetchedPayload());
  markupTitle.sources[1].records[0]!.title = "Gempa bumi · <img src=x onerror=alert(1)>";
  assert.throws(() => validateContextSourcesPayload(markupTitle), ContextSourcesPayloadError);

  const plainAngleText = clone(fetchedPayload());
  plainAngleText.sources[1].records[0]!.title = "Gempa bumi · wilayah < 5 km dari pantai";
  assert.doesNotThrow(() => validateContextSourcesPayload(plainAngleText));
  const escaped = markup(createElement(EarthquakeRecordDetails, {
    record: plainAngleText.sources[1].records[0]!,
    fetchedAt,
  }));
  assert.match(escaped, /&lt; 5 km/u);
});

test("default client request is local not_requested; fetch mode is an exact explicit query", async () => {
  const seen: Array<{ url: string; init: RequestInit | undefined }> = [];
  const fetcher: typeof fetch = async (input, init) => {
    seen.push({ url: String(input), init });
    return jsonResponse(seen.length === 1 ? localPayload() : fetchedPayload());
  };
  const manualClock = createManualClock();
  const local = await getContextSources({ fetcher, clock: manualClock.clock });
  assert.equal(seen[0]?.url, "/api/v1/demo/context-sources");
  assert.equal(seen[0]?.init?.method, "GET");
  assert.equal((seen[0]?.init?.headers as Record<string, string>).Accept, "application/json");
  assert.equal(seen[0]?.init?.redirect, "error");
  assert.equal(seen[0]?.init?.cache, "default");
  assert.deepEqual(local.sources.map((source) => source.status), ["not_requested", "not_requested"]);
  assert.equal(manualClock.delayMs, 35_000);

  const explicit = await getContextSources({ mode: "fetch", fetcher, clock: manualClock.clock });
  assert.equal(seen[1]?.url, "/api/v1/demo/context-sources?mode=fetch");
  assert.equal(seen[1]?.init?.cache, "no-store");
  assert.equal(explicit.sources[0].status, "available");
});

test("bounds HTTP status, content type, response size, and JSON nesting", async () => {
  await assert.rejects(
    getContextSources({ fetcher: async () => new Response("{}", { status: 502, headers: { "content-type": "application/json" } }) }),
    ContextSourcesHttpError,
  );
  await assert.rejects(
    getContextSources({ fetcher: async () => new Response("{}", { headers: { "content-type": "text/html" } }) }),
    ContextSourcesPayloadError,
  );
  await assert.rejects(
    getContextSources({ fetcher: async () => jsonResponse(localPayload(), { "content-length": String(512 * 1024 + 1) }) }),
    ContextSourcesPayloadError,
  );

  const large = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(512 * 1024));
      controller.enqueue(new Uint8Array(1));
      controller.close();
    },
  });
  await assert.rejects(
    getContextSources({ fetcher: async () => new Response(large, { headers: { "content-type": "application/json" } }) }),
    ContextSourcesPayloadError,
  );

  const nested = "[".repeat(CONTEXT_SOURCE_POLICY.maxNestingDepth + 1) + "null" + "]".repeat(CONTEXT_SOURCE_POLICY.maxNestingDepth + 1);
  await assert.rejects(
    getContextSources({ fetcher: async () => new Response(nested, { headers: { "content-type": "application/json" } }) }),
    ContextSourcesPayloadError,
  );
});

test("35-second deadline covers a stalled response body and aborts its reader", async () => {
  const manualClock = createManualClock();
  const capturedSignal: { current: AbortSignal | null } = { current: null };
  const fetcher: typeof fetch = async (_input, init) => {
    capturedSignal.current = init?.signal as AbortSignal;
    const body = new ReadableStream<Uint8Array>({ pull: () => new Promise<void>(() => {}) });
    return new Response(body, { headers: { "content-type": "application/json" } });
  };
  const pending = getContextSources({ fetcher, clock: manualClock.clock });
  await new Promise<void>((resolve) => setImmediate(resolve));
  manualClock.expire();
  await assert.rejects(pending, ContextSourcesTimeoutError);
  assert.equal(capturedSignal.current?.aborted, true);
});

test("external cancellation aborts the request and remains distinguishable", async () => {
  const capturedSignal: { current: AbortSignal | null } = { current: null };
  const controller = new AbortController();
  const fetcher: typeof fetch = async (_input, init) => {
    capturedSignal.current = init?.signal as AbortSignal;
    return new Promise<Response>((_resolve, reject) => {
      capturedSignal.current?.addEventListener("abort", () => {
        const error = new Error("aborted");
        error.name = "AbortError";
        reject(error);
      }, { once: true });
    });
  };
  const pending = getContextSources({ signal: controller.signal, fetcher });
  await new Promise<void>((resolve) => setImmediate(resolve));
  controller.abort();
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(capturedSignal.current?.aborted, true);
});

test("renders available model context, Indonesian code labels, missing values, and attribution", () => {
  const html = markup(createElement(WeatherContextCard, { source: availableWeather(), cached: false }));
  assert.match(html, /Prakiraan model · 2 jam pada respons/u);
  assert.match(html, /Hujan ringan/u);
  assert.match(html, /WMO 61/u);
  assert.match(html, /Akumulasi:/u);
  assert.match(html, /Peluang model:/u);
  assert.match(html, /satu jam sebelumnya/u);
  assert.match(html, /waktu penerbitan model/u);
  assert.match(html, /Tidak disediakan penyedia/u);
  assert.match(html, /Tidak diketahui/u);
  assert.match(html, /CC BY 4.0/u);
  assert.match(html, /creativecommons\.org\/licenses\/by\/4\.0/u);
  assert.match(html, /bukan peringatan banjir/u);
});

test("renders weather empty and unavailable states without inventing forecast values", () => {
  const empty = markup(createElement(WeatherContextCard, {
    source: weatherSource({ status: "empty", data_mode: "fetched", fetched_at: fetchedAt }),
    cached: false,
  }));
  assert.match(empty, /Respons kosong/u);
  assert.match(empty, /Nilai cuaca tidak diketahui/u);
  assert.doesNotMatch(empty, /Prakiraan model ·/u);

  const unavailable = markup(createElement(WeatherContextCard, {
    source: weatherSource({ status: "unavailable", data_mode: "fetched", fetched_at: fetchedAt, error: "timeout" }),
    cached: false,
  }));
  assert.match(unavailable, /Sumber tidak tersedia/u);
  assert.match(unavailable, /Waktu tunggu sumber berakhir/u);
  assert.match(unavailable, /Nilainya tidak diketahui/u);
});

test("renders earthquake empty and unavailable source outcomes independently", () => {
  const empty = markup(createElement(EarthquakeContextCard, {
    source: quakeSource({ status: "empty", data_mode: "fetched", fetched_at: fetchedAt, source_updated_at: "2026-10-10T05:04:00.000Z", window_start: windowStart, window_end: windowEnd }),
    cached: false,
    selectedId: null,
    onSelect: () => undefined,
  }));
  assert.match(empty, /Respons kosong/u);
  assert.match(empty, /tidak menetapkan keselamatan atau dampak/u);
  assert.match(empty, /Kueri katalog regional · tujuh hari/u);
  assert.doesNotMatch(empty, /USGS ·/u);

  const unavailable = markup(createElement(EarthquakeContextCard, {
    source: quakeSource({ status: "unavailable", data_mode: "fetched", fetched_at: fetchedAt, error: "http_error", window_start: windowStart, window_end: windowEnd }),
    cached: false,
    selectedId: null,
    onSelect: () => undefined,
  }));
  assert.match(unavailable, /Sumber tidak memberi respons yang dapat digunakan/u);
  assert.match(unavailable, /Nilainya tidak diketahui/u);
});

test("renders useful list-first earthquake details, separates origin/update/fetch and keeps map optional", () => {
  const mapArguments: { current: { points: readonly EarthquakeContextRecord[]; selectedId: string | null } | null } = { current: null };
  const source = availableQuakes();
  const html = markup(createElement(EarthquakeContextCard, {
    source,
    cached: false,
    selectedId: quakeRecord.id,
    onSelect: () => undefined,
    renderMap(points, selectedId) {
      mapArguments.current = { points, selectedId };
      return createElement("div", { className: "test-map" }, "Peta kawasan uji");
    },
  }));
  assert.ok(html.indexOf("Daftar episentrum") < html.indexOf("Lihat peta kawasan"));
  assert.match(html, /Magnitudo 4,2/u);
  assert.match(html, /Tipe magnitudo/u);
  assert.match(html, /Kedalaman/u);
  assert.match(html, /Reviewed · status dari USGS saja/u);
  assert.match(html, /Asal kejadian/u);
  assert.match(html, /Pembaruan sumber/u);
  assert.match(html, /Data diambil/u);
  assert.match(html, /bukan area dampak/u);
  assert.match(html, /tidak menyimpulkan dampak di Jakarta/u);
  assert.match(html, /Peta kawasan uji/u);
  assert.equal(mapArguments.current?.points.length, 1);
  assert.equal(mapArguments.current?.selectedId, quakeRecord.id);
  assert.doesNotMatch(html, /Richter/u);
});

test("renders the non-demo guard and initial demo controls without fabricated source data", () => {
  const live = markup(createElement(ContextSources, { datasetMode: "live" }));
  assert.match(live, /Tidak ada permintaan yang dilakukan/u);
  assert.match(live, /mode live/u);
  assert.match(live, /disabled=""/u);
  assert.doesNotMatch(live, /Prakiraan model ·/u);

  const unknown = markup(createElement(ContextSources, { datasetMode: null }));
  assert.match(unknown, /Status dataset belum tersedia/u);
  assert.match(unknown, /Data konteks tidak ditampilkan/u);
  assert.doesNotMatch(unknown, /Gempa bumi ·/u);

  const demo = markup(createElement(ContextSources, { datasetMode: "demo" }));
  assert.match(demo, /Ambil konteks cuaca &amp; gempa/u);
  assert.match(demo, /Status lokal tidak menghubungi penyedia/u);
  assert.doesNotMatch(demo, /Prakiraan model ·/u);
});

test("renders selected earthquake metadata with source timestamps and exact source link", () => {
  const html = markup(createElement(EarthquakeRecordDetails, { record: quakeRecord, fetchedAt }));
  assert.match(html, /eventpage\/us7000sample/u);
  assert.match(html, /2026-10-09T03:12:00\.000Z/u);
  assert.match(html, /2026-10-10T04:59:00\.000Z/u);
  assert.match(html, /2026-10-10T05:05:00\.000Z/u);
});
