import assert from "node:assert/strict";
import test from "node:test";
import type { PublicContext, PublicFeatureCollection, EventView } from "@waspada/worker/public-contracts";
import { createAdminMonitor, type AdminMonitorScheduler } from "../src/admin-monitoring.js";
import { createSimulationSnapshot, SIMULATION_STEPS } from "../src/admin-fixtures.js";
import type { AdminMonitorState } from "../src/admin-types.js";

const NOW = Date.parse("2026-10-10T03:00:00.000Z");
const sourceUrl = "https://source.example.test/notices/one";

function context(datasetLabel: PublicContext["dataset_label"] = "synthetic", datasetMode: PublicContext["dataset_mode"] = "demo", displayName = "Kanal Contoh Publik") : PublicContext {
  return {
    dataset_mode: datasetMode,
    dataset_label: datasetLabel,
    generated_at: "2026-10-10T02:59:00.000Z",
    sources: [{
      display_name: displayName,
      health: "degraded",
      last_success_at: "2026-10-10T02:30:00.000Z",
    }],
  };
}
function eventView(options: { eventId?: string; version?: number; dateOnly?: string; impossibleDate?: string } = {}): EventView {
  const eventId = options.eventId ?? "public-event-01";
  const version = options.version ?? 1;
  const start = options.impossibleDate ?? options.dateOnly ?? "2026-10-10T02:00:00.000Z";
  const precision = options.impossibleDate || options.dateOnly ? "date" : "exact";
  const time = { start, end: null, precision } as const;
  const scope = { places: ["Tempat Contoh, Jakarta (fiktif)"], services: [], institutions: [], audiences: [] };
  const validity = { valid_from: "2026-10-10T01:00:00.000Z", valid_until: null };
  return {
    event_id: eventId,
    version,
    title: "Contoh pemberitahuan publik fiktif",
    summary: "Ringkasan yang diterbitkan dalam fixture lokal.",
    category: "disasters_weather",
    tags: [{ namespace: "topic", value: "fictional_example" }],
    lifecycle: "ongoing",
    freshness: {
      status: "current",
      evaluated_at: "2026-10-10T02:45:00.000Z",
      review_due_at: null,
      basis: "manual_review",
    },
    event_time: time,
    validity,
    scope,
    claims: [{
      claim_id: "public-claim-01",
      text: "Klaim publik fiktif untuk menguji proyeksi.",
      event_time: time,
      validity,
      scope,
      qualifiers: ["contoh"],
      evidence_label: "attributed_report",
      sources: [{
        display_name: "Situs Contoh Publik",
        url: sourceUrl,
        published_at: "2026-10-10T02:10:00.000Z",
        observed_at: "2026-10-10T02:05:00.000Z",
        excerpt: "Kutipan sumber fiktif.",
      }],
    }],
    impacts: [],
    published_at: "2026-10-10T02:15:00.000Z",
  };
}
function eventPage(events: EventView[] = [eventView()]) {
  return {
    data: events,
    page: { next_cursor: "opaque-next-page", cursor_expires_at: "2026-10-11T00:00:00.000Z" },
  };
}
function feature(eventId: string, version: number, id = "feature-01", type: "Point" | "LineString" = "Point") {
  return {
    type: "Feature" as const,
    id,
    geometry: type === "Point"
      ? { type: "Point" as const, coordinates: [106.81, -6.20] as [number, number] }
      : { type: "LineString" as const, coordinates: [[106.81, -6.20], [106.82, -6.21]] as [number, number][] },
    properties: {
      event_id: eventId,
      version,
      title: "Contoh geometri publik fiktif",
      category: "disasters_weather" as const,
      lifecycle: "ongoing" as const,
      freshness: "current" as const,
      geometry_role: "incident_scene" as const,
    },
  };
}
function featureCollection(features = [
  feature("public-event-01", 1, "matching-point"),
  feature("public-event-01", 1, "matching-line", "LineString"),
  feature("public-event-01", 2, "wrong-version"),
  feature("event-not-on-page", 1, "not-on-page"),
]): PublicFeatureCollection {
  return { type: "FeatureCollection", features };
}
function jsonResponse(value: unknown, contentType = "application/json", headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": contentType, ...headers },
  });
}
function payloadForPath(path: string, currentContext = context()): Response {
  if (path === "/api/v1/context") return jsonResponse(currentContext);
  if (path === "/api/v1/events?limit=20") return jsonResponse(eventPage());
  if (path === "/api/v1/events.geojson") return jsonResponse(featureCollection(), "application/geo+json");
  throw new Error("Unexpected local fixture path: " + path);
}
function requestPath(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}
async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}
class FakeScheduler implements AdminMonitorScheduler {
  private nextId = 1;
  readonly tasks = new Map<number, { callback: () => void; delayMs: number }>();
  setTimeout(callback: () => void, delayMs: number): number {
    const id = this.nextId++;
    this.tasks.set(id, { callback, delayMs });
    return id;
  }
  clearTimeout(handle: unknown): void {
    if (typeof handle === "number") this.tasks.delete(handle);
  }
  get delays(): number[] {
    return [...this.tasks.values()].map((task) => task.delayMs).sort((a, b) => a - b);
  }
  runNext(): number {
    const next = [...this.tasks.entries()].sort((left, right) => left[0] - right[0])[0];
    assert.ok(next, "expected a scheduled callback");
    this.tasks.delete(next[0]);
    next[1].callback();
    return next[1].delayMs;
  }
}

