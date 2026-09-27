import assert from "node:assert/strict";
import test from "node:test";
import worker from "../src/index.js";
import type {
  EventDetail,
  EventPage,
  HistoryPage,
  PublicContext,
} from "../src/contracts/public-api.js";
import {
  handlePublicApiRequest,
  type WorkerEnvironment,
} from "../src/layers/l4-application-integration/api.js";
import {
  JAKARTA_GEOJSON_QUERY_ENVELOPE,
  readPublicGeoJSONQuery,
} from "../src/layers/l4-application-integration/public-geojson-query.js";
import { PublicReadModel } from "../src/layers/l4-application-integration/public-read-model.js";
import {
  PublicEventListPageServiceError,
  type PublicEventListPageService,
} from "../src/layers/l4-application-integration/public-event-list-page-service.js";
import type { PublicEventDetailProjectionService } from "../src/layers/l4-application-integration/public-event-detail-projection-service.js";
import type { PublicEventHistoryProjectionService } from "../src/layers/l4-application-integration/public-event-history-projection-service.js";
import type { PublicEventGeoJSONRuntime } from "../src/runtime/public-event-geojson-runtime.js";
import {
  API_REQUEST_EVENT_NAME,
  consoleTelemetry,
  type TelemetryRecord,
} from "../src/layers/l5-evaluation-monitoring/telemetry.js";

const demoEnvironment: WorkerEnvironment = { DATASET_MODE: "demo" };

async function readJson<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

function assertKeys(value: object, expected: string[]) {
  assert.deepEqual(Object.keys(value).sort(), [...expected].sort());
}

test("GeoJSON query defaults to the inclusive application envelope and accepts contained bounds", () => {
  assert.deepEqual(readPublicGeoJSONQuery(new URLSearchParams()), {
    bbox: JAKARTA_GEOJSON_QUERY_ENVELOPE,
    category: null,
    lifecycle: null,
    freshness: null,
  });
  assert.deepEqual(
    readPublicGeoJSONQuery(new URLSearchParams({ bbox: "106.32,-6.40,106.98,-5.16" })).bbox,
    JAKARTA_GEOJSON_QUERY_ENVELOPE,
  );
  assert.deepEqual(
    readPublicGeoJSONQuery(new URLSearchParams({ bbox: "106.70,-6.30,106.90,-6.10" })).bbox,
    [106.7, -6.3, 106.9, -6.1],
  );
});

test("GeoJSON route returns the exact empty FeatureCollection for the current demo dataset", async () => {
  const requests = [
    new Request("http://localhost/api/v1/events.geojson"),
    new Request("http://localhost/api/v1/events.geojson?bbox=106.32,-6.40,106.98,-5.16"),
    new Request("http://localhost/api/v1/events.geojson?bbox=106.70,-6.30,106.90,-6.10"),
  ];

  for (const request of requests) {
    const response = await worker.fetch(request, demoEnvironment);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "application/geo+json");
    assert.deepEqual(await readJson(response), { type: "FeatureCollection", features: [] });
  }

  const write = await worker.fetch(
    new Request("http://localhost/api/v1/events.geojson", { method: "POST" }),
    demoEnvironment,
  );
  assert.equal(write.status, 405);
});

test("only the exact live GeoJSON route uses its injected runtime after query validation", async () => {
  let calls = 0;
  let receivedQuery: URLSearchParams | undefined;
  const runtime: PublicEventGeoJSONRuntime = {
    async read(query) {
      calls += 1;
      receivedQuery = query;
      return {
        type: "FeatureCollection",
        features: [],
      };
    },
  };

  const invalid = await handlePublicApiRequest(
    new Request("http://localhost/api/v1/events.geojson?bbox=106.70,-6.30,106.90,-6.10&unknown=x"),
    { DATASET_MODE: "live" },
    undefined,
    undefined,
    undefined,
    undefined,
    runtime,
  );
  assert.equal(invalid.status, 400);
  assert.equal(calls, 0, "query validation runs before the runtime");

  const live = await handlePublicApiRequest(
    new Request("http://localhost/api/v1/events.geojson?bbox=106.70,-6.30,106.90,-6.10"),
    { DATASET_MODE: "live" },
    undefined,
    undefined,
    undefined,
    undefined,
    runtime,
  );
  assert.equal(live.status, 200);
  assert.equal(live.headers.get("content-type"), "application/geo+json");
  assert.equal(live.headers.get("cache-control"), "no-store");
  assert.equal(live.headers.get("x-content-type-options"), "nosniff");
  assert.deepEqual(await readJson(live), { type: "FeatureCollection", features: [] });
  assert.equal(calls, 1);
  assert.ok(receivedQuery instanceof URLSearchParams);
  assert.equal(receivedQuery.get("bbox"), "106.70,-6.30,106.90,-6.10");

  const unavailable = await handlePublicApiRequest(
    new Request("http://localhost/api/v1/events.geojson"),
    { DATASET_MODE: "live" },
  );
  assert.equal(unavailable.status, 503);
  assert.equal(calls, 1);

  const demo = await handlePublicApiRequest(
    new Request("http://localhost/api/v1/events.geojson"),
    demoEnvironment,
    undefined,
    undefined,
    undefined,
    undefined,
    runtime,
  );
  assert.equal(demo.status, 200);
  assert.deepEqual(await readJson(demo), { type: "FeatureCollection", features: [] });
  assert.equal(calls, 1, "an injected live runtime does not replace the demo path");
});

