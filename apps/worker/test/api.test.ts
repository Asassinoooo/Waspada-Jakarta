import assert from "node:assert/strict";
import test from "node:test";
import "./petabencana-geojson.test.js";
import worker from "../src/index.js";
import type { WorkerEnvironment } from "../src/layers/l4-application-integration/api.js";

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
