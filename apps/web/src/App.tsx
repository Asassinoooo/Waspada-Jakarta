import { useEffect, useReducer, useState } from "react";
import type { Category, EventDetail as EventDetailRecord, EventView, FreshnessStatus, HistoryPage, Lifecycle, PublicContext } from "@waspada/worker/public-contracts";
import { ApiHttpError, getEventDetail, getEventGeoJSON, getEventHistory, getPublicContext, listEvents, type ApiReadState, type PublicGeoJSONFilters } from "./api-client.js";
import { EventDetail } from "./EventDetail.js";
import { DEFAULT_FEED_FILTERS, EventFeed, type FeedFilters, type FeedStatus, type MobileDiscoveryPanel } from "./EventFeed.js";
import { ModeratorReview } from "./ModeratorReview.js";
import { Preferences } from "./Preferences.js";
import type { GeoJSONMapState, MapSelection } from "./MapPanel.js";

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

const feedCategories: readonly Category[] = [
  "crime_personal_security",
  "demonstrations_public_gatherings",
  "crowds_major_events",
  "violence_immediate_threats",
  "disasters_weather",
  "fires_infrastructure_hazards",
  "transport_road_incidents",
  "utilities_essential_services",
  "health_environmental_advisories",
  "group_specific_critical_notices",
];
const feedLifecycles: readonly Lifecycle[] = ["planned", "ongoing", "resolved", "cancelled", "unknown"];
const feedFreshnessStatuses: readonly FreshnessStatus[] = ["current", "needs_update", "expired"];

function queryFilter<T extends string>(params: URLSearchParams, name: string, allowed: readonly T[]): T | "all" {
  const value = params.get(name);
  return value !== null && allowed.includes(value as T) ? value as T : "all";
}

export function discoveryStateFromSearch(search: string): DiscoveryState {
  const params = new URLSearchParams(search);
  return {
    query: params.get("q") ?? "",
    filters: {
      category: queryFilter(params, "category", feedCategories),
      lifecycle: queryFilter(params, "lifecycle", feedLifecycles),
      freshness: queryFilter(params, "freshness", feedFreshnessStatuses),
    },
    mapSelection: { kind: "none" },
  };
}

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
  return discoveryStateFromSearch(window.location.search);
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

export function SiteHeader({ route, context = null }: { route: Route; context?: PublicContext | null }) {
  const onDiscover = route.screen === "discover" || route.screen.startsWith("detail");
  const datasetMode = context?.dataset_mode;
  const modeText = datasetMode === "demo"
    ? "Mode demo"
    : datasetMode === "live"
      ? "Mode live"
      : "Status dataset tidak tersedia";
  const bannerLabel = datasetMode === "demo" ? "DEMO" : datasetMode === "live" ? "LIVE" : "—";
  const bannerTitle = datasetMode === "demo"
    ? "DEMO — data sintetis; bukan peringatan langsung"
    : datasetMode === "live"
      ? "LIVE — record berasal dari dataset live API"
      : "Status dataset tidak tersedia.";
  const bannerDetail = datasetMode === "demo"
    ? "Fixture presentasi tetap terpisah dari record API."
    : datasetMode === "live"
      ? "Waktu dan kesegaran tercantum per record; cakupan mengikuti data API yang dimuat."
      : "Jenis dataset belum dapat diverifikasi.";

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
        <span className="mode-chip">{modeText}</span>
      </header>
      <section
        className={"demo-banner" + (datasetMode === "live" ? " demo-banner--live" : datasetMode === undefined ? " demo-banner--unknown" : "")}
        aria-label="Status dataset"
      >
        <span className="demo-banner__mark" aria-hidden="true">{bannerLabel}</span>
        <strong>{bannerTitle}</strong>
        <span className="demo-banner__detail">{bannerDetail}</span>
      </section>
    </>
  );
}

