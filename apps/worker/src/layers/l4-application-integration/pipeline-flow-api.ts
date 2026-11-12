/**
 * FLOW-VIS-01: moderator-only snapshot and drill-down for the live agent pipeline view.
 *
 * `buildPipelineFlowSnapshot` is pure. It turns database aggregates and the optional runtime
 * status into the `pipeline-flow-v1` nodes, health, 15-minute throughput and edges. Health is
 * never a safety claim: a zero count means "no data in the window".
 */
import type { TransactionalSqlExecutor } from "../../../../db/src/sql.js";
import type { DatasetKind } from "../../../../db/src/ports.js";
import {
  createPipelineFlowStore,
  PIPELINE_FLOW_DB_ITEM_NODES,
  type PipelineFlowAggregates,
  type PipelineFlowStoredItem,
} from "../../../../db/src/pipeline-flow-store.js";
import {
  PIPELINE_FLOW_ITEM_LIMIT_DEFAULT,
  PIPELINE_FLOW_ITEM_LIMIT_MAX,
  PIPELINE_FLOW_NODE_IDS,
  PIPELINE_FLOW_SCHEMA_VERSION,
  type PipelineFlowDatasetMode,
  type PipelineFlowEdgeDto,
  type PipelineFlowHealth,
  type PipelineFlowItemDto,
  type PipelineFlowItemsDto,
  type PipelineFlowLane,
  type PipelineFlowNodeDto,
  type PipelineFlowNodeId,
  type PipelineFlowRuntimeDto,
  type PipelineFlowSnapshotDto,
} from "../../contracts/pipeline-flow.js";
import type { PipelineRuntimeNineRouterBucket, PipelineRuntimeSnapshot, PipelineRuntimeStage, PipelineRuntimeStatusProvider } from "../../runtime/pipeline-runtime-status.js";
import type { WorkerEnvironment } from "./api.js";

export const PIPELINE_FLOW_ROUTE_PATH = "/api/v1/pipeline/flow";
export const PIPELINE_FLOW_ITEMS_PATTERN = /^\/api\/v1\/pipeline\/flow\/nodes\/([a-z_]+)\/items$/u;

export const PIPELINE_FLOW_NODE_LANES: Readonly<Record<PipelineFlowNodeId, PipelineFlowLane>> = {
  src_petabencana: "L1",
  src_bmkg: "L1",
  src_rss: "L1",
  dedupe: "L1",
  det_filter: "L1",
  triage: "L1",
  revisions: "L1",
  ai_queue: "L2",
  interpret: "L2",
  embed: "L2",
  retrieve: "L2",
  correlate: "L3",
  proposal: "L3",
  gate: "L4",
  review: "L4",
  published: "L4",
  ninerouter: "L5",
  cycle: "L5",
};

/** Pipeline order. An edge animates when its downstream node moved items in the last 15 minutes. */
export const PIPELINE_FLOW_EDGES: readonly (readonly [PipelineFlowNodeId, PipelineFlowNodeId])[] = [
  ["src_petabencana", "revisions"],
  ["src_bmkg", "revisions"],
  ["src_rss", "dedupe"],
  ["dedupe", "det_filter"],
  ["det_filter", "triage"],
  ["triage", "revisions"],
  ["revisions", "ai_queue"],
  ["ai_queue", "interpret"],
  ["interpret", "embed"],
  ["embed", "retrieve"],
  ["retrieve", "correlate"],
  ["correlate", "proposal"],
  ["proposal", "gate"],
  ["gate", "published"],
  ["gate", "review"],
  ["review", "published"],
];

export interface PipelineFlowBuildInput {
  readonly generatedAt: string;
  readonly datasetMode: PipelineFlowDatasetMode;
  readonly aggregates: PipelineFlowAggregates;
  /** Null when the runtime status is not attached. Runtime-only nodes then report `unavailable`. */
  readonly runtime: PipelineRuntimeStatusProvider | null;
}

type Counts = Record<string, number>;

interface NodeDraft {
  readonly counts: Counts;
  readonly throughput: number;
  readonly failing: boolean;
  readonly waiting: boolean;
  readonly active: boolean;
  readonly unavailable: boolean;
}

