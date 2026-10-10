import { useEffect, useMemo, useRef, useState } from "react";
import { AdminOperationsMap } from "./AdminOperationsMap.js";
import { createSimulationSnapshot, SIMULATION_STEPS } from "./admin-fixtures.js";
import { createAdminMonitor } from "./admin-monitoring.js";
import {
  categoryLabel,
  formatEventTime,
  formatInstant,
  freshnessLabel,
  lifecycleLabel,
} from "./display.js";
import type {
  AdminItem,
  AdminItemState,
  AdminLayer,
  AdminLayerSummary,
  AdminMode,
  AdminMonitorState,
  AdminProbe,
  AdminSnapshot,
} from "./admin-types.js";

const LAYERS: readonly AdminLayer[] = ["L1", "L2", "L3", "L4", "L5"];
const LAYER_NAMES: Record<AdminLayer, string> = {
  L1: "Penerimaan dan persiapan",
  L2: "Pencarian dan grounding",
  L3: "Investigasi terbatas",
  L4: "Review dan publikasi",
  L5: "Observabilitas lintas lapisan",
};
const STATUS_OPTIONS: readonly { value: AdminItemState | "all"; label: string }[] = [
  { value: "all", label: "Semua status" },
  { value: "queued", label: "Dalam antrean" },
  { value: "running", label: "Berjalan" },
  { value: "held", label: "Ditahan" },
  { value: "failed", label: "Gagal" },
  { value: "done", label: "Selesai" },
];
const LAYER_OPTIONS: readonly { value: AdminLayer | "all"; label: string }[] = [
  { value: "all", label: "Semua lapisan" },
  ...LAYERS.map((layer) => ({ value: layer, label: `${layer} · ${LAYER_NAMES[layer]}` })),
];

export interface AdminItemFilters {
  query: string;
  layer: AdminLayer | "all";
  state: AdminItemState | "all";
  geometry: "all" | "mapped" | "unmapped";
}

function normalizedSearch(value: string) {
  return value.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLocaleLowerCase("id-ID");
}

export function filterAdminItems(items: readonly AdminItem[], filters: AdminItemFilters): AdminItem[] {
  const query = normalizedSearch(filters.query.trim());
  return items.filter((item) => {
    if (filters.layer !== "all" && item.layer !== filters.layer) return false;
    if (filters.state !== "all" && item.state !== filters.state) return false;
    if (filters.geometry === "mapped" && !hasAdminGeometry(item)) return false;
    if (filters.geometry === "unmapped" && hasAdminGeometry(item)) return false;
    if (!query) return true;
    const searchable = normalizedSearch([
      item.title,
      item.summary,
      item.placeLabel,
      item.evidenceSummary,
      item.sourceNames.join(" "),
      item.id,
      item.publicEventId ?? "",
    ].join(" "));
    return searchable.includes(query);
  });
}

export function hasAdminGeometry(item: Pick<AdminItem, "geometry" | "additionalGeometries">) {
  return item.geometry !== null || (item.additionalGeometries?.length ?? 0) > 0;
}

export function countAdminGeometry(items: readonly AdminItem[], geometryKnown = true) {
  if (!geometryKnown) {
    return { mapped: null, unmapped: null, unknown: items.length, total: items.length };
  }
  let mapped = 0;
  for (const item of items) if (hasAdminGeometry(item)) mapped += 1;
  const missing = items.length - mapped;
  return {
    mapped,
    unmapped: missing,
    unknown: 0,
    total: items.length,
  };
}

export function findSelectedAdminItem(items: readonly AdminItem[], selectedId: string | null) {
  if (selectedId === null) return null;
  return items.find((item) => item.id === selectedId) ?? null;
}

export function currentApiObservation(state: AdminMonitorState, baselineAttempt: AdminMonitorState["currentAttempt"] | undefined) {
  const attempt = state.currentAttempt;
  const isCurrentAttempt = attempt !== null
    && baselineAttempt !== undefined
    && attempt !== baselineAttempt;
  if (!isCurrentAttempt || attempt === null) {
    return { isCurrentAttempt: false, currentAttempt: null, context: null, snapshot: null } as const;
  }
  return {
    isCurrentAttempt: true,
    currentAttempt: attempt,
    context: attempt.context,
    // A refreshed context does not make the prior event/geometry payload current.
    snapshot: attempt.context === null || state.status === "loading" ? null : state.snapshot,
  } as const;
}

function itemStateLabel(value: AdminItemState) {
  switch (value) {
    case "queued": return "Dalam antrean";
    case "running": return "Berjalan";
    case "held": return "Ditahan untuk pemeriksaan";
    case "failed": return "Gagal";
    case "done": return "Selesai";
  }
}

function itemDisplayStatus(item: AdminItem, mode: AdminMode) {
  if (mode === "simulation") return itemStateLabel(item.state);
  return item.publicEventId !== null ? "Record tersedia dari API publik" : "Status alur internal tidak tersedia";
}

function monitorStateLabel(state: AdminMonitorState["status"]) {
  switch (state) {
    case "idle": return "Belum ada pemeriksaan";
    case "loading": return "Memeriksa endpoint";
    case "connected": return "Permintaan terakhir berhasil";
    case "partial": return "Sebagian permintaan gagal";
    case "error": return "Pemeriksaan terakhir gagal";
    case "paused": return "Pemantauan dijeda";
    case "offline": return "Perangkat offline";
  }
}

function probeLabel(value: AdminProbe["endpoint"]) {
  switch (value) {
    case "context": return "Konteks publik";
    case "events": return "Halaman event publik";
    case "geometry": return "GeoJSON publik";
  }
}

function probeStatusLabel(value: AdminProbe["status"]) {
  switch (value) {
    case "succeeded": return "Berhasil";
    case "failed": return "Gagal";
    case "unavailable": return "Tidak tersedia";
  }
}

function sourceHealthLabel(value: AdminSnapshot["sources"][number]["health"]) {
  switch (value) {
    case "healthy": return "Status sumber: tersedia";
    case "degraded": return "Status sumber: menurun";
    case "unavailable": return "Status sumber: tidak tersedia";
    case "unknown": return "Status sumber: belum diketahui";
  }
}

function stateBadgeClass(state: AdminItemState) {
  return `admin-state admin-state--${state}`;
}

function displayStateBadgeClass(item: AdminItem, mode: AdminMode) {
  // API presence is not a workflow state: don't style a public record as done/held.
  return mode === "simulation" ? stateBadgeClass(item.state) : "admin-state admin-state--public";
}

function stepForLayer(item: AdminItem, layer: AdminLayer) {
  return [...item.steps].reverse().find((step) => step.layer === layer) ?? null;
}

function validityLabel(value: NonNullable<AdminItem["publicStatus"]>["validity"]) {
  const { valid_from: from, valid_until: until } = value;
  if (from && until) return `${formatInstant(from)} – ${formatInstant(until)}`;
  if (from) return `Mulai ${formatInstant(from)}; akhir tidak dinyatakan`;
  if (until) return `Berakhir ${formatInstant(until)}; awal tidak dinyatakan`;
  return "Tidak dinyatakan oleh sumber";
}