test("simulation script is finite, immutable, fictional, and covers the operational stops", () => {
  assert.equal(SIMULATION_STEPS.length, 10);
  assert.deepEqual(SIMULATION_STEPS.map((step) => step.index), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.ok(Object.isFrozen(SIMULATION_STEPS));
  assert.ok(Object.isFrozen(SIMULATION_STEPS[0]));
  const step2 = createSimulationSnapshot(2);
  const step4 = createSimulationSnapshot(4);
  const step5 = createSimulationSnapshot(5);
  const step6 = createSimulationSnapshot(6);
  const step7 = createSimulationSnapshot(7);
  const step8 = createSimulationSnapshot(8);

  const byId = (snapshot: ReturnType<typeof createSimulationSnapshot>, id: string) =>
    snapshot.items.find((item) => item.id === id);
  assert.equal(byId(step2, "sim-parse-quarantine")?.state, "held");
  assert.equal(byId(step4, "sim-l3-budget")?.state, "running");
  assert.equal(byId(step5, "sim-l3-budget")?.state, "failed");
  assert.match(byId(step5, "sim-l3-budget")?.stopReason ?? "", /batas anggaran/i);
  assert.equal(byId(step5, "sim-l3-budget")?.budget?.toolsUsed, 3);
  assert.equal(byId(step5, "sim-l3-budget")?.budget?.reasoningUsed, 2);
  assert.equal(byId(step6, "sim-moderator-hold")?.state, "held");
  assert.equal(byId(step6, "sim-published-example")?.publicEventId, null);
  assert.equal(byId(step7, "sim-published-example")?.state, "done");
  assert.equal(byId(step7, "sim-published-example")?.datasetKind, "synthetic");
  assert.equal(byId(step7, "sim-published-example")?.publicStatus, undefined);
  assert.equal(byId(step8, "sim-source-unavailable")?.state, "failed");
  assert.equal(byId(step8, "sim-unmapped-notice")?.geometry, null);
  assert.equal(step8.layers.find((layer) => layer.layer === "L5")?.count, 1);
  assert.ok(step8.items.every((item) => item.datasetKind === "synthetic"));
  assert.ok(step8.items.flatMap((item) => item.sourceNames).every((name) => /fiktif|contoh|rekaan|imajiner/i.test(name)));
  assert.ok(step8.limitations.some((note) => /bukan batas resmi|zona bahaya/i.test(note)));
  assert.ok(Object.isFrozen(step8));
  assert.ok(Object.isFrozen(step8.items));
  assert.throws(() => createSimulationSnapshot(-1), RangeError);
  assert.throws(() => createSimulationSnapshot(SIMULATION_STEPS.length), RangeError);
  assert.throws(() => {
    (step8.items[0] as { title: string }).title = "changed";
  }, TypeError);
});

test("public monitoring reads only the bounded read paths and joins every exact event/version geometry", async () => {
  const scheduler = new FakeScheduler();
  const calls: Array<{ path: string; init: RequestInit | undefined }> = [];
  let now = NOW;
  const latest: { current: AdminMonitorState | null } = { current: null };
  const monitor = createAdminMonitor({
    onState: (state) => { latest.current = state; },
    scheduler,
    clock: () => now += 5,
    fetch: async (input, init) => {
      const path = requestPath(input);
      calls.push({ path, init });
      return payloadForPath(path);
    },
  });

  await monitor.start();

  assert.deepEqual(calls.map((call) => call.path), [
    "/api/v1/context", "/api/v1/events?limit=20", "/api/v1/events.geojson",
  ]);
  assert.ok(calls.every(({ init }) => init?.method === "GET"));
  assert.ok(calls.every(({ init }) => init?.cache === "no-store"));
  assert.ok(calls.every(({ init }) => init?.credentials === "omit"));
  assert.ok(calls.every(({ init }) => init?.redirect === "error"));
  assert.ok(calls.every(({ init }) => init?.body === undefined));
  assert.ok(calls.every(({ init }) => init?.signal instanceof AbortSignal));
  assert.equal((calls[1]?.init?.headers as Record<string, string>).accept, "application/json");
  assert.equal((calls[2]?.init?.headers as Record<string, string>).accept, "application/geo+json");
  assert.equal(latest.current?.status, "connected");
  assert.equal(latest.current?.snapshot?.mode, "public_api");
  assert.equal(latest.current?.snapshot?.datasetMode, "demo");
  assert.equal(latest.current?.snapshot?.context?.dataset_label, "synthetic");
  assert.equal(latest.current?.snapshot?.items[0]?.datasetKind, "synthetic");
  assert.equal(latest.current?.snapshot?.items[0]?.geometryBasis, "source_supported");
  assert.deepEqual(latest.current?.snapshot?.items[0]?.geometry, featureCollection().features[0]?.geometry);
  assert.equal(latest.current?.snapshot?.items[0]?.additionalGeometries?.length, 1);
  assert.equal(latest.current?.snapshot?.items[0]?.sourceNames[0], "Situs Contoh Publik");
  assert.equal(latest.current?.snapshot?.items[0]?.observedAt, "2026-10-10T02:05:00.000Z");
  assert.equal(latest.current?.snapshot?.items[0]?.eventVersion, 1);
  assert.deepEqual(latest.current?.snapshot?.items[0]?.publicStatus, {
    lifecycle: "ongoing",
    freshness: eventView().freshness,
    eventTime: eventView().event_time,
    validity: eventView().validity,
  });
  assert.equal(latest.current?.snapshot?.items[0]?.publicEventId, "public-event-01");
  assert.equal(latest.current?.snapshot?.hasMoreEvents, true);
  assert.equal(latest.current?.snapshot?.layers.find((layer) => layer.layer === "L2")?.count, null);
  assert.equal(latest.current?.snapshot?.layers.find((layer) => layer.layer === "L3")?.count, null);
  assert.equal(latest.current?.snapshot?.layers.find((layer) => layer.layer === "L4")?.count, 1);
  assert.equal(latest.current?.snapshot?.layers.find((layer) => layer.layer === "L5")?.count, null);
  assert.equal(latest.current?.snapshot?.sources[0]?.health, "degraded");
  assert.equal(latest.current?.lastSuccessAt, latest.current?.snapshot?.capturedAt);
  assert.equal(latest.current?.currentAttempt?.probes.length, 3);
  assert.ok(latest.current?.currentAttempt?.probes.every((probe) => probe.status === "succeeded"));
  assert.equal(scheduler.delays[0], 30_000);
  assert.ok(latest.current?.snapshot?.limitations.some((note) => /tidak ada request detail/i.test(note)));

  monitor.pause();
  assert.deepEqual(scheduler.delays, []);
  assert.equal(latest.current?.status, "paused");
  monitor.stop();
});

test("unverified context hides API data and prevents event/geometry requests", async () => {
  const calls: string[] = [];
  const latest: { current: AdminMonitorState | null } = { current: null };
  const invalidContext = { ...context(), unexpected_private_field: "discard" };
  const monitor = createAdminMonitor({
    onState: (state) => { latest.current = state; },
    scheduler: new FakeScheduler(),
    clock: () => NOW,
    fetch: async (input) => {
      const path = requestPath(input);
      calls.push(path);
      if (path === "/api/v1/context") return jsonResponse(invalidContext);
      throw new Error("Unexpected endpoint after context validation failed.");
    },
  });

  await monitor.start();

  assert.deepEqual(calls, ["/api/v1/context"]);
  assert.equal(latest.current?.status, "error");
  assert.equal(latest.current?.snapshot, null);
  assert.equal(latest.current?.currentAttempt?.context, null);
  assert.equal(latest.current?.currentAttempt?.probes[0]?.status, "failed");
  assert.deepEqual(latest.current?.currentAttempt?.probes.slice(1).map((probe) => probe.status), ["unavailable", "unavailable"]);
  assert.equal(latest.current?.lastSuccessAt, null);
  monitor.stop();
});

test("a contradictory dataset mode and label cannot authorize public previews", async () => {
  const calls: string[] = [];
  const latest: { current: AdminMonitorState | null } = { current: null };
  const monitor = createAdminMonitor({
    onState: (state) => { latest.current = state; },
    scheduler: new FakeScheduler(),
    clock: () => NOW,
    fetch: async (input) => {
      const path = requestPath(input);
      calls.push(path);
      if (path === "/api/v1/context") return jsonResponse(context("synthetic", "live"));
      throw new Error("A contradictory context must stop the cycle.");
    },
  });

  await monitor.start();

  assert.deepEqual(calls, ["/api/v1/context"]);
  assert.equal(latest.current?.status, "error");
  assert.equal(latest.current?.snapshot, null);
  assert.equal(latest.current?.currentAttempt?.context, null);
  assert.deepEqual(latest.current?.currentAttempt?.probes.slice(1).map((probe) => probe.status), ["unavailable", "unavailable"]);
  monitor.stop();
});

test("an event page over the public first-page bound is rejected without projecting partial rows", async () => {
  const scheduler = new FakeScheduler();
  const latest: { current: AdminMonitorState | null } = { current: null };
  const monitor = createAdminMonitor({
    onState: (state) => { latest.current = state; },
    scheduler,
    clock: () => NOW,
    fetch: async (input) => {
      const path = requestPath(input);
      if (path === "/api/v1/context") return jsonResponse(context());
      if (path === "/api/v1/events?limit=20") {
        return jsonResponse(eventPage(Array.from({ length: 21 }, (_entry, index) => eventView({
          eventId: "public-event-" + String(index + 1),
        }))));
      }
      if (path === "/api/v1/events.geojson") return jsonResponse(featureCollection(), "application/geo+json");
      throw new Error("Unexpected path.");
    },
  });

  await monitor.start();

  assert.equal(latest.current?.status, "partial");
  assert.equal(latest.current?.snapshot?.items.length, 0);
  assert.equal(latest.current?.snapshot?.layers.find((layer) => layer.layer === "L4")?.count, null);
  assert.equal(latest.current?.currentAttempt?.probes.find((probe) => probe.endpoint === "events")?.status, "failed");
  assert.equal(latest.current?.currentAttempt?.probes.find((probe) => probe.endpoint === "geometry")?.status, "succeeded");
  assert.equal(scheduler.delays[0], 60_000);
  monitor.stop();
});

test("date-only event times are accepted only when valid and impossible calendar dates fail closed", async () => {
  const scheduler = new FakeScheduler();
  const latest: { current: AdminMonitorState | null } = { current: null };
  let impossible = false;
  const monitor = createAdminMonitor({
    onState: (state) => { latest.current = state; },
    scheduler,
    clock: () => NOW,
    fetch: async (input) => {
      const path = requestPath(input);
      if (path === "/api/v1/context") return jsonResponse(context());
      if (path === "/api/v1/events?limit=20") {
        return jsonResponse(eventPage([eventView(impossible
          ? { impossibleDate: "2026-02-30" }
          : { dateOnly: "2026-02-28" })]));
      }
      if (path === "/api/v1/events.geojson") return jsonResponse(featureCollection(), "application/geo+json");
      throw new Error("Unexpected path.");
    },
  });

  await monitor.start();
  assert.equal(latest.current?.status, "connected");
  assert.equal(latest.current?.snapshot?.items[0]?.observedAt, "2026-10-10T02:05:00.000Z");
  assert.equal(latest.current?.snapshot?.items.length, 1);
  assert.equal(latest.current?.snapshot?.items[0]?.publicStatus?.eventTime.start, "2026-02-28");
  assert.equal(latest.current?.snapshot?.items[0]?.publicStatus?.eventTime.precision, "date");

  monitor.pause();
  impossible = true;
  await monitor.start();
  assert.equal(latest.current?.status, "partial");
  assert.equal(latest.current?.snapshot?.items.length, 0);
  assert.equal(latest.current?.snapshot?.layers.find((layer) => layer.layer === "L4")?.count, null);
  assert.equal(latest.current?.currentAttempt?.probes.find((probe) => probe.endpoint === "events")?.status, "failed");
  assert.equal(latest.current?.lastSuccessAt, "2026-10-10T03:00:00.000Z");
  monitor.stop();
});

test("failed current probes retain a distinct last-success time and back off without mixing old dataset records", async () => {
  const scheduler = new FakeScheduler();
  const calls: string[] = [];
  let cycle = 0;
  let now = NOW;
  const latest: { current: AdminMonitorState | null } = { current: null };
  const monitor = createAdminMonitor({
    onState: (state) => { latest.current = state; },
    scheduler,
    clock: () => now,
    fetch: async (input) => {
      const path = requestPath(input);
      calls.push(path);
      if (path === "/api/v1/context") {
        cycle += 1;
        return jsonResponse(cycle === 1 ? context() : context("live", "live", "Different source for current dataset"));
      }
      if (path === "/api/v1/events?limit=20") {
        return cycle === 2 ? new Response("service unavailable", { status: 503 }) : jsonResponse(eventPage());
      }
      if (path === "/api/v1/events.geojson") return jsonResponse(featureCollection(), "application/geo+json");
      throw new Error("Unexpected path.");
    },
  });

  await monitor.start();
  const previousSuccessAt = latest.current?.lastSuccessAt;
  const previousSnapshotAt = latest.current?.snapshot?.capturedAt;
  assert.equal(scheduler.delays[0], 30_000);

  now += 30_000;
  assert.equal(scheduler.runNext(), 30_000);
  await monitor.refresh();

  assert.equal(latest.current?.status, "partial");
  assert.equal(latest.current?.lastSuccessAt, previousSuccessAt);
  assert.equal(latest.current?.snapshot?.capturedAt, new Date(now).toISOString());
  assert.notEqual(latest.current?.snapshot?.capturedAt, previousSnapshotAt);
  assert.equal(latest.current?.snapshot?.datasetMode, "live");
  assert.equal(latest.current?.snapshot?.context?.dataset_label, "live");
  assert.equal(latest.current?.snapshot?.items.length, 0);
  assert.equal(latest.current?.snapshot?.sources[0]?.name, "Different source for current dataset");
  assert.equal(latest.current?.snapshot?.layers.find((layer) => layer.layer === "L4")?.count, null);
  assert.equal(latest.current?.currentAttempt?.context?.dataset_mode, "live");
  assert.equal(latest.current?.currentAttempt?.probes.find((probe) => probe.endpoint === "events")?.httpStatus, 503);
  assert.equal(latest.current?.consecutiveFailures, 1);
  assert.equal(scheduler.delays[0], 60_000);
  assert.deepEqual(calls.slice(3), [
    "/api/v1/context", "/api/v1/events?limit=20", "/api/v1/events.geojson",
  ]);
  monitor.pause();
  monitor.stop();
});

test("a new attempt hides the prior dataset snapshot until current list and geometry finish", async () => {
  const scheduler = new FakeScheduler();
  const latest: { current: AdminMonitorState | null } = { current: null };
  const observedStates: AdminMonitorState[] = [];
  const pending: {
    events: ((response: Response) => void) | null;
    geometry: ((response: Response) => void) | null;
  } = { events: null, geometry: null };
  let cycle = 0;
  let now = NOW;
  const monitor = createAdminMonitor({
    onState: (state) => { latest.current = state; observedStates.push(state); },
    scheduler,
    clock: () => now += 5,
    fetch: async (input) => {
      const path = requestPath(input);
      if (path === "/api/v1/context") {
        cycle += 1;
        return jsonResponse(cycle === 1 ? context() : context("live", "live", "Current live source"));
      }
      if (path === "/api/v1/events?limit=20") {
        return cycle === 1
          ? jsonResponse(eventPage())
          : new Promise<Response>((resolve) => { pending.events = resolve; });
      }
      if (path === "/api/v1/events.geojson") {
        return cycle === 1
          ? jsonResponse(featureCollection(), "application/geo+json")
          : new Promise<Response>((resolve) => { pending.geometry = resolve; });
      }
      throw new Error("Unexpected path.");
    },
  });

  await monitor.start();
  const previousSuccessAt = latest.current?.lastSuccessAt;
  assert.equal(latest.current?.snapshot?.datasetMode, "demo");
  assert.ok(previousSuccessAt);

  const refreshing = monitor.refresh();
  for (let index = 0; index < 20 && (pending.events === null || pending.geometry === null); index += 1) {
    await Promise.resolve();
  }
  assert.ok(pending.events);
  assert.ok(pending.geometry);
  const currentContextLoadingStates = observedStates.filter((state) =>
    state.status === "loading" && state.currentAttempt?.context?.dataset_mode === "live");
  assert.ok(currentContextLoadingStates.length > 0);
  assert.ok(currentContextLoadingStates.every((state) => state.snapshot === null));
  assert.equal(latest.current?.snapshot, null);
  assert.equal(latest.current?.lastSuccessAt, previousSuccessAt);

  pending.events?.(jsonResponse(eventPage([eventView({ eventId: "live-event", version: 2 })])));
  pending.geometry?.(jsonResponse(featureCollection([feature("live-event", 2)]), "application/geo+json"));
  await refreshing;

  const completedState = latest.current as AdminMonitorState | null;
  assert.equal(completedState?.status, "connected");
  assert.equal(completedState?.snapshot?.datasetMode, "live");
  assert.equal(completedState?.snapshot?.context?.dataset_label, "live");
  assert.deepEqual(completedState?.snapshot?.items.map((item) => item.id), ["public:live-event:2"]);
  assert.notEqual(completedState?.lastSuccessAt, previousSuccessAt);
  monitor.stop();
});

test("visibility aborts and discards a late response, then resumes one coalesced request", async () => {
  const scheduler = new FakeScheduler();
  const calls: string[] = [];
  const signals: AbortSignal[] = [];
  const firstContext: { release: ((response: Response) => void) | null } = { release: null };
  const latest: { current: AdminMonitorState | null } = { current: null };
  let contextCalls = 0;
  const monitor = createAdminMonitor({
    onState: (state) => { latest.current = state; },
    scheduler,
    clock: () => NOW,
    fetch: async (input, init) => {
      const path = requestPath(input);
      calls.push(path);
      if (init?.signal) signals.push(init.signal as AbortSignal);
      if (path === "/api/v1/context" && contextCalls++ === 0) {
        return new Promise<Response>((resolve) => { firstContext.release = resolve; });
      }
      return payloadForPath(path);
    },
  });

  const started = monitor.start();
  await flushMicrotasks();
  assert.deepEqual(calls, ["/api/v1/context"]);
  const coalesced = monitor.refresh();
  assert.equal(coalesced, started);
  monitor.setVisible(false);
  assert.equal(signals[0]?.aborted, true);
  assert.equal(latest.current?.status, "paused");
  monitor.setVisible(true);
  firstContext.release?.(jsonResponse(context()));
  await started;
  await monitor.refresh();

  assert.deepEqual(calls, [
    "/api/v1/context",
    "/api/v1/context",
    "/api/v1/events?limit=20",
    "/api/v1/events.geojson",
  ]);
  assert.equal(latest.current?.status, "connected");
  assert.equal(latest.current?.snapshot?.items.length, 1);
  assert.equal(latest.current?.lastSuccessAt, latest.current?.snapshot?.capturedAt);
  monitor.stop();
});

test("pause, offline, and stop abort an active request and discard its late result", async () => {
  const cases: Array<{
    name: string;
    action: (monitor: ReturnType<typeof createAdminMonitor>) => void;
    expectedStatus: "paused" | "offline";
  }> = [
    { name: "pause", action: (monitor) => monitor.pause(), expectedStatus: "paused" },
    { name: "offline", action: (monitor) => monitor.setOnline(false), expectedStatus: "offline" },
    { name: "stop", action: (monitor) => monitor.stop(), expectedStatus: "paused" },
  ];
  for (const scenario of cases) {
    const scheduler = new FakeScheduler();
    const sent: { signal: AbortSignal | null } = { signal: null };
    const latest: { current: AdminMonitorState | null } = { current: null };
    const monitor = createAdminMonitor({
      onState: (state) => { latest.current = state; },
      scheduler,
      clock: () => NOW,
      fetch: async (_input, init) => new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal as AbortSignal;
        sent.signal = signal;
        signal.addEventListener("abort", () => reject(new Error("Aborted by monitor lifecycle.")), { once: true });
      }),
    });

    const started = monitor.start();
    await flushMicrotasks();
    assert.ok(sent.signal, scenario.name + " should have started a probe");
    scenario.action(monitor);
    assert.equal(sent.signal?.aborted, true, scenario.name + " should abort the active request");
    await started;

    assert.equal(latest.current?.status, scenario.expectedStatus);
    assert.equal(latest.current?.snapshot, null);
    assert.deepEqual(scheduler.delays, []);
    monitor.stop();
  }
});

