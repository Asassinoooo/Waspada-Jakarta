/**
 * FLOW-VIS-01 pure mapping from a `pipeline-flow-v1` snapshot to React Flow nodes and edges, plus
 * the Indonesian labels. No DOM, so it is unit-tested directly. Health is shown as a state of the
 * stage, never as a safety claim; an empty stage says "tidak ada data dalam 24 jam".
 */
import type { Edge, MarkerType, Node } from "@xyflow/react";
import type {
  PipelineFlowEdgeDto,
  PipelineFlowHealth,
  PipelineFlowItemDto,
  PipelineFlowLane,
  PipelineFlowNineRouterDto,
  PipelineFlowNodeDto,
  PipelineFlowNodeId,
  PipelineFlowSnapshotDto,
} from "@waspada/worker/pipeline-flow-contracts";
import { PIPELINE_LAYER_NAMES, type PipelineLayerId } from "./pipeline-layers.js";
import { PIPELINE_LANE_BANDS, pipelineEdgeHandles, type NodePosition, type PipelineLaneBand } from "./pipeline-flow-layout.js";

export const PIPELINE_FLOW_NODE_TYPE = "flow" as const;
export const PIPELINE_LANE_NODE_TYPE = "lane" as const;

export interface PipelineNodeMeta {
  readonly label: string;
  readonly description: string;
}

/** Indonesian stage names and what each stage may and must not do (from the layer table in CLAUDE.md). */
export const PIPELINE_NODE_META: Readonly<Record<PipelineFlowNodeId, PipelineNodeMeta>> = {
  src_petabencana: { label: "Sumber · PetaBencana", description: "Laporan banjir dan cuaca dari PetaBencana. Titik hanya dipetakan bila sumber menyediakannya." },
  src_bmkg: { label: "Sumber · BMKG", description: "Peringatan CAP BMKG. Waktu kejadian mengikuti penerbit; tidak ada waktu yang dikarang." },
  src_rss: { label: "Sumber · RSS (14 feed)", description: "Feed berita. Hak tampil tiap sumber dicek di registri; sumber tidak disetujui oleh model." },
  dedupe: { label: "Saring duplikat", description: "Judul yang mirip dalam 48 jam dan revisi yang sudah diterima siklus ini dibuang tanpa memanggil model." },
  det_filter: { label: "Saring deterministik", description: "Aturan kata kunci sebelum model. Dalam mode shadow aturan ini tidak membuang apa pun." },
  triage: { label: "Triase AI (Stage B)", description: "Model menilai relevansi Jakarta. Status ditunda oleh limit laju bukan galat model." },
  revisions: { label: "Revisi & potongan teks", description: "Teks yang diizinkan disimpan sebagai revisi dan potongan bukti. Teks tidak ditampilkan di sini." },
  ai_queue: { label: "Antrean AI", description: "Pekerjaan per revisi. Galat model dicoba ulang sampai batas, lalu perlu tinjauan." },
  interpret: { label: "Interpretasi", description: "Model menafsirkan laporan. Hasil disimpan sebagai checkpoint agar tidak diulang saat dicoba lagi." },
  embed: { label: "Embedding", description: "Vektor per potongan bukti untuk pencarian. Vektor tidak pernah ditampilkan." },
  retrieve: { label: "Pencarian bukti", description: "Mencari bukti yang terkait. Tahap ini tidak menyimpan catatan terpisah." },
  correlate: { label: "Pengaitan insiden", description: "Keputusan sama, baru, atau belum jelas. Penggabungan dibuat AI dengan kutipan dari tiap sumber." },
  proposal: { label: "Usulan peristiwa", description: "Usulan yang belum tentu benar. Usulan bukan kejadian yang terbukti." },
  gate: { label: "Gerbang publikasi otomatis", description: "Lolos semua pemeriksaan deterministik: terbit oleh agen. Selain itu usulan menunggu moderator." },
  review: { label: "Tinjauan diskrepansi", description: "Usulan dengan diskrepansi atau yang tidak lolos gerbang. Moderator yang memutuskan. Usulan yang tidak ditinjau dalam 48 jam ditandai kedaluwarsa dan tidak diterbitkan." },
  published: { label: "Terbit ke publik", description: "Versi yang sudah terbit. Halaman publik hanya membaca versi ini." },
  ninerouter: { label: "NineRouter", description: "Kuota RPM chat dan embedding, masa tunggu (cooldown), dan jumlah panggilan sejak server berjalan." },
  cycle: { label: "Siklus polling", description: "Waktu siklus terakhir, jumlah galat, dan pemakaian batas item baru per siklus." },
};

