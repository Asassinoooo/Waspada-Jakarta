import * as React from "react";
import {
  useCallback, useEffect, useMemo, useRef, useState, type ReactNode
}
from "react";
import type {
  PreviewKind, PreviewRecord, PreviewSource, SourcePreviewPayload
}
from "@waspada/worker/source-preview-contracts";
import type {
  ContextSourcesPayload, ContextSourceMetadata, ContextSourceStatus, EarthquakeContextRecord, WeatherContextSource,
}
from "@waspada/worker/context-sources-contracts";
import { CONTEXT_SOURCE_POLICY } from "@waspada/worker/context-sources-contracts";
import {
  ContextSourcesHttpError, ContextSourcesPayloadError, ContextSourcesTimeoutError, getContextSources, type ContextSourcesRequestMode,
}
from "./context-sources-client.js";
import {
  SourcePreviewHttpError, SourcePreviewPayloadError, SourcePreviewTimeoutError, getSourcePreview, type SourcePreviewRequestMode,
}
from "./source-preview-client.js";
import {
  EarthquakeRecordDetails, WeatherForecastTable
}
from "./ContextSources.js";
import {
  SourcePreviewRecordDetails, SourcePreviewStatusCard
}
from "./SourcePreview.js";
import type {
  SourceMapPoint
}
from "./SourcePointMap.js";
export type UnifiedSourceMapRenderer = ( points: readonly SourceMapPoint[], selectedId: string | null, onSelect: (id: string) => void, onReturnToList: () => void,) => ReactNode;
export interface UnifiedSourceExplorerProps {
  datasetMode: "demo" | "live" | null;
  renderMap?: UnifiedSourceMapRenderer;
}
export type UnifiedExplorerPanel = "daftar" | "detail" | "cuaca" | "sumber";
export type UnifiedSourceFilter = SourceMapPoint["source"] | "all";
export type UnifiedKindFilter = PreviewKind | "earthquake" | "all";
export type UnifiedRequestMode = SourcePreviewRequestMode | ContextSourcesRequestMode;
export type UnifiedRequestState = | {
  status: "idle"
}
| {
  status: "loading";
  mode: UnifiedRequestMode
}
| {
  status: "loaded";
  mode: UnifiedRequestMode
}
| {
  status: "error";
  mode: UnifiedRequestMode;
  message: string
}
;
export interface UnifiedSourceExplorerViewProps {
  datasetMode: "demo" | "live" | null;
  sourcePayload: SourcePreviewPayload | null;
  sourceRequest: UnifiedRequestState;
  contextPayload: ContextSourcesPayload | null;
  contextRequest: UnifiedRequestState;
  renderMap?: UnifiedSourceMapRenderer;
  onSourceRequest: (mode: SourcePreviewRequestMode) => void;
  onContextRequest: (mode: ContextSourcesRequestMode) => void;
  defaultPanel?: UnifiedExplorerPanel;
}
const kindLabels: Readonly<Record<PreviewKind | "earthquake", string>> = {
  hospital: "Rumah sakit", police: "Kepolisian", fire_station: "Pemadam kebakaran", flood_report: "Laporan banjir warga", earthquake: "Gempa bumi regional",
}
;
const panelLabels: Readonly<Record<UnifiedExplorerPanel, string>> = {
  daftar: "Daftar", detail: "Detail", cuaca: "Cuaca", sumber: "Sumber",
}
;
const sourceLabels: Readonly<Record<SourceMapPoint["source"], string>> = {
  osm: "OpenStreetMap", petabencana: "PetaBencana.id", usgs: "USGS",
}
;
function formatTime(value: string): string {
  return new Intl.DateTimeFormat("id-ID", {
    dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Jakarta",
}
  ).format(new Date(value)) + " WIB";
}
function formatPolicyNumber(value: number): string {
  return new Intl.NumberFormat("id-ID", { maximumFractionDigits: 1 }).format(value);
}
function statusLabel(status: ContextSourceStatus | PreviewSource["status"] | "loading" | "error" | "idle"): string {
  switch (status) {
    case "available": return "Ada record";
    case "empty": return "Respons kosong";
    case "unavailable": return "Tidak tersedia";
    case "not_requested": return "Belum diminta";
    case "loading": return "Memuat";
    case "error": return "Gagal dimuat";
    case "idle": return "Tidak dimuat";
  }
}
function requestGroupStatus( request: UnifiedRequestState, payloadStatus: ContextSourceStatus | PreviewSource["status"] | undefined,): string {
  if (request.status === "loading") return statusLabel("loading");
  if (request.status === "error") return statusLabel("error");
  if (request.status === "idle" || payloadStatus === undefined) return statusLabel("idle");
  return statusLabel(payloadStatus);
}
function sourceStatusError(error: unknown, group: "source" | "context"): string {
  if (group === "source") {
    if (error instanceof SourcePreviewTimeoutError) return "Permintaan sumber melewati batas waktu.";
    if (error instanceof SourcePreviewHttpError) return "Server tidak memberi respons pratinjau yang dapat digunakan.";
    if (error instanceof SourcePreviewPayloadError) return "Respons sumber tidak sesuai format pratinjau.";
    return "Snapshot atau data sumber tidak dapat dimuat.";
  }
  if (error instanceof ContextSourcesTimeoutError) return "Permintaan konteks melewati batas waktu.";
  if (error instanceof ContextSourcesHttpError) return "Server tidak memberi respons konteks yang dapat digunakan.";
  if (error instanceof ContextSourcesPayloadError) return "Respons konteks tidak sesuai format pratinjau.";
  return "Status lokal atau data konteks tidak dapat dimuat.";
}
function previewSourceStatus(payload: SourcePreviewPayload | null, id: PreviewSource["id"]): PreviewSource["status"] | undefined {
  return payload?.sources.find((source) => source.id === id)?.status;
}
function contextSourceStatus(payload: ContextSourcesPayload | null, id: "openmeteo" | "usgs"): ContextSourceStatus | undefined {
  return payload?.sources.find((source) => source.id === id)?.status;
}
/** Combine only validated point records; model-grid coordinates are not incident markers. */
export function collectUnifiedSourcePoints( sourcePayload: SourcePreviewPayload | null, contextPayload: ContextSourcesPayload | null,): SourceMapPoint[] {
  return [ ...(sourcePayload?.sources.flatMap((source) => source.records) ?? []), ...(contextPayload?.sources.find((source) => source.id === "usgs")?.records ?? []), ];
}
/** One selector drives the combined list and map. */
export function filterUnifiedSourcePoints( points: readonly SourceMapPoint[], filters: {
  query?: string;
  source?: UnifiedSourceFilter;
  kind?: UnifiedKindFilter
}
= {
}
,): SourceMapPoint[] {
  const search = (filters.query ?? "").trim().toLocaleLowerCase("id");
  return points.filter((point) => {
    const matchesSearch = search.length === 0 || `${point.title} ${kindLabels[point.kind]} ${sourceLabels[point.source]}`.toLocaleLowerCase("id").includes(search);
    return matchesSearch && ((filters.source ?? "all") === "all" || point.source === filters.source) && ((filters.kind ?? "all") === "all" || point.kind === filters.kind);
  }
  );
}
/** A hidden or reset record cannot resolve to a current detail or map marker. */
export function resolveVisibleSourceSelection(points: readonly SourceMapPoint[], selectedId: string | null): SourceMapPoint | null {
  return selectedId === null ? null : points.find((point) => point.id === selectedId) ?? null;
}
export function retainVisibleSourceSelection(points: readonly SourceMapPoint[], selectedId: string | null): string | null {
  return resolveVisibleSourceSelection(points, selectedId)?.id ?? null;
}
function SourceStatusChip({
  label, status
}
: {
  label: string;
  status: string
}
) {
  return <span className="unified-source-explorer__status-chip">
  <span>{
    label
}
  </span>
  <strong>{
    status
}
  </strong>
  </span>;
}
function GroupRequestState({
  request, onRetry, retryLabel
}
: {
  request: UnifiedRequestState;
  onRetry: () => void;
  retryLabel: string;
}
) {
  if (request.status !== "error") return null;
  return <div className="unified-source-explorer__request-error" role="alert">
  <span>{
    request.message
}
  </span>
  <button className="button button--quiet" type="button" onClick={
    onRetry
}
  >{
    retryLabel
}
  </button>
  </div>;
}
function RecordList({
  points, selectedId, onSelect
}
: {
  points: readonly SourceMapPoint[];
  selectedId: string | null;
  onSelect: (point: SourceMapPoint) => void;
}
) {
  if (points.length === 0) {
    return <p className="unified-source-explorer__empty-list" role="status">Tidak ada record yang cocok dengan filter. Hasil kosong bukan pernyataan bahwa Jakarta aman.</p>;
  }
  return ( <ul className="unified-source-explorer__record-list" aria-label="Record dari seluruh sumber"> {
    points.map((point) => ( <li key={
      `${point.source}:${point.id}`
}
    > <button className="unified-source-explorer__record" type="button" aria-pressed={
      selectedId === point.id
}
    onClick={
      () => onSelect(point)
}
    > <span className={
      `unified-source-explorer__record-symbol unified-source-explorer__record-symbol--${point.source}`
}
    aria-hidden="true"> {
      point.kind === "hospital" ? "H" : point.kind === "police" ? "P" : point.kind === "fire_station" ? "D" : point.kind === "flood_report" ? "B" : "G"
}
    </span> <span className="unified-source-explorer__record-copy">
    <strong>{
      point.title
}
    </strong>
    <span>{
      kindLabels[point.kind]
}
    · {
      sourceLabels[point.source]
}
    </span>
    </span> <span className="unified-source-explorer__record-chevron" aria-hidden="true">›</span> </button> </li> ))
}
  </ul> );
}
function SourceMetadataCard({
  title, source, generatedAt, cached
}
: {
  title: string;
  source: ContextSourceMetadata & {
    id: string;
    window_start?: string | null;
    window_end?: string | null
}
  ;
  generatedAt: string;
  cached: boolean;
}
) {
  const modeCopy = source.data_mode === "none" ? "Status lokal; penyedia belum diminta." : cached ? "Hasil permintaan eksplisit yang masih disimpan sementara oleh server." : "Hasil permintaan eksplisit; waktu pengambilan terpisah dari waktu sumber.";
  const errorCopy = source.error === "timeout" ? "Batas waktu permintaan habis." : source.error === "http_error" ? "Penyedia tidak memberi respons yang dapat digunakan." : source.error === "invalid_payload" ? "Respons penyedia tidak sesuai format yang diizinkan." : null;
  return ( <article className={
    `unified-source-explorer__source-card unified-source-explorer__source-card--${source.status}`
}
  > <div className="unified-source-explorer__source-heading">
  <h3>{
    title
}
  </h3>
  <span>{
    statusLabel(source.status)
}
  </span>
  </div> <p>{
    modeCopy
}
  </p> <dl> <div>
  <dt>Respons dibuat</dt>
  <dd>
  <time dateTime={
    generatedAt
}
  >{
    formatTime(generatedAt)
}
  </time>
  </dd>
  </div> <div>
  <dt>Diminta dari penyedia</dt>
  <dd>{
    source.fetched_at === null ? "Belum diminta; waktu tidak tersedia." : <time dateTime={
      source.fetched_at
}
    >{
      formatTime(source.fetched_at)
}
    </time>
}
  </dd>
  </div> <div>
  <dt>Pembaruan sumber</dt>
  <dd>{
    source.source_updated_at === null ? "Tidak disediakan sumber; waktu proses tidak menggantikannya." : <time dateTime={
      source.source_updated_at
}
    >{
      formatTime(source.source_updated_at)
}
    </time>
}
  </dd>
  </div> {
    source.window_start != null && source.window_end != null && <div>
    <dt>Jendela katalog USGS</dt>
    <dd>
    <time dateTime={
      source.window_start
}
    >{
      formatTime(source.window_start)
}
    </time> – <time dateTime={
      source.window_end
}
    >{
      formatTime(source.window_end)
}
    </time>
    </dd>
    </div>
}
  </dl>
  {source.id === "usgs" && (
    <section className="unified-source-explorer__query-policy" aria-label="Cakupan kueri katalog USGS">
      <h4>Kueri katalog USGS</h4>
      <p>{source.data_mode === "fetched" ? "Kueri yang digunakan" : "Batas kueri untuk permintaan berikutnya"}: magnitudo ≥ 2,5 · jendela {CONTEXT_SOURCE_POLICY.earthquakeWindowMs / (24 * 60 * 60_000)} hari · maksimal {CONTEXT_SOURCE_POLICY.maxEarthquakes} record.</p>
      <p>Batas pencarian: {CONTEXT_SOURCE_POLICY.earthquakeEnvelope.west}° BT–{CONTEXT_SOURCE_POLICY.earthquakeEnvelope.east}° BT, {formatPolicyNumber(Math.abs(CONTEXT_SOURCE_POLICY.earthquakeEnvelope.north))}°–{formatPolicyNumber(Math.abs(CONTEXT_SOURCE_POLICY.earthquakeEnvelope.south))}° LS. Cakupan ini adalah jendela kueri, bukan batas bahaya resmi atau area dampak Jakarta.</p>
    </section>
  )}
 {
    errorCopy && <p className="unified-source-explorer__source-error">{
      errorCopy
}
    </p>
}
  {
    source.limited && <p>Respons dibatasi oleh sumber atau kebijakan kueri;
    hasil mungkin tidak lengkap.</p>
}
  {
    source.rejected_count > 0 && <p>{
      source.rejected_count
}
    record/nilai tidak memenuhi batas validasi.</p>
}
  <p className="unified-source-explorer__attribution">{
    source.attribution
}
  </p> <p className="unified-source-explorer__source-links">
  <a href={
    source.source_url
}
  target="_blank" rel="noreferrer">Buka katalog sumber ↗</a>
  <a href={
    source.license_url
}
  target="_blank" rel="noreferrer">Lisensi / kredit ↗</a>
  </p> </article> );
}
function WeatherPanel({
  source, generatedAt, cached
}
: {
  source: WeatherContextSource | null;
  generatedAt: string | null;
  cached: boolean;
}
) {
  if (source === null || generatedAt === null) {
    return <p className="unified-source-explorer__empty-panel" role="status">Konteks cuaca belum tersedia. Gunakan Ambil cuaca &amp;
    gempa bila ingin meminta sumber;
    area kosong bukan laporan bahwa cuaca aman.</p>;
  }
  return ( <section className="unified-source-explorer__weather" aria-label="Konteks prakiraan cuaca Open-Meteo"> <div className="unified-source-explorer__weather-heading">
  <div>
  <p className="section-kicker">Keluaran model · bukan observasi atau peringatan</p>
  <h3>Cuaca · Open-Meteo</h3>
  </div>
  <span>{
    statusLabel(source.status)
}
  </span>
  </div> <p className="unified-source-explorer__weather-meta">{
    source.data_mode === "none" ? "Status lokal saja; penyedia belum dihubungi." : `Respons dibuat ${formatTime(generatedAt)}${cached ? " · cache server" : ""}.`
}
  </p> <dl className="unified-source-explorer__weather-times"> <div>
  <dt>Data diminta</dt>
  <dd>{
    source.fetched_at === null ? "Belum diminta; waktu tidak tersedia." : <time dateTime={
      source.fetched_at
}
    >{
      formatTime(source.fetched_at)
}
    </time>
}
  </dd>
  </div> <div>
  <dt>Waktu terbit/pembaruan model</dt>
  <dd>{
    source.source_updated_at === null ? "Tidak disediakan; waktu API bukan waktu terbit model." : <time dateTime={
      source.source_updated_at
}
    >{
      formatTime(source.source_updated_at)
}
    </time>
}
  </dd>
  </div> </dl> {
    source.error && <p className="unified-source-explorer__source-error">{
      source.error === "timeout" ? "Batas waktu permintaan habis." : source.error === "http_error" ? "Penyedia tidak memberi respons yang dapat digunakan." : "Respons tidak sesuai format."
}
    </p>
}
  {
    source.status === "empty" && <p>Respons tidak memuat jam prakiraan;
    nilai cuaca tidak diketahui.</p>
}
  {
    source.forecast && <WeatherForecastTable source={
      source
}
    />
}
  {
    source.forecast === null && source.status === "available" && <p>Nilai prakiraan tidak tersedia di respons ini.</p>
}
  <p className="unified-source-explorer__attribution">{
    source.attribution
}
  </p> <p className="unified-source-explorer__source-links">
  <a href={
    source.source_url
}
  target="_blank" rel="noreferrer">Dokumentasi Open-Meteo ↗</a>
  <a href={
    source.license_url
}
  target="_blank" rel="noreferrer">Lisensi CC BY 4.0 ↗</a>
  </p> <p className="unified-source-explorer__note">Koordinat grid model dijelaskan di tabel sebagai konteks sampel. Tidak dibuat titik insiden cuaca pada peta.</p> </section> );
}
export function UnifiedSourceExplorerView({
  datasetMode, sourcePayload, sourceRequest, contextPayload, contextRequest, renderMap, onSourceRequest, onContextRequest, defaultPanel = "daftar",
}
: UnifiedSourceExplorerViewProps) {
  void React;
  const [query, setQuery] = useState("");
  const [sourceFilter, setSourceFilter] = useState<UnifiedSourceFilter>("all");
  const [kindFilter, setKindFilter] = useState<UnifiedKindFilter>("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [panel, setPanel] = useState<UnifiedExplorerPanel>(defaultPanel);
  const [companionOpen, setCompanionOpen] = useState(defaultPanel !== "daftar");
  const mapContainerRef = useRef<HTMLElement>(null);
  const usableSourcePayload = datasetMode === "demo" && sourceRequest.status === "loaded" ? sourcePayload : null;
  const usableContextPayload = datasetMode === "demo" && contextRequest.status === "loaded" ? contextPayload : null;
  const allPoints = useMemo(() => collectUnifiedSourcePoints(usableSourcePayload, usableContextPayload), [usableSourcePayload, usableContextPayload]);
  const visiblePoints = useMemo(() => filterUnifiedSourcePoints(allPoints, {
    query, source: sourceFilter, kind: kindFilter
}
  ), [allPoints, query, sourceFilter, kindFilter]);
  useEffect(() => {
    if (retainVisibleSourceSelection(visiblePoints, selectedId) !== selectedId) {
      setSelectedId(null);
    }
  }, [selectedId, visiblePoints]);
  const selectedPoint = resolveVisibleSourceSelection(visiblePoints, selectedId);
  const sourceLoading = sourceRequest.status === "loading";
  const contextLoading = contextRequest.status === "loading";
  const canUseSources = datasetMode === "demo";
  const selectPoint = useCallback((point: SourceMapPoint) => {
    if (!visiblePoints.some((visible) => visible.id === point.id)) return;
    setSelectedId(point.id);
    setPanel("detail");
    setCompanionOpen(true);
  }
  , [visiblePoints]);
  const selectMapPoint = useCallback((id: string) => {
    const point = visiblePoints.find((candidate) => candidate.id === id);
    if (point) selectPoint(point);
  }
  , [selectPoint, visiblePoints]);
  const returnToList = useCallback(() => { setPanel("daftar"); setCompanionOpen(true); }, []);
  const sourcePayloadStatus = usableSourcePayload;
  const contextPayloadStatus = usableContextPayload;
  const weatherSource = contextPayloadStatus?.sources[0] ?? null;
  const quakeSource = contextPayloadStatus?.sources[1] ?? null;
  const quakeRecord = selectedPoint?.source === "usgs" ? selectedPoint as EarthquakeContextRecord : null;
  const visibleSourceStatus = (id: PreviewSource["id"]) => requestGroupStatus(sourceRequest, previewSourceStatus(sourcePayloadStatus, id));
  const visibleContextStatus = (id: "openmeteo" | "usgs") => requestGroupStatus(contextRequest, contextSourceStatus(contextPayloadStatus, id));
  return ( <main id="main-content" className={`main-shell unified-source-explorer${companionOpen ? " unified-source-explorer--panel-open" : ""}`} aria-busy={
    sourceLoading || contextLoading
}
  > <header className="unified-source-explorer__intro"> <div> <p className="section-kicker">Demo sumber · pratinjau terpisah</p> <h1 id="unified-source-explorer-title">Peta sumber Jakarta</h1> <p>Titik fasilitas adalah rujukan;
  laporan dan katalog bukan penilaian keselamatan atau dampak.</p> </div> <span className="unified-source-explorer__not-published">Belum melalui publikasi Waspada</span> </header> <section className="unified-source-explorer__toolbar" aria-label="Status dan permintaan sumber"> <div className="unified-source-explorer__dataset"> <strong>{
    datasetMode === "demo" ? "DEMO · belum dipublikasi" : datasetMode === "live" ? "LIVE" : "Dataset belum diketahui"
}
  </strong> <span>{
    datasetMode === "demo" ? "Default lokal; permintaan penyedia hanya setelah tindakan Anda." : datasetMode === "live" ? "Pratinjau demo tidak tersedia dalam mode live." : "Tidak ada data atau permintaan sebelum konfirmasi mode demo."
}
  </span> </div> <div className="unified-source-explorer__actions"> <button className="button button--primary" type="button" disabled={
    !canUseSources || sourceLoading
}
  onClick={
    () => onSourceRequest("fetch")
}
  > {
    sourceLoading && sourceRequest.status === "loading" && sourceRequest.mode === "fetch" ? "Meminta fasilitas & banjir…" : "Ambil fasilitas & banjir"
}
  </button> <button className="button button--primary" type="button" disabled={
    !canUseSources || contextLoading
}
  onClick={
    () => onContextRequest("fetch")
}
  > {
    contextLoading && contextRequest.status === "loading" && contextRequest.mode === "fetch" ? "Meminta cuaca & gempa…" : "Ambil cuaca & gempa"
}
  </button> </div> <div className="unified-source-explorer__source-status" aria-label="Status singkat tiap sumber"> <SourceStatusChip label="OSM" status={
    visibleSourceStatus("osm")
}
  /> <SourceStatusChip label="PetaBencana" status={
    visibleSourceStatus("petabencana")
}
  /> <SourceStatusChip label="Open-Meteo" status={
    visibleContextStatus("openmeteo")
}
  /> <SourceStatusChip label="USGS" status={
    visibleContextStatus("usgs")
}
  /> </div> </section> {
    datasetMode !== "demo" && <p className="unified-source-explorer__guard" role="status">{
      datasetMode === "live" ? "Pratinjau sumber ini hanya tersedia pada mode demo; tidak ada permintaan sumber yang dilakukan." : "Pratinjau menunggu konfirmasi dataset demo; tidak ada permintaan sumber yang dilakukan."
}
    </p>
}
  <div className="unified-source-explorer__request-states" aria-live="polite"> {
    sourceLoading && <p role="status">{
      sourceRequest.status === "loading" && sourceRequest.mode === "snapshot" ? "Memuat snapshot fasilitas lokal; penyedia belum dihubungi…" : "Meminta fasilitas dan laporan setelah tindakan Anda…"
}
    </p>
}
  {
    contextLoading && <p role="status">{
      contextRequest.status === "loading" && contextRequest.mode === "local" ? "Memuat status konteks lokal; penyedia belum dihubungi…" : "Meminta cuaca dan katalog gempa setelah tindakan Anda…"
}
    </p>
}
  {
    sourceRequest.status === "error" && <GroupRequestState request={
      sourceRequest
}
    onRetry={
      () => onSourceRequest(sourceRequest.mode as SourcePreviewRequestMode)
}
    retryLabel={
      sourceRequest.mode === "snapshot" ? "Coba snapshot lagi" : "Coba permintaan lagi"
}
    />
}
  {
    contextRequest.status === "error" && <GroupRequestState request={
      contextRequest
}
    onRetry={
      () => onContextRequest(contextRequest.mode as ContextSourcesRequestMode)
}
    retryLabel={
      contextRequest.mode === "local" ? "Coba status lokal lagi" : "Coba permintaan lagi"
}
    />
}
  </div> <section className="unified-source-explorer__filters" aria-label="Pencarian bersama untuk daftar dan peta"> <details className="unified-source-explorer__filter-disclosure"> <summary>
  <span>Filter dan pencarian</span>
  <span>{visiblePoints.length} dari {allPoints.length} titik termuat</span>
  </summary> <div className="unified-source-explorer__filter-controls"> <label className="unified-source-explorer__search" htmlFor="unified-source-search">Cari lokasi atau laporan <input id="unified-source-search" name="source-search" type="search" autoComplete="off" value={
    query
}
  onChange={
    (event) => setQuery(event.currentTarget.value)
}
  placeholder="Rumah sakit, banjir, gempa…" /> </label> <label htmlFor="unified-source-filter">Sumber <select id="unified-source-filter" name="source" autoComplete="off" value={
    sourceFilter
}
  onChange={
    (event) => setSourceFilter(event.currentTarget.value as UnifiedSourceFilter)
}
  > <option value="all">Semua sumber</option>
  <option value="osm">OpenStreetMap</option>
  <option value="petabencana">PetaBencana.id</option>
  <option value="usgs">USGS</option> </select> </label> <label htmlFor="unified-kind-filter">Jenis <select id="unified-kind-filter" name="kind" autoComplete="off" value={
    kindFilter
}
  onChange={
    (event) => setKindFilter(event.currentTarget.value as UnifiedKindFilter)
}
  > <option value="all">Semua jenis</option>{
    Object.entries(kindLabels).map(([kind, label]) => <option key={
      kind
}
    value={
      kind
}
    >{
      label
}
    </option>)
}
  </select> </label> <button className="button button--quiet" type="button" disabled={
    query.length === 0 && sourceFilter === "all" && kindFilter === "all"
}
  onClick={
    () => {
      setQuery("");
      setSourceFilter("all");
      setKindFilter("all");
    }
  }
  >Hapus filter</button> </div> </details> </section> <div className="unified-source-explorer__layout">
  <section ref={mapContainerRef} className="unified-source-explorer__map" aria-label="Peta sumber terpadu">
    {renderMap ? (
      renderMap(visiblePoints, selectedPoint?.id ?? null, selectMapPoint, returnToList)
    ) : (
      <div className="unified-source-explorer__map-fallback" role="status">
        <div>
          <h2>Peta sumber Jakarta</h2>
          <p>Peta interaktif belum tersambung pada tampilan ini.</p>
          <p>{visiblePoints.length} record mengikuti pencarian dan filter bersama.</p>
        </div>
      </div>
    )}
  </section>
  <section className="unified-source-explorer__companion" aria-label="Panel sumber"> <nav className="unified-source-explorer__panel-nav" aria-label="Tampilan panel sumber"> {
    (Object.keys(panelLabels) as UnifiedExplorerPanel[]).map((value) => ( <button key={
      value
}
    type="button" aria-current={
      panel === value ? "page" : undefined
}
  aria-controls="unified-source-panel-content"
  onClick={() => { setPanel(value); setCompanionOpen(true); }}
    >{
      panelLabels[value]
}
    </button> ))
}
  </nav>
  <button className="unified-source-explorer__close-panel" type="button" onClick={() => {
    setCompanionOpen(false);
    mapContainerRef.current?.querySelector<HTMLElement>('[role="region"][tabindex="0"]')?.focus({ preventScroll: true });
  }}>Kembali ke peta</button>
  <div id="unified-source-panel-content" className="unified-source-explorer__panel-content" aria-live={
    panel === "detail" ? "polite" : undefined
}
  > {
    panel === "daftar" && <RecordList points={
      visiblePoints
}
    selectedId={
      selectedPoint?.id ?? null
}
    onSelect={
      selectPoint
}
    />
}
  {
    panel === "detail" && ( selectedPoint === null ? <section className="unified-source-explorer__empty-panel" aria-labelledby="unified-source-detail-title">
    <h2 id="unified-source-detail-title">Detail pilihan</h2>
    <p>Pilih satu fasilitas, laporan, atau episentrum di daftar atau peta untuk melihat asal dan waktunya.</p>
    </section> : quakeRecord !== null ? <EarthquakeRecordDetails record={
      quakeRecord
}
    fetchedAt={
      quakeSource?.fetched_at ?? null
}
    /> : <SourcePreviewRecordDetails record={
      selectedPoint as PreviewRecord
}
    /> )
}
  {
    panel === "cuaca" && <WeatherPanel source={
      weatherSource
}
    generatedAt={
      contextPayloadStatus?.generated_at ?? null
}
    cached={
      contextPayloadStatus?.cached ?? false
}
    />
}
  {
    panel === "sumber" && ( <div className="unified-source-explorer__source-details"> <p className="unified-source-explorer__dataset-explanation">{datasetMode === "demo" ? "Mode demo terisolasi; snapshot lokal tidak menghubungi penyedia, sedangkan permintaan eksplisit dapat menghasilkan data parsial atau tersimpan sementara." : datasetMode === "live" ? "Mode live tidak menampilkan atau meminta pratinjau demo." : "Mode dataset belum dikonfirmasi; pratinjau dan permintaan sumber tidak dijalankan."}</p> <div className="unified-source-explorer__reset-actions"> <button className="button button--quiet" type="button" disabled={!canUseSources || sourceLoading} onClick={() => onSourceRequest("snapshot")}>Reset fasilitas &amp; banjir ke snapshot lokal</button>  <button className="button button--quiet" type="button" disabled={
      !canUseSources || contextLoading
}
    onClick={
      () => onContextRequest("local")
}
    >Reset cuaca &amp;
    gempa ke status lokal</button> </div> {
      usableSourcePayload ? ( <> <p className="unified-source-explorer__payload-stamp">{
        usableSourcePayload.sources[0]?.data_mode === "snapshot" ? "Snapshot lokal" : "Permintaan sumber"
}
      · respons dibuat <time dateTime={
        usableSourcePayload.generated_at
}
      >{
        formatTime(usableSourcePayload.generated_at)
}
      </time>{
        usableSourcePayload.cached ? " · cache server" : ""
}
      </p> {
        usableSourcePayload.sources.map((source) => <React.Fragment key={
          source.id
}
        > <SourcePreviewStatusCard source={
          source
}
        cached={
          usableSourcePayload.cached
}
        /> <p className="unified-source-explorer__attribution">{
          source.attribution
}
        · <a href={
          source.license_url
}
        target="_blank" rel="noreferrer">baca lisensi ↗</a>
        </p> </React.Fragment>)
}
      </> ) : <p className="unified-source-explorer__empty-panel" role="status">Status fasilitas dan laporan belum tersedia. Snapshot lokal tidak menghubungi penyedia.</p>
}
    {
      contextPayloadStatus && contextPayloadStatus.sources.map((source) => ( <SourceMetadataCard key={
        source.id
}
      title={
        source.id === "openmeteo" ? "Open-Meteo · konteks cuaca" : "USGS · katalog gempa regional"
}
      source={
        source
}
      generatedAt={
        contextPayloadStatus.generated_at
}
      cached={
        contextPayloadStatus.cached
}
      /> ))
}
    {
      !contextPayloadStatus && <p className="unified-source-explorer__empty-panel" role="status">Konteks cuaca dan gempa berstatus {
        requestGroupStatus(contextRequest, undefined).toLocaleLowerCase("id")
}
      . Reset lokal dan permintaan eksplisit tetap terpisah dari fasilitas/laporan.</p>
}
    <p className="unified-source-explorer__note">Status penyedia bukan verifikasi Waspada. Hasil kosong atau sumber gagal tidak menunjukkan keadaan aman.</p> </div> )
}
  </div> </section> </div> </main> );
}
export function UnifiedSourceExplorer({
  datasetMode, renderMap
}
: UnifiedSourceExplorerProps) {
  void React;
  const [sourceRequest, setSourceRequest] = useState<UnifiedRequestState>(() => datasetMode === "demo" ? {
    status: "loading", mode: "snapshot"
}
  : {
    status: "idle"
}
  , );
  const [sourcePayload, setSourcePayload] = useState<SourcePreviewPayload | null>(null);
  const [contextRequest, setContextRequest] = useState<UnifiedRequestState>(() => datasetMode === "demo" ? {
    status: "loading", mode: "local"
}
  : {
    status: "idle"
}
  , );
  const [contextPayload, setContextPayload] = useState<ContextSourcesPayload | null>(null);
  const sourceController = useRef<AbortController | null>(null);
  const sourceSequence = useRef(0);
  const contextController = useRef<AbortController | null>(null);
  const contextSequence = useRef(0);
  const startSourceRequest = useCallback((mode: SourcePreviewRequestMode) => {
    if (datasetMode !== "demo") return;
    sourceController.current?.abort();
    const controller = new AbortController();
    sourceController.current = controller;
    const sequence = ++sourceSequence.current;
    setSourcePayload(null);
    setSourceRequest({
      status: "loading", mode
}
    );
    void getSourcePreview({
      mode, signal: controller.signal
}
    ).then((nextPayload) => {
      if (controller.signal.aborted || sequence !== sourceSequence.current) return;
      setSourcePayload(nextPayload);
      setSourceRequest({
        status: "loaded", mode
}
      );
      sourceController.current = null;
    }
    ).catch((error: unknown) => {
      if (controller.signal.aborted || sequence !== sourceSequence.current) return;
      setSourcePayload(null);
      setSourceRequest({
        status: "error", mode, message: sourceStatusError(error, "source")
}
      );
      sourceController.current = null;
    }
    );
  }
  , [datasetMode]);
  const startContextRequest = useCallback((mode: ContextSourcesRequestMode) => {
    if (datasetMode !== "demo") return;
    contextController.current?.abort();
    const controller = new AbortController();
    contextController.current = controller;
    const sequence = ++contextSequence.current;
    setContextPayload(null);
    setContextRequest({
      status: "loading", mode
}
    );
    void getContextSources({
      mode, signal: controller.signal
}
    ).then((nextPayload) => {
      if (controller.signal.aborted || sequence !== contextSequence.current) return;
      setContextPayload(nextPayload);
      setContextRequest({
        status: "loaded", mode
}
      );
      contextController.current = null;
    }
    ).catch((error: unknown) => {
      if (controller.signal.aborted || sequence !== contextSequence.current) return;
      setContextPayload(null);
      setContextRequest({
        status: "error", mode, message: sourceStatusError(error, "context")
}
      );
      contextController.current = null;
    }
    );
  }
  , [datasetMode]);
  useEffect(() => {
    if (datasetMode !== "demo") {
      sourceController.current?.abort();
      contextController.current?.abort();
      sourceController.current = null;
      contextController.current = null;
      sourceSequence.current += 1;
      contextSequence.current += 1;
      setSourcePayload(null);
      setContextPayload(null);
      setSourceRequest({
        status: "idle"
}
      );
      setContextRequest({
        status: "idle"
}
      );
      return;
    }
    startSourceRequest("snapshot");
    startContextRequest("local");
    return () => {
      sourceController.current?.abort();
      contextController.current?.abort();
      sourceController.current = null;
      contextController.current = null;
      sourceSequence.current += 1;
      contextSequence.current += 1;
    }
    ;
  }
  , [datasetMode, startSourceRequest, startContextRequest]);
  return <UnifiedSourceExplorerView key={
    datasetMode ?? "unknown"
}
  datasetMode={
    datasetMode
}
  sourcePayload={
    sourcePayload
}
  sourceRequest={
    sourceRequest
}
  contextPayload={
    contextPayload
}
  contextRequest={
    contextRequest
}
  renderMap={
    renderMap
}
  onSourceRequest={
    startSourceRequest
}
  onContextRequest={
    startContextRequest
}
  />;
}
