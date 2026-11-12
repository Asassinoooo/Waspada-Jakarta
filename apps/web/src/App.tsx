import { lazy, Suspense, useCallback, useEffect, useReducer, useRef, useState } from "react";
import type { Category, EventDetail as EventDetailRecord, EventView, FreshnessStatus, HistoryPage, Lifecycle, PublicContext } from "@waspada/worker/public-contracts";
import { apiReadFailure, getEventDetail, getEventHistory, getPublicContext, listEvents, type ApiReadState } from "./api-client.js";
import { EventDetail } from "./EventDetail.js";
import { DEFAULT_FEED_FILTERS, type FeedFilters, type FeedStatus, type MobileDiscoveryPanel } from "./EventFeed.js";
import { ModeratorReview } from "./ModeratorReview.js";
import { MapHome } from "./MapHome.js";
import { parseEventIdFromHash } from "./map-links.js";
import { Preferences } from "./Preferences.js";
import { UpdatesCenter } from "./UpdatesCenter.js";
import { UnifiedSourceExplorer } from "./UnifiedSourceExplorer.js";
import { SourcePointMap } from "./SourcePointMap.js";
import type { MapSelection } from "./MapPanel.js";
import { HelpPage } from "./HelpPage.js";
import { AccountAccessGate, AccountPage, type AccountSessionState, hasProtectedShellAccess } from "./AccountPages.js";
import { accountClient, type AccountReturnTarget } from "./account-client.js";
import { SiteFooter, SiteHeader } from "./AppShell.js";
import { introAutoOpenFor, OnboardingIntro } from "./OnboardingIntro.js";

const AdminDashboard = lazy(() => import("./admin-entry.js"));

export type Route =
  | { screen: "discover"; eventId?: string }
  | { screen: "help"; section?: "panduan" | "privasi" }
  | { screen: "preferences" }
  | { screen: "updates" }
  | { screen: "login"; returnTo?: AccountReturnTarget }
  | { screen: "onboarding" }
  | { screen: "account" }
  | { screen: "review" }
  | { screen: "pipeline-flow" }
  | { screen: "source-preview" }
  | { screen: "local-pipeline" }
  | { screen: "embedding-3d" }
  | { screen: "admin" }
  | { screen: "detail-presentation" }
  | { screen: "detail-api"; eventId: string };

const LocalPipelinePreview = import.meta.env?.DEV === true
  ? lazy(() => import("./LocalPipelinePreview.js").then((module) => ({ default: module.LocalPipelinePreview })))
  : null;
// FLOW-VIS-01: the moderator flow view and React Flow load only on #alur-agen.
const PipelineFlow = lazy(() => import("./pipeline-flow-entry.js"));
const Embedding3DVisualization = lazy(() =>
  import("./Embedding3DVisualization.js").then((module) => ({ default: module.Embedding3DVisualization }))
);

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

// Public map home (#peta). The older landing and report hashes keep working and land on the same screen.
const DISCOVER_HASHES: ReadonlySet<string> = new Set([
  "",
  "#peta",
  "#beranda",
  "#jelajah",
  "#laporan-publik",
  "#laporan-publik-demo",
  "#publik-demo",
]);

/** Admin workspace tabs (`#admin/<tab>`). Phase C turns them into real tabs; for now each maps to an existing screen. */
function adminTabRoute(tab: string): Route {
  switch (tab) {
    case "tinjau":
      return { screen: "review" };
    case "alur":
      return { screen: "pipeline-flow" };
    case "embedding":
      return { screen: "embedding-3d" };
    case "sumber":
      return { screen: "source-preview" };
    default:
      // ringkasan, akun and unknown tabs open the administrator workspace.
      return { screen: "admin" };
  }
}

