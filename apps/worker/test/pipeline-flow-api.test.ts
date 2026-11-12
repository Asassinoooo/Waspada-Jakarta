import assert from "node:assert/strict";
import { describe, it } from "node:test";
import worker from "../src/index.js";
import {
  buildPipelineFlowSnapshot,
  createPipelineFlowHandler,
  PIPELINE_FLOW_EDGES,
  PIPELINE_FLOW_NODE_LANES,
} from "../src/layers/l4-application-integration/pipeline-flow-api.js";
import {
  createDemoPipelineFlowAggregates,
  demoPipelineFlowItems,
  demoPipelineFlowSnapshotSource,
} from "../src/layers/l4-application-integration/pipeline-flow-fixtures.js";
import { PIPELINE_FLOW_NODE_IDS } from "../src/contracts/pipeline-flow.js";
import { createPipelineRuntimeStatus } from "../src/runtime/pipeline-runtime-status.js";
import type { PipelineFlowAggregates } from "../../db/src/pipeline-flow-store.js";
import type { WorkerEnvironment } from "../src/layers/l4-application-integration/api.js";

const NOW = new Date("2026-11-11T09:00:00.000Z");
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

function nodeOf(snapshot: ReturnType<typeof buildPipelineFlowSnapshot>, id: string) {
  const node = snapshot.nodes.find((candidate) => candidate.id === id);
  assert.ok(node, `node ${id} is present`);
  return node;
}

describe("FLOW-VIS-01 pipeline flow snapshot", () => {
  it("the review node carries expired_24h, and an aggregate without the count still builds with zero", () => {
    const base = zeroAggregates();
    const withExpired = buildPipelineFlowSnapshot({
      generatedAt: NOW.toISOString(),
      datasetMode: "live",
      aggregates: { ...base, publication: { ...base.publication, expired_24h: 3 } },
      runtime: null,
    });
    assert.equal(nodeOf(withExpired, "review").counts.expired_24h, 3);
    assert.equal(nodeOf(withExpired, "gate").counts.reject_24h, 0, "an expiry is not a gate rejection");

    const legacy = buildPipelineFlowSnapshot({
      generatedAt: NOW.toISOString(),
      datasetMode: "live",
      aggregates: { ...base, publication: { ...base.publication, expired_24h: undefined as unknown as number } },
      runtime: null,
    });
    assert.equal(nodeOf(legacy, "review").counts.expired_24h, 0);
  });

  it("places every stage in its layer and keeps the edges in pipeline order", () => {
    const snapshot = buildPipelineFlowSnapshot({ generatedAt: NOW.toISOString(), datasetMode: "demo", aggregates: zeroAggregates(), runtime: null });
    assert.deepEqual(snapshot.nodes.map((node) => node.id), [...PIPELINE_FLOW_NODE_IDS]);
    assert.equal(nodeOf(snapshot, "gate").lane, "L4");
    assert.equal(nodeOf(snapshot, "ninerouter").lane, "L5");
    assert.equal(PIPELINE_FLOW_NODE_LANES.cycle, "L5");
    assert.ok(snapshot.edges.some((edge) => edge.from === "gate" && edge.to === "published"), "auto publication edge");
    assert.ok(snapshot.edges.some((edge) => edge.from === "gate" && edge.to === "review"), "discrepancy edge");
    assert.equal(snapshot.edges.length, PIPELINE_FLOW_EDGES.length);
    assert.equal(snapshot.window_hours, 24);
    assert.equal(snapshot.schema_version, "pipeline-flow-v1");
  });

  it("reports an empty database as idle with zero counts, never as safe or healthy", () => {
    const snapshot = buildPipelineFlowSnapshot({ generatedAt: NOW.toISOString(), datasetMode: "live", aggregates: zeroAggregates(), runtime: null });
    for (const node of snapshot.nodes) {
      if (node.id === "ninerouter" || node.id === "cycle" || node.id === "dedupe") {
        assert.equal(node.health, "unavailable", `${node.id} needs the runtime`);
      } else {
        assert.equal(node.health, "idle", `${node.id} has no data`);
      }
      assert.equal(node.throughput_15m, 0);
    }
    assert.equal(snapshot.runtime, null);
  });

  it("gives failure precedence over waiting and waiting over activity", () => {
    const base = zeroAggregates();
    const snapshot = buildPipelineFlowSnapshot({
      generatedAt: NOW.toISOString(),
      datasetMode: "live",
      aggregates: {
        ...base,
        ai_jobs: { ...base.ai_jobs, leased: 2, retry: 3, needs_review: 1, completed_15m: 4 },
        triage: { ...base.triage, rate_limited_15m: 2, decisions_15m: 5 },
        proposals: { ...base.proposals, pending: 4, pending_discrepancy: 1 },
      },
      runtime: null,
    });
    assert.equal(nodeOf(snapshot, "ai_queue").health, "failing", "needs_review outranks leased and retry");
    assert.equal(nodeOf(snapshot, "triage").health, "waiting", "rate limits are amber");
    assert.equal(nodeOf(snapshot, "review").health, "waiting", "a moderator queue waits for people");
    assert.equal(nodeOf(snapshot, "ai_queue").throughput_15m, 4);
  });

  it("animates an edge only when its downstream node moved items in the last 15 minutes", () => {
    const snapshot = buildPipelineFlowSnapshot({
      generatedAt: NOW.toISOString(),
      datasetMode: "demo",
      aggregates: createDemoPipelineFlowAggregates(NOW),
      runtime: demoPipelineFlowSnapshotSource(NOW).runtime,
    });
    const edge = (from: string, to: string) => snapshot.edges.find((candidate) => candidate.from === from && candidate.to === to);
    assert.ok((edge("ai_queue", "interpret")?.throughput_15m ?? 0) > 0, "interpret is active");
    assert.equal(edge("ai_queue", "interpret")?.throughput_15m, nodeOf(snapshot, "interpret").throughput_15m);
    const quiet = buildPipelineFlowSnapshot({ generatedAt: NOW.toISOString(), datasetMode: "live", aggregates: zeroAggregates(), runtime: null });
    assert.ok(quiet.edges.every((candidate) => candidate.throughput_15m === 0));
  });

  it("attaches runtime detail and marks runtime-only nodes from the runtime status", () => {
    const { aggregates, runtime } = demoPipelineFlowSnapshotSource(NOW);
    const snapshot = buildPipelineFlowSnapshot({ generatedAt: NOW.toISOString(), datasetMode: "demo", aggregates, runtime });
    assert.equal(snapshot.dataset_mode, "demo", "the demo snapshot is labelled");
    assert.equal(snapshot.runtime?.ninerouter.chat.cooldown_remaining_ms, 42_000);
    assert.equal(nodeOf(snapshot, "ninerouter").health, "waiting", "a chat cooldown is amber");
    assert.notEqual(nodeOf(snapshot, "cycle").health, "unavailable");
    assert.equal(snapshot.runtime?.cycle.sequence, 3);
  });
});

