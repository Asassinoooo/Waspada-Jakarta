import { useEffect, useState } from "react";
import type { EventView, PublicContext } from "@waspada/worker/public-contracts";
import { getPublicContext, listEvents } from "./api-client.js";
import { EventDetail } from "./EventDetail.js";
import { EventFeed, type FeedStatus, type MobileDiscoveryPanel } from "./EventFeed.js";
import { ModeratorReview } from "./ModeratorReview.js";
import type { MapSelection } from "./MapPanel.js";

type Route =
  | { screen: "discover" }
  | { screen: "review" }
  | { screen: "detail-presentation" }
  | { screen: "detail-api"; eventId: string };

function routeFromHash(hash: string): Route {
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
  const [query, setQuery] = useState(() => new URLSearchParams(window.location.search).get("q") ?? "");
  const [mobilePanel, setMobilePanel] = useState<MobileDiscoveryPanel>(() =>
    new URLSearchParams(window.location.search).get("panel") === "map" ? "map" : "list",
  );
  const [mapSelection, setMapSelection] = useState<MapSelection>({ kind: "none" });

  useEffect(() => {
    const updateRoute = () => setRoute(routeFromHash(window.location.hash));
    if (!window.location.hash) window.history.replaceState(null, "", "#jelajah");
    window.addEventListener("hashchange", updateRoute);
    return () => window.removeEventListener("hashchange", updateRoute);
  }, []);

  useEffect(() => {
    const url = new URL(window.location.href);
    if (query) url.searchParams.set("q", query);
    else url.searchParams.delete("q");
    if (mobilePanel === "map") url.searchParams.set("panel", "map");
    else url.searchParams.delete("panel");
    window.history.replaceState(window.history.state, "", url.pathname + url.search + url.hash);
  }, [query, mobilePanel]);

  useEffect(() => {
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
  }, [retryKey]);

  const selectedApiEvent = route.screen === "detail-api"
    ? events.find((event) => event.event_id === route.eventId)
    : undefined;

  return (
    <div className="app-shell">
      <SiteHeader route={route} />
      {route.screen === "discover" && (
        <EventFeed
          status={status}
          events={events}
          context={context}
          query={query}
          onQueryChange={setQuery}
          onRetry={() => setRetryKey((current) => current + 1)}
          mapSelection={mapSelection}
          onSelectApiEvent={(event) => setMapSelection({ kind: "api-event", event })}
          onSelectPresentation={() => {
            setMapSelection({ kind: "presentation" });
            setMobilePanel("map");
          }}
          mobilePanel={mobilePanel}
          onMobilePanelChange={setMobilePanel}
        />
      )}
      {(route.screen === "detail-api" || route.screen === "detail-presentation") && (
        <EventDetail
          mode={route.screen === "detail-presentation" ? "presentation" : "api-event"}
          event={selectedApiEvent}
          context={context}
        />
      )}
      {route.screen === "review" && <ModeratorReview />}
      <footer className="site-footer">
        <span>Demo lokal · semua record dan segmen contoh bersifat sintetis.</span>
        <a href="#jelajah">Kembali ke jelajah</a>
      </footer>
    </div>
  );
}
