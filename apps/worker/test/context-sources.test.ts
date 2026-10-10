import assert from "node:assert/strict";
import test from "node:test";
import {
  CONTEXT_SOURCES_LIMITS,
  type ContextSourcesClock,
} from "../src/layers/l1-data-knowledge/context-source-adapters.js";
import { createContextSourcesHandler } from "../src/layers/l4-application-integration/context-sources-api.js";

const contextPath = "https://waspada.test/api/v1/demo/context-sources";
const demoEnvironment = { DATASET_MODE: "demo", SOURCE_PREVIEW_ENABLED: "true" } as const;
const fixedNow = Date.parse("2026-10-10T05:00:00.000Z");
const hourSeconds = 3_600;
const fixedHourEpoch = fixedNow / 1_000;
const openMeteoUrl = "https://api.open-meteo.com/v1/forecast?latitude=-6.2&longitude=106.82&hourly=temperature_2m,precipitation_probability,precipitation,weather_code,wind_speed_10m&forecast_hours=12&timezone=GMT&timeformat=unixtime&wind_speed_unit=kmh&temperature_unit=celsius&precipitation_unit=mm";

interface FakeClockHarness {
  readonly clock: ContextSourcesClock;
  setNow(value: number): void;
  fireDeadline(index?: number): void;
  scheduledDelays(): number[];
}

function fakeClock(initial = fixedNow): FakeClockHarness {
  let now = initial;
  const scheduled: Array<{ readonly handle: object; readonly callback: () => void; readonly delay: number; active: boolean }> = [];
  const clock: ContextSourcesClock = {
    now: () => now,
    schedule(callback, delayMs) {
      const entry = { handle: {}, callback, delay: delayMs, active: true };
      scheduled.push(entry);
      return entry.handle;
    },
    cancel(handle) {
      const entry = scheduled.find((candidate) => candidate.handle === handle);
      if (entry !== undefined) entry.active = false;
    },
  };
  return {
    clock,
    setNow(value) {
      now = value;
    },
    fireDeadline(index = 0) {
      const active = scheduled.filter((entry) => entry.active);
      active[index]?.callback();
    },
    scheduledDelays: () => scheduled.filter((entry) => entry.active).map((entry) => entry.delay),
  };
}

function request(search = ""): Request {
  return new Request(`${contextPath}${search}`);
}

function jsonResponse(value: unknown, status = 200, contentType = "application/json; charset=utf-8"): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": contentType } });
}

function weatherPayload(overrides: Record<string, unknown> = {}) {
  return {
    latitude: -6.221441,
    longitude: 106.856186,
    generationtime_ms: 0.015,
    utc_offset_seconds: 0,
    timezone: "GMT",
    timezone_abbreviation: "GMT",
    hourly_units: {
      time: "unixtime",
      temperature_2m: "°C",
      precipitation_probability: "%",
      precipitation: "mm",
      weather_code: "wmo code",
      wind_speed_10m: "km/h",
    },
    hourly: {
      time: [fixedHourEpoch, fixedHourEpoch + hourSeconds, fixedHourEpoch + 2 * hourSeconds],
      temperature_2m: [29.4, null, 28.8],
      precipitation_probability: [30, null, 45],
      precipitation: [0.2, null, 1.5],
      weather_code: [2, null, 61],
      wind_speed_10m: [12.3, null, 17.1],
    },
    ...overrides,
  };
}

function earthquakeFeature(id = "us7000abcd", overrides: Record<string, unknown> = {}) {
  const properties = {
    type: "earthquake",
    mag: 4.3,
    place: "12 km south of Example Bay",
    time: fixedNow - 24 * 60 * 60_000,
    updated: fixedNow - 60 * 60_000,
    url: `https://earthquake.usgs.gov/earthquakes/eventpage/${id}`,
    status: "reviewed",
    magType: "mb",
    ...overrides,
  };
  return {
    type: "Feature",
    id,
    properties,
    geometry: { type: "Point", coordinates: [106.1, -6.7, 24.5] },
  };
}