describe("FLOW-VIS-01 pipeline flow handler", () => {
  const handler = createPipelineFlowHandler({
    withTransactionalSqlExecutor: async (_env, operation) => {
      void operation;
      throw new Error("no database in this test");
    },
    demo: {
      snapshot: (now) => demoPipelineFlowSnapshotSource(now),
      items: (input) => demoPipelineFlowItems(input),
    },
    now: () => NOW,
  });

  it("answers the demo snapshot and items without a database and labels them demo", async () => {
    const res = await handler(new Request(`${origin}/api/v1/pipeline/flow`), { DATASET_MODE: "demo" }, "synthetic");
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "no-store");
    const body = await res.json() as { dataset_mode: string; nodes: unknown[]; runtime: unknown };
    assert.equal(body.dataset_mode, "demo");
    assert.equal(body.nodes.length, PIPELINE_FLOW_NODE_IDS.length);
    assert.notEqual(body.runtime, null);

    const items = await handler(new Request(`${origin}/api/v1/pipeline/flow/nodes/proposal/items?limit=3`), { DATASET_MODE: "demo" }, "synthetic");
    const itemBody = await items.json() as { dataset_mode: string; items: Array<{ title: string | null }>; limit: number };
    assert.equal(itemBody.dataset_mode, "demo");
    assert.equal(itemBody.limit, 3);
    assert.equal(itemBody.items.length, 3);
    assert.ok(itemBody.items.every((item) => item.title === null || item.title.startsWith("Contoh fiktif")), "demo titles are fictional");
  });

  it("validates the node id and the limit before reading anything", async () => {
    const unknown = await handler(new Request(`${origin}/api/v1/pipeline/flow/nodes/nope/items`), { DATASET_MODE: "demo" }, "live");
    assert.equal(unknown.status, 404);
    for (const limit of ["0", "21", "abc", "5.5"]) {
      const res = await handler(new Request(`${origin}/api/v1/pipeline/flow/nodes/triage/items?limit=${limit}`), { DATASET_MODE: "demo" }, "live");
      assert.equal(res.status, 400, `limit ${limit} is refused`);
    }
    const post = await handler(new Request(`${origin}/api/v1/pipeline/flow`, { method: "POST" }), { DATASET_MODE: "demo" }, "live");
    assert.equal(post.status, 405);
  });

  it("answers 503 in live mode when the database cannot be read, without echoing the error", async () => {
    const res = await handler(new Request(`${origin}/api/v1/pipeline/flow`), { DATASET_MODE: "live" }, "live");
    assert.equal(res.status, 503);
    const text = await res.text();
    assert.equal(text.includes("no database"), false);
  });

  it("uses runtime-only drill-downs from the attached status and says so when it is absent", async () => {
    const status = createPipelineRuntimeStatus({ now: () => NOW.getTime() });
    status.recordDedupeHits({ title: 1, cycle: 0, ref: "feed-source-antara-metro" });
    const withRuntime = await handler(new Request(`${origin}/api/v1/pipeline/flow/nodes/dedupe/items`), { DATASET_MODE: "live", PIPELINE_STATUS: status }, "live");
    const body = await withRuntime.json() as { items: Array<{ ref: string }>; unavailable_reason: string | null };
    assert.deepEqual(body.items.map((item) => item.ref), ["feed-source-antara-metro"]);
    assert.equal(body.unavailable_reason, null);

    const without = await handler(new Request(`${origin}/api/v1/pipeline/flow/nodes/cycle/items`), { DATASET_MODE: "live" }, "live");
    const withoutBody = await without.json() as { items: unknown[]; unavailable_reason: string | null };
    assert.deepEqual(withoutBody.items, []);
    assert.notEqual(withoutBody.unavailable_reason, null);
  });

  it("reads live aggregates through the injected read-only runner and labels them live", async () => {
    const seen: string[] = [];
    const live = createPipelineFlowHandler({
      withTransactionalSqlExecutor: async (_env, operation) => {
        seen.push("transaction");
        return operation({ query: async () => ({ rows: [] }), execute: async () => {}, transaction: async (work: (tx: unknown) => Promise<unknown>) => work({ query: async () => ({ rows: [] }), execute: async () => {} }) } as never);
      },
      demo: { snapshot: (now) => demoPipelineFlowSnapshotSource(now), items: () => [] },
      now: () => NOW,
    });
    const res = await live(new Request(`${origin}/api/v1/pipeline/flow`), { DATASET_MODE: "live" }, "live");
    assert.equal(res.status, 200);
    const body = await res.json() as { dataset_mode: string; nodes: Array<{ health: string }> };
    assert.equal(body.dataset_mode, "live", "live aggregates are labelled live, not demo");
    assert.ok(body.nodes.every((node) => node.health === "idle" || node.health === "unavailable"), "an empty read shows no activity");
    assert.deepEqual(seen, ["transaction"], "one read-only transaction was opened");
  });
});

