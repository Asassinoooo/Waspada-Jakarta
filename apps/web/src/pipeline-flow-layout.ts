/**
 * FLOW-VIS-01 static layout, compact since FLOW-VIS-02. The pipeline runs as a snake over a six by
 * four grid so the whole diagram fits a wide screen without panning:
 *
 *   row 0  →  RSS · dedupe · filter · triage · revisions · AI queue
 *   row 1  ←                      retrieve · embed · interpret      (PetaBencana and BMKG at the left)
 *   row 2  ←  published · gate · proposal · correlate
 *   row 3     review                                · NineRouter · cycle (L5)
 *
 * Positions and edge handles are a fixed table, so no layout engine is needed. The diagram is not
 * movable: cards cannot be dragged and the view is not panned or zoomed.
 */
import type { PipelineFlowNodeId } from "@waspada/worker/pipeline-flow-contracts";
import type { PipelineLayerId } from "./pipeline-layers.js";

export interface NodePosition {
  readonly x: number;
  readonly y: number;
}

export const PIPELINE_NODE_WIDTH = 200;
export const PIPELINE_NODE_HEIGHT = 180;
export const PIPELINE_COLUMN_WIDTH = 236;
export const PIPELINE_ROW_HEIGHT = 232;

const COLUMN = (index: number) => index * PIPELINE_COLUMN_WIDTH;
const ROW = (index: number) => index * PIPELINE_ROW_HEIGHT;

export const PIPELINE_DEFAULT_POSITIONS: Readonly<Record<PipelineFlowNodeId, NodePosition>> = {
  src_rss: { x: COLUMN(0), y: ROW(0) },
  dedupe: { x: COLUMN(1), y: ROW(0) },
  det_filter: { x: COLUMN(2), y: ROW(0) },
  triage: { x: COLUMN(3), y: ROW(0) },
  revisions: { x: COLUMN(4), y: ROW(0) },
  ai_queue: { x: COLUMN(5), y: ROW(0) },
  src_petabencana: { x: COLUMN(0), y: ROW(1) },
  src_bmkg: { x: COLUMN(1), y: ROW(1) },
  interpret: { x: COLUMN(5), y: ROW(1) },
  embed: { x: COLUMN(4), y: ROW(1) },
  retrieve: { x: COLUMN(3), y: ROW(1) },
  correlate: { x: COLUMN(3), y: ROW(2) },
  proposal: { x: COLUMN(2), y: ROW(2) },
  gate: { x: COLUMN(1), y: ROW(2) },
  published: { x: COLUMN(0), y: ROW(2) },
  review: { x: COLUMN(1), y: ROW(3) },
  ninerouter: { x: COLUMN(4), y: ROW(3) },
  cycle: { x: COLUMN(5), y: ROW(3) },
};

/** Handle ids rendered on every card. Sources leave from one side, targets enter from another. */
export type PipelineHandleSide = "left" | "right" | "top" | "bottom";

export interface PipelineEdgeHandles {
  readonly source: PipelineHandleSide;
  readonly target: PipelineHandleSide;
}

const FORWARD: PipelineEdgeHandles = { source: "right", target: "left" };
const BACKWARD: PipelineEdgeHandles = { source: "left", target: "right" };
const DOWN: PipelineEdgeHandles = { source: "bottom", target: "top" };
const UP: PipelineEdgeHandles = { source: "top", target: "bottom" };

/** Edges not listed run left to right. */
const EDGE_HANDLES: Readonly<Record<string, PipelineEdgeHandles>> = {
  "src_petabencana->revisions": UP,
  "src_bmkg->revisions": UP,
  "ai_queue->interpret": DOWN,
  "interpret->embed": BACKWARD,
  "embed->retrieve": BACKWARD,
  "retrieve->correlate": DOWN,
  "correlate->proposal": BACKWARD,
  "proposal->gate": BACKWARD,
  "gate->published": BACKWARD,
  "gate->review": DOWN,
  "review->published": { source: "left", target: "bottom" },
};

export function pipelineEdgeHandles(from: PipelineFlowNodeId, to: PipelineFlowNodeId): PipelineEdgeHandles {
  return EDGE_HANDLES[`${from}->${to}`] ?? FORWARD;
}

export interface PipelineLaneBand {
  readonly lane: PipelineLayerId;
  /** Only the first band of a lane shows the lane title. */
  readonly titled: boolean;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

const BAND_PAD = 12;
const BAND_TITLE_ROOM = 28;

function band(lane: PipelineLayerId, titled: boolean, firstColumn: number, lastColumn: number, firstRow: number, lastRow: number): PipelineLaneBand {
  const top = titled ? BAND_TITLE_ROOM : BAND_PAD;
  return {
    lane,
    titled,
    x: COLUMN(firstColumn) - BAND_PAD,
    y: ROW(firstRow) - top,
    width: COLUMN(lastColumn) - COLUMN(firstColumn) + PIPELINE_NODE_WIDTH + 2 * BAND_PAD,
    height: ROW(lastRow) - ROW(firstRow) + PIPELINE_NODE_HEIGHT + top + BAND_PAD,
  };
}

/** Background bands behind each swimlane. They are not interactive. */
export const PIPELINE_LANE_BANDS: readonly PipelineLaneBand[] = [
  band("L1", true, 0, 4, 0, 0),
  band("L1", false, 0, 1, 1, 1),
  band("L2", true, 5, 5, 0, 1),
  band("L2", false, 3, 4, 1, 1),
  band("L3", true, 2, 3, 2, 2),
  band("L4", true, 0, 1, 2, 3),
  band("L5", true, 4, 5, 3, 3),
];
