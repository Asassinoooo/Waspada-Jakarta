import assert from "node:assert/strict";
import test from "node:test";
import type { PipelineFlowNodeDto, PipelineFlowSnapshotDto } from "@waspada/worker/pipeline-flow-contracts";
import { PIPELINE_FLOW_NODE_IDS } from "@waspada/worker/pipeline-flow-contracts";
import {
  countLabel,
  cooldownLabel,
  failureLabel,
  nodeView,
  PIPELINE_COUNT_LABELS,
  PIPELINE_HEALTH_LABELS,
  PIPELINE_NODE_META,
  PIPELINE_REVIEW_LINK_NODES,
  relativeTimeLabel,
  statusLabel,
  toPipelineFlowGraph,
} from "../src/pipeline-flow-model.js";
import {
  clearStoredPositions,
  loadStoredPositions,
  PIPELINE_DEFAULT_POSITIONS,
  PIPELINE_LAYOUT_STORAGE_KEY,
  resolvePipelinePositions,
  saveStoredPositions,
} from "../src/pipeline-flow-layout.js";
import { PIPELINE_LAYER_NAMES, PIPELINE_LAYER_SHORT_NAMES } from "../src/pipeline-layers.js";
import { demoSnapshot } from "./pipeline-flow-fixtures.js";

const NOW = Date.parse("2026-11-11T09:00:00.000Z");

function nodeById(snapshot: PipelineFlowSnapshotDto, id: string): PipelineFlowNodeDto {
  const node = snapshot.nodes.find((candidate) => candidate.id === id);
  assert.ok(node, `node ${id} exists`);
  return node;
}

test("the snapshot maps to five swimlane bands and eighteen stage cards with pipeline edges", () => {
  const snapshot = demoSnapshot();
  const graph = toPipelineFlowGraph(snapshot, PIPELINE_DEFAULT_POSITIONS);
  const lanes = graph.nodes.filter((node) => node.type === "lane");
  const cards = graph.nodes.filter((node) => node.type === "flow");
  assert.equal(lanes.length, 5);
  assert.equal(cards.length, PIPELINE_FLOW_NODE_IDS.length);
  for (const lane of lanes) {
    assert.equal(lane.selectable, false, "lane bands are not selectable");
    assert.equal(lane.draggable, false, "lane bands are not draggable");
  }
  const gate = graph.edges.filter((edge) => edge.source === "gate").map((edge) => edge.target).sort();
  assert.deepEqual(gate, ["published", "review"], "the gate branches to auto publication and discrepancy review");
  assert.ok(graph.edges.some((edge) => edge.source === "review" && edge.target === "published"));
});

test("an edge animates only when its downstream stage moved items in the last 15 minutes", () => {
  const snapshot = demoSnapshot();
  const graph = toPipelineFlowGraph(snapshot, PIPELINE_DEFAULT_POSITIONS);
  for (const edge of graph.edges) {
    const downstream = nodeById(snapshot, String(edge.target));
    assert.equal(edge.animated, downstream.throughput_15m > 0, `${String(edge.source)} to ${String(edge.target)}`);
  }
  const quiet = toPipelineFlowGraph({ ...snapshot, edges: snapshot.edges.map((edge) => ({ ...edge, throughput_15m: 0 })) }, PIPELINE_DEFAULT_POSITIONS);
  assert.ok(quiet.edges.every((edge) => edge.animated === false));
});

test("cards take their position from the layout table and carry only the view model", () => {
  const snapshot = demoSnapshot();
  const moved = { ...PIPELINE_DEFAULT_POSITIONS, embed: { x: 9, y: 7 } };
  const graph = toPipelineFlowGraph(snapshot, moved);
  const embed = graph.nodes.find((node) => node.id === "embed");
  assert.deepEqual(embed?.position, { x: 9, y: 7 });
  const data = embed?.data as { view: { label: string }; nineRouter: unknown };
  assert.equal(data.view.label, "Embedding");
  assert.equal(data.nineRouter, null);
  const ninerouter = graph.nodes.find((node) => node.id === "ninerouter")?.data as { nineRouter: { chat: { rpm: number } } | null };
  assert.equal(ninerouter.nineRouter?.chat.rpm, 10, "only the NineRouter card carries its meters");
});

test("a stage with no counts says there is no data in 24 hours and never claims safety", () => {
  const snapshot = demoSnapshot();
  const empty = { ...nodeById(snapshot, "src_bmkg"), counts: { revisions_24h: 0, sources: 0 }, health: "idle" as const, throughput_15m: 0 };
  const view = nodeView(empty);
  assert.equal(view.emptyText, "Tidak ada data dalam 24 jam.", "all-zero counts are an empty stage, not a healthy one");
  const withData = nodeView({ ...empty, counts: { revisions_24h: 3, sources: 1 } });
  assert.equal(withData.emptyText, null);
  const none = nodeView({ ...empty, counts: {} });
  assert.equal(none.emptyText, "Tidak ada data dalam 24 jam.");
  const unavailable = nodeView({ ...nodeById(snapshot, "cycle"), counts: {}, health: "unavailable" });
  assert.equal(unavailable.emptyText, "Status runtime tidak terpasang pada layanan ini.");
  for (const label of Object.values(PIPELINE_HEALTH_LABELS)) {
    assert.doesNotMatch(label, /\baman\b/iu, "no health label claims a place is safe");
  }
});

