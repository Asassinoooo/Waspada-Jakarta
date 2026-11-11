/**
 * FLOW-VIS-01: in-process status of the live polling cycle. It holds counts, timings and a short
 * ring of item events. It never stores text, prompts, URLs or vectors; an item is referenced only by
 * an opaque ref (a revision id or identity hash). Only `tools/serve-live-pipeline.ts` writes to it,
 * and the Worker reads it through `env.PIPELINE_STATUS`. Absent in the Worker and demo, where the
 * runtime-only nodes report `unavailable`.
 */

export type PipelineRuntimeStage = "petabencana" | "bmkg" | "rss" | "dedupe" | "det_filter" | "triage" | "cycle" | "ninerouter";
export type PipelineRuntimeItemStatus = "ingest" | "held" | "duplicate" | "deferred" | "dropped" | "error" | "completed";

export interface PipelineRuntimeItem {
  readonly stage: PipelineRuntimeStage;
  readonly item_ref: string;
  readonly status: PipelineRuntimeItemStatus;
  readonly at: string;
}

export interface PipelineRuntimeSourceCounts {
  readonly ingest: number;
  readonly held: number;
  readonly duplicate: number;
  readonly deferred: number;
  readonly errors: number;
}

export interface PipelineRuntimeNineRouterBucket {
  readonly rpm: number;
  readonly tokensAvailable: number;
  readonly cooldownRemainingMs: number;
  readonly inFlight: number;
  readonly queued: number;
}

/** Structurally the same as the rate gate snapshot (`getNineRouterRateGateSnapshot`). */
export interface PipelineRuntimeNineRouter {
  readonly chat: PipelineRuntimeNineRouterBucket;
  readonly embed: PipelineRuntimeNineRouterBucket;
  readonly callCounts: { readonly chat: number; readonly embed: number };
}