export function displayedLayers(snapshot: AdminSnapshot | null, mode: AdminMode): AdminLayerSummary[] {
  return LAYERS.map((layer) => {
    const value = snapshot?.layers.find((summary) => summary.layer === layer);
    if (value) {
      if (mode === "public_api") {
        if ((layer === "L1" || layer === "L4" || layer === "L5") && value.availability === "observed") {
          return value;
        }
        return {
          ...value,
          availability: "unavailable",
          count: null,
          state: "unavailable",
          note: "Metrik internal lapisan ini tidak tersedia melalui API publik.",
        };
      }
      return value;
    }
    return {
      layer,
      name: LAYER_NAMES[layer],
      description: mode === "public_api"
        ? "Proyeksi publik tidak membuka keadaan internal lapisan ini."
        : "Belum ada ringkasan untuk tahap ini dalam skrip simulasi.",
      availability: mode === "simulation" ? "simulated" : "unavailable",
      count: null,
      state: "unavailable",
      note: mode === "public_api"
        ? "Jumlah antrean, pemanggilan model, dan jejak internal tidak tersedia."
        : "Tidak ada angka pada fixture tahap ini.",
    };
  });
}

function PublicDatasetBadge({ datasetMode }: { datasetMode: "live" | "demo" | null }) {
  const mode = datasetMode;
  if (mode === "demo") {
    return <span className="admin-dataset admin-dataset--demo">Dataset server DEMO</span>;
  }
  if (mode === "live") {
    return <span className="admin-dataset admin-dataset--live">Dataset server LIVE</span>;
  }
  return <span className="admin-dataset admin-dataset--unknown">Mode dataset tidak diketahui</span>;
}

function SnapshotNotice({ mode, state, snapshot, onRefresh }: {
  mode: AdminMode;
  state: AdminMonitorState;
  snapshot: AdminSnapshot | null;
  onRefresh: () => void;
}) {
  if (mode === "simulation") return null;
  if (snapshot) {
    if (state.status === "partial" || state.status === "error" || state.status === "offline") {
      return (
        <div className="admin-inline-notice admin-inline-notice--attention" role="status">
          <strong>{state.status === "offline" ? "Perangkat offline." : "Permintaan terbaru bermasalah."}</strong>
          <span>
            Status permintaan saat ini dipisahkan dari data yang berhasil dibaca. Keberhasilan terakhir tercatat pada {formatInstant(state.lastSuccessAt)}; hanya respons yang lolos validasi yang ditampilkan.
          </span>
        </div>
      );
    }
    return null;
  }
  if (state.status === "loading" || state.status === "idle") {
    return (
      <div className="admin-inline-notice" role="status">
        <strong>{state.status === "loading" ? "Memuat proyeksi publik…" : "Belum ada snapshot endpoint."}</strong>
        <span>Hanya konteks, satu halaman event publik, dan GeoJSON publik yang dibaca.</span>
      </div>
    );
  }
  return (
    <div className="admin-inline-notice admin-inline-notice--attention" role="status">
      <strong>{state.status === "offline" ? "Tidak ada koneksi jaringan." : "Snapshot belum tersedia."}</strong>
      <span>
        {state.status === "paused"
          ? "Pemantauan dijeda sebelum ada pembacaan yang berhasil."
          : `Tidak ada data sukses yang dapat ditampilkan. Pemeriksaan endpoint tetap gagal atau belum selesai.${state.lastSuccessAt ? ` Pembacaan berhasil terakhir: ${formatInstant(state.lastSuccessAt)}.` : ""}`}
      </span>
      {state.status !== "offline" && (
        <button type="button" className="admin-button admin-button--quiet" onClick={onRefresh}>Coba baca endpoint</button>
      )}
    </div>
  );
}

function QueueCard({ item, mode, geometryKnown, selected, onSelect }: {
  item: AdminItem;
  mode: AdminMode;
  geometryKnown: boolean;
  selected: boolean;
  onSelect: (id: string) => void;
}) {
  const mapped = hasAdminGeometry(item);
  return (
    <li className="admin-queue__entry">
      <button
        type="button"
        className="admin-queue-card"
        aria-pressed={selected}
        onClick={() => onSelect(item.id)}
      >
        <span className="admin-queue-card__topline">
          <span className="admin-layer-chip">{mode === "simulation" ? item.layer : "API"}</span>
          <span className={displayStateBadgeClass(item, mode)}>{itemDisplayStatus(item, mode)}</span>
          <span className="admin-queue-card__geometry">{mapped ? "Ada geometri" : geometryKnown || mode === "simulation" ? "Tidak dipetakan" : "Geometri belum teramati"}</span>
        </span>
        <strong className="admin-queue-card__title">{item.title}</strong>
        <span className="admin-queue-card__category">{categoryLabel(item.category)} · {item.placeLabel}</span>
        <span className="admin-queue-card__summary">{item.summary}</span>
        <span className="admin-queue-card__meta">
          <span>{mode === "simulation" ? "FIKTIF · simulasi" : `Dataset item: ${item.datasetKind}`}</span>
          {item.sourceNames.length > 0 && <span>{item.sourceNames.join(" · ")}</span>}
        </span>
      </button>
    </li>
  );
}