function earthquakeCollection(features: unknown[], metadata: Record<string, unknown> = {}) {
  return {
    type: "FeatureCollection",
    metadata: {
      generated: fixedNow - 30_000,
      status: 200,
      title: "Synthetic USGS catalog fixture",
      ...metadata,
    },
    features,
  };
}

function makeHandler(fetcher: typeof fetch, clock: ContextSourcesClock = fakeClock().clock) {
  return createContextSourcesHandler({ fetch: fetcher, clock });
}

function source(payload: unknown, id: "openmeteo" | "usgs"): Record<string, unknown> {
  const body = payload as { sources: Array<Record<string, unknown>> };
  const matched = body.sources.find((item) => item.id === id);
  assert.ok(matched);
  return matched;
}

async function readPayload(response: Response): Promise<Record<string, unknown>> {
  return await response.json() as Record<string, unknown>;
}

function expectedWindow() {
  const end = new Date(fixedNow).toISOString();
  const start = new Date(fixedNow - 7 * 24 * 60 * 60_000).toISOString();
  return { start, end };
}

test("default mode makes no upstream request and returns both sources as not requested", async () => {
  let fetchCount = 0;
  const handler = makeHandler(async () => {
    fetchCount += 1;
    throw new Error("default mode must not use the network");
  });

  const response = await handler(request(), demoEnvironment);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const payload = await readPayload(response) as {
    schema_version: string;
    mode: string;
    cached: boolean;
    sources: Array<Record<string, unknown>>;
  };
  assert.equal(fetchCount, 0);
  assert.equal(payload.schema_version, "context-sources-v1");
  assert.equal(payload.mode, "source_context");
  assert.equal(payload.cached, false);
  assert.deepEqual(payload.sources.map((item) => item.id), ["openmeteo", "usgs"]);
  for (const item of payload.sources) {
    assert.equal(item.status, "not_requested");
    assert.equal(item.data_mode, "none");
    assert.equal(item.fetched_at, null);
  }
});

test("exact demo gate, method and query rules prevent network calls", async () => {
  let fetchCount = 0;
  const handler = makeHandler(async () => {
    fetchCount += 1;
    return jsonResponse({});
  });

  for (const blocked of [
    [{}, 404],
    [{ DATASET_MODE: "live", SOURCE_PREVIEW_ENABLED: "true" }, 404],
    [{ DATASET_MODE: "demo", SOURCE_PREVIEW_ENABLED: "True" }, 404],
  ] as const) {
    assert.equal((await handler(request("?mode=fetch"), blocked[0])).status, blocked[1]);
  }
  assert.equal((await handler(new Request(contextPath, { method: "POST" }), demoEnvironment)).status, 405);
  for (const search of ["?url=https://example.org", "?mode=fetch&source=usgs", "?mode=fetch&mode=fetch", "?mode=default", "?MODE=fetch"]) {
    assert.equal((await handler(request(search), demoEnvironment)).status, 400);
  }
  assert.equal((await handler(new Request("https://waspada.test/api/v1/demo/other"), demoEnvironment)).status, 404);
  assert.equal(fetchCount, 0);
});

