import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { PipelineFlowNodeDto, PipelineFlowSnapshotDto } from "@waspada/worker/pipeline-flow-contracts";
import { overviewAttention, overviewLayers, overviewWindowNote, relativeAgo, worstHealth } from "../src/admin-overview-model.js";
import AdminOverview from "../src/AdminOverview.js";

const NOW = Date.parse("2026-11-28T10:00:00.000Z");

function node(id: PipelineFlowNodeDto["id"], lane: PipelineFlowNodeDto["lane"], health: PipelineFlowNodeDto["health"], counts: Record<string, number> = {}): PipelineFlowNodeDto {
  return { id, lane, health, counts, throughput_15m: 0 };
}

function snapshot(overrides: Partial<PipelineFlowSnapshotDto> = {}): PipelineFlowSnapshotDto {
  return {
    schema_version: "pipeline-flow-v1",
    generated_at: "2026-11-28T09:59:00.000Z",
    dataset_mode: "live",
    window: { range: "24h", since: "2026-11-27T10:00:00.000Z" },
    window_hours: 24,
    nodes: [
      node("src_rss", "L1", "active"),
      node("triage", "L1", "idle", { ingest_24h: 52 }),
      node("revisions", "L1", "active", { eligible_24h: 58 }),
      node("ai_queue", "L2", "waiting", { pending: 3, needs_review: 0 }),
      node("embed", "L2", "active", { available_24h: 31 }),
      node("correlate", "L3", "idle", { incidents_open: 9 }),
      node("proposal", "L3", "idle", { proposed_24h: 15, pending_discrepancy: 2 }),
      node("review", "L4", "waiting", { waiting_discrepancy: 2 }),
      node("published", "L4", "active", { versions_24h: 11 }),
      node("cycle", "L5", "idle"),
    ],
    edges: [],
    runtime: {
      generated_at: "2026-11-28T09:59:00.000Z",
      ninerouter: null,
      cycle: {
        running: false, sequence: 4, started_at: "2026-11-28T09:07:00.000Z", finished_at: "2026-11-28T09:10:00.000Z",
        duration_ms: 180_000, new_items_cap: 40, new_items_used: 12, feeds_total: 14, feeds_failed: 0, error_count: 0,
      },
    },
    ...overrides,
  };
}

test("five layers in order, each with the worst health of its stages and its two figures", () => {
  const layers = overviewLayers(snapshot(), NOW);
  assert.deepEqual(layers.map((layer) => layer.id), ["L1", "L2", "L3", "L4", "L5"]);
  assert.deepEqual(layers.map((layer) => layer.health), ["active", "waiting", "idle", "waiting", "idle"]);
  assert.deepEqual(layers[0]?.metrics, [{ label: "Lolos triase", value: 52 }, { label: "Layak diproses", value: 58 }]);
  assert.deepEqual(layers[3]?.metrics.map((metric) => metric.value), [2, 11]);
  assert.deepEqual(layers[4]?.metrics, [{ label: "Siklus terakhir", value: "50 menit lalu" }, { label: "Feed terbaca", value: "14/14" }]);
});

test("a count the snapshot does not carry is unknown, not zero; a layer with no stage is unavailable", () => {
  const sparse = snapshot({ nodes: [node("triage", "L1", "idle", {})], runtime: null });
  const layers = overviewLayers(sparse, NOW);
  assert.equal(layers[0]?.metrics[0]?.value, null);
  assert.equal(layers[1]?.health, "unavailable");
  assert.deepEqual(layers[4]?.metrics.map((metric) => metric.value), [null, null]);
});

test("the window note follows the selected range", () => {
  assert.match(overviewWindowNote(snapshot()), /dalam 24 jam terakhir/u);
  assert.match(overviewWindowNote(snapshot({ window: { range: "7d", since: "2026-11-21T10:00:00.000Z" }, window_hours: 168 })), /dalam 7 hari terakhir/u);
});

test("worst health ranks failing over waiting over active over idle", () => {
  assert.equal(worstHealth(["idle", "failing", "waiting"]), "failing");
  assert.equal(worstHealth(["idle", "active"]), "active");
  assert.equal(worstHealth([]), "unavailable");
});

test("attention lists failures first, then the review queue, each linking to the tab that can act on it", () => {
  const failing = snapshot({
    nodes: [
      ...snapshot().nodes.filter((item) => item.id !== "embed" && item.id !== "ai_queue"),
      node("embed", "L2", "failing", { available_24h: 1 }),
      node("ai_queue", "L2", "failing", { pending: 0, needs_review: 4 }),
    ],
    runtime: { ...snapshot().runtime!, cycle: { ...snapshot().runtime!.cycle, feeds_failed: 3 } },
  });
  const items = overviewAttention(failing, { canOpenSources: true });
  assert.deepEqual(items.map((item) => [item.id, item.tone, item.href]), [
    ["failing-embed", "failing", "#admin/alur"],
    ["ai-stuck", "failing", "#admin/alur"],
    ["feeds-failed", "failing", "#admin/sumber"],
    ["review-waiting", "waiting", "#admin/tinjau"],
  ]);
  assert.match(items[2]?.text ?? "", /3 dari 14 feed gagal/u);
  // A moderator cannot open Sumber, so the feed failure points at Alur agen instead.
  assert.equal(overviewAttention(failing, { canOpenSources: false })[2]?.href, "#admin/alur");
});

test("nothing waiting gives an empty list, never a safety claim", () => {
  const calm = snapshot({ nodes: snapshot().nodes.map((item) => ({ ...item, health: "idle" as const, counts: { ...item.counts, waiting_discrepancy: 0, pending_discrepancy: 0 } })) });
  assert.deepEqual(overviewAttention(calm, { canOpenSources: true }), []);
});

test("relative times read in Indonesian", () => {
  assert.equal(relativeAgo(NOW - 20_000, NOW), "Baru saja");
  assert.equal(relativeAgo(NOW - 3 * 3_600_000, NOW), "3 jam lalu");
  assert.equal(relativeAgo(NOW - 72 * 3_600_000, NOW), "3 hari lalu");
});

test("the page renders its three sections, the five layer slots and no safety wording before data arrives", () => {
  const html = renderToStaticMarkup(createElement(AdminOverview, { canOpenSources: true }));
  assert.match(html, /<h2 id="overview-title">Keadaan sistem<\/h2>/u);
  assert.match(html, /Perlu tindakan/u);
  assert.match(html, /Lima lapis/u);
  assert.match(html, /Terbit terakhir/u);
  assert.equal((html.match(/class="overview-layer__id"/gu) ?? []).length, 5);
  assert.match(html, /href="#admin\/alur"/u);
  assert.doesNotMatch(html, /\baman\b(?! )/u);
  // The old inspector pieces are gone.
  assert.doesNotMatch(html, /Contoh tampilan|Data aplikasi|admin-map/u);
});