function healthOf(draft: NodeDraft): PipelineFlowHealth {
  if (draft.unavailable) return "unavailable";
  if (draft.failing) return "failing";
  if (draft.waiting) return "waiting";
  if (draft.active || draft.throughput > 0) return "active";
  return "idle";
}

function runtimeNineRouterCooldown(bucket: PipelineRuntimeNineRouterBucket | undefined): number {
  return bucket ? bucket.cooldownRemainingMs : 0;
}

export function buildPipelineFlowSnapshot(input: PipelineFlowBuildInput): PipelineFlowSnapshotDto {
  const { aggregates: a, runtime } = input;
  const runtimeSnapshot: PipelineRuntimeSnapshot | null = runtime ? runtime.snapshot(Date.parse(input.generatedAt)) : null;
  const throughputOfRuntime = (stage: PipelineRuntimeStage) => (runtime ? runtime.throughput(stage, undefined, Date.parse(input.generatedAt)) : 0);
  const nineRouter = runtimeSnapshot?.ninerouter ?? null;
  const cooldownMs = Math.max(runtimeNineRouterCooldown(nineRouter?.chat), runtimeNineRouterCooldown(nineRouter?.embed));
  const bySourceFamily = (family: "petabencana" | "bmkg" | "rss") => a.sources.find((row) => row.family === family);

  const drafts: Record<PipelineFlowNodeId, NodeDraft> = {} as Record<PipelineFlowNodeId, NodeDraft>;
  const sourceDraft = (family: "petabencana" | "bmkg" | "rss"): NodeDraft => {
    const row = bySourceFamily(family);
    const unhealthy = row?.unhealthy ?? 0;
    const failed15 = row?.acquisition_failed_15m ?? 0;
    const revisions15 = row?.revisions_15m ?? 0;
    return {
      counts: {
        sources: row?.sources ?? 0,
        healthy: row?.healthy ?? 0,
        unhealthy,
        revisions_24h: row?.revisions_24h ?? 0,
        acquisition_waiting: row?.acquisition_waiting ?? 0,
        acquisition_running: row?.acquisition_running ?? 0,
        acquisition_failed_24h: row?.acquisition_failed_24h ?? 0,
      },
      throughput: revisions15,
      failing: unhealthy > 0 || failed15 > 0,
      waiting: false,
      active: (row?.acquisition_running ?? 0) > 0,
      unavailable: false,
    };
  };

  drafts.src_petabencana = sourceDraft("petabencana");
  drafts.src_bmkg = sourceDraft("bmkg");
  drafts.src_rss = sourceDraft("rss");

  const dedupeCounts: Counts = runtimeSnapshot
    ? {
      title_last_cycle: runtimeSnapshot.dedupe.title_hits_last_cycle,
      cycle_last_cycle: runtimeSnapshot.dedupe.cycle_hits_last_cycle,
      hits_total: runtimeSnapshot.dedupe.hits_total,
    }
    : {};
  drafts.dedupe = {
    counts: dedupeCounts,
    throughput: throughputOfRuntime("dedupe"),
    failing: false,
    waiting: false,
    active: false,
    unavailable: runtimeSnapshot === null,
  };

  drafts.det_filter = {
    counts: {
      skipped_24h: a.triage.skipped_stage_a_24h,
      skipped_15m: a.triage.skipped_stage_a_15m,
      ...(runtimeSnapshot?.det_filter.dropped_last_cycle !== null && runtimeSnapshot?.det_filter.dropped_last_cycle !== undefined
        ? { dropped_last_cycle: runtimeSnapshot.det_filter.dropped_last_cycle }
        : {}),
    },
    throughput: a.triage.skipped_stage_a_15m,
    failing: false,
    waiting: false,
    active: false,
    unavailable: false,
  };

  drafts.triage = {
    counts: {
      ingest_24h: a.triage.dispositions_24h.ingest ?? 0,
      drop_24h: a.triage.dispositions_24h.drop ?? 0,
      uncertain_24h: a.triage.dispositions_24h.uncertain ?? 0,
      rate_limited_24h: a.triage.model_status_24h.rate_limited ?? 0,
      provider_error_24h: a.triage.model_status_24h.provider_error ?? 0,
      invalid_output_24h: a.triage.model_status_24h.invalid_model_output ?? 0,
    },
    throughput: a.triage.decisions_15m,
    failing: a.triage.failures_15m > 0,
    waiting: a.triage.rate_limited_15m > 0 || cooldownMs > 0,
    active: false,
    unavailable: false,
  };

  drafts.revisions = {
    counts: {
      unreviewed_24h: a.revisions.by_status_24h.unreviewed ?? 0,
      eligible_24h: a.revisions.by_status_24h.eligible ?? 0,
      quarantined_24h: a.revisions.by_status_24h.quarantined ?? 0,
      superseded_24h: a.revisions.by_status_24h.superseded ?? 0,
      retracted_24h: a.revisions.by_status_24h.retracted ?? 0,
      active_chunks: a.revisions.active_chunks,
    },
    throughput: a.revisions.revisions_15m,
    failing: false,
    waiting: false,
    active: false,
    unavailable: false,
  };

  drafts.ai_queue = {
    counts: {
      pending: a.ai_jobs.pending,
      leased: a.ai_jobs.leased,
      retry: a.ai_jobs.retry,
      needs_review: a.ai_jobs.needs_review,
      completed_24h: a.ai_jobs.completed_24h,
      terminal_24h: a.ai_jobs.terminal_24h,
    },
    throughput: a.ai_jobs.completed_15m + a.ai_jobs.terminal_15m,
    failing: a.ai_jobs.needs_review > 0 || a.ai_jobs.terminal_15m > 0,
    waiting: a.ai_jobs.retry > 0 || cooldownMs > 0,
    active: a.ai_jobs.leased > 0,
    unavailable: false,
  };

  drafts.interpret = {
    counts: { checkpointed_open: a.ai_jobs.checkpointed_open, leased: a.ai_jobs.leased },
    throughput: a.ai_jobs.checkpointed_15m,
    failing: false,
    waiting: false,
    active: a.ai_jobs.leased > 0,
    unavailable: false,
  };

  drafts.embed = {
    counts: {
      available_24h: a.embeddings.available_24h,
      failed_24h: a.embeddings.failed_24h,
      invalidated_24h: a.embeddings.invalidated_24h,
    },
    throughput: a.embeddings.available_15m + a.embeddings.failed_15m,
    failing: a.embeddings.failed_15m > 0,
    waiting: false,
    active: false,
    unavailable: false,
  };

  drafts.retrieve = {
    counts: { active_chunks: a.revisions.active_chunks, searchable_24h: a.embeddings.available_24h },
    throughput: a.embeddings.available_15m,
    failing: false,
    waiting: false,
    active: false,
    unavailable: false,
  };

  drafts.correlate = {
    counts: {
      same_incident_24h: a.correlation.by_decision_24h.same_incident ?? 0,
      new_incident_24h: a.correlation.by_decision_24h.new_incident ?? 0,
      unresolved_24h: a.correlation.by_decision_24h.unresolved ?? 0,
      incidents_open: a.correlation.incidents_open,
    },
    throughput: a.correlation.decisions_15m,
    failing: false,
    waiting: false,
    active: false,
    unavailable: false,
  };

  drafts.proposal = {
    counts: {
      proposed_24h: a.proposals.proposed_24h,
      pending: a.proposals.pending,
      pending_discrepancy: a.proposals.pending_discrepancy,
    },
    throughput: a.proposals.proposed_15m,
    failing: false,
    waiting: false,
    active: false,
    unavailable: false,
  };

  const decisions = a.publication.decisions_24h;
  drafts.gate = {
    counts: {
      auto_publish_24h: decisions.publish_agent ?? 0,
      moderator_publish_24h: decisions.publish_moderator ?? 0,
      reject_24h: (decisions.reject_moderator ?? 0) + (decisions.reject_agent ?? 0),
    },
    throughput: a.publication.decisions_15m,
    failing: false,
    waiting: false,
    active: false,
    unavailable: false,
  };

  drafts.review = {
    counts: {
      waiting_discrepancy: a.proposals.pending_discrepancy,
      waiting_gate: Math.max(0, a.proposals.pending - a.proposals.pending_discrepancy),
      moderator_decisions_15m: a.publication.moderator_decisions_15m,
      // REVIEW-EXPIRY-01 (ADR-062): undecided proposals past the review TTL, 24 h.
      expired_24h: a.publication.expired_24h ?? 0,
    },
    throughput: a.publication.moderator_decisions_15m,
    failing: false,
    waiting: a.proposals.pending > 0,
    active: false,
    unavailable: false,
  };

  drafts.published = {
    counts: {
      events_published: a.publication.events_published,
      versions_24h: a.publication.versions_24h,
      agent_versions_24h: a.publication.versions_agent_24h,
      moderator_versions_24h: a.publication.versions_moderator_24h,
    },
    throughput: a.publication.versions_15m,
    failing: false,
    waiting: false,
    active: false,
    unavailable: false,
  };

  const nr = nineRouter;
  drafts.ninerouter = {
    counts: nr
      ? {
        calls_total: nr.callCounts.chat + nr.callCounts.embed,
        chat_tokens_available: nr.chat.tokensAvailable,
        embed_tokens_available: nr.embed.tokensAvailable,
        in_flight: nr.chat.inFlight + nr.embed.inFlight,
        queued: nr.chat.queued + nr.embed.queued,
        cooldown_ms: cooldownMs,
      }
      : {},
    throughput: throughputOfRuntime("ninerouter"),
    failing: false,
    waiting: cooldownMs > 0,
    active: nr !== null && nr.chat.inFlight + nr.embed.inFlight > 0,
    unavailable: nr === null,
  };

  const cycle = runtimeSnapshot?.cycle ?? null;
  drafts.cycle = {
    counts: cycle
      ? {
        running: cycle.running ? 1 : 0,
        error_count: cycle.error_count,
        new_items_used: cycle.new_items_used ?? 0,
        new_items_cap: cycle.new_items_cap ?? 0,
        feeds_failed: cycle.feeds_failed ?? 0,
        duration_ms: cycle.duration_ms ?? 0,
      }
      : {},
    throughput: throughputOfRuntime("cycle"),
    failing: cycle !== null && cycle.error_count > 0,
    waiting: false,
    active: cycle !== null && cycle.running,
    unavailable: cycle === null,
  };

  const nodes: PipelineFlowNodeDto[] = PIPELINE_FLOW_NODE_IDS.map((id) => {
    const draft = drafts[id];
    return {
      id,
      lane: PIPELINE_FLOW_NODE_LANES[id],
      health: healthOf(draft),
      counts: draft.counts,
      throughput_15m: draft.throughput,
    };
  });
  const throughputById = new Map(nodes.map((node) => [node.id, node.throughput_15m] as const));
  const edges: PipelineFlowEdgeDto[] = PIPELINE_FLOW_EDGES.map(([from, to]) => ({
    from,
    to,
    throughput_15m: throughputById.get(to) ?? 0,
  }));

  const runtimeDto: PipelineFlowRuntimeDto | null = runtimeSnapshot && nr && cycle
    ? {
      generated_at: runtimeSnapshot.generated_at,
      ninerouter: {
        chat: {
          rpm: nr.chat.rpm,
          tokens_available: nr.chat.tokensAvailable,
          cooldown_remaining_ms: nr.chat.cooldownRemainingMs,
          in_flight: nr.chat.inFlight,
          queued: nr.chat.queued,
        },
        embed: {
          rpm: nr.embed.rpm,
          tokens_available: nr.embed.tokensAvailable,
          cooldown_remaining_ms: nr.embed.cooldownRemainingMs,
          in_flight: nr.embed.inFlight,
          queued: nr.embed.queued,
        },
        call_counts: { chat: nr.callCounts.chat, embed: nr.callCounts.embed },
      },
      cycle: {
        running: cycle.running,
        sequence: cycle.sequence,
        started_at: cycle.started_at,
        finished_at: cycle.finished_at,
        duration_ms: cycle.duration_ms,
        new_items_cap: cycle.new_items_cap,
        new_items_used: cycle.new_items_used,
        feeds_total: cycle.feeds_total,
        feeds_failed: cycle.feeds_failed,
        error_count: cycle.error_count,
      },
    }
    : null;

  return {
    schema_version: PIPELINE_FLOW_SCHEMA_VERSION,
    generated_at: input.generatedAt,
    dataset_mode: input.datasetMode,
    window_hours: 24,
    nodes,
    edges,
    runtime: runtimeDto,
  };
}

