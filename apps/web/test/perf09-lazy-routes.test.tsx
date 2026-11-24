import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import test from "node:test";
import { createElement, Suspense, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { prerenderToNodeStream } from "react-dom/static";
import {
  LazyAccountAccessGate,
  LazyAccountPage,
  LazyHelpPage,
  LazyPasswordResetPage,
  LazyPreferences,
  LazyUpdatesCenter,
  RouteFallback,
  scheduleRouteChunkWarmup,
} from "../src/lazy-routes.js";
import type { PreferencesStorage } from "../src/preferences-store.js";

/** PERF-09: public routes that are not on the first screen load on demand, and the map home stays in the first chunk. */

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

test("route chunk warm-up is a cancellable no-op without a browser window", () => {
  const cancel = scheduleRouteChunkWarmup();
  assert.equal(typeof cancel, "function");
  assert.doesNotThrow(() => cancel());
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