export function AdminRecordInspector({ item, mode, geometryKnown }: { item: AdminItem | null; mode: AdminMode; geometryKnown: boolean }) {
  if (!item) {
    return (
      <aside className="admin-inspector" aria-labelledby="admin-inspector-title">
        <div className="admin-panel-heading">
          <div><p className="admin-kicker">Detail terpilih</p><h2 id="admin-inspector-title">Pemeriksaan record</h2></div>
        </div>
        <div className="admin-empty admin-empty--compact">
          <strong>Pilih satu record dari daftar atau geometri.</strong>
          <p>Record tanpa geometri tetap dapat dipilih dari daftar.</p>
        </div>
      </aside>
    );
  }

  const mapped = hasAdminGeometry(item);
  const l3 = mode === "simulation" ? stepForLayer(item, "L3") : null;
  const l4 = mode === "simulation" ? stepForLayer(item, "L4") : null;
  const publishedPublicRecord = mode === "public_api" && item.publicEventId !== null && item.publishedAt !== null;
  const publicSources = mode === "public_api" ? (item.publicSources ?? []).slice(0, 20) : [];

  return (
    <aside className="admin-inspector" aria-labelledby="admin-inspector-title">
      <div className="admin-panel-heading">
        <div><p className="admin-kicker">{mode === "simulation" ? "Fixture fiktif" : "Record terpilih dari snapshot"}</p><h2 id="admin-inspector-title">Pemeriksaan record</h2></div>
        <span className={displayStateBadgeClass(item, mode)}>{itemDisplayStatus(item, mode)}</span>
      </div>

      <section className="admin-inspector__identity" aria-label="Identitas record">
        <h3>{item.title}</h3>
        <p>{item.summary}</p>
        <dl className="admin-facts">
          <div><dt>{mode === "simulation" ? "ID fixture" : "ID event publik"}</dt><dd>{mode === "simulation" ? item.id : item.publicEventId ?? "Tidak tersedia"}</dd></div>
          <div><dt>Kategori</dt><dd>{categoryLabel(item.category)}</dd></div>
          <div><dt>Lokasi pada record</dt><dd>{item.placeLabel}</dd></div>
          <div><dt>Prioritas operasional</dt><dd>{mode === "simulation" ? `${item.operationalPriority === "normal" ? "Normal" : item.operationalPriority === "attention" ? "Perlu perhatian" : "Terblokir"} · label alur kerja, bukan tingkat bahaya` : "Tidak disediakan oleh endpoint publik"}</dd></div>
          <div><dt>Jenis dataset item</dt><dd>{mode === "simulation" ? "Sintetis · simulasi lokal" : item.datasetKind}</dd></div>
          <div><dt>Lapisan saat ini</dt><dd>{mode === "simulation" ? `${item.layer} · ${LAYER_NAMES[item.layer]}` : "Proyeksi event publik · status proses privat tidak tersedia"}</dd></div>
          <div><dt>Versi event publik</dt><dd>{item.eventVersion ?? "Tidak tersedia"}</dd></div>
        </dl>
      </section>

      <section className="admin-inspector__section" aria-labelledby="admin-evidence-title">
        <h3 id="admin-evidence-title">Bukti dan asal data</h3>
        <p className="admin-evidence-copy">{item.evidenceSummary || "Ringkasan bukti tidak tersedia pada record ini."}</p>
        {item.sourceNames.length > 0 ? (
          <ul className="admin-source-tags" aria-label="Nama sumber yang tercantum">
            {item.sourceNames.map((name) => <li key={name}>{name}</li>)}
          </ul>
        ) : <p className="admin-muted">Tidak ada nama sumber pada snapshot ini.</p>}
        {mode === "public_api" && (
          <div className="admin-attributions">
            <h4>Atribusi sumber publik</h4>
            {publicSources.length > 0 ? (
              <>
                <ul className="admin-attribution-list">
                  {publicSources.map((source, index) => (
                    <li key={`${source.url}-${index}`}>
                      <a href={source.url} referrerPolicy="no-referrer">{source.displayName}</a>
                      <dl className="admin-facts admin-facts--compact">
                        <div><dt>Publikasi sumber</dt><dd>{source.publishedAt ? formatInstant(source.publishedAt) : "Tidak dicantumkan sumber"}</dd></div>
                        <div><dt>Observasi sumber</dt><dd>{source.observedAt ? formatInstant(source.observedAt) : "Tidak dicantumkan sumber"}</dd></div>
                      </dl>
                    </li>
                  ))}
                </ul>
                <p className="admin-muted">Maksimum 20 tautan atribusi ditampilkan di sini. Gunakan tautan detail event publik di bawah untuk atribusi lengkap yang tersedia.</p>
              </>
            ) : (
              <p className="admin-muted">Snapshot ini tidak menyediakan tautan atribusi sumber pada halaman event.</p>
            )}
          </div>
        )}
        <dl className="admin-facts admin-facts--compact">
          {mode === "simulation" && <div><dt>Waktu fixture dicatat</dt><dd>{formatInstant(item.observedAt)}</dd></div>}
          <div><dt>{mode === "simulation" ? "Waktu fixture diambil" : "Waktu browser membaca proyeksi"}</dt><dd>{formatInstant(item.fetchedAt)}</dd></div>
          {publishedPublicRecord && <div><dt>Waktu publikasi pada record publik</dt><dd>{formatInstant(item.publishedAt)}</dd></div>}
        </dl>
        {mapped ? (
          <p className="admin-geometry-note"><strong>Dasar geometri:</strong> {item.geometryBasis === "synthetic_example" ? "contoh sintetis" : item.geometryBasis === "source_supported" ? "geometri pada proyeksi sumber publik" : "belum ditentukan"}. {item.geometryNote}</p>
        ) : mode === "public_api" && !geometryKnown ? (
          <p className="admin-geometry-note"><strong>Geometri belum teramati.</strong> Endpoint GeoJSON belum memberi respons sukses pada percobaan terbaru.</p>
        ) : (
          <p className="admin-geometry-note"><strong>Tidak dipetakan.</strong> {item.geometryNote || "Record ini tidak memiliki geometri yang didukung sumber."}</p>
        )}
        {publishedPublicRecord && (
          <a className="admin-link" href={`#detail/api/${encodeURIComponent(item.publicEventId ?? "")}`}>
            Buka detail event publik
          </a>
        )}
      </section>

      {mode === "public_api" && (
        <section className="admin-inspector__section admin-public-status" aria-labelledby="admin-public-status-title">
          <div className="admin-panel-heading admin-panel-heading--tight">
            <div><p className="admin-kicker">Proyeksi event publik</p><h3 id="admin-public-status-title">Status dan waktu event</h3></div>
          </div>
          {item.publicStatus ? (
            <dl className="admin-facts">
              <div><dt>Siklus event</dt><dd>{lifecycleLabel(item.publicStatus.lifecycle)}</dd></div>
              <div><dt>Kesegaran informasi</dt><dd>{freshnessLabel(item.publicStatus.freshness.status)}</dd></div>
              <div><dt>Kesegaran dievaluasi</dt><dd>{formatInstant(item.publicStatus.freshness.evaluated_at)}</dd></div>
              <div><dt>Batas tinjau</dt><dd>{formatInstant(item.publicStatus.freshness.review_due_at)}</dd></div>
              <div><dt>Waktu kejadian/observasi</dt><dd>{formatEventTime({ event_time: item.publicStatus.eventTime })}</dd></div>
              <div><dt>Validitas menurut penerbit</dt><dd>{validityLabel(item.publicStatus.validity)}</dd></div>
            </dl>
          ) : (
            <p className="admin-muted">Siklus, kesegaran, dan waktu event tidak tersedia pada record publik ini.</p>
          )}
          <p className="admin-muted">Siklus event, kesegaran, waktu observasi, dan validitas penerbit menjelaskan hal yang berbeda.</p>
        </section>
      )}

      <section className="admin-inspector__section" aria-labelledby="admin-timeline-title">
        <div className="admin-panel-heading admin-panel-heading--tight">
          <div><p className="admin-kicker">Riwayat record</p><h3 id="admin-timeline-title">Tahap yang tercatat</h3></div>
          <span className="admin-read-only-chip">Baca saja</span>
        </div>
        {mode === "simulation" ? (
          <ol className="admin-timeline">
            {item.steps.map((step, index) => (
              <li className="admin-timeline__step" key={`${step.layer}-${step.at ?? "unknown"}-${index}`}>
                <span className="admin-timeline__layer">{step.layer}</span>
                <div>
                  <strong>{step.label}</strong>
                  <p>{step.detail}</p>
                  <span>{itemStateLabel(step.state)}{step.at ? ` · ${formatInstant(step.at)}` : " · waktu tidak tercatat"}</span>
                </div>
              </li>
            ))}
            {item.steps.length === 0 && <li className="admin-timeline__empty">Tidak ada tahap yang tercatat untuk item ini.</li>}
          </ol>
        ) : (
          <p className="admin-muted">Langkah antrean, model, investigasi, dan review internal tidak tersedia di proyeksi API publik.</p>
        )}
      </section>

      <section className="admin-inspector__section admin-gate" aria-labelledby="admin-l4-title">
        <div className="admin-panel-heading admin-panel-heading--tight">
          <div>
            <p className="admin-kicker">{mode === "simulation" ? "L4 · pemeriksaan deterministik" : "Batas proyeksi L4"}</p>
            <h3 id="admin-l4-title">{mode === "simulation" ? "Gate manusia tetap diperlukan" : "Status review privat"}</h3>
          </div>
        </div>
        {l4 ? <p><strong>{l4.label}:</strong> {l4.detail}</p> : (
          <p>{mode === "simulation"
            ? "Fixture ini tidak mencatat keputusan gate L4. Tampilan tidak menentukan kelayakan publikasi."
            : publishedPublicRecord
              ? "Record versi publik dan waktu terbit berasal dari respons API. Keputusan moderator, catatan audit, serta status internal gate tidak ditampilkan."
              : "Keputusan moderator dan status internal gate tidak tersedia melalui API publik."}</p>
        )}
        {publishedPublicRecord && <p className="admin-public-record-note">Snapshot memuat record publik versi {item.eventVersion ?? "tidak diketahui"}; halaman ini tidak menetapkan atau mengubah kelayakan publikasi.</p>}
      </section>

      <section className="admin-inspector__section admin-budget" aria-labelledby="admin-l3-title">
        <div className="admin-panel-heading admin-panel-heading--tight">
          <div><p className="admin-kicker">L3 · tindakan bersyarat</p><h3 id="admin-l3-title">Batas dan penghentian</h3></div>
        </div>
        {mode === "public_api" ? (
          <p>Anggaran model, tool, token, antrean investigasi, dan jejak privat tidak tersedia pada endpoint publik.</p>
        ) : item.budget ? (
          <>
            <dl className="admin-budget-grid">
              <div><dt>Tool</dt><dd>{item.budget.toolsUsed} / {item.budget.toolsLimit}</dd></div>
              <div><dt>Langkah penalaran</dt><dd>{item.budget.reasoningUsed} / {item.budget.reasoningLimit}</dd></div>
              <div><dt>Token</dt><dd>{item.budget.tokensUsed} / {item.budget.tokensLimit}</dd></div>
              <div><dt>Waktu aktif</dt><dd>{item.budget.activeSecondsUsed} / {item.budget.activeSecondsLimit} dtk</dd></div>
            </dl>
            <p><strong>Hasil L3:</strong> {l3 ? `${itemStateLabel(l3.state)} · ${l3.detail}` : "Tidak ada langkah L3 dalam fixture."}</p>
            <p><strong>Alasan berhenti:</strong> {item.stopReason ?? "Belum dicatat dalam fixture."}</p>
            <p><strong>Eskalasi berikutnya:</strong> {item.nextStep}</p>
            <p className="admin-synthetic-note">Angka dan hasil pada bagian ini adalah fixture fiktif; simulator tidak menjalankan tool atau model.</p>
          </>
        ) : (
          <p>Tidak ada anggaran L3 pada fixture item ini. Tidak ada investigasi yang dimulai oleh halaman ini.</p>
        )}
      </section>
    </aside>
  );
}

