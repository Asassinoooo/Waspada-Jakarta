/**
 * FLOW-VIS-01 static layout. Swimlanes run left to right (L1 to L4) with L5 as a bottom strip.
 * Positions are a fixed table, so no layout engine is needed. Users may drag nodes; the moved
 * positions are kept in localStorage (wrapped in try/catch) and can be reset to this table.
 */
import type { PipelineFlowNodeId } from "@waspada/worker/pipeline-flow-contracts";
import type { PipelineLayerId } from "./pipeline-layers.js";

export interface NodePosition {
  readonly x: number;
  readonly y: number;
}

export const PIPELINE_LAYOUT_STORAGE_KEY = "waspada.alur-agen.tata-letak.v1";
export const PIPELINE_NODE_WIDTH = 200;
export const PIPELINE_COLUMN_WIDTH = 250;
export const PIPELINE_ROW_HEIGHT = 170;

const COLUMN = (index: number) => index * PIPELINE_COLUMN_WIDTH;
const ROW = (index: number) => index * PIPELINE_ROW_HEIGHT;

export const PIPELINE_DEFAULT_POSITIONS: Readonly<Record<PipelineFlowNodeId, NodePosition>> = {
  src_petabencana: { x: COLUMN(0), y: ROW(0) },
  src_bmkg: { x: COLUMN(0), y: ROW(1) },
  src_rss: { x: COLUMN(0), y: ROW(2) },
  dedupe: { x: COLUMN(1), y: ROW(2) },
  det_filter: { x: COLUMN(2), y: ROW(2) },
  triage: { x: COLUMN(3), y: ROW(2) },
  revisions: { x: COLUMN(4), y: ROW(1) },
  ai_queue: { x: COLUMN(5), y: ROW(1) },
  interpret: { x: COLUMN(6), y: ROW(1) },
  embed: { x: COLUMN(7), y: ROW(1) },
  retrieve: { x: COLUMN(8), y: ROW(1) },
  correlate: { x: COLUMN(9), y: ROW(1) },
  proposal: { x: COLUMN(10), y: ROW(1) },
  gate: { x: COLUMN(11), y: ROW(1) },
  published: { x: COLUMN(12), y: ROW(0) },
  review: { x: COLUMN(12), y: ROW(2) },
  ninerouter: { x: COLUMN(0), y: ROW(3) + 40 },
  cycle: { x: COLUMN(1), y: ROW(3) + 40 },
};

export interface PipelineLaneBand {
  readonly lane: PipelineLayerId;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** Background bands behind each swimlane. They are not interactive. */
export const PIPELINE_LANE_BANDS: readonly PipelineLaneBand[] = [
  { lane: "L1", x: -20, y: -60, width: COLUMN(4) + PIPELINE_NODE_WIDTH + 40, height: ROW(2) + 170 + 40 },
  { lane: "L2", x: COLUMN(5) - 20, y: -60, width: COLUMN(8) + PIPELINE_NODE_WIDTH - COLUMN(5) + 40, height: ROW(2) + 170 + 40 },
  { lane: "L3", x: COLUMN(9) - 20, y: -60, width: COLUMN(10) + PIPELINE_NODE_WIDTH - COLUMN(9) + 40, height: ROW(2) + 170 + 40 },
  { lane: "L4", x: COLUMN(11) - 20, y: -60, width: COLUMN(12) + PIPELINE_NODE_WIDTH - COLUMN(11) + 40, height: ROW(2) + 170 + 40 },
  { lane: "L5", x: -20, y: ROW(3) + 40 - 40, width: COLUMN(12) + PIPELINE_NODE_WIDTH + 40, height: 170 },
];

export type StoredPositions = Partial<Record<PipelineFlowNodeId, NodePosition>>;

const MAX_COORDINATE = 20_000;

function isPosition(value: unknown): value is NodePosition {
  if (value === null || typeof value !== "object") return false;
  const candidate = value as { x?: unknown; y?: unknown };
  return typeof candidate.x === "number" && typeof candidate.y === "number"
    && Number.isFinite(candidate.x) && Number.isFinite(candidate.y)
    && Math.abs(candidate.x) <= MAX_COORDINATE && Math.abs(candidate.y) <= MAX_COORDINATE;
}

/** Reads saved positions. Any storage error or malformed value yields no saved positions. */
export function loadStoredPositions(storage: Pick<Storage, "getItem"> | null = safeLocalStorage()): StoredPositions {
  try {
    const raw = storage?.getItem(PIPELINE_LAYOUT_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const out: StoredPositions = {};
    for (const id of Object.keys(PIPELINE_DEFAULT_POSITIONS) as PipelineFlowNodeId[]) {
      if (isPosition(parsed[id])) out[id] = { x: parsed[id].x, y: parsed[id].y };
    }
    return out;
  } catch {
    return {};
  }
}

/** Saves positions. A full or blocked storage is ignored; the layout then lasts for the page only. */
export function saveStoredPositions(
  positions: StoredPositions,
  storage: Pick<Storage, "setItem"> | null = safeLocalStorage(),
): boolean {
  try {
    storage?.setItem(PIPELINE_LAYOUT_STORAGE_KEY, JSON.stringify(positions));
    return storage !== null;
  } catch {
    return false;
  }
}

export function clearStoredPositions(storage: Pick<Storage, "removeItem"> | null = safeLocalStorage()): void {
  try {
    storage?.removeItem(PIPELINE_LAYOUT_STORAGE_KEY);
  } catch {
    // Nothing to clear when storage is blocked.
  }
}

/** Defaults overlaid with valid saved positions. */
export function resolvePipelinePositions(stored: StoredPositions): Record<PipelineFlowNodeId, NodePosition> {
  const out = { ...PIPELINE_DEFAULT_POSITIONS } as Record<PipelineFlowNodeId, NodePosition>;
  for (const id of Object.keys(out) as PipelineFlowNodeId[]) {
    const saved = stored[id];
    if (saved && isPosition(saved)) out[id] = { x: saved.x, y: saved.y };
  }
  return out;
}

function safeLocalStorage(): Storage | null {
  try {
    return typeof window !== "undefined" && window.localStorage ? window.localStorage : null;
  } catch {
    return null;
  }
}