export const PIPELINE_HEALTH_LABELS: Readonly<Record<PipelineFlowHealth, string>> = {
  idle: "Tidak ada aktivitas",
  active: "Berjalan",
  waiting: "Menunggu",
  failing: "Gagal, perlu dicek",
  unavailable: "Tidak tersedia",
};

export const PIPELINE_COUNT_LABELS: Readonly<Record<string, string>> = {
  sources: "Sumber terdaftar",
  healthy: "Sehat",
  unhealthy: "Bermasalah",
  revisions_24h: "Revisi 24 jam",
  acquisition_waiting: "Tugas menunggu",
  acquisition_running: "Tugas berjalan",
  acquisition_failed_24h: "Tugas gagal 24 jam",
  title_last_cycle: "Judul mirip, siklus terakhir",
  cycle_last_cycle: "Revisi berulang, siklus terakhir",
  hits_total: "Duplikat sejak start",
  skipped_24h: "Dilewati 24 jam",
  skipped_15m: "Dilewati 15 menit",
  dropped_last_cycle: "Non-kandidat siklus terakhir",
  ingest_24h: "Diterima 24 jam",
  drop_24h: "Dibuang 24 jam",
  uncertain_24h: "Belum jelas 24 jam",
  rate_limited_24h: "Ditunda limit 24 jam",
  provider_error_24h: "Galat penyedia 24 jam",
  invalid_output_24h: "Keluaran tidak valid 24 jam",
  unreviewed_24h: "Belum ditinjau 24 jam",
  eligible_24h: "Layak 24 jam",
  quarantined_24h: "Karantina 24 jam",
  superseded_24h: "Digantikan 24 jam",
  retracted_24h: "Ditarik 24 jam",
  active_chunks: "Potongan bukti aktif",
  pending: "Menunggu",
  leased: "Berjalan",
  retry: "Ditunda, dicoba lagi",
  needs_review: "Perlu tinjauan",
  completed_24h: "Selesai 24 jam",
  terminal_24h: "Gagal permanen 24 jam",
  checkpointed_open: "Interpretasi tersimpan",
  available_24h: "Tersedia 24 jam",
  failed_24h: "Gagal 24 jam",
  invalidated_24h: "Dibatalkan 24 jam",
  searchable_24h: "Siap dicari 24 jam",
  same_incident_24h: "Digabung ke insiden 24 jam",
  new_incident_24h: "Insiden baru 24 jam",
  unresolved_24h: "Belum jelas 24 jam",
  incidents_open: "Insiden terbuka",
  proposed_24h: "Usulan 24 jam",
  pending_discrepancy: "Dengan diskrepansi",
  auto_publish_24h: "Terbit otomatis 24 jam",
  moderator_publish_24h: "Terbit oleh moderator 24 jam",
  reject_24h: "Ditolak 24 jam",
  waiting_discrepancy: "Menunggu, diskrepansi",
  waiting_gate: "Menunggu, gerbang",
  moderator_decisions_15m: "Keputusan moderator 15 menit",
  expired_24h: "Kedaluwarsa 24 jam",
  events_published: "Peristiwa terbit",
  versions_24h: "Versi 24 jam",
  agent_versions_24h: "Versi dari agen 24 jam",
  moderator_versions_24h: "Versi dari moderator 24 jam",
  calls_total: "Panggilan sejak start",
  chat_tokens_available: "Kuota chat tersisa",
  embed_tokens_available: "Kuota embedding tersisa",
  in_flight: "Sedang berjalan",
  queued: "Antre",
  cooldown_ms: "Masa tunggu (ms)",
  running: "Sedang berjalan",
  error_count: "Galat siklus",
  new_items_used: "Item baru dipakai",
  new_items_cap: "Batas item baru",
  feeds_failed: "Feed gagal",
  duration_ms: "Durasi (ms)",
};

