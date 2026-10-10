import type {
  AdminActivity,
  AdminBudget,
  AdminItem,
  AdminLayer,
  AdminLayerSummary,
  AdminSnapshot,
  AdminSource,
  AdminStep,
} from "./admin-types.js";
import type { PublicGeoJSONGeometry } from "@waspada/worker/public-contracts";

export interface SimulationStep {
  index: number;
  label: string;
  description: string;
  durationMs: number;
}

const authoredSteps: SimulationStep[] = [
  { index: 0, label: "Mulai skenario fiktif", description: "Kasus dan waktu bersifat ilustratif; tidak ada sumber yang dihubungi.", durationMs: 3_000 },
  { index: 1, label: "L1 menerima laporan contoh", description: "Sebuah laporan rekaan masuk ke antrean persiapan lokal.", durationMs: 3_000 },
  { index: 2, label: "L1 mengarantina bentuk yang gagal", description: "Parser menahan geometri rekaan yang bentuknya tidak sah.", durationMs: 3_000 },
  { index: 3, label: "L2 menemukan bukti yang berbeda", description: "Dua kutipan fiktif belum mendukung kesimpulan yang sama.", durationMs: 3_000 },
  { index: 4, label: "L3 menjalankan pemeriksaan terbatas", description: "Pemeriksaan memakai anggaran lokal yang dibatasi.", durationMs: 3_000 },
  { index: 5, label: "L3 berhenti pada batas anggaran", description: "Tidak ada pemeriksaan lanjutan setelah batas tercapai.", durationMs: 3_000 },
  { index: 6, label: "L4 menahan usulan untuk moderator", description: "Persetujuan tetap menjadi keputusan manusia.", durationMs: 3_000 },
  { index: 7, label: "L4 menyelesaikan contoh publikasi", description: "Satu contoh fiktif melewati gerbang lokal dan tetap berlabel sintetis.", durationMs: 3_000 },
  { index: 8, label: "L5 mencatat sumber contoh tidak tersedia", description: "Sinyal lintas lapisan menunjukkan kegagalan sumber simulasi.", durationMs: 3_000 },
  { index: 9, label: "Skenario selesai", description: "Urutan berakhir; tidak ada pengulangan otomatis.", durationMs: 3_000 },
];

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  }
  return value;
}

/** The finite, zero-based sequence consumed by the local simulator. */
export const SIMULATION_STEPS: readonly SimulationStep[] = deepFreeze(authoredSteps);

const BASE_AT = Date.UTC(2026, 9, 10, 3, 0, 0);
const SIMULATION_SOURCE_NAMES = [
  "Kanal Warga Contoh (fiktif)",
  "Papan Layanan Imajiner",
  "Catatan Lapangan Rekaan",
  "Feed Simulasi Jakarta (fiktif)",
] as const;

function atMinute(minute: number): string {
  return new Date(BASE_AT + minute * 60_000).toISOString();
}

function budget(overrides: Partial<AdminBudget> = {}): AdminBudget {
  return {
    toolsUsed: 0,
    toolsLimit: 3,
    reasoningUsed: 0,
    reasoningLimit: 2,
    tokensUsed: 0,
    tokensLimit: 12_000,
    activeSecondsUsed: 0,
    activeSecondsLimit: 120,
    ...overrides,
  };
}

const pointA: PublicGeoJSONGeometry = {
  type: "Point",
  coordinates: [106.8271, -6.1968],
};
const pointB: PublicGeoJSONGeometry = {
  type: "Point",
  coordinates: [106.8456, -6.2146],
};
const lineExample: PublicGeoJSONGeometry = {
  type: "LineString",
  coordinates: [[106.8271, -6.1968], [106.8313, -6.2012], [106.8365, -6.2041]],
};
const polygonExample: PublicGeoJSONGeometry = {
  type: "Polygon",
  coordinates: [[
    [106.8410, -6.2110],
    [106.8460, -6.2110],
    [106.8460, -6.2160],
    [106.8410, -6.2160],
    [106.8410, -6.2110],
  ]],
};

function item(
  input: Omit<AdminItem, "datasetKind" | "geometryNote" | "steps"> & {
    geometryNote?: string;
    steps?: AdminStep[];
  },
): AdminItem {
  return {
    datasetKind: "synthetic",
    geometryNote: input.geometryNote ?? (input.geometry
      ? "Koordinat ilustratif fiktif; bukan batas resmi atau penilaian bahaya."
      : "Tidak dipetakan. Lokasi rekaan belum memiliki koordinat contoh."),
    steps: input.steps ?? [],
    ...input,
  };
}

