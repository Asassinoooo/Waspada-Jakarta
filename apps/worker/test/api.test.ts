import assert from "node:assert/strict";
import test from "node:test";
import worker from "../src/index.js";
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

test("explicit non-demo mode blocks GeoJSON before the read model is accessed", async () => {
  const originalGeoJSON = PublicReadModel.prototype.geoJSON;
  let readCount = 0;
  PublicReadModel.prototype.geoJSON = function () {
    readCount += 1;
    throw new Error("GeoJSON fixtures must not be read");
  };

  let response: Response;
  try {
    response = await worker.fetch(
      new Request("http://localhost/api/v1/events.geojson?bbox=malformed"),
      { DATASET_MODE: "live" },
    );
  } finally {
    PublicReadModel.prototype.geoJSON = originalGeoJSON;
  }

  const body = await readJson<{ code: string; message: string }>(response!);
  assert.equal(response!.status, 503);
  assert.equal(body.code, "TEMPORARILY_UNAVAILABLE");
  assert.match(body.message, /synthetic demo dataset/);
  assert.equal(readCount, 0);
});

test("context reports a server-selected synthetic dataset with no live sources", async () => {
  const response = await worker.fetch(
    new Request("http://localhost/api/v1/context"),
    demoEnvironment,
  );
  const body = await readJson<{
    dataset_mode: string;
    dataset_label: string;
    sources: unknown[];
  }>(response);

  assert.equal(response.status, 200);
  assert.equal(body.dataset_mode, "demo");
  assert.equal(body.dataset_label, "synthetic");
  assert.deepEqual(body.sources, []);
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

test("browser input cannot select a live dataset", async () => {
  const queryAttempt = await worker.fetch(
    new Request("http://localhost/api/v1/context?dataset_mode=live", {
      headers: { "x-dataset-mode": "live" },
    }),
    demoEnvironment,
  );
  const body = await readJson<{ dataset_mode: string; dataset_label: string }>(queryAttempt);

  assert.equal(body.dataset_mode, "demo");
  assert.equal(body.dataset_label, "synthetic");

  const wrongRuntime = await worker.fetch(
    new Request("http://localhost/api/v1/context"),
    { DATASET_MODE: "live" },
  );
  assert.equal(wrongRuntime.status, 503);
  assert.match((await readJson<{ message: string }>(wrongRuntime)).message, /synthetic demo dataset/);
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
      assert.match(body.message, /synthetic demo dataset/);
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
      request: new Request(`http://localhost/api/v1/context?token=${marker}`),
      env: { DATASET_MODE: "live" },
      route: "context",
      status: 503,
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
    });

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
