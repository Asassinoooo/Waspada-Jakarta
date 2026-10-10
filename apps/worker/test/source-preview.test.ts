import assert from "node:assert/strict";
import test from "node:test";
import { createSourcePreviewHandler } from "../src/layers/l4-application-integration/source-preview-api.js";
import {
  SOURCE_PREVIEW_LIMITS,
  type SourcePreviewClock,
} from "../src/layers/l1-data-knowledge/source-preview-adapters.js";

const previewPath = "https://waspada.test/api/v1/demo/source-preview";
const demoEnvironment = { DATASET_MODE: "demo", SOURCE_PREVIEW_ENABLED: "true" } as const;
const fixedNow = Date.parse("2026-10-10T05:00:00.000Z");

interface FakeClockHarness {
  readonly clock: SourcePreviewClock;
  setNow(value: number): void;
  fireDeadline(index?: number): void;
  scheduledDelays(): number[];
}

function fakeClock(initial = fixedNow): FakeClockHarness {
  let now = initial;
  const scheduled: Array<{ readonly handle: object; readonly callback: () => void; readonly delay: number; active: boolean }> = [];
  const clock: SourcePreviewClock = {
    now: () => now,
    schedule(next, nextDelay) {
      const entry = { handle: {}, callback: next, delay: nextDelay, active: true };
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
      const entry = active[index];
      if (entry !== undefined) {
        entry.active = false;
        entry.callback();
      }
    },
    scheduledDelays: () => scheduled.filter((entry) => entry.active).map((entry) => entry.delay),
  };
}

