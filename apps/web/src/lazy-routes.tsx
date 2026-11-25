// PERF-09: public routes that are not on the first screen (the map home) load on demand. The loaders are module-level so
// the idle warm-up fetches the same chunk that the route later renders.
import { lazy } from "react";

const loadPreferences = () => import("./Preferences.js");
const loadUpdatesCenter = () => import("./UpdatesCenter.js");
const loadHelpPage = () => import("./HelpPage.js");
const loadAccountPages = () => import("./AccountPages.js");
const loadAccountGate = () => import("./account-gate.js");
const loadDownloadPage = () => import("./DownloadPage.js");

export const LazyPreferences = lazy(() => loadPreferences().then((module) => ({ default: module.Preferences })));
export const LazyUpdatesCenter = lazy(() => loadUpdatesCenter().then((module) => ({ default: module.UpdatesCenter })));
export const LazyHelpPage = lazy(() => loadHelpPage().then((module) => ({ default: module.HelpPage })));
export const LazyAccountPage = lazy(() => loadAccountPages().then((module) => ({ default: module.AccountPage })));
export const LazyPasswordResetPage = lazy(() => loadAccountPages().then((module) => ({ default: module.PasswordResetPage })));
/** MOBILE-REL-01: `#unduh`. Not warmed: few visitors open it. */
export const LazyDownloadPage = lazy(() => loadDownloadPage().then((module) => ({ default: module.DownloadPage })));
/** The gate for protected routes (admin workspace). Not warmed: only signed-in staff reach it. */
export const LazyAccountAccessGate = lazy(() => loadAccountGate().then((module) => ({ default: module.AccountAccessGate })));

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

const routeChunkLoaders: readonly (() => Promise<unknown>)[] = [loadPreferences, loadUpdatesCenter, loadHelpPage, loadAccountPages];
const WARM_UP_DELAY_MS = 2000;

/**
 * After the first render, fetches the public route chunks while the browser is idle, so the first visit to one of
 * those routes does not wait for its download. Returns a cancel function for effect cleanup. Does nothing without a window.
 */
export function scheduleRouteChunkWarmup(): () => void {
  if (typeof window === "undefined") return () => {};
  const warm = () => {
    for (const load of routeChunkLoaders) {
      load().catch(() => {
        // A failed warm-up is harmless: the route retries its own import when it is opened.
      });
    }
  };
  if (typeof window.requestIdleCallback === "function") {
    const handle = window.requestIdleCallback(warm, { timeout: WARM_UP_DELAY_MS });
    return () => window.cancelIdleCallback(handle);
  }
  const handle = window.setTimeout(warm, WARM_UP_DELAY_MS);
  return () => window.clearTimeout(handle);
}
