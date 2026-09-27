import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ApiHttpError, type PublicUpdatePage } from "../src/api-client.js";
import {
  createUpdateCenterPoller,
  hydrateAndMatchUpdates,
  matchPublicUpdate,
  resolvePreferencesGate,
  UPDATE_CURSOR_STORAGE_KEY,
  UPDATE_DETAIL_CONCURRENCY,
  UPDATE_MAX_PAGES_PER_CYCLE,
  UPDATE_PAGE_SIZE,
  UPDATE_POLL_INTERVAL_MS,
  UpdateCenterContent,
  UpdatesCenter,
  validateCurrentUpdateEvent,
  type MatchedPublicUpdate,
  type UpdateCenterScheduler,
  type UpdateCenterState,
} from "../src/UpdatesCenter.js";
import {
  emptyInterests,
  PREFERENCES_SCHEMA_VERSION,
  PREFERENCES_STORAGE_KEY,
  type BriefingInterests,
  type PreferencesStorage,
} from "../src/preferences-store.js";
import type { HistoryEntry, PublicContext, PublicScope, TimeScope } from "@waspada/worker/public-contracts";

const liveContext: PublicContext = {
  dataset_mode: "live",
  dataset_label: "live",
  generated_at: "2026-09-25T04:06:00.000Z",
  sources: [],
};

const demoContext: PublicContext = { ...liveContext, dataset_mode: "demo", dataset_label: "synthetic" };
const checkedAt = "2026-09-25T04:06:00.000Z";
const changedAt = "2026-09-25T04:05:00.000Z";
const eventTime: TimeScope = { start: "2026-09-25", end: null, precision: "date" };
const emptyScope: PublicScope = { places: [], services: [], institutions: [], audiences: [] };

function scope(overrides: Partial<PublicScope> = {}): PublicScope {
  return { ...emptyScope, ...overrides };
}

function interests(overrides: Partial<BriefingInterests> = {}): BriefingInterests {
  return { ...emptyInterests(), ...overrides };
}

function detail(eventId: string, overrides: Record<string, unknown> = {}) {
  return {
    event_id: eventId,
    version: 3,
    title: "Perubahan fiktif di Pondok Labu",
    category: "disasters_weather",
    lifecycle: "ongoing",
    freshness: {
      status: "current",
      evaluated_at: changedAt,
      review_due_at: null,
      basis: "manual_review",
    },
    event_time: eventTime,
    published_at: checkedAt,
    scope: scope(),
    claims: [{ scope: scope({ places: ["Évakuasi Selatan"] }) }],
    impacts: [{ scope: scope({ services: ["Transjakarta 12"] }) }],
    ...overrides,
  };
}

function change(eventId: string, version = 2, summary = "Synthetic reviewed change."): HistoryEntry {
  return {
    event_id: eventId,
    version,
    change_type: "corrected",
    changed_at: changedAt,
    summary,
  };
}

function page(items: HistoryEntry[], cursor: string): PublicUpdatePage {
  return { items, next_cursor: cursor, cursor_expires_at: "2026-10-25T04:06:00.000Z", checked_at: checkedAt };
}

class MemoryStorage implements PreferencesStorage {
  readonly values = new Map<string, string>();
  readonly writes: Array<{ key: string; value: string }> = [];
  readonly removals: string[] = [];
  readFailure = false;
  writeFailure = false;
  removeFailure = false;

  getItem(key: string) {
    if (this.readFailure) throw new Error("synthetic storage read failure");
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string) {
    if (this.writeFailure) throw new Error("synthetic storage write failure");
    this.writes.push({ key, value });
    this.values.set(key, value);
  }

  removeItem(key: string) {
    if (this.removeFailure) throw new Error("synthetic storage remove failure");
    this.removals.push(key);
    this.values.delete(key);
  }
}

class FakeScheduler implements UpdateCenterScheduler {
  private nextId = 0;
  readonly jobs = new Map<number, { callback: () => void; delayMs: number }>();

  setTimeout(callback: () => void, delayMs: number) {
    const id = ++this.nextId;
    this.jobs.set(id, { callback, delayMs });
    return id;
  }

  clearTimeout(handle: unknown) {
    if (typeof handle === "number") this.jobs.delete(handle);
  }

