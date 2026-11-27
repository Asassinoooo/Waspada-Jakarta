import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import test from "node:test";
import { createElement, Suspense, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { prerenderToNodeStream } from "react-dom/static";
import * as lazyRoutes from "../src/lazy-routes.js";
import {
  LazyAccountAccessGate,
  LazyAccountPage,
  LazyHelpPage,
  LazyPasswordResetPage,
  LazyPreferences,
  LazyUpdatesCenter,
  prefetchRouteChunk,
  prefetchRouteOnIntent,
  RouteFallback,
  routeChunkForHref,
  type RouteChunk,
} from "../src/lazy-routes.js";
import { EventDetail } from "../src/EventDetail.js";
import type { PreferencesStorage } from "../src/preferences-store.js";
import type { PublicContext } from "@waspada/worker/public-contracts";

/**
 * PERF-09 / PERF-09b: public routes that are not on the first screen load on demand, and the map home stays in the first
 * chunk. PERF-09b replaces the idle warm-up with a prefetch on link intent (pointer over, focus, touch start).
 */

class MemoryStorage implements PreferencesStorage {
  readonly values = new Map<string, string>();
  getItem(key: string) {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
  removeItem(key: string) {
    this.values.delete(key);
  }
}

/** Waits until every Suspense boundary in the tree has resolved, then returns the markup. */
async function renderWhenReady(element: ReactElement): Promise<string> {
  const { prelude } = await prerenderToNodeStream(element);
  let html = "";
  for await (const chunk of prelude) html += String(chunk);
  return html;
}

function suspended(route: ReactElement): ReactElement {
  return createElement(Suspense, { fallback: createElement(RouteFallback) }, route);
}

test("the route fallback is a labelled status region that keeps the page focus target", () => {
  const html = renderToStaticMarkup(createElement(RouteFallback));
  assert.match(html, /role="status"/);
  assert.match(html, /Memuat halaman…/);
  assert.match(html, /<main id="main-content" tabindex="-1"/);
});

test("the preferences route shows the fallback until its module loads, then the page", async () => {
  const storage = new MemoryStorage();
  const element = suspended(createElement(LazyPreferences, { context: null, contextSnapshotId: "snapshot-1", storage }));
  const pending = renderToStaticMarkup(element);
  assert.match(pending, /role="status"/);
  assert.match(pending, /Memuat halaman…/);
  assert.doesNotMatch(pending, /Ringkasan saya/);

  const ready = await renderWhenReady(element);
  assert.match(ready, /Ringkasan saya/);
  assert.doesNotMatch(ready, /Memuat halaman…/);
});

test("the updates route shows the fallback until its module loads, then the page", async () => {
  const storage = new MemoryStorage();
  const element = suspended(createElement(LazyUpdatesCenter, { context: null, storage, refreshCurrentEvents: async () => {} }));
  const pending = renderToStaticMarkup(element);
  assert.match(pending, /role="status"/);
  assert.doesNotMatch(pending, /Pembaruan/);

  const ready = await renderWhenReady(element);
  assert.match(ready, /Pembaruan/);
  assert.doesNotMatch(ready, /Memuat halaman…/);
});

test("the help route shows the fallback until its module loads, then the guide and privacy page", async () => {
  const storage = new MemoryStorage();
  const element = suspended(createElement(LazyHelpPage, { showLocalPipeline: false, storage, onCleared: () => {} }));
  const pending = renderToStaticMarkup(element);
  assert.match(pending, /role="status"/);
  assert.doesNotMatch(pending, /Panduan dan privasi/);

  const ready = await renderWhenReady(element);
  assert.match(ready, /Panduan dan privasi/);
  assert.doesNotMatch(ready, /Memuat halaman…/);
});

test("the account route shows the fallback until its module loads, then the account frame", async () => {
  const element = suspended(createElement(LazyAccountPage, {
    screen: "account",
    sessionState: { status: "loading", session: null },
    isNarrowScreen: false,
    onRefreshSession: () => {},
  }));
  const pending = renderToStaticMarkup(element);
  assert.match(pending, /role="status"/);

  const ready = await renderWhenReady(element);
  assert.match(ready, /Akun Anda/);
  assert.doesNotMatch(ready, /Memuat halaman…/);
});

test("the password reset route shows the fallback until its module loads, then the reset page", async () => {
  const element = suspended(createElement(LazyPasswordResetPage, {}));
  const pending = renderToStaticMarkup(element);
  assert.match(pending, /role="status"/);
  assert.doesNotMatch(pending, /Atur ulang kata sandi/);

  const ready = await renderWhenReady(element);
  assert.match(ready, /Atur ulang kata sandi/);
  assert.doesNotMatch(ready, /Memuat halaman…/);
});

test("the admin access gate loads lazily and shows its own loading status", async () => {
  const element = suspended(createElement(LazyAccountAccessGate, {
    shell: "admin",
    sessionState: { status: "loading", session: null },
    isNarrowScreen: false,
    onRefreshSession: () => {},
  }));
  const ready = await renderWhenReady(element);
  assert.match(ready, /Memeriksa izin sesi…/);
  assert.match(ready, /role="status"/);
});

test("no route chunk is fetched at idle: the warm-up is gone and the app does not call it", () => {
  assert.equal("scheduleRouteChunkWarmup" in lazyRoutes, false);
  const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(app, /scheduleRouteChunkWarmup|requestIdleCallback/);
});

test("a hash link maps to the one route chunk it opens; the map and other links map to none", () => {
  const expected: Array<[string, RouteChunk]> = [
    ["#ringkasan-saya", "preferences"],
    ["#pembaruan", "updates"],
    ["#bantuan", "help"],
    ["#privasi", "help"],
    ["#panduan", "help"],
    ["#akun", "account"],
    ["#masuk", "account"],
    ["#masuk?return_to=%23akun", "account"],
    ["#lupa-sandi", "account"],
    ["#mulai", "account"],
    ["#unduh", "download"],
    ["#admin/tinjau", "admin"],
  ];
  for (const [href, chunk] of expected) assert.equal(routeChunkForHref(href), chunk, href);
  for (const href of ["#peta", "#detail/api/evt-1", "#detail/presentation", "https://example.com/#akun", ""]) {
    assert.equal(routeChunkForHref(href), null, href);
  }
});

test("prefetch on intent loads the link's chunk once, and a failed load is harmless", async () => {
  const loaded: RouteChunk[] = [];
  const load = (chunk: RouteChunk) => {
    loaded.push(chunk);
    return Promise.resolve({});
  };
  prefetchRouteChunk("#pembaruan", load);
  prefetchRouteChunk("#peta", load);
  assert.deepEqual(loaded, ["updates"]);

  // A rejected load and a synchronous throw are both swallowed. An unhandled rejection would fail this test run.
  assert.doesNotThrow(() => prefetchRouteChunk("#bantuan", () => Promise.reject(new Error("offline"))));
  assert.doesNotThrow(() => prefetchRouteChunk("#bantuan", () => {
    throw new Error("synchronous failure");
  }));
  await new Promise((resolve) => setTimeout(resolve, 0));
});

test("the header and footer intent handler prefetches the link under the pointer or focus only", () => {
  const loaded: RouteChunk[] = [];
  const load = (chunk: RouteChunk) => {
    loaded.push(chunk);
    return Promise.resolve({});
  };
  const onLink = (href: string) => ({ target: { closest: () => ({ getAttribute: () => href }) } as unknown as EventTarget });
  prefetchRouteOnIntent(onLink("#ringkasan-saya"), load);
  prefetchRouteOnIntent({ target: { closest: () => null } as unknown as EventTarget }, load);
  prefetchRouteOnIntent({ target: null }, load);
  assert.deepEqual(loaded, ["preferences"]);

  const shell = readFileSync(new URL("../src/AppShell.tsx", import.meta.url), "utf8");
  assert.match(shell, /<header className=\{`site-header\$\{brandCollapsed \? " site-header--collapsed" : ""\}`\} onPointerOver=\{prefetchRouteOnIntent\} onFocus=\{prefetchRouteOnIntent\} onTouchStart=\{prefetchRouteOnIntent\}>/);
  assert.match(shell, /<footer className="site-footer" onPointerOver=\{prefetchRouteOnIntent\} onFocus=\{prefetchRouteOnIntent\} onTouchStart=\{prefetchRouteOnIntent\}>/);
});

test("the demo presentation detail shows a status while its module loads, then the fixture", async () => {
  const demoContext: PublicContext = { dataset_mode: "demo", dataset_label: "synthetic", generated_at: "2026-09-24T10:00:00.000Z", sources: [] };
  const pending = renderToStaticMarkup(createElement(EventDetail, { mode: "presentation", context: demoContext }));
  assert.match(pending, /role="status"/);
  assert.doesNotMatch(pending, /Contoh detail terpisah dari API/);

  const ready = await renderWhenReady(createElement(EventDetail, { mode: "presentation", context: demoContext }));
  assert.match(ready, /Contoh detail terpisah dari API/);
  assert.doesNotMatch(ready, /Memuat contoh detail/);
});

/**
 * Guards the split itself: walks the static (non-type, non-dynamic) imports from the first-screen entry and checks that
 * no lazily loaded route module is reachable. A dynamic import() is not followed, so it does not count.
 */
test("the first-screen import graph does not reach the lazily loaded route modules", () => {
  const srcUrl = new URL("../src/", import.meta.url);
  const resolveSource = (fromFile: string, specifier: string): string | null => {
    if (!specifier.startsWith(".")) return null;
    const base = new URL(specifier, new URL(fromFile, srcUrl)).pathname;
    const candidates = [base.replace(/\.js$/, ".ts"), base.replace(/\.js$/, ".tsx"), base.replace(/\.js$/, ".js"), base];
    return candidates.find((candidate) => existsSync(candidate) && candidate.startsWith(srcUrl.pathname)) ?? null;
  };
  const staticSpecifiers = (text: string): string[] => {
    const code = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
    const specifiers: string[] = [];
    for (const match of code.matchAll(/(?:^|\n)\s*(import|export)\s+(type\s+)?([^;"']*?)?(?:from\s*)?["']([^"']+)["']/g)) {
      if (match[2] !== undefined) continue;
      if (match[1] === "export" && match[3] === undefined) continue;
      specifiers.push(match[4]!);
    }
    return specifiers;
  };

  const visited = new Set<string>();
  const queue = [new URL("App.tsx", srcUrl).pathname];
  while (queue.length > 0) {
    const file = queue.shift()!;
    if (visited.has(file)) continue;
    visited.add(file);
    for (const specifier of staticSpecifiers(readFileSync(file, "utf8"))) {
      const next = resolveSource(file, specifier);
      if (next !== null) queue.push(next);
    }
  }

  const names = [...visited].map((file) => file.slice(srcUrl.pathname.length));
  const lazyRouteModules = [
    "Preferences.tsx",
    "PresentationDetail.tsx",
    "GeoMapPanel.tsx",
    "account-client.ts",
    "EventFeed.tsx",
    "UpdatesCenter.tsx",
    "HelpPage.tsx",
    "PrivacyPage.tsx",
    "ReadGuide.tsx",
    "BriefingResults.tsx",
    "NotificationSettings.tsx",
    "AccountPages.tsx",
    "account-gate.tsx",
    "interest-notifications.ts",
    "update-matching.ts",
    "SourcePointMap.tsx",
    "emergency-facilities.ts",
    "admin-entry.ts",
    "AdminWorkspace.tsx",
  ];
  for (const module of lazyRouteModules) {
    assert.equal(names.includes(module), false, `${module} must load lazily, not from the first screen`);
  }
  assert.equal(names.includes("MapHome.tsx"), true, "the map home stays on the first screen");
  assert.equal(names.includes("EventDetail.tsx"), true, "the event detail panel stays on the first screen");
});
