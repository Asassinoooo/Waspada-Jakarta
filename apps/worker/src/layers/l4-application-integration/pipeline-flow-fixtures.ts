/**
 * FLOW-VIS-01 demo fixture for `#alur-agen` when the Worker runs in demo mode. Styled after
 * admin-fixtures.ts: counts are fixed and timestamps are offsets from the requested instant. Every
 * title is fictional and every response is labelled `dataset_mode: "demo"` by the handler.
 */
import type { PipelineFlowAggregates } from "../../../../db/src/pipeline-flow-store.js";
import type { PipelineFlowItemDto, PipelineFlowNodeId } from "../../contracts/pipeline-flow.js";
import {
  createPipelineRuntimeStatus,
  type PipelineRuntimeStatusProvider,
} from "../../runtime/pipeline-runtime-status.js";

const MINUTE = 60_000;

export function createDemoPipelineFlowAggregates(now: Date): PipelineFlowAggregates {
  return {
    dataset_kind: "synthetic",
    generated_at: now.toISOString(),
    sources: [
      { family: "petabencana", sources: 1, healthy: 1, unhealthy: 0, revisions_24h: 14, revisions_15m: 2, acquisition_waiting: 0, acquisition_running: 0, acquisition_failed_15m: 0, acquisition_failed_24h: 0 },
      { family: "bmkg", sources: 1, healthy: 1, unhealthy: 0, revisions_24h: 0, revisions_15m: 0, acquisition_waiting: 0, acquisition_running: 0, acquisition_failed_15m: 0, acquisition_failed_24h: 0 },
      { family: "rss", sources: 14, healthy: 13, unhealthy: 1, revisions_24h: 61, revisions_15m: 4, acquisition_waiting: 0, acquisition_running: 0, acquisition_failed_15m: 0, acquisition_failed_24h: 0 },
    ],
    revisions: {
      by_status_24h: { unreviewed: 9, eligible: 58, quarantined: 2, superseded: 4, retracted: 0 },
      revisions_15m: 6,
      active_chunks: 212,
    },
    triage: {
      dispositions_24h: { ingest: 52, drop: 19, uncertain: 3 },
      model_status_24h: { ok: 74, rate_limited: 4, provider_error: 0, invalid_model_output: 0, not_cleared: 0 },
      decisions_15m: 5,
      failures_15m: 0,
      rate_limited_15m: 4,
      skipped_stage_a_24h: 40,
      skipped_stage_a_15m: 3,
    },
    ai_jobs: {
      pending: 3,
      leased: 1,
      retry: 2,
      needs_review: 0,
      completed_24h: 33,
      terminal_24h: 1,
      completed_15m: 2,
      terminal_15m: 0,
      checkpointed_open: 1,
      checkpointed_15m: 1,
    },
    embeddings: {
      available_24h: 31,
      failed_24h: 0,
      invalidated_24h: 0,
      available_15m: 2,
      failed_15m: 0,
    },
    correlation: {
      by_decision_24h: { same_incident: 18, new_incident: 12, unresolved: 3 },
      decisions_15m: 2,
      incidents_open: 9,
    },
    proposals: {
      proposed_24h: 15,
      proposed_15m: 1,
      pending: 5,
      pending_discrepancy: 2,
    },
    publication: {
      decisions_24h: { publish_agent: 9, publish_moderator: 1, reject_moderator: 2 },
      decisions_15m: 1,
      moderator_decisions_15m: 0,
      expired_24h: 2,
      events_published: 11,
      versions_24h: 10,
      versions_15m: 1,
      versions_agent_24h: 9,
      versions_moderator_24h: 1,
    },
  };
}

/** Runtime fixture with a fixed event history that ends at `now`. */
export function createDemoPipelineRuntime(now: Date): PipelineRuntimeStatusProvider {
  let clock = now.getTime() - 40 * MINUTE;
  const status = createPipelineRuntimeStatus({
    now: () => clock,
    ninerouter: () => ({
      chat: { rpm: 10, tokensAvailable: 6, cooldownRemainingMs: 42_000, inFlight: 0, queued: 2 },
      embed: { rpm: 30, tokensAvailable: 21, cooldownRemainingMs: 0, inFlight: 1, queued: 0 },
      callCounts: { chat: 318, embed: 1204 },
    }),
  });
  status.recordCycleStart({ newItemsCap: 5, feedsTotal: 14 });
  status.recordSourceCycle("rss", { ingest: 2, held: 1, duplicate: 3, deferred: 1, errors: 0 });
  status.recordDedupeHits({ title: 2, cycle: 1, ref: "rev-demo-dedupe-01" });
  status.recordCycleEnd({ newItemsUsed: 4, feedsFailed: 1, errors: 0 });
  clock = now.getTime() - 6 * MINUTE;
  status.recordCycleStart({ newItemsCap: 5, feedsTotal: 14 });
  status.recordSourceCycle("petabencana", { ingest: 2, held: 0, duplicate: 0, deferred: 0, errors: 0 });
  status.recordSourceCycle("rss", { ingest: 3, held: 0, duplicate: 2, deferred: 0, errors: 1 });
  status.recordDetFilter({ mode: "enforce", dropped: 3 });
  status.recordDedupeHits({ title: 1, cycle: 0, ref: "rev-demo-dedupe-02" });
  status.recordNineRouterCalls(6);
  status.recordCycleEnd({ newItemsUsed: 5, feedsFailed: 1, errors: 1 });
  clock = now.getTime() - 1 * MINUTE;
  status.recordCycleStart({ newItemsCap: 5, feedsTotal: 14 });
  status.recordSourceCycle("bmkg", { ingest: 0, held: 0, duplicate: 0, deferred: 0, errors: 0 });
  status.recordNineRouterCalls(4);
  clock = now.getTime();
  return status;
}