export const PIPELINE_ITEM_STATUS_LABELS: Readonly<Record<string, string>> = {
  pending: "menunggu",
  leased: "berjalan",
  retry: "ditunda",
  needs_review: "perlu tinjauan",
  completed: "selesai",
  terminal: "gagal permanen",
  available: "tersedia",
  failed: "gagal",
  invalidated: "dibatalkan",
  unreviewed: "belum ditinjau",
  eligible: "layak",
  quarantined: "karantina",
  superseded: "digantikan",
  retracted: "ditarik",
  ingest: "diterima",
  drop: "dibuang",
  uncertain: "belum jelas",
  same_incident: "digabung ke insiden",
  new_incident: "insiden baru",
  unresolved: "belum jelas",
  menunggu: "menunggu",
  diputuskan: "diputuskan",
  diskrepansi: "diskrepansi",
  antrean_gerbang: "antrean gerbang",
  publish_agent: "terbit oleh agen",
  publish_moderator: "terbit oleh moderator",
  reject_agent: "ditolak agen",
  reject_moderator: "ditolak moderator",
  ok: "berhasil",
  error: "galat",
  duplicate: "duplikat",
  held: "ditahan",
  dropped: "dibuang",
  deferred: "ditunda",
};

export const PIPELINE_FAILURE_LABELS: Readonly<Record<string, string>> = {
  rate_limited: "limit laju, ditunda",
  model_failed: "galat model",
  model_timeout: "waktu model habis",
  invalid_output: "keluaran tidak valid",
  invalid_model_output: "keluaran model tidak valid",
  provider_error: "galat penyedia",
  db_error: "galat basis data",
  workflow_execution_failed: "galat alur kerja",
  stale_lease: "sewa kedaluwarsa",
  cycle_error: "galat siklus",
  skipped_stage_a: "dilewati aturan",
};

export function statusLabel(status: string): string {
  if (PIPELINE_ITEM_STATUS_LABELS[status]) return PIPELINE_ITEM_STATUS_LABELS[status]!;
  const version = /^versi (\d+)$/u.exec(status);
  if (version) return `versi ${version[1]}`;
  return status.replace(/_/gu, " ");
}

export function failureLabel(code: string | null): string | null {
  if (code === null) return null;
  return PIPELINE_FAILURE_LABELS[code] ?? code.replace(/_/gu, " ");
}

export function countLabel(key: string): string {
  return PIPELINE_COUNT_LABELS[key] ?? key.replace(/_/gu, " ");
}

export interface PipelineChip {
  readonly label: string;
  readonly value: number;
  readonly tone: "neutral" | "active" | "warning" | "danger";
}

/** The chips under each card: state counts only. */
const CHIP_SPECS: Partial<Record<PipelineFlowNodeId, readonly { key: string; label: string; tone: PipelineChip["tone"] }[]>> = {
  ai_queue: [
    { key: "pending", label: "menunggu", tone: "neutral" },
    { key: "leased", label: "berjalan", tone: "active" },
    { key: "retry", label: "ditunda", tone: "warning" },
    { key: "needs_review", label: "gagal", tone: "danger" },
  ],
  triage: [
    { key: "rate_limited_24h", label: "ditunda", tone: "warning" },
    { key: "provider_error_24h", label: "galat", tone: "danger" },
  ],
  embed: [
    { key: "available_24h", label: "tersedia", tone: "active" },
    { key: "failed_24h", label: "gagal", tone: "danger" },
  ],
  review: [
    { key: "waiting_discrepancy", label: "diskrepansi", tone: "warning" },
    { key: "waiting_gate", label: "gerbang", tone: "neutral" },
    { key: "expired_24h", label: "kedaluwarsa", tone: "neutral" },
  ],
  gate: [
    { key: "auto_publish_24h", label: "agen", tone: "active" },
    { key: "moderator_publish_24h", label: "moderator", tone: "neutral" },
  ],
  src_rss: [
    { key: "healthy", label: "sehat", tone: "active" },
    { key: "unhealthy", label: "bermasalah", tone: "danger" },
  ],
  src_petabencana: [
    { key: "healthy", label: "sehat", tone: "active" },
    { key: "unhealthy", label: "bermasalah", tone: "danger" },
  ],
  src_bmkg: [
    { key: "healthy", label: "sehat", tone: "active" },
    { key: "unhealthy", label: "bermasalah", tone: "danger" },
  ],
};

