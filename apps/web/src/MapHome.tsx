import { useEffect, useMemo, useRef, useState } from "react";
import type { EventView, PublicContext } from "@waspada/worker/public-contracts";
import { EventDetail } from "./EventDetail.js";
import {
  EventMapCanvas,
  MAP_DEFAULT_VIEW,
  MAP_DETAIL_ZOOM,
  isDefaultMapView,
  type CanvasMarker,
  type MapFlyRequest,
  type MapProjection,
  type MapView,
} from "./EventMapCanvas.js";
import type { MapCoordinate } from "./map-tiles.js";
import { MapEventList, RECENT_SCOPE_TEXT } from "./MapEventList.js";
import { MapLegend } from "./MapSeverity.js";
import { DEFAULT_MAP_FILTER_VALUE, MapFilterSheet, type MapFilterValue } from "./MapFilterSheet.js";
import { AnchoredMapPopup, PeekMapPopup, popupAnchor, unmappedPopupAnchor } from "./MapPopup.js";
import type { EmergencyFacility } from "./emergency-facility-kinds.js";
import { buildEventHash, copyText, eventShareUrl, MAP_HOME_HASH } from "./map-links.js";
import {
  categoryMarkerIcon,
  categoryText,
  countActiveFilters,
  deepLinkTarget,
  filterPublishedEvents,
  publishedRecently,
  type PublicationRecency,
  severityOf,
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
/** After a flight on desktop the event sits this share of the map height below the centre, so its popup fits above it. */
const POPUP_ROOM_RATIO = 0.24;
const NO_MARKERS: ReadonlyMap<string, PublishedMarker> = new Map();

export interface MapHomeProps {
  /** Event id from `#peta?event=<id>` or the legacy `#jelajah?event=<id>`. */
  deepLinkEventId?: string | null;
  /** Public context, used only for the dataset line in the detail sheet. */
  context?: PublicContext | null;
  /** Test seam: renders these published events without reading the API. */
  initialEvents?: readonly EventView[];
  initialMarkers?: ReadonlyMap<string, PublishedMarker>;
  /** Test seam: the clock for the time filters (ms). The page otherwise reads Date.now() and re-reads it every minute. */
  now?: number;
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
function withRecency(value: MapFilterValue, recency: PublicationRecency): MapFilterValue {
  return { ...value, filters: { ...value.filters, recency } };
}

export function MapHome({ deepLinkEventId = null, context = null, initialEvents, initialMarkers, now: fixedNow }: MapHomeProps) {
  const seed = useMemo(
    () => (initialEvents === undefined ? undefined : { events: initialEvents, markers: initialMarkers ?? NO_MARKERS }),
    [initialEvents, initialMarkers],
  );
  const data = usePublishedEvents(seed);
  const wide = useMediaMatch(WIDE_QUERY);
  const [clock, setClock] = useState(() => Date.now());
  const now = fixedNow ?? clock;
  // MAP-RECENT-01: the 24-hour window moves with the clock, so an open page drops events that age out of it.
  useEffect(() => {
    if (fixedNow !== undefined) return;
    const timer = window.setInterval(() => setClock(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, [fixedNow]);
  const [query, setQuery] = useState("");
  const [applied, setApplied] = useState<MapFilterValue>(DEFAULT_MAP_FILTER_VALUE);
  const [listOpen, setListOpen] = useState(wide);
  const [filterOpen, setFilterOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [view, setView] = useState<MapView>(MAP_DEFAULT_VIEW);
  const [flyRequest, setFlyRequest] = useState<MapFlyRequest | null>(null);
  const flyCounter = useRef(0);
  const islandRef = useRef<HTMLElement | null>(null);
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
  // MAP-RECENT-01: how many loaded events the 24-hour window alone hides, under the same search and other filters.
  const olderHiddenCount = useMemo(
    () => applied.filters.recency === "all"
      ? 0
      : filterPublishedEvents(data.events, query, { ...applied.filters, recency: "all" }, now).length - visibleEvents.length,
    [data.events, query, applied.filters, now, visibleEvents.length],
  );
  const recentOnly = applied.filters.recency === "24h";
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
      severity: severityOf(event),
    }];
  }), [visibleEvents, data.markers, selectedId]);
  // PERF-09: the OSM facility records (about 200 points) load only when the facility layer is switched on.
  const [facilityRecords, setFacilityRecords] = useState<readonly EmergencyFacility[] | null>(null);
  useEffect(() => {
    if (!applied.facilitiesOn || facilityRecords !== null) return;
    let cancelled = false;
    import("./emergency-facilities.js")
      .then((module) => {
        if (!cancelled) setFacilityRecords(module.EMERGENCY_FACILITIES);
      })
      .catch(() => {
        // The layer stays empty when the chunk cannot load. The filter sheet keeps its own note.
      });
    return () => {
      cancelled = true;
    };
  }, [applied.facilitiesOn, facilityRecords]);
  const facilities = useMemo(
    () => (applied.facilitiesOn && facilityRecords !== null
      ? facilityRecords.filter((facility) => applied.facilityKinds.includes(facility.kind))
      : []),
    [applied, facilityRecords],
  );
  const selectedEvent = selectedId !== null && visibleIds.has(selectedId) ? eventsById.get(selectedId) ?? null : null;
  const activeCount = countActiveFilters(applied.filters, applied.facilitiesOn);
  const filtersActive = activeCount > 0 || query.trim().length > 0;
  // HOSTED-34: a text query with no category, time or source filter gets the search-specific empty message.
  const searchOnly = activeCount === 0 && query.trim().length > 0;

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
    // A shared link to an older event widens the window, so the event it names is shown, never hidden by the default.
    setApplied(publishedRecently(target.event, now) ? DEFAULT_MAP_FILTER_VALUE : withRecency(DEFAULT_MAP_FILTER_VALUE, "all"));
    setSelectedId(target.event.event_id);
    setCopyMessage(null);
    if (target.marker) flyTo(target.marker.coordinate, MAP_DETAIL_ZOOM);
    // A whole_view event has no pin: show the whole Jakarta view (the recenter target), never another event's point.
    else if (target.event.location_display === "whole_view") flyTo(MAP_DEFAULT_VIEW.center, MAP_DEFAULT_VIEW.zoom, false);
    if (!wide) setListOpen(false);
    // The clock is read, not a dependency: a link is applied once, and a minute tick must not re-apply it.
  }, [deepLinkEventId, data.status, data.events, data.markers, wide]);

  // Focus moves into the popup only after a user action, never on a deep-link load.
  useEffect(() => {
    if (!focusPopupOnOpen.current || selectedEvent === null) return;
    focusPopupOnOpen.current = false;
    if (wide) popupRef.current?.focus({ preventScroll: true });
  }, [selectedEvent, wide]);

  /**
   * Glide the map to a place. For an event it lands right of the floating list and low enough that
   * the popup above the marker fits under the toolbar.
   */
  function flyTo(center: MapCoordinate, zoom: number, forEvent = true) {
    flyCounter.current += 1;
    const stage = stageRef.current;
    const offsetX = forEvent ? islandInset() / 2 : 0;
    const offsetY = forEvent && wide && stage ? Math.round(stage.getBoundingClientRect().height * POPUP_ROOM_RATIO) : 0;
    setFlyRequest({ id: flyCounter.current, center, zoom, offsetX, offsetY });
  }

  /** Width of the map strip covered by the floating list, measured from the map's left edge. */
  function islandInset(): number {
    const island = islandRef.current;
    const stage = stageRef.current;
    if (!island || !stage) return 0;
    return Math.max(0, island.getBoundingClientRect().right - stage.getBoundingClientRect().left);
  }

  function selectEvent(eventId: string, origin: { focus: boolean; opener: HTMLElement | null }) {
    setSelectedId(eventId);
    setCopyMessage(null);
    setDeepLinkMissing(false);
    focusPopupOnOpen.current = origin.focus;
    openerRef.current = origin.opener;
    const marker = data.markers.get(eventId);
    // Every selection glides to its event: zoom out, travel, zoom in, so moving between events stays smooth.
    if (marker) flyTo(marker.coordinate, Math.max(view.zoom, MAP_DETAIL_ZOOM));
    // A whole_view event has no pin: show the whole Jakarta view (the recenter target), never another event's point.
    else if (eventsById.get(eventId)?.location_display === "whole_view") flyTo(MAP_DEFAULT_VIEW.center, MAP_DEFAULT_VIEW.zoom, false);
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
    selectEvent(eventId, { focus: true, opener: null });
  }

  async function copyLink(eventId: string) {
    const copied = await copyText(eventShareUrl(eventId, window.location.href));
    setCopyMessage(copied ? "Tautan disalin." : "Salin otomatis tidak tersedia. Tautan sudah ada di bilah alamat.");
  }

  function resetFilters() {
    setQuery("");
    setApplied(DEFAULT_MAP_FILTER_VALUE);
  }

  function setRecency(recency: PublicationRecency) {
    setApplied((current) => withRecency(current, recency));
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
      ? popupAnchor(projection.project(marker.coordinate), projection.width, projection.height, listOpen ? islandInset() : 0)
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
      searchOnly={searchOnly}
      recency={applied.filters.recency}
      olderHiddenCount={olderHiddenCount}
      onShowAll={() => setRecency("all")}
      errorMessage={data.errorMessage}
      onSelect={openFromList}
      onReset={resetFilters}
      onRetry={data.reload}
    />
  );

  return (
    <main id="main-content" tabIndex={-1} className={`map-home${wide && listOpen ? " map-home--island" : ""}`}>
      <h1 className="visually-hidden">Peta laporan terbit</h1>
      <div className="map-home__body">
        {wide && listOpen && (
          <aside ref={islandRef} className="map-home__panel" aria-labelledby={LIST_HEADING_ID}>
            {listContent}
          </aside>
        )}

        <div className="map-home__stage" ref={stageRef} tabIndex={-1}>
          <EventMapCanvas
            label={MAP_LABEL}
            view={view}
            onViewChange={setView}
            markers={canvasMarkers}
            onSelectMarker={(eventId, element) => selectEvent(eventId, { focus: true, opener: element })}
            facilities={facilities}
            showRecenter={!isDefaultMapView(view)}
            onRecenter={() => flyTo(MAP_DEFAULT_VIEW.center, MAP_DEFAULT_VIEW.zoom, false)}
            flyRequest={flyRequest}
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
              aria-label={activeCount > 0 ? `Filter ${activeCount} aktif` : "Filter"}
              onClick={() => setFilterOpen(true)}
            >
              <svg className="map-home__icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <path d="M4 6h16M7 12h10M10 18h4" />
              </svg>
              <span className="map-home__tool-label">Filter</span>{" "}
              {activeCount > 0 && <span className="count-chip map-home__count">{activeCount}</span>}
            </button>
            <button
              type="button"
              className="button button--quiet map-home__tool"
              aria-expanded={listOpen}
              aria-label={`Daftar ${visibleEvents.length} laporan`}
              onClick={() => setListOpen((open) => !open)}
            >
              <svg className="map-home__icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01" />
              </svg>
              <span className="map-home__tool-label">Daftar</span>{" "}
              <span className="count-chip map-home__count">{visibleEvents.length}</span>
            </button>
          </div>

          {/* MAP-RECENT-01: the map says which window its pins cover. It is a caption, not a sixth first-screen control:
              the window changes from the list or the filter sheet. Hidden while the side panel shows the same line. */}
          {recentOnly && data.status === "loaded" && !(wide && listOpen) && (
            <p className="map-home__scope">
              <svg className="map-home__scope-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <circle cx="12" cy="12" r="9" />
                <path d="M12 7v5l3 2" />
              </svg>
              <span>{RECENT_SCOPE_TEXT}</span>
              {olderHiddenCount > 0 && <span className="map-home__scope-more">{olderHiddenCount} laporan lebih lama disembunyikan</span>}
            </p>
          )}

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

          <MapLegend />

          {/* The map screen has no page footer: the same notice floats over the map. */}
          <footer className="map-home__footer">
            <span className="map-home__footer-text map-home__footer-text--long">
              Data dari sumber publik dan laporan warga; bukan layanan darurat. Darurat: 112.
            </span>
            <span className="map-home__footer-text map-home__footer-text--short">Bukan layanan darurat. Darurat: 112.</span>
            <nav className="map-home__footer-links" aria-label="Tautan bawah">
              <a href="#unduh">Aplikasi Android</a>
              <a href="#bantuan">Bantuan</a>
              <a href="#privasi">Privasi</a>
            </nav>
          </footer>
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