export interface PipelineRuntimeCycle {
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

export interface PipelineRuntimeSnapshot {
  readonly generated_at: string;
  readonly cycle: PipelineRuntimeCycle;
  /** Last completed cycle, per source family. Null until a cycle reports that family. */
  readonly sources: Readonly<Record<"petabencana" | "bmkg" | "rss", PipelineRuntimeSourceCounts | null>>;
  readonly dedupe: {
    readonly title_hits_last_cycle: number;
    readonly cycle_hits_last_cycle: number;
    readonly hits_total: number;
  };
  readonly det_filter: {
    readonly mode: string | null;
    readonly dropped_last_cycle: number | null;
  };
  readonly ninerouter: PipelineRuntimeNineRouter | null;
}

export interface PipelineRuntimeStatusProvider {
  snapshot(nowMs?: number): PipelineRuntimeSnapshot;
  /** Recent item events, newest first. Optionally one stage only. */
  recentItems(options?: { readonly stage?: PipelineRuntimeStage; readonly limit?: number }): readonly PipelineRuntimeItem[];
  /** Weighted events for one stage in the trailing window (default 15 minutes). */
  throughput(stage: PipelineRuntimeStage, windowMs?: number, nowMs?: number): number;
}

export interface PipelineRuntimeStatusOptions {
  readonly now?: () => number;
  readonly ninerouter?: () => PipelineRuntimeNineRouter;
  readonly ringSize?: number;
  readonly sampleCap?: number;
}

export const PIPELINE_RUNTIME_RING_SIZE = 50;
export const PIPELINE_RUNTIME_THROUGHPUT_WINDOW_MS = 15 * 60_000;
const DEFAULT_SAMPLE_CAP = 2_000;

interface ThroughputSample {
  readonly at: number;
  readonly weight: number;
}

function emptySourceTotals(): PipelineRuntimeSourceCounts {
  return { ingest: 0, held: 0, duplicate: 0, deferred: 0, errors: 0 };
}

export function createPipelineRuntimeStatus(options: PipelineRuntimeStatusOptions = {}): PipelineRuntimeStatusProvider & RecordingPipelineRuntimeStatus {
  const now = options.now ?? (() => Date.now());
  const ringSize = options.ringSize ?? PIPELINE_RUNTIME_RING_SIZE;
  const sampleCap = options.sampleCap ?? DEFAULT_SAMPLE_CAP;

  let sequence = 0;
  let running = false;
  let startedAtMs: number | null = null;
  let finishedAtMs: number | null = null;
  let durationMs: number | null = null;
  let newItemsCap: number | null = null;
  let newItemsUsed: number | null = null;
  let feedsTotal: number | null = null;
  let feedsFailed: number | null = null;
  let cycleErrors = 0;

  let currentSources: Record<"petabencana" | "bmkg" | "rss", PipelineRuntimeSourceCounts | null> = { petabencana: null, bmkg: null, rss: null };
  let titleHitsLast = 0;
  let cycleHitsLast = 0;
  let hitsTotal = 0;
  let detMode: string | null = null;
  let detDroppedLast: number | null = null;

  const ring: PipelineRuntimeItem[] = [];
  const samples = new Map<PipelineRuntimeStage, ThroughputSample[]>();

  function iso(ms: number): string {
    return new Date(ms).toISOString();
  }

  function addSample(stage: PipelineRuntimeStage, weight: number, atMs: number): void {
    if (weight <= 0) return;
    const list = samples.get(stage) ?? [];
    list.push({ at: atMs, weight });
    if (list.length > sampleCap) list.splice(0, list.length - sampleCap);
    samples.set(stage, list);
  }

  function pushItem(stage: PipelineRuntimeStage, itemRef: string, status: PipelineRuntimeItemStatus, atMs: number): void {
    ring.unshift({ stage, item_ref: itemRef, status, at: iso(atMs) });
    if (ring.length > ringSize) ring.length = ringSize;
  }

  return {
    recordCycleStart(input = {}) {
      sequence += 1;
      running = true;
      startedAtMs = now();
      finishedAtMs = null;
      durationMs = null;
      newItemsCap = input.newItemsCap ?? null;
      newItemsUsed = null;
      feedsTotal = input.feedsTotal ?? null;
      feedsFailed = null;
      cycleErrors = 0;
      currentSources = { petabencana: null, bmkg: null, rss: null };
      titleHitsLast = 0;
      cycleHitsLast = 0;
      detDroppedLast = null;
    },

    recordCycleEnd(input = {}) {
      const finishedMs = now();
      running = false;
      finishedAtMs = finishedMs;
      durationMs = startedAtMs === null ? null : Math.max(0, finishedMs - startedAtMs);
      newItemsUsed = input.newItemsUsed ?? newItemsUsed;
      feedsFailed = input.feedsFailed ?? feedsFailed;
      cycleErrors = input.errors ?? cycleErrors;
      addSample("cycle", 1, finishedMs);
      pushItem("cycle", `cycle-${sequence}`, cycleErrors > 0 ? "error" : "completed", finishedMs);
    },

    recordSourceCycle(family, counts) {
      const previous = currentSources[family] ?? emptySourceTotals();
      currentSources = {
        ...currentSources,
        [family]: {
          ingest: previous.ingest + counts.ingest,
          held: previous.held + counts.held,
          duplicate: previous.duplicate + counts.duplicate,
          deferred: previous.deferred + counts.deferred,
          errors: previous.errors + counts.errors,
        },
      };
      cycleErrors += counts.errors;
      addSample(family, counts.ingest, now());
    },

    recordDedupeHits(input) {
      const atMs = now();
      titleHitsLast += input.title;
      cycleHitsLast += input.cycle;
      hitsTotal += input.title + input.cycle;
      if (input.title > 0) {
        addSample("dedupe", input.title, atMs);
        pushItem("dedupe", input.ref ?? "title-dedupe", "duplicate", atMs);
      }
      if (input.cycle > 0) {
        addSample("dedupe", input.cycle, atMs);
        pushItem("dedupe", input.ref ?? "cycle-dedupe", "duplicate", atMs);
      }
    },

    recordDetFilter(input) {
      const atMs = now();
      detMode = input.mode;
      detDroppedLast = (detDroppedLast ?? 0) + input.dropped;
      addSample("det_filter", input.dropped, atMs);
    },

    recordItem(input) {
      const atMs = now();
      pushItem(input.stage, input.itemRef, input.status, atMs);
      addSample(input.stage, 1, atMs);
    },

    recordNineRouterCalls(delta) {
      addSample("ninerouter", delta, now());
    },

    snapshot(nowMs) {
      const at = nowMs ?? now();
      const cycleElapsed = running && startedAtMs !== null ? Math.max(0, at - startedAtMs) : durationMs;
      return {
        generated_at: iso(at),
        cycle: {
          running,
          sequence,
          started_at: startedAtMs === null ? null : iso(startedAtMs),
          finished_at: finishedAtMs === null ? null : iso(finishedAtMs),
          duration_ms: cycleElapsed,
          new_items_cap: newItemsCap,
          new_items_used: newItemsUsed,
          feeds_total: feedsTotal,
          feeds_failed: feedsFailed,
          error_count: cycleErrors,
        },
        sources: { ...currentSources },
        dedupe: { title_hits_last_cycle: titleHitsLast, cycle_hits_last_cycle: cycleHitsLast, hits_total: hitsTotal },
        det_filter: { mode: detMode, dropped_last_cycle: detDroppedLast },
        ninerouter: options.ninerouter ? options.ninerouter() : null,
      };
    },

    recentItems(query = {}) {
      const limit = Math.max(1, Math.min(ringSize, query.limit ?? ringSize));
      const filtered = query.stage ? ring.filter((item) => item.stage === query.stage) : ring;
      return filtered.slice(0, limit);
    },

    throughput(stage, windowMs = PIPELINE_RUNTIME_THROUGHPUT_WINDOW_MS, nowMs) {
      const at = nowMs ?? now();
      const list = samples.get(stage) ?? [];
      let total = 0;
      for (const sample of list) {
        if (at - sample.at < windowMs && sample.at <= at) total += sample.weight;
      }
      return total;
    },
  };
}

export interface RecordingPipelineRuntimeStatus {
  recordCycleStart(input?: { readonly newItemsCap?: number | null; readonly feedsTotal?: number | null }): void;
  recordCycleEnd(input?: { readonly newItemsUsed?: number | null; readonly feedsFailed?: number | null; readonly errors?: number }): void;
  recordSourceCycle(family: "petabencana" | "bmkg" | "rss", counts: PipelineRuntimeSourceCounts): void;
  recordDedupeHits(input: { readonly title: number; readonly cycle: number; readonly ref?: string }): void;
  recordDetFilter(input: { readonly mode: string; readonly dropped: number }): void;
  recordItem(input: { readonly stage: PipelineRuntimeStage; readonly itemRef: string; readonly status: PipelineRuntimeItemStatus }): void;
  recordNineRouterCalls(delta: number): void;
}