test("fetch uses exactly two fixed provider requests and closed normalized projections", async () => {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const handler = makeHandler(async (input, init) => {
    const url = String(input);
    calls.push({ url, init });
    if (url === openMeteoUrl) return jsonResponse(weatherPayload());
    const parsed = new URL(url);
    assert.equal(parsed.origin, "https://earthquake.usgs.gov");
    assert.equal(parsed.pathname, "/fdsnws/event/1/query");
    return jsonResponse(earthquakeCollection([earthquakeFeature()]));
  });

  const response = await handler(request("?mode=fetch"), demoEnvironment);
  assert.equal(response.status, 200);
  assert.equal(calls.length, 2);
  const weatherCall = calls.find((call) => call.url === openMeteoUrl);
  const quakeCall = calls.find((call) => call.url.includes("earthquake.usgs.gov"));
  assert.ok(weatherCall);
  assert.ok(quakeCall);
  assert.equal(weatherCall.init?.method, "GET");
  assert.equal(quakeCall.init?.method, "GET");
  assert.equal(weatherCall.init?.redirect, "manual");
  assert.equal(quakeCall.init?.redirect, "manual");
  const expectedAgent = "WaspadaJakarta-Team12-Demo/0.1 (+https://github.com/Asassinoooo/Waspada-Jakarta)";
  assert.equal(new Headers(weatherCall.init?.headers).get("user-agent"), expectedAgent);
  assert.equal(new Headers(quakeCall.init?.headers).get("user-agent"), expectedAgent);
  const query = new URL(quakeCall.url).searchParams;
  const window = expectedWindow();
  assert.equal(query.get("format"), "geojson");
  assert.equal(query.get("starttime"), window.start);
  assert.equal(query.get("endtime"), window.end);
  assert.equal(query.get("minmagnitude"), "2.5");
  assert.equal(query.get("minlongitude"), "104");
  assert.equal(query.get("maxlongitude"), "110");
  assert.equal(query.get("minlatitude"), "-9.5");
  assert.equal(query.get("maxlatitude"), "-4");
  assert.equal(query.get("orderby"), "time");
  assert.equal(query.get("limit"), "30");

  const payload = await readPayload(response) as { cached: boolean; sources: Array<Record<string, unknown>> };
  assert.equal(payload.cached, false);
  const weather = source(payload, "openmeteo");
  const forecast = weather.forecast as Record<string, unknown>;
  assert.deepEqual(forecast.requested_coordinates, [106.82, -6.2]);
  assert.deepEqual(forecast.model_coordinates, [106.856186, -6.221441]);
  const hours = forecast.hours as Array<Record<string, unknown>>;
  assert.equal(hours.length, 3);
  assert.equal(hours[0]?.valid_at, "2026-10-10T05:00:00.000Z");
  assert.equal(hours[0]?.precipitation_mm, 0.2);
  assert.equal(hours[1]?.temperature_c, null);
  assert.equal(hours[1]?.precipitation_probability_pct, null);
  assert.equal(weather.source_updated_at, null);
  assert.deepEqual(Object.keys(hours[0] ?? {}).sort(), [
    "precipitation_mm", "precipitation_probability_pct", "temperature_c", "valid_at", "weather_code", "wind_speed_kmh",
  ]);

  const earthquakes = source(payload, "usgs");
  const records = earthquakes.records as Array<Record<string, unknown>>;
  assert.equal(earthquakes.status, "available");
  assert.equal(earthquakes.window_start, window.start);
  assert.equal(earthquakes.window_end, window.end);
  assert.equal(earthquakes.source_updated_at, "2026-10-10T04:59:30.000Z");
  assert.equal(records.length, 1);
  assert.equal(records[0]?.id, "usgs:us7000abcd");
  assert.equal(records[0]?.title, "Gempa bumi · 12 km south of Example Bay");
  assert.equal(records[0]?.event_time, "2026-10-09T05:00:00.000Z");
  assert.equal(records[0]?.updated_at, "2026-10-10T04:00:00.000Z");
  assert.equal(records[0]?.source_status, "reviewed");
  assert.equal(records[0]?.source_url, "https://earthquake.usgs.gov/earthquakes/eventpage/us7000abcd");
  assert.deepEqual(Object.keys(records[0] ?? {}).sort(), [
    "coordinate_kind", "coordinates", "depth_km", "event_time", "id", "kind", "magnitude", "magnitude_type",
    "source", "source_status", "source_url", "title", "updated_at",
  ]);
  assert.equal(JSON.stringify(payload).includes("Synthetic USGS catalog fixture"), false);
});

