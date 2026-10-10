import * as React from "react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type {
  ContextSourcesPayload,
  EarthquakeContextRecord,
  EarthquakeContextSource,
  WeatherContextSource,
} from "@waspada/worker/context-sources-contracts";
import {
  ContextSourcesHttpError,
  ContextSourcesPayloadError,
  ContextSourcesTimeoutError,
  getContextSources,
  type ContextSourcesRequestMode,
} from "./context-sources-client.js";

export type ContextSourcesMapRenderer = (
  points: readonly EarthquakeContextRecord[],
  selectedId: string | null,
  onSelect: (id: string) => void,
) => ReactNode;

export interface ContextSourcesProps {
  datasetMode: "demo" | "live" | null;
  renderMap?: ContextSourcesMapRenderer;
}

type RequestState =
  | { status: "not-requested" }
  | { status: "loading"; mode: ContextSourcesRequestMode }
  | { status: "loaded"; mode: ContextSourcesRequestMode }
  | { status: "error"; mode: ContextSourcesRequestMode; message: string };

const weatherCodeLabels: Readonly<Record<number, string>> = {
  0: "Cerah",
  1: "Umumnya cerah",
  2: "Cerah berawan",
  3: "Berawan",
  45: "Kabut",
  48: "Kabut beku",
  51: "Gerimis ringan",
  53: "Gerimis sedang",
  55: "Gerimis lebat",
  56: "Gerimis beku ringan",
  57: "Gerimis beku lebat",
  61: "Hujan ringan",
  63: "Hujan sedang",
  65: "Hujan lebat",
  66: "Hujan beku ringan",
  67: "Hujan beku lebat",
  71: "Salju ringan",
  73: "Salju sedang",
  75: "Salju lebat",
  77: "Butiran salju",
  80: "Hujan sesaat ringan",
  81: "Hujan sesaat sedang",
  82: "Hujan sesaat lebat",
  85: "Hujan salju sesaat ringan",
  86: "Hujan salju sesaat lebat",
  95: "Hujan petir",
  96: "Hujan petir dengan es ringan",
  99: "Hujan petir dengan es lebat",
};

