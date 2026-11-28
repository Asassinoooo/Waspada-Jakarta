/*
 * ADMIN-BRIEF-01: the admin overview ("Ringkasan") reads the same pipeline-flow-v1 snapshot as Alur agen and folds it
 * into the five layers. Pure functions only, so the folding rules are covered by node:test.
 *
 * Every number here describes the work of the pipeline, never conditions in Jakarta: an empty attention list means no
 * work is waiting, not that an area is safe. A count the snapshot does not carry is unknown (null), never zero.
 */
import type {
  PipelineFlowHealth,
  PipelineFlowNodeDto,
  PipelineFlowNodeId,
  PipelineFlowSnapshotDto,
} from "@waspada/worker/pipeline-flow-contracts";
import { PIPELINE_NODE_META, PIPELINE_RANGE_LABELS, snapshotRange } from "./pipeline-flow-model.js";

/** One line under "Lima lapis" that names the window instead of repeating it on every figure. */
export function overviewWindowNote(snapshot: PipelineFlowSnapshotDto): string {
  return `Lolos triase, layak diproses, potongan, usulan, dan versi terbit dihitung dalam ${PIPELINE_RANGE_LABELS[snapshotRange(snapshot)]} terakhir; angka lain adalah keadaan saat ini.`;
}
import { PIPELINE_LAYER_IDS, PIPELINE_LAYER_NAMES, type PipelineLayerId } from "./pipeline-layers.js";
import { adminTabHash, type AdminTab } from "./admin-workspace-model.js";

export interface OverviewMetric {
  readonly label: string;
  /** null = the snapshot does not report it (shown as a dash, never as 0). */
  readonly value: number | string | null;
}

export interface OverviewLayer {
  readonly id: PipelineLayerId;
  readonly name: string;
  readonly health: PipelineFlowHealth;
  readonly stageCount: number;
  readonly failingStages: readonly string[];
  readonly metrics: readonly OverviewMetric[];
  /** One sentence on what the layer owns, from the layer table. */
  readonly role: string;
}

export interface OverviewAttention {
  readonly id: string;
  readonly tone: "failing" | "waiting";
  readonly text: string;
  readonly tab: AdminTab;
  readonly href: string;
  readonly action: string;
}

const LAYER_ROLES: Readonly<Record<PipelineLayerId, string>> = {
  L1: "Mengambil laporan dari sumber yang disetujui, membuang duplikat, dan menyaring yang relevan.",
  L2: "Menafsirkan laporan dan mencari bukti pendukung sebelum ada usulan.",
  L3: "Mengaitkan laporan menjadi insiden dan menyusun usulan peristiwa.",
  L4: "Gerbang publikasi: usulan tanpa selisih terbit otomatis, yang lain menunggu moderator.",
  L5: "Siklus pengambilan dan batas pemakaian model.",
};

/** The two figures each layer card shows: [node, count key, label]. Keys ending in _24h count over the selected window
 * (named once under the section heading, see overviewWindowNote); the others are the state now. */
const LAYER_METRICS: Readonly<Record<PipelineLayerId, ReadonlyArray<readonly [PipelineFlowNodeId, string, string]>>> = {
  L1: [["triage", "ingest_24h", "Lolos triase"], ["revisions", "eligible_24h", "Layak diproses"]],
  L2: [["ai_queue", "pending", "Antre AI"], ["embed", "available_24h", "Potongan siap dicari"]],
  L3: [["correlate", "incidents_open", "Insiden terbuka"], ["proposal", "proposed_24h", "Usulan dibuat"]],
  L4: [["review", "waiting_discrepancy", "Menunggu moderator"], ["published", "versions_24h", "Versi terbit"]],
  L5: [],
};

/** Worst first: one failing stage makes the layer failing. A layer with no reporting stage is unavailable. */
const HEALTH_RANK: Readonly<Record<PipelineFlowHealth, number>> = { failing: 4, waiting: 3, active: 2, idle: 1, unavailable: 0 };

export function worstHealth(values: readonly PipelineFlowHealth[]): PipelineFlowHealth {
  let worst: PipelineFlowHealth = "unavailable";
  for (const value of values) if (HEALTH_RANK[value] > HEALTH_RANK[worst]) worst = value;
  return worst;
}