  fireNext() {
    const first = this.jobs.entries().next().value as [number, { callback: () => void; delayMs: number }] | undefined;
    if (!first) return null;
    this.jobs.delete(first[0]);
    first[1].callback();
    return first[1].delayMs;
  }
}

function captureStates() {
  const states: UpdateCenterState[] = [];
  return { states, onState: (state: UpdateCenterState) => states.push(state) };
}

function matchedEvent(eventId: string, matchedByScope = true): MatchedPublicUpdate {
  const current = validateCurrentUpdateEvent(detail(eventId), eventId, 2);
  return {
    change: change(eventId),
    event: current,
    relevance: { category: true, scope: matchedByScope },
  };
}

test("only exact-live mode with readable normalized interests is eligible", () => {
  const stored = interests({ places: [" Pondok Labu "] });
  const loadResult = {
    status: "loaded" as const,
    interests: stored,
  };
  assert.equal(resolvePreferencesGate(null, loadResult), "unknown");
  assert.equal(resolvePreferencesGate(demoContext, loadResult), "demo");
  assert.equal(resolvePreferencesGate(liveContext, { status: "empty", interests: emptyInterests() }), "empty");
  assert.equal(resolvePreferencesGate(liveContext, { status: "malformed", issue: "invalid-json" }), "malformed");
  assert.equal(resolvePreferencesGate(liveContext, { status: "unavailable", operation: "read" }), "unavailable");
  assert.equal(resolvePreferencesGate(liveContext, loadResult), "live");
});

test("gate and status copy is accessible and does not imply coverage or safety", () => {
  const state: UpdateCenterState = {
    status: "ready",
    phase: "updates",
    items: [],
    checkedAt,
    resetNotice: false,
    failure: null,
  };
  const empty = renderToStaticMarkup(<UpdateCenterContent gate="empty" state={state} onRefresh={() => {}} />);
  const demo = renderToStaticMarkup(<UpdateCenterContent gate="demo" state={state} onRefresh={() => {}} />);
  const unknown = renderToStaticMarkup(<UpdateCenterContent gate="unknown" state={state} onRefresh={() => {}} />);
  const ready = renderToStaticMarkup(<UpdateCenterContent gate="live" state={state} onRefresh={() => {}} />);
  assert.match(empty, /Atur minat di perangkat ini/);
  assert.match(demo, /Data demo dan fixture tidak digunakan/);
  assert.match(unknown, /Status dataset belum dapat diverifikasi/);
  assert.match(ready, /Belum ada pembaruan yang cocok/);
  assert.match(ready, /bukan pernyataan bahwa area aman/);
  assert.match(ready, /Mode live tidak memastikan sumber tertentu tersambung/);
  assert.match(ready, /aria-live="polite"/);
});

test("component reads only the versioned local preference store and sends no interests during rendering", (t) => {
  const storage = new MemoryStorage();
  const localInterests = interests({ places: ["Pondok Labu"] });
  storage.values.set(PREFERENCES_STORAGE_KEY, JSON.stringify({ version: PREFERENCES_SCHEMA_VERSION, interests: localInterests }));
  const originalFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = (async () => {
    requests += 1;
    throw new Error("unexpected network request");
  }) as typeof fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  const markup = renderToStaticMarkup(<UpdatesCenter context={liveContext} storage={storage} refreshCurrentEvents={async () => {}} />);
  assert.match(markup, /Permintaan pembaruan tidak mengirim pilihan minat/);
  assert.match(markup, /Menetapkan titik awal pembaruan/);
  assert.doesNotMatch(markup, /Pondok Labu/);
  assert.equal(requests, 0);
});

