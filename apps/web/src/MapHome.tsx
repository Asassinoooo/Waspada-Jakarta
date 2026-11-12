import { useEffect, useMemo, useRef, useState } from "react";
import type { EventView, PublicContext } from "@waspada/worker/public-contracts";
import { EventDetail } from "./EventDetail.js";
import { EventMapCanvas, MAP_DEFAULT_VIEW, MAP_DETAIL_ZOOM, isDefaultMapView, type CanvasMarker, type MapProjection, type MapView } from "./EventMapCanvas.js";
import { MapEventList } from "./MapEventList.js";
import { DEFAULT_MAP_FILTER_VALUE, MapFilterSheet, type MapFilterValue } from "./MapFilterSheet.js";
import { AnchoredMapPopup, PeekMapPopup, popupAnchor, unmappedPopupAnchor } from "./MapPopup.js";
import { EMERGENCY_FACILITIES } from "./emergency-facilities.js";
import { buildEventHash, copyText, eventShareUrl, MAP_HOME_HASH } from "./map-links.js";
import {
  categoryMarkerIcon,
  categoryText,
  countActiveFilters,
  deepLinkTarget,
  filterPublishedEvents,
  usePublicEventDetail,
  usePublishedEvents,
  type PublishedMarker,
} from "./published-events.js";
import { Sheet } from "./ui/Sheet.js";

// Browser-only, like the other page stylesheets: keeps the module importable under Node SSR tests.
if (typeof document !== "undefined") {
  void import("./map-home.css");
}

/** Same breakpoint as the Sheet side panel: from 900px the list is a left panel, below it a bottom sheet. */
const WIDE_QUERY = "(min-width: 900px)";
const LIST_HEADING_ID = "map-list-title";
const POPUP_TITLE_ID = "map-popup-title";
const DETAIL_TITLE_ID = "map-detail-title";
const MAP_LABEL = "Peta laporan terbit di Jakarta";
const NO_MARKERS: ReadonlyMap<string, PublishedMarker> = new Map();

export interface MapHomeProps {
  /** Event id from `#peta?event=<id>` or the legacy `#jelajah?event=<id>`. */
  deepLinkEventId?: string | null;
  /** Public context, used only for the dataset line in the detail sheet. */
  context?: PublicContext | null;
  /** Test seam: renders these published events without reading the API. */
  initialEvents?: readonly EventView[];
  initialMarkers?: ReadonlyMap<string, PublishedMarker>;
}

function useMediaMatch(query: string): boolean {
  const [matches, setMatches] = useState(() =>
    typeof window !== "undefined" && typeof window.matchMedia === "function" ? window.matchMedia(query).matches : true,
  );
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const media = window.matchMedia(query);
    const update = () => setMatches(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, [query]);
  return matches;
}

/**
 * Map-first home at `#peta` (UI-V2-B). The map fills the screen, the toolbar floats over it, and the
 * list is a left panel from 900px or a bottom sheet below that. Every view reads the same published
 * events, through the shared hook, and every filter applies to the list and the markers alike.
 */