function formatTime(value: string, includeDate = true): string {
  const date = new Intl.DateTimeFormat("id-ID", includeDate
    ? { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Jakarta" }
    : { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: "Asia/Jakarta" },
  ).format(new Date(value));
  return date + " WIB";
}

function timeValue(value: string | null, missing: string): ReactNode {
  return value === null
    ? missing
    : React.createElement("time", { dateTime: value }, formatTime(value));
}

function requestErrorMessage(error: unknown, mode: ContextSourcesRequestMode): string {
  if (error instanceof ContextSourcesTimeoutError) return "Batas waktu permintaan habis. Coba lagi bila diperlukan.";
  if (error instanceof ContextSourcesHttpError) return "Status data pratinjau tidak dapat dimuat dari server.";
  if (error instanceof ContextSourcesPayloadError) return "Respons konteks tidak sesuai format yang dapat ditampilkan.";
  if (error instanceof Error && error.name === "AbortError") return "Permintaan dibatalkan.";
  return mode === "local"
    ? "Status konteks lokal belum dapat dimuat. Tidak ada data pengganti yang ditampilkan."
    : "Permintaan konteks tidak dapat diselesaikan. Tidak ada data pengganti yang ditampilkan.";
}

function sourceErrorLabel(source: WeatherContextSource | EarthquakeContextSource): string | null {
  switch (source.error) {
    case "timeout": return "Waktu tunggu sumber berakhir.";
    case "http_error": return "Sumber tidak memberi respons yang dapat digunakan.";
    case "invalid_payload": return "Data sumber tidak sesuai dengan format konteks.";
    case null: return null;
  }
}

function sourceStatusLabel(source: WeatherContextSource | EarthquakeContextSource): string {
  switch (source.status) {
    case "available": return "Konteks tersedia";
    case "empty": return "Respons kosong";
    case "unavailable": return "Sumber tidak tersedia";
    case "not_requested": return "Belum diminta";
  }
}

function sourceModeLabel(source: WeatherContextSource | EarthquakeContextSource, cached: boolean): string {
  if (source.data_mode === "none") return "Belum ada permintaan ke penyedia.";
  return cached
    ? "Hasil permintaan eksplisit tersimpan sementara di server."
    : "Hasil dari permintaan eksplisit ke penyedia.";
}

function Attribution({ source }: { source: WeatherContextSource | EarthquakeContextSource }) {
  return (
    <div className="context-sources__attribution">
      <p>{source.attribution}</p>
      <p>
        <a href={source.source_url} target="_blank" rel="noreferrer">Buka sumber</a>
        <span aria-hidden="true"> · </span>
        <a href={source.license_url} target="_blank" rel="noreferrer">Lisensi dan ketentuan</a>
      </p>
    </div>
  );
}

function SourceTimes({ source, updatedLabel, updatedMissing }: {
  source: WeatherContextSource | EarthquakeContextSource;
  updatedLabel: string;
  updatedMissing: string;
}) {
  const fetchedLabel = source.status === "unavailable" ? "Permintaan dicoba pada" : "Data diambil pada";
  return (
    <dl className="context-sources__times">
      <div>
        <dt>{source.fetched_at === null ? "Waktu pengambilan" : fetchedLabel}</dt>
        <dd>{timeValue(source.fetched_at, "Belum ada permintaan ke penyedia.")}</dd>
      </div>
      <div>
        <dt>{updatedLabel}</dt>
        <dd>{timeValue(source.source_updated_at, updatedMissing)}</dd>
      </div>
    </dl>
  );
}

function SourceStatusNote({ source }: { source: WeatherContextSource | EarthquakeContextSource }) {
  if (source.status === "not_requested") {
    return <p className="context-sources__state-note">Sumber ini belum diminta. Memuat status lokal tidak menghubungi penyedia.</p>;
  }
  if (source.status === "unavailable") {
    return <p className="context-sources__state-note" role="status">
      {sourceErrorLabel(source) ?? "Data sumber tidak tersedia."} Nilainya tidak diketahui.
    </p>;
  }
  return null;
}

function SourceHeader({ source, title, titleId, cached }: {
  source: WeatherContextSource | EarthquakeContextSource;
  title: string;
  titleId: string;
  cached: boolean;
}) {
  return (
    <div className="context-sources__provider-heading">
      <div>
        <p className="context-sources__eyebrow">Konteks sumber eksternal</p>
        <h3 id={titleId}>{title}</h3>
      </div>
      <span className={"context-sources__status context-sources__status--" + source.status}>
        {sourceStatusLabel(source)}
      </span>
      <p className="context-sources__mode">{sourceModeLabel(source, cached)}</p>
    </div>
  );
}

function formatNumber(value: number, maximumFractionDigits = 1): string {
  return new Intl.NumberFormat("id-ID", { maximumFractionDigits }).format(value);
}

function coordinatesLabel(coordinates: [number, number]): string {
  return formatNumber(coordinates[1], 5) + "° lintang, " + formatNumber(coordinates[0], 5) + "° bujur";
}

function WeatherHourCell({ value, unit }: { value: number | null; unit: string }) {
  return value === null ? <span className="context-sources__unknown">Tidak diketahui</span> : <span>{formatNumber(value)} {unit}</span>;
}

export function WeatherForecastTable({ source }: { source: WeatherContextSource }) {
  if (source.forecast === null) return null;
  const { forecast } = source;
  return (
    <div className="context-sources__forecast">
      <div className="context-sources__forecast-heading">
        <div>
          <p className="context-sources__eyebrow">Keluaran model</p>
          <h4>Prakiraan model · {forecast.hours.length} jam pada respons</h4>
        </div>
        <p>Jam berlaku adalah waktu prakiraan model, bukan waktu pengamatan atau penerbitan model.</p>
      </div>
      <dl className="context-sources__weather-location">
        <div>
          <dt>Sampel yang diminta</dt>
          <dd>{coordinatesLabel(forecast.requested_coordinates)}</dd>
        </div>
        <div>
          <dt>Titik grid model</dt>
          <dd>{coordinatesLabel(forecast.model_coordinates)}</dd>
        </div>
      </dl>
      <div className="context-sources__table-scroll" role="region" aria-label="Tabel prakiraan cuaca, dapat digeser mendatar" tabIndex={0}>
        <table className="context-sources__forecast-table">
          <caption>Prakiraan Open-Meteo per jam untuk sampel Jakarta</caption>
          <thead>
            <tr>
              <th scope="col">Waktu berlaku</th>
              <th scope="col">Suhu</th>
              <th scope="col">Hujan satu jam sebelumnya</th>
              <th scope="col">Kondisi model</th>
              <th scope="col">Angin</th>
            </tr>
          </thead>
          <tbody>
            {forecast.hours.map((hour) => (
              <tr key={hour.valid_at}>
                <th scope="row"><time dateTime={hour.valid_at}>{formatTime(hour.valid_at, false)}</time></th>
                <td><WeatherHourCell value={hour.temperature_c} unit="°C" /></td>
                <td>
                  <span className="context-sources__quantity-label">Akumulasi: <WeatherHourCell value={hour.precipitation_mm} unit="mm" /></span>
                  <span className="context-sources__quantity-label">Peluang model: <WeatherHourCell value={hour.precipitation_probability_pct} unit="%" /></span>
                </td>
                <td>{hour.weather_code === null
                  ? <span className="context-sources__unknown">Tidak diketahui</span>
                  : <><span>{weatherCodeLabels[hour.weather_code] ?? "Kondisi cuaca"}</span><small> · WMO {hour.weather_code}</small></>}
                </td>
                <td><WeatherHourCell value={hour.wind_speed_kmh} unit="km/jam" /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="context-sources__footnote">
        Curah hujan adalah akumulasi model selama satu jam sebelumnya; peluang hujan adalah nilai persentase model yang terpisah.
        Data model ini bukan peringatan banjir atau kejadian yang diamati.
      </p>
    </div>
  );
}

export function WeatherContextCard({ source, cached }: { source: WeatherContextSource; cached: boolean }) {
  return (
    <article className={"context-sources__provider context-sources__provider--" + source.status} aria-labelledby="context-sources-weather-title">
      <SourceHeader source={source} title="Cuaca · Open-Meteo" titleId="context-sources-weather-title" cached={cached} />
      <SourceTimes
        source={source}
        updatedLabel="Waktu penerbitan atau pembaruan model"
        updatedMissing="Tidak disediakan penyedia; waktu proses API bukan waktu penerbitan model."
      />
      <SourceStatusNote source={source} />
      {source.status === "empty" && <p className="context-sources__state-note">Respons tidak memuat jam prakiraan. Nilai cuaca tidak diketahui.</p>}
      {source.status === "available" && source.forecast !== null && <WeatherForecastTable source={source} />}
      {source.limited && <p className="context-sources__state-note">Jumlah jam prakiraan dibatasi oleh sumber.</p>}
      {source.rejected_count > 0 && <p className="context-sources__state-note">{source.rejected_count} nilai sumber tidak memenuhi batas validasi.</p>}
      <Attribution source={source} />
    </article>
  );
}

function magnitudeLabel(record: EarthquakeContextRecord): string {
  return record.magnitude === null ? "Magnitudo tidak disediakan" : "Magnitudo " + formatNumber(record.magnitude, 2);
}

export function EarthquakeRecordDetails({ record, fetchedAt }: { record: EarthquakeContextRecord | null; fetchedAt: string | null }) {
  if (record === null) {
    return (
      <section className="context-sources__earthquake-detail" aria-live="polite" aria-labelledby="context-sources-quake-detail-title">
        <h4 id="context-sources-quake-detail-title">Detail pilihan</h4>
        <p>Pilih gempa pada daftar untuk melihat asal, pembaruan sumber, dan metadata katalog.</p>
      </section>
    );
  }
  const sourceStatus = record.source_status === null
    ? "Tidak disediakan oleh USGS."
    : record.source_status === "reviewed"
      ? "Reviewed · status dari USGS saja; belum diverifikasi Waspada Jakarta."
      : "Automatic · status dari USGS saja; belum diverifikasi Waspada Jakarta.";
  return (
    <section className="context-sources__earthquake-detail" aria-live="polite" aria-labelledby="context-sources-quake-detail-title">
      <div className="context-sources__detail-heading">
        <div>
          <p className="context-sources__eyebrow">Episentrum katalog · USGS</p>
          <h4 id="context-sources-quake-detail-title">{record.title}</h4>
        </div>
        <span className="context-sources__quake-symbol" aria-hidden="true">G</span>
      </div>
      <dl className="context-sources__record-facts">
        <div>
          <dt>Asal kejadian</dt>
          <dd>{timeValue(record.event_time, "Tidak diketahui.")}</dd>
        </div>
        <div>
          <dt>Pembaruan sumber</dt>
          <dd>{timeValue(record.updated_at, "Tidak diketahui.")}</dd>
        </div>
        <div>
          <dt>Data diambil</dt>
          <dd>{timeValue(fetchedAt, "Waktu pengambilan tidak tersedia.")}</dd>
        </div>
        <div>
          <dt>Magnitudo</dt>
          <dd>{magnitudeLabel(record)}</dd>
        </div>
        <div>
          <dt>Tipe magnitudo</dt>
          <dd>{record.magnitude_type ?? "Tidak disediakan oleh sumber."}</dd>
        </div>
        <div>
          <dt>Kedalaman</dt>
          <dd>{formatNumber(record.depth_km, 1)} km</dd>
        </div>
        <div>
          <dt>Status sumber</dt>
          <dd>{sourceStatus}</dd>
        </div>
        <div>
          <dt>Koordinat episentrum</dt>
          <dd>{coordinatesLabel(record.coordinates)}</dd>
        </div>
      </dl>
      <p className="context-sources__impact-note">Titik menunjukkan episentrum katalog, bukan area dampak. Data kawasan ini tidak menyimpulkan dampak di Jakarta.</p>
      <a className="context-sources__source-link" href={record.source_url} target="_blank" rel="noreferrer">
        Buka record USGS <span aria-hidden="true">↗</span>
      </a>
    </section>
  );
}

export function EarthquakeContextCard({
  source,
  cached,
  selectedId,
  onSelect,
  renderMap,
}: {
  source: EarthquakeContextSource;
  cached: boolean;
  selectedId: string | null;
  onSelect: (id: string) => void;
  renderMap?: ContextSourcesMapRenderer;
}) {
  const selectedRecord = source.records.find((record) => record.id === selectedId) ?? null;
  const selectRecord = (id: string) => {
    if (source.records.some((record) => record.id === id)) onSelect(id);
  };
  return (
    <article className={"context-sources__provider context-sources__provider--" + source.status} aria-labelledby="context-sources-quake-title">
      <SourceHeader source={source} title="Gempa kawasan · katalog USGS" titleId="context-sources-quake-title" cached={cached} />
      <SourceTimes
        source={source}
        updatedLabel="Pembaruan katalog dari sumber"
        updatedMissing="Waktu pembaruan katalog tidak disediakan."
      />
      {source.data_mode === "fetched" && source.window_start && source.window_end && (
        <div className="context-sources__quake-window">
          <strong>Kueri katalog regional · tujuh hari</strong>
          <span>{formatTime(source.window_start)} – {formatTime(source.window_end)}</span>
          <span>Filter magnitudo ≥ 2,5 · hingga 30 record.</span>
          <span>Wilayah kueri memberi konteks kawasan; bukan batas resmi atau area dampak Jakarta.</span>
        </div>
      )}
      {source.status === "not_requested" && <SourceStatusNote source={source} />}
      {source.status === "unavailable" && <SourceStatusNote source={source} />}
      {source.status === "empty" && (
        <p className="context-sources__state-note">
          Katalog tidak mengembalikan record pada jendela ini. Hasil kosong tidak menetapkan keselamatan atau dampak di Jakarta.
        </p>
      )}
      {source.status === "available" && (
        <>
          <section className="context-sources__earthquake-list" aria-label="Gempa kawasan dari USGS">
            <h4>Daftar episentrum</h4>
            <ul>
              {source.records.map((record) => (
                <li key={record.id}>
                  <button
                    className="context-sources__earthquake-option"
                    type="button"
                    aria-pressed={selectedRecord?.id === record.id}
                    onClick={() => selectRecord(record.id)}
                  >
                    <span className="context-sources__quake-symbol" aria-hidden="true">G</span>
                    <span className="context-sources__earthquake-copy">
                      <strong>{record.title}</strong>
                      <span>{magnitudeLabel(record)} · {formatTime(record.event_time)}</span>
                    </span>
                    <span className="context-sources__chevron" aria-hidden="true">›</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
          {source.limited && <p className="context-sources__state-note">Daftar dibatasi hingga jumlah record yang ditetapkan kueri; hasil mungkin tidak lengkap.</p>}
          {source.rejected_count > 0 && <p className="context-sources__state-note">{source.rejected_count} record sumber tidak dimasukkan karena tidak memenuhi batas validasi.</p>}
          <EarthquakeRecordDetails record={selectedRecord} fetchedAt={source.fetched_at} />
          <details className="context-sources__map-disclosure">
            <summary>Lihat peta kawasan (opsional)</summary>
            {!renderMap && <p className="context-sources__impact-note">
              Episentrum tidak menunjukkan luas guncangan atau dampak. Cakupan katalog regional ini tidak menetapkan dampak di Jakarta.
            </p>}
            {renderMap
              ? renderMap(source.records, selectedRecord?.id ?? null, selectRecord)
              : <p className="context-sources__map-fallback">Peta belum tersedia. Daftar, metadata, atribusi, dan tautan record tetap dapat digunakan.</p>}
          </details>
        </>
      )}
      <Attribution source={source} />
    </article>
  );
}

function ContextRequestError({ state, onRetry, onReset }: {
  state: Extract<RequestState, { status: "error" }>;
  onRetry: () => void;
  onReset: () => void;
}) {
  return (
    <div className="context-sources__request-error" role="alert">
      <strong>{state.mode === "local" ? "Status konteks tidak dapat dimuat." : "Permintaan konteks tidak berhasil."}</strong>
      <p>{state.message}</p>
      <div className="context-sources__actions">
        <button className="button button--quiet" type="button" onClick={onRetry}>Coba lagi</button>
        {state.mode === "fetch" && <button className="button button--quiet" type="button" onClick={onReset}>Kembali ke belum diminta</button>}
      </div>
    </div>
  );
}

export function ContextSources({ datasetMode, renderMap }: ContextSourcesProps) {
  const [request, setRequest] = useState<RequestState>({ status: "not-requested" });
  const [payload, setPayload] = useState<ContextSourcesPayload | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const activeController = useRef<AbortController | null>(null);
  const requestSequence = useRef(0);

  const startRequest = useCallback((mode: ContextSourcesRequestMode) => {
    if (datasetMode !== "demo") return;
    activeController.current?.abort();
    const controller = new AbortController();
    activeController.current = controller;
    const sequence = ++requestSequence.current;
    setPayload(null);
    setSelectedId(null);
    setRequest({ status: "loading", mode });
    void getContextSources({ mode, signal: controller.signal }).then((nextPayload) => {
      if (controller.signal.aborted || sequence !== requestSequence.current) return;
      setPayload(nextPayload);
      setRequest({ status: "loaded", mode });
      activeController.current = null;
    }).catch((error: unknown) => {
      if (controller.signal.aborted || sequence !== requestSequence.current) return;
      setPayload(null);
      setRequest({ status: "error", mode, message: requestErrorMessage(error, mode) });
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
    startRequest("local");
    return () => {
      activeController.current?.abort();
      activeController.current = null;
      requestSequence.current += 1;
    };
  }, [datasetMode, startRequest]);

  const canUseContext = datasetMode === "demo";
  const isLoading = request.status === "loading";
  const loadedPayload = canUseContext && request.status === "loaded" ? payload : null;
  const weather = loadedPayload?.sources[0] ?? null;
  const earthquakes = loadedPayload?.sources[1] ?? null;
  const selectedRecord = earthquakes?.records.find((record) => record.id === selectedId) ?? null;
  const retry = useCallback(() => {
    startRequest(request.status === "error" ? request.mode : "fetch");
  }, [request, startRequest]);
  const reset = useCallback(() => startRequest("local"), [startRequest]);
  const selectRecord = useCallback((id: string) => {
    if (earthquakes?.records.some((record) => record.id === id)) setSelectedId(id);
  }, [earthquakes]);

  return (
    <section id="context-sources" className="context-sources" aria-labelledby="context-sources-title" aria-busy={isLoading}>
      <div className="context-sources__intro">
        <div>
          <p className="section-kicker">Konteks tambahan · pratinjau terpisah</p>
          <h2 id="context-sources-title">Konteks cuaca &amp; gempa</h2>
          <p>
            Prakiraan model dan katalog gempa regional ditampilkan sebagai konteks sumber. Keduanya tidak membuat atau memverifikasi insiden Waspada Jakarta.
          </p>
        </div>
        <span className="context-sources__stamp">Belum melalui publikasi Waspada</span>
      </div>

      <div className="context-sources__controls" aria-label="Kontrol konteks cuaca dan gempa">
        <div>
          <strong>{datasetMode === "demo" ? "Mode demo terkonfirmasi" : datasetMode === "live" ? "Mode live" : "Mode dataset belum terkonfirmasi"}</strong>
          <span>
            {datasetMode === "demo"
              ? "Status lokal tidak menghubungi penyedia. Pengambilan cuaca dan gempa hanya berjalan setelah Anda memilih tombol."
              : datasetMode === "live"
                ? "Konteks eksternal hanya tersedia pada mode demo. Tidak ada permintaan yang dilakukan."
                : "Status dataset belum tersedia; tidak ada permintaan atau data konteks yang ditampilkan."}
          </span>
        </div>
        <div className="context-sources__actions">
          <button className="button button--primary" type="button" disabled={!canUseContext || isLoading} onClick={() => startRequest("fetch")}>
            {request.status === "loading" && request.mode === "fetch" ? "Meminta konteks…" : "Ambil konteks cuaca & gempa"}
          </button>
          {request.status === "loaded" && request.mode === "fetch" && (
            <button className="button button--quiet" type="button" disabled={isLoading} onClick={reset}>
              Kembali ke belum diminta
            </button>
          )}
        </div>
      </div>

      {!canUseContext && (
        <p className="context-sources__guard" role="status">
          {datasetMode === "live"
            ? "Konteks sumber demo tidak tersedia pada mode live."
            : "Data konteks tidak ditampilkan sampai server mengonfirmasi mode demo."}
        </p>
      )}
      {isLoading && (
        <p className="context-sources__loading" role="status">
          {request.status === "loading" && request.mode === "local"
            ? "Memuat status konteks lokal; penyedia belum dihubungi…"
            : "Meminta konteks dari penyedia atas tindakan Anda…"}
        </p>
      )}
      {request.status === "error" && <ContextRequestError state={request} onRetry={retry} onReset={reset} />}

      {loadedPayload && weather && earthquakes && (
        <>
          <div className="context-sources__summary" aria-label="Ringkasan konteks">
            <strong>{request.status === "loaded" && request.mode === "fetch" ? "Hasil permintaan konteks" : "Status konteks lokal"}</strong>
            <span>
              Respons dibuat <time dateTime={loadedPayload.generated_at}>{formatTime(loadedPayload.generated_at)}</time>
              {loadedPayload.cached ? " · hasil sementara dalam cache server" : ""}
            </span>
          </div>
          <div className="context-sources__providers">
            <WeatherContextCard source={weather} cached={loadedPayload.cached} />
            <EarthquakeContextCard
              source={earthquakes}
              cached={loadedPayload.cached}
              selectedId={selectedRecord?.id ?? null}
              onSelect={selectRecord}
              renderMap={renderMap}
            />
          </div>
        </>
      )}
      <p className="context-sources__boundary-note">
        Data kosong atau tidak tersedia menunjukkan bahwa status tidak diketahui. Data konteks ini bukan konfirmasi keselamatan, peringatan resmi, atau hasil verifikasi dampak.
      </p>
    </section>
  );
}
