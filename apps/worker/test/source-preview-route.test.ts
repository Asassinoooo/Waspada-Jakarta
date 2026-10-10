import assert from "node:assert/strict";
import test from "node:test";
import worker from "../src/index.js";

const origin = "http://localhost";
const path = "/api/v1/demo/source-preview";
const env = { DATASET_MODE: "demo", SOURCE_PREVIEW_ENABLED: "true" };

test("source preview is gated separately from published events", async () => {
  for (const blocked of [{}, { DATASET_MODE: "demo" }, { ...env, DATASET_MODE: "live" }]) {
    assert.equal((await worker.fetch(new Request(origin + path), blocked)).status, 404);
  }
  const response = await worker.fetch(new Request(origin + path), env);
  assert.equal(response.status, 200);
  const preview = await response.json() as { mode: string; sources: { id: string; data_mode: string; records: unknown[]; status: string }[] };
  assert.equal(preview.mode, "source_preview");
  assert.equal(preview.sources[0]?.id, "osm");
  assert.equal(preview.sources[0]?.data_mode, "snapshot");
  assert.equal(preview.sources[0]?.records.length, 100);
  assert.equal(preview.sources[1]?.status, "not_requested");

  const context = await (await worker.fetch(new Request(origin + "/api/v1/context"), env)).json() as { dataset_label: string };
  assert.equal(context.dataset_label, "synthetic");
  const events = await (await worker.fetch(new Request(origin + "/api/v1/events"), env)).json() as { data: { title: string; claims: unknown[] }[] };
  assert.equal(events.data.length, 4);
  assert.ok(events.data.every(event => event.title.startsWith("SIMULASI FIKTIF") && event.claims.length === 0));
  const geometry = await (await worker.fetch(new Request(origin + "/api/v1/events.geojson"), env)).json() as { features: unknown[] };
  assert.deepEqual(geometry.features, []);
});

test("preview route rejects arbitrary queries and mutation methods", async () => {
  assert.equal((await worker.fetch(new Request(origin + path + "?url=https://example.org"), env)).status, 400);
  assert.equal((await worker.fetch(new Request(origin + path, { method: "POST" }), env)).status, 405);
});

test("context preview is a separate exact-demo route with an unrequested default", async () => {
  const contextPath = "/api/v1/demo/context-sources";
  for (const blocked of [{}, { DATASET_MODE: "demo" }, { ...env, DATASET_MODE: "live" }]) {
    assert.equal((await worker.fetch(new Request(origin + contextPath), blocked)).status, 404);
  }
  const response = await worker.fetch(new Request(origin + contextPath), env);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const payload = await response.json() as {
    schema_version: string; mode: string; cached: boolean;
    sources: { id: string; status: string; data_mode: string; fetched_at: string | null; forecast?: unknown; records?: unknown[] }[];
  };
  assert.equal(payload.schema_version, "context-sources-v1");
  assert.equal(payload.mode, "source_context");
  assert.equal(payload.cached, false);
  assert.deepEqual(payload.sources.map(s => [s.id, s.status, s.data_mode, s.fetched_at]), [
    ["openmeteo", "not_requested", "none", null], ["usgs", "not_requested", "none", null],
  ]);
  assert.equal(payload.sources[0]?.forecast, null);
  assert.deepEqual(payload.sources[1]?.records, []);
  assert.equal((await worker.fetch(new Request(origin + contextPath + "?mode=other"), env)).status, 400);
  assert.equal((await worker.fetch(new Request(origin + contextPath, { method: "POST" }), env)).status, 405);
  const geo = await (await worker.fetch(new Request(origin + "/api/v1/events.geojson"), env)).json() as { features: unknown[] };
  assert.deepEqual(geo.features, []);
});