test("a hung endpoint is aborted at the bounded deadline and enters backoff", async () => {
  const scheduler = new FakeScheduler();
  const sent: { signal: AbortSignal | null } = { signal: null };
  const latest: { current: AdminMonitorState | null } = { current: null };
  const monitor = createAdminMonitor({
    onState: (state) => { latest.current = state; },
    scheduler,
    clock: () => NOW,
    fetch: async (_input, init) => {
      sent.signal = init?.signal as AbortSignal;
      return new Promise<Response>(() => undefined);
    },
  });

  const start = monitor.start();
  await flushMicrotasks();
  assert.equal(sent.signal?.aborted, false);
  assert.equal(scheduler.delays[0], 15_000);
  assert.equal(scheduler.runNext(), 15_000);
  await start;

  assert.equal(sent.signal?.aborted, true);
  assert.equal(latest.current?.status, "error");
  assert.equal(latest.current?.currentAttempt?.probes[0]?.status, "failed");
  assert.equal(latest.current?.currentAttempt?.probes[0]?.httpStatus, null);
  assert.equal(latest.current?.lastSuccessAt, null);
  assert.equal(latest.current?.consecutiveFailures, 1);
  assert.equal(scheduler.delays[0], 60_000);
  monitor.stop();
});

test("the bounded deadline includes a response body that never finishes", async () => {
  const scheduler = new FakeScheduler();
  const sent: { signal: AbortSignal | null } = { signal: null };
  const latest: { current: AdminMonitorState | null } = { current: null };
  const monitor = createAdminMonitor({
    onState: (state) => { latest.current = state; },
    scheduler,
    clock: () => NOW,
    fetch: async (_input, init) => {
      const signal = init?.signal as AbortSignal;
      sent.signal = signal;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          signal.addEventListener("abort", () => controller.error(new Error("Request aborted.")), { once: true });
        },
      });
      return new Response(body, { headers: { "content-type": "application/json" } });
    },
  });

  const start = monitor.start();
  await flushMicrotasks();
  assert.equal(sent.signal?.aborted, false);
  assert.equal(scheduler.delays[0], 15_000);
  assert.equal(scheduler.runNext(), 15_000);
  await start;

  assert.equal(sent.signal?.aborted, true);
  assert.equal(latest.current?.status, "error");
  assert.equal(latest.current?.currentAttempt?.probes[0]?.httpStatus, null);
  assert.equal(latest.current?.consecutiveFailures, 1);
  assert.equal(scheduler.delays[0], 60_000);
  monitor.stop();
});