test("Open-Meteo rejects wrong units, mismatched arrays, bad hour spacing, wrong horizon and invalid values", async () => {
  const malformed = [
    { label: "unit", mutate: (body: Record<string, unknown>) => {
      (body.hourly_units as Record<string, unknown>).precipitation = "in";
    } },
    { label: "timezone", mutate: (body: Record<string, unknown>) => { body.utc_offset_seconds = 3600; } },
    { label: "unequal arrays", mutate: (body: Record<string, unknown>) => {
      (body.hourly as Record<string, unknown>).wind_speed_10m = [10];
    } },
    { label: "string coercion", mutate: (body: Record<string, unknown>) => {
      (body.hourly as Record<string, unknown>).temperature_2m = ["29", null, 28];
    } },
    { label: "unknown weather code", mutate: (body: Record<string, unknown>) => {
      (body.hourly as Record<string, unknown>).weather_code = [999, null, 61];
    } },
    { label: "bad precipitation", mutate: (body: Record<string, unknown>) => {
      (body.hourly as Record<string, unknown>).precipitation = [1_001, null, 1.5];
    } },
    { label: "non-hourly sequence", mutate: (body: Record<string, unknown>) => {
      (body.hourly as Record<string, unknown>).time = [fixedHourEpoch, fixedHourEpoch + 7_200, fixedHourEpoch + 10_800];
    } },
    { label: "outside request horizon", mutate: (body: Record<string, unknown>) => {
      (body.hourly as Record<string, unknown>).time = [fixedHourEpoch + 46_800];
      (body.hourly as Record<string, unknown>).temperature_2m = [29];
      (body.hourly as Record<string, unknown>).precipitation_probability = [30];
      (body.hourly as Record<string, unknown>).precipitation = [0.2];
      (body.hourly as Record<string, unknown>).weather_code = [2];
      (body.hourly as Record<string, unknown>).wind_speed_10m = [12];
    } },
    { label: "wrong first hour", mutate: (body: Record<string, unknown>) => {
      (body.hourly as Record<string, unknown>).time = [fixedHourEpoch - 7_200, fixedHourEpoch - 3_600, fixedHourEpoch];
    } },
    { label: "outside model grid", mutate: (body: Record<string, unknown>) => { body.longitude = 107.5; } },
  ];

  for (const scenario of malformed) {
    const body = weatherPayload() as Record<string, unknown>;
    scenario.mutate(body);
    const handler = makeHandler(async (input) => String(input) === openMeteoUrl
      ? jsonResponse(body)
      : jsonResponse(earthquakeCollection([])));
    const response = await handler(request("?mode=fetch"), demoEnvironment);
    const payload = await readPayload(response);
    const weather = source(payload, "openmeteo");
    assert.equal(weather.status, "unavailable", scenario.label);
    assert.equal(weather.error, "invalid_payload", scenario.label);
    assert.equal(weather.forecast, null, scenario.label);
    assert.equal(source(payload, "usgs").status, "empty", scenario.label);
  }
});

test("weather allows null model values and the prior hour only across a request hour boundary", async () => {
  const crossingClock = fakeClock(fixedNow - 1_000);
  let samples = 0;
  const clock: ContextSourcesClock = {
    ...crossingClock.clock,
    now: () => {
      samples += 1;
      return samples <= 2 ? fixedNow - 1_000 : fixedNow + 1_000;
    },
  };
  const body = weatherPayload({
    hourly: {
      time: [fixedHourEpoch - hourSeconds, fixedHourEpoch],
      temperature_2m: [null, 27],
      precipitation_probability: [null, 0],
      precipitation: [null, 0],
      weather_code: [null, 0],
      wind_speed_10m: [null, 0],
    },
  });
  const handler = makeHandler(async (input) => String(input) === openMeteoUrl
    ? jsonResponse(body)
    : jsonResponse(earthquakeCollection([])), clock);
  const response = await handler(request("?mode=fetch"), demoEnvironment);
  const payload = await readPayload(response);
  assert.equal(source(payload, "openmeteo").status, "available", JSON.stringify(payload));
  const forecast = source(payload, "openmeteo").forecast as { hours: Array<Record<string, unknown>> };
  assert.equal(forecast.hours[0]?.valid_at, "2026-10-10T04:00:00.000Z");
  assert.equal(forecast.hours[0]?.temperature_c, null);

});

