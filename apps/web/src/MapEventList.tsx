import type { EventView } from "@waspada/worker/public-contracts";
import { SeverityChip } from "./MapSeverity.js";
import {
  areaText,
  categoryText,
  eventHasTime,
  eventTimeText,
  freshnessText,
  countIndependentSources,
  sourcePublishedAtText,
  severityOf,
  sourceCountText,
  type PublicationRecency,
  type PublishedEventsStatus,
  type PublishedMarker,
} from "./published-events.js";

export const EMPTY_LIST_TITLE = "Belum ada laporan terbit di area ini dalam rentang waktu ini.";
export const EMPTY_LIST_NOTE = "Daftar ini hanya memuat laporan yang sudah terbit. Hasil kosong tidak berarti tidak ada kejadian.";
/** HOSTED-34: the empty message when only the text search is active (no category, time or source filter). */
export const EMPTY_SEARCH_TITLE = "Tidak ada laporan terbit yang cocok dengan pencarian ini.";
/** MAP-RECENT-01: the list states its default window, and an empty window never reads as "nothing happened". */
/** What `areaText` returns when the report names no place. */
export const UNKNOWN_AREA_TEXT = "Lokasi tidak tercatat";

export const RECENT_SCOPE_TEXT = "Terbit atau diperbarui dalam 24 jam terakhir.";
export const EMPTY_RECENT_TITLE = "Tidak ada laporan yang terbit atau diperbarui dalam 24 jam terakhir.";
export function showAllText(olderCount: number): string {
  return `Tampilkan semua (${olderCount} lebih lama)`;
}
export const LIST_NOTE = "Hanya laporan yang sudah terbit. Ini bukan hasil pemeriksaan atau verifikasi otomatis.";

export interface MapEventListProps {
  headingId: string;
  status: PublishedEventsStatus;
  events: readonly EventView[];
  markers: ReadonlyMap<string, PublishedMarker>;
  selectedId: string | null;
  filtersActive: boolean;
  /** True when the text search is the only narrowing; the empty message then names the search. */
  searchOnly?: boolean;
  /** MAP-RECENT-01: the publication window in force, and how many loaded events it hides. */
  recency?: PublicationRecency;
  olderHiddenCount?: number;
  onShowAll?: () => void;
  errorMessage: string | null;
  onSelect: (eventId: string) => void;
  onReset: () => void;
  onRetry: () => void;
  searchQuery?: string;
  onSearchChange?: (query: string) => void;
  onClose?: () => void;
}