test("current detail validation accepts date-only time and rejects malformed identity, fields, and scope", () => {
  const parsed = validateCurrentUpdateEvent(detail("synthetic-event"), "synthetic-event", 2);
  assert.equal(parsed.event_time.precision, "date");
  assert.equal(parsed.title, "Perubahan fiktif di Pondok Labu");
  const mixedRange = validateCurrentUpdateEvent(detail("synthetic-range", {
    event_time: { start: "2026-09-25", end: "2026-09-26T03:00:00.000Z", precision: "range" },
  }), "synthetic-range", 2);
  assert.equal(mixedRange.event_time.precision, "range");
  assert.throws(() => validateCurrentUpdateEvent(detail("wrong-event"), "synthetic-event", 2));
  assert.throws(() => validateCurrentUpdateEvent(detail("synthetic-event", { version: 1 }), "synthetic-event", 2));
  assert.throws(() => validateCurrentUpdateEvent(detail("synthetic-event", { category: "unsafe" }), "synthetic-event", 2));
  assert.throws(() => validateCurrentUpdateEvent(detail("synthetic-event", { event_time: { start: "2026-09-25T00:00:00Z", end: null, precision: "date" } }), "synthetic-event", 2));
  assert.throws(() => validateCurrentUpdateEvent(detail("synthetic-event", { scope: { places: ["Pondok"], services: [], institutions: [] } }), "synthetic-event", 2));
});

test("matching uses normalized exact scope names from event, claim, and impact only", () => {
  const current = validateCurrentUpdateEvent(detail("fictional-match", {
    title: "A different title must not match",
    scope: scope({ places: ["   "] }),
    claims: [{ scope: scope({ places: ["E\u0301vakuasi Selatan"] }) }],
    impacts: [{ scope: scope({ services: ["Transjakarta 12"] }) }],
  }), "fictional-match", 2);
  const exact = matchPublicUpdate(current, interests({ places: ["Évakuasi Selatan"] }));
  assert.deepEqual(exact, { category: false, scope: true });
  assert.deepEqual(matchPublicUpdate(current, interests({ services: ["transjakarta 12"] })), { category: false, scope: true });
  assert.deepEqual(matchPublicUpdate(current, interests({ places: ["Évakuasi"] })), { category: false, scope: false });
  assert.deepEqual(matchPublicUpdate(current, interests({ categories: ["disasters_weather"] })), { category: true, scope: false });
});

test("detail hydration fetches unique event IDs with at most four concurrent requests", async () => {
  let active = 0;
  let maximumActive = 0;
  let requestCount = 0;
  const changes = Array.from({ length: 12 }, (_, index) => change("synthetic-event-" + index));
  const controller = new AbortController();
  const hydrated = await hydrateAndMatchUpdates(changes, interests({ categories: ["disasters_weather"] }), async (eventId) => {
    requestCount += 1;
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    await new Promise((resolve) => setTimeout(resolve, 2));
    active -= 1;
    return detail(eventId);
  }, controller.signal);

  assert.equal(requestCount, 12);
  assert.equal(maximumActive, UPDATE_DETAIL_CONCURRENCY);
  assert.equal(hydrated.length, 12);
});

test("aborted or hidden pages do not persist cursors, expose stale entries, or schedule polling", async (t) => {
  const storage = new MemoryStorage();
  const scheduler = new FakeScheduler();
  const captured = captureStates();
  let resolvePage: ((value: PublicUpdatePage) => void) | undefined;
  let requests = 0;
  const poller = createUpdateCenterPoller({
    interests: interests({ categories: ["disasters_weather"] }),
    storage,
    scheduler,
    onState: captured.onState,
    refreshCurrentEvents: async () => {},
    getUpdates: async () => {
      requests += 1;
      return new Promise((resolve) => { resolvePage = resolve; });
    },
  });
  t.after(() => poller.stop());

  poller.start(false);
  assert.equal(requests, 0);
  assert.equal(scheduler.jobs.size, 0);
  poller.setVisible(true);
  const pending = poller.refresh();
  assert.equal(requests, 1);
  poller.setVisible(false);
  resolvePage?.(page([], "stale-cursor"));
  await pending;

  assert.equal(storage.values.has(UPDATE_CURSOR_STORAGE_KEY), false);
  assert.equal(scheduler.jobs.size, 0);
  assert.equal(captured.states.some((state) => state.status === "ready"), false);
});