test("USGS accepts absent metadata.count and validates source time, bounds, IDs, URL, types and depth", async () => {
  const invalidCases: Array<{ label: string; feature: unknown; metadata?: Record<string, unknown>; expectedStatus?: string }> = [
    { label: "wrong GeoJSON feature type", feature: { ...earthquakeFeature("us7000badfeature"), type: "Record" } },
    { label: "outside region", feature: { ...earthquakeFeature(), geometry: { type: "Point", coordinates: [110.1, -6, 10] } } },
    { label: "depth too large", feature: { ...earthquakeFeature(), geometry: { type: "Point", coordinates: [106, -6, 801] } } },
    { label: "bad provider ID", feature: earthquakeFeature("unsafe/id") },
    { label: "mismatched event URL", feature: earthquakeFeature("us7000wrong", { url: "https://earthquake.usgs.gov/earthquakes/eventpage/us7000other" }) },
    { label: "wrong event type", feature: earthquakeFeature("us7000other", { type: "quarry blast" }), expectedStatus: "empty" },
    { label: "origin outside seven days", feature: earthquakeFeature("us7000old", { time: fixedNow - 8 * 24 * 60 * 60_000 }) },
    { label: "updated before origin", feature: earthquakeFeature("us7000regress", { updated: fixedNow - 25 * 60 * 60_000 }) },
    { label: "future source revision", feature: earthquakeFeature("us7000future", { updated: fixedNow + 1 }) },
    { label: "bad magnitude", feature: earthquakeFeature("us7000mag", { mag: 11 }) },
    { label: "unsafe place markup", feature: earthquakeFeature("us7000place", { place: "<script>bad</script>" }) },
    { label: "future catalog generation", feature: earthquakeFeature("us7000generated"), metadata: { generated: fixedNow + 1 } },
  ];
  for (const scenario of invalidCases) {
    const handler = makeHandler(async (input) => String(input) === openMeteoUrl
      ? jsonResponse(weatherPayload())
      : jsonResponse(earthquakeCollection([scenario.feature], scenario.metadata)));
    const response = await handler(request("?mode=fetch"), demoEnvironment);
    const payload = await readPayload(response);
    const earthquakes = source(payload, "usgs");
    assert.equal(earthquakes.status, scenario.expectedStatus ?? "unavailable", scenario.label);
    assert.equal(earthquakes.error, scenario.expectedStatus === "empty" ? null : "invalid_payload", scenario.label);
    assert.deepEqual(earthquakes.records, [], scenario.label);
  }

  const inconsistentCount = makeHandler(async (input) => String(input) === openMeteoUrl
    ? jsonResponse(weatherPayload())
    : jsonResponse(earthquakeCollection([], { count: 1 })));
  const countPayload = await readPayload(await inconsistentCount(request("?mode=fetch"), demoEnvironment));
  assert.equal(source(countPayload, "usgs").error, "invalid_payload");

  const missingCount = makeHandler(async (input) => String(input) === openMeteoUrl
    ? jsonResponse(weatherPayload())
    : jsonResponse({
      type: "FeatureCollection",
      metadata: { generated: fixedNow - 30_000, status: 200 },
      features: [],
    }));
  const emptyPayload = await readPayload(await missingCount(request("?mode=fetch"), demoEnvironment));
  assert.equal(source(emptyPayload, "usgs").status, "empty");
  assert.equal(source(emptyPayload, "usgs").source_updated_at, "2026-10-10T04:59:30.000Z");
});