function nodeById(snapshot: PipelineFlowSnapshotDto, id: PipelineFlowNodeId): PipelineFlowNodeDto | undefined {
  return snapshot.nodes.find((node) => node.id === id);
}

function count(snapshot: PipelineFlowSnapshotDto, id: PipelineFlowNodeId, key: string): number | null {
  const value = nodeById(snapshot, id)?.counts[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function cycleMetrics(snapshot: PipelineFlowSnapshotDto, nowMs: number): OverviewMetric[] {
  const cycle = snapshot.runtime?.cycle ?? null;
  const finished = cycle?.finished_at ? Date.parse(cycle.finished_at) : Number.NaN;
  const last = cycle?.running
    ? "Sedang berjalan"
    : Number.isFinite(finished) ? relativeAgo(finished, nowMs) : null;
  const feeds = cycle && cycle.feeds_total !== null && cycle.feeds_failed !== null
    ? `${cycle.feeds_total - cycle.feeds_failed}/${cycle.feeds_total}`
    : null;
  return [
    { label: "Siklus terakhir", value: last },
    { label: "Feed terbaca", value: feeds },
  ];
}

export function relativeAgo(atMs: number, nowMs: number): string {
  const minutes = Math.max(0, Math.round((nowMs - atMs) / 60_000));
  if (minutes < 1) return "Baru saja";
  if (minutes < 60) return `${minutes} menit lalu`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} jam lalu`;
  return `${Math.round(hours / 24)} hari lalu`;
}

export function overviewLayers(snapshot: PipelineFlowSnapshotDto, nowMs: number): OverviewLayer[] {
  return PIPELINE_LAYER_IDS.map((id) => {
    const nodes = snapshot.nodes.filter((node) => node.lane === id);
    const metrics = id === "L5"
      ? cycleMetrics(snapshot, nowMs)
      : LAYER_METRICS[id].map(([node, key, label]) => ({ label, value: count(snapshot, node, key) }));
    return {
      id,
      name: PIPELINE_LAYER_NAMES[id],
      health: worstHealth(nodes.map((node) => node.health)),
      stageCount: nodes.length,
      failingStages: nodes.filter((node) => node.health === "failing").map((node) => PIPELINE_NODE_META[node.id].label),
      metrics,
      role: LAYER_ROLES[id],
    };
  });
}

function attention(id: string, tone: OverviewAttention["tone"], text: string, tab: AdminTab, action: string): OverviewAttention {
  return { id, tone, text, tab, href: adminTabHash(tab), action };
}

/**
 * What a person can act on now, most urgent first. Moderators get the review queue; failures point at Alur agen;
 * feed failures point at Sumber only for people who can open it.
 */
export function overviewAttention(snapshot: PipelineFlowSnapshotDto, options: { canOpenSources: boolean }): OverviewAttention[] {
  const items: OverviewAttention[] = [];
  const failing = snapshot.nodes.filter((node) => node.health === "failing");
  for (const node of failing) {
    if (node.id === "ai_queue") continue; // reported below with its own count
    items.push(attention(`failing-${node.id}`, "failing", `${PIPELINE_NODE_META[node.id].label}: gagal, perlu dicek.`, "alur", "Lihat tahap"));
  }
  const stuck = count(snapshot, "ai_queue", "needs_review") ?? 0;
  if (stuck > 0) items.push(attention("ai-stuck", "failing", `${stuck} pekerjaan AI berhenti dan perlu dicek.`, "alur", "Lihat antrean"));
  const cycle = snapshot.runtime?.cycle ?? null;
  if (cycle && cycle.feeds_failed !== null && cycle.feeds_total !== null && cycle.feeds_failed > 0) {
    const text = `${cycle.feeds_failed} dari ${cycle.feeds_total} feed gagal dibaca pada siklus terakhir.`;
    items.push(options.canOpenSources
      ? attention("feeds-failed", "failing", text, "sumber", "Lihat sumber")
      : attention("feeds-failed", "failing", text, "alur", "Lihat tahap"));
  }
  const waiting = count(snapshot, "review", "waiting_discrepancy") ?? count(snapshot, "proposal", "pending_discrepancy") ?? 0;
  if (waiting > 0) items.push(attention("review-waiting", "waiting", `${waiting} usulan menunggu keputusan moderator.`, "tinjau", "Tinjau bukti"));
  return items;
}
