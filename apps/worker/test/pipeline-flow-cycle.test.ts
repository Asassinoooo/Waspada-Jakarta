import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildPipelineFlowSnapshot,
  createPipelineFlowHandler,
} from "../src/layers/l4-application-integration/pipeline-flow-api.js";
import {
  createDemoPipelineFlowAggregates,
  demoPipelineFlowItems,
  demoPipelineFlowSnapshotSource,
} from "../src/layers/l4-application-integration/pipeline-flow-fixtures.js";
import { createPipelineRuntimeStatus } from "../src/runtime/pipeline-runtime-status.js";
import type { PipelineFlowAggregates, PipelineFlowCycleRunAggregate } from "../../db/src/pipeline-flow-store.js";

/**
 * HOSTED-30: the hosted Worker has no in-process runtime status, so the cycle comes from the latest recorded `--once` run
 * (waspada.pipeline_cycle_runs) and the source check times come from source_registry. Synthetic fixtures only.
 */

const NOW = new Date("2026-11-18T09:00:00.000Z");
const origin = "http://127.0.0.1:5173";

function zeroAggregates(): PipelineFlowAggregates {
  const base = createDemoPipelineFlowAggregates(NOW);
  return {
    ...base,
    sources: [],
    revisions: { by_status_24h: {}, revisions_15m: 0, active_chunks: 0 },
    triage: { dispositions_24h: {}, model_status_24h: {}, decisions_15m: 0, failures_15m: 0, rate_limited_15m: 0, skipped_stage_a_24h: 0, skipped_stage_a_15m: 0 },
    ai_jobs: { pending: 0, leased: 0, retry: 0, needs_review: 0, completed_24h: 0, terminal_24h: 0, completed_15m: 0, terminal_15m: 0, checkpointed_open: 0, checkpointed_15m: 0 },
    embeddings: { available_24h: 0, failed_24h: 0, invalidated_24h: 0, available_15m: 0, failed_15m: 0 },
    correlation: { by_decision_24h: {}, decisions_15m: 0, incidents_open: 0 },
    proposals: { proposed_24h: 0, proposed_15m: 0, pending: 0, pending_discrepancy: 0 },
    publication: {
      decisions_24h: {}, decisions_15m: 0, moderator_decisions_15m: 0, expired_24h: 0, events_published: 0,
      versions_24h: 0, versions_15m: 0, versions_agent_24h: 0, versions_moderator_24h: 0,
    },
  };
}

/** A run that finished ten minutes before NOW, with one failed source, the default for these tests. */
function recordedRun(overrides: Partial<PipelineFlowCycleRunAggregate> = {}): PipelineFlowCycleRunAggregate {
  return {
    run_id: "once-latest",
    started_at: "2026-11-18T08:46:00.000Z",
    finished_at: "2026-11-18T08:50:00.000Z",
    elapsed_ms: 240_000,
    feeds_ok: 14,
    feeds_failed: 1,
    feeds_not_fetched: 1,
    items_new: 9,
    ai_completed: 7,
    ai_not_completed: 2,
    published: 3,
    held: 1,
    exit_code: 0,
    poll_errors: 0,
    new_items_cap: 40,
    new_items_used: 12,
    runs_recorded: 5,
    ...overrides,
  };
}

function nodeOf(snapshot: ReturnType<typeof buildPipelineFlowSnapshot>, id: string) {
  const node = snapshot.nodes.find((candidate) => candidate.id === id);
  assert.ok(node, `node ${id} is present`);
  return node;
}

function liveSnapshot(aggregates: PipelineFlowAggregates) {
  return buildPipelineFlowSnapshot({ generatedAt: NOW.toISOString(), datasetMode: "live", aggregates, runtime: null });
}