export function demoPipelineFlowSnapshotSource(now: Date): {
  readonly aggregates: PipelineFlowAggregates;
  readonly runtime: PipelineRuntimeStatusProvider;
} {
  return { aggregates: createDemoPipelineFlowAggregates(now), runtime: createDemoPipelineRuntime(now) };
}

const DEMO_PROPOSAL_TITLES = [
  "Contoh fiktif: genangan dekat Tebet",
  "Contoh fiktif: kemacetan Tol Dalam Kota",
  "Contoh fiktif: pemadaman listrik Cengkareng",
] as const;

/** Synthetic drill-down rows for the demo. Refs are fictional and no permitted text is included. */
export function demoPipelineFlowItems(input: { readonly nodeId: PipelineFlowNodeId; readonly limit: number; readonly now: Date }): readonly PipelineFlowItemDto[] {
  const count = Math.max(1, Math.min(20, input.limit));
  const at = (index: number) => new Date(input.now.getTime() - (index + 1) * 3 * MINUTE).toISOString();
  const rows: PipelineFlowItemDto[] = [];
  for (let index = 0; index < count; index++) {
    switch (input.nodeId) {
      case "src_rss":
      case "revisions":
        rows.push({ ref: `rev-demo-${String(index + 1).padStart(3, "0")}`, status: index % 5 === 0 ? "unreviewed" : "eligible", failure_code: null, title: null, at: at(index) });
        break;
      case "src_petabencana":
        rows.push({ ref: `rev-demo-pb-${String(index + 1).padStart(3, "0")}`, status: "eligible", failure_code: null, title: null, at: at(index) });
        break;
      case "src_bmkg":
        break;
      case "det_filter":
        rows.push({ ref: `hash${String(index + 1).padStart(8, "0")}`, status: "drop", failure_code: null, title: null, at: at(index) });
        break;
      case "triage":
        rows.push({ ref: `hash${String(index + 101).padStart(8, "0")}`, status: index % 4 === 3 ? "uncertain" : "ingest", failure_code: index % 4 === 3 ? null : "rate_limited", title: null, at: at(index) });
        break;
      case "ai_queue":
        rows.push({ ref: `job-demo-${String(index + 1).padStart(3, "0")}`, status: index < 2 ? "retry" : index === 2 ? "leased" : "completed", failure_code: index < 2 ? "rate_limited" : null, title: null, at: at(index) });
        break;
      case "interpret":
        rows.push({ ref: `job-demo-${String(index + 4).padStart(3, "0")}`, status: "leased", failure_code: null, title: null, at: at(index) });
        break;
      case "embed":
        rows.push({ ref: `emb-demo-${String(index + 1).padStart(3, "0")}`, status: "available", failure_code: null, title: null, at: at(index) });
        break;
      case "correlate":
        rows.push({ ref: `corr-demo-${String(index + 1).padStart(3, "0")}`, status: index % 3 === 0 ? "new_incident" : "same_incident", failure_code: null, title: null, at: at(index) });
        break;
      case "proposal":
        rows.push({ ref: `prop-demo-${String(index + 1).padStart(3, "0")}`, status: index % 2 === 0 ? "menunggu" : "diputuskan", failure_code: null, title: DEMO_PROPOSAL_TITLES[index % DEMO_PROPOSAL_TITLES.length]!, at: at(index) });
        break;
      case "gate":
        rows.push({ ref: `prop-demo-${String(index + 1).padStart(3, "0")}`, status: index % 4 === 0 ? "publish_moderator" : "publish_agent", failure_code: null, title: null, at: at(index) });
        break;
      case "review":
        rows.push({ ref: `prop-demo-${String(index + 20).padStart(3, "0")}`, status: index % 2 === 0 ? "diskrepansi" : "antrean_gerbang", failure_code: null, title: DEMO_PROPOSAL_TITLES[index % DEMO_PROPOSAL_TITLES.length]!, at: at(index) });
        break;
      case "published":
        rows.push({ ref: `evt-demo-${String(index + 1).padStart(3, "0")}`, status: "versi 1", failure_code: null, title: DEMO_PROPOSAL_TITLES[index % DEMO_PROPOSAL_TITLES.length]!, at: at(index) });
        break;
      default:
        break;
    }
  }
  return rows;
}
