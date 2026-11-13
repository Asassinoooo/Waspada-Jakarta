import assert from "node:assert/strict";
import test from "node:test";
import { fetchPipelineFlowItems, fetchPipelineFlowSnapshot } from "../src/pipeline-flow-client.js";
import { demoSnapshot } from "./pipeline-flow-fixtures.js";

/**
 * FLOW-RANGE-01: the client sends the selected window on every snapshot and drill-down request.
 * fetch is replaced for the duration of each test, so no request leaves the test process.
 */

async function recordRequests(work: () => Promise<unknown>): Promise<string[]> {
  const seen: string[] = [];
  const original = globalThis.fetch;
  const itemsBody = {
    schema_version: "pipeline-flow-v1",
    generated_at: "2026-11-11T09:00:00.000Z",
    dataset_mode: "demo",
    node_id: "proposal",
    limit: 5,
    window: { range: "1h", since: "2026-11-11T08:00:00.000Z" },
    items: [],
    unavailable_reason: null,
  };
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    seen.push(String(input));
    const body = String(input).includes("/items?") ? itemsBody : demoSnapshot();
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    await work();
  } finally {
    globalThis.fetch = original;
  }
  return seen;
}

test("FLOW-RANGE-01: the snapshot request carries the selected range and defaults to 24h", async () => {
  const [defaulted] = await recordRequests(() => fetchPipelineFlowSnapshot());
  assert.equal(defaulted, "/api/v1/pipeline/flow?range=24h");

  const [weekly] = await recordRequests(() => fetchPipelineFlowSnapshot("7d"));
  assert.equal(weekly, "/api/v1/pipeline/flow?range=7d");
});

test("FLOW-RANGE-01: the drill-down request carries the limit and the selected range", async () => {
  const [hourly] = await recordRequests(() => fetchPipelineFlowItems("proposal", 5, "1h"));
  assert.equal(hourly, "/api/v1/pipeline/flow/nodes/proposal/items?limit=5&range=1h");

  const [defaulted] = await recordRequests(() => fetchPipelineFlowItems("gate"));
  assert.equal(defaulted, "/api/v1/pipeline/flow/nodes/gate/items?limit=20&range=24h");
});