function request(search = ""): Request {
  return new Request(`${previewPath}${search}`);
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function emptyOsm() {
  return { osm3s: { timestamp_osm_base: "2026-10-10T04:06:43Z" }, elements: [] };
}

function osmNode(overrides: Record<string, unknown> = {}) {
  return {
    type: "node",
    id: 101,
    lat: -6.2,
    lon: 106.8,
    tags: { amenity: "hospital", name: "Rumah Sakit Pusat" },
    ...overrides,
  };
}

function petabencanaFeature(overrides: Record<string, unknown> = {}) {
  const { geometry, ...propertyOverrides } = overrides;
  return {
    type: "Feature",
    geometry: geometry ?? { type: "Point", coordinates: [106.8, -6.2] },
    properties: {
      pkey: "flood_123",
      disaster_type: "flood",
      created_at: "2026-10-10T04:30:00Z",
      status: "unverified",
      text: "PRIVATE REPORT BODY",
      photo_url: "https://private.example/image.jpg",
      reporter_name: "PRIVATE REPORTER",
      social_media_url: "https://private.example/post",
      ...propertyOverrides,
    },
  };
}

function petabencanaCollection(features: unknown[]) {
  return { statusCode: 200, result: { type: "FeatureCollection", features } };
}

function makeHandler(
  fetcher: typeof fetch,
  clock: SourcePreviewClock = fakeClock().clock,
) {
  return createSourcePreviewHandler({ fetch: fetcher, clock });
}

function source(payload: unknown, id: "osm" | "petabencana"): Record<string, unknown> {
  const body = payload as { sources: Array<Record<string, unknown>> };
  const matched = body.sources.find((item) => item.id === id);
  assert.ok(matched);
  return matched;
}

test("snapshot is the default, includes only the validated dated OSM snapshot, and does not fetch", async () => {
  let fetchCount = 0;
  const handler = makeHandler(async () => {
    fetchCount += 1;
    throw new Error("network must not be used for the snapshot");
  });

  const response = await handler(request(), demoEnvironment);
  assert.equal(response.status, 200);
  assert.equal(fetchCount, 0);
  const payload = await response.json() as {
    schema_version: string;
    mode: string;
    sources: Array<Record<string, unknown>>;
  };
  assert.equal(payload.schema_version, "source-preview-v1");
  assert.equal(payload.mode, "source_preview");
  assert.deepEqual(payload.sources.map((item) => item.id), ["osm", "petabencana"]);
  const osm = source(payload, "osm");
  const petabencana = source(payload, "petabencana");
  assert.equal(osm.data_mode, "snapshot");
  assert.equal(osm.status, "available");
  assert.equal(osm.fetched_at, "2026-10-10T04:08:05Z");
  assert.equal(osm.source_updated_at, "2026-10-10T04:06:43Z");
  assert.equal((osm.records as unknown[]).length, 100);
  assert.equal(petabencana.status, "not_requested");
  assert.equal(petabencana.data_mode, "none");
});

test("exact environment and route gates prevent fetch; query and mutation failures are closed", async () => {
  let fetchCount = 0;
  const handler = makeHandler(async () => {
    fetchCount += 1;
    return jsonResponse(emptyOsm());
  });

  assert.equal((await handler(request("?mode=fetch"), { DATASET_MODE: "live", SOURCE_PREVIEW_ENABLED: "true" })).status, 404);
  assert.equal((await handler(new Request(previewPath, { method: "POST" }), { DATASET_MODE: "live", SOURCE_PREVIEW_ENABLED: "true" })).status, 404);
  assert.equal((await handler(request("?mode=fetch"), { DATASET_MODE: "demo", SOURCE_PREVIEW_ENABLED: "True" })).status, 404);
  assert.equal((await handler(request("?mode=fetch&source=osm"), demoEnvironment)).status, 400);
  assert.equal((await handler(request("?mode=fetch&mode=fetch"), demoEnvironment)).status, 400);
  assert.equal((await handler(request("?mode=snapshot"), demoEnvironment)).status, 400);
  assert.equal((await handler(new Request(previewPath, { method: "POST" }), demoEnvironment)).status, 405);
  assert.equal((await handler(new Request("https://waspada.test/api/v1/demo/other"), demoEnvironment)).status, 404);
  assert.equal(fetchCount, 0);
});

test("fetch uses the fixed endpoints, bounded query, identifying user agent, and safe allowlisted projections", async () => {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const handler = makeHandler(async (input, init) => {
    const url = String(input);
    calls.push({ url, init });
    if (url === "https://overpass-api.de/api/interpreter") {
      return jsonResponse({
        osm3s: { timestamp_osm_base: "2026-10-10T04:59:00Z" },
        elements: [
          osmNode({ tags: { amenity: "hospital", name: "<b>RS Aman</b>", phone: "PRIVATE PHONE" } }),
          {
            type: "way",
            id: 202,
            center: { lat: -6.21, lon: 106.81 },
            tags: { amenity: "police", name: "Polsek Contoh", operator: "PRIVATE OPERATOR" },
          },
        ],
      });
    }
    if (url === "https://api.petabencana.id/reports?admin=ID-JK&timeperiod=86400&disaster=flood&geoformat=geojson") {
      return jsonResponse(petabencanaCollection([petabencanaFeature()]));
    }
    throw new Error("unexpected endpoint");
  });

  const response = await handler(request("?mode=fetch"), demoEnvironment);
  assert.equal(response.status, 200);
  assert.equal(calls.length, 2);
  const osmCall = calls.find((call) => call.url.includes("overpass-api"));
  const petabencanaCall = calls.find((call) => call.url.includes("api.petabencana.id"));
  assert.ok(osmCall);
  assert.ok(petabencanaCall);
  assert.equal(petabencanaCall.url,
    "https://api.petabencana.id/reports?admin=ID-JK&timeperiod=86400&disaster=flood&geoformat=geojson");
  assert.equal(osmCall.init?.method, "POST");
  assert.equal(osmCall.init?.redirect, "error");
  assert.equal(petabencanaCall.init?.method, "GET");
  assert.equal(petabencanaCall.init?.redirect, "error");
  const userAgent = "WaspadaJakarta-Team12-Demo/0.1 (+https://github.com/Asassinoooo/Waspada-Jakarta)";
  assert.equal(new Headers(osmCall.init?.headers).get("user-agent"), userAgent);
  assert.equal(new Headers(petabencanaCall.init?.headers).get("user-agent"), userAgent);
  const query = decodeURIComponent(String(osmCall.init?.body).slice("data=".length));
  assert.equal(query,
    '[out:json][timeout:20][maxsize:67108864];(nwr["amenity"="hospital"](-6.24,106.78,-6.14,106.88);nwr["amenity"="police"](-6.24,106.78,-6.14,106.88);nwr["amenity"="fire_station"](-6.24,106.78,-6.14,106.88););out center 100;');

  const payload = await response.json() as {
    generated_at: string;
    cached: boolean;
    sources: Array<Record<string, unknown>>;
  };
  assert.equal(payload.cached, false);
  const osm = source(payload, "osm");
  const petabencana = source(payload, "petabencana");
  const osmRecords = osm.records as Array<Record<string, unknown>>;
  const pbRecords = petabencana.records as Array<Record<string, unknown>>;
  assert.deepEqual(osmRecords.map((record) => record.id), ["osm:node/101", "osm:way/202"]);
  assert.equal(osmRecords[0]?.title, "<b>RS Aman</b>");
  assert.equal(osmRecords[0]?.coordinate_kind, "source_point");
  assert.equal(osmRecords[1]?.coordinate_kind, "source_extent_center");
  assert.deepEqual(Object.keys(osmRecords[0] ?? {}).sort(), [
    "coordinate_kind", "coordinates", "id", "kind", "source", "source_created_at", "source_status", "source_url", "title",
  ]);
  assert.equal(osmRecords[0]?.source_created_at, null);
  assert.equal(osmRecords[0]?.source_url, "https://www.openstreetmap.org/node/101");
  assert.equal(pbRecords.length, 1);
  assert.equal(pbRecords[0]?.id, "petabencana:flood_123");
  assert.equal(pbRecords[0]?.title, "Laporan banjir warga");
  assert.equal(pbRecords[0]?.source_created_at, "2026-10-10T04:30:00Z");
  assert.equal(pbRecords[0]?.source_url, "https://petabencana.id/");
  assert.equal(pbRecords[0]?.source_status, "unverified");
  const serialized = JSON.stringify(payload);
  for (const privateField of ["PRIVATE PHONE", "PRIVATE OPERATOR", "PRIVATE REPORT BODY", "PRIVATE REPORTER", "private.example"]) {
    assert.equal(serialized.includes(privateField), false);
  }
});

test("one failed provider remains a sanitized partial-source result", async () => {
  const handler = makeHandler(async (input) => {
    if (String(input).includes("overpass-api")) return jsonResponse(emptyOsm());
    throw new Error("PRIVATE UPSTREAM ERROR BODY");
  });

  const response = await handler(request("?mode=fetch"), demoEnvironment);
  assert.equal(response.status, 200);
  const payload = await response.json() as { sources: Array<Record<string, unknown>> };
  assert.equal(source(payload, "osm").status, "empty");
  assert.equal(source(payload, "petabencana").status, "unavailable");
  assert.equal(source(payload, "petabencana").error, "http_error");
  assert.equal(JSON.stringify(payload).includes("PRIVATE UPSTREAM ERROR BODY"), false);
});

test("early response rejection aborts that request after cleanup while the peer source succeeds", async () => {
  const cases = [
    {
      failingId: "osm" as const,
      failingUrl: "https://overpass-api.de/api/interpreter",
      failingResponse: () => new Response("upstream failure", {
        status: 503,
        headers: { "content-type": "application/json" },
      }),
      expectedError: "http_error",
    },
    {
      failingId: "petabencana" as const,
      failingUrl: "https://api.petabencana.id/reports?admin=ID-JK&timeperiod=86400&disaster=flood&geoformat=geojson",
      failingResponse: () => new Response("{}", {
        headers: {
          "content-type": "application/json",
          "content-length": String(SOURCE_PREVIEW_LIMITS.maxBodyBytes + 1),
        },
      }),
      expectedError: "invalid_payload",
    },
  ];

  for (const scenario of cases) {
    const signals = new Map<string, AbortSignal>();
    const handler = makeHandler(async (input, init) => {
      const url = String(input);
      signals.set(url, init?.signal as AbortSignal);
      if (url === scenario.failingUrl) return scenario.failingResponse();
      return url.includes("overpass-api")
        ? jsonResponse(emptyOsm())
        : jsonResponse(petabencanaCollection([]));
    });

    const response = await handler(request("?mode=fetch"), demoEnvironment);
    const payload = await response.json() as { sources: Array<Record<string, unknown>> };
    const failingSource = source(payload, scenario.failingId);
    const peerId = scenario.failingId === "osm" ? "petabencana" : "osm";
    const failedSignal = signals.get(scenario.failingUrl);
    assert.equal(failingSource.status, "unavailable");
    assert.equal(failingSource.error, scenario.expectedError);
    assert.equal(failedSignal?.aborted, true);
    assert.equal(source(payload, peerId).status, "empty");
  }
});

test("provider remarks and application errors are not empty successes", async () => {
  const handler = makeHandler(async (input) => String(input).includes("overpass-api")
    ? jsonResponse({ elements: [], remark: "runtime error" })
    : jsonResponse({ statusCode: 200, error: "provider error", result: { type: "FeatureCollection", features: [] } }));

  const response = await handler(request("?mode=fetch"), demoEnvironment);
  const payload = await response.json() as { sources: Array<Record<string, unknown>> };
  for (const id of ["osm", "petabencana"] as const) {
    assert.equal(source(payload, id).status, "unavailable");
    assert.equal(source(payload, id).error, "invalid_payload");
    assert.equal((source(payload, id).records as unknown[]).length, 0);
  }
});

test("invalid, out-of-window, non-point, stale, and future flood records are rejected safely", async () => {
  const features = [
    petabencanaFeature(),
    petabencanaFeature({ pkey: "missing-zone", created_at: "2026-10-10T04:30:00" }),
    petabencanaFeature({ pkey: "invalid-date", created_at: "2026-02-30T04:30:00Z" }),
    petabencanaFeature({ pkey: "future", created_at: "2026-10-10T05:01:00Z" }),
    petabencanaFeature({ pkey: "stale", created_at: "2026-10-09T04:59:59Z" }),
    petabencanaFeature({ pkey: "zero", geometry: { type: "Point", coordinates: [0, 0] } }),
    petabencanaFeature({ pkey: "outside", geometry: { type: "Point", coordinates: [107.01, -6.2] } }),
    petabencanaFeature({ pkey: "line", geometry: { type: "LineString", coordinates: [[106.8, -6.2], [106.81, -6.21]] } }),
    petabencanaFeature({ pkey: "unsafe/id" }),
    petabencanaFeature({ pkey: "old", created_at: "2026-10-09T04:59:59.999Z" }),
    petabencanaFeature({ pkey: "earthquake", disaster_type: "earthquake" }),
  ];
  const handler = makeHandler(async (input) => String(input).includes("overpass-api")
    ? jsonResponse(emptyOsm())
    : jsonResponse(petabencanaCollection(features)));

  const response = await handler(request("?mode=fetch"), demoEnvironment);
  const payload = await response.json() as { sources: Array<Record<string, unknown>> };
  const petabencana = source(payload, "petabencana");
  assert.equal(petabencana.status, "available");
  assert.equal(petabencana.rejected_count, 9);
  assert.deepEqual((petabencana.records as Array<{ id: string }>).map((record) => record.id), ["petabencana:flood_123"]);
});

test("contradictory duplicate identities are removed instead of selecting an input order", async () => {
  const first = osmNode({ tags: { amenity: "hospital", name: "Hospital A" } });
  const second = osmNode({ tags: { amenity: "hospital", name: "Hospital B" } });
  const handler = makeHandler(async (input) => String(input).includes("overpass-api")
    ? jsonResponse({ elements: [first, second] })
    : jsonResponse(petabencanaCollection([
      petabencanaFeature({ pkey: "same", created_at: "2026-10-10T04:30:00Z" }),
      petabencanaFeature({ pkey: "same", created_at: "2026-10-10T04:31:00Z" }),
    ])));

  const response = await handler(request("?mode=fetch"), demoEnvironment);
  const payload = await response.json() as { sources: Array<Record<string, unknown>> };
  const osm = source(payload, "osm");
  const petabencana = source(payload, "petabencana");
  assert.equal(osm.status, "unavailable");
  assert.equal(osm.error, "invalid_payload");
  assert.equal(osm.rejected_count, 2);
  assert.deepEqual(osm.records, []);
  assert.equal(petabencana.status, "unavailable");
  assert.equal(petabencana.rejected_count, 2);
  assert.deepEqual(petabencana.records, []);
});

test("streamed bodies stop at 1 MiB and remain independent from the other source", async () => {
  let streamedBytes = 0;
  const oversized = new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      const next = new Uint8Array(800 * 1024);
      streamedBytes += next.byteLength;
      controller.enqueue(next);
      if (streamedBytes > SOURCE_PREVIEW_LIMITS.maxBodyBytes) controller.close();
    },
  }), { headers: { "content-type": "application/json" } });
  const handler = makeHandler(async (input) => String(input).includes("overpass-api")
    ? oversized
    : jsonResponse(petabencanaCollection([])));

  const response = await handler(request("?mode=fetch"), demoEnvironment);
  const payload = await response.json() as { sources: Array<Record<string, unknown>> };
  assert.equal(source(payload, "osm").status, "unavailable");
  assert.equal(source(payload, "osm").error, "invalid_payload");
  assert.equal(source(payload, "petabencana").status, "empty");
  assert.ok(streamedBytes <= 2 * SOURCE_PREVIEW_LIMITS.maxBodyBytes);
});