test("GeoJSON rejects malformed, reversed, overlong, non-finite, and out-of-envelope bounds safely", async () => {
  const invalidBounds = [
    "106.4,-6.2,106.7",
    "106.4,-6.2,106.7,-6.1,1",
    "106.4,-6.2,not-a-number,-6.1",
    "106.4,-6.2,Infinity,-6.1",
    "106.4,-6.2,NaN,-6.1",
    "106.4,-6.2,1e999,-6.1",
    "106.8,-6.2,106.7,-6.1",
    "106.4,-5.8,106.7,-6.0",
    "106.31,-6.2,106.7,-6.1",
    "106.4,-6.41,106.7,-6.1",
    "106.4,-6.2,106.99,-6.1",
    "106.4,-6.2,106.7,-5.15",
    "x".repeat(101),
  ];

  for (const bbox of invalidBounds) {
    const response = await worker.fetch(
      new Request(`http://localhost/api/v1/events.geojson?${new URLSearchParams({ bbox })}`),
      demoEnvironment,
    );
    const body = await readJson<{ code: string; message: string; request_id: string }>(response);
    assert.equal(response.status, 400, bbox.slice(0, 40));
    assertKeys(body, ["code", "message", "request_id"]);
    assert.equal(body.code, "INVALID_REQUEST");
    assert.equal(body.message, "bbox is invalid");
    assert.ok(!body.message.includes(bbox));
    assert.match(body.request_id, /^[0-9a-f-]{36}$/i);
  }
});

test("GeoJSON validates only its documented category, lifecycle, and freshness enums", async () => {
  const validFilters = [
    ...[
      "crime_personal_security",
      "demonstrations_public_gatherings",
      "crowds_major_events",
      "violence_immediate_threats",
      "disasters_weather",
      "fires_infrastructure_hazards",
      "transport_road_incidents",
      "utilities_essential_services",
      "health_environmental_advisories",
      "group_specific_critical_notices",
    ].map((category) => new URLSearchParams({ category })),
    ...["planned", "ongoing", "resolved", "cancelled", "unknown"].map(
      (lifecycle) => new URLSearchParams({ lifecycle }),
    ),
    ...["current", "needs_update", "expired"].map(
      (freshness) => new URLSearchParams({ freshness }),
    ),
  ];

  for (const search of validFilters) {
    const response = await worker.fetch(
      new Request(`http://localhost/api/v1/events.geojson?${search}`),
      demoEnvironment,
    );
    assert.equal(response.status, 200, search.toString());
  }

  for (const search of [
    new URLSearchParams({ category: "unknown_category" }),
    new URLSearchParams({ lifecycle: "active" }),
    new URLSearchParams({ freshness: "stale" }),
    new URLSearchParams("category=planned&category=ongoing"),
    new URLSearchParams("bbox=106.4%2C-6.2%2C106.7%2C-6.1&bbox=106.5%2C-6.2%2C106.7%2C-6.1"),
    new URLSearchParams({ limit: "1" }),
    new URLSearchParams({ cursor: "0" }),
    new URLSearchParams({ q: "extra-filter" }),
  ]) {
    const response = await worker.fetch(
      new Request(`http://localhost/api/v1/events.geojson?${search}`),
      demoEnvironment,
    );
    const body = await readJson<{ code: string; message: string }>(response);
    assert.equal(response.status, 400, search.toString());
    assert.equal(body.code, "INVALID_REQUEST");
    assert.ok(!body.message.includes(search.toString()));
  }
});

test("live GeoJSON without a configured runtime does not read the demo model", async () => {
  const originalGeoJSON = PublicReadModel.prototype.geoJSON;
  let readCount = 0;
  PublicReadModel.prototype.geoJSON = function () {
    readCount += 1;
    throw new Error("GeoJSON fixtures must not be read");
  };

  let response: Response;
  try {
    response = await worker.fetch(
      new Request("http://localhost/api/v1/events.geojson"),
      { DATASET_MODE: "live" },
    );
  } finally {
    PublicReadModel.prototype.geoJSON = originalGeoJSON;
  }

  const body = await readJson<{ code: string; message: string }>(response!);
  assert.equal(response!.status, 503);
  assert.equal(body.code, "TEMPORARILY_UNAVAILABLE");
  assert.equal(body.message, "The public read could not be completed.");
  assert.equal(readCount, 0);
});

test("context reports the server-selected synthetic dataset in demo and omitted modes", async () => {
  for (const environment of [demoEnvironment, {}]) {
    const response = await worker.fetch(
      new Request("http://localhost/api/v1/context"),
      environment,
    );
    const body = await readJson<PublicContext>(response);

    assert.equal(response.status, 200);
    assert.equal(body.dataset_mode, "demo");
    assert.equal(body.dataset_label, "synthetic");
    assert.equal(new Date(body.generated_at).toISOString(), body.generated_at);
    assert.deepEqual(body.sources, []);
    assertKeys(body, ["dataset_mode", "dataset_label", "generated_at", "sources"]);
  }
});