describe("HOSTED-30 pipeline flow: the recorded hosted cycle", () => {
  it("fills runtime.cycle from the latest recorded run and leaves ninerouter null, because the database holds no provider counters", () => {
    const snapshot = liveSnapshot({ ...zeroAggregates(), cycle_run: recordedRun() });
    assert.notEqual(snapshot.runtime, null, "the cycle is known, so the runtime block is present");
    assert.equal(snapshot.runtime?.ninerouter, null);
    assert.equal(snapshot.runtime?.generated_at, NOW.toISOString());
    assert.deepEqual(snapshot.runtime?.cycle, {
      running: false,
      sequence: 5,
      started_at: "2026-11-18T08:46:00.000Z",
      finished_at: "2026-11-18T08:50:00.000Z",
      duration_ms: 240_000,
      new_items_cap: 40,
      new_items_used: 12,
      feeds_total: 16,
      feeds_failed: 1,
      error_count: 1,
    });
    assert.equal(nodeOf(snapshot, "ninerouter").health, "unavailable", "the rate gate is not in the database");
  });

  it("shows the run's counts on the cycle node and marks it failing when a source failed", () => {
    const failing = nodeOf(liveSnapshot({ ...zeroAggregates(), cycle_run: recordedRun() }), "cycle");
    assert.equal(failing.health, "failing");
    assert.equal(failing.counts.feeds_ok, 14);
    assert.equal(failing.counts.items_new, 9);
    assert.equal(failing.counts.ai_completed, 7);
    assert.equal(failing.counts.ai_not_completed, 2);
    assert.equal(failing.counts.published, 3);
    assert.equal(failing.counts.held, 1);
    assert.equal(failing.counts.feeds_failed, 1);
    assert.equal(failing.counts.error_count, 1);
    assert.equal(failing.counts.duration_ms, 240_000);
    assert.equal(failing.counts.running, 0);
  });

  it("a clean run inside 15 minutes is active, and the same run older than 15 minutes is idle", () => {
    const clean = { ...recordedRun({ feeds_failed: 0, feeds_not_fetched: 0 }) };
    const recent = nodeOf(liveSnapshot({ ...zeroAggregates(), cycle_run: clean }), "cycle");
    assert.equal(recent.health, "active");
    assert.equal(recent.throughput_15m, 1);

    const older = recordedRun({ feeds_failed: 0, feeds_not_fetched: 0, started_at: "2026-11-18T06:46:00.000Z", finished_at: "2026-11-18T06:50:00.000Z" });
    const stale = nodeOf(liveSnapshot({ ...zeroAggregates(), cycle_run: older }), "cycle");
    assert.equal(stale.health, "idle", "an old run is not activity, and it is not a failure either");
    assert.equal(stale.throughput_15m, 0);
  });

  it("counts a poll that threw, and a run that exited non-zero, as errors even when every source succeeded", () => {
    const pollThrew = nodeOf(liveSnapshot({ ...zeroAggregates(), cycle_run: recordedRun({ feeds_failed: 0, poll_errors: 1 }) }), "cycle");
    assert.equal(pollThrew.health, "failing");
    assert.equal(pollThrew.counts.error_count, 1);

    const hardError = nodeOf(liveSnapshot({ ...zeroAggregates(), cycle_run: recordedRun({ feeds_failed: 0, exit_code: 1 }) }), "cycle");
    assert.equal(hardError.health, "failing");
    assert.equal(hardError.counts.error_count, 1);

    const clean = nodeOf(liveSnapshot({ ...zeroAggregates(), cycle_run: recordedRun({ feeds_failed: 0 }) }), "cycle");
    assert.equal(clean.counts.error_count, 0);
  });

  it("leaves the cycle unavailable and the runtime null when no run is recorded", () => {
    const snapshot = liveSnapshot({ ...zeroAggregates(), cycle_run: null });
    assert.equal(snapshot.runtime, null);
    assert.equal(nodeOf(snapshot, "cycle").health, "unavailable");
    assert.deepEqual(nodeOf(snapshot, "cycle").counts, {});
  });

  it("an attached runtime status wins over the recorded run, and the recorded run adds nothing to it", () => {
    const { aggregates, runtime } = demoPipelineFlowSnapshotSource(NOW);
    const snapshot = buildPipelineFlowSnapshot({
      generatedAt: NOW.toISOString(),
      datasetMode: "live",
      aggregates: { ...aggregates, cycle_run: recordedRun() },
      runtime,
    });
    assert.equal(snapshot.runtime?.cycle.sequence, 3, "the in-process sequence is shown, not the recorded run count");
    assert.notEqual(snapshot.runtime?.ninerouter, null, "the attached status carries the rate gate");
    assert.equal(nodeOf(snapshot, "cycle").counts.items_new, undefined, "the recorded counts are not mixed into the runtime cycle");
  });

  it("carries the source check counts onto the source nodes, and a family with no sources reads zero", () => {
    const base = zeroAggregates();
    const snapshot = liveSnapshot({
      ...base,
      sources: [{
        family: "rss", sources: 3, healthy: 2, unhealthy: 1, revisions_24h: 0, revisions_15m: 0,
        acquisition_waiting: 0, acquisition_running: 0, acquisition_failed_15m: 0, acquisition_failed_24h: 0,
        checked_24h: 2, succeeded_24h: 1, never_checked: 1,
      }],
    });
    const rss = nodeOf(snapshot, "src_rss");
    assert.equal(rss.counts.checked_24h, 2);
    assert.equal(rss.counts.succeeded_24h, 1);
    assert.equal(rss.counts.never_checked, 1);
    assert.equal(nodeOf(snapshot, "src_bmkg").counts.checked_24h, 0);
  });
});