function createItems(step: number): AdminItem[] {
  const items: AdminItem[] = [
    item({
      id: "sim-flood-report",
      title: "Contoh genangan dekat Simpang Ilustrasi",
      summary: "Laporan rekaan menyebut genangan singkat; penyebab dan dampak belum dipastikan.",
      category: "disasters_weather",
      layer: step >= 3 ? "L2" : "L1",
      state: step >= 3 ? "running" : "done",
      operationalPriority: "attention",
      placeLabel: "Simpang Ilustrasi, Jakarta Pusat (rekaan)",
      geometry: pointA,
      geometryBasis: "synthetic_example",
      sourceNames: [SIMULATION_SOURCE_NAMES[0]],
      eventVersion: null,
      publicEventId: null,
      observedAt: atMinute(1),
      fetchedAt: atMinute(2),
      publishedAt: null,
      evidenceSummary: "Satu laporan simulasi; dukungan dan cakupan waktu belum lengkap.",
      stopReason: null,
      nextStep: "Periksa kecocokan waktu dan bukti sebelum menyimpulkan.",
      budget: null,
      steps: [
        { layer: "L1", state: "done", label: "Laporan contoh diterima", detail: "Sumber rekaan diproses lokal.", at: atMinute(1) },
        { layer: "L2", state: step >= 3 ? "running" : "queued", label: "Pencocokan bukti", detail: "Menunggu pemeriksaan terhadap konteks yang tersedia.", at: step >= 3 ? atMinute(4) : null },
      ],
    }),
    item({
      id: "sim-parse-quarantine",
      title: "Geometri contoh dikarantina saat parse",
      summary: "Bentuk koordinat pada masukan fiktif tidak memenuhi aturan GeoJSON.",
      category: "transport_road_incidents",
      layer: "L1",
      state: step >= 2 ? "held" : "queued",
      operationalPriority: step >= 2 ? "blocked" : "normal",
      placeLabel: "Lokasi tidak dipetakan — pemeriksaan tertahan",
      geometry: null,
      geometryBasis: "none",
      geometryNote: "Parser simulasi menahan koordinat yang rusak; tidak dibuat titik pengganti.",
      sourceNames: [SIMULATION_SOURCE_NAMES[2]],
      eventVersion: null,
      publicEventId: null,
      observedAt: atMinute(3),
      fetchedAt: atMinute(3),
      publishedAt: null,
      evidenceSummary: "Koordinat tidak dapat dipakai; tidak ada lokasi yang disimpulkan.",
      stopReason: step >= 2 ? "Geometri contoh ditolak parser karena struktur tidak valid." : null,
      nextStep: "Perbaiki input contoh atau biarkan tetap di luar peta.",
      budget: null,
      steps: [
        { layer: "L1", state: step >= 2 ? "held" : "queued", label: "Validasi geometri", detail: "Masukan fiktif belum lolos validasi.", at: step >= 2 ? atMinute(3) : null },
      ],
    }),
    item({
      id: "sim-l2-conflict",
      title: "Dua catatan fiktif berbeda soal waktu",
      summary: "Catatan rekaan menyebut waktu mulai yang berbeda; sistem tidak memilih salah satunya.",
      category: "demonstrations_public_gatherings",
      layer: "L2",
      state: step >= 3 ? "held" : "queued",
      operationalPriority: step >= 3 ? "attention" : "normal",
      placeLabel: "Taman Contoh, Jakarta Selatan (rekaan)",
      geometry: lineExample,
      geometryBasis: "synthetic_example",
      sourceNames: [SIMULATION_SOURCE_NAMES[0], SIMULATION_SOURCE_NAMES[2]],
      eventVersion: null,
      publicEventId: null,
      observedAt: atMinute(4),
      fetchedAt: atMinute(4),
      publishedAt: null,
      evidenceSummary: "Satu catatan menyebut pukul 10.00; satu lagi 10.30 (semua waktu fiktif).",
      stopReason: step >= 3 ? "Konflik bukti belum terselesaikan; usulan tidak diteruskan ke publikasi." : null,
      nextStep: "Minta peninjauan bukti tambahan yang dapat dipertanggungjawabkan.",
      budget: null,
      steps: [
        { layer: "L1", state: "done", label: "Dua catatan simulasi disiapkan", detail: "Kedua sumber sepenuhnya fiktif.", at: atMinute(4) },
        { layer: "L2", state: step >= 3 ? "held" : "queued", label: "Konflik waktu ditemukan", detail: "Perbedaan tidak digabung menjadi satu fakta.", at: step >= 3 ? atMinute(5) : null },
      ],
    }),
    item({
      id: "sim-l3-budget",
      title: "Pemeriksaan lanjutan berhenti pada batas",
      summary: "Contoh kasus belum terselesaikan dan diteruskan sebagai kebutuhan tinjauan.",
      category: "fires_infrastructure_hazards",
      layer: "L3",
      state: step >= 5 ? "failed" : step >= 4 ? "running" : "queued",
      operationalPriority: step >= 5 ? "blocked" : "attention",
      placeLabel: "Koridor Rekaan, Jakarta Timur (rekaan)",
      geometry: pointB,
      geometryBasis: "synthetic_example",
      sourceNames: [SIMULATION_SOURCE_NAMES[1]],
      eventVersion: null,
      publicEventId: null,
      observedAt: atMinute(6),
      fetchedAt: atMinute(6),
      publishedAt: null,
      evidenceSummary: "Belum ada dukungan cukup untuk menetapkan jenis atau luasan kejadian.",
      stopReason: step >= 5 ? "Berhenti: batas anggaran 3 alat / 2 giliran reasoning tercapai." : null,
      nextStep: step >= 5 ? "Tinjauan manusia diperlukan; simulator tidak mencoba lagi." : "Gunakan paling banyak satu pemeriksaan berikutnya dalam batas yang ditetapkan.",
      budget: budget({
        toolsUsed: step >= 5 ? 3 : step >= 4 ? 1 : 0,
        reasoningUsed: step >= 5 ? 2 : step >= 4 ? 1 : 0,
        tokensUsed: step >= 5 ? 12_000 : step >= 4 ? 5_100 : 0,
        activeSecondsUsed: step >= 5 ? 120 : step >= 4 ? 42 : 0,
      }),
      steps: [
        { layer: "L1", state: "done", label: "Konteks contoh disiapkan", detail: "Data sumber ini rekaan.", at: atMinute(6) },
        { layer: "L2", state: "done", label: "Konteks masih belum cukup", detail: "Alasan investigasi ditampilkan; tidak ada fakta baru yang dibuat.", at: atMinute(7) },
        { layer: "L3", state: step >= 5 ? "failed" : step >= 4 ? "running" : "queued", label: step >= 5 ? "Batas anggaran tercapai" : "Pemeriksaan terbatas", detail: step >= 5 ? "Tidak ada pemanggilan lanjutan setelah batas." : "Pemakaian dan batas hanya simulasi.", at: step >= 4 ? atMinute(8) : null },
      ],
    }),
    item({
      id: "sim-moderator-hold",
      title: "Usulan contoh menunggu moderator",
      summary: "Pemeriksaan otomatis tidak menerbitkan kandidat; persetujuan manusia masih diperlukan.",
      category: "utilities_essential_services",
      layer: "L4",
      state: step >= 6 ? "held" : "queued",
      operationalPriority: step >= 6 ? "attention" : "normal",
      placeLabel: "Fasilitas Contoh, Jakarta Barat (rekaan)",
      geometry: null,
      geometryBasis: "none",
      geometryNote: "Lokasi detail tidak disediakan dalam contoh; tidak ada geometri yang ditebak.",
      sourceNames: [SIMULATION_SOURCE_NAMES[1]],
      eventVersion: null,
      publicEventId: null,
      observedAt: atMinute(9),
      fetchedAt: atMinute(9),
      publishedAt: null,
      evidenceSummary: "Tidak ada contoh sumber yang memenuhi semua pemeriksaan publikasi.",
      stopReason: step >= 6 ? "Gerbang publikasi menunggu tinjauan dan keputusan moderator." : null,
      nextStep: "Moderator menilai bukti dan alasan; tidak ada tindakan tulis dalam demo.",
      budget: null,
      steps: [
        { layer: "L2", state: "done", label: "Usulan sintetis disusun", detail: "Belum menjadi informasi terbit.", at: atMinute(9) },
        { layer: "L4", state: step >= 6 ? "held" : "queued", label: "Gerbang manusia", detail: "Persetujuan adalah langkah terpisah.", at: step >= 6 ? atMinute(10) : null },
      ],
    }),
    item({
      id: "sim-published-example",
      title: "Contoh rute lokal selesai ditinjau",
      summary: "Pemberitahuan rute rekaan disetujui di dalam skenario lokal ini saja.",
      category: "transport_road_incidents",
      layer: "L4",
      state: step >= 7 ? "done" : "held",
      operationalPriority: "normal",
      placeLabel: "Jalur Demonstrasi, Jakarta Pusat (rekaan)",
      geometry: lineExample,
      additionalGeometries: [polygonExample],
      geometryBasis: "synthetic_example",
      sourceNames: [SIMULATION_SOURCE_NAMES[3]],
      eventVersion: step >= 7 ? 2 : null,
      publicEventId: step >= 7 ? "simulated-public-event-route-02" : null,
      observedAt: atMinute(11),
      fetchedAt: atMinute(11),
      publishedAt: step >= 7 ? atMinute(12) : null,
      evidenceSummary: "Seluruh teks, sumber, waktu, dan publikasi yang ditampilkan dibuat untuk simulator.",
      stopReason: step >= 7 ? null : "Menunggu keputusan moderator pada contoh lokal.",
      nextStep: step >= 7 ? "Contoh selesai; simulator tidak mengirim atau mengubah data publik." : "Selesaikan review manusia pada langkah simulasi berikutnya.",
      budget: null,
      steps: [
        { layer: "L1", state: "done", label: "Fixture rekaan disiapkan", detail: "Tidak ada provider atau jaringan yang dipakai.", at: atMinute(11) },
        { layer: "L2", state: "done", label: "Ringkasan contoh dirapikan", detail: "Konten hanya untuk demonstrasi.", at: atMinute(11) },
        { layer: "L4", state: step >= 7 ? "done" : "held", label: step >= 7 ? "Review contoh selesai" : "Menunggu moderator", detail: step >= 7 ? "Terbit hanya dalam simulasi lokal." : "Belum terbit; tidak ada kandidat dipresentasikan sebagai data publik.", at: step >= 7 ? atMinute(12) : null },
      ],
    }),
    item({
      id: "sim-unmapped-notice",
      title: "Pemberitahuan kelompok tanpa lokasi",
      summary: "Contoh pemberitahuan umum tidak memiliki lokasi dan tetap tersedia sebagai item daftar.",
      category: "group_specific_critical_notices",
      layer: "L2",
      state: "done",
      operationalPriority: "normal",
      placeLabel: "Tidak berlaku — pemberitahuan tanpa lokasi",
      geometry: null,
      geometryBasis: "none",
      geometryNote: "Kasus fiktif ini sengaja tidak memiliki lokasi; tetap dapat diperiksa dari daftar.",
      sourceNames: [SIMULATION_SOURCE_NAMES[2]],
      eventVersion: null,
      publicEventId: null,
      observedAt: atMinute(13),
      fetchedAt: atMinute(13),
      publishedAt: null,
      evidenceSummary: "Kategori dan sumber adalah rekaan. Tidak ada lokasi yang disimpulkan.",
      stopReason: null,
      nextStep: "Baca ringkasan dan batas bukti pada inspector.",
      budget: null,
      steps: [
        { layer: "L1", state: "done", label: "Contoh non-geografis", detail: "Lokasi kosong adalah keadaan yang sah.", at: atMinute(13) },
        { layer: "L2", state: "done", label: "Konteks terbatas", detail: "Tidak ada pencocokan lokasi.", at: atMinute(14) },
      ],
    }),
    ...(step >= 8 ? [item({
      id: "sim-source-unavailable",
      title: "Sumber contoh tidak menjawab",
      summary: "Permintaan tiruan gagal dalam skenario; kegagalan tidak berarti kondisi aman.",
      category: "health_environmental_advisories",
      layer: "L1",
      state: "failed",
      operationalPriority: "blocked",
      placeLabel: "Tidak dipetakan — respons sumber tidak tersedia",
      geometry: null,
      geometryBasis: "none",
      geometryNote: "Tidak ada geometri karena sumber contoh tidak menjawab.",
      sourceNames: ["Feed Simulasi Jakarta (fiktif)"],
      eventVersion: null,
      publicEventId: null,
      observedAt: null,
      fetchedAt: atMinute(15),
      publishedAt: null,
      evidenceSummary: "Sumber contoh tidak tersedia; isi dan cakupan tidak diketahui.",
      stopReason: "Sumber simulasi gagal menjawab; statusnya tidak diubah menjadi sehat atau kosong.",
      nextStep: "Tampilkan status gagal dan waktu pemeriksaan contoh.",
      budget: null,
      steps: [
        { layer: "L1", state: "failed", label: "Permintaan simulasi gagal", detail: "Respons ini bukan pemantauan provider nyata.", at: atMinute(15) },
      ],
    })] : []),
  ];

  return items;
}