test("identical earthquake IDs collapse while contradictory versions are rejected together", async () => {
  const identicalHandler = makeHandler(async (input) => String(input) === openMeteoUrl
    ? jsonResponse(weatherPayload())
    : jsonResponse(earthquakeCollection([earthquakeFeature(), earthquakeFeature()])));
  const identical = await readPayload(await identicalHandler(request("?mode=fetch"), demoEnvironment));
  const identicalSource = source(identical, "usgs");
  assert.equal(identicalSource.status, "available");
  assert.equal(identicalSource.rejected_count, 1);
  assert.equal((identicalSource.records as unknown[]).length, 1);

  const contradictoryHandler = makeHandler(async (input) => String(input) === openMeteoUrl
    ? jsonResponse(weatherPayload())
    : jsonResponse(earthquakeCollection([
      earthquakeFeature("us7000duplicate", { mag: 3.1 }),
      earthquakeFeature("us7000duplicate", { mag: 4.1 }),
    ])));
  const contradictory = await readPayload(await contradictoryHandler(request("?mode=fetch"), demoEnvironment));
  const contradictorySource = source(contradictory, "usgs");
  assert.equal(contradictorySource.status, "unavailable");
  assert.equal(contradictorySource.error, "invalid_payload");
  assert.equal(contradictorySource.rejected_count, 2);
  assert.deepEqual(contradictorySource.records, []);

  const malformedDuplicateHandler = makeHandler(async (input) => String(input) === openMeteoUrl
    ? jsonResponse(weatherPayload())
    : jsonResponse(earthquakeCollection([
      earthquakeFeature("us7000duplicate-malformed"),
      earthquakeFeature("us7000duplicate-malformed", { updated: fixedNow - 25 * 60 * 60_000 }),
    ])));
  const malformedDuplicate = await readPayload(await malformedDuplicateHandler(request("?mode=fetch"), demoEnvironment));
  const malformedDuplicateSource = source(malformedDuplicate, "usgs");
  assert.equal(malformedDuplicateSource.status, "unavailable");
  assert.equal(malformedDuplicateSource.error, "invalid_payload");
  assert.equal(malformedDuplicateSource.rejected_count, 2);
  assert.deepEqual(malformedDuplicateSource.records, []);
});

test("USGS limit is reflected in limited metadata and records remain bounded", async () => {
  const features = Array.from({ length: 30 }, (_, index) => earthquakeFeature(`us7000${String(index).padStart(4, "0")}`, {
    time: fixedNow - (index + 1) * 60_000,
    updated: fixedNow - 10_000,
  }));
  const handler = makeHandler(async (input) => String(input) === openMeteoUrl
    ? jsonResponse(weatherPayload())
    : jsonResponse(earthquakeCollection(features, { count: 30 })));
  const payload = await readPayload(await handler(request("?mode=fetch"), demoEnvironment));
  const earthquakes = source(payload, "usgs");
  assert.equal(earthquakes.status, "available");
  assert.equal(earthquakes.limited, true);
  assert.equal((earthquakes.records as unknown[]).length, 30);
});

test("provider failures are independent, redirects are rejected, and details stay sanitized", async () => {
  const failureCases = [
    { failing: "weather", expectedPeer: "empty" },
    { failing: "usgs", expectedPeer: "available" },
  ] as const;
  for (const scenario of failureCases) {
    const handler = makeHandler(async (input) => {
      const url = String(input);
      if (scenario.failing === "weather" && url === openMeteoUrl) throw new Error("PRIVATE upstream error");
      if (scenario.failing === "usgs" && url !== openMeteoUrl) {
        return new Response(null, { status: 302, headers: { location: "https://redirect.invalid/secret" } });
      }
      return url === openMeteoUrl
        ? jsonResponse(weatherPayload())
        : jsonResponse(earthquakeCollection([]));
    });
    const response = await handler(request("?mode=fetch"), demoEnvironment);
    assert.equal(response.status, 200);
    const payload = await readPayload(response);
    const failedId = scenario.failing === "weather" ? "openmeteo" : "usgs";
    const peerId = scenario.failing === "weather" ? "usgs" : "openmeteo";
    const failed = source(payload, failedId);
    assert.equal(failed.status, "unavailable");
    assert.equal(failed.error, scenario.failing === "weather" ? "http_error" : "http_error");
    assert.equal(source(payload, peerId).status, scenario.expectedPeer);
    assert.equal(JSON.stringify(payload).includes("PRIVATE upstream error"), false);
    assert.equal(JSON.stringify(payload).includes("redirect.invalid"), false);
  }
});

