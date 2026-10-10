import * as React from "react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { PreviewKind, PreviewRecord, PreviewSource, SourcePreviewPayload } from "@waspada/worker/source-preview-contracts";
import { getSourcePreview, type SourcePreviewRequestMode } from "./source-preview-client.js";

export type SourcePreviewMapRenderer = (
  points: readonly PreviewRecord[],
  selectedId: string | null,
  onSelect: (id: string) => void,
  onReturnToList: () => void,
) => ReactNode;

export interface SourcePreviewProps {
  datasetMode: "demo" | "live" | null;
  renderMap?: SourcePreviewMapRenderer;
  contextSources?: ReactNode;
}

type RequestState =
  | { status: "not-requested" }
  | { status: "loading"; mode: SourcePreviewRequestMode }
  | { status: "loaded"; mode: SourcePreviewRequestMode }
  | { status: "error"; mode: SourcePreviewRequestMode };
type MobileView = "list" | "map";
type SourceFilter = PreviewRecord["source"] | "all";
type KindFilter = PreviewKind | "all";

const kindLabels: Readonly<Record<PreviewKind, string>> = {
  hospital: "Rumah sakit",
  police: "Kepolisian",
  fire_station: "Pemadam kebakaran",
  flood_report: "Laporan banjir warga",
};
const kindSymbols: Readonly<Record<PreviewKind, string>> = {
  hospital: "H",
  police: "P",
  fire_station: "D",
  flood_report: "B",
};

function sourceName(id: PreviewRecord["source"] | PreviewSource["id"]): string {
  return id === "osm" ? "OpenStreetMap" : "PetaBencana.id";
}

function formatTime(value: string): string {
  return new Intl.DateTimeFormat("id-ID", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Jakarta",
  }).format(new Date(value)) + " WIB";
}

function timeValue(value: string | null, missing: string): ReactNode {
  return value === null
    ? <span>{missing}</span>
    : React.createElement("time", { dateTime: value }, formatTime(value));
}

function statusLabel(source: PreviewSource): string {
  switch (source.status) {
    case "available": return "Ada record pratinjau";
    case "empty": return "Respons sumber kosong";
    case "unavailable": return "Sumber tidak tersedia";
    case "not_requested": return "Belum diminta";
  }
}

function errorLabel(source: PreviewSource): string | null {
  switch (source.error) {
    case "timeout": return "Waktu tunggu sumber berakhir.";
    case "http_error": return "Sumber tidak memberi respons yang dapat digunakan.";
    case "invalid_payload": return "Data sumber tidak sesuai format pratinjau.";
    case null: return null;
  }
}

function dataModeLabel(source: PreviewSource, cached: boolean): string {
  if (source.data_mode === "snapshot") return "Snapshot lokal demo; penyedia tidak dihubungi untuk data ini.";
  if (source.data_mode === "none") return "Belum ada data yang diminta dari penyedia.";
  return cached
    ? "Hasil permintaan eksplisit yang masih disimpan sementara oleh server."
    : "Hasil permintaan eksplisit Ambil data sumber.";
}

