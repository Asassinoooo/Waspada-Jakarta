import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createPipelineRuntimeStatus,
  PIPELINE_RUNTIME_RING_SIZE,
  PIPELINE_RUNTIME_THROUGHPUT_WINDOW_MS,
} from "../src/runtime/pipeline-runtime-status.js";

const BASE = Date.parse("2026-11-11T09:00:00.000Z");

function clock(start = BASE) {
  let t = start;
  return { now: () => t, set: (ms: number) => { t = ms; }, advance: (ms: number) => { t += ms; } };
}

describe("FLOW-VIS-01 pipeline runtime status", () => {
  it("records cycle timing, per-source counts and dedupe hits for the last completed cycle", () => {
    const c = clock();
    const status = createPipelineRuntimeStatus({ now: c.now });
    status.recordCycleStart({ newItemsCap: 5, feedsTotal: 14 });
    status.recordSourceCycle("rss", { ingest: 2, held: 1, duplicate: 3, deferred: 1, errors: 0 });
    status.recordSourceCycle("rss", { ingest: 1, held: 0, duplicate: 0, deferred: 0, errors: 1 });
    status.recordDedupeHits({ title: 3, cycle: 1, ref: "feed-a" });
    status.recordDetFilter({ mode: "enforce", dropped: 4 });
    c.advance(12_000);
    status.recordCycleEnd({ newItemsUsed: 3, feedsFailed: 1 });

    const snapshot = status.snapshot(c.now());
    assert.equal(snapshot.cycle.running, false);
    assert.equal(snapshot.cycle.duration_ms, 12_000);
    assert.equal(snapshot.cycle.new_items_cap, 5);
    assert.equal(snapshot.cycle.new_items_used, 3);
    assert.equal(snapshot.cycle.feeds_total, 14);
    assert.equal(snapshot.cycle.feeds_failed, 1);
    assert.equal(snapshot.cycle.error_count, 1);
    assert.deepEqual(snapshot.sources.rss, { ingest: 3, held: 1, duplicate: 3, deferred: 1, errors: 1 });
    assert.equal(snapshot.sources.bmkg, null, "a family that did not report is null, not zero");
    assert.deepEqual(snapshot.dedupe, { title_hits_last_cycle: 3, cycle_hits_last_cycle: 1, hits_total: 4 });
    assert.deepEqual(snapshot.det_filter, { mode: "enforce", dropped_last_cycle: 4 });
    assert.equal(snapshot.ninerouter, null, "no NineRouter provider attached");
  });

  it("keeps a bounded ring of item events with opaque refs and no text", () => {
    const c = clock();
    const status = createPipelineRuntimeStatus({ now: c.now });
    for (let index = 0; index < PIPELINE_RUNTIME_RING_SIZE + 10; index++) {
      c.advance(1_000);
      status.recordDedupeHits({ title: 1, cycle: 0, ref: `rev-${index}` });
    }
    const items = status.recentItems();
    assert.equal(items.length, PIPELINE_RUNTIME_RING_SIZE, "the ring keeps only the newest events");
    assert.equal(items[0]?.item_ref, `rev-${PIPELINE_RUNTIME_RING_SIZE + 9}`);
    assert.deepEqual(Object.keys(items[0]!).sort(), ["at", "item_ref", "stage", "status"]);
    assert.equal(status.recentItems({ stage: "cycle" }).length, 0);
    assert.equal(status.recentItems({ stage: "dedupe", limit: 3 }).length, 3);
  });

  it("counts throughput over a trailing window and ignores events outside it", () => {
    const c = clock();
    const status = createPipelineRuntimeStatus({ now: c.now });
    status.recordNineRouterCalls(4);
    c.advance(PIPELINE_RUNTIME_THROUGHPUT_WINDOW_MS + 1_000);
    status.recordNineRouterCalls(2);
    assert.equal(status.throughput("ninerouter", undefined, c.now()), 2, "the first delta is older than 15 minutes");
    assert.equal(status.throughput("ninerouter", 60 * 60_000, c.now()), 6);
    assert.equal(status.throughput("cycle", undefined, c.now()), 0);
  });

  it("reads the NineRouter snapshot through the provider at snapshot time", () => {
    const c = clock();
    let calls = 0;
    const status = createPipelineRuntimeStatus({
      now: c.now,
      ninerouter: () => {
        calls += 1;
        return {
          chat: { rpm: 10, tokensAvailable: 7, cooldownRemainingMs: 9_000, inFlight: 0, queued: 1 },
          embed: { rpm: 30, tokensAvailable: 30, cooldownRemainingMs: 0, inFlight: 0, queued: 0 },
          callCounts: { chat: 3, embed: 8 },
        };
      },
    });
    const snapshot = status.snapshot();
    assert.equal(calls, 1);
    assert.equal(snapshot.ninerouter?.chat.cooldownRemainingMs, 9_000);
    assert.deepEqual(snapshot.ninerouter?.callCounts, { chat: 3, embed: 8 });
  });
});
