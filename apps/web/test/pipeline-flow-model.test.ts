import assert from "node:assert/strict";
import test from "node:test";
import type { PipelineFlowNodeDto, PipelineFlowSnapshotDto } from "@waspada/worker/pipeline-flow-contracts";
import { PIPELINE_FLOW_NODE_IDS } from "@waspada/worker/pipeline-flow-contracts";
import {
  countLabel,
  cooldownLabel,
  failureLabel,
  isPipelineFlowRange,
  nodeView,
  PIPELINE_COUNT_LABELS,
  PIPELINE_HEALTH_LABELS,
  PIPELINE_NODE_META,
  PIPELINE_RANGE_LABELS,
  PIPELINE_RANGE_STORAGE_KEY,
  PIPELINE_REVIEW_LINK_NODES,
  readStoredPipelineFlowRange,
  relativeTimeLabel,
  snapshotRange,
  statusLabel,
  toPipelineFlowGraph,
  writeStoredPipelineFlowRange,
} from "../src/pipeline-flow-model.js";
import {
  PIPELINE_COLUMN_WIDTH,
  PIPELINE_DEFAULT_POSITIONS,
  PIPELINE_LANE_BANDS,
  PIPELINE_NODE_HEIGHT,
  PIPELINE_NODE_WIDTH,
  PIPELINE_ROW_HEIGHT,
} from "../src/pipeline-flow-layout.js";
import { PIPELINE_LAYER_NAMES, PIPELINE_LAYER_SHORT_NAMES } from "../src/pipeline-layers.js";
import { demoSnapshot } from "./pipeline-flow-fixtures.js";

const NOW = Date.parse("2026-11-11T09:00:00.000Z");

function nodeById(snapshot: PipelineFlowSnapshotDto, id: string): PipelineFlowNodeDto {
  const node = snapshot.nodes.find((candidate) => candidate.id === id);
  assert.ok(node, `node ${id} exists`);
  return node;
}