test("exact live context uses bounded public source status without initializing SQL", async () => {
  let hyperdriveReads = 0;
  const environment: WorkerEnvironment = {
    DATASET_MODE: "live",
    get HYPERDRIVE(): { readonly connectionString?: string } {
      hyperdriveReads += 1;
      throw new Error("context must not initialize a database connection");
    },
  };
  const response = await worker.fetch(
    new Request("http://localhost/api/v1/context?dataset_mode=demo&token=private-query-marker", {
      headers: { "x-dataset-mode": "demo" },
    }),
    environment,
  );
  const body = await readJson<PublicContext>(response);
  const serialized = JSON.stringify(body);

  assert.equal(response.status, 200);
  assert.equal(body.dataset_mode, "live");
  assert.equal(body.dataset_label, "live");
  assert.equal(new Date(body.generated_at).toISOString(), body.generated_at);
  assert.deepEqual(body.sources, []);
  assertKeys(body, ["dataset_mode", "dataset_label", "generated_at", "sources"]);
  assert.ok(!serialized.includes("private-query-marker"));
  assert.equal(hyperdriveReads, 0);

  const write = await worker.fetch(
    new Request("http://localhost/api/v1/context", { method: "POST" }),
    { DATASET_MODE: "live" },
  );
  assert.equal(write.status, 405);
  assert.equal((await readJson<{ code: string }>(write)).code, "INVALID_REQUEST");

  const unknownMode = await worker.fetch(
    new Request("http://localhost/api/v1/context"),
    { DATASET_MODE: "staging" },
  );
  assert.equal(unknownMode.status, 503);
  assert.equal((await readJson<{ code: string }>(unknownMode)).code, "TEMPORARILY_UNAVAILABLE");
});

test("event pages use the OpenAPI projection and bounded read filters", async () => {
  const firstResponse = await worker.fetch(
    new Request("http://localhost/api/v1/events?limit=1"),
    demoEnvironment,
  );
  const firstPage = await readJson<{
    data: Array<{ event_id: string; claims: unknown[]; impacts: unknown[] }>;
    page: { next_cursor: string | null; cursor_expires_at: string | null };
  }>(firstResponse);

  assert.equal(firstResponse.status, 200);
  assert.equal(firstPage.data.length, 1);
  assert.equal(firstPage.data[0]?.event_id, "synthetic-demo-01");
  assert.deepEqual(firstPage.data[0]?.claims, []);
  assert.deepEqual(firstPage.data[0]?.impacts, []);
  assert.equal(firstPage.page.next_cursor, "1");
  assert.ok(firstPage.page.cursor_expires_at);

  const secondResponse = await worker.fetch(
    new Request("http://localhost/api/v1/events?cursor=1&limit=1"),
    demoEnvironment,
  );
  const secondPage = await readJson<typeof firstPage>(secondResponse);
  assert.equal(secondPage.data[0]?.event_id, "synthetic-demo-02");
  assert.equal(secondPage.page.next_cursor, null);
  assert.equal(secondPage.page.cursor_expires_at, null);

  const emptyResponse = await worker.fetch(
    new Request("http://localhost/api/v1/events?q=no-matching-fiction"),
    demoEnvironment,
  );
  const emptyPage = await readJson<typeof firstPage>(emptyResponse);
  assert.deepEqual(emptyPage.data, []);
  assert.deepEqual(emptyPage.page, { next_cursor: null, cursor_expires_at: null });
});

test("injected event-list page service receives route query and returns its exact public page", async () => {
  const page: EventPage = {
    data: [],
    page: {
      next_cursor: "synthetic-cursor-token",
      cursor_expires_at: "2026-09-27T01:15:00.000Z",
    },
  };
  const query = "limit=7&q=Canal%20Barat&category=disasters_weather&cursor=opaque%2Fcursor";
  let calls = 0;
  let receivedQuery: URLSearchParams | undefined;
  const service: PublicEventListPageService = {
    async read(search) {
      calls += 1;
      receivedQuery = search;
      return page;
    },
  };

  const response = await handlePublicApiRequest(
    new Request(`http://localhost/api/v1/events?${query}`),
    demoEnvironment,
    undefined,
    service,
  );
  const body = await readJson<EventPage>(response);

  assert.equal(response.status, 200);
  assert.equal(calls, 1);
  assert.ok(receivedQuery);
  assert.equal(receivedQuery.get("limit"), "7");
  assert.equal(receivedQuery.get("q"), "Canal Barat");
  assert.equal(receivedQuery.get("category"), "disasters_weather");
  assert.equal(receivedQuery.get("cursor"), "opaque/cursor");
  assert.deepEqual(body, page);
  assert.deepEqual(Object.keys(body).sort(), ["data", "page"]);
  assert.deepEqual(Object.keys(body.page).sort(), ["cursor_expires_at", "next_cursor"]);
  assert.equal(response.headers.get("content-type"), "application/json; charset=utf-8");
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");

  const detailResponse = await handlePublicApiRequest(
    new Request("http://localhost/api/v1/events/synthetic-demo-01"),
    demoEnvironment,
    undefined,
    service,
  );
  assert.equal(detailResponse.status, 200);
  assert.equal(calls, 1);
});