test("successful bootstrap stores only its cursor and schedules at least sixty seconds later", async (t) => {
  const storage = new MemoryStorage();
  const scheduler = new FakeScheduler();
  const captured = captureStates();
  const requests: Array<string | undefined> = [];
  const poller = createUpdateCenterPoller({
    interests: interests({ places: ["Pondok Labu"] }),
    storage,
    scheduler,
    onState: captured.onState,
    refreshCurrentEvents: async () => {},
    getUpdates: async (cursor) => {
      requests.push(cursor);
      return cursor === undefined ? page([], "baseline-cursor") : page([], "continued-cursor");
    },
  });
  t.after(() => poller.stop());

  poller.start(true);
  await poller.refresh();
  assert.deepEqual(requests, [undefined, "baseline-cursor"]);
  assert.deepEqual([...storage.values.keys()], [UPDATE_CURSOR_STORAGE_KEY]);
  assert.equal(storage.values.get(UPDATE_CURSOR_STORAGE_KEY), "continued-cursor");
  assert.deepEqual(storage.writes.map((write) => write.key), [UPDATE_CURSOR_STORAGE_KEY, UPDATE_CURSOR_STORAGE_KEY]);
  assert.equal([...scheduler.jobs.values()][0]?.delayMs, UPDATE_POLL_INTERVAL_MS);
});

test("a transient or malformed detail keeps the whole page and cursor uncommitted", async (t) => {
  const storage = new MemoryStorage();
  storage.values.set(UPDATE_CURSOR_STORAGE_KEY, "cursor-before-page");
  const scheduler = new FakeScheduler();
  const captured = captureStates();
  const poller = createUpdateCenterPoller({
    interests: interests({ categories: ["disasters_weather"] }),
    storage,
    scheduler,
    onState: captured.onState,
    refreshCurrentEvents: async () => {},
    getUpdates: async () => page([change("fictional-good"), change("fictional-failure")], "cursor-after-page"),
    getDetail: async (eventId) => {
      if (eventId === "fictional-failure") throw new Error("synthetic network failure");
      return detail(eventId);
    },
  });
  t.after(() => poller.stop());

  poller.start(true);
  await poller.refresh();
  const latest = captured.states[captured.states.length - 1];
  assert.equal(latest?.status, "retry");
  assert.equal(latest?.failure, "details");
  assert.equal(latest?.items.length, 0);
  assert.equal(storage.values.get(UPDATE_CURSOR_STORAGE_KEY), "cursor-before-page");
  assert.equal(storage.writes.length, 0);
});

test("confirmed current-detail 404 is omitted and a fully processed page advances its cursor", async (t) => {
  const storage = new MemoryStorage();
  storage.values.set(UPDATE_CURSOR_STORAGE_KEY, "cursor-before-page");
  const scheduler = new FakeScheduler();
  const captured = captureStates();
  const poller = createUpdateCenterPoller({
    interests: interests({ places: ["Pondok Labu"] }),
    storage,
    scheduler,
    onState: captured.onState,
    refreshCurrentEvents: async () => {},
    getUpdates: async () => page([change("no-longer-public")], "cursor-after-page"),
    getDetail: async () => { throw new ApiHttpError(404); },
  });
  t.after(() => poller.stop());

  poller.start(true);
  await poller.refresh();
  const latest = captured.states[captured.states.length - 1];
  assert.equal(latest?.status, "ready");
  assert.deepEqual(latest?.items, []);
  assert.equal(storage.values.get(UPDATE_CURSOR_STORAGE_KEY), "cursor-after-page");
});