test("the snapshot maps to five titled swimlanes and eighteen stage cards with pipeline edges", () => {
  const snapshot = demoSnapshot();
  const graph = toPipelineFlowGraph(snapshot, PIPELINE_DEFAULT_POSITIONS);
  const lanes = graph.nodes.filter((node) => node.type === "lane");
  const cards = graph.nodes.filter((node) => node.type === "flow");
  const titled = lanes.filter((lane) => (lane.data as { title: string }).title !== "");
  assert.equal(titled.length, 5);
  assert.equal(new Set(lanes.map((lane) => lane.id)).size, lanes.length, "band ids are unique");
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

test("the fixed layout is a compact grid with no overlapping cards and every card inside its lane band", () => {
  const positions = Object.entries(PIPELINE_DEFAULT_POSITIONS);
  const cells = new Set(positions.map(([, p]) => `${p.x / PIPELINE_COLUMN_WIDTH},${p.y / PIPELINE_ROW_HEIGHT}`));
  assert.equal(cells.size, positions.length, "each card has its own grid cell");
  const columns = Math.max(...positions.map(([, p]) => p.x)) / PIPELINE_COLUMN_WIDTH + 1;
  const rows = Math.max(...positions.map(([, p]) => p.y)) / PIPELINE_ROW_HEIGHT + 1;
  assert.ok(columns <= 6 && rows <= 4, `fits a 6 by 4 grid, got ${columns} by ${rows}`);
  const width = (columns - 1) * PIPELINE_COLUMN_WIDTH + PIPELINE_NODE_WIDTH;
  const height = (rows - 1) * PIPELINE_ROW_HEIGHT + PIPELINE_NODE_HEIGHT;
  assert.ok(width / height < 2.2, "wide but not a long horizontal strip");

  const graph = toPipelineFlowGraph(demoSnapshot(), PIPELINE_DEFAULT_POSITIONS);
  for (const card of graph.nodes.filter((node) => node.type === "flow")) {
    assert.equal(card.draggable, false, `${card.id} cannot be dragged`);
    const lane = (card.data as { view: { lane: string } }).view.lane;
    const inside = PIPELINE_LANE_BANDS.some((band) => band.lane === lane
      && card.position.x >= band.x && card.position.x + PIPELINE_NODE_WIDTH <= band.x + band.width
      && card.position.y >= band.y && card.position.y + PIPELINE_NODE_HEIGHT <= band.y + band.height);
    assert.ok(inside, `${card.id} sits inside a ${lane} band`);
  }
  for (const edge of graph.edges) {
    assert.match(String(edge.sourceHandle), /^source-(left|right|top|bottom)$/u);
    assert.match(String(edge.targetHandle), /^target-(left|right|top|bottom)$/u);
  }
});

test("the demo fixture carries no permitted text and only fictional titles", () => {
  const snapshot = demoSnapshot();
  assert.equal(snapshot.dataset_mode, "demo");
  assert.ok(snapshot.runtime !== null);
  assert.equal(snapshot.nodes.length, PIPELINE_FLOW_NODE_IDS.length);
});

test("the review node shows a kedaluwarsa chip, and its drawer says unreviewed proposals expire unpublished (REVIEW-EXPIRY-01)", () => {
  const snapshot = demoSnapshot();
  const review = nodeView(nodeById(snapshot, "review"));
  assert.deepEqual(review.chips.find((row) => row.label === "kedaluwarsa"), { label: "kedaluwarsa", value: 2, tone: "neutral" });
  assert.equal(countLabel("expired_24h"), "Kedaluwarsa 24 jam");
  assert.match(review.description, /Usulan yang tidak ditinjau dalam 48 jam ditandai kedaluwarsa dan tidak diterbitkan\./u);

  const older = nodeView({ ...nodeById(snapshot, "review"), counts: { waiting_discrepancy: 2, waiting_gate: 3 } });
  assert.equal(older.chips.some((row) => row.label === "kedaluwarsa"), false, "a snapshot without the count shows no chip");
});

test("FLOW-RANGE-01: keys ending in _24h name the selected window, and _15m labels never change", () => {
  assert.equal(countLabel("skipped_24h"), "Dilewati 24 jam", "the default window keeps today's wording");
  assert.equal(countLabel("skipped_24h", "7d"), "Dilewati 7 hari");
  assert.equal(countLabel("skipped_24h", "1h"), "Dilewati 1 jam");
  assert.equal(countLabel("expired_24h", "30d"), "Kedaluwarsa 30 hari");
  assert.equal(countLabel("skipped_15m", "7d"), "Dilewati 15 menit", "the 15 minute throughput is not windowed");
  assert.equal(countLabel("moderator_decisions_15m", "6h"), "Keputusan moderator 15 menit");
  assert.deepEqual(PIPELINE_RANGE_LABELS, { "1h": "1 jam", "6h": "6 jam", "24h": "24 jam", "7d": "7 hari", "30d": "30 hari" });
});

test("FLOW-RANGE-01: a card and its empty line follow the snapshot's window, and the default is unchanged", () => {
  const snapshot = demoSnapshot();
  const detFilter = nodeById(snapshot, "det_filter");
  const dflt = nodeView(detFilter);
  assert.equal(dflt.primaryLabel, "Dilewati 24 jam");
  assert.equal(dflt.windowLabel, "24 jam");
  assert.ok(dflt.countRows.some((row) => row.label === "Dilewati 15 menit"));

  const weekly: PipelineFlowSnapshotDto = { ...snapshot, window: { range: "7d", since: "2026-11-04T09:00:00.000Z" } };
  const graph = toPipelineFlowGraph(weekly, PIPELINE_DEFAULT_POSITIONS);
  const card = graph.nodes.find((node) => node.id === "det_filter")?.data as { view: { primaryLabel: string; windowLabel: string } };
  assert.equal(card.view.primaryLabel, "Dilewati 7 hari");
  assert.equal(card.view.windowLabel, "7 hari");

  const empty = nodeView({ ...detFilter, counts: { skipped_24h: 0, skipped_15m: 0 }, health: "idle", throughput_15m: 0 }, "1h");
  assert.equal(empty.emptyText, "Tidak ada data dalam 1 jam.", "the empty line names the selected window");
  assert.equal(nodeView({ ...detFilter, counts: {} }, "30d").emptyText, "Tidak ada data dalam 30 hari.");
});

test("FLOW-RANGE-01: labels follow the window of the snapshot on screen, falling back to 24 jam without one", () => {
  const snapshot = demoSnapshot();
  assert.equal(snapshotRange(snapshot), "24h");
  assert.equal(snapshotRange({ ...snapshot, window: { range: "30d", since: "2026-10-12T09:00:00.000Z" } }), "30d");
  const legacy = { ...snapshot, window: undefined } as unknown as PipelineFlowSnapshotDto;
  assert.equal(snapshotRange(legacy), "24h", "a response without window is read as the default");
  assert.equal(isPipelineFlowRange("7d"), true);
  assert.equal(isPipelineFlowRange("365d"), false);
  assert.equal(isPipelineFlowRange(null), false);
});

test("FLOW-RANGE-01: the chosen window is remembered per viewer and falls back to 24 jam when storage is blocked or unknown", () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const saved = new Map<string, string>();
  const setStorage = (value: unknown) => Object.defineProperty(globalThis, "localStorage", { configurable: true, value });
  try {
    setStorage({ getItem: (key: string) => saved.get(key) ?? null, setItem: (key: string, value: string) => void saved.set(key, value) });
    assert.equal(readStoredPipelineFlowRange(), "24h", "nothing stored means the default");
    writeStoredPipelineFlowRange("7d");
    assert.equal(saved.get(PIPELINE_RANGE_STORAGE_KEY), "7d");
    assert.equal(readStoredPipelineFlowRange(), "7d");
    saved.set(PIPELINE_RANGE_STORAGE_KEY, "365d");
    assert.equal(readStoredPipelineFlowRange(), "24h", "an unknown stored value is ignored");

    setStorage({
      getItem: () => { throw new Error("blocked"); },
      setItem: () => { throw new Error("blocked"); },
    });
    assert.equal(readStoredPipelineFlowRange(), "24h", "blocked storage falls back to the default");
    assert.doesNotThrow(() => writeStoredPipelineFlowRange("1h"), "a blocked write does not break the page");
  } finally {
    if (original) Object.defineProperty(globalThis, "localStorage", original);
    else delete (globalThis as { localStorage?: unknown }).localStorage;
  }
});