test("invalid content type, declared and streamed body overages, and excessive JSON depth fail closed", async () => {
  const invalidResponses = [
    () => new Response("{}", { headers: { "content-type": "text/plain" } }),
    () => new Response("{}", {
      headers: {
        "content-type": "application/json",
        "content-length": String(CONTEXT_SOURCES_LIMITS.maxBodyBytes + 1),
      },
    }),
    () => new Response(`[${"[".repeat(CONTEXT_SOURCES_LIMITS.maxNestingDepth)}0${"]".repeat(CONTEXT_SOURCES_LIMITS.maxNestingDepth)}]`, {
      headers: { "content-type": "application/json" },
    }),
  ];
  for (const responseFactory of invalidResponses) {
    const handler = makeHandler(async (input) => String(input) === openMeteoUrl
      ? responseFactory()
      : jsonResponse(earthquakeCollection([])));
    const payload = await readPayload(await handler(request("?mode=fetch"), demoEnvironment));
    assert.equal(source(payload, "openmeteo").status, "unavailable");
    assert.equal(source(payload, "openmeteo").error, "invalid_payload");
    assert.equal(source(payload, "usgs").status, "empty");
  }

  let streamedBytes = 0;
  const oversizedBody = new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      const next = new Uint8Array(800 * 1024);
      streamedBytes += next.byteLength;
      controller.enqueue(next);
      if (streamedBytes > CONTEXT_SOURCES_LIMITS.maxBodyBytes) controller.close();
    },
  }), { headers: { "content-type": "application/json" } });
  const streamedHandler = makeHandler(async (input) => String(input) === openMeteoUrl
    ? oversizedBody
    : jsonResponse(earthquakeCollection([])));
  const streamedPayload = await readPayload(await streamedHandler(request("?mode=fetch"), demoEnvironment));
  assert.equal(source(streamedPayload, "openmeteo").error, "invalid_payload");
  assert.ok(streamedBytes <= 2 * CONTEXT_SOURCES_LIMITS.maxBodyBytes);
  assert.equal(source(streamedPayload, "usgs").status, "empty");
});

test("25-second deadlines cover response headers and streamed bodies per provider", async () => {
  for (const timeoutTarget of ["weather_headers", "usgs_body"] as const) {
    const harness = fakeClock();
    const signals: AbortSignal[] = [];
    let releaseUsgs!: (response: Response) => void;
    const hangingBody = new Response(new ReadableStream<Uint8Array>({
      pull() { return new Promise<void>(() => undefined); },
    }), { headers: { "content-type": "application/json" } });
    const handler = makeHandler(async (input, init) => {
      const url = String(input);
      signals.push(init?.signal as AbortSignal);
      if (timeoutTarget === "weather_headers" && url === openMeteoUrl) {
        return new Promise<Response>(() => undefined);
      }
      if (timeoutTarget === "usgs_body" && url !== openMeteoUrl) return hangingBody;
      if (url === openMeteoUrl) return jsonResponse(weatherPayload());
      return new Promise<Response>((resolve) => { releaseUsgs = resolve; });
    }, harness.clock);

    const pending = handler(request("?mode=fetch"), demoEnvironment);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    const expectedActiveDeadlines = timeoutTarget === "weather_headers"
      ? [CONTEXT_SOURCES_LIMITS.requestDeadlineMs, CONTEXT_SOURCES_LIMITS.requestDeadlineMs]
      : [CONTEXT_SOURCES_LIMITS.requestDeadlineMs];
    assert.deepEqual(harness.scheduledDelays(), expectedActiveDeadlines);
    harness.fireDeadline(0);
    if (timeoutTarget === "weather_headers") releaseUsgs(jsonResponse(earthquakeCollection([])));
    const response = await pending;
    const payload = await readPayload(response);
    const timedOutId = timeoutTarget === "weather_headers" ? "openmeteo" : "usgs";
    const peerId = timeoutTarget === "weather_headers" ? "usgs" : "openmeteo";
    assert.equal(source(payload, timedOutId).status, "unavailable");
    assert.equal(source(payload, timedOutId).error, "timeout");
    assert.equal(source(payload, peerId).status, timeoutTarget === "weather_headers" ? "empty" : "available");
    assert.equal(signals[timeoutTarget === "weather_headers" ? 0 : 1]?.aborted, true);
  }
});

