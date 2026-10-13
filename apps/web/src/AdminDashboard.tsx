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
  L1: "Penerimaan laporan",
  L2: "Pencarian bukti",
  L3: "Pemeriksaan lanjutan",
  L4: "Tinjauan laporan",
  L5: "Pemantauan sistem",
};
const LAYER_SHORT_NAMES: Record<AdminLayer, string> = {
  L1: "Terima",
  L2: "Cari bukti",
  L3: "Periksa",
  L4: "Tinjau",
  L5: "Pantau",
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
  { value: "all", label: "Semua tahap" },
  ...LAYERS.map((layer) => ({ value: layer, label: LAYER_NAMES[layer] })),
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
  return item.publicEventId !== null ? "Laporan publik tersedia" : "Rincian proses tidak tersedia";
}

function monitorStateLabel(state: AdminMonitorState["status"]) {
  switch (state) {
    case "idle": return "Belum ada pembaruan";
    case "loading": return "Membaca data publik";
    case "connected": return "Data berhasil dibaca";
    case "partial": return "Sebagian data gagal dimuat";
    case "error": return "Pembaruan gagal";
    case "paused": return "Pembaruan dijeda";
    case "offline": return "Perangkat offline";
  }
}

function probeLabel(value: AdminProbe["endpoint"]) {
  switch (value) {
    case "context": return "Daftar sumber";
    case "events": return "Daftar laporan";
    case "geometry": return "Lokasi laporan";
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
    case "healthy": return "Sumber tersedia";
    case "degraded": return "Sumber terganggu";
    case "unavailable": return "Sumber tidak tersedia";
    case "unknown": return "Status sumber belum diketahui";
  }
}

function stateBadgeClass(state: AdminItemState) {
  return `admin-state admin-state--${state}`;
}

function displayStateBadgeClass(item: AdminItem, mode: AdminMode) {
  // API presence is not a workflow state: don't style a public record as done/held.
  return mode === "simulation" ? stateBadgeClass(item.state) : "admin-state admin-state--public";
}