describe("FLOW-VIS-01 route guard", () => {
  const env = (overrides: Partial<WorkerEnvironment> = {}): WorkerEnvironment => ({
    DATASET_MODE: "live",
    AUTH_ENABLED: "true",
    AUTH_APP_ORIGIN: origin,
    ...overrides,
  });

  it("refuses anonymous callers and deployments without accounts before touching a database", async () => {
    const unconfigured = await worker.fetch(new Request(`${origin}/api/v1/pipeline/flow`), { DATASET_MODE: "demo" });
    assert.equal(unconfigured.status, 503);

    const anonymous = await worker.fetch(new Request(`${origin}/api/v1/pipeline/flow`), env({
      SQL_EXECUTOR: {
        query: async () => { throw new Error("must not be reached without a cookie"); },
        execute: async () => {},
        transaction: async () => { throw new Error("must not be reached without a cookie"); },
      } as never,
    }));
    assert.equal(anonymous.status, 401);

    const drillDown = await worker.fetch(new Request(`${origin}/api/v1/pipeline/flow/nodes/gate/items`), env({
      SQL_EXECUTOR: {
        query: async () => { throw new Error("must not be reached without a cookie"); },
        execute: async () => {},
        transaction: async () => { throw new Error("must not be reached without a cookie"); },
      } as never,
    }));
    assert.equal(drillDown.status, 401);
  });
});