export function isPipelineFlowNodeId(value: string): value is PipelineFlowNodeId {
  return (PIPELINE_FLOW_NODE_IDS as readonly string[]).includes(value);
}

const RUNTIME_ONLY_STAGE: Partial<Record<PipelineFlowNodeId, PipelineRuntimeStage>> = {
  dedupe: "dedupe",
  ninerouter: "ninerouter",
  cycle: "cycle",
};

function toItem(row: PipelineFlowStoredItem): PipelineFlowItemDto {
  return { ref: row.ref, status: row.status, failure_code: row.failure_code, title: row.title, at: row.at };
}

/** Runtime-only drill-down. Refs are opaque; the runtime never stores text. */
export function runtimeItemsForNode(
  runtime: PipelineRuntimeStatusProvider | null,
  nodeId: PipelineFlowNodeId,
  limit: number,
): { readonly items: readonly PipelineFlowItemDto[]; readonly unavailable_reason: string | null } {
  if (runtime === null) {
    return { items: [], unavailable_reason: "Status runtime tidak terpasang pada layanan ini." };
  }
  const stage = RUNTIME_ONLY_STAGE[nodeId];
  if (!stage) return { items: [], unavailable_reason: null };
  return {
    items: runtime.recentItems({ stage, limit }).map((item) => ({
      ref: item.item_ref,
      status: item.status,
      failure_code: item.status === "error" ? "cycle_error" : null,
      title: null,
      at: item.at,
    })),
    unavailable_reason: null,
  };
}