test("per-source 25-second deadlines include body reads and abort only the source that timed out", async () => {
  const harness = fakeClock();
  let calls = 0;
  const signals: AbortSignal[] = [];
  let resolvePetabencana!: (response: Response) => void;
  const hangingBody = new Response(new ReadableStream<Uint8Array>({
    pull() {
      return new Promise<void>(() => undefined);
    },
  }), { headers: { "content-type": "application/json" } });
  const handler = makeHandler(async (input, init) => {
    calls += 1;
    signals.push(init?.signal as AbortSignal);
    if (String(input).includes("overpass-api")) return hangingBody;
    return new Promise<Response>((resolve) => {
      resolvePetabencana = resolve;
    });
  }, harness.clock);

  const pending = handler(request("?mode=fetch"), demoEnvironment);
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  assert.equal(calls, 2);
  assert.deepEqual(harness.scheduledDelays(), [
    SOURCE_PREVIEW_LIMITS.requestDeadlineMs,
    SOURCE_PREVIEW_LIMITS.requestDeadlineMs,
  ]);
  harness.fireDeadline();
  assert.equal(signals[0]?.aborted, true);
  assert.equal(signals[1]?.aborted, false);
  resolvePetabencana(jsonResponse(petabencanaCollection([])));
  const response = await pending;
  const payload = await response.json() as { sources: Array<Record<string, unknown>> };
  assert.equal(source(payload, "osm").status, "unavailable");
  assert.equal(source(payload, "osm").error, "timeout");
  assert.equal(source(payload, "petabencana").status, "empty");
  assert.equal(signals[1]?.aborted, true);
});