export function PresentationRoute({ context }: { context: PublicContext | null }) {
  if (context?.dataset_mode === "demo") {
    return <EventDetail mode="presentation" context={context} />;
  }

  return (
    <main id="main-content" className="main-shell">
      <section className="state-panel" role="status">
        <strong>{context === null ? "Status dataset tidak tersedia." : "Fixture presentasi hanya tersedia pada dataset demo."}</strong>
        <p>
          {context === null
            ? "Fixture presentasi disembunyikan sampai status dataset tersedia."
            : "Record presentasi tidak ditampilkan pada dataset live."}
        </p>
        <a className="text-link" href="#jelajah">Kembali ke jelajah</a>
      </section>
    </main>
  );
}

export function App() {
  const [status, setStatus] = useState<FeedStatus>("loading");
  const [context, setContext] = useState<PublicContext | null>(null);
  const [events, setEvents] = useState<EventView[]>([]);
  const [geoJSONState, setGeoJSONState] = useState<GeoJSONMapState>({ status: "idle" });
  const [route, setRoute] = useState<Route>(() => routeFromHash(window.location.hash));
  const [retryKey, setRetryKey] = useState(0);
  const [mapRetryKey, setMapRetryKey] = useState(0);
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
    for (const [name, value] of Object.entries(discovery.filters)) {
      if (value === "all") url.searchParams.delete(name);
      else url.searchParams.set(name, value);
    }
    if (mobilePanel === "map") url.searchParams.set("panel", "map");
    else url.searchParams.delete("panel");
    window.history.replaceState(window.history.state, "", url.pathname + url.search + url.hash);
  }, [discovery.query, discovery.filters.category, discovery.filters.lifecycle, discovery.filters.freshness, mobilePanel]);

  useEffect(() => {
    if (route.screen === "preferences") return;
    let cancelled = false;
    setStatus("loading");

    listEvents()
      .then((page) => {
        if (cancelled) return;
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

  useEffect(() => {
    if (route.screen === "preferences") return;
    let cancelled = false;
    setContext(null);

    getPublicContext()
      .then((nextContext) => {
        if (!cancelled) setContext(nextContext);
      })
      .catch(() => {
        if (!cancelled) setContext(null);
      });

    return () => {
      cancelled = true;
    };
  }, [retryKey, route.screen]);

  const { category, lifecycle, freshness } = discovery.filters;
  useEffect(() => {
    if (route.screen !== "discover" || status !== "loaded" || context === null) {
      setGeoJSONState({ status: "idle" });
      return;
    }

    let cancelled = false;
    setGeoJSONState({ status: "loading" });
    const filters: PublicGeoJSONFilters = {
      ...(category === "all" ? {} : { category }),
      ...(lifecycle === "all" ? {} : { lifecycle }),
      ...(freshness === "all" ? {} : { freshness }),
    };

    getEventGeoJSON(filters)
      .then((data) => {
        if (!cancelled) setGeoJSONState({ status: "loaded", data });
      })
      .catch(() => {
        if (!cancelled) setGeoJSONState({ status: "unavailable" });
      });

    return () => {
      cancelled = true;
    };
  }, [category, context?.dataset_mode, context, freshness, lifecycle, mapRetryKey, route.screen, status]);

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
      <SiteHeader route={route} context={context} />
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
          geoJSONState={geoJSONState}
          onSelectApiEvent={(event, featureId) => dispatchDiscovery({
            type: "map-selection-changed",
            selection: featureId === undefined
              ? { kind: "api-event", event }
              : { kind: "api-event", event, featureId },
          })}
          onSelectPresentation={() => {
            dispatchDiscovery({ type: "map-selection-changed", selection: { kind: "presentation" } });
            setMobilePanel("map");
          }}
          onRetryMap={() => setMapRetryKey((current) => current + 1)}
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
        <PresentationRoute context={context} />
      )}
      {route.screen === "preferences" && <Preferences />}
      {route.screen === "review" && <ModeratorReview />}
      <footer className="site-footer">
        <span>
          {context?.dataset_mode === "demo"
            ? "Mode demo · record API sintetis dan fixture presentasi ditandai terpisah."
            : context?.dataset_mode === "live"
              ? "Mode live · data berasal dari API; cakupan sesuai halaman yang dimuat."
              : "Status dataset tidak tersedia."}
        </span>
        <a href="#jelajah">Kembali ke jelajah</a>
      </footer>
    </div>
  );
}