export interface PipelineFlowHandlerOptions {
  /** Runs one read-only transaction against the account database. Throws when no database is configured. */
  readonly withTransactionalSqlExecutor: <Result>(
    env: WorkerEnvironment,
    operation: (executor: TransactionalSqlExecutor) => Promise<Result>,
  ) => Promise<Result>;
  /** Demo snapshot and items. Injected so the Worker composition owns the fixture module. */
  readonly demo: {
    readonly snapshot: (now: Date) => { readonly aggregates: PipelineFlowAggregates; readonly runtime: PipelineRuntimeStatusProvider };
    readonly items: (input: { readonly nodeId: PipelineFlowNodeId; readonly limit: number; readonly now: Date }) => readonly PipelineFlowItemDto[];
  };
  readonly now?: () => Date;
}

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
} as const;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

function errorResponse(status: number, code: string, message: string): Response {
  return jsonResponse({ code, message, request_id: crypto.randomUUID() }, status);
}

function parseLimit(raw: string | null): number | null {
  if (raw === null) return PIPELINE_FLOW_ITEM_LIMIT_DEFAULT;
  if (!/^\d{1,3}$/u.test(raw)) return null;
  const value = Number(raw);
  if (value < 1 || value > PIPELINE_FLOW_ITEM_LIMIT_MAX) return null;
  return value;
}