test("concurrent refreshes coalesce and the normalized result is cached for five minutes", async () => {
  const harness = fakeClock();
  const calls: Array<{ url: string; resolve: (response: Response) => void }> = [];
  const handler = makeHandler((input) => new Promise<Response>((resolve) => {
    calls.push({ url: String(input), resolve });
  }), harness.clock);

  const firstPending = handler(request("?mode=fetch"), demoEnvironment);
  const secondPending = handler(request("?mode=fetch"), demoEnvironment);
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  assert.equal(calls.length, 2);
  for (const call of calls) {
    call.resolve(call.url.includes("overpass-api")
      ? jsonResponse(emptyOsm())
      : jsonResponse(petabencanaCollection([])));
  }
  const [first, second] = await Promise.all([firstPending, secondPending]);
  const firstPayload = await first.json() as { cached: boolean };
  const secondPayload = await second.json() as { cached: boolean };
  assert.equal(firstPayload.cached || secondPayload.cached, true);
  assert.equal(firstPayload.cached && secondPayload.cached, false);

  const cachedResponse = await handler(request("?mode=fetch"), demoEnvironment);
  assert.equal((await cachedResponse.json() as { cached: boolean }).cached, true);
  assert.equal(calls.length, 2);

  harness.setNow(fixedNow + SOURCE_PREVIEW_LIMITS.cacheTtlMs);
  const refreshPending = handler(request("?mode=fetch"), demoEnvironment);
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  assert.equal(calls.length, 4);
  for (const call of calls.slice(2)) {
    call.resolve(call.url.includes("overpass-api")
      ? jsonResponse(emptyOsm())
      : jsonResponse(petabencanaCollection([])));
  }
  const refreshResponse = await refreshPending;
  assert.equal((await refreshResponse.json() as { cached: boolean }).cached, false);
});

test("an expired normalized cache refreshes without falling back to stale success", async () => {
  const harness = fakeClock();
  let count = 0;
  const handler = makeHandler(async (input) => {
    count += 1;
    if (count <= 2) return String(input).includes("overpass-api")
      ? jsonResponse(emptyOsm())
      : jsonResponse(petabencanaCollection([]));
    throw new Error("refreshed upstream unavailable");
  }, harness.clock);
  const firstResponse = await handler(request("?mode=fetch"), demoEnvironment);
  const firstPayload = await firstResponse.json() as { cached: boolean; sources: Array<Record<string, unknown>> };
  assert.equal(firstPayload.cached, false);
  assert.equal(source(firstPayload, "osm").status, "empty");

  harness.setNow(fixedNow + SOURCE_PREVIEW_LIMITS.cacheTtlMs + 1);
  const secondResponse = await handler(request("?mode=fetch"), demoEnvironment);
  const secondPayload = await secondResponse.json() as { cached: boolean; sources: Array<Record<string, unknown>> };
  assert.equal(secondPayload.cached, false);
  assert.equal(source(secondPayload, "osm").status, "unavailable");
  assert.equal(source(secondPayload, "osm").error, "http_error");
});