function createLayerSummaries(items: readonly AdminItem[], step: number): AdminLayerSummary[] {
  const definitions: Array<{ layer: AdminLayer; name: string; description: string }> = [
    { layer: "L1", name: "L1 · Persiapan", description: "Penerimaan dan validasi fixture fiktif." },
    { layer: "L2", name: "L2 · Pengaitan bukti", description: "Konteks dan konflik dalam skenario lokal." },
    { layer: "L3", name: "L3 · Pemeriksaan terbatas", description: "Langkah bersyarat dengan batas alat, reasoning, token, dan waktu." },
    { layer: "L4", name: "L4 · Review dan publikasi", description: "Gerbang deterministik dengan keputusan moderator pada contoh." },
    { layer: "L5", name: "L5 · Pengamatan lintas lapisan", description: "Peristiwa simulasi untuk kegagalan atau batas yang dicapai." },
  ];
  return definitions.map(({ layer, name, description }) => {
    const relevant = items.filter((entry) => entry.layer === layer);
    const attention = relevant.some((entry) => entry.state === "held" || entry.state === "failed");
    const unavailable = layer === "L5" && step < 8;
    return {
      layer,
      name,
      description,
      availability: "simulated",
      count: layer === "L5" ? (step >= 8 ? 1 : 0) : relevant.length,
      state: unavailable ? "unavailable" : attention ? "attention" : "ready",
      note: layer === "L5"
        ? step >= 8 ? "Fiksi: satu sinyal lintas lapisan dipicu oleh sumber contoh yang tidak tersedia." : "Belum ada sinyal L5 pada langkah ini."
        : "Angka dan status berasal dari fixture lokal; bukan telemetry runtime.",
    };
  });
}