/**
 * Serves `/api/v1/pipeline/flow` and `/api/v1/pipeline/flow/nodes/:id/items`. The caller must already
 * have run the moderator guard. The dataset is chosen by server configuration, never by the query.
 */
export function createPipelineFlowHandler(options: PipelineFlowHandlerOptions) {
  return async (request: Request, env: WorkerEnvironment, datasetKind: DatasetKind): Promise<Response> => {
    if (request.method !== "GET") {
      return new Response(JSON.stringify({ code: "METHOD_NOT_ALLOWED", message: "Only GET is supported" }), {
        status: 405,
        headers: { ...JSON_HEADERS, allow: "GET" },
      });
    }
    const url = new URL(request.url);
    const now = options.now ? options.now() : new Date();
    const datasetMode: PipelineFlowDatasetMode = env.DATASET_MODE === "live" ? "live" : "demo";
    const runtime: PipelineRuntimeStatusProvider | null = env.PIPELINE_STATUS ?? null;

    if (url.pathname === PIPELINE_FLOW_ROUTE_PATH) {
      if (datasetMode === "demo") {
        const demo = options.demo.snapshot(now);
        return jsonResponse(buildPipelineFlowSnapshot({
          generatedAt: now.toISOString(),
          datasetMode,
          aggregates: demo.aggregates,
          runtime: demo.runtime,
        }));
      }
      try {
        const aggregates = await options.withTransactionalSqlExecutor(env, (executor) =>
          createPipelineFlowStore(executor).readAggregates({ datasetKind, now }));
        return jsonResponse(buildPipelineFlowSnapshot({
          generatedAt: now.toISOString(),
          datasetMode,
          aggregates,
          runtime,
        }));
      } catch {
        return errorResponse(503, "TEMPORARILY_UNAVAILABLE", "Status pipeline tidak tersedia saat ini.");
      }
    }

    const match = PIPELINE_FLOW_ITEMS_PATTERN.exec(url.pathname);
    if (!match) return errorResponse(404, "NOT_FOUND", "Route not found");
    const nodeId = match[1]!;
    if (!isPipelineFlowNodeId(nodeId)) return errorResponse(404, "NOT_FOUND", "Unknown pipeline node");
    const limit = parseLimit(url.searchParams.get("limit"));
    if (limit === null) return errorResponse(400, "INVALID_REQUEST", "limit must be an integer from 1 to 20");

    const generatedAt = now.toISOString();
    const isDbNode = (PIPELINE_FLOW_DB_ITEM_NODES as readonly string[]).includes(nodeId);
    if (datasetMode === "demo") {
      if (!isDbNode) {
        const fromRuntime = runtimeItemsForNode(options.demo.snapshot(now).runtime, nodeId, limit);
        return jsonResponse(itemsBody({ generatedAt, datasetMode, nodeId, limit, items: fromRuntime.items, unavailable_reason: fromRuntime.unavailable_reason }));
      }
      const items = options.demo.items({ nodeId, limit, now });
      return jsonResponse(itemsBody({ generatedAt, datasetMode, nodeId, limit, items, unavailable_reason: null }));
    }

    if (!isDbNode) {
      const fromRuntime = runtimeItemsForNode(runtime, nodeId, limit);
      return jsonResponse(itemsBody({ generatedAt, datasetMode, nodeId, limit, items: fromRuntime.items, unavailable_reason: fromRuntime.unavailable_reason }));
    }
    try {
      const rows = await options.withTransactionalSqlExecutor(env, (executor) =>
        createPipelineFlowStore(executor).readItems({ datasetKind, node: nodeId as (typeof PIPELINE_FLOW_DB_ITEM_NODES)[number], now, limit }));
      const note = nodeId === "retrieve"
        ? "Pencarian bukti tidak punya catatan sendiri. Daftar ini adalah vektor yang tersedia untuk dicari."
        : null;
      return jsonResponse(itemsBody({ generatedAt, datasetMode, nodeId, limit, items: rows.map(toItem), unavailable_reason: note }));
    } catch {
      return errorResponse(503, "TEMPORARILY_UNAVAILABLE", "Rincian pipeline tidak tersedia saat ini.");
    }
  };
}

function itemsBody(input: {
  readonly generatedAt: string;
  readonly datasetMode: PipelineFlowDatasetMode;
  readonly nodeId: PipelineFlowNodeId;
  readonly limit: number;
  readonly items: readonly PipelineFlowItemDto[];
  readonly unavailable_reason: string | null;
}): PipelineFlowItemsDto {
  return {
    schema_version: PIPELINE_FLOW_SCHEMA_VERSION,
    generated_at: input.generatedAt,
    dataset_mode: input.datasetMode,
    node_id: input.nodeId,
    limit: input.limit,
    items: input.items,
    unavailable_reason: input.unavailable_reason,
  };
}
