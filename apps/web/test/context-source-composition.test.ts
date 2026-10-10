import assert from "node:assert/strict";
import test from "node:test";
import { createContextSourcesHandler } from "../../worker/src/layers/l4-application-integration/context-sources-api.js";
import { getContextSources } from "../src/context-sources-client.js";

// Authored synthetic upstream data: no provider requests or real incident assertions.
const instant = Date.parse("2026-10-10T08:30:00Z");
const hour = Math.floor(instant / 3_600_000) * 3_600;
const environment = { DATASET_MODE: "demo", SOURCE_PREVIEW_ENABLED: "true" };

function setup(weatherUnavailable = false) {
  let calls = 0;
  const sourceFetch: typeof fetch = async (input) => {
    calls += 1;
    const url = String(input);
    if (url.startsWith("https://api.open-meteo.com/")) {
      if (weatherUnavailable) return new Response("", { status: 503 });
      return Response.json({
        latitude: -6.221441, longitude: 106.856186,
        utc_offset_seconds: 0, timezone: "GMT", timezone_abbreviation: "GMT",
        hourly_units: {
          time: "unixtime", temperature_2m: "°C", precipitation_probability: "%",
          precipitation: "mm", weather_code: "wmo code", wind_speed_10m: "km/h",
        },
        hourly: {
          time: [hour, hour + 3_600], temperature_2m: [29, null],
          precipitation_probability: [20, null], precipitation: [0.1, null],
          weather_code: [3, null], wind_speed_10m: [7.5, null],
        },
      });
    }
    assert.ok(url.startsWith("https://earthquake.usgs.gov/fdsnws/event/1/query?"));
    return Response.json({
      type: "FeatureCollection", metadata: { status: 200, generated: instant - 1_000 },
      features: [{
        type: "Feature", id: "syntheticComposition",
        geometry: { type: "Point", coordinates: [105.8, -6.8, 12] },
        properties: {
          type: "earthquake", time: instant - 3_600_000, updated: instant - 1_800_000,
          mag: 3.4, magType: "mb", place: "CONTOH SINTETIS < 1 km", status: "reviewed",
          url: "https://earthquake.usgs.gov/earthquakes/eventpage/syntheticComposition",
        },
      }],
    });
  };
  const handler = createContextSourcesHandler({
    fetch: sourceFetch,
    clock: {
      now: () => instant,
      schedule: (callback, delayMs) => setTimeout(callback, delayMs),
      cancel: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    },
  });
  const apiFetch: typeof fetch = async (input, init) => handler(
    new Request(new URL(String(input), "http://localhost"), init), environment,
  );
  return { fetcher: apiFetch, calls: () => calls };
}

test("synthetic source adapters compose through the closed API and strict browser client", async () => {
  const service = setup();
  const local = await getContextSources(service);
  assert.deepEqual(local.sources.map(source => source.status), ["not_requested", "not_requested"]);
  assert.equal(service.calls(), 0);

  const result = await getContextSources({ ...service, mode: "fetch" });
  assert.equal(service.calls(), 2);
  assert.equal(result.sources[0].forecast?.hours.length, 2);
  assert.equal(result.sources[0].forecast?.hours[1]?.temperature_c, null);
  assert.equal(result.sources[0].source_updated_at, null);
  assert.equal(result.sources[1].records[0]?.title, "Gempa bumi · CONTOH SINTETIS < 1 km");
  assert.equal(result.sources[1].records[0]?.source_status, "reviewed");
  assert.equal(result.sources[1].records[0]?.coordinate_kind, "source_point");
  assert.equal(result.sources[1].source_updated_at, "2026-10-10T08:29:59.000Z");

  const cached = await getContextSources({ ...service, mode: "fetch" });
  assert.equal(cached.cached, true);
  assert.equal(service.calls(), 2);
  const reset = await getContextSources(service);
  assert.ok(reset.sources.every(source => source.status === "not_requested"));
  assert.equal(service.calls(), 2);
});

test("browser accepts independently normalized source failure without discarding the other provider", async () => {
  const service = setup(true);
  const result = await getContextSources({ ...service, mode: "fetch" });
  assert.equal(service.calls(), 2);
  assert.equal(result.sources[0].status, "unavailable");
  assert.equal(result.sources[0].error, "http_error");
  assert.equal(result.sources[0].forecast, null);
  assert.equal(result.sources[1].status, "available");
  assert.equal(result.sources[1].records.length, 1);
});
