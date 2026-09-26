import { useEffect, useReducer, useState } from "react";
import type { Category, EventDetail as EventDetailRecord, EventView, FreshnessStatus, HistoryPage, Lifecycle, PublicContext } from "@waspada/worker/public-contracts";
import { ApiHttpError, getEventDetail, getEventHistory, getPublicContext, listEvents, type ApiReadState } from "./api-client.js";
import { EventDetail } from "./EventDetail.js";
import { DEFAULT_FEED_FILTERS, EventFeed, type FeedFilters, type FeedStatus, type MobileDiscoveryPanel } from "./EventFeed.js";
import { ModeratorReview } from "./ModeratorReview.js";
import { Preferences } from "./Preferences.js";
import type { MapSelection } from "./MapPanel.js";

type Route =
  | { screen: "discover" }
  | { screen: "preferences" }
  | { screen: "review" }
  | { screen: "detail-presentation" }
  | { screen: "detail-api"; eventId: string };

export interface DiscoveryState {
  query: string;
  filters: FeedFilters;
  mapSelection: MapSelection;
}

export type DiscoveryAction =
  | { type: "query-changed"; query: string }
  | { type: "category-changed"; value: Category | "all" }
  | { type: "lifecycle-changed"; value: Lifecycle | "all" }
  | { type: "freshness-changed"; value: FreshnessStatus | "all" }
  | { type: "filters-cleared" }
  | { type: "map-selection-changed"; selection: MapSelection };

export function discoveryStateReducer(state: DiscoveryState, action: DiscoveryAction): DiscoveryState {
  switch (action.type) {
    case "query-changed":
      return state.query === action.query
        ? state
        : { ...state, query: action.query, mapSelection: { kind: "none" } };
    case "category-changed":
      return state.filters.category === action.value
        ? state
        : {
            ...state,
            filters: { ...state.filters, category: action.value },
            mapSelection: { kind: "none" },
          };
    case "lifecycle-changed":
      return state.filters.lifecycle === action.value
        ? state
        : {
            ...state,
            filters: { ...state.filters, lifecycle: action.value },
            mapSelection: { kind: "none" },
          };
    case "freshness-changed":
      return state.filters.freshness === action.value
        ? state
        : {
            ...state,
            filters: { ...state.filters, freshness: action.value },
            mapSelection: { kind: "none" },
          };
    case "filters-cleared":
      return { query: "", filters: { ...DEFAULT_FEED_FILTERS }, mapSelection: { kind: "none" } };
    case "map-selection-changed":
      return { ...state, mapSelection: action.selection };
  }
}

function initialDiscoveryState(): DiscoveryState {
  return {
    query: new URLSearchParams(window.location.search).get("q") ?? "",
    filters: { ...DEFAULT_FEED_FILTERS },
    mapSelection: { kind: "none" },
  };
}

function apiFailure<T>(eventId: string, error: unknown): ApiReadState<T> {
  return {
    eventId,
    status: error instanceof ApiHttpError && error.status === 404 ? "not-found" : "unavailable",
  };
}

export function routeFromHash(hash: string): Route {
  if (hash === "#ringkasan-saya") return { screen: "preferences" };
  if (hash === "#tinjau-bukti") return { screen: "review" };
  if (hash === "#detail/presentation") return { screen: "detail-presentation" };
  if (hash.startsWith("#detail/api/")) {
    try {
      return { screen: "detail-api", eventId: decodeURIComponent(hash.slice("#detail/api/".length)) };
    } catch {
      return { screen: "detail-api", eventId: "" };
    }
  }
  return { screen: "discover" };
}

export function SiteHeader({ route }: { route: Route }) {
  const onDiscover = route.screen === "discover" || route.screen.startsWith("detail");
  return (
    <>
      <a className="skip-link" href="#main-content">Lewati ke konten utama</a>
      <header className="site-header">
        <a className="brand" href="#jelajah" aria-label="Waspada Jakarta, ke jelajah">
          <span className="brand-mark" aria-hidden="true">WJ</span>
          <span><strong>Waspada Jakarta</strong><small>Informasi dengan jejak sumber</small></span>
        </a>
        <nav className="primary-nav" aria-label="Navigasi utama">
          <a href="#jelajah" aria-current={onDiscover ? "page" : undefined}>Jelajah</a>
          <a href="#ringkasan-saya" aria-current={route.screen === "preferences" ? "page" : undefined}>Ringkasan saya</a>
          <a href="#tinjau-bukti" aria-current={route.screen === "review" ? "page" : undefined}>Tinjau bukti</a>
        </nav>
        <span className="mode-chip">Mode demo</span>
      </header>
      <section className="demo-banner" aria-label="Peringatan mode demo">
        <span className="demo-banner__mark" aria-hidden="true">DEMO</span>
        <strong>DEMO — data sintetis; bukan peringatan langsung</strong>
        <span className="demo-banner__detail">Tidak ada sumber live yang terhubung.</span>
      </section>
    </>
  );
}