function datasetKindLabel(value: AdminItem["datasetKind"]) {
  switch (value) {
    case "live": return "Data publik";
    case "historical": return "Data historis";
    case "synthetic": return "Contoh rekaan";
  }
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
    return <span className="admin-dataset admin-dataset--demo">Server: contoh</span>;
  }
  if (mode === "live") {
    return <span className="admin-dataset admin-dataset--live">Server: data publik</span>;
  }
  return <span className="admin-dataset admin-dataset--unknown">Jenis data server belum diketahui</span>;
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
          <strong>{state.status === "offline" ? "Tidak ada koneksi." : "Pembaruan terbaru bermasalah."}</strong>
          <span>
            Status permintaan saat ini dipisahkan dari data yang sudah berhasil dibaca. Pembacaan berhasil terakhir tercatat pada {formatInstant(state.lastSuccessAt)}; hanya data yang lolos pemeriksaan yang ditampilkan.
          </span>
        </div>
      );
    }
    return null;
  }
  if (state.status === "loading" || state.status === "idle") {
    return (
      <div className="admin-inline-notice" role="status">
        <strong>{state.status === "loading" ? "Memuat data publik…" : "Belum ada data publik."}</strong>
        <span>Halaman hanya membaca sumber, satu halaman laporan, dan lokasi laporan yang tersedia.</span>
      </div>
    );
  }
  return (
    <div className="admin-inline-notice admin-inline-notice--attention" role="status">
      <strong>{state.status === "offline" ? "Tidak ada koneksi jaringan." : "Data belum tersedia."}</strong>
      <span>
        {state.status === "paused"
          ? "Pembaruan dijeda sebelum ada data yang berhasil dibaca."
          : `Belum ada data berhasil yang dapat ditampilkan. Pembaruan masih gagal atau belum selesai.${state.lastSuccessAt ? ` Pembacaan berhasil terakhir: ${formatInstant(state.lastSuccessAt)}.` : ""}`}
      </span>
      {state.status !== "offline" && (
        <button type="button" className="admin-button admin-button--quiet" onClick={onRefresh}>Coba lagi</button>
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
          <span className="admin-layer-chip">{mode === "simulation" ? LAYER_SHORT_NAMES[item.layer] : "Data"}</span>
          <span className={displayStateBadgeClass(item, mode)}>{itemDisplayStatus(item, mode)}</span>
          <span className="admin-queue-card__geometry">{mapped ? "Ada lokasi peta" : geometryKnown || mode === "simulation" ? "Tidak ada lokasi peta" : "Lokasi belum diketahui"}</span>
        </span>
        <strong className="admin-queue-card__title">{item.title}</strong>
        <span className="admin-queue-card__category">{categoryLabel(item.category)} · {item.placeLabel}</span>
        <span className="admin-queue-card__summary">{item.summary}</span>
        <span className="admin-queue-card__meta">
          <span>{mode === "simulation" ? "Contoh rekaan" : `Jenis data: ${datasetKindLabel(item.datasetKind)}`}</span>
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
          <div><p className="admin-kicker">Laporan terpilih</p><h2 id="admin-inspector-title">Detail laporan</h2></div>
        </div>
        <div className="admin-empty admin-empty--compact">
          <strong>Pilih laporan dari daftar atau peta.</strong>
          <p>Laporan tanpa lokasi di peta tetap tersedia di daftar.</p>
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
        <div><p className="admin-kicker">{mode === "simulation" ? "Contoh rekaan" : "Data aplikasi · baca saja"}</p><h2 id="admin-inspector-title">Detail laporan</h2></div>
        <span className={displayStateBadgeClass(item, mode)}>{itemDisplayStatus(item, mode)}</span>
      </div>

      <section className="admin-inspector__identity" aria-label="Ringkasan laporan">
        <h3>{item.title}</h3>
        <p>{item.summary}</p>
        <dl className="admin-facts">
          <div><dt>Kategori</dt><dd>{categoryLabel(item.category)}</dd></div>
          <div><dt>Lokasi</dt><dd>{item.placeLabel}</dd></div>
          <div><dt>Jenis data</dt><dd>{mode === "simulation" ? "Contoh rekaan" : datasetKindLabel(item.datasetKind)}</dd></div>
          <div><dt>Lokasi di peta</dt><dd>{mapped ? item.geometryBasis === "synthetic_example" ? "Contoh koordinat" : "Sesuai lokasi dari sumber" : mode === "public_api" && !geometryKnown ? "Belum diketahui" : "Tidak disertakan"}</dd></div>
        </dl>
      </section>

      <section className="admin-inspector__section" aria-labelledby="admin-evidence-title">
        <h3 id="admin-evidence-title">Sumber dan bukti</h3>
        <p className="admin-evidence-copy">{item.evidenceSummary || "Ringkasan bukti tidak tersedia pada record ini."}</p>
        {item.sourceNames.length > 0 ? (
          <ul className="admin-source-tags" aria-label="Nama sumber yang tercantum">
            {item.sourceNames.map((name) => <li key={name}>{name}</li>)}
          </ul>
        ) : <p className="admin-muted">Nama sumber tidak dicantumkan.</p>}
        {mapped ? (
          <p className="admin-geometry-note"><strong>{item.geometryBasis === "synthetic_example" ? "Lokasi contoh:" : "Lokasi dari sumber:"}</strong> {item.geometryNote}</p>
        ) : mode === "public_api" && !geometryKnown ? (
          <p className="admin-geometry-note"><strong>Lokasi belum diketahui.</strong> Data lokasi belum berhasil dibaca.</p>
        ) : (
          <p className="admin-geometry-note"><strong>Tidak ada lokasi peta.</strong> {item.geometryNote || "Sumber tidak menyertakan lokasi yang dapat dipetakan."}</p>
        )}
        {publishedPublicRecord && (
          <a className="admin-link" href={`#detail/api/${encodeURIComponent(item.publicEventId ?? "")}`}>
            Buka laporan publik lengkap
          </a>
        )}
      </section>

      {mode === "public_api" && (
        <section className="admin-inspector__section admin-public-status" aria-labelledby="admin-public-status-title">
          <div className="admin-panel-heading admin-panel-heading--tight">
            <div><p className="admin-kicker">Informasi dari sumber</p><h3 id="admin-public-status-title">Status dan waktu</h3></div>
          </div>
          {item.publicStatus ? (
            <dl className="admin-facts">
              <div><dt>Status laporan</dt><dd>{lifecycleLabel(item.publicStatus.lifecycle)}</dd></div>
              <div><dt>Kondisi informasi</dt><dd>{freshnessLabel(item.publicStatus.freshness.status)}</dd></div>
              <div><dt>Diperiksa pada</dt><dd>{formatInstant(item.publicStatus.freshness.evaluated_at)}</dd></div>
              <div><dt>Perlu ditinjau pada</dt><dd>{formatInstant(item.publicStatus.freshness.review_due_at)}</dd></div>
              <div><dt>Waktu kejadian atau pengamatan</dt><dd>{formatEventTime({ event_time: item.publicStatus.eventTime })}</dd></div>
              <div><dt>Masa berlaku menurut sumber</dt><dd>{validityLabel(item.publicStatus.validity)}</dd></div>
            </dl>
          ) : (
            <p className="admin-muted">Status dan waktu laporan tidak tersedia pada data ini.</p>
          )}
          <p className="admin-muted">Status laporan, kondisi informasi, waktu kejadian, dan masa berlaku memiliki arti berbeda.</p>
        </section>
      )}

      <details className="admin-disclosure admin-inspector__disclosure">
        <summary>Waktu, tautan sumber, dan ID</summary>
        <div className="admin-disclosure__content">
          <h3>Waktu pada laporan</h3>
          <dl className="admin-facts admin-facts--compact">
            {mode === "simulation" && <div><dt>Contoh dicatat</dt><dd>{formatInstant(item.observedAt)}</dd></div>}
            <div><dt>{mode === "simulation" ? "Contoh dibaca browser" : "Browser membaca data"}</dt><dd>{formatInstant(item.fetchedAt)}</dd></div>
            {publishedPublicRecord && <div><dt>Terbit pada data publik</dt><dd>{formatInstant(item.publishedAt)}</dd></div>}
          </dl>
          {mode === "public_api" && (
            <div className="admin-attributions">
              <h4>Tautan dan waktu sumber</h4>
              {publicSources.length > 0 ? (
                <>
                  <ul className="admin-attribution-list">
                    {publicSources.map((source, index) => (
                      <li key={`${source.url}-${index}`}>
                        <a href={source.url} referrerPolicy="no-referrer">{source.displayName}</a>
                        <dl className="admin-facts admin-facts--compact">
                          <div><dt>Sumber terbit</dt><dd>{source.publishedAt ? formatInstant(source.publishedAt) : "Waktu tidak dicantumkan"}</dd></div>
                          <div><dt>Sumber diamati</dt><dd>{source.observedAt ? formatInstant(source.observedAt) : "Waktu tidak dicantumkan"}</dd></div>
                        </dl>
                      </li>
                    ))}
                  </ul>
                  <p className="admin-muted">Hingga 20 tautan sumber ditampilkan. Laporan publik lengkap dapat memuat tautan lain.</p>
                </>
              ) : <p className="admin-muted">Data ini tidak menyertakan tautan sumber.</p>}
            </div>
          )}
          <h3>ID teknis</h3>
          <dl className="admin-facts admin-facts--compact">
            <div><dt>{mode === "simulation" ? "ID contoh" : "ID laporan publik"}</dt><dd>{mode === "simulation" ? item.id : item.publicEventId ?? "Tidak tersedia"}</dd></div>
            <div><dt>Versi laporan</dt><dd>{item.eventVersion ?? "Tidak tersedia"}</dd></div>
            <div><dt>Tahap saat ini</dt><dd>{mode === "simulation" ? `${item.layer} · ${LAYER_NAMES[item.layer]}` : "Status proses internal tidak tersedia"}</dd></div>
          </dl>
        </div>
      </details>

      <details className="admin-disclosure admin-inspector__disclosure">
        <summary>{mode === "simulation" ? "Urutan contoh dan batasnya" : "Data internal yang tidak tersedia"}</summary>
        <div className="admin-disclosure__content">
          {mode === "simulation" ? (
            <>
              <p className="admin-muted">Semua langkah di bawah adalah rekaan. Halaman ini tidak menjalankan sumber, model, atau tindakan.</p>
              <h3>Tahap yang tercatat</h3>
              <ol className="admin-timeline">
                {item.steps.map((step, index) => (
                  <li className="admin-timeline__step" key={`${step.layer}-${step.at ?? "unknown"}-${index}`}>
                    <span className="admin-timeline__layer">{LAYER_SHORT_NAMES[step.layer]}</span>
                    <div>
                      <strong>{step.label}</strong>
                      <p>{step.detail}</p>
                      <span>{itemStateLabel(step.state)}{step.at ? ` · ${formatInstant(step.at)}` : " · waktu tidak tercatat"}</span>
                    </div>
                  </li>
                ))}
                {item.steps.length === 0 && <li className="admin-timeline__empty">Belum ada tahap contoh untuk laporan ini.</li>}
              </ol>
              <section className="admin-inspector__section admin-gate" aria-labelledby="admin-l4-title">
                <h3 id="admin-l4-title">Tinjauan manusia tetap diperlukan</h3>
                {l4 ? <p><strong>{l4.label}:</strong> {l4.detail}</p> : <p>Contoh ini tidak mencatat keputusan tinjauan. Halaman tidak menentukan kelayakan publikasi.</p>}
              </section>
              <section className="admin-inspector__section admin-budget" aria-labelledby="admin-l3-title">
                <h3 id="admin-l3-title">Batas pemeriksaan</h3>
                {item.budget ? (
                  <>
                    <dl className="admin-budget-grid">
                      <div><dt>Tool</dt><dd>{item.budget.toolsUsed} / {item.budget.toolsLimit}</dd></div>
                      <div><dt>Langkah penalaran</dt><dd>{item.budget.reasoningUsed} / {item.budget.reasoningLimit}</dd></div>
                      <div><dt>Token</dt><dd>{item.budget.tokensUsed} / {item.budget.tokensLimit}</dd></div>
                      <div><dt>Waktu aktif</dt><dd>{item.budget.activeSecondsUsed} / {item.budget.activeSecondsLimit} dtk</dd></div>
                    </dl>
                    <p><strong>Hasil pemeriksaan:</strong> {l3 ? `${itemStateLabel(l3.state)} · ${l3.detail}` : "Tidak ada langkah pemeriksaan pada contoh."}</p>
                    <p><strong>Alasan berhenti:</strong> {item.stopReason ?? "Belum dicatat pada contoh."}</p>
                    <p><strong>Langkah berikutnya:</strong> {item.nextStep}</p>
                  </>
                ) : <p>Tidak ada batas pemeriksaan pada contoh ini.</p>}
              </section>
            </>
          ) : (
            <>
              <p>Data aplikasi hanya membaca informasi yang sudah tersedia melalui layanan publik. Halaman ini tidak melihat antrean, model, catatan moderator, audit, atau pekerjaan internal.</p>
              <p className="admin-public-record-note">{publishedPublicRecord
                ? `Laporan publik versi ${item.eventVersion ?? "tidak diketahui"} berasal dari respons layanan. Halaman ini tidak menetapkan atau mengubah status penerbitan.`
                : "Keputusan moderator dan status peninjauan internal tidak tersedia dari data publik."}</p>
              <p>Anggaran pemeriksaan, jumlah antrean, hasil model, dan alasan internal tidak disediakan oleh layanan publik.</p>
            </>
          )}
        </div>
      </details>
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
        <button type="button" className="admin-button admin-button--quiet" onClick={onPause}>Jeda contoh</button>
      ) : (
        <button type="button" className="admin-button admin-button--primary" onClick={onStart} disabled={step >= last}>Jalankan contoh</button>
      )}
      <button type="button" className="admin-button admin-button--quiet" onClick={onReplay}>Ulangi contoh</button>
      <span className="admin-transport__progress">Langkah {step + 1} dari {SIMULATION_STEPS.length}</span>
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
        <div><p className="admin-kicker">Rincian proses</p><h2 id="admin-layers-title">Tahap dalam proses</h2></div>
        <p>{mode === "simulation"
          ? "Urutan ini mengikuti contoh rekaan dan bergerak hanya setelah contoh dijalankan."
          : "Data publik tidak menampilkan pekerjaan internal. Hasil pembacaan browser di bawah hanya mencakup permintaan halaman ini."}</p>
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
            ? "laporan contoh"
            : layer.layer === "L1"
              ? "sumber dalam konteks"
              : layer.layer === "L4"
                ? "laporan publik pada halaman"
                : layer.layer === "L5"
                  ? "permintaan browser"
                  : "jumlah tidak tersedia";
          return (
            <li className={`admin-layer-card${unavailable ? " admin-layer-card--unavailable" : ""}`} key={layer.layer}>
              <div className="admin-layer-card__heading">
                <span className="admin-layer-chip">ID {layer.layer}</span>
                <span>{unavailable ? "Tidak tersedia" : mode === "simulation" ? "Contoh rekaan" : "Terlihat pada data"}</span>
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
                  ? `${monitorState.currentAttempt.probes.filter((probe) => probe.status === "succeeded").length} dari ${monitorState.currentAttempt.probes.length} permintaan browser berhasil pada pembaruan terakhir. Ini bukan status keseluruhan sistem.`
                  : "Pembaruan terakhir tidak menghasilkan catatan; kinerja layanan belum diketahui."}</p>
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
        <div className="admin-panel-heading"><div><p className="admin-kicker">Contoh rekaan</p><h2 id="admin-sources-title">Sumber pada contoh</h2></div><span className="admin-read-only-chip">Fiktif</span></div>
        {sources.length === 0 ? <p className="admin-muted">Skenario ini tidak mencantumkan nama sumber.</p> : (
          <ul className="admin-source-list">
          {sources.map((source) => <li key={source.id}><strong>{source.name}</strong><span>{source.note}</span><small>{sourceHealthLabel(source.health)} · hanya keterangan contoh</small></li>)}
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
    note: "Informasi ini berasal dari data publik.",
  })) ?? [];
  const contextAvailable = snapshot?.context !== null && snapshot?.context !== undefined || publicContext !== null;
  return (
    <section className="admin-support-panel" aria-labelledby="admin-sources-title">
      <div className="admin-panel-heading"><div><p className="admin-kicker">Daftar sumber</p><h2 id="admin-sources-title">Status sumber pada data publik</h2></div><span className="admin-read-only-chip">Baca saja</span></div>
      {sources.length === 0 ? (
        <div className="admin-empty admin-empty--compact">
          <strong>{contextAvailable ? "Daftar sumber kosong pada konteks publik." : "Konteks sumber publik tidak tersedia."}</strong>
          <p>{contextAvailable ? "Daftar kosong tidak berarti semua sumber tersedia." : "Status sumber belum diketahui karena data konteks belum berhasil dibaca."}</p>
        </div>
      ) : (
        <ul className="admin-source-list">
          {sources.map((source) => <li key={source.id}><strong>{source.name}</strong><span>{source.note}</span><small>{sourceHealthLabel(source.health)} · sukses terakhir {formatInstant(source.lastSuccessAt)}</small></li>)}
        </ul>
      )}
      <p className="admin-muted">Status sumber ini berasal dari layanan. Hasil pembacaan halaman dicatat terpisah.</p>
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
      <div className="admin-panel-heading"><div><p className="admin-kicker">Catatan pembacaan halaman</p><h2 id="admin-probes-title">Hasil permintaan browser</h2></div><span className="admin-read-only-chip">Baca saja</span></div>
      <p className="admin-muted">Waktu diukur pada browser. Ini bukan ukuran kinerja server, model, atau seluruh layanan.</p>
      {probes.length === 0 ? (
        <div className="admin-empty admin-empty--compact"><strong>{mode === "simulation" ? "Belum ada catatan pada contoh." : "Belum ada hasil permintaan."}</strong><p>Data kosong berarti belum teramati, bukan 0 ms atau berhasil.</p></div>
      ) : (
        <div className="admin-probe-table-wrap">
          <table className="admin-probe-table">
            <caption>{mode === "simulation" ? "Waktu dan status pada contoh" : `Pembaruan terakhir · ${formatInstant(state.currentAttempt?.at ?? state.attemptedAt)}`}</caption>
            <thead><tr><th scope="col">Data yang dibaca</th><th scope="col">Hasil</th><th scope="col">Waktu browser</th><th scope="col">Kode HTTP</th><th scope="col">Dicatat pada</th></tr></thead>
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
        <div className="admin-panel-heading"><div><p className="admin-kicker">Rincian yang tidak tersedia</p><h2 id="admin-activity-title">Aktivitas internal</h2></div><span className="admin-read-only-chip">Tidak tersedia</span></div>
        <div className="admin-empty admin-empty--compact"><strong>Data publik tidak memberikan antrean atau riwayat pekerjaan.</strong><p>Catatan moderator, kegagalan proses, dan audit tidak ditampilkan di sini.</p></div>
      </section>
    );
  }
  const activities = snapshot?.activities ?? [];
  return (
    <section className="admin-support-panel" aria-labelledby="admin-activity-title">
      <div className="admin-panel-heading"><div><p className="admin-kicker">Riwayat contoh</p><h2 id="admin-activity-title">Langkah terbaru</h2></div><span className="admin-read-only-chip">Fiktif</span></div>
      {activities.length === 0 ? (
        <div className="admin-empty admin-empty--compact"><strong>{mode === "simulation" ? "Belum ada catatan pada tahap ini." : "API publik tidak mengembalikan riwayat operasi internal."}</strong><p>{mode === "simulation" ? "Jalankan simulasi lokal untuk melihat urutan fixture." : "Riwayat moderator, antrean privat, dan audit tidak tersedia di sini."}</p></div>
      ) : (
        <ol className="admin-activity-list">
          {activities.slice(0, 8).map((activity) => (
            <li key={activity.id}>
              <time dateTime={activity.at}>{formatInstant(activity.at)}</time>
              <div><strong>{activity.layer} · {activity.label}</strong><p>{activity.detail}</p></div>
              {activity.itemId && snapshot?.items.some((item) => item.id === activity.itemId) && (
                <button type="button" className="admin-text-button" onClick={() => onSelect(activity.itemId ?? "")}>Pilih laporan</button>
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
    ? "Tidak ada laporan yang cocok dengan filter."
    : mode === "simulation"
      ? "Belum ada laporan pada contoh ini."
      : !apiDatasetReady
        ? "Jenis data server belum dikonfirmasi."
      : publicListProbe?.status === "succeeded"
        ? "Data publik tidak menyertakan laporan."
        : publicListProbe?.status === "failed"
          ? "Daftar laporan gagal dibaca."
          : "Belum ada laporan publik yang dimuat.";
  const emptyQueueDetail = sourceItems.length > 0
    ? "Ubah atau hapus filter untuk melihat kembali laporan yang sudah dimuat."
    : mode === "simulation"
      ? "Pilih tahap contoh lain atau jalankan contoh."
      : !apiDatasetReady
        ? "Laporan dan lokasi dari pembacaan sebelumnya tetap tersembunyi sampai jenis data berhasil diketahui."
      : publicListProbe?.status === "succeeded"
        ? "Hasil kosong bukan pernyataan bahwa kondisi di lapangan aman."
        : publicListProbe?.status === "failed"
          ? "Daftar tidak tersedia saat ini. Data yang tidak diketahui tidak dihitung sebagai nol."
          : viewMonitorState.status === "paused"
            ? "Pembaruan dijeda. Lanjutkan pembaruan untuk membaca data publik."
            : "Kegagalan atau hasil kosong tidak menunjukkan bahwa kondisi aman.";

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
          <p className="admin-kicker">Pengelola · baca saja</p>
          <h1>Laporan dan peta</h1>
          <p className="admin-header__lede">Pilih laporan untuk melihat sumber, waktu, status informasi, dan lokasinya di peta.</p>
        </div>
        <div className="admin-header__actions">
          <a className="admin-button admin-button--quiet" href="#tinjau-bukti">Tinjau bukti publik</a>
        </div>
      </header>

      <section className="admin-mode-strip" aria-label="Pilih jenis informasi">
        <div className="admin-mode-switch" role="group" aria-label="Mode data">
          <button type="button" aria-pressed={mode === "simulation"} onClick={() => changeMode("simulation")}>Contoh tampilan</button>
          <button type="button" aria-pressed={mode === "public_api"} onClick={() => changeMode("public_api")}>Data aplikasi</button>
        </div>
        <div className="admin-mode-strip__state">
          {mode === "simulation" ? (
            <span className="admin-connection admin-connection--simulation"><i aria-hidden="true" />Contoh · {simulationPlaying ? documentVisible ? "berjalan" : "menunggu halaman terlihat" : "berhenti"}</span>
          ) : (
            <span className={`admin-connection admin-connection--${viewMonitorState.status}`} aria-live="polite"><i aria-hidden="true" />{monitorStateLabel(viewMonitorState.status)}</span>
          )}
          {mode === "public_api" && <PublicDatasetBadge datasetMode={currentApiContext?.dataset_mode ?? null} />}
        </div>
      </section>

      <section className={`admin-provenance admin-provenance--${mode}`} aria-label="Asal dan batas data">
        {mode === "simulation" ? (
          <>
            <strong>Semua laporan dan lokasi di sini adalah rekaan.</strong>
            <p>Contoh bergerak hanya saat dijalankan. Halaman ini tidak menghubungi sumber, memakai model, atau mengubah data.</p>
          </>
        ) : (
          <>
            <strong>Data aplikasi hanya dibaca.</strong>
            <p>
              Halaman membaca laporan dan lokasi yang sudah tersedia untuk umum. Ini bukan pemantauan operasi privat; antrean, model, dan tinjauan internal tidak terlihat. Label server menjelaskan jenis dataset, bukan keadaan seluruh layanan.
            </p>
          </>
        )}
      </section>

      <section className="admin-controls" aria-label="Kontrol dan pencarian laporan">
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
          <div className="admin-transport" aria-label="Pembaruan data aplikasi">
            <button type="button" className="admin-button admin-button--primary" onClick={refresh} disabled={!monitoringEnabled || viewMonitorState.status === "loading"}>
              {viewMonitorState.status === "loading" ? "Memuat…" : "Perbarui laporan"}
            </button>
            <button type="button" className="admin-button admin-button--quiet" onClick={toggleMonitoring}>
              {monitoringEnabled ? "Jeda pembaruan" : "Lanjutkan pembaruan"}
            </button>
            <span className="admin-transport__progress">Pembaruan tiap 30 detik saat halaman terlihat</span>
            {viewMonitorState.status === "offline" && <span className="admin-transport__paused">Permintaan menunggu koneksi jaringan.</span>}
          </div>
        )}
        <label className="admin-filter admin-filter--search">
          <span>Cari laporan</span>
          <input type="search" value={query} onChange={(event) => setQuery(event.currentTarget.value)} placeholder="Judul, lokasi, sumber…" />
        </label>
        <details className="admin-disclosure admin-filter-disclosure">
          <summary>Filter laporan</summary>
          <div className="admin-filter-grid">
            <label className="admin-filter">
              <span>Tahap contoh</span>
              <select
                value={mode === "simulation" ? layerFilter : "all"}
                disabled={mode === "public_api"}
                onChange={(event) => setLayerFilter(event.currentTarget.value as AdminLayer | "all")}
              >
                {mode === "simulation"
                  ? LAYER_OPTIONS.map((option) => <option value={option.value} key={option.value}>{option.label}</option>)
                  : <option value="all">Tidak tersedia pada data publik</option>}
              </select>
            </label>
            <label className="admin-filter">
              <span>Status contoh</span>
              <select
                value={mode === "simulation" ? stateFilter : "all"}
                disabled={mode === "public_api"}
                onChange={(event) => setStateFilter(event.currentTarget.value as AdminItemState | "all")}
              >
                {mode === "simulation"
                  ? STATUS_OPTIONS.map((option) => <option value={option.value} key={option.value}>{option.label}</option>)
                  : <option value="all">Tidak tersedia pada data publik</option>}
              </select>
            </label>
            <label className="admin-filter">
              <span>Lokasi di peta</span>
              <select
                value={mode === "public_api" && !geometryKnown ? "all" : geometryFilter}
                disabled={mode === "public_api" && !geometryKnown}
                onChange={(event) => setGeometryFilter(event.currentTarget.value as AdminItemFilters["geometry"])}
              >
                <option value="all">{mode === "public_api" && !geometryKnown ? "Belum diketahui" : "Semua laporan"}</option>
                <option value="mapped">Ada di peta</option>
                <option value="unmapped">Tidak ada di peta</option>
              </select>
            </label>
            <button type="button" className="admin-button admin-button--quiet admin-filter__clear" onClick={() => { setQuery(""); setLayerFilter("all"); setStateFilter("all"); setGeometryFilter("all"); }}>Hapus filter</button>
          </div>
        </details>
      </section>

      <SnapshotNotice mode={mode} state={viewMonitorState} snapshot={snapshot} onRefresh={refresh} />

      <section id="admin-workspace" tabIndex={-1} className={`admin-workspace admin-workspace--mobile-${mobileView}`} aria-label="Daftar laporan, peta, dan detail">
        <div className="admin-mobile-switch" role="group" aria-label="Tampilan pada layar kecil">
          <button type="button" aria-pressed={mobileView === "list"} onClick={() => setMobileView("list")}>Daftar</button>
          <button type="button" aria-pressed={mobileView === "map"} onClick={() => setMobileView("map")}>Peta</button>
        </div>

        <section className="admin-queue" aria-labelledby="admin-queue-title">
          <div className="admin-panel-heading">
            <div><p className="admin-kicker">{mode === "simulation" ? "Contoh rekaan" : "Data yang tersedia"}</p><h2 id="admin-queue-title">Daftar laporan</h2></div>
            <span className="admin-total-count">{publicListKnown ? `${filteredItems.length} / ${sourceItems.length}` : "—"}</span>
          </div>
          <div className="admin-queue__coverage" aria-live="polite">
            <span><strong>{publicListKnown && publicGeometryKnown ? geometryCounts.mapped ?? "—" : "—"}</strong> di peta</span>
            {publicListKnown && publicGeometryKnown
              ? <span><strong>{geometryCounts.unmapped ?? "—"}</strong> tanpa lokasi peta</span>
              : publicListKnown
                ? <span><strong>{geometryCounts.unknown}</strong> lokasi belum diketahui</span>
                : <span><strong>—</strong> lokasi belum diketahui</span>}
            <span>{publicListKnown ? `dari ${geometryCounts.total} laporan pada hasil filter` : "Jumlah laporan belum diketahui"}</span>
          </div>
          {mode === "public_api" && viewMonitorState.lastSuccessAt && (
            <p className="admin-observation-time">Data berhasil dibaca pada: <time dateTime={viewMonitorState.lastSuccessAt}>{formatInstant(viewMonitorState.lastSuccessAt)}</time></p>
          )}
          <p className="admin-coverage-note">Jumlah hanya mencakup laporan yang sudah dimuat dan cocok dengan filter.</p>
          {filteredItems.length > 0 ? (
            <ul className="admin-queue__list">
              {filteredItems.map((item) => <QueueCard key={item.id} item={item} mode={mode} geometryKnown={geometryKnown} selected={selectedId === item.id} onSelect={selectItem} />)}
            </ul>
          ) : (
            <div className="admin-empty">
              <strong>{emptyQueueTitle}</strong>
              <p>{emptyQueueDetail}</p>
              {mode === "public_api" && !monitoringEnabled && <button type="button" className="admin-button admin-button--quiet" onClick={toggleMonitoring}>Lanjutkan pembaruan</button>}
              {mode === "public_api" && monitoringEnabled && viewMonitorState.status !== "loading" && viewMonitorState.status !== "offline" && (
                <button type="button" className="admin-button admin-button--quiet" onClick={refresh}>Perbarui laporan</button>
              )}
            </div>
          )}
        </section>

        <section className="admin-map-panel" aria-labelledby="admin-map-title">
          <div className="admin-panel-heading">
            <div><p className="admin-kicker">{mode === "simulation" ? "Lokasi rekaan" : "Lokasi dari sumber"}</p><h2 id="admin-map-title">Peta laporan</h2></div>
            <span className="admin-read-only-chip">{mode === "simulation" ? "Contoh" : "Baca saja"}</span>
          </div>
          {mode === "public_api" && !publicListKnown
            ? <p className="admin-map-empty-note">Daftar laporan belum berhasil dimuat. Lokasi laporan belum dapat dihitung.</p>
            : mode === "public_api" && !geometryKnown
              ? <p className="admin-map-empty-note" role="status">Lokasi belum berhasil dibaca. Laporan tetap tersedia di daftar, tetapi jumlah yang memiliki lokasi belum diketahui.</p>
            : <AdminOperationsMap items={filteredItems} selectedId={selectedId} onSelect={selectItem} mode={mode} />}
          <p className="admin-map-footnote">{mode === "simulation"
            ? "Lokasi pada peta hanya contoh rekaan; bukan jalan, batas resmi, atau area bahaya."
            : !publicListKnown
              ? "Peta menunggu daftar laporan publik yang berhasil dibaca."
            : geometryKnown
              ? "Lokasi mengikuti data sumber. Halaman tidak membuat radius bahaya atau lokasi pengganti."
              : "Data lokasi belum berhasil dibaca. Laporan yang belum tampil belum tentu tidak memiliki lokasi."}</p>
        </section>

        <AdminRecordInspector item={selectedItem} mode={mode} geometryKnown={geometryKnown} />
      </section>

      <details className="admin-disclosure admin-diagnostics">
        <summary>Rincian proses, sumber, dan pembacaan</summary>
        <div className="admin-diagnostics__content">
          <LayerOverview snapshot={snapshot} mode={mode} monitorState={viewMonitorState} />
          <section className="admin-support-grid" aria-label="Status sumber, riwayat, dan hasil pembacaan">
            <PublicSources snapshot={snapshot} mode={mode} publicContext={currentApiContext} />
            <RecentActivity snapshot={snapshot} mode={mode} onSelect={selectItem} />
            <ProbeObservations state={viewMonitorState} mode={mode} snapshot={snapshot} />
          </section>
        </div>
      </details>

      <footer className="admin-footer">
        <strong>Halaman ini hanya membaca data.</strong>
        <p>Halaman tidak mengambil laporan dari sumber, menjalankan pemeriksaan, atau mengubah status laporan.</p>
        <a className="admin-link" href="#tinjau-bukti">Buka tinjau bukti publik</a>
        <span aria-hidden="true"> · </span>
        <a className="admin-link" href="#beranda">Kembali ke Waspada Jakarta</a>
      </footer>
    </main>
  );
}

export default AdminDashboard;