export function MapHome({ deepLinkEventId = null, context = null, initialEvents, initialMarkers }: MapHomeProps) {
  const seed = useMemo(
    () => (initialEvents === undefined ? undefined : { events: initialEvents, markers: initialMarkers ?? NO_MARKERS }),
    [initialEvents, initialMarkers],
  );
  const data = usePublishedEvents(seed);
  const wide = useMediaMatch(WIDE_QUERY);
  const [now] = useState(() => Date.now());
  const [query, setQuery] = useState("");
  const [applied, setApplied] = useState<MapFilterValue>(DEFAULT_MAP_FILTER_VALUE);
  const [listOpen, setListOpen] = useState(wide);
  const [filterOpen, setFilterOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [view, setView] = useState<MapView>(MAP_DEFAULT_VIEW);
  const [copyMessage, setCopyMessage] = useState<string | null>(null);
  const [deepLinkMissing, setDeepLinkMissing] = useState(false);
  const [detailEventId, setDetailEventId] = useState<string | null>(null);
  const detail = usePublicEventDetail(detailEventId);
  const focusPopupOnOpen = useRef(false);
  const openerRef = useRef<HTMLElement | null>(null);
  const popupRef = useRef<HTMLElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const appliedDeepLink = useRef<string | null>(null);

  const eventsById = useMemo(() => new Map(data.events.map((event) => [event.event_id, event] as const)), [data.events]);
  const visibleEvents = useMemo(
    () => filterPublishedEvents(data.events, query, applied.filters, now),
    [data.events, query, applied.filters, now],
  );
  const visibleIds = useMemo(() => new Set(visibleEvents.map((event) => event.event_id)), [visibleEvents]);
  const canvasMarkers = useMemo<CanvasMarker[]>(() => visibleEvents.flatMap((event) => {
    const marker = data.markers.get(event.event_id);
    if (!marker) return [];
    return [{
      id: event.event_id,
      coordinate: marker.coordinate,
      label: `${categoryText(event.category)}: ${event.title}`,
      icon: categoryMarkerIcon(event.category),
      selected: event.event_id === selectedId,
    }];
  }), [visibleEvents, data.markers, selectedId]);
  const facilities = useMemo(
    () => (applied.facilitiesOn ? EMERGENCY_FACILITIES.filter((facility) => applied.facilityKinds.includes(facility.kind)) : []),
    [applied],
  );
  const selectedEvent = selectedId !== null && visibleIds.has(selectedId) ? eventsById.get(selectedId) ?? null : null;
  const activeCount = countActiveFilters(applied.filters, applied.facilitiesOn);
  const filtersActive = activeCount > 0 || query.trim().length > 0;

  // The list panel follows the layout: open on desktop, closed as a sheet on phones. A resize never opens a sheet by itself.
  useEffect(() => {
    setListOpen(wide);
  }, [wide]);

  // Deep link: select the event, centre the map and open its popup once the list is loaded. Applied once per link.
  useEffect(() => {
    if (deepLinkEventId === null) {
      appliedDeepLink.current = null;
      return;
    }
    if (data.status !== "loaded") return;
    if (appliedDeepLink.current === deepLinkEventId) return;
    appliedDeepLink.current = deepLinkEventId;
    const target = deepLinkTarget(data.events, data.markers, deepLinkEventId);
    if (target === null) {
      setDeepLinkMissing(true);
      return;
    }
    setDeepLinkMissing(false);
    setQuery("");
    setApplied(DEFAULT_MAP_FILTER_VALUE);
    setSelectedId(target.event.event_id);
    setCopyMessage(null);
    if (target.marker) setView({ center: target.marker.coordinate, zoom: MAP_DETAIL_ZOOM });
    if (!wide) setListOpen(false);
  }, [deepLinkEventId, data.status, data.events, data.markers, wide]);

  // Focus moves into the popup only after a user action, never on a deep-link load.
  useEffect(() => {
    if (!focusPopupOnOpen.current || selectedEvent === null) return;
    focusPopupOnOpen.current = false;
    if (wide) popupRef.current?.focus({ preventScroll: true });
  }, [selectedEvent, wide]);

  function selectEvent(eventId: string, origin: { focus: boolean; center: boolean; opener: HTMLElement | null }) {
    setSelectedId(eventId);
    setCopyMessage(null);
    setDeepLinkMissing(false);
    focusPopupOnOpen.current = origin.focus;
    openerRef.current = origin.opener;
    const marker = data.markers.get(eventId);
    if (origin.center && marker) {
      const { coordinate } = marker;
      setView((current) => ({ center: coordinate, zoom: Math.max(current.zoom, MAP_DETAIL_ZOOM) }));
    }
    // replaceState does not fire hashchange, so the route does not reload when the selection changes.
    window.history.replaceState(window.history.state, "", buildEventHash(eventId));
  }

  function closePopup() {
    const opener = openerRef.current;
    openerRef.current = null;
    setSelectedId(null);
    setCopyMessage(null);
    window.history.replaceState(window.history.state, "", MAP_HOME_HASH);
    const target = opener?.isConnected ? opener : stageRef.current;
    target?.focus({ preventScroll: true });
  }

  function openFromList(eventId: string) {
    if (!wide) setListOpen(false);
    selectEvent(eventId, { focus: true, center: true, opener: null });
  }

  async function copyLink(eventId: string) {
    const copied = await copyText(eventShareUrl(eventId, window.location.href));
    setCopyMessage(copied ? "Tautan disalin." : "Salin otomatis tidak tersedia. Tautan sudah ada di bilah alamat.");
  }

  function resetFilters() {
    setQuery("");
    setApplied(DEFAULT_MAP_FILTER_VALUE);
  }

  function openDetail(eventId: string) {
    setDetailEventId(eventId);
  }

  function closeDetail() {
    setDetailEventId(null);
  }

  const marker = selectedEvent ? data.markers.get(selectedEvent.event_id) ?? null : null;
  const peekVisible = !wide && !listOpen && !filterOpen && detailEventId === null;

  const renderOverlay = (projection: MapProjection) => {
    if (selectedEvent === null || !wide) return null;
    const anchor = marker
      ? popupAnchor(projection.project(marker.coordinate), projection.width, projection.height)
      : unmappedPopupAnchor(projection.width, projection.height);
    const eventId = selectedEvent.event_id;
    return (
      <AnchoredMapPopup
        rootRef={popupRef}
        anchor={anchor}
        event={selectedEvent}
        marker={marker}
        titleId={POPUP_TITLE_ID}
        copyMessage={copyMessage}
        onClose={closePopup}
        onViewDetail={() => openDetail(eventId)}
        onCopyLink={() => void copyLink(eventId)}
      />
    );
  };

  const listContent = (
    <MapEventList
      headingId={LIST_HEADING_ID}
      status={data.status}
      events={visibleEvents}
      markers={data.markers}
      selectedId={selectedId}
      filtersActive={filtersActive}
      errorMessage={data.errorMessage}
      onSelect={openFromList}
      onReset={resetFilters}
      onRetry={data.reload}
    />
  );

  return (
    <main id="main-content" tabIndex={-1} className="map-home">
      <h1 className="visually-hidden">Peta laporan terbit</h1>
      <div className="map-home__body">
        {wide && listOpen && (
          <aside className="map-home__panel" aria-labelledby={LIST_HEADING_ID}>
            {listContent}
          </aside>
        )}

        <div className="map-home__stage" ref={stageRef} tabIndex={-1}>
          <EventMapCanvas
            label={MAP_LABEL}
            view={view}
            onViewChange={setView}
            markers={canvasMarkers}
            onSelectMarker={(eventId, element) => selectEvent(eventId, { focus: true, center: false, opener: element })}
            facilities={facilities}
            showRecenter={!isDefaultMapView(view)}
            onRecenter={() => setView(MAP_DEFAULT_VIEW)}
            renderOverlay={renderOverlay}
          />

          <div className="toolbar map-home__toolbar">
            <input
              id="map-search"
              type="search"
              className="input map-home__search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Cari judul atau lokasi"
              aria-label="Cari laporan"
              autoComplete="off"
            />
            <button
              type="button"
              className="button button--quiet map-home__tool"
              aria-haspopup="dialog"
              aria-expanded={filterOpen}
              aria-label={activeCount > 0 ? `Filter, ${activeCount} aktif` : "Filter"}
              onClick={() => setFilterOpen(true)}
            >
              <svg className="map-home__icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <path d="M4 6h16M7 12h10M10 18h4" />
              </svg>
              <span className="map-home__tool-label">Filter</span>
              {activeCount > 0 && <span className="count-chip map-home__count">{activeCount}</span>}
            </button>
            <button
              type="button"
              className="button button--quiet map-home__tool"
              aria-expanded={listOpen}
              aria-label={`Daftar laporan, ${visibleEvents.length}`}
              onClick={() => setListOpen((open) => !open)}
            >
              <svg className="map-home__icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01" />
              </svg>
              <span className="map-home__tool-label">Daftar</span>
              <span className="count-chip map-home__count">{visibleEvents.length}</span>
            </button>
          </div>

          {data.markersUnavailable && (
            <div className="feedback-banner feedback-banner--error map-home__notice" role="alert">
              <span>Peta belum dapat dimuat. Daftar tetap tersedia.</span>
              <button type="button" className="button button--quiet button--sm" onClick={data.reload}>
                Coba lagi
              </button>
            </div>
          )}
          {deepLinkMissing && (
            <p className="feedback-banner feedback-banner--info map-home__notice" role="status">
              Laporan dari tautan ini tidak ada di daftar yang terbit saat ini.
            </p>
          )}
        </div>
      </div>

      {!wide && (
        <Sheet open={listOpen} onClose={() => setListOpen(false)} titleId={LIST_HEADING_ID} side="left" className="map-list-sheet">
          <div className="map-list-sheet__head">
            <button type="button" className="button button--quiet button--sm" onClick={() => setListOpen(false)}>
              Tutup daftar
            </button>
          </div>
          {listContent}
        </Sheet>
      )}

      {filterOpen && (
        <MapFilterSheet
          applied={applied}
          onApply={(next) => {
            setApplied(next);
            setFilterOpen(false);
          }}
          onClose={() => setFilterOpen(false)}
        />
      )}

      {/* Only one modal layer at a time on phones: the peek yields to the list, filter and detail sheets. */}
      {peekVisible && selectedEvent !== null && (
        <PeekMapPopup
          event={selectedEvent}
          marker={marker}
          titleId={POPUP_TITLE_ID}
          copyMessage={copyMessage}
          onClose={closePopup}
          onViewDetail={() => openDetail(selectedEvent.event_id)}
          onCopyLink={() => void copyLink(selectedEvent.event_id)}
        />
      )}

      {detailEventId !== null && (
        <Sheet open onClose={closeDetail} titleId={DETAIL_TITLE_ID} className="map-detail-sheet">
          <div className="map-detail-sheet__head">
            <h2 id={DETAIL_TITLE_ID}>Detail laporan</h2>
            <button type="button" className="button button--quiet button--sm" onClick={closeDetail}>
              Tutup
            </button>
          </div>
          <EventDetail
            variant="sheet"
            mode="api-event"
            apiDetail={detail.detail ?? undefined}
            apiHistory={detail.history ?? undefined}
            onRetryDetail={detail.retryDetail}
            onRetryHistory={detail.retryHistory}
            context={context}
            onBackToList={closeDetail}
          />
        </Sheet>
      )}
    </main>
  );
}