test("exact live detail uses its injected projection while demo and other route gates stay intact", async () => {
  const detail: EventDetail = {
    event_id: "event-synthetic-live-01",
    version: 1,
    title: "Synthetic live-shaped detail",
    summary: "An authored fictional detail response.",
    category: "transport_road_incidents",
    tags: [],
    lifecycle: "unknown",
    freshness: {
      status: "current",
      evaluated_at: "2026-09-26T03:00:00Z",
      review_due_at: null,
      basis: "manual_review",
    },
    event_time: { start: null, end: null, precision: "unknown" },
    validity: { valid_from: null, valid_until: null },
    scope: { places: [], services: [], institutions: [], audiences: [] },
    claims: [],
    impacts: [],
    published_at: "2026-09-26T03:01:00Z",
    geometries: [],
  };
  let detailCalls = 0;
  let receivedId: unknown;
  const detailService: PublicEventDetailProjectionService = {
    async read(eventId) {
      detailCalls += 1;
      receivedId = eventId;
      return { kind: "found", detail };
    },
  };
  let listCalls = 0;
  const page: EventPage = {
    data: [],
    page: { next_cursor: null, cursor_expires_at: null },
  };
  const listService: PublicEventListPageService = {
    async read() {
      listCalls += 1;
      return page;
    },
  };

  const detailResponse = await handlePublicApiRequest(
    new Request("http://localhost/api/v1/events/event-synthetic-live-01"),
    { DATASET_MODE: "live" },
    undefined,
    listService,
    detailService,
  );
  assert.equal(detailResponse.status, 200);
  assert.deepEqual(await readJson<EventDetail>(detailResponse), detail);
  assert.equal(detailCalls, 1);
  assert.equal(receivedId, "event-synthetic-live-01");
  assert.equal(listCalls, 0);

  const listResponse = await handlePublicApiRequest(
    new Request("http://localhost/api/v1/events?limit=1"),
    { DATASET_MODE: "live" },
    undefined,
    listService,
    detailService,
  );
  assert.equal(listResponse.status, 200);
  assert.deepEqual(await readJson<EventPage>(listResponse), page);
  assert.equal(listCalls, 1);
  assert.equal(detailCalls, 1);

  const demoDetail = await handlePublicApiRequest(
    new Request("http://localhost/api/v1/events/synthetic-demo-01"),
    demoEnvironment,
    undefined,
    listService,
    detailService,
  );
  assert.equal(demoDetail.status, 200);
  assert.equal((await readJson<EventDetail>(demoDetail)).event_id, "synthetic-demo-01");
  assert.equal(detailCalls, 1);

  const invalidLiveId = await handlePublicApiRequest(
    new Request("http://localhost/api/v1/events/bad%20id"),
    { DATASET_MODE: "live" },
    undefined,
    listService,
    detailService,
  );
  assert.equal(invalidLiveId.status, 400);
  assert.equal((await readJson<{ code: string }>(invalidLiveId)).code, "INVALID_REQUEST");
  assert.equal(detailCalls, 1);

  const unavailableDetail = await handlePublicApiRequest(
    new Request("http://localhost/api/v1/events/event-synthetic-live-01"),
    { DATASET_MODE: "live" },
  );
  assert.equal(unavailableDetail.status, 503);
  assert.equal((await readJson<{ code: string }>(unavailableDetail)).code, "TEMPORARILY_UNAVAILABLE");

  for (const path of [
    "/api/v1/events/event-synthetic-live-01/history",
    "/api/v1/events.geojson",
    "/api/v1/unknown",
  ]) {
    const response = await handlePublicApiRequest(
      new Request(`http://localhost${path}`),
      { DATASET_MODE: "live" },
      undefined,
      listService,
      detailService,
    );
    assert.equal(response.status, 503, path);
    assert.equal((await readJson<{ code: string }>(response)).code, "TEMPORARILY_UNAVAILABLE");
  }
  assert.equal(detailCalls, 1);
  assert.equal(listCalls, 1);
});

test("exact live history uses its injected reviewed projection and leaves demo history intact", async () => {
  const page: HistoryPage = {
    data: [{
      event_id: "event-synthetic-live-history-01",
      version: 2,
      change_type: "corrected",
      changed_at: "2026-09-26T03:01:00Z",
      summary: "Authored fictional moderator-reviewed change.",
    }],
    page: { next_cursor: "2", cursor_expires_at: null },
  };
  let calls = 0;
  let receivedId: unknown;
  let receivedQuery: unknown;
  const historyService: PublicEventHistoryProjectionService = {
    async read(eventId, query) {
      calls += 1;
      receivedId = eventId;
      receivedQuery = query;
      return { kind: "found", page };
    },
  };

  const response = await handlePublicApiRequest(
    new Request("http://localhost/api/v1/events/event-synthetic-live-history-01/history?cursor=1&limit=7"),
    { DATASET_MODE: "live" },
    undefined,
    undefined,
    undefined,
    historyService,
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await readJson<HistoryPage>(response), page);
  assert.equal(calls, 1);
  assert.equal(receivedId, "event-synthetic-live-history-01");
  assert.ok(receivedQuery instanceof URLSearchParams);
  assert.equal(receivedQuery.get("cursor"), "1");
  assert.equal(receivedQuery.get("limit"), "7");

  const unavailable = await handlePublicApiRequest(
    new Request("http://localhost/api/v1/events/event-synthetic-live-history-01/history"),
    { DATASET_MODE: "live" },
  );
  assert.equal(unavailable.status, 503);
  assert.equal((await readJson<{ code: string }>(unavailable)).code, "TEMPORARILY_UNAVAILABLE");
  assert.equal(calls, 1);

  const demo = await handlePublicApiRequest(
    new Request("http://localhost/api/v1/events/synthetic-demo-01/history?cursor=0&limit=20"),
    demoEnvironment,
    undefined,
    undefined,
    undefined,
    historyService,
  );
  assert.equal(demo.status, 200);
  assert.equal((await readJson<HistoryPage>(demo)).data[0]?.event_id, "synthetic-demo-01");
  assert.equal(calls, 1);
});