export function routeFromHash(hash: string): Route {
  // `#peta?event=<id>` keeps its query, so the map can select that event. The path decides the screen.
  const queryStart = hash.indexOf("?");
  const path = queryStart === -1 ? hash : hash.slice(0, queryStart);
  if (DISCOVER_HASHES.has(path)) {
    const eventId = parseEventIdFromHash(hash);
    return eventId === null ? { screen: "discover" } : { screen: "discover", eventId };
  }
  if (hash.startsWith("#admin/")) return adminTabRoute(hash.slice("#admin/".length));
  if (hash === "#masuk") return { screen: "login" };
  if (hash.startsWith("#masuk?")) {
    const params = new URLSearchParams(hash.slice("#masuk?".length));
    const returnTo = params.get("return_to");
    return {
      screen: "login",
      ...(returnTo === "#akun" || returnTo === "#mulai" || returnTo === "#admin" || returnTo === "#tinjau-bukti" ? { returnTo } : {}),
    };
  }
  if (hash === "#mulai") return { screen: "onboarding" };
  if (hash === "#akun") return { screen: "account" };
  if (hash === "#bantuan") return { screen: "help" };
  if (hash === "#panduan") return { screen: "help", section: "panduan" };
  if (hash === "#privasi") return { screen: "help", section: "privasi" };
  if (hash === "#admin" || hash === "#admin-workspace") return { screen: "admin" };
  if (hash === "#pipeline-lokal" && import.meta.env?.DEV === true) return { screen: "local-pipeline" };
  if (hash === "#demo-sumber") return { screen: "source-preview" };
  if (hash === "#visualisasi-3d" || hash === "#embedding-3d") return { screen: "embedding-3d" };
  if (hash === "#ringkasan-saya") return { screen: "preferences" };
  if (hash === "#pembaruan") return { screen: "updates" };
  if (hash === "#tinjau-bukti") return { screen: "review" };
  if (hash === "#alur-agen") return { screen: "pipeline-flow" };
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

export function PresentationRoute({ context }: { context: PublicContext | null }) {
  if (context?.dataset_mode === "demo") {
    return <EventDetail mode="presentation" context={context} />;
  }

  return (
    <main id="main-content" tabIndex={-1} className="main-shell">
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
  const [route, setRoute] = useState<Route>(() => routeFromHash(window.location.hash));
  const [routeActivation, setRouteActivation] = useState(0);
  const [narrowScreen, setNarrowScreen] = useState(() => window.matchMedia("(max-width: 900px)").matches);
  const [sessionRevision, setSessionRevision] = useState(0);
  const [sessionResult, setSessionResult] = useState<{
    scope: "login" | "onboarding" | "account" | "admin" | "review" | "pipeline-flow" | "source-preview";
    activation: number;
    revision: number;
    state: AccountSessionState;
  } | null>(null);
  const [localDataRevision, setLocalDataRevision] = useState(0);
  const contextRequestKey = route.screen;
  const [contextResult, setContextResult] = useState<{ requestKey: string; value: PublicContext | null } | null>(null);
  const context = contextResult?.requestKey === contextRequestKey ? contextResult.value : null;
  // The map home (MapHome) reads and owns the published list and geometry. Events here are only the
  // live SSE and refresh path for the other screens.
  const [, setStatus] = useState<FeedStatus>("loading");
  const [, setEvents] = useState<EventView[]>([]);
  const [detailRetryKey, setDetailRetryKey] = useState(0);
  const [historyRetryKey, setHistoryRetryKey] = useState(0);
  const [detailState, setDetailState] = useState<ApiReadState<EventDetailRecord> | null>(null);
  const [historyState, setHistoryState] = useState<ApiReadState<HistoryPage> | null>(null);
  const [discovery, dispatchDiscovery] = useReducer(discoveryStateReducer, undefined, initialDiscoveryState);
  const [mobilePanel, setMobilePanel] = useState<MobileDiscoveryPanel>(() =>
    new URLSearchParams(window.location.search).get("panel") === "map" ? "map" : "list",
  );
  void dispatchDiscovery;
  void setMobilePanel;
  const sessionScope = route.screen === "login" || route.screen === "onboarding" || route.screen === "account" || route.screen === "admin" || route.screen === "review" || route.screen === "pipeline-flow" || route.screen === "source-preview"
    ? route.screen
    : null;
  const sessionState: AccountSessionState = sessionScope === null || sessionResult?.scope !== sessionScope || sessionResult.activation !== routeActivation || sessionResult.revision !== sessionRevision
    ? { status: "loading", session: null }
    : sessionResult.state;
  const refreshAccountSession = useCallback(() => setSessionRevision((current) => current + 1), []);

  useEffect(() => {
    const media = window.matchMedia("(max-width: 900px)");
    const updateNarrowScreen = () => setNarrowScreen(media.matches);
    updateNarrowScreen();
    media.addEventListener("change", updateNarrowScreen);
    return () => media.removeEventListener("change", updateNarrowScreen);
  }, []);

  useEffect(() => {
    if (sessionScope === null) return;
    const controller = new AbortController();
    let cancelled = false;
    accountClient.getSession(controller.signal)
      .then((session) => {
        if (cancelled) return;
        setSessionResult({
          scope: sessionScope,
          activation: routeActivation,
          revision: sessionRevision,
          state: session.status === "anonymous"
            ? { status: "anonymous", session }
            : { status: "authenticated", session },
        });
      })
      .catch(() => {
        if (!cancelled) setSessionResult({ scope: sessionScope, activation: routeActivation, revision: sessionRevision, state: { status: "error", session: null } });
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [routeActivation, sessionScope, sessionRevision]);

  useEffect(() => {
    if (sessionScope !== "admin" && sessionScope !== "review" && sessionScope !== "pipeline-flow" && sessionScope !== "source-preview") return;
    const refreshOnFocus = () => {
      if (document.visibilityState === "visible") refreshAccountSession();
    };
    const interval = window.setInterval(refreshAccountSession, 60_000);
    window.addEventListener("focus", refreshOnFocus);
    document.addEventListener("visibilitychange", refreshOnFocus);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("focus", refreshOnFocus);
      document.removeEventListener("visibilitychange", refreshOnFocus);
    };
  }, [refreshAccountSession, sessionScope]);
  const refreshCurrentEvents = useCallback(async () => {
    const page = await listEvents();
    setEvents(page.data);
    setStatus("loaded");
  }, []);

  useEffect(() => {
    const updateRoute = () => {
      // In-page focus targets preserve the selected public/admin screen.
      if (window.location.hash === "#main-content" || window.location.hash === "#admin-workspace") return;
      setRouteActivation((current) => current + 1);
      setRoute(routeFromHash(window.location.hash));
    };
    if (!window.location.hash) window.history.replaceState(null, "", "#peta");
    window.addEventListener("hashchange", updateRoute);
    return () => window.removeEventListener("hashchange", updateRoute);
  }, []);

  const routeKey = route.screen === "detail-api"
    ? `${route.screen}:${route.eventId}`
    : route.screen === "help"
      ? `${route.screen}:${route.section ?? "all"}`
      : route.screen;
  const previousRouteKey = useRef<string | null>(route.screen === "help" && route.section ? null : routeKey);
  useEffect(() => {
    if (previousRouteKey.current === routeKey) return;
    previousRouteKey.current = routeKey;
    window.scrollTo({ top: 0, left: 0, behavior: "instant" });
    const targetId = route.screen === "help" && route.section ? route.section : "main-content";
    const target = document.getElementById(targetId);
    if (route.screen === "help" && route.section) target?.scrollIntoView({ block: "start", behavior: "instant" });
    target?.focus({ preventScroll: true });
  }, [routeKey]);

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

  // Real-time Public Events SSE Stream (Zero-polling live updates)
  useEffect(() => {
    if (typeof window === "undefined" || typeof EventSource === "undefined") return;
    let eventSource: EventSource | null = null;
    try {
      eventSource = new EventSource("/api/v1/events/stream");
      eventSource.addEventListener("event_published", (e: MessageEvent) => {
        try {
          const published = JSON.parse(e.data) as EventView;
          if (published && published.event_id) {
            setEvents((prev) => {
              const exists = prev.some((ev) => ev.event_id === published.event_id);
              if (exists) {
                return prev.map((ev) => (ev.event_id === published.event_id ? published : ev));
              }
              return [published, ...prev];
            });
            setStatus("loaded");
          }
        } catch {}
      });
    } catch {}

    return () => {
      if (eventSource) {
        eventSource.close();
      }
    };
  }, []);

  useEffect(() => {
    if (route.screen === "admin") return;
    let cancelled = false;

    getPublicContext()
      .then((nextContext) => {
        if (!cancelled) setContextResult({ requestKey: contextRequestKey, value: nextContext });
      })
      .catch(() => {
        if (!cancelled) setContextResult({ requestKey: contextRequestKey, value: null });
      });

    return () => {
      cancelled = true;
    };
  }, [contextRequestKey]);

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
        if (!cancelled) setDetailState(apiReadFailure(detailEventId, error));
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
        if (!cancelled) setHistoryState(apiReadFailure(detailEventId, error));
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

  if (route.screen === "admin") {
    const gate = <AccountAccessGate shell="admin" sessionState={sessionState} isNarrowScreen={narrowScreen} onRefreshSession={refreshAccountSession} />;
    if (narrowScreen || sessionState.status !== "authenticated" || !hasProtectedShellAccess("admin", sessionState.session)) {
      return <div className="app-shell app-shell--admin">{gate}</div>;
    }
    return (
      <div className="app-shell app-shell--admin">
        <a className="skip-link" href="#main-content">Lewati ke konten utama</a>
        <nav className="admin-shell-tools" aria-label="Akun dan layanan publik"><a href="#akun">Akun administrator</a><a href="#beranda">Kembali ke layanan publik</a></nav>
        <Suspense fallback={
          <main id="main-content" tabIndex={-1} className="main-shell">
            <section className="state-panel" role="status">
              <strong>Memuat ruang operasi web…</strong>
              <p>Simulasi alur dan pantauan endpoint publik, hanya baca.</p>
              <a className="text-link" href="#beranda">Kembali ke layanan publik</a>
            </section>
          </main>
        }>
          <AdminDashboard />
        </Suspense>
      </div>
    );
  }

  return (
    <div className={`app-shell${route.screen === "source-preview" ? " app-shell--source-map" : ""}${route.screen === "discover" ? " app-shell--map" : ""}`}>
      <SiteHeader route={route} context={context} sessionKey={routeActivation} />
      {route.screen === "discover" && (
        <MapHome deepLinkEventId={route.eventId ?? null} context={context} />
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
      {route.screen === "preferences" && <Preferences key={localDataRevision} context={context} contextSnapshotId={contextRequestKey} />}
      {route.screen === "updates" && <UpdatesCenter key={localDataRevision} context={context} refreshCurrentEvents={refreshCurrentEvents} />}
      {route.screen === "login" && <AccountPage screen="login" sessionState={sessionState} returnTo={route.returnTo} isNarrowScreen={narrowScreen} onRefreshSession={refreshAccountSession} />}
      {route.screen === "onboarding" && <AccountPage screen="onboarding" sessionState={sessionState} isNarrowScreen={narrowScreen} onRefreshSession={refreshAccountSession} />}
      {route.screen === "account" && <AccountPage screen="account" sessionState={sessionState} isNarrowScreen={narrowScreen} onRefreshSession={refreshAccountSession} />}
      {route.screen === "help" && (
        <HelpPage
          section={route.section}
          showLocalPipeline={import.meta.env?.DEV === true && context?.dataset_mode === "demo"}
          onCleared={() => setLocalDataRevision((revision) => revision + 1)}
        />
      )}
      {route.screen === "review" && (sessionState.status === "authenticated" && hasProtectedShellAccess("review", sessionState.session)
        ? <ModeratorReview />
        : <AccountAccessGate shell="review" sessionState={sessionState} isNarrowScreen={narrowScreen} onRefreshSession={refreshAccountSession} />)}
      {route.screen === "local-pipeline" && LocalPipelinePreview !== null && (
        <Suspense fallback={<main id="main-content" className="main-shell"><section className="state-panel" role="status">Memuat tampilan lokal…</section></main>}>
          <LocalPipelinePreview enabled={import.meta.env?.DEV === true && context?.dataset_mode === "demo"} />
        </Suspense>
      )}
      {route.screen === "pipeline-flow" && (sessionState.status === "authenticated" && hasProtectedShellAccess("review", sessionState.session)
        ? (
          <Suspense fallback={<main id="main-content" tabIndex={-1} className="main-shell"><section className="state-panel" role="status">Memuat alur agen…</section></main>}>
            <PipelineFlow />
          </Suspense>
        )
        : <AccountAccessGate shell="review" sessionState={sessionState} isNarrowScreen={narrowScreen} onRefreshSession={refreshAccountSession} />)}
      {route.screen === "embedding-3d" && (
        <Suspense fallback={<main id="main-content" className="main-shell"><section className="state-panel" role="status">Memuat Visualisasi 3D…</section></main>}>
          <Embedding3DVisualization />
        </Suspense>
      )}
      {route.screen === "source-preview" && (sessionState.status === "authenticated" && hasProtectedShellAccess("admin", sessionState.session)
        ? (
          <UnifiedSourceExplorer
            datasetMode={context?.dataset_mode ?? null}
            renderMap={(points, selectedId, onSelect, onReturnToList) => (
              <SourcePointMap points={points} selectedId={selectedId} onSelect={onSelect} onReturnToList={onReturnToList} viewMode="unified" />
            )}
          />
        )
        : <AccountAccessGate shell="admin" sessionState={sessionState} isNarrowScreen={narrowScreen} onRefreshSession={refreshAccountSession} />)}
      <SiteFooter />
      <OnboardingIntro autoOpen={introAutoOpenFor(route.screen)} />
    </div>
  );
}