export function SourcePreviewStatusCard({
  source,
  cached,
}: {
  source: PreviewSource;
  cached: boolean;
}) {
  const isOsm = source.id === "osm";
  const sourceTitle = isOsm ? "OpenStreetMap · fasilitas rujukan" : "PetaBencana.id · laporan warga";
  const sourceUpdatedLabel = isOsm ? "Waktu basis data OpenStreetMap" : "Waktu pembaruan yang disediakan sumber";
  const sourceFetchedLabel = source.status === "unavailable"
    ? "Permintaan dicoba pada"
    : source.status === "available" || source.status === "empty"
      ? "Data diambil pada"
      : "Waktu pengambilan sumber";
  const sourceEmptyCopy = isOsm
    ? "Tidak ada fasilitas pada respons ini. Ini bukan gambaran keseluruhan Jakarta."
    : "Tidak ada laporan pada respons ini. Hasil kosong tidak berarti Jakarta aman.";
  const sourceTimeMissing = isOsm
    ? "Tidak tersedia dari sumber. Waktu ini bukan waktu perubahan fasilitas tertentu."
    : "Tidak tersedia dari penyedia.";

  return (
    <article className={"source-preview__source-card source-preview__source-card--" + source.status} aria-labelledby={"source-preview-source-" + source.id}>
      <div className="source-preview__source-heading">
        <div>
          <h3 id={"source-preview-source-" + source.id}>{sourceTitle}</h3>
        </div>
        <span className="source-preview__source-status">{statusLabel(source)}</span>
      </div>
      <p className="source-preview__source-mode">{dataModeLabel(source, cached)}</p>
      {source.status === "empty" && <p className="source-preview__source-note">{sourceEmptyCopy}</p>}
      {source.status === "unavailable" && <p className="source-preview__source-note">{errorLabel(source) ?? "Data sumber tidak dapat ditampilkan."}</p>}
      {source.status === "not_requested" && (
        <p className="source-preview__source-note">
          {isOsm ? "Data fasilitas belum diminta dari sumber." : "PetaBencana hanya dihubungi setelah tombol Ambil data sumber dipilih."}
        </p>
      )}
      {source.status !== "not_requested" && (
        <dl className="source-preview__source-times">
          <div>
            <dt>{sourceFetchedLabel}</dt>
            <dd>{timeValue(source.fetched_at, "Tidak tersedia dari penyedia.")}</dd>
          </div>
          <div>
            <dt>{sourceUpdatedLabel}</dt>
            <dd>{timeValue(source.source_updated_at, sourceTimeMissing)}</dd>
          </div>
        </dl>
      )}
      {source.limited && <p className="source-preview__source-note">Jumlah record dibatasi; daftar ini tidak lengkap.</p>}
      {source.rejected_count > 0 && (
        <p className="source-preview__source-note">{source.rejected_count} record tidak dimasukkan ke pratinjau karena tidak memenuhi batas sumber.</p>
      )}
    </article>
  );
}

export function SourcePreviewRecordDetails({ record }: { record: PreviewRecord | null }) {
  if (!record) {
    return (
      <section className="source-preview__selected" aria-live="polite" aria-labelledby="source-preview-selected-title">
        <h2 id="source-preview-selected-title">Detail pilihan</h2>
        <p>Pilih satu record di daftar atau peta untuk melihat waktu, status sumber, dan tautannya.</p>
      </section>
    );
  }
  const isOsm = record.source === "osm";
  const sourceTimeMissing = isOsm
    ? "Perubahan fasilitas ini tidak memiliki waktu individual. Stempel basis data di atas bukan waktu perubahan lokasi ini."
    : "Waktu pembuatan laporan tidak disediakan penyedia. Waktu kejadian fisik juga tidak tersedia dari sumber.";
  const coordinateCopy = record.coordinate_kind === "source_extent_center"
    ? "Titik tengah perkiraan dari area objek OpenStreetMap; bukan lokasi insiden atau pintu masuk."
    : "Titik koordinat yang disediakan sumber.";

  return (
    <section className="source-preview__selected" aria-live="polite" aria-labelledby="source-preview-selected-title">
      <div className="source-preview__selected-title-row">
        <div>
          <p className="source-preview__source-eyebrow">{sourceName(record.source)} · {kindLabels[record.kind]}</p>
          <h2 id="source-preview-selected-title">{record.title}</h2>
        </div>
        <span className="source-preview__kind-symbol" aria-hidden="true">{kindSymbols[record.kind]}</span>
      </div>
      <dl className="source-preview__record-details">
        <div>
          <dt>{isOsm ? "Waktu perubahan lokasi" : "Laporan dibuat di sumber"}</dt>
          <dd>{timeValue(record.source_created_at, sourceTimeMissing)}</dd>
        </div>
        <div>
          <dt>Status penyedia</dt>
          <dd>
            {record.source_status === null ? "Tidak diberikan oleh penyedia." : record.source_status + " · status penyedia saja, belum diverifikasi Waspada."}
          </dd>
        </div>
        <div>
          <dt>Koordinat</dt>
          <dd>{coordinateCopy}</dd>
        </div>
      </dl>
      {!isOsm && <p className="source-preview__record-note">Waktu kejadian fisik tidak tersedia dari sumber; waktu di atas hanya waktu pembuatan laporan.</p>}
      <a className="source-preview__source-link" href={record.source_url} target="_blank" rel="noreferrer">
        Buka sumber {sourceName(record.source)} <span aria-hidden="true">↗</span>
      </a>
    </section>
  );
}