/** The large number on each card. */
const PRIMARY_KEY: Partial<Record<PipelineFlowNodeId, string>> = {
  src_petabencana: "revisions_24h",
  src_bmkg: "revisions_24h",
  src_rss: "revisions_24h",
  dedupe: "hits_total",
  det_filter: "skipped_24h",
  triage: "ingest_24h",
  revisions: "eligible_24h",
  ai_queue: "pending",
  interpret: "checkpointed_open",
  embed: "available_24h",
  retrieve: "searchable_24h",
  correlate: "incidents_open",
  proposal: "proposed_24h",
  gate: "auto_publish_24h",
  review: "waiting_discrepancy",
  published: "events_published",
  ninerouter: "calls_total",
  cycle: "new_items_used",
};

export interface PipelineFlowNodeView {
  readonly id: PipelineFlowNodeId;
  readonly lane: PipelineFlowLane;
  readonly label: string;
  readonly description: string;
  readonly health: PipelineFlowHealth;
  readonly healthLabel: string;
  readonly primaryValue: number | null;
  readonly primaryLabel: string;
  readonly chips: readonly PipelineChip[];
  readonly throughput15m: number;
  readonly countRows: readonly { readonly key: string; readonly label: string; readonly value: number }[];
  /** Null when the stage has counts; otherwise the Indonesian "no data in 24 h" line. */
  readonly emptyText: string | null;
  readonly runtimeUnavailable: boolean;
}

export function nodeView(node: PipelineFlowNodeDto): PipelineFlowNodeView {
  const meta = PIPELINE_NODE_META[node.id];
  const counts = node.counts;
  const countRows = Object.entries(counts).map(([key, value]) => ({ key, label: countLabel(key), value }));
  const hasCounts = countRows.some((row) => row.value !== 0);
  const primaryKey = PRIMARY_KEY[node.id];
  const primaryValue = primaryKey !== undefined && primaryKey in counts ? counts[primaryKey]! : null;
  const chips = (CHIP_SPECS[node.id] ?? [])
    .filter((spec) => spec.key in counts)
    // A warning or danger chip is coloured only when its count is above zero.
    .map((spec) => {
      const value = counts[spec.key] ?? 0;
      const tone = (spec.tone === "warning" || spec.tone === "danger") && value === 0 ? "neutral" : spec.tone;
      return { label: spec.label, value, tone };
    });
  let emptyText: string | null = null;
  if (node.health === "unavailable") {
    emptyText = "Status runtime tidak terpasang pada layanan ini.";
  } else if (!hasCounts) {
    emptyText = "Tidak ada data dalam 24 jam.";
  }
  return {
    id: node.id,
    lane: node.lane,
    label: meta.label,
    description: meta.description,
    health: node.health,
    healthLabel: PIPELINE_HEALTH_LABELS[node.health],
    primaryValue,
    primaryLabel: primaryKey !== undefined ? countLabel(primaryKey) : "",
    chips,
    throughput15m: node.throughput_15m,
    countRows,
    emptyText,
    runtimeUnavailable: node.health === "unavailable",
  };
}

export interface PipelineLaneNodeData extends Record<string, unknown> {
  readonly lane: PipelineLayerId;
  readonly title: string;
}

export interface PipelineFlowCardData extends Record<string, unknown> {
  readonly view: PipelineFlowNodeView;
  /** Only the NineRouter card reads the meters; every other card leaves this null. */
  readonly nineRouter: PipelineFlowNineRouterDto | null;
  readonly nineRouterGeneratedAt: string | null;
}