test("injected event-list service errors map to fixed redacted API responses", async () => {
  const marker = "private-query-cursor-key-sql-source-exception-marker";
  const cases: Array<{
    code: "INVALID_REQUEST" | "PUBLIC_EVENT_LIST_READ_FAILED";
    status: number;
    apiCode: string;
    message: string;
  }> = [
    {
      code: "INVALID_REQUEST",
      status: 400,
      apiCode: "INVALID_REQUEST",
      message: "The public event list request is invalid.",
    },
    {
      code: "PUBLIC_EVENT_LIST_READ_FAILED",
      status: 500,
      apiCode: "TEMPORARILY_UNAVAILABLE",
      message: "The public read could not be completed.",
    },
  ];

  for (const outcome of cases) {
    let calls = 0;
    const service: PublicEventListPageService = {
      async read() {
        calls += 1;
        const error = new PublicEventListPageServiceError(outcome.code);
        error.message = marker;
        throw error;
      },
    };
    const response = await handlePublicApiRequest(
      new Request(`http://localhost/api/v1/events?q=${marker}&cursor=${marker}`),
      demoEnvironment,
      undefined,
      service,
    );
    const body = await readJson<{ code: string; message: string; request_id: string }>(response);

    assert.equal(calls, 1);
    assert.equal(response.status, outcome.status);
    assert.deepEqual(Object.keys(body).sort(), ["code", "message", "request_id"]);
    assert.equal(body.code, outcome.apiCode);
    assert.equal(body.message, outcome.message);
    assert.match(body.request_id, /^[0-9a-f-]{36}$/i);
    assert.ok(!JSON.stringify(body).includes(marker));
  }

  const unrelatedMarker = `unrelated-${marker}`;
  const unrelatedService: PublicEventListPageService = {
    async read() {
      throw new Error(unrelatedMarker);
    },
  };
  const unrelatedResponse = await handlePublicApiRequest(
    new Request(`http://localhost/api/v1/events?q=${marker}`),
    demoEnvironment,
    undefined,
    unrelatedService,
  );
  const unrelatedBody = await readJson<{ code: string; message: string; request_id: string }>(unrelatedResponse);
  assert.equal(unrelatedResponse.status, 500);
  assert.deepEqual(Object.keys(unrelatedBody).sort(), ["code", "message", "request_id"]);
  assert.equal(unrelatedBody.code, "TEMPORARILY_UNAVAILABLE");
  assert.equal(unrelatedBody.message, "The public read could not be completed.");
  assert.ok(!JSON.stringify(unrelatedBody).includes(marker));
});

test("event-list page service injection cannot bypass an unsupported runtime mode", async () => {
  let calls = 0;
  const service: PublicEventListPageService = {
    async read() {
      calls += 1;
      return { data: [], page: { next_cursor: null, cursor_expires_at: null } };
    },
  };
  const response = await handlePublicApiRequest(
    new Request("http://localhost/api/v1/events?q=private-query-marker&cursor=private-cursor-marker"),
    { DATASET_MODE: "staging" },
    undefined,
    service,
  );
  const body = await readJson<{ code: string; message: string; request_id: string }>(response);

  assert.equal(calls, 0);
  assert.equal(response.status, 503);
  assert.deepEqual(Object.keys(body).sort(), ["code", "message", "request_id"]);
  assert.equal(body.code, "TEMPORARILY_UNAVAILABLE");
  assert.match(body.message, /synthetic demo dataset/);
  assert.ok(!JSON.stringify(body).includes("private-query-marker"));
  assert.ok(!JSON.stringify(body).includes("private-cursor-marker"));
});

test("event detail returns the exact synthetic fixture projection without added evidence or geometry", async () => {
  const response = await worker.fetch(
    new Request("http://localhost/api/v1/events/synthetic-demo-01?dataset_mode=live", {
      headers: { "x-dataset-mode": "live" },
    }),
    demoEnvironment,
  );
  const body = await readJson<{
    event_id: string;
    version: number;
    title: string;
    summary: string;
    category: string;
    tags: Array<Record<string, unknown>>;
    lifecycle: string;
    freshness: Record<string, unknown>;
    event_time: Record<string, unknown>;
    validity: Record<string, unknown>;
    scope: Record<string, unknown>;
    claims: unknown[];
    impacts: unknown[];
    published_at: string;
    geometries: unknown[];
  }>(response);

  assert.equal(response.status, 200);
  assertKeys(body, [
    "event_id", "version", "title", "summary", "category", "tags", "lifecycle",
    "freshness", "event_time", "validity", "scope", "claims", "impacts", "published_at",
    "geometries",
  ]);
  assert.equal(body.event_id, "synthetic-demo-01");
  assert.match(body.title, /^Contoh fiktif:/);
  assert.match(body.summary, /Data contoh/);
  assertKeys(body.freshness, ["status", "evaluated_at", "review_due_at", "basis"]);
  assertKeys(body.event_time, ["start", "end", "precision"]);
  assertKeys(body.validity, ["valid_from", "valid_until"]);
  assertKeys(body.scope, ["places", "services", "institutions", "audiences"]);
  assertKeys(body.tags[0] ?? {}, ["namespace", "value"]);
  assert.deepEqual(body.claims, []);
  assert.deepEqual(body.impacts, []);
  assert.deepEqual(body.geometries, []);
  assert.deepEqual(body.scope, { places: [], services: [], institutions: [], audiences: [] });
  assert.equal(JSON.stringify(body).includes("source"), false);
  assert.equal(JSON.stringify(body).includes("safety"), false);
});

