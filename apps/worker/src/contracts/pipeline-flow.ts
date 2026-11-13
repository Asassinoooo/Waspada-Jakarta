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

/**
 * FLOW-RANGE-01: the time range for windowed counts, sent as `?range=` on the snapshot and item
 * routes. Only these values are accepted. Every count whose key ends in `_24h` (and every `*_24h`
 * drill-down) covers the selected window; the key name is kept for compatibility, and the default
 * window is still 24 h, so a request without `range` returns the same counts as before. The `*_15m`
 * counts and `throughput_15m` always cover the last 15 minutes, whatever the range.
 */
export const PIPELINE_FLOW_RANGES = ["1h", "6h", "24h", "7d", "30d"] as const;
export type PipelineFlowRange = (typeof PIPELINE_FLOW_RANGES)[number];
export const PIPELINE_FLOW_DEFAULT_RANGE: PipelineFlowRange = "24h";
export const PIPELINE_FLOW_RANGE_HOURS = { "1h": 1, "6h": 6, "24h": 24, "7d": 168, "30d": 720 } as const;
export type PipelineFlowWindowHours = (typeof PIPELINE_FLOW_RANGE_HOURS)[PipelineFlowRange];

export interface PipelineFlowWindowDto {
  readonly range: PipelineFlowRange;
  /** Start of the selected window, an ISO instant computed from the response's own clock. */
  readonly since: string;
}

/**
 * Reads the `range` query values. No value means the default. More than one value, or any value that
 * is not one of PIPELINE_FLOW_RANGES, is null, which the route answers with 400.
 */
export function parsePipelineFlowRange(values: readonly string[]): PipelineFlowRange | null {
  if (values.length === 0) return PIPELINE_FLOW_DEFAULT_RANGE;
  if (values.length > 1) return null;
  const value = values[0] ?? "";
  return (PIPELINE_FLOW_RANGES as readonly string[]).includes(value) ? (value as PipelineFlowRange) : null;
}

export function pipelineFlowWindowAt(range: PipelineFlowRange, now: Date): PipelineFlowWindowDto {
  return { range, since: new Date(now.getTime() - PIPELINE_FLOW_RANGE_HOURS[range] * 3_600_000).toISOString() };
}

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
  /** FLOW-RANGE-01: the selected window. Defaults to 24 h when the request has no `range`. */
  readonly window: PipelineFlowWindowDto;
  readonly window_hours: PipelineFlowWindowHours;
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
  /** FLOW-RANGE-01: the window the request asked for. Runtime-only nodes ignore it (their items are not windowed). */
  readonly window: PipelineFlowWindowDto;
  readonly items: readonly PipelineFlowItemDto[];
  /** Null when the node reads only the runtime and the runtime is not attached. */
  readonly unavailable_reason: string | null;
}

export const PIPELINE_FLOW_ITEM_LIMIT_DEFAULT = 20;
export const PIPELINE_FLOW_ITEM_LIMIT_MAX = 20;
