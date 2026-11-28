// PERF-09: public routes that are not on the first screen (the map home) load on demand. The loaders are module-level so
// a prefetch on intent fetches the same chunk that the route later renders.
import { lazy } from "react";
import { adminWorkspaceTabFromHash } from "./admin-workspace-model.js";

const loadPreferences = () => import("./Preferences.js");
const loadUpdatesCenter = () => import("./UpdatesCenter.js");
const loadHelpPage = () => import("./HelpPage.js");
const loadAccountPages = () => import("./AccountPages.js");
const loadAccountGate = () => import("./account-gate.js");
const loadDownloadPage = () => import("./DownloadPage.js");
const loadPresentationDetail = () => import("./PresentationDetail.js");
const loadAdminEntry = () => import("./admin-entry.js");
const loadAdminOverview = () => import("./AdminOverview.js");

export const LazyPreferences = lazy(() => loadPreferences().then((module) => ({ default: module.Preferences })));
export const LazyUpdatesCenter = lazy(() => loadUpdatesCenter().then((module) => ({ default: module.UpdatesCenter })));
export const LazyHelpPage = lazy(() => loadHelpPage().then((module) => ({ default: module.HelpPage })));
export const LazyAccountPage = lazy(() => loadAccountPages().then((module) => ({ default: module.AccountPage })));
export const LazyPasswordResetPage = lazy(() => loadAccountPages().then((module) => ({ default: module.PasswordResetPage })));
/** MOBILE-REL-01: `#unduh`. */
export const LazyDownloadPage = lazy(() => loadDownloadPage().then((module) => ({ default: module.DownloadPage })));
/** The gate for protected routes (admin workspace). Only signed-in staff reach it. */
export const LazyAccountAccessGate = lazy(() => loadAccountGate().then((module) => ({ default: module.AccountAccessGate })));
/** PERF-09b: the demo presentation (its fixture and map) is only reached from `#detail/presentation`. */
export const LazyPresentationDetail = lazy(() => loadPresentationDetail().then((module) => ({ default: module.PresentationDetail })));

/** Shown while a lazy route loads. The header and footer stay mounted outside it, so the page frame does not jump. */
export function RouteFallback() {
  return (
    <main id="main-content" tabIndex={-1} className="main-shell">
      <section className="state-panel" role="status" aria-live="polite">
        <strong>Memuat halaman…</strong>
      </section>
    </main>
  );
}

/** The route chunks that a hash link can open. The map home is not listed: it is in the first chunk. */
export type RouteChunk = "preferences" | "updates" | "help" | "account" | "download" | "admin";
export type RouteChunkLoad = (chunk: RouteChunk) => Promise<unknown>;

const routeChunkLoaders: Readonly<Record<RouteChunk, () => Promise<unknown>>> = {
  preferences: loadPreferences,
  updates: loadUpdatesCenter,
  help: loadHelpPage,
  account: loadAccountPages,
  download: loadDownloadPage,
  admin: loadAdminEntry,
};

/**
 * Opening an admin hash: the gate checks the session first and only then renders the workspace, which only then asks for
 * its default tab. Starting both chunks with the session check saves two round trips. They are static code with no data;
 * the server still checks every request.
 */
export function preloadAdminRoute(hash: string): void {
  const tab = adminWorkspaceTabFromHash(hash);
  if (tab === null) return;
  loadAdminEntry().catch(() => {});
  if (tab === "ringkasan") loadAdminOverview().catch(() => {});
}

/** The route chunk that a hash link opens, or null for the map home and for anything that is not a route of this app. */
export function routeChunkForHref(href: string): RouteChunk | null {
  const queryStart = href.indexOf("?");
  const path = queryStart === -1 ? href : href.slice(0, queryStart);
  switch (path) {
    case "#ringkasan-saya":
      return "preferences";
    case "#pembaruan":
      return "updates";
    case "#bantuan":
    case "#panduan":
    case "#privasi":
      return "help";
    case "#akun":
    case "#masuk":
    case "#mulai":
    case "#lupa-sandi":
      return "account";
    case "#unduh":
      return "download";
  }
  return adminWorkspaceTabFromHash(href) === null ? null : "admin";
}

/**
 * PERF-09b: starts loading the chunk behind a hash link, when the person points at or focuses the link. Nothing loads at
 * idle, so a visitor who never reaches for those links never downloads them. A failed prefetch is harmless: the route
 * imports its own chunk when it opens.
 */
export function prefetchRouteChunk(href: string, load: RouteChunkLoad = (chunk) => routeChunkLoaders[chunk]()): void {
  const chunk = routeChunkForHref(href);
  if (chunk === null) return;
  try {
    load(chunk).catch(() => {});
  } catch {
    // Same as a rejected load: the route retries its own import.
  }
}

/** Event handler for the header and footer (pointer over, focus and touch start). It prefetches the link under the event. */
export function prefetchRouteOnIntent(event: { target: EventTarget | null }, load?: RouteChunkLoad): void {
  const link = (event.target as Element | null)?.closest?.("a[href]");
  const href = link?.getAttribute("href");
  if (typeof href === "string") prefetchRouteChunk(href, load);
}