describe("HOSTED-30 pipeline flow handler on the live path", () => {
  const runRow = {
    run_id: "once-latest",
    started_at: new Date("2026-11-18T08:46:00.000Z"),
    finished_at: new Date("2026-11-18T08:50:00.000Z"),
    elapsed_ms: 240_000,
    feeds_ok: 16,
    feeds_failed: 0,
    items_new: 9,
    ai_completed: 7,
    ai_not_completed: 2,
    published: 3,
    held: 1,
    exit_code: 0,
    record_json: { new_items_cap: 40, new_items_used: 12, feeds_not_fetched: 0, poll_errors: 0 },
    runs_recorded: 5,
  };

  /** Answers by statement text: the cycle row, the source counts, and empty rows for every other read. */
  function routedExecutor(cycleRows: readonly unknown[]) {
    const executor = {
      query: async (statement: string) => {
        if (statement.includes("pipeline_cycle_runs pcr")) return { rows: cycleRows };
        if (statement.includes("sr.health_status = 'healthy'")) {
          return { rows: [{ family: "rss", sources: 2, healthy: 2, unhealthy: 0, checked_24h: 2, succeeded_24h: 2, never_checked: 0 }] };
        }
        return { rows: [] };
      },
      execute: async () => {},
      transaction: async (work: (tx: unknown) => Promise<unknown>) => work(executor),
    };
    return executor;
  }

  function handlerWith(executor: ReturnType<typeof routedExecutor>) {
    return createPipelineFlowHandler({
      withTransactionalSqlExecutor: async (_env, operation) => operation(executor as never),
      demo: { snapshot: (now) => demoPipelineFlowSnapshotSource(now), items: (input) => demoPipelineFlowItems(input) },
      now: () => NOW,
    });
  }

  it("answers the hosted snapshot from the database with no PIPELINE_STATUS: the recorded cycle and the source checks", async () => {
    const handler = handlerWith(routedExecutor([runRow]));
    const res = await handler(new Request(`${origin}/api/v1/pipeline/flow`), { DATASET_MODE: "live" }, "live");
    assert.equal(res.status, 200);
    const body = await res.json() as {
      dataset_mode: string;
      runtime: { ninerouter: unknown; cycle: { sequence: number; error_count: number; finished_at: string } } | null;
      nodes: Array<{ id: string; health: string; counts: Record<string, number> }>;
    };
    assert.equal(body.dataset_mode, "live");
    assert.notEqual(body.runtime, null, "the recorded cycle makes the runtime block present");
    assert.equal(body.runtime?.ninerouter, null);
    assert.equal(body.runtime?.cycle.sequence, 5);
    assert.equal(body.runtime?.cycle.error_count, 0);
    assert.equal(body.runtime?.cycle.finished_at, "2026-11-18T08:50:00.000Z");
    const cycle = body.nodes.find((node) => node.id === "cycle");
    assert.equal(cycle?.health, "active", "a clean run finished ten minutes ago");
    assert.equal(cycle?.counts.items_new, 9);
    const rss = body.nodes.find((node) => node.id === "src_rss");
    assert.equal(rss?.counts.checked_24h, 2);
    assert.equal(rss?.counts.never_checked, 0);
  });

  it("with no recorded run and no status the hosted snapshot keeps runtime null, as before", async () => {
    const handler = handlerWith(routedExecutor([]));
    const res = await handler(new Request(`${origin}/api/v1/pipeline/flow`), { DATASET_MODE: "live" }, "live");
    const body = await res.json() as { runtime: unknown; nodes: Array<{ id: string; health: string }> };
    assert.equal(body.runtime, null);
    assert.equal(body.nodes.find((node) => node.id === "cycle")?.health, "unavailable");
  });

  it("with a runtime status attached, the in-process cycle is shown and the database run is not", async () => {
    const status = createPipelineRuntimeStatus({ now: () => NOW.getTime() });
    status.recordCycleStart({ newItemsCap: 40, feedsTotal: 14 });
    status.recordCycleEnd({ newItemsUsed: 3, feedsFailed: 0 });
    const handler = handlerWith(routedExecutor([runRow]));
    const res = await handler(new Request(`${origin}/api/v1/pipeline/flow`), { DATASET_MODE: "live", PIPELINE_STATUS: status }, "live");
    const body = await res.json() as { runtime: { cycle: { sequence: number; new_items_used: number } } | null };
    assert.equal(body.runtime?.cycle.sequence, 1, "the attached status counts its own cycle");
    assert.equal(body.runtime?.cycle.new_items_used, 3);
  });
});