/** Compact cards and every list state: loading skeleton, inline error with retry, and the exact empty message. */
export function MapEventList({
  headingId,
  status,
  events,
  markers,
  selectedId,
  filtersActive,
  searchOnly = false,
  recency = "all",
  olderHiddenCount = 0,
  onShowAll,
  errorMessage,
  onSelect,
  onReset,
  onRetry,
  searchQuery,
  onSearchChange,
  onClose,
}: MapEventListProps) {
  return (
    <div className="map-list">
      <div className="map-list__top-bar">
        <div className="map-list__search-wrapper">
          <svg className="map-list__search-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <circle cx="11" cy="11" r="8" />
            <path d="m21 21-4.3-4.3" />
          </svg>
          <input
            id="map-search"
            type="search"
            className="input map-list__search-input"
            value={searchQuery ?? ""}
            onChange={(event) => onSearchChange?.(event.target.value)}
            placeholder="Cari judul atau lokasi..."
            aria-label="Cari laporan"
            autoComplete="off"
          />
        </div>
        {onClose && (
          <button
            type="button"
            className="button button--quiet map-list__collapse-btn"
            onClick={onClose}
            title="Sembunyikan daftar"
            aria-label="Sembunyikan daftar laporan"
          >
            <svg className="map-home__icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        )}
      </div>

      <div className="map-list__head">
        <div>
          <p className="section-kicker">Laporan terbit</p>
          <h2 id={headingId}>Daftar laporan</h2>
        </div>
        {status === "loaded" && <span className="count-chip" aria-live="polite">{events.length} laporan</span>}
      </div>
      <p className="map-list__note muted">{LIST_NOTE}</p>
      {recency === "24h" && status === "loaded" && (
        <div className="map-list__scope">
          <span className="map-list__scope-text">
            <svg className="map-list__scope-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <circle cx="12" cy="12" r="9" />
              <path d="M12 7v5l3 2" />
            </svg>
            {RECENT_SCOPE_TEXT}
          </span>
          {olderHiddenCount > 0 && onShowAll && events.length > 0 && (
            <button type="button" className="button button--quiet button--sm map-list__scope-action" onClick={onShowAll}>
              {showAllText(olderHiddenCount)}
            </button>
          )}
        </div>
      )}

      {status === "loading" && (
        <div className="map-list__loading" role="status">
          <span className="map-list__loading-text">Memuat laporan terbit…</span>
          <ul className="map-list__items map-list__items--skeleton" aria-hidden="true">
            {[0, 1, 2].map((index) => (
              <li key={index} className="map-card map-card--skeleton">
                <span className="skeleton map-card__skeleton-line" />
                <span className="skeleton map-card__skeleton-line map-card__skeleton-line--wide" />
                <span className="skeleton map-card__skeleton-line" />
              </li>
            ))}
          </ul>
        </div>
      )}

      {status === "unavailable" && (
        <div className="feedback-banner feedback-banner--error map-list__error" role="alert">
          <span>{errorMessage ?? "Gagal memuat laporan publik."}</span>
          <button type="button" className="button button--quiet button--sm" onClick={onRetry}>
            Coba lagi
          </button>
        </div>
      )}

      {status === "loaded" && events.length === 0 && (
        <div className="empty-state map-list__empty" role="status">
          <p className="empty-state__title">
            {searchOnly ? EMPTY_SEARCH_TITLE : recency === "24h" && !filtersActive ? EMPTY_RECENT_TITLE : EMPTY_LIST_TITLE}
          </p>
          <p>{EMPTY_LIST_NOTE}</p>
          {recency === "24h" && olderHiddenCount > 0 && onShowAll && (
            <button type="button" className="button button--primary" onClick={onShowAll}>
              {showAllText(olderHiddenCount)}
            </button>
          )}
          {filtersActive && (
            <button type="button" className="button button--quiet" onClick={onReset}>
              Reset filter
            </button>
          )}
        </div>
      )}

      {status === "loaded" && events.length > 0 && (
        <ul className="map-list__items" aria-label="Laporan terbit">
          {events.map((event) => {
            const selected = event.event_id === selectedId;
            const hasMarker = markers.has(event.event_id);
            const severity = severityOf(event);
            const sources = countIndependentSources(event);
            return (
              <li key={event.event_id}>
                <button
                  type="button"
                  className={`map-card${selected ? " map-card--selected" : ""}`}
                  aria-current={selected ? "true" : undefined}
                  onClick={() => onSelect(event.event_id)}
                >
                  <span className="map-card__top">
                    <span className="badge">{categoryText(event.category)}</span>
                    <span className="map-card__freshness">{freshnessText(event.freshness.status)}</span>
                  </span>
                  <strong className="map-card__title">{event.title}</strong>
                  {/* GUI-03: an unknown place is not spelled out on the card; the "Tanpa titik" badge below says it once. */}
                  {areaText(event) !== UNKNOWN_AREA_TEXT && <span className="map-card__meta">{areaText(event)}</span>}
                  <span className="map-card__times">
                    <span className="map-card__meta">{eventHasTime(event) ? `Waktu kejadian: ${eventTimeText(event.event_time)}` : eventTimeText(event.event_time)}</span>
                    {!eventHasTime(event) && sourcePublishedAtText(event) !== null && (
                      <span className="map-card__meta">Dipublikasikan sumber: {sourcePublishedAtText(event)}</span>
                    )}
                  </span>
                  <span className="map-card__foot">
                    {severity !== null && <SeverityChip level={severity} />}
                    <span className="map-card__sources">{sourceCountText(sources.outlets, sources.copies)}</span>
                    {!hasMarker && <span className="map-card__unmapped">{event.location_display === "whole_view" ? "Tanpa titik" : "Belum dipetakan"}</span>}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
