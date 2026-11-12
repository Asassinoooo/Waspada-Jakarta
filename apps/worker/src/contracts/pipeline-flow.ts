/**
 * FLOW-VIS-01: `pipeline-flow-v1`, the moderator-only contract for the live agent pipeline view.
 * It is separate from the public `/api/v1` DTOs and carries counts and metadata only. It never
 * carries text, prompts, vectors, keys or endpoints.
 */

export const PIPELINE_FLOW_SCHEMA_VERSION = "pipeline-flow-v1" as const;

export const PIPELINE_FLOW_NODE_IDS = [
  "src_petabencana",
  "src_bmkg",
  "src_rss",
  "dedupe",
  "det_filter",
  "triage",
  "revisions",
  "ai_queue",
  "interpret",
  "embed",
  "retrieve",
  "correlate",
  "proposal",
  "gate",
  "review",
  "published",
  "ninerouter",
  "cycle",
] as const;

export type PipelineFlowNodeId = (typeof PIPELINE_FLOW_NODE_IDS)[number];

export const PIPELINE_FLOW_LANES = ["L1", "L2", "L3", "L4", "L5"] as const;
export type PipelineFlowLane = (typeof PIPELINE_FLOW_LANES)[number];

/** idle: nothing recent. active: items moved in 15 min. waiting: deferred or cooling down. failing: recent failure. unavailable: no state source. */
export const PIPELINE_FLOW_HEALTH = ["idle", "active", "waiting", "failing", "unavailable"] as const;
export type PipelineFlowHealth = (typeof PIPELINE_FLOW_HEALTH)[number];

export type PipelineFlowDatasetMode = "live" | "demo";

export interface PipelineFlowNodeDto {
  readonly id: PipelineFlowNodeId;
  readonly lane: PipelineFlowLane;
  readonly health: PipelineFlowHealth;
  /**
   * Stable machine keys mapped to counts. Zero means "no data in the window", never "safe".
   * REVIEW-EXPIRY-01 added `expired_24h` to the review node. Clients must treat a missing key as absent.
   */
  readonly counts: Readonly<Record<string, number>>;
  readonly throughput_15m: number;
}

export interface PipelineFlowEdgeDto {
  readonly from: PipelineFlowNodeId;
  readonly to: PipelineFlowNodeId;
  /** The downstream node's throughput; the edge animates when this is above zero. */
  readonly throughput_15m: number;
}

export interface PipelineFlowNineRouterDto {
  readonly chat: { readonly rpm: number; readonly tokens_available: number; readonly cooldown_remaining_ms: number; readonly in_flight: number; readonly queued: number };
  readonly embed: { readonly rpm: number; readonly tokens_available: number; readonly cooldown_remaining_ms: number; readonly in_flight: number; readonly queued: number };
  readonly call_counts: { readonly chat: number; readonly embed: number };
}

export interface PipelineFlowCycleDto {
  readonly running: boolean;
  readonly sequence: number;
  readonly started_at: string | null;
  readonly finished_at: string | null;
  readonly duration_ms: number | null;
  readonly new_items_cap: number | null;
  readonly new_items_used: number | null;
  readonly feeds_total: number | null;
  readonly feeds_failed: number | null;
  readonly error_count: number;
}

export interface PipelineFlowRuntimeDto {
  readonly generated_at: string;
  readonly ninerouter: PipelineFlowNineRouterDto;
  readonly cycle: PipelineFlowCycleDto;
}

export interface PipelineFlowSnapshotDto {
  readonly schema_version: typeof PIPELINE_FLOW_SCHEMA_VERSION;
  readonly generated_at: string;
  readonly dataset_mode: PipelineFlowDatasetMode;
  readonly window_hours: 24;
  readonly nodes: readonly PipelineFlowNodeDto[];
  readonly edges: readonly PipelineFlowEdgeDto[];
  /** Null when the runtime status is not attached (the Worker, demo, or a stopped server). */
  readonly runtime: PipelineFlowRuntimeDto | null;
}

export interface PipelineFlowItemDto {
  /** Opaque reference: a revision id, identity-hash prefix, proposal id or runtime ref. Never text. */
  readonly ref: string;
  readonly status: string;
  readonly failure_code: string | null;
  /** Short title, only where the source table has one. Moderator-only. */
  readonly title: string | null;
  readonly at: string | null;
}

export interface PipelineFlowItemsDto {
  readonly schema_version: typeof PIPELINE_FLOW_SCHEMA_VERSION;
  readonly generated_at: string;
  readonly dataset_mode: PipelineFlowDatasetMode;
  readonly node_id: PipelineFlowNodeId;
  readonly limit: number;
  readonly items: readonly PipelineFlowItemDto[];
  /** Null when the node reads only the runtime and the runtime is not attached. */
  readonly unavailable_reason: string | null;
}

export const PIPELINE_FLOW_ITEM_LIMIT_DEFAULT = 20;
export const PIPELINE_FLOW_ITEM_LIMIT_MAX = 20;
