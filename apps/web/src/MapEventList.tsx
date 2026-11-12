import type { EventView } from "@waspada/worker/public-contracts";
import {
  areaText,
  categoryText,
  eventTimeText,
  freshnessText,
  sourceCountText,
  sourceNamesOf,
  type PublishedEventsStatus,
  type PublishedMarker,
} from "./published-events.js";

export const EMPTY_LIST_TITLE = "Belum ada laporan terbit di area ini dalam rentang waktu ini.";
export const EMPTY_LIST_NOTE = "Daftar ini hanya memuat laporan yang sudah terbit. Hasil kosong tidak berarti tidak ada kejadian.";
export const LIST_NOTE = "Hanya laporan yang sudah terbit. Ini bukan hasil pemeriksaan atau verifikasi otomatis.";

export interface MapEventListProps {
  headingId: string;
  status: PublishedEventsStatus;
  events: readonly EventView[];
  markers: ReadonlyMap<string, PublishedMarker>;
  selectedId: string | null;
  filtersActive: boolean;
  errorMessage: string | null;
  onSelect: (eventId: string) => void;
  onReset: () => void;
  onRetry: () => void;
}

/** Compact cards and every list state: loading skeleton, inline error with retry, and the exact empty message. */
export function MapEventList({
  headingId,
  status,
  events,
  markers,
  selectedId,
  filtersActive,
  errorMessage,
  onSelect,
  onReset,
  onRetry,
}: MapEventListProps) {
  return (
    <div className="map-list">
      <div className="map-list__head">
        <div>
          <p className="section-kicker">Laporan terbit</p>
          <h2 id={headingId}>Daftar laporan</h2>
        </div>
        {status === "loaded" && <span className="count-chip" aria-live="polite">{events.length} laporan</span>}
      </div>
      <p className="map-list__note muted">{LIST_NOTE}</p>

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
          <p className="empty-state__title">{EMPTY_LIST_TITLE}</p>
          <p>{EMPTY_LIST_NOTE}</p>
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
                  <span className="map-card__meta">{areaText(event)}</span>
                  <span className="map-card__meta">Waktu kejadian: {eventTimeText(event)}</span>
                  <span className="map-card__foot">
                    <span className="map-card__sources">{sourceCountText(sourceNamesOf(event).length)}</span>
                    {!hasMarker && <span className="map-card__unmapped">Belum dipetakan</span>}
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
