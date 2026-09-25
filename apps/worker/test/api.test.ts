import assert from "node:assert/strict";
import test from "node:test";
import worker from "../src/index.js";
import {
  handlePublicApiRequest,
  type WorkerEnvironment,
} from "../src/layers/l4-application-integration/api.js";
import {
  API_REQUEST_EVENT_NAME,
  consoleTelemetry,
  type TelemetryRecord,
} from "../src/layers/l5-evaluation-monitoring/telemetry.js";

const demoEnvironment: WorkerEnvironment = { DATASET_MODE: "demo" };

async function readJson<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

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