test("event history exposes only the single synthetic fixture version with stable bounded pagination", async () => {
  const defaultResponse = await worker.fetch(
    new Request("http://localhost/api/v1/events/synthetic-demo-01/history"),
    demoEnvironment,
  );
  const defaultPage = await readJson<{
    data: Array<Record<string, unknown>>;
    page: { next_cursor: string | null; cursor_expires_at: string | null };
  }>(defaultResponse);

  assert.equal(defaultResponse.status, 200);
  assertKeys(defaultPage, ["data", "page"]);
  assertKeys(defaultPage.page, ["next_cursor", "cursor_expires_at"]);
  assert.equal(defaultPage.data.length, 1);
  const [entry] = defaultPage.data;
  assert.ok(entry);
  assertKeys(entry, ["event_id", "version", "change_type", "changed_at", "summary"]);
  assert.equal(entry.event_id, "synthetic-demo-01");
  assert.equal(entry.version, 1);
  assert.equal(entry.change_type, "published");
  assert.equal(entry.changed_at, "2026-09-24T00:00:00.000Z");
  assert.match(String(entry.summary), /sintetis.*demonstrasi/i);
  assert.deepEqual(defaultPage.page, { next_cursor: null, cursor_expires_at: null });

  const maxPageResponse = await worker.fetch(
    new Request("http://localhost/api/v1/events/synthetic-demo-01/history?limit=100"),
    demoEnvironment,
  );
  assert.deepEqual(await readJson(maxPageResponse), defaultPage);

  const emptyPageResponse = await worker.fetch(
    new Request("http://localhost/api/v1/events/synthetic-demo-01/history?cursor=1&limit=1"),
    demoEnvironment,
  );
  const emptyPage = await readJson<typeof defaultPage>(emptyPageResponse);
  assert.equal(emptyPageResponse.status, 200);
  assert.deepEqual(emptyPage, {
    data: [],
    page: { next_cursor: null, cursor_expires_at: null },
  });

  const secondFixtureResponse = await worker.fetch(
    new Request("http://localhost/api/v1/events/synthetic-demo-02/history?limit=1"),
    demoEnvironment,
  );
  const secondFixturePage = await readJson<typeof defaultPage>(secondFixtureResponse);
  assert.equal(secondFixtureResponse.status, 200);
  assert.equal(secondFixturePage.data[0]?.event_id, "synthetic-demo-02");
  assert.equal(secondFixturePage.data[0]?.changed_at, "2026-09-24T00:00:00.000Z");
});

test("detail and history reject malformed IDs and return the documented not-found envelope", async () => {
  const knownButAbsent = await worker.fetch(
    new Request("http://localhost/api/v1/events/not-a-fixture"),
    demoEnvironment,
  );
  const absentHistory = await worker.fetch(
    new Request("http://localhost/api/v1/events/not-a-fixture/history"),
    demoEnvironment,
  );
  for (const response of [knownButAbsent, absentHistory]) {
    const error = await readJson<{ code: string; message: string; request_id: string }>(response);
    assert.equal(response.status, 404);
    assertKeys(error, ["code", "message", "request_id"]);
    assert.equal(error.code, "NOT_FOUND");
    assert.match(error.request_id, /^[0-9a-f-]{36}$/i);
  }

  const malformedUrls = [
    "http://localhost/api/v1/events/",
    "http://localhost/api/v1/events//history",
    "http://localhost/api/v1/events/%2F",
    "http://localhost/api/v1/events/%E0%A4%A",
    `http://localhost/api/v1/events/${"x".repeat(129)}`,
  ];
  for (const url of malformedUrls) {
    const response = await worker.fetch(new Request(url), demoEnvironment);
    const error = await readJson<{ code: string; message: string; request_id: string }>(response);
    assert.equal(response.status, 400, url);
    assert.equal(error.code, "INVALID_REQUEST");
    assertKeys(error, ["code", "message", "request_id"]);
    assert.equal(error.message.includes("x".repeat(129)), false);
  }
});

test("history query bounds follow the existing page convention", async () => {
  const invalidQueries = [
    "limit=0",
    "limit=101",
    "limit=1.5",
    "cursor=01",
    "cursor=-1",
    "cursor=1.0",
    `cursor=${"1".repeat(2049)}`,
  ];
  for (const query of invalidQueries) {
    const response = await worker.fetch(
      new Request(`http://localhost/api/v1/events/synthetic-demo-01/history?${query}`),
      demoEnvironment,
    );
    const body = await readJson<{ code: string }>(response);
    assert.equal(response.status, 400, query.slice(0, 40));
    assert.equal(body.code, "INVALID_REQUEST");
  }

  for (const query of ["limit=1", "limit=100", "cursor=0&limit=20"]) {
    const response = await worker.fetch(
      new Request(`http://localhost/api/v1/events/synthetic-demo-01/history?${query}`),
      demoEnvironment,
    );
    assert.equal(response.status, 200, query);
  }
});