test("concurrent fetches coalesce, cache normalized results five minutes, then refresh without stale fallback", async () => {
  const harness = fakeClock();
  const calls: Array<{ url: string; resolve: (response: Response) => void }> = [];
  let failAfterExpiry = false;
  const handler = makeHandler((input) => new Promise<Response>((resolve) => {
    if (failAfterExpiry) {
      resolve(new Response("provider unavailable", { status: 503, headers: { "content-type": "application/json" } }));
      return;
    }
    calls.push({ url: String(input), resolve });
  }), harness.clock);

  const firstPending = handler(request("?mode=fetch"), demoEnvironment);
  const secondPending = handler(request("?mode=fetch"), demoEnvironment);
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  assert.equal(calls.length, 2);
  for (const call of calls) {
    call.resolve(call.url === openMeteoUrl
      ? jsonResponse(weatherPayload())
      : jsonResponse(earthquakeCollection([])));
  }
  const [first, second] = await Promise.all([firstPending, secondPending]);
  const firstPayload = await readPayload(first) as { cached: boolean };
  const secondPayload = await readPayload(second) as { cached: boolean };
  assert.equal(firstPayload.cached || secondPayload.cached, true);
  assert.equal(firstPayload.cached && secondPayload.cached, false);

  const cached = await handler(request("?mode=fetch"), demoEnvironment);
  assert.equal((await readPayload(cached) as { cached: boolean }).cached, true);
  assert.equal(calls.length, 2);

  harness.setNow(fixedNow + CONTEXT_SOURCES_LIMITS.cacheTtlMs);
  failAfterExpiry = true;
  const refreshed = await handler(request("?mode=fetch"), demoEnvironment);
  const refreshedPayload = await readPayload(refreshed) as { cached: boolean };
  assert.equal(refreshedPayload.cached, false);
  assert.equal(source(refreshedPayload, "openmeteo").status, "unavailable");
  assert.equal(source(refreshedPayload, "usgs").status, "unavailable");
  assert.equal(calls.length, 2);
});

test("USGS caps overlong provider output and rejects responses above the provider-record budget", async () => {
  const overReturned = Array.from({ length: 31 }, (_, index) => earthquakeFeature(`us7000${String(index).padStart(4, "0")}`, {
    time: fixedNow - (index + 1) * 60_000,
    updated: fixedNow - 10_000,
  }));
  const cappedHandler = makeHandler(async (input) => String(input) === openMeteoUrl
    ? jsonResponse(weatherPayload())
    : jsonResponse(earthquakeCollection(overReturned, { count: 31 })));
  const cappedPayload = await readPayload(await cappedHandler(request("?mode=fetch"), demoEnvironment));
  const capped = source(cappedPayload, "usgs");
  assert.equal(capped.status, "available");
  assert.equal(capped.limited, true);
  assert.equal(capped.rejected_count, 1);
  assert.equal((capped.records as unknown[]).length, 30);

  const oversizedHandler = makeHandler(async (input) => String(input) === openMeteoUrl
    ? jsonResponse(weatherPayload())
    : jsonResponse({
      type: "FeatureCollection",
      metadata: { generated: fixedNow - 30_000, status: 200 },
      features: Array.from({ length: CONTEXT_SOURCES_LIMITS.maxProviderRecords + 1 }, () => null),
    }));
  const oversizedPayload = await readPayload(await oversizedHandler(request("?mode=fetch"), demoEnvironment));
  assert.equal(source(oversizedPayload, "usgs").status, "unavailable");
  assert.equal(source(oversizedPayload, "usgs").error, "invalid_payload");
});