function SimulationControls({ step, playing, visible, onStart, onPause, onReplay }: {
  step: number;
  playing: boolean;
  visible: boolean;
  onStart: () => void;
  onPause: () => void;
  onReplay: () => void;
}) {
  const last = Math.max(0, SIMULATION_STEPS.length - 1);
  return (
    <div className="admin-transport" aria-label="Kontrol simulasi lokal">
      {playing ? (
        <button type="button" className="admin-button admin-button--quiet" onClick={onPause}>Jeda simulasi</button>
      ) : (
        <button type="button" className="admin-button admin-button--primary" onClick={onStart} disabled={step >= last}>Mulai simulasi</button>
      )}
      <button type="button" className="admin-button admin-button--quiet" onClick={onReplay}>Ulangi dari awal</button>
      <span className="admin-transport__progress">Tahap {step + 1} dari {SIMULATION_STEPS.length}</span>
      {playing && !visible && <span className="admin-transport__paused">Menunggu tab terlihat untuk melanjutkan.</span>}
    </div>
  );
}

function LayerOverview({ snapshot, mode, monitorState }: {
  snapshot: AdminSnapshot | null;
  mode: AdminMode;
  monitorState: AdminMonitorState;
}) {
  const layers = displayedLayers(snapshot, mode);
  return (
    <section className="admin-layers" aria-labelledby="admin-layers-title">
      <div className="admin-section-heading">
        <div><p className="admin-kicker">Cakupan proses</p><h2 id="admin-layers-title">Lima lapisan sistem</h2></div>
        <p>{mode === "simulation"
          ? "Kartu mengikuti fixture lokal; progres hanya bergerak saat simulasi dimulai."
          : "Endpoint publik tidak memaparkan antrean dan metrik privat; probe browser disajikan terpisah di bawah."}</p>
      </div>
      <ol className="admin-layer-grid">
        {layers.map((layer) => {
          const step = mode === "simulation"
            ? snapshot?.items.flatMap((item) => item.steps).filter((entry) => entry.layer === layer.layer).at(-1)
            : undefined;
          const available = layer.state !== "unavailable" && (mode === "simulation"
            ? layer.availability === "simulated"
            : layer.availability === "observed");
          const unavailable = !available;
          const countLabel = mode === "simulation"
            ? "item pada fixture"
            : layer.layer === "L1"
              ? "sumber dalam konteks"
              : layer.layer === "L4"
                ? "record publik pada halaman"
                : layer.layer === "L5"
                  ? "probe browser terukur"
                  : "jumlah internal tidak tersedia";
          return (
            <li className={`admin-layer-card${unavailable ? " admin-layer-card--unavailable" : ""}`} key={layer.layer}>
              <div className="admin-layer-card__heading">
                <span className="admin-layer-chip">{layer.layer}</span>
                <span>{unavailable ? "Tidak tersedia" : mode === "simulation" ? "Simulasi" : "Observasi"}</span>
              </div>
              <h3>{layer.name || LAYER_NAMES[layer.layer]}</h3>
              <p>{layer.description}</p>
              <div className="admin-layer-card__count">
                <strong>{unavailable || layer.count === null ? "—" : layer.count}</strong>
                <span>{unavailable ? mode === "public_api" ? "jumlah internal tidak tersedia" : "belum ada angka" : countLabel}</span>
              </div>
              <p className="admin-layer-card__note">{mode === "public_api" ? layer.availability === "observed" ? layer.note : "Metrik privat tidak tersedia melalui endpoint publik." : step ? `${itemStateLabel(step.state)} · ${step.label}` : layer.note}</p>
              {mode === "public_api" && layer.layer === "L5" && monitorState.currentAttempt && (
                <p className="admin-layer-card__note">{monitorState.currentAttempt.probes.length > 0
                  ? `${monitorState.currentAttempt.probes.filter((probe) => probe.status === "succeeded").length} dari ${monitorState.currentAttempt.probes.length} probe browser berhasil pada percobaan terakhir. Ini bukan status keseluruhan sistem.`
                  : "Percobaan terakhir tidak memiliki hasil probe; kinerja endpoint tidak teramati."}</p>
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
}

function PublicSources({ snapshot, mode, publicContext }: {
  snapshot: AdminSnapshot | null;
  mode: AdminMode;
  publicContext: AdminSnapshot["context"];
}) {
  if (mode === "simulation") {
    const sources = snapshot?.sources ?? [];
    return (
      <section className="admin-support-panel" aria-labelledby="admin-sources-title">
        <div className="admin-panel-heading"><div><p className="admin-kicker">Fixture lokal</p><h2 id="admin-sources-title">Sumber pada skenario</h2></div><span className="admin-read-only-chip">Semua sintetik</span></div>
        {sources.length === 0 ? <p className="admin-muted">Skenario ini tidak mencantumkan nama sumber.</p> : (
          <ul className="admin-source-list">
            {sources.map((source) => <li key={source.id}><strong>{source.name}</strong><span>{source.note}</span><small>{sourceHealthLabel(source.health)} · fixture, bukan status konektor nyata</small></li>)}
          </ul>
        )}
      </section>
    );
  }

  const sources = snapshot?.sources ?? publicContext?.sources.map((source, index) => ({
    id: `${source.display_name}-${index}`,
    name: source.display_name,
    health: source.health,
    lastSuccessAt: source.last_success_at,
    note: "Nilai ini dikembalikan oleh endpoint konteks publik.",
  })) ?? [];
  const contextAvailable = snapshot?.context !== null && snapshot?.context !== undefined || publicContext !== null;
  return (
    <section className="admin-support-panel" aria-labelledby="admin-sources-title">
      <div className="admin-panel-heading"><div><p className="admin-kicker">GET /api/v1/context</p><h2 id="admin-sources-title">Status sumber dari konteks publik</h2></div><span className="admin-read-only-chip">Respons API</span></div>
      {sources.length === 0 ? (
        <div className="admin-empty admin-empty--compact">
          <strong>{contextAvailable ? "Daftar sumber kosong pada konteks publik." : "Konteks sumber publik tidak tersedia."}</strong>
          <p>{contextAvailable ? "sources: [] bukan bukti bahwa semua sumber sehat." : "Status sumber tidak dapat ditentukan tanpa respons konteks terbaru."}</p>
        </div>
      ) : (
        <ul className="admin-source-list">
          {sources.map((source) => <li key={source.id}><strong>{source.name}</strong><span>{source.note}</span><small>{sourceHealthLabel(source.health)} · sukses terakhir {formatInstant(source.lastSuccessAt)}</small></li>)}
        </ul>
      )}
      <p className="admin-muted">Koneksi API browser dipantau terpisah. Status ini hanya nilai sumber yang dikembalikan oleh endpoint konteks.</p>
    </section>
  );
}

function ProbeObservations({ state, mode, snapshot }: {
  state: AdminMonitorState;
  mode: AdminMode;
  snapshot: AdminSnapshot | null;
}) {
  const probes = mode === "public_api"
    ? state.currentAttempt?.probes ?? snapshot?.probes ?? []
    : snapshot?.probes ?? [];
  return (
    <section className="admin-support-panel" aria-labelledby="admin-probes-title">
      <div className="admin-panel-heading"><div><p className="admin-kicker">Observasi permintaan</p><h2 id="admin-probes-title">Probe endpoint browser</h2></div><span className="admin-read-only-chip">Baca saja</span></div>
      <p className="admin-muted">Durasi diukur di browser untuk permintaan yang terlihat; bukan latensi server, kinerja model, atau kesehatan seluruh stack.</p>
      {probes.length === 0 ? (
        <div className="admin-empty admin-empty--compact"><strong>{mode === "simulation" ? "Belum ada probe pada skenario." : "Belum ada hasil probe."}</strong><p>Nilai kosong berarti tidak teramati, bukan 0 ms atau berhasil.</p></div>
      ) : (
        <div className="admin-probe-table-wrap">
          <table className="admin-probe-table">
            <caption>{mode === "simulation" ? "Durasi dan status fixture simulasi" : `Percobaan terakhir · ${formatInstant(state.currentAttempt?.at ?? state.attemptedAt)}`}</caption>
            <thead><tr><th scope="col">Endpoint</th><th scope="col">Hasil</th><th scope="col">Durasi browser</th><th scope="col">HTTP</th><th scope="col">Diamati pada</th></tr></thead>
            <tbody>
              {probes.map((probe, index) => (
                <tr key={`${probe.endpoint}-${probe.observedAt}-${index}`}>
                  <th scope="row">{probeLabel(probe.endpoint)}</th>
                  <td><span className={`admin-probe-status admin-probe-status--${probe.status}`}>{probeStatusLabel(probe.status)}</span></td>
                  <td>{probe.durationMs === null ? "Tidak tersedia" : `${probe.durationMs} ms`}</td>
                  <td>{probe.httpStatus ?? "Tidak tersedia"}</td>
                  <td>{formatInstant(probe.observedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function RecentActivity({ snapshot, mode, onSelect }: {
  snapshot: AdminSnapshot | null;
  mode: AdminMode;
  onSelect: (id: string) => void;
}) {
  if (mode === "public_api") {
    return (
      <section className="admin-support-panel" aria-labelledby="admin-activity-title">
        <div className="admin-panel-heading"><div><p className="admin-kicker">Cakupan proyeksi</p><h2 id="admin-activity-title">Aktivitas internal</h2></div><span className="admin-read-only-chip">Tidak tersedia</span></div>
        <div className="admin-empty admin-empty--compact"><strong>API publik tidak memberikan antrean atau jejak aktivitas operasi.</strong><p>Catatan review privat, kegagalan job, dan audit tidak disimulasikan pada mode ini.</p></div>
      </section>
    );
  }
  const activities = snapshot?.activities ?? [];
  return (
    <section className="admin-support-panel" aria-labelledby="admin-activity-title">
      <div className="admin-panel-heading"><div><p className="admin-kicker">Catatan yang termuat</p><h2 id="admin-activity-title">Aktivitas terbaru</h2></div><span className="admin-read-only-chip">{mode === "simulation" ? "Fiktif" : "Dari proyeksi publik"}</span></div>
      {activities.length === 0 ? (
        <div className="admin-empty admin-empty--compact"><strong>{mode === "simulation" ? "Belum ada catatan pada tahap ini." : "API publik tidak mengembalikan riwayat operasi internal."}</strong><p>{mode === "simulation" ? "Jalankan simulasi lokal untuk melihat urutan fixture." : "Riwayat moderator, antrean privat, dan audit tidak tersedia di sini."}</p></div>
      ) : (
        <ol className="admin-activity-list">
          {activities.slice(0, 8).map((activity) => (
            <li key={activity.id}>
              <time dateTime={activity.at}>{formatInstant(activity.at)}</time>
              <div><strong>{activity.layer} · {activity.label}</strong><p>{activity.detail}</p></div>
              {activity.itemId && snapshot?.items.some((item) => item.id === activity.itemId) && (
                <button type="button" className="admin-text-button" onClick={() => onSelect(activity.itemId ?? "")}>Pilih record</button>
              )}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

export function AdminDashboard() {
  const [mode, setMode] = useState<AdminMode>("simulation");
  const [simulationStep, setSimulationStep] = useState(0);
  const [simulationPlaying, setSimulationPlaying] = useState(false);
  const [monitorState, setMonitorState] = useState<AdminMonitorState>({
    status: "idle",
    snapshot: null,
    attemptedAt: null,
    lastSuccessAt: null,
    nextPollAt: null,
    consecutiveFailures: 0,
    currentAttempt: null,
  });
  const [apiAttemptBaseline, setApiAttemptBaseline] = useState<AdminMonitorState["currentAttempt"] | undefined>(undefined);
  const [monitoringEnabled, setMonitoringEnabled] = useState(true);
  const [documentVisible, setDocumentVisible] = useState(() => typeof document === "undefined" || document.visibilityState === "visible");
  const [query, setQuery] = useState("");
  const [layerFilter, setLayerFilter] = useState<AdminLayer | "all">("all");
  const [stateFilter, setStateFilter] = useState<AdminItemState | "all">("all");
  const [geometryFilter, setGeometryFilter] = useState<AdminItemFilters["geometry"]>("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [mobileView, setMobileView] = useState<"list" | "map">("list");
  const monitorRef = useRef<ReturnType<typeof createAdminMonitor> | null>(null);

  useEffect(() => {
    const main = document.getElementById("main-content");
    if (!main) return;
    const active = document.activeElement;
    const activeFallbackMain = active instanceof HTMLElement
      && active.tagName === "MAIN"
      && active.id === "main-content"
      && active !== main;
    if (active === document.body || activeFallbackMain) main.focus({ preventScroll: true });
  }, []);

  const simulationSnapshot = useMemo(() => createSimulationSnapshot(simulationStep), [simulationStep]);
  const apiObservation = currentApiObservation(monitorState, apiAttemptBaseline);
  const apiAttemptIsCurrent = apiObservation.isCurrentAttempt;
  const currentApiContext = apiObservation.context;
  const apiSnapshot = apiObservation.snapshot;
  const snapshot = mode === "simulation" ? simulationSnapshot : apiSnapshot;
  const viewMonitorState: AdminMonitorState = mode === "public_api" && !apiAttemptIsCurrent
    ? {
      ...monitorState,
      status: !monitoringEnabled ? "paused" : monitorState.status === "offline" ? "offline" : "loading",
      snapshot: null,
      attemptedAt: null,
      lastSuccessAt: null,
      nextPollAt: null,
      currentAttempt: null,
    }
    : {
      ...monitorState,
      snapshot: apiSnapshot,
    };
  const rawItems = snapshot?.items ?? [];
  const geometryProbe = viewMonitorState.currentAttempt?.probes.find((probe) => probe.endpoint === "geometry");
  const geometryKnown = mode === "simulation" || geometryProbe?.status === "succeeded";
  const sourceItems = useMemo(() => {
    if (mode !== "public_api" || geometryKnown) return rawItems;
    return rawItems.map((item) => ({
      ...item,
      geometry: null,
      additionalGeometries: [],
      geometryBasis: "none" as const,
      geometryNote: "Geometri belum teramati karena endpoint GeoJSON belum berhasil pada percobaan terbaru.",
    }));
  }, [mode, geometryKnown, rawItems]);
  const filteredItems = useMemo(() => filterAdminItems(sourceItems, {
    query,
    layer: layerFilter,
    state: stateFilter,
    geometry: geometryFilter,
  }), [sourceItems, query, layerFilter, stateFilter, geometryFilter]);
  const selectedItem = findSelectedAdminItem(filteredItems, selectedId);
  const geometryCounts = countAdminGeometry(filteredItems, geometryKnown);
  const lastStep = Math.max(0, SIMULATION_STEPS.length - 1);
  const publicListProbe = viewMonitorState.currentAttempt?.probes.find((probe) => probe.endpoint === "events");
  const publicListKnown = mode === "simulation" || publicListProbe?.status === "succeeded";
  const publicGeometryKnown = mode === "simulation" || geometryKnown;
  const apiDatasetReady = apiAttemptIsCurrent && currentApiContext !== null;
  const emptyQueueTitle = sourceItems.length > 0
    ? "Tidak ada record yang cocok dengan filter."
    : mode === "simulation"
      ? "Fixture tahap ini belum memuat kasus."
      : !apiDatasetReady
        ? "Mode dataset belum dikonfirmasi oleh konteks terbaru."
      : publicListProbe?.status === "succeeded"
        ? "Halaman event publik yang dikembalikan kosong."
        : publicListProbe?.status === "failed"
          ? "Endpoint halaman event publik gagal dibaca."
          : "Belum ada record publik yang termuat.";
  const emptyQueueDetail = sourceItems.length > 0
    ? "Ubah atau hapus filter untuk melihat kembali record pada snapshot yang sama."
    : mode === "simulation"
      ? "Pilih tahap simulasi lain atau mulai simulasi lokal."
      : !apiDatasetReady
        ? "Record dan geometri dari pembacaan sebelumnya disembunyikan sampai konteks publik berhasil dibaca."
      : publicListProbe?.status === "succeeded"
        ? "Halaman ini tidak mengembalikan record; hasil kosong bukan pernyataan bahwa kondisi aman."
        : publicListProbe?.status === "failed"
          ? "Daftar tidak tersedia pada percobaan ini. Data yang tidak teramati tidak dihitung sebagai 0."
          : viewMonitorState.status === "paused"
            ? "Pantauan dijeda. Lanjutkan pantauan untuk membaca endpoint."
            : "Kegagalan atau hasil kosong tidak menunjukkan bahwa kondisi aman; periksa status endpoint di bawah.";

  useEffect(() => {
    const monitor = createAdminMonitor({ onState: setMonitorState });
    monitorRef.current = monitor;
    monitor.setVisible(document.visibilityState === "visible");
    monitor.setOnline(navigator.onLine);

    const updateVisibility = () => {
      const visible = document.visibilityState === "visible";
      setDocumentVisible(visible);
      monitor.setVisible(visible);
    };
    const updateOnline = () => monitor.setOnline(navigator.onLine);
    document.addEventListener("visibilitychange", updateVisibility);
    window.addEventListener("online", updateOnline);
    window.addEventListener("offline", updateOnline);

    return () => {
      document.removeEventListener("visibilitychange", updateVisibility);
      window.removeEventListener("online", updateOnline);
      window.removeEventListener("offline", updateOnline);
      monitor.stop();
      monitorRef.current = null;
    };
  }, []);

  useEffect(() => {
    const monitor = monitorRef.current;
    if (!monitor) return;
    if (mode === "public_api" && monitoringEnabled) monitor.start();
    else monitor.pause();
  }, [mode, monitoringEnabled]);

  useEffect(() => {
    if (!simulationPlaying || mode !== "simulation" || !documentVisible || simulationStep >= lastStep) return;
    const timer = window.setTimeout(() => {
      if (document.visibilityState !== "visible") return;
      setSimulationStep((step) => Math.min(lastStep, step + 1));
    }, SIMULATION_STEPS[simulationStep]?.durationMs ?? 2_400);
    return () => window.clearTimeout(timer);
  }, [simulationPlaying, mode, documentVisible, simulationStep, lastStep]);

  useEffect(() => {
    if (simulationStep >= lastStep) setSimulationPlaying(false);
  }, [simulationStep, lastStep]);

  useEffect(() => {
    if (selectedId !== null && !filteredItems.some((item) => item.id === selectedId)) setSelectedId(null);
  }, [filteredItems, selectedId]);

  useEffect(() => {
    if (mode === "public_api" && !geometryKnown && geometryFilter !== "all") setGeometryFilter("all");
  }, [mode, geometryKnown, geometryFilter]);

  const changeMode = (nextMode: AdminMode) => {
    if (nextMode === mode) return;
    setSimulationPlaying(false);
    setSelectedId(null);
    setQuery("");
    setLayerFilter("all");
    setStateFilter("all");
    setGeometryFilter("all");
    setMobileView("list");
    setApiAttemptBaseline(nextMode === "public_api" ? monitorState.currentAttempt : undefined);
    setMode(nextMode);
  };

  const refresh = () => {
    if (mode === "public_api" && monitoringEnabled) monitorRef.current?.refresh();
  };

  const toggleMonitoring = () => setMonitoringEnabled((enabled) => !enabled);

  const selectItem = (id: string) => {
    if (filteredItems.some((item) => item.id === id)) setSelectedId(id);
  };

  return (
    <main id="main-content" tabIndex={-1} className="admin-page">
      <header className="admin-header">
        <div className="admin-header__identity">
          <a className="admin-back-link" href="#beranda">Kembali ke layanan publik</a>
          <p className="admin-kicker">Ruang operasi web · baca saja</p>
          <h1>Alur data dan peta</h1>
          <p className="admin-header__lede">Pilih record untuk melihat asal data, tahap yang tercatat, waktu, dan keterbatasan yang diketahui.</p>
        </div>
        <div className="admin-header__actions">
          <a className="admin-button admin-button--quiet" href="#jelajah">Buka informasi publik</a>
          <span className="admin-read-only-chip">Baca saja · tidak ada kontrol tulis</span>
        </div>
      </header>

      <section className="admin-mode-strip" aria-label="Pilih mode ruang operasi">
        <div className="admin-mode-switch" role="group" aria-label="Mode data">
          <button type="button" aria-pressed={mode === "simulation"} onClick={() => changeMode("simulation")}>Simulasi alur</button>
          <button type="button" aria-pressed={mode === "public_api"} onClick={() => changeMode("public_api")}>Pantauan API</button>
        </div>
        <div className="admin-mode-strip__state">
          {mode === "simulation" ? (
            <span className="admin-connection admin-connection--simulation"><i aria-hidden="true" />Simulasi lokal · {simulationPlaying ? documentVisible ? "diputar" : "menunggu tab terlihat" : "jeda"}</span>
          ) : (
            <span className={`admin-connection admin-connection--${viewMonitorState.status}`} aria-live="polite"><i aria-hidden="true" />{monitorStateLabel(viewMonitorState.status)}</span>
          )}
          {mode === "public_api" && <PublicDatasetBadge datasetMode={currentApiContext?.dataset_mode ?? null} />}
        </div>
      </section>

      <section className={`admin-provenance admin-provenance--${mode}`} aria-label="Asal dan batas data">
        {mode === "simulation" ? (
          <>
            <strong>SIMULASI LOKAL · DEMO TANPA AUTENTIKASI · KASUS DAN GEOGRAFI FIKTIF</strong>
            <p>Demo ini tidak membuka akses ke operasi privat. Fixture terpisah sepenuhnya dari API. Tidak ada pengambilan sumber, pemanggilan model, publikasi, atau perubahan record. {simulationPlaying ? "Progres terbatas berjalan saat halaman terlihat." : "Simulasi diam sampai Anda memulainya."}</p>
          </>
        ) : (
          <>
            <strong>PANTAUAN API · HANYA PEMBACAAN ENDPOINT PUBLIK</strong>
            <p>
              Record dan geometri hanya berasal dari snapshot endpoint yang berhasil dimuat. Mode server dan jenis dataset tiap record ditampilkan terpisah. Antrean internal, penggunaan model, hasil gate privat, audit, dan kesehatan seluruh stack tidak tersedia.
            </p>
          </>
        )}
      </section>

      <section className="admin-controls" aria-label="Kontrol dan filter record">
        {mode === "simulation" ? (
          <SimulationControls
            step={simulationStep}
            playing={simulationPlaying}
            visible={documentVisible}
            onStart={() => { if (simulationStep < lastStep) setSimulationPlaying(true); }}
            onPause={() => setSimulationPlaying(false)}
            onReplay={() => { setSimulationStep(0); setSimulationPlaying(SIMULATION_STEPS.length > 1); }}
          />
        ) : (
          <div className="admin-transport" aria-label="Kontrol pantauan API">
            <button type="button" className="admin-button admin-button--primary" onClick={refresh} disabled={!monitoringEnabled || viewMonitorState.status === "loading"}>
              {viewMonitorState.status === "loading" ? "Memeriksa…" : "Periksa sekarang"}
            </button>
            <button type="button" className="admin-button admin-button--quiet" onClick={toggleMonitoring}>
              {monitoringEnabled ? "Jeda pantauan" : "Lanjutkan pantauan"}
            </button>
            <span className="admin-transport__progress">Interval 30 detik saat halaman aktif dan terlihat</span>
            {viewMonitorState.status === "offline" && <span className="admin-transport__paused">Permintaan menunggu koneksi jaringan.</span>}
          </div>
        )}
        <div className="admin-filter-grid">
          <label className="admin-filter admin-filter--search">
            <span>Cari record yang termuat</span>
            <input type="search" value={query} onChange={(event) => setQuery(event.currentTarget.value)} placeholder="Judul, tempat, sumber, ID…" />
          </label>
          <label className="admin-filter">
            <span>Lapisan</span>
            <select
              value={mode === "simulation" ? layerFilter : "all"}
              disabled={mode === "public_api"}
              onChange={(event) => setLayerFilter(event.currentTarget.value as AdminLayer | "all")}
            >
              {mode === "simulation"
                ? LAYER_OPTIONS.map((option) => <option value={option.value} key={option.value}>{option.label}</option>)
                : <option value="all">Tidak tersedia dari endpoint publik</option>}
            </select>
          </label>
          <label className="admin-filter">
            <span>{mode === "simulation" ? "Status alur" : "Status pipeline"}</span>
            <select
              value={mode === "simulation" ? stateFilter : "all"}
              disabled={mode === "public_api"}
              onChange={(event) => setStateFilter(event.currentTarget.value as AdminItemState | "all")}
            >
              {mode === "simulation"
                ? STATUS_OPTIONS.map((option) => <option value={option.value} key={option.value}>{option.label}</option>)
                : <option value="all">Tidak tersedia dari endpoint publik</option>}
            </select>
          </label>
          <label className="admin-filter">
            <span>Ketersediaan geometri</span>
            <select
              value={mode === "public_api" && !geometryKnown ? "all" : geometryFilter}
              disabled={mode === "public_api" && !geometryKnown}
              onChange={(event) => setGeometryFilter(event.currentTarget.value as AdminItemFilters["geometry"])}
            >
              <option value="all">{mode === "public_api" && !geometryKnown ? "Belum teramati" : "Semua record"}</option>
              <option value="mapped">Ada geometri</option>
              <option value="unmapped">Tidak dipetakan</option>
            </select>
          </label>
          <button type="button" className="admin-button admin-button--quiet admin-filter__clear" onClick={() => { setQuery(""); setLayerFilter("all"); setStateFilter("all"); setGeometryFilter("all"); }}>Hapus filter</button>
        </div>
      </section>

      <SnapshotNotice mode={mode} state={viewMonitorState} snapshot={snapshot} onRefresh={refresh} />

      <section id="admin-workspace" className={`admin-workspace admin-workspace--mobile-${mobileView}`} aria-label="Peta, daftar, dan detail record">
        <div className="admin-mobile-switch" role="group" aria-label="Tampilan ruang operasi">
          <button type="button" aria-pressed={mobileView === "list"} onClick={() => setMobileView("list")}>Daftar record</button>
          <button type="button" aria-pressed={mobileView === "map"} onClick={() => setMobileView("map")}>Peta geometri</button>
        </div>

        <section className="admin-queue" aria-labelledby="admin-queue-title">
          <div className="admin-panel-heading">
            <div><p className="admin-kicker">{mode === "simulation" ? "Kasus lokal fiktif" : "Record event publik termuat"}</p><h2 id="admin-queue-title">{mode === "simulation" ? "Antrean simulasi" : "Daftar API publik"}</h2></div>
            <span className="admin-total-count">{publicListKnown ? `${filteredItems.length} / ${sourceItems.length}` : "—"}</span>
          </div>
          <div className="admin-queue__coverage" aria-live="polite">
            <span><strong>{publicListKnown && publicGeometryKnown ? geometryCounts.mapped ?? "—" : "—"}</strong> dipetakan</span>
            {publicListKnown && publicGeometryKnown
              ? <span><strong>{geometryCounts.unmapped ?? "—"}</strong> tidak dipetakan</span>
              : publicListKnown
                ? <span><strong>{geometryCounts.unknown}</strong> geometri belum teramati</span>
                : <span><strong>—</strong> geometri belum teramati</span>}
            <span>{publicListKnown ? `dari ${geometryCounts.total} record pada hasil filter` : "Cakupan event belum teramati"}</span>
          </div>
          {mode === "public_api" && viewMonitorState.lastSuccessAt && (
            <p className="admin-observation-time">Snapshot sukses terakhir: <time dateTime={viewMonitorState.lastSuccessAt}>{formatInstant(viewMonitorState.lastSuccessAt)}</time></p>
          )}
          <p className="admin-coverage-note">Peta dan jumlah hanya mencakup hasil yang sudah termuat serta filter saat ini; cakupan bukan seluruh Jakarta atau seluruh event.</p>
          {filteredItems.length > 0 ? (
            <ul className="admin-queue__list">
              {filteredItems.map((item) => <QueueCard key={item.id} item={item} mode={mode} geometryKnown={geometryKnown} selected={selectedId === item.id} onSelect={selectItem} />)}
            </ul>
          ) : (
            <div className="admin-empty">
              <strong>{emptyQueueTitle}</strong>
              <p>{emptyQueueDetail}</p>
              {mode === "public_api" && !monitoringEnabled && <button type="button" className="admin-button admin-button--quiet" onClick={toggleMonitoring}>Lanjutkan pantauan</button>}
              {mode === "public_api" && monitoringEnabled && viewMonitorState.status !== "loading" && viewMonitorState.status !== "offline" && (
                <button type="button" className="admin-button admin-button--quiet" onClick={refresh}>Periksa endpoint</button>
              )}
            </div>
          )}
        </section>

        <section className="admin-map-panel" aria-labelledby="admin-map-title">
          <div className="admin-panel-heading">
            <div><p className="admin-kicker">{mode === "simulation" ? "Geografi fiktif" : "Geometri dari GeoJSON publik"}</p><h2 id="admin-map-title">Peta record termuat</h2></div>
            <span className="admin-read-only-chip">{mode === "simulation" ? "Sintetis" : "Sumber saja"}</span>
          </div>
          {mode === "public_api" && !publicListKnown
            ? <p className="admin-map-empty-note">Daftar event belum berhasil dimuat dari percobaan terbaru; record peta belum tersedia untuk dihitung.</p>
            : mode === "public_api" && !geometryKnown
              ? <p className="admin-map-empty-note" role="status">Geometri belum teramati: GeoJSON belum berhasil dibaca pada percobaan terbaru. Record tetap tersedia di daftar; jumlah yang dipetakan belum diketahui.</p>
            : <AdminOperationsMap items={filteredItems} selectedId={selectedId} onSelect={selectItem} mode={mode} />}
          <p className="admin-map-footnote">{mode === "simulation"
            ? "Koordinat hanya menjelaskan fixture fiktif. Tidak merepresentasikan jalan, batas resmi, atau area bahaya."
            : !publicListKnown
              ? "Peta menunggu konteks dan record publik dari percobaan terbaru."
            : geometryKnown
              ? "Hanya geometri sumber yang terhubung ke record publik termuat. Tidak dibuat radius bahaya atau geometri pengganti."
              : "GeoJSON belum berhasil dibaca; geometri yang tidak tampil belum dapat dinyatakan tidak dipetakan."}</p>
        </section>

        <AdminRecordInspector item={selectedItem} mode={mode} geometryKnown={geometryKnown} />
      </section>

      <LayerOverview snapshot={snapshot} mode={mode} monitorState={viewMonitorState} />

      <section className="admin-support-grid" aria-label="Sumber, aktivitas, dan hasil pemantauan">
        <PublicSources snapshot={snapshot} mode={mode} publicContext={currentApiContext} />
        <RecentActivity snapshot={snapshot} mode={mode} onSelect={selectItem} />
        <ProbeObservations state={viewMonitorState} mode={mode} snapshot={snapshot} />
      </section>

      <footer className="admin-footer">
        <strong>Ruang operasi ini hanya untuk membaca informasi.</strong>
        <p>Halaman tidak memulai akuisisi atau investigasi, tidak menyetujui atau mengubah publikasi, dan tidak menampilkan telemetry internal yang tidak disediakan secara publik.</p>
        <a className="admin-link" href="#beranda">Kembali ke Waspada Jakarta</a>
      </footer>
    </main>
  );
}

export default AdminDashboard;