function createSources(step: number): AdminSource[] {
  return SIMULATION_SOURCE_NAMES.map((name, index) => ({
    id: "fictional-source-" + String(index + 1),
    name,
    health: step >= 8 && index === 3 ? "unavailable" : "healthy",
    lastSuccessAt: step >= 8 && index === 3 ? atMinute(14) : atMinute(12),
    note: "Sumber fiktif simulator; tidak ada provider yang dihubungi.",
  }));
}

function createActivities(items: readonly AdminItem[], step: number): AdminActivity[] {
  const activities: AdminActivity[] = items.flatMap((entry) => entry.steps
    .filter((event) => event.at !== null)
    .map((event, index) => ({
      id: entry.id + "-step-" + String(index),
      itemId: entry.id,
      layer: event.layer,
      at: event.at as string,
      state: event.state,
      label: event.label,
      detail: event.detail,
    })));
  if (step >= 8) {
    activities.push({
      id: "sim-l5-source-failure",
      itemId: "sim-source-unavailable",
      layer: "L5",
      at: atMinute(16),
      state: "failed",
      label: "Sinyal lintas lapisan: sumber contoh tidak tersedia",
      detail: "Peristiwa lokal; bukan telemetry atau insiden publik.",
    });
  }
  return activities.sort((left, right) => right.at.localeCompare(left.at)).slice(0, 12);
}