test("browser input cannot select the server context dataset", async () => {
  const queryAttempt = await worker.fetch(
    new Request("http://localhost/api/v1/context?dataset_mode=live", {
      headers: { "x-dataset-mode": "live" },
    }),
    demoEnvironment,
  );
  const body = await readJson<{ dataset_mode: string; dataset_label: string }>(queryAttempt);

  assert.equal(body.dataset_mode, "demo");
  assert.equal(body.dataset_label, "synthetic");

  const liveRequest = await worker.fetch(
    new Request("http://localhost/api/v1/context?dataset_mode=demo", {
      headers: { "x-dataset-mode": "demo" },
    }),
    { DATASET_MODE: "live" },
  );
  const liveBody = await readJson<PublicContext>(liveRequest);
  assert.equal(liveRequest.status, 200);
  assert.equal(liveBody.dataset_mode, "live");
  assert.equal(liveBody.dataset_label, "live");
});

test("explicit non-demo mode blocks detail and history before a fixture read", async () => {
  const originalDetail = PublicReadModel.prototype.detail;
  const originalHistory = PublicReadModel.prototype.history;
  let fixtureReads = 0;
  PublicReadModel.prototype.detail = function () {
    fixtureReads += 1;
    throw new Error("fixture detail must not be read");
  };
  PublicReadModel.prototype.history = function () {
    fixtureReads += 1;
    throw new Error("fixture history must not be read");
  };

  try {
    for (const path of [
      "/api/v1/events/synthetic-demo-01",
      "/api/v1/events/synthetic-demo-01/history",
    ]) {
      const response = await worker.fetch(new Request(`http://localhost${path}`), {
        DATASET_MODE: "live",
      });
      const body = await readJson<{ code: string; message: string }>(response);
      assert.equal(response.status, 503);
      assert.equal(body.code, "TEMPORARILY_UNAVAILABLE");
      assert.equal(body.message, "The public read could not be completed.");
    }
  } finally {
    PublicReadModel.prototype.detail = originalDetail;
    PublicReadModel.prototype.history = originalHistory;
  }

  assert.equal(fixtureReads, 0);
});

test("invalid filters are rejected and writes cannot mutate the fixture", async () => {
  const before = await worker.fetch(
    new Request("http://localhost/api/v1/events"),
    demoEnvironment,
  );
  const beforeBody = await before.text();

  const invalid = await worker.fetch(
    new Request("http://localhost/api/v1/events?limit=101"),
    demoEnvironment,
  );
  assert.equal(invalid.status, 400);
  assert.equal((await readJson<{ code: string }>(invalid)).code, "INVALID_REQUEST");

  const write = await worker.fetch(
    new Request("http://localhost/api/v1/events", { method: "POST" }),
    demoEnvironment,
  );
  assert.equal(write.status, 405);

  const after = await worker.fetch(
    new Request("http://localhost/api/v1/events"),
    demoEnvironment,
  );
  assert.equal(await after.text(), beforeBody);

  const detailBefore = await worker.fetch(
    new Request("http://localhost/api/v1/events/synthetic-demo-01"),
    demoEnvironment,
  );
  const historyBefore = await worker.fetch(
    new Request("http://localhost/api/v1/events/synthetic-demo-01/history"),
    demoEnvironment,
  );
  const detailBeforeBody = await detailBefore.text();
  const historyBeforeBody = await historyBefore.text();

  for (const [path, method] of [
    ["/api/v1/events/synthetic-demo-01", "POST"],
    ["/api/v1/events/synthetic-demo-01/history", "PUT"],
    ["/api/v1/events/synthetic-demo-01/history", "DELETE"],
  ]) {
    const response = await worker.fetch(
      new Request(`http://localhost${path}`, { method }),
      demoEnvironment,
    );
    assert.equal(response.status, 405, `${method} ${path}`);
  }

  const detailAfter = await worker.fetch(
    new Request("http://localhost/api/v1/events/synthetic-demo-01"),
    demoEnvironment,
  );
  const historyAfter = await worker.fetch(
    new Request("http://localhost/api/v1/events/synthetic-demo-01/history"),
    demoEnvironment,
  );
  assert.equal(await detailAfter.text(), detailBeforeBody);
  assert.equal(await historyAfter.text(), historyBeforeBody);
});