test("cursor restart clears displayed history, baselines before snapshot refresh, then resumes polling", async (t) => {
  const storage = new MemoryStorage();
  storage.values.set(UPDATE_CURSOR_STORAGE_KEY, "cursor-old");
  const scheduler = new FakeScheduler();
  const captured = captureStates();
  const calls: string[] = [];
  let recoveryStarted = false;
  const fullPage = Array.from({ length: UPDATE_PAGE_SIZE }, () => change("fictional-update", 2));
  const poller = createUpdateCenterPoller({
    interests: interests({ categories: ["disasters_weather"] }),
    storage,
    scheduler,
    onState: captured.onState,
    refreshCurrentEvents: async () => { calls.push("events"); },
    getUpdates: async (cursor) => {
      calls.push("updates:" + (cursor ?? "baseline"));
      if (!recoveryStarted && cursor === "cursor-old") return page(fullPage, "cursor-p1");
      if (!recoveryStarted && cursor === "cursor-p1") return page(fullPage, "cursor-p2");
      if (!recoveryStarted && cursor === "cursor-p2") return page(fullPage, "cursor-p3");
      if (!recoveryStarted && cursor === "cursor-p3") return page(fullPage, "cursor-p4");
      if (!recoveryStarted && cursor === "cursor-p4") {
        recoveryStarted = true;
        throw new ApiHttpError(410);
      }
      if (cursor === undefined) return page([], "cursor-rebased");
      if (cursor === "cursor-rebased") return page([], "cursor-resumed");
      throw new Error("unexpected synthetic cursor");
    },
    getDetail: async (eventId) => detail(eventId),
  });
  t.after(() => poller.stop());

  poller.start(true);
  await poller.refresh();
  assert.deepEqual(calls, [
    "updates:cursor-old",
    "updates:cursor-p1",
    "updates:cursor-p2",
    "updates:cursor-p3",
    "updates:cursor-p4",
  ]);
  assert.equal(calls.filter((call) => call.startsWith("updates:")).length, UPDATE_MAX_PAGES_PER_CYCLE);
  assert.equal(storage.values.has(UPDATE_CURSOR_STORAGE_KEY), false);
  assert.equal(captured.states[captured.states.length - 1]?.items.length, 0);
  assert.equal(scheduler.fireNext(), 0, "cursor reset must continue immediately after the five-page budget");
  await poller.refresh();
  assert.deepEqual(calls.slice(-3), ["updates:baseline", "events", "updates:cursor-rebased"]);
  assert.equal(storage.values.get(UPDATE_CURSOR_STORAGE_KEY), "cursor-resumed");
  assert.equal(captured.states.at(-1)?.resetNotice, true);
});

test("page budget stops after five full pages and continues from the fifth cursor next cycle", async (t) => {
  const storage = new MemoryStorage();
  storage.values.set(UPDATE_CURSOR_STORAGE_KEY, "cursor-0");
  const scheduler = new FakeScheduler();
  const captured = captureStates();
  const requests: string[] = [];
  const fullPage = Array.from({ length: UPDATE_PAGE_SIZE }, () => change("same-event", 2));
  const poller = createUpdateCenterPoller({
    interests: interests({ categories: ["disasters_weather"] }),
    storage,
    scheduler,
    onState: captured.onState,
    refreshCurrentEvents: async () => {},
    getUpdates: async (cursor) => {
      const current = cursor ?? "baseline";
      requests.push(current);
      if (current === "cursor-5") return page([], "cursor-final");
      return page(fullPage, "cursor-" + (Number(current.slice("cursor-".length)) + 1));
    },
    getDetail: async (eventId) => detail(eventId),
  });
  t.after(() => poller.stop());

  poller.start(true);
  await poller.refresh();
  assert.equal(requests.length, UPDATE_MAX_PAGES_PER_CYCLE);
  assert.equal(requests[4], "cursor-4");
  assert.equal(storage.values.get(UPDATE_CURSOR_STORAGE_KEY), "cursor-5");
  assert.equal(captured.states.at(-1)?.items.length, 1, "duplicate event/version entries are kept once in memory");
  assert.equal(scheduler.fireNext(), UPDATE_POLL_INTERVAL_MS);
  await poller.refresh();
  assert.equal(requests.at(-1), "cursor-5");
});

test("update cards distinguish current event time, published-change time, and system check time", () => {
  const item = matchedEvent("fictional/id?1");
  item.change.change_type = "retracted";
  const markup = renderToStaticMarkup(<UpdateCenterContent
    gate="live"
    state={{ status: "ready", phase: "updates", items: [item], checkedAt, resetNotice: false, failure: null }}
    onRefresh={() => {}}
  />);

  assert.match(markup, /Perubahan fiktif di Pondok Labu/);
  assert.match(markup, /Pernyataan terkait ditarik/);
  assert.doesNotMatch(markup, /Versi ditarik/);
  assert.match(markup, /Waktu kejadian saat ini/);
  assert.match(markup, /tanggal saja/);
  assert.match(markup, /Waktu perubahan dipublikasikan/);
  assert.match(markup, /Pemeriksaan sistem terakhir/);
  assert.match(markup, /href="#detail\/api\/fictional%2Fid%3F1"/);
  assert.match(markup, /Cocok dengan kategori pilihan Anda/);
});