/**
 * Build an immutable snapshot at a zero-based simulator position.
 * There is no network, timer, provider, write, or persistent state in this function.
 */
export function createSimulationSnapshot(step: number): AdminSnapshot {
  if (!Number.isInteger(step) || step < 0 || step >= SIMULATION_STEPS.length) {
    throw new RangeError("Simulation step is outside the finite script.");
  }

  const items = createItems(step);
  const snapshot: AdminSnapshot = {
    mode: "simulation",
    capturedAt: atMinute(step),
    context: null,
    datasetMode: "demo",
    items,
    layers: createLayerSummaries(items, step),
    sources: createSources(step),
    activities: createActivities(items, step),
    probes: [],
    limitations: [
      "SIMULASI FIKTIF: semua kasus, sumber, koordinat, waktu, anggaran, dan jumlah dibuat untuk demonstrasi.",
      "Fixture tidak menghubungi provider, menjalankan model, mengubah data demo, menulis, atau menerbitkan ke publik.",
      "Geometri hanya contoh sintetis; bukan batas resmi, lokasi terverifikasi, atau zona bahaya.",
      "Status operasional dan prioritas bukan penilaian bahaya bagi masyarakat.",
      "Semua pengukuran internal pada snapshot ini berasal dari skrip lokal, bukan runtime.",
    ],
    hasMoreEvents: false,
  };
  return deepFreeze(snapshot);
}