test("injected telemetry records only bounded route, status, and duration across API outcomes", async () => {
  const marker = "private-query-marker-should-not-be-logged";
  const cases: Array<{
    request: Request;
    env: WorkerEnvironment;
    route: "context" | "events" | "other";
    status: number;
    pageService?: PublicEventListPageService;
  }> = [
    {
      request: new Request(`http://localhost/api/v1/context?label=${marker}`),
      env: demoEnvironment,
      route: "context",
      status: 200,
    },
    {
      request: new Request(`http://localhost/api/v1/events?limit=101&token=${marker}`),
      env: demoEnvironment,
      route: "events",
      status: 400,
    },
    {
      request: new Request(`http://localhost/api/v1/events.geojson?bbox=${marker}`),
      env: demoEnvironment,
      route: "events",
      status: 400,
    },
    {
      request: new Request(`http://localhost/api/v1/events/synthetic-demo-01?cursor=0&token=${marker}`),
      env: demoEnvironment,
      route: "events",
      status: 200,
    },
    {
      request: new Request(`http://localhost/api/v1/events/synthetic-demo-01/history?limit=1&token=${marker}`),
      env: demoEnvironment,
      route: "events",
      status: 200,
    },
    {
      request: new Request(`http://localhost/api/v1/events?token=${marker}`, { method: "POST" }),
      env: demoEnvironment,
      route: "events",
      status: 405,
    },
    {
      request: new Request(`http://localhost/api/v1/events?q=${marker}&cursor=${marker}`),
      env: demoEnvironment,
      route: "events",
      status: 200,
      pageService: {
        async read() {
          return { data: [], page: { next_cursor: null, cursor_expires_at: null } };
        },
      },
    },
    {
      request: new Request(`http://localhost/api/v1/events?q=${marker}&cursor=${marker}`),
      env: demoEnvironment,
      route: "events",
      status: 500,
      pageService: {
        async read() {
          throw new Error(marker);
        },
      },
    },
    {
      request: new Request(`http://localhost/api/v1/context?token=${marker}`),
      env: { DATASET_MODE: "live" },
      route: "context",
      status: 200,
    },
    {
      request: new Request(`http://localhost/private-route?token=${marker}`),
      env: demoEnvironment,
      route: "other",
      status: 404,
    },
  ];

  for (const outcome of cases) {
    const records: TelemetryRecord[] = [];
    const response = await handlePublicApiRequest(outcome.request, outcome.env, {
      record(record) {
        records.push(record);
      },
    }, outcome.pageService);

    assert.equal(response.status, outcome.status);
    assert.equal(records.length, 1);
    const [record] = records;
    assert.ok(record);
    if (record.eventName !== API_REQUEST_EVENT_NAME) {
      assert.fail("expected one API request telemetry record");
    }
    assert.deepEqual(Object.keys(record).sort(), ["durationMs", "eventName", "route", "status"]);
    assert.equal(record.eventName, API_REQUEST_EVENT_NAME);
    assert.equal(record.route, outcome.route);
    assert.equal(record.status, response.status);
    assert.ok(Number.isFinite(record.durationMs));
    assert.ok(record.durationMs >= 0);
    assert.ok(!JSON.stringify(record).includes(marker));
  }
});

test("telemetry sink exceptions leave the original API error response intact", async () => {
  let calls = 0;
  const response = await handlePublicApiRequest(
    new Request("http://localhost/api/v1/events?limit=101"),
    demoEnvironment,
    {
      record() {
        calls += 1;
        throw new Error("private sink failure detail");
      },
    },
  );
  const body = await readJson<{ code: string; message: string; request_id: string }>(response);

  assert.equal(calls, 1);
  assert.equal(response.status, 400);
  assert.equal(body.code, "INVALID_REQUEST");
  assert.equal(body.message, "limit must be between 1 and 100");
  assert.match(body.request_id, /^[0-9a-f-]{36}$/i);
  assert.deepEqual(Object.keys(body).sort(), ["code", "message", "request_id"]);

  const geoJSONResponse = await handlePublicApiRequest(
    new Request("http://localhost/api/v1/events.geojson?bbox=private-bounds-marker"),
    demoEnvironment,
    {
      record() {
        throw new Error("private sink failure detail");
      },
    },
  );
  const geoJSONBody = await readJson<{ code: string; message: string }>(geoJSONResponse);
  assert.equal(geoJSONResponse.status, 400);
  assert.equal(geoJSONBody.code, "INVALID_REQUEST");
  assert.equal(geoJSONBody.message, "bbox is invalid");
  assert.ok(!JSON.stringify(geoJSONBody).includes("private-bounds-marker"));
});

test("unexpected detail read errors are generic and do not expose exception text", async () => {
  const marker = "private fixture read failure detail";
  const originalDetail = PublicReadModel.prototype.detail;
  PublicReadModel.prototype.detail = function () {
    throw new Error(marker);
  };

  let response: Response;
  try {
    response = await worker.fetch(
      new Request("http://localhost/api/v1/events/synthetic-demo-01"),
      demoEnvironment,
    );
  } finally {
    PublicReadModel.prototype.detail = originalDetail;
  }

  const body = await response!.text();
  assert.equal(response!.status, 500);
  assert.ok(!body.includes(marker));
  assert.ok(body.includes("The public read could not be completed."));
});

test("unexpected GeoJSON read errors are generic and do not expose exception text", async () => {
  const marker = "private GeoJSON read failure detail";
  const originalGeoJSON = PublicReadModel.prototype.geoJSON;
  PublicReadModel.prototype.geoJSON = function () {
    throw new Error(marker);
  };

  let response: Response;
  try {
    response = await worker.fetch(
      new Request("http://localhost/api/v1/events.geojson"),
      demoEnvironment,
    );
  } finally {
    PublicReadModel.prototype.geoJSON = originalGeoJSON;
  }

  const body = await response!.text();
  assert.equal(response!.status, 500);
  assert.ok(!body.includes(marker));
  assert.ok(body.includes("The public read could not be completed."));
});

test("console telemetry writes only the stable allowlisted structured fields", () => {
  const writes: unknown[] = [];
  const originalLog = console.log;
  console.log = (...messages: unknown[]) => {
    writes.push(...messages);
  };

  try {
    consoleTelemetry.record({
      eventName: API_REQUEST_EVENT_NAME,
      route: "events",
      status: 400,
      durationMs: 12,
      url: "http://localhost/private?token=must-not-appear",
      requestId: "private-request-id",
    } as TelemetryRecord);
  } finally {
    console.log = originalLog;
  }

  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0], {
    event_name: "api_request",
    route: "events",
    http_status: 400,
    duration_ms: 12,
  });
  assert.ok(!JSON.stringify(writes[0]).includes("private"));
});