export function App() {
  const [status, setStatus] = useState<FeedStatus>("loading");
  const [context, setContext] = useState<PublicContext | null>(null);
  const [events, setEvents] = useState<EventView[]>([]);
  const [route, setRoute] = useState<Route>(() => routeFromHash(window.location.hash));
  const [retryKey, setRetryKey] = useState(0);
  const [detailRetryKey, setDetailRetryKey] = useState(0);
  const [historyRetryKey, setHistoryRetryKey] = useState(0);
  const [detailState, setDetailState] = useState<ApiReadState<EventDetailRecord> | null>(null);
  const [historyState, setHistoryState] = useState<ApiReadState<HistoryPage> | null>(null);
  const [discovery, dispatchDiscovery] = useReducer(discoveryStateReducer, undefined, initialDiscoveryState);
  const [mobilePanel, setMobilePanel] = useState<MobileDiscoveryPanel>(() =>
    new URLSearchParams(window.location.search).get("panel") === "map" ? "map" : "list",
  );

  useEffect(() => {
    const updateRoute = () => setRoute(routeFromHash(window.location.hash));
    if (!window.location.hash) window.history.replaceState(null, "", "#jelajah");
    window.addEventListener("hashchange", updateRoute);
    return () => window.removeEventListener("hashchange", updateRoute);
  }, []);

  useEffect(() => {
    const url = new URL(window.location.href);
    if (discovery.query) url.searchParams.set("q", discovery.query);
    else url.searchParams.delete("q");
    if (mobilePanel === "map") url.searchParams.set("panel", "map");
    else url.searchParams.delete("panel");
    window.history.replaceState(window.history.state, "", url.pathname + url.search + url.hash);
  }, [discovery.query, mobilePanel]);

  useEffect(() => {
    if (route.screen === "preferences") return;
    let cancelled = false;
    setStatus("loading");

    Promise.all([getPublicContext(), listEvents()])
      .then(([nextContext, page]) => {
        if (cancelled) return;
        setContext(nextContext);
        setEvents(page.data);
        setStatus("loaded");
      })
      .catch(() => {
        if (!cancelled) setStatus("unavailable");
      });

    return () => {
      cancelled = true;
    };
  }, [retryKey, route.screen]);

  const detailEventId = route.screen === "detail-api" ? route.eventId : null;

  useEffect(() => {
    if (detailEventId === null) return;
    let cancelled = false;
    setDetailState({ eventId: detailEventId, status: "loading" });
    getEventDetail(detailEventId)
      .then((data) => {
        if (!cancelled) setDetailState({ eventId: detailEventId, status: "loaded", data });
      })
      .catch((error: unknown) => {
        if (!cancelled) setDetailState(apiFailure(detailEventId, error));
      });
    return () => {
      cancelled = true;
    };
  }, [detailEventId, detailRetryKey]);

  useEffect(() => {
    if (detailEventId === null) return;
    let cancelled = false;
    setHistoryState({ eventId: detailEventId, status: "loading" });
    getEventHistory(detailEventId)
      .then((data) => {
        if (!cancelled) setHistoryState({ eventId: detailEventId, status: "loaded", data });
      })
      .catch((error: unknown) => {
        if (!cancelled) setHistoryState(apiFailure(detailEventId, error));
      });
    return () => {
      cancelled = true;
    };
  }, [detailEventId, historyRetryKey]);

  const currentDetailState = route.screen === "detail-api"
    ? detailState?.eventId === route.eventId
      ? detailState
      : { eventId: route.eventId, status: "loading" as const }
    : undefined;
  const currentHistoryState = route.screen === "detail-api"
    ? historyState?.eventId === route.eventId
      ? historyState
      : { eventId: route.eventId, status: "loading" as const }
    : undefined;

  return (
    <div className="app-shell">
      <SiteHeader route={route} />
      {route.screen === "discover" && (
        <EventFeed
          status={status}
          events={events}
          context={context}
          query={discovery.query}
          onQueryChange={(query) => dispatchDiscovery({ type: "query-changed", query })}
          filters={discovery.filters}
          onCategoryChange={(value) => dispatchDiscovery({ type: "category-changed", value })}
          onLifecycleChange={(value) => dispatchDiscovery({ type: "lifecycle-changed", value })}
          onFreshnessChange={(value) => dispatchDiscovery({ type: "freshness-changed", value })}
          onClearFilters={() => dispatchDiscovery({ type: "filters-cleared" })}
          onRetry={() => setRetryKey((current) => current + 1)}
          mapSelection={discovery.mapSelection}
          onSelectApiEvent={(event) => dispatchDiscovery({ type: "map-selection-changed", selection: { kind: "api-event", event } })}
          onSelectPresentation={() => {
            dispatchDiscovery({ type: "map-selection-changed", selection: { kind: "presentation" } });
            setMobilePanel("map");
          }}
          mobilePanel={mobilePanel}
          onMobilePanelChange={setMobilePanel}
        />
      )}
      {route.screen === "detail-api" && currentDetailState && currentHistoryState && (
        <EventDetail
          mode="api-event"
          apiDetail={currentDetailState}
          apiHistory={currentHistoryState}
          onRetryDetail={() => setDetailRetryKey((current) => current + 1)}
          onRetryHistory={() => setHistoryRetryKey((current) => current + 1)}
          context={context}
        />
      )}
      {route.screen === "detail-presentation" && (
        <EventDetail
          mode="presentation"
          context={context}
        />
      )}
      {route.screen === "preferences" && <Preferences />}
      {route.screen === "review" && <ModeratorReview />}
      <footer className="site-footer">
        <span>Demo lokal · semua record dan segmen contoh bersifat sintetis.</span>
        <a href="#jelajah">Kembali ke jelajah</a>
      </footer>
    </div>
  );
}