export interface PipelineFlowGraph {
  readonly nodes: Node[];
  readonly edges: Edge[];
}

/**
 * Snapshot to React Flow graph. Lane bands come first as non-interactive nodes. Each stage card
 * carries its view, and each edge animates when its downstream stage moved items in 15 minutes.
 */
export function toPipelineFlowGraph(
  snapshot: PipelineFlowSnapshotDto,
  positions: Readonly<Record<PipelineFlowNodeId, NodePosition>>,
): PipelineFlowGraph {
  const laneNodes: Node[] = PIPELINE_LANE_BANDS.map((band: PipelineLaneBand, index: number) => ({
    id: band.titled ? `lane-${band.lane}` : `lane-${band.lane}-${index}`,
    type: PIPELINE_LANE_NODE_TYPE,
    position: { x: band.x, y: band.y },
    data: { lane: band.lane, title: band.titled ? `${band.lane} · ${PIPELINE_LAYER_NAMES[band.lane]}` : "" } satisfies PipelineLaneNodeData,
    style: { width: band.width, height: band.height },
    selectable: false,
    draggable: false,
    focusable: false,
    zIndex: -1,
  }));
  const cardNodes: Node[] = snapshot.nodes.map((node) => ({
    id: node.id,
    type: PIPELINE_FLOW_NODE_TYPE,
    position: { x: positions[node.id].x, y: positions[node.id].y },
    data: {
      view: nodeView(node),
      nineRouter: node.id === "ninerouter" ? snapshot.runtime?.ninerouter ?? null : null,
      nineRouterGeneratedAt: node.id === "ninerouter" ? snapshot.runtime?.generated_at ?? null : null,
    } satisfies PipelineFlowCardData,
    draggable: false,
    selectable: true,
  }));
  const edges: Edge[] = snapshot.edges.map((edge: PipelineFlowEdgeDto) => edgeFor(edge));
  return { nodes: [...laneNodes, ...cardNodes], edges };
}

function edgeFor(edge: PipelineFlowEdgeDto): Edge {
  const handles = pipelineEdgeHandles(edge.from, edge.to);
  return {
    id: `${edge.from}->${edge.to}`,
    source: edge.from,
    target: edge.to,
    sourceHandle: `source-${handles.source}`,
    targetHandle: `target-${handles.target}`,
    // The rows alternate direction, so arrowheads keep the reading order clear.
    markerEnd: { type: "arrowclosed" as MarkerType, width: 16, height: 16 },
    type: "smoothstep",
    animated: edge.throughput_15m > 0,
    className: edge.throughput_15m > 0 ? "pipeline-edge pipeline-edge--active" : "pipeline-edge",
    data: { throughput_15m: edge.throughput_15m },
  };
}

/** Rows shown for a stored item in the drill-down list. Titles are moderator-only and only from the DTO. */
export function itemRows(items: readonly PipelineFlowItemDto[]) {
  return items.map((item) => ({
    ref: item.ref,
    status: statusLabel(item.status),
    failure: failureLabel(item.failure_code),
    title: item.title,
    at: item.at,
  }));
}

/** Relative time in Indonesian. Null input stays unknown; it is never guessed. */
export function relativeTimeLabel(at: string | null, nowMs: number): string {
  if (at === null) return "waktu tidak tersedia";
  const parsed = Date.parse(at);
  if (!Number.isFinite(parsed)) return "waktu tidak tersedia";
  const minutes = Math.round((nowMs - parsed) / 60_000);
  if (minutes < 1) return "baru saja";
  if (minutes < 60) return `${minutes} menit lalu`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} jam lalu`;
  return `${Math.round(hours / 24)} hari lalu`;
}

/** Remaining cooldown as m:ss, from milliseconds. */
export function cooldownLabel(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "tidak ada masa tunggu";
  const total = Math.ceil(ms / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

/** Drill-down nodes that link to the moderator review page. */
export const PIPELINE_REVIEW_LINK_NODES: ReadonlySet<PipelineFlowNodeId> = new Set<PipelineFlowNodeId>([
  "proposal",
  "gate",
  "review",
  "published",
]);