export function SourcePreviewRequestError({
  mode,
  onRetrySnapshot,
}: {
  mode: SourcePreviewRequestMode;
  onRetrySnapshot: () => void;
}) {
  return (
    <div className="source-preview__request-error" role="alert">
      <strong>{mode === "snapshot" ? "Snapshot demo tidak dapat dimuat." : "Permintaan data sumber gagal."}</strong>
      <p>
        {mode === "snapshot"
          ? "Tidak ada data pengganti yang ditampilkan. Coba muat ulang snapshot lokal atau minta data sumber secara terpisah."
          : "Tidak ada data pengganti yang ditampilkan. Anda dapat kembali ke snapshot atau meminta sumber lagi."}
      </p>
      {mode === "snapshot" && (
        <button className="button button--quiet" type="button" onClick={onRetrySnapshot}>
          Coba muat snapshot
        </button>
      )}
    </div>
  );
}

function FlowStrip() {
  return (
    <ol className="source-preview__flow" aria-label="Alur pratinjau lima lapisan">
      <li><span>L1</span><strong>Ambil, validasi &amp; normalisasi</strong></li>
      <li><span>L2</span><strong>Model/RAG belum dijalankan</strong></li>
      <li><span>L3</span><strong>Investigasi belum dijalankan</strong></li>
      <li><span>L4</span><strong>Tampilkan pratinjau sumber</strong></li>
      <li><span>L5</span><strong>Batas, status &amp; privasi</strong></li>
    </ol>
  );
}