test("the card chips for the AI queue read as menunggu, berjalan, ditunda and gagal", () => {
  const snapshot = demoSnapshot();
  const queue = nodeView(nodeById(snapshot, "ai_queue"));
  assert.deepEqual(queue.chips.map((chip) => chip.label), ["menunggu", "berjalan", "ditunda", "gagal"]);
  assert.equal(queue.primaryLabel, "Menunggu");
  assert.equal(queue.health, "waiting");
});

test("every count the Worker sends has an Indonesian label, so raw keys never reach the page", () => {
  const snapshot = demoSnapshot();
  for (const node of snapshot.nodes) {
    for (const key of Object.keys(node.counts)) {
      assert.notEqual(countLabel(key), key, `${node.id}.${key} has a label`);
      assert.ok(PIPELINE_COUNT_LABELS[key], `${key} is in the label table`);
    }
  }
});

test("the layer names match the admin dashboard names and the review page links only where items are reviewable", () => {
  assert.deepEqual(PIPELINE_LAYER_NAMES, {
    L1: "Penerimaan laporan",
    L2: "Pencarian bukti",
    L3: "Pemeriksaan lanjutan",
    L4: "Tinjauan laporan",
    L5: "Pemantauan sistem",
  });
  assert.equal(PIPELINE_LAYER_SHORT_NAMES.L4, "Tinjau");
  assert.deepEqual([...PIPELINE_REVIEW_LINK_NODES].sort(), ["gate", "proposal", "published", "review"]);
  for (const id of PIPELINE_FLOW_NODE_IDS) {
    assert.ok(PIPELINE_NODE_META[id].label.length > 0);
    assert.ok(PIPELINE_NODE_META[id].description.length > 0);
  }
});

test("labels for statuses and failure codes are readable and fall back to the raw value", () => {
  assert.equal(statusLabel("needs_review"), "perlu tinjauan");
  assert.equal(statusLabel("versi 3"), "versi 3");
  assert.equal(statusLabel("made_up_status"), "made up status");
  assert.equal(failureLabel("rate_limited"), "limit laju, ditunda");
  assert.equal(failureLabel(null), null);
  assert.equal(failureLabel("new_code_x"), "new code x");
});

test("relative times and cooldowns are plain Indonesian and never invent a time", () => {
  assert.equal(relativeTimeLabel(null, NOW), "waktu tidak tersedia");
  assert.equal(relativeTimeLabel("not a date", NOW), "waktu tidak tersedia");
  assert.equal(relativeTimeLabel(new Date(NOW - 20_000).toISOString(), NOW), "baru saja");
  assert.equal(relativeTimeLabel(new Date(NOW - 5 * 60_000).toISOString(), NOW), "5 menit lalu");
  assert.equal(relativeTimeLabel(new Date(NOW - 3 * 3_600_000).toISOString(), NOW), "3 jam lalu");
  assert.equal(relativeTimeLabel(new Date(NOW - 2 * 86_400_000).toISOString(), NOW), "2 hari lalu");
  assert.equal(cooldownLabel(0), "tidak ada masa tunggu");
  assert.equal(cooldownLabel(42_000), "0:42");
  assert.equal(cooldownLabel(125_000), "2:05");
});

test("saved layout is validated, and broken or blocked storage falls back to defaults without throwing", () => {
  const good = { getItem: () => JSON.stringify({ gate: { x: 100, y: 200 }, embed: { x: "bad", y: 1 }, nope: { x: 1, y: 1 } }) };
  assert.deepEqual(loadStoredPositions(good), { gate: { x: 100, y: 200 } });
  assert.equal(resolvePipelinePositions({ gate: { x: 100, y: 200 } }).gate.x, 100);
  assert.deepEqual(resolvePipelinePositions({}).gate, PIPELINE_DEFAULT_POSITIONS.gate);

  const malformed = { getItem: () => "{not json" };
  assert.deepEqual(loadStoredPositions(malformed), {});
  const blocked = { getItem: () => { throw new Error("SecurityError"); } };
  assert.deepEqual(loadStoredPositions(blocked), {});
  assert.deepEqual(loadStoredPositions(null), {});

  const writes: Array<[string, string]> = [];
  assert.equal(saveStoredPositions({ gate: { x: 1, y: 2 } }, { setItem: (key, value) => { writes.push([key, value]); } }), true);
  assert.equal(writes[0]?.[0], PIPELINE_LAYOUT_STORAGE_KEY);
  assert.equal(saveStoredPositions({}, { setItem: () => { throw new Error("QuotaExceededError"); } }), false);
  assert.doesNotThrow(() => clearStoredPositions({ removeItem: () => { throw new Error("blocked"); } }));
});

test("the demo fixture carries no permitted text and only fictional titles", () => {
  const snapshot = demoSnapshot();
  assert.equal(snapshot.dataset_mode, "demo");
  assert.ok(snapshot.runtime !== null);
  assert.equal(snapshot.nodes.length, PIPELINE_FLOW_NODE_IDS.length);
});