function SourceRecordList({
  title,
  records,
  selectedId,
  onSelect,
}: {
  title: string;
  records: readonly PreviewRecord[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  return (
    <section className="source-preview__record-group" aria-label={title}>
      <h3>{title}</h3>
      {records.length === 0 ? (
        <p className="source-preview__list-empty">Belum ada record pada kelompok ini di hasil filter.</p>
      ) : (
        <ul>
          {records.map((record) => (
            <li key={record.id}>
              <button
                className="source-preview__record-button"
                type="button"
                aria-pressed={selectedId === record.id}
                onClick={() => onSelect(record.id)}
              >
                <span className={"source-preview__kind-symbol source-preview__kind-symbol--" + record.source} aria-hidden="true">{kindSymbols[record.kind]}</span>
                <span className="source-preview__record-copy">
                  <strong>{record.title}</strong>
                  <span>{kindLabels[record.kind]} · {sourceName(record.source)}</span>
                </span>
                <span className="source-preview__record-chevron" aria-hidden="true">›</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function SourcePreview({ datasetMode, renderMap, contextSources }: SourcePreviewProps) {
  const [request, setRequest] = useState<RequestState>(() =>
    datasetMode === "demo" ? { status: "loading", mode: "snapshot" } : { status: "not-requested" },
  );
  const [payload, setPayload] = useState<SourcePreviewPayload | null>(null);
  const [query, setQuery] = useState("");
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>("all");
  const [kindFilter, setKindFilter] = useState<KindFilter>("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [mobileView, setMobileView] = useState<MobileView>("list");
  const activeController = useRef<AbortController | null>(null);
  const requestSequence = useRef(0);

  const startRequest = useCallback((mode: SourcePreviewRequestMode) => {
    if (datasetMode !== "demo") return;
    activeController.current?.abort();
    const controller = new AbortController();
    activeController.current = controller;
    const sequence = ++requestSequence.current;
    setPayload(null);
    setSelectedId(null);
    setMobileView("list");
    setRequest({ status: "loading", mode });
    void getSourcePreview({ mode, signal: controller.signal }).then((nextPayload) => {
      if (controller.signal.aborted || sequence !== requestSequence.current) return;
      setPayload(nextPayload);
      setRequest({ status: "loaded", mode });
      activeController.current = null;
    }).catch(() => {
      if (controller.signal.aborted || sequence !== requestSequence.current) return;
      setPayload(null);
      setRequest({ status: "error", mode });
      activeController.current = null;
    });
  }, [datasetMode]);

  useEffect(() => {
    if (datasetMode !== "demo") {
      activeController.current?.abort();
      activeController.current = null;
      requestSequence.current += 1;
      setPayload(null);
      setRequest({ status: "not-requested" });
      setSelectedId(null);
      return;
    }
    startRequest("snapshot");
    return () => {
      activeController.current?.abort();
      activeController.current = null;
      requestSequence.current += 1;
    };
  }, [datasetMode, startRequest]);

  const records = useMemo(() => payload?.sources.flatMap((source) => source.records) ?? [], [payload]);
  const visibleRecords = useMemo(() => {
    const search = query.trim().toLocaleLowerCase("id");
    return records.filter((record) => {
      const matchesSearch = search.length === 0 ||
        (record.title + " " + kindLabels[record.kind] + " " + sourceName(record.source)).toLocaleLowerCase("id").includes(search);
      return matchesSearch &&
        (sourceFilter === "all" || record.source === sourceFilter) &&
        (kindFilter === "all" || record.kind === kindFilter);
    });
  }, [records, query, sourceFilter, kindFilter]);
  const selectedRecord = visibleRecords.find((record) => record.id === selectedId) ?? null;
  const facilityRecords = visibleRecords.filter((record) => record.source === "osm");
  const reportRecords = visibleRecords.filter((record) => record.source === "petabencana");
  const isLoading = request.status === "loading";
  const canUsePreview = datasetMode === "demo";

  const selectMapRecord = useCallback((id: string) => {
    if (visibleRecords.some((record) => record.id === id)) setSelectedId(id);
  }, [visibleRecords]);
  const returnToList = useCallback(() => setMobileView("list"), []);
  const showSnapshot = useCallback(() => startRequest("snapshot"), [startRequest]);
  const fetchSources = useCallback(() => startRequest("fetch"), [startRequest]);

  return (
    <main id="main-content" className="main-shell source-preview" aria-busy={isLoading}>
      <section className="source-preview__intro" aria-labelledby="source-preview-title">
        <div>
          <p className="section-kicker">Demo sumber · tampilan terpisah</p>
          <h1 id="source-preview-title">Pratinjau data dari sumber</h1>
          <p className="source-preview__intro-copy">
            Titik fasilitas adalah rujukan; laporan warga bukan zona bahaya. Cakupan demo bukan batas administrasi atau penilaian keselamatan.
          </p>
          {contextSources && <a href="#context-sources" onClick={(event) => {
            event.preventDefault();
            document.getElementById("context-sources")?.scrollIntoView({ behavior: "instant", block: "start" });
          }}>Lihat konteks cuaca &amp; gempa ↓</a>}
        </div>
        <p className="source-preview__disclaimer">Pratinjau sumber — belum melalui publikasi Waspada</p>
      </section>

      <FlowStrip />

      <section className="source-preview__controls" aria-label="Kontrol pratinjau sumber">
        <div className="source-preview__controls-copy">
          <strong>{datasetMode === "demo" ? "Mode demo terkonfirmasi" : datasetMode === "live" ? "Mode live" : "Mode dataset belum terkonfirmasi"}</strong>
          <span>
            {datasetMode === "demo"
              ? "Snapshot dimuat otomatis. Permintaan ke sumber hanya berjalan setelah Ambil data sumber dipilih."
              : datasetMode === "live"
                ? "Pratinjau ini hanya tersedia saat server mengonfirmasi mode demo. Tidak ada permintaan sumber yang dilakukan."
                : "Pratinjau sumber tidak dimuat sampai server mengonfirmasi mode demo."}
          </span>
        </div>
        <div className="source-preview__actions">
          <button className="button button--primary" type="button" disabled={!canUsePreview || isLoading} onClick={fetchSources}>
            {isLoading && request.status === "loading" && request.mode === "fetch" ? "Meminta data…" : "Ambil data sumber"}
          </button>
          {request.status !== "not-requested" && request.mode === "fetch" && (
            <button className="button button--quiet" type="button" disabled={isLoading || !canUsePreview} onClick={showSnapshot}>
              Kembali ke snapshot
            </button>
          )}
        </div>
      </section>

      {!canUsePreview && (
        <p className="source-preview__guard-state" role="status">
          {datasetMode === "live"
            ? "Pratinjau sumber demo tidak tersedia pada mode live."
            : "Status dataset belum tersedia; tidak ada permintaan atau data pratinjau yang ditampilkan."}
        </p>
      )}
      {isLoading && (
        <p className="source-preview__request-state" role="status">
          {request.status === "loading" && request.mode === "snapshot" ? "Memuat snapshot lokal demo…" : "Meminta sumber atas tindakan Anda…"}
        </p>
      )}
      {request.status === "error" && (
        <SourcePreviewRequestError mode={request.mode} onRetrySnapshot={showSnapshot} />
      )}

      {payload && request.status === "loaded" && (
        <>
          <section className="source-preview__summary" aria-label="Ringkasan hasil pratinjau">
            <div>
              <strong>{request.mode === "snapshot" ? "Snapshot pratinjau" : "Hasil permintaan sumber"}</strong>
              <span>
                Respons dibuat <time dateTime={payload.generated_at}>{formatTime(payload.generated_at)}</time>
                {payload.cached ? " · hasil sementara dalam cache server" : ""}
              </span>
            </div>
            <p>{visibleRecords.length} record cocok dengan pencarian dan filter. Cakupan mengikuti respons pratinjau ini.</p>
          </section>

          <section className="source-preview__sources" aria-label="Status tiap sumber">
            {payload.sources.map((source) => (
              <SourcePreviewStatusCard key={source.id} source={source} cached={payload.cached} />
            ))}
          </section>

          <section className="source-preview__filters" aria-label="Cari dan filter record pratinjau">
            <label className="source-preview__search" htmlFor="source-preview-search">
              Cari fasilitas atau kategori
              <input
                id="source-preview-search"
                type="search"
                autoComplete="off"
                value={query}
                onChange={(event) => setQuery(event.currentTarget.value)}
                placeholder="Contoh: rumah sakit"
              />
            </label>
            <label htmlFor="source-preview-source-filter">
              Sumber
              <select id="source-preview-source-filter" value={sourceFilter} onChange={(event) => setSourceFilter(event.currentTarget.value as SourceFilter)}>
                <option value="all">Semua sumber</option>
                <option value="osm">OpenStreetMap</option>
                <option value="petabencana">PetaBencana.id</option>
              </select>
            </label>
            <label htmlFor="source-preview-kind-filter">
              Jenis
              <select id="source-preview-kind-filter" value={kindFilter} onChange={(event) => setKindFilter(event.currentTarget.value as KindFilter)}>
                <option value="all">Semua jenis</option>
                {Object.entries(kindLabels).map(([kind, label]) => <option key={kind} value={kind}>{label}</option>)}
              </select>
            </label>
            <button
              className="button button--quiet source-preview__clear-filters"
              type="button"
              disabled={query.length === 0 && sourceFilter === "all" && kindFilter === "all"}
              onClick={() => { setQuery(""); setSourceFilter("all"); setKindFilter("all"); }}
            >
              Hapus filter
            </button>
          </section>

          <div className="source-preview__mobile-switch" role="group" aria-label="Bagian pratinjau pada layar kecil">
            <button type="button" aria-pressed={mobileView === "list"} onClick={() => setMobileView("list")}>Daftar</button>
            <button type="button" aria-pressed={mobileView === "map"} onClick={() => setMobileView("map")}>Peta</button>
          </div>

          {visibleRecords.length === 0 && (
            <p className="source-preview__no-records" role="status">
              Tidak ada record yang cocok dengan filter ini. Hasil kosong tidak berarti Jakarta aman.
            </p>
          )}
          <div className="source-preview__columns" data-mobile-view={mobileView}>
            <div className="source-preview__list-column" aria-label="Daftar record pratinjau">
              <SourceRecordList title="Fasilitas rujukan · OpenStreetMap" records={facilityRecords} selectedId={selectedId} onSelect={setSelectedId} />
              <SourceRecordList title="Laporan warga · belum ditinjau" records={reportRecords} selectedId={selectedId} onSelect={setSelectedId} />
            </div>
            <section className="source-preview__map-column" aria-label="Peta record pratinjau">
              {renderMap
                ? renderMap(visibleRecords, selectedRecord?.id ?? null, selectMapRecord, returnToList)
                : <p className="source-preview__map-fallback">Peta belum tersedia. Daftar, waktu, atribusi, dan tautan sumber tetap dapat digunakan.</p>}
              {visibleRecords.length === 0 && <p className="source-preview__map-empty">Tidak ada titik pada filter ini. Hasil kosong tidak menunjukkan keadaan aman.</p>}
            </section>
          </div>

          <SourcePreviewRecordDetails record={selectedRecord} />
        </>
      )}

      <section className="source-preview__attribution" aria-label="Atribusi dan lisensi sumber">
        <strong>Penggunaan non-komersial untuk demo universitas.</strong>
        <p>
          © OpenStreetMap contributors · ODbL 1.0 — <a href="https://opendatacommons.org/licenses/odbl/1-0/" target="_blank" rel="noreferrer">baca lisensi ODbL</a>.
        </p>
        <p>
          Data disediakan oleh PetaBencana.id, dilisensikan di bawah CC BY-NC 4.0 — <a href="https://creativecommons.org/licenses/by-nc/4.0/" target="_blank" rel="noreferrer">baca lisensi CC BY-NC 4.0</a>.
        </p>
        <p>Tidak ada teks laporan warga, identitas, foto, atau tautan media sosial yang ditampilkan.</p>
      </section>
      {contextSources}
    </main>
  );
}
