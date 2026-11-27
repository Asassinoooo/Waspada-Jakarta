import assert from "node:assert/strict";
import { after, before, describe, it, type TestContext } from "node:test";
import { createEventProposalWriter, type EventProposalDto } from "../../db/src/event-proposal-writer.js";
import { createPublicEventGeometriesRepository } from "../../db/src/public-event-geometries.js";
import { createSqlFreshnessTransitionLedger } from "../../db/src/freshness-transition-ledger.js";
import { createPublicEventSnapshotRepository } from "../../db/src/public-event-snapshot.js";
import { createPublicProjectionLookupRepository } from "../../db/src/public-projection-lookups.js";
import { applyMigrations, readMigrations } from "../../db/src/migrations.js";
import type { SqlExecutor } from "../../db/src/sql.js";
import { createTestDatabase, type TestDatabase } from "../../db/test/harness.js";
import { lineageIdsFor, seedProposalLineage } from "../../db/test/proposal-lineage-fixture.js";
import type { EventPage } from "../src/contracts/public-api.js";
import {
  handlePublicApiRequest,
  type WorkerEnvironment,
} from "../src/layers/l4-application-integration/api.js";
import type { PublicEventListCursorCodec } from "../src/layers/l4-application-integration/public-event-list-cursor.js";
import type { PublicEventListPageService } from "../src/layers/l4-application-integration/public-event-list-page-service.js";
import {
  createPublicEventDetailProjectionService,
  type PublicEventDetailProjectionService,
} from "../src/layers/l4-application-integration/public-event-detail-projection-service.js";
import {
  AGENT_AUTO_PUBLISHER_ID,
  decideProposal,
  withdrawPublishedEvent,
  type ProposalDecisionDependencies,
} from "../src/layers/l4-application-integration/proposal-publication.js";
import { noOpTelemetry } from "../src/layers/l5-evaluation-monitoring/telemetry.js";
import {
  createPublicEventGeoJSONRuntime,
  type PublicEventGeoJSONRuntime,
} from "../src/runtime/public-event-geojson-runtime.js";
import { createPublicEventDetailRuntime } from "../src/runtime/public-event-detail-runtime.js";
import {
  createPublicEventListCursorCodecForKey,
  createPublicEventListRuntime,
} from "../src/runtime/public-event-list-runtime.js";
import {
  createPublicSnapshotStore,
  newPublicSnapshotTiming,
  PUBLIC_SNAPSHOT_KEY,
  type PublicSnapshotKvNamespace,
  type PublicSnapshotStore,
  PUBLIC_SNAPSHOT_VERIFIED_KEY,
} from "../src/runtime/public-snapshot.js";
import {
  publicSnapshotRouteFor,
  PUBLIC_READ_CACHE_CONTROL,
  readPublicSnapshotRoute,
  snapshotServerTiming,
  type PublicSnapshotRouteKind,
} from "../src/runtime/public-snapshot-route.js";
import worker from "../src/index.js";

/**
 * PERF-03 (23 Nov 2026): the hosted public reads of the event list, one event and the GeoJSON collection come from a
 * KV snapshot built by the existing DB services. These tests use PGlite and the real publication path, as PERF-01
 * does. Each snapshot answer must equal the DB path's bytes, and must issue no SQL. The DB path here is the real
 * handlePublicApiRequest with the same page service, detail and GeoJSON runtimes the Worker builds.
 */

const PUBLISHED_EVENT_COUNT = 20;
const LINEAGE_KEYS = ["perf03a", "perf03b"] as const;
const SOURCE_IDS = new Set(LINEAGE_KEYS.map((key) => `source-lineage-${key}`));
const TEST_CONNECTION_STRING = "postgresql://test-user:test-password@hyperdrive.example.invalid/waspada?sslmode=require";
const TEST_CURSOR_KEY_HEX = "fedcba9876543210".repeat(4);
const TEST_NOW = Date.parse("2026-11-23T00:00:00.000Z");
const ENV: WorkerEnvironment = { DATASET_MODE: "live" };
/**
 * PERF-08: the fixed shape of a snapshot answer's Server-Timing. Only a source word and rounded numbers match. PERF-05
 * trial: the edge part appears only when a `caches.default` exists, so it is optional here.
 */
const SERVER_TIMING = /^snap;desc="(memo|kv|rebuild)", kv;dur=\d+(?:\.\d)?, db;dur=\d+(?:\.\d)?, build;dur=\d+(?:\.\d)?, total;dur=\d+(?:\.\d)?(?:, edge;desc="(?:hit|miss)")?$/u;
/** PERF-06: the staleness bound of the background check (the store default). */
const STALE_AFTER_MS = 300_000;

function proposalFor(index: number): EventProposalDto {
  const lineageKey = LINEAGE_KEYS[index % LINEAGE_KEYS.length]!;
  const eventId = eventIdFor(index);
  const sourceId = `source-lineage-${lineageKey}`;
  return {
    schema_version: "2.0",
    ...lineageIdsFor(lineageKey),
    proposal_id: `prop-${eventId}`,
    incident_id: eventId,
    title: `Genangan titik ${index} (fiktif)`,
    incident_type: "genangan_air_luapan_saluran",
    primary_category: "disasters_weather",
    compatibility_category: "flood",
    severity: "medium",
    event_time: { precision: "exact", value: "2026-11-10T08:00:00.000Z" },
    location_label: `Lokasi fiktif ${index}, Jakarta Timur`,
    coordinates: [106.87 + index * 0.001, -6.24 - index * 0.001],
    claims: [{
      claim_id: "claim-1",
      claim_text: `Genangan ${index} di lokasi fiktif`,
      evidence_label: "attributed_report",
      support_assessment: "supported",
      quote_text: "Genangan setinggi 50 cm di Cawang (fiktif)",
      evidence_ref_id: `chk-prop-${eventId}`,
      source_id: sourceId,
      outlet: "Fictional lineage source",
      source_url: `https://lineage.invalid/${lineageKey}`,
    }],
    impacts: [],
    interpretation_category: null,
    source_id: sourceId,
    is_multi_source: false,
    source_count: 1,
    has_discrepancy: false,
    discrepancy_summary: null,
    discrepancies: [],
    caveats: [],
    correlation_relationship: "primary_initial",
    proposed_at: "2026-11-10T08:05:00.000Z",
  } as EventProposalDto;
}

function eventIdFor(index: number): string {
  return `inc-perf03-${String(index).padStart(2, "0")}`;
}

/** Publishes the events through the real auto-publication path. Each one has a point, and a source attribution. */
async function publishEvents(database: TestDatabase): Promise<void> {
  await applyMigrations(database.executor, await readMigrations(new URL("../../db/migrations/", import.meta.url)));
  await database.executor.query("INSERT INTO waspada.dataset_namespace_config (singleton, dataset_kind) VALUES (true, 'live')");
  for (const key of LINEAGE_KEYS) await seedProposalLineage(database.executor, key);
  const deps: ProposalDecisionDependencies = {
    executor: database.executor,
    datasetKind: "live",
    checkPublicDisplay: async (sourceId: string) => SOURCE_IDS.has(sourceId),
  };
  for (let index = 0; index < PUBLISHED_EVENT_COUNT; index += 1) {
    const proposal = proposalFor(index);
    await createEventProposalWriter(database.executor).persistProposal(proposal, "live");
    const outcome = await decideProposal(deps, {
      proposalId: proposal.proposal_id,
      action: "auto_publish",
      actor: { kind: "agent", actorId: AGENT_AUTO_PUBLISHER_ID },
    }) as { readonly status: string };
    assert.equal(outcome.status, "published", eventIdFor(index));
  }
}

/** Counts each statement that reaches the database, so a test can tell a snapshot answer from a DB answer. */
function countingExecutor(database: TestDatabase, counter: { queries: number }): SqlExecutor {
  return {
    async query<Row extends object>(statement: string, parameters?: readonly unknown[]) {
      counter.queries += 1;
      return database.executor.query<Row>(statement, parameters);
    },
    async execute(statement: string) {
      await database.executor.execute(statement);
    },
  };
}

class FakeKv implements PublicSnapshotKvNamespace {
  readonly values = new Map<string, string>();
  readonly putKeys: string[] = [];

  async get(key: string, _type: "text"): Promise<string | null> {
    return this.values.get(key) ?? null;
  }

  async put(key: string, value: string): Promise<void> {
    this.putKeys.push(key);
    this.values.set(key, value);
  }
}

class BrokenKv implements PublicSnapshotKvNamespace {
  async get(): Promise<string | null> {
    throw new Error("KV unavailable");
  }

  async put(): Promise<void> {
    throw new Error("KV unavailable");
  }
}

interface Harness {
  readonly database: TestDatabase;
  readonly counter: { queries: number };
  readonly clock: { at: number };
  readonly cursorCodec: PublicEventListCursorCodec;
  readonly listService: PublicEventListPageService;
  readonly detailService: PublicEventDetailProjectionService;
  readonly geoService: PublicEventGeoJSONRuntime;
}

async function harnessFor(database: TestDatabase): Promise<Harness> {
  const counter = { queries: 0 };
  const clock = { at: TEST_NOW };
  const runner = async <Result>(_connectionString: string, operation: (executor: SqlExecutor) => Promise<Result>) =>
    operation(countingExecutor(database, counter));
  const listService = await createPublicEventListRuntime(
    { datasetMode: "live", connectionString: TEST_CONNECTION_STRING, cursorHmacKeyHex: TEST_CURSOR_KEY_HEX },
    { withSqlExecutor: runner, now: () => clock.at },
  );
  const detailService = createPublicEventDetailRuntime(
    { datasetMode: "live", connectionString: TEST_CONNECTION_STRING },
    { withSqlExecutor: runner },
  );
  const geoService = createPublicEventGeoJSONRuntime(
    { datasetMode: "live", connectionString: TEST_CONNECTION_STRING },
    { withSqlExecutor: runner },
  );
  const cursorCodec = await createPublicEventListCursorCodecForKey(TEST_CURSOR_KEY_HEX, () => clock.at);
  assert.ok(listService && detailService && geoService && cursorCodec, "the live services must be configured");
  return { database, counter, clock, cursorCodec, listService, detailService, geoService };
}

/** The DB path: the real public API router over the same services the Worker composes for live mode. */
function dbRead(h: Harness, request: Request): Promise<Response> {
  return handlePublicApiRequest(
    request,
    ENV,
    noOpTelemetry,
    h.listService,
    h.detailService,
    undefined,
    h.geoService,
    undefined,
    undefined,
  );
}

function storeFor(h: Harness, kv: PublicSnapshotKvNamespace): PublicSnapshotStore {
  return createPublicSnapshotStore({
    kv,
    withExecutor: (operation) => operation(countingExecutor(h.database, h.counter)),
    now: () => h.clock.at,
  });
}

/**
 * PERF-06: a store whose database calls wait at a gate while it is held. A background check then cannot reach the
 * database until the test releases it, so a read that returns while held has answered without the database.
 */
function gatedStore(h: Harness, kv: PublicSnapshotKvNamespace): { store: PublicSnapshotStore; hold(): void; release(): void } {
  const gate = { held: false, waiting: [] as Array<() => void> };
  const store = createPublicSnapshotStore({
    kv,
    withExecutor: async (operation) => {
      if (gate.held) await new Promise<void>((resolve) => gate.waiting.push(resolve));
      return operation(countingExecutor(h.database, h.counter));
    },
    now: () => h.clock.at,
  });
  return {
    store,
    hold: () => {
      gate.held = true;
    },
    release: () => {
      gate.held = false;
      for (const resolve of gate.waiting.splice(0)) resolve();
    },
  };
}

function snapshotRead(
  h: Harness,
  store: PublicSnapshotStore,
  kind: PublicSnapshotRouteKind,
  request: Request,
  waitUntil?: (promise: Promise<unknown>) => void,
): Promise<Response> {
  return readPublicSnapshotRoute(
    request,
    kind,
    { store, cursorCodec: h.cursorCodec, ...(waitUntil === undefined ? {} : { waitUntil }) },
    () => dbRead(h, request),
  );
}

function request(path: string, headers?: Record<string, string>): Request {
  return new Request(`https://waspada.example.invalid${path}`, headers === undefined ? {} : { headers });
}

describe("PERF-03 public read snapshot (PGlite, real publication path)", () => {
  let database: TestDatabase;
  let h: Harness;

  before(async () => {
    database = await createTestDatabase();
    await publishEvents(database);
    h = await harnessFor(database);
  });

  after(async () => {
    await database?.close();
  });

  it("PERF-03: list pages from the snapshot equal the DB path bytes, walk every event, and issue no SQL", async (t: TestContext) => {
    const kv = new FakeKv();
    const store = storeFor(h, kv);
    const buildStart = h.counter.queries;
    assert.ok(await store.read(), "the first read builds the snapshot from the database");
    const buildStatements = h.counter.queries - buildStart;
    t.diagnostic(`PERF-03 SQL statements for one snapshot build of ${PUBLISHED_EVENT_COUNT} events: ${buildStatements}; snapshot JSON ${kv.values.get(PUBLIC_SNAPSHOT_KEY)?.length ?? 0} bytes`);

    const walked: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const path: string = `/api/v1/events?limit=7${cursor === null ? "" : `&cursor=${encodeURIComponent(cursor)}`}`;
      const before = h.counter.queries;
      const served = await snapshotRead(h, store, "list", request(path));
      assert.equal(h.counter.queries, before, `page ${pages + 1} issued no SQL`);

      const servedBody: string = await served.text();
      const dbBody: string = await (await dbRead(h, request(path))).text();
      assert.equal(servedBody, dbBody, `page ${pages + 1} equals the DB path bytes`);

      assert.equal(served.status, 200);
      assert.equal(served.headers.get("cache-control"), PUBLIC_READ_CACHE_CONTROL);
      assert.match(served.headers.get("etag") ?? "", /^W\/"[0-9a-f]{16}-[0-9a-f]{16}"$/u);

      const page = JSON.parse(servedBody) as EventPage;
      walked.push(...page.data.map((event) => event.event_id));
      cursor = page.page.next_cursor;
      pages += 1;
    } while (cursor !== null);

    assert.equal(pages, 3, "20 events in pages of 7 make three pages");
    assert.equal(walked.length, PUBLISHED_EVENT_COUNT);
    assert.equal(new Set(walked).size, PUBLISHED_EVENT_COUNT);
    // The walk covers the events once, in the same order as one page of all twenty from the DB path.
    const onePage = (await (await dbRead(h, request("/api/v1/events?limit=20"))).json()) as EventPage;
    assert.deepEqual(walked, onePage.data.map((event) => event.event_id));
  });

  it("PERF-03: a snapshot detail and the GeoJSON collection equal the DB path bytes, with no SQL", async () => {
    const store = storeFor(h, new FakeKv());
    const eventId = eventIdFor(4);
    assert.ok(await store.read(), "the snapshot is built before the snapshot reads are measured");

    const before = h.counter.queries;
    const detail = await snapshotRead(h, store, "detail", request(`/api/v1/events/${eventId}`));
    assert.equal(h.counter.queries, before, "the detail came from the snapshot");
    assert.equal(detail.status, 200);
    assert.equal(await detail.text(), await (await dbRead(h, request(`/api/v1/events/${eventId}`))).text());
    assert.equal(detail.headers.get("content-type"), "application/json; charset=utf-8");

    const beforeGeo = h.counter.queries;
    const geo = await snapshotRead(h, store, "geojson", request("/api/v1/events.geojson"));
    assert.equal(h.counter.queries, beforeGeo, "the GeoJSON came from the snapshot");
    const geoBody = await geo.text();
    assert.equal(geoBody, await (await dbRead(h, request("/api/v1/events.geojson"))).text());
    assert.equal(geo.headers.get("content-type"), "application/geo+json");
    assert.ok((JSON.parse(geoBody) as { features: unknown[] }).features.length > 0, "the collection has features");
  });

  it("PERF-03: an id the snapshot does not hold, and a filtered list, are answered by the DB path", async () => {
    const store = storeFor(h, new FakeKv());
    await store.read();

    const missingPath = "/api/v1/events/inc-perf03-missing";
    const missing = await snapshotRead(h, store, "detail", request(missingPath));
    const missingDb = await dbRead(h, request(missingPath));
    assert.equal(missing.status, 404);
    assert.equal(missing.status, missingDb.status);
    assert.equal(missing.headers.get("cache-control"), "no-store", "a non-200 keeps no-store");
    assert.equal((await missing.json() as { code: string }).code, (await missingDb.json() as { code: string }).code);

    const filteredPath = "/api/v1/events?category=disasters_weather&limit=5";
    const beforeFiltered = h.counter.queries;
    const filtered = await snapshotRead(h, store, "list", request(filteredPath));
    assert.ok(h.counter.queries > beforeFiltered, "a filtered list reads the database");
    assert.equal(await filtered.text(), await (await dbRead(h, request(filteredPath))).text());
    assert.equal(filtered.headers.get("cache-control"), PUBLIC_READ_CACHE_CONTROL);
  });

  it("PERF-03: a KV read failure answers from the DB path with the same bytes and public cache headers", async () => {
    const store = storeFor(h, new BrokenKv());
    const path = "/api/v1/events?limit=3";
    const response = await snapshotRead(h, store, "list", request(path));
    assert.equal(response.status, 200);
    assert.equal(await response.text(), await (await dbRead(h, request(path))).text());
    assert.equal(response.headers.get("cache-control"), PUBLIC_READ_CACHE_CONTROL);
    assert.match(response.headers.get("etag") ?? "", /^W\/"[0-9a-f]{16}"$/u, "a DB-served page carries a body ETag");
  });

  it("PERF-03: a KV miss builds from the database, serves the page, and writes KV in the background", async () => {
    const kv = new FakeKv();
    const pending: Promise<unknown>[] = [];
    const store = storeFor(h, kv);
    const path = "/api/v1/events?limit=20";

    const response = await snapshotRead(h, store, "list", request(path), (promise) => pending.push(promise));
    assert.equal(await response.text(), await (await dbRead(h, request(path))).text());
    assert.equal(pending.length, 1, "the write is handed to waitUntil");

    await Promise.all(pending);
    // PERF-06: the snapshot is written first, then its verified time.
    assert.deepEqual(kv.putKeys, [PUBLIC_SNAPSHOT_KEY, PUBLIC_SNAPSHOT_VERIFIED_KEY]);
    assert.equal(JSON.parse(kv.values.get(PUBLIC_SNAPSHOT_KEY)!).version, 1);
  });

  it("PERF-03: a matching If-None-Match gets a 304 with no body, and a different tag gets the page", async () => {
    const store = storeFor(h, new FakeKv());
    const path = "/api/v1/events?limit=4";
    const first = await snapshotRead(h, store, "list", request(path));
    const etag = first.headers.get("etag");
    assert.ok(etag);
    await first.text();

    const notModified = await snapshotRead(h, store, "list", request(path, { "if-none-match": etag }));
    assert.equal(notModified.status, 304);
    assert.equal(await notModified.text(), "");
    assert.equal(notModified.headers.get("etag"), etag);
    assert.equal(notModified.headers.get("cache-control"), PUBLIC_READ_CACHE_CONTROL);

    const wildcard = await snapshotRead(h, store, "list", request(path, { "if-none-match": "*" }));
    assert.equal(wildcard.status, 304);

    const other = await snapshotRead(h, store, "list", request(path, { "if-none-match": 'W/"0000000000000000"' }));
    assert.equal(other.status, 200);
    assert.equal(await other.text(), await (await dbRead(h, request(path))).text());
  });

  // PERF-08 cases. They publish nothing and withdraw nothing, so they run before the withdrawal cases below.
  function serverTimingOf(response: Response): string {
    return response.headers.get("server-timing") ?? "";
  }

  it("PERF-08: a list, detail or GeoJSON 200 from the snapshot carries a well-formed Server-Timing, and a 304 keeps it", async () => {
    const store = storeFor(h, new FakeKv());
    const listPath = "/api/v1/events?limit=5";
    const list = await snapshotRead(h, store, "list", request(listPath));
    assert.equal(list.status, 200);
    assert.match(serverTimingOf(list), SERVER_TIMING);
    assert.match(serverTimingOf(list), /^snap;desc="rebuild"/u, "the first read of a cold store builds the snapshot");
    const etag = list.headers.get("etag");
    assert.ok(etag);
    await list.text();

    const detail = await snapshotRead(h, store, "detail", request(`/api/v1/events/${eventIdFor(4)}`));
    assert.equal(detail.status, 200);
    assert.match(serverTimingOf(detail), SERVER_TIMING);
    assert.match(serverTimingOf(detail), /^snap;desc="memo"/u, "a read within the memo TTL is answered from the memo");
    await detail.text();

    const geo = await snapshotRead(h, store, "geojson", request("/api/v1/events.geojson"));
    assert.equal(geo.status, 200);
    assert.match(serverTimingOf(geo), SERVER_TIMING);
    await geo.text();

    const notModified = await snapshotRead(h, store, "list", request(listPath, { "if-none-match": etag }));
    assert.equal(notModified.status, 304);
    assert.match(serverTimingOf(notModified), SERVER_TIMING);
    assert.equal(await notModified.text(), "");
  });

  it("PERF-08: the timing source is rebuild on a cold build, memo within the memo TTL, kv in a new isolate, and kv past 60 s with no check", async () => {
    const kv = new FakeKv();
    const first = storeFor(h, kv);
    const built = newPublicSnapshotTiming();
    assert.ok(await first.read({ timing: built }));
    assert.equal(built.source, "rebuild");
    assert.ok(Number.isFinite(built.dbMs) && built.dbMs >= 0, "the database stage is a non-negative duration");
    assert.ok(Number.isFinite(built.buildMs) && built.buildMs >= 0, "the build stage is a non-negative duration");

    const memoTiming = newPublicSnapshotTiming();
    const beforeMemo = h.counter.queries;
    assert.ok(await first.read({ timing: memoTiming }));
    assert.equal(memoTiming.source, "memo");
    assert.equal(memoTiming.kvMs, 0, "a memo read does not touch KV");
    assert.equal(memoTiming.dbMs, 0, "a memo read issues no statement");
    assert.equal(h.counter.queries, beforeMemo);

    // A new isolate has no memo. Its KV snapshot is fresh, so it is served with no statement.
    const second = storeFor(h, kv);
    const kvTiming = newPublicSnapshotTiming();
    const beforeKv = h.counter.queries;
    assert.ok(await second.read({ timing: kvTiming }));
    assert.equal(kvTiming.source, "kv");
    assert.equal(kvTiming.dbMs, 0);
    assert.equal(h.counter.queries, beforeKv, "a fresh KV snapshot is served with no statement");

    // PERF-06: 61 s is inside the 5 min bound, so the read is served from KV with no statement and no background check.
    h.clock.at += 61_000;
    const olderTiming = newPublicSnapshotTiming();
    const beforeOlder = h.counter.queries;
    const pending: Promise<unknown>[] = [];
    assert.ok(await second.read({ timing: olderTiming, waitUntil: (promise) => pending.push(promise) }));
    assert.equal(olderTiming.source, "kv");
    assert.equal(h.counter.queries - beforeOlder, 0, "no statement on the request path past 60 s");
    assert.equal(pending.length, 0, "no background check inside the 5 min bound");
  });

  it("PERF-08: a stale KV snapshot is served at once, and the background check rebuilds it, so the next read is the new content", async () => {
    const kv = new FakeKv();
    assert.ok(await storeFor(h, kv).read());
    // Stored content with a fingerprint the database does not produce, as after a change the store has not seen yet.
    const stored = JSON.parse(kv.values.get(PUBLIC_SNAPSHOT_KEY)!) as Record<string, unknown>;
    kv.values.set(PUBLIC_SNAPSHOT_KEY, JSON.stringify({ ...stored, fingerprint: "0:stale" }));

    const gated = gatedStore(h, kv);
    const store = gated.store;
    h.clock.at += STALE_AFTER_MS + 1_000;
    const putsBefore = kv.putKeys.length;
    const timing = newPublicSnapshotTiming();
    const pending: Promise<unknown>[] = [];
    const beforeServe = h.counter.queries;
    // The database is held: the read must answer while the background check is still waiting for it.
    gated.hold();
    const served = await store.read({ timing, waitUntil: (promise) => pending.push(promise) });
    assert.ok(served);
    assert.equal(timing.source, "kv", "the stale copy is served, not rebuilt, on the request path");
    assert.equal(served.fingerprint, "0:stale");
    assert.equal(h.counter.queries - beforeServe, 0, "no database statement before the response");
    assert.equal(pending.length, 1, "one background check is handed to waitUntil");

    gated.release();
    await Promise.all(pending);
    const after = await store.read();
    assert.ok(after);
    assert.notEqual(after.fingerprint, "0:stale", "the background check rebuilt the snapshot");
    assert.equal(kv.putKeys.length, putsBefore + 2, "the background rebuild writes the snapshot and its verified time");
  });

  it("PERF-08: error responses and DB-served answers carry no Server-Timing, and a snapshot answer names no SQL, key or id", async () => {
    const store = storeFor(h, new FakeKv());
    const missing = await snapshotRead(h, store, "detail", request("/api/v1/events/inc-perf03-missing"));
    assert.equal(missing.status, 404);
    assert.equal(missing.headers.get("server-timing"), null);
    await missing.text();

    const filtered = await snapshotRead(h, store, "list", request("/api/v1/events?category=disasters_weather&limit=5"));
    assert.equal(filtered.status, 200);
    assert.equal(filtered.headers.get("server-timing"), null, "a filtered list is a DB answer, not a snapshot answer");
    await filtered.text();

    // A KV failure answers from the DB path, so it is not a snapshot answer either.
    const fallback = await snapshotRead(h, storeFor(h, new BrokenKv()), "list", request("/api/v1/events?limit=3"));
    assert.equal(fallback.status, 200);
    assert.equal(fallback.headers.get("server-timing"), null);
    await fallback.text();

    const served = await snapshotRead(h, store, "detail", request(`/api/v1/events/${eventIdFor(7)}`));
    const header = serverTimingOf(served);
    assert.match(header, SERVER_TIMING);
    assert.equal(header.includes(":"), false, "no colon, so no SQL text and no URL");
    assert.equal(header.includes("inc-perf03"), false, "no event id");
    assert.equal(/select|waspada|postgres|public-snapshot/iu.test(header), false, "no SQL, schema or key name");
  });

  it("PERF-08: the Server-Timing value has the fixed shape, rounds each duration to one decimal, and maps a bad number to 0", () => {
    const timing = { source: "kv" as const, kvMs: 3.24, dbMs: 0, buildMs: Number.NaN };
    assert.equal(
      snapshotServerTiming(timing, 5.06),
      'snap;desc="kv", kv;dur=3.2, db;dur=0, build;dur=0, total;dur=5.1',
    );
  });

  it("PERF-03: the route is selected only for a live GET of one of the three reads, with the binding and a database", () => {
    const binding = new FakeKv();
    const select = (overrides: Partial<Parameters<typeof publicSnapshotRouteFor>[0]>) => publicSnapshotRouteFor({
      method: "GET",
      pathname: "/api/v1/events",
      datasetMode: "live",
      snapshotBinding: binding,
      databaseConfigured: true,
      ...overrides,
    });
    assert.equal(select({}), "list");
    assert.equal(select({ pathname: "/api/v1/events.geojson" }), "geojson");
    assert.equal(select({ pathname: "/api/v1/events/inc-perf03-01" }), "detail");

    // Without the binding (local dev, demo, tests) nothing changes: the route is not selected.
    assert.equal(select({ snapshotBinding: undefined }), null);
    assert.equal(select({ datasetMode: "demo" }), null);
    assert.equal(select({ databaseConfigured: false }), null);
    // The database check runs only for one of the three snapshot routes, so /context never reads the binding.
    let checks = 0;
    assert.equal(select({ pathname: "/api/v1/context", databaseConfigured: () => { checks += 1; return true; } }), null);
    assert.equal(checks, 0);
    assert.equal(select({ databaseConfigured: () => { checks += 1; return true; } }), "list");
    assert.equal(checks, 1);
    assert.equal(select({ method: "POST" }), null);
    assert.equal(select({ pathname: "/api/v1/events/inc-perf03-01/history" }), null);
    assert.equal(select({ pathname: "/api/v1/context" }), null);
    assert.equal(select({ pathname: "/api/v1/updates" }), null);
  });

  it("PERF-03: without the binding the DB path keeps no-store and adds no ETag", async () => {
    const response = await dbRead(h, request("/api/v1/events?limit=3"));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("etag"), null);
  });

  /** Withdraws one fixture event through the moderator path, the call the Worker's withdrawal hook makes. */
  async function withdrawFixtureEvent(index: number): Promise<void> {
    const outcome = await withdrawPublishedEvent({
      executor: h.database.executor,
      datasetKind: "live",
      checkPublicDisplay: async (sourceId: string) => SOURCE_IDS.has(sourceId),
    }, {
      eventId: eventIdFor(index),
      actorId: "moderator-perf03",
      reasonCategory: "source_retracted",
      reason: "fixture withdrawal",
    });
    assert.equal(outcome.status, "withdrawn", eventIdFor(index));
  }

  it("PERF-03: the batch detail read gives each event the result of its single read, and a missing id is missing", async () => {
    const ids = [...Array.from({ length: PUBLISHED_EVENT_COUNT }, (_, index) => eventIdFor(index)), "inc-perf03-missing"];
    // The same factory the snapshot build uses, over the counting executor. Its read is the single-event path.
    const executor = countingExecutor(h.database, h.counter);
    const batchService = createPublicEventDetailProjectionService({
      snapshots: createPublicEventSnapshotRepository(executor),
      lookups: createPublicProjectionLookupRepository(executor),
      geometries: createPublicEventGeometriesRepository(executor),
    });
    const batch = await batchService.readMany(ids);
    assert.equal(batch.length, ids.length);
    for (const [index, eventId] of ids.entries()) {
      const outcome = batch[index]!;
      assert.ok("value" in outcome, `${eventId} is projected without an error`);
      assert.deepEqual(outcome.value, await batchService.read(eventId), `${eventId} equals its single read`);
    }
    const missingOutcome = batch.at(-1);
    assert.ok(missingOutcome !== undefined && "value" in missingOutcome, "the unknown id has a result, not an error");
    assert.equal(missingOutcome.value.kind, "missing");
  });

  it("PERF-03: an unchanged fingerprint is verified in the background: one fingerprint statement, no rebuild, and only the verified time is written", async () => {
    const kv = new FakeKv();
    const store = storeFor(h, kv);
    const built = await store.read();
    assert.ok(built, "the first read builds the snapshot");
    const putsBefore = kv.putKeys.length;

    // Inside the 5 min bound nothing runs: no statement on the request path, no check, no write.
    const beforeInside = h.counter.queries;
    h.clock.at += 61_000;
    const inside = await store.read();
    assert.equal(h.counter.queries - beforeInside, 0, "no statement inside the staleness bound");
    assert.equal(inside?.built_at, built.built_at, "no rebuild: built_at is unchanged");
    assert.equal(kv.putKeys.length, putsBefore, "no KV write inside the bound");

    // Past the bound the snapshot is served at once and one fingerprint check runs after the response.
    const pending: Promise<unknown>[] = [];
    const beforeBackground = h.counter.queries;
    h.clock.at += STALE_AFTER_MS;
    // A fresh isolate, with the database held: the snapshot is served before the background check can reach it.
    const gated = gatedStore(h, kv);
    gated.hold();
    const served = await gated.store.read({ waitUntil: (promise) => pending.push(promise) });
    assert.ok(served, "the snapshot is served while the background check runs");
    assert.equal(h.counter.queries - beforeBackground, 0, "no database statement before the response");
    assert.equal(pending.length, 1, "the background check is handed to waitUntil");
    gated.release();
    await Promise.all(pending);
    assert.equal(h.counter.queries - beforeBackground, 1, "the background check reads only the fingerprint");
    assert.equal(kv.putKeys.at(-1), PUBLIC_SNAPSHOT_VERIFIED_KEY, "a matching check writes the verified time, not the snapshot");
    assert.equal(kv.putKeys.length, putsBefore + 1, "one KV write: the verified time");
  });

  it("PERF-03: a freshness change moves the fingerprint, so the next check rebuilds and the served page equals the DB path", async () => {
    const kv = new FakeKv();
    const store = storeFor(h, kv);
    const built = await store.read();
    assert.ok(built);
    const listPath = "/api/v1/events?limit=20";
    const beforeServed = await (await snapshotRead(h, store, "list", request(listPath))).text();

    const eventId = eventIdFor(5);
    const [current] = (await h.database.executor.query<{ readonly version: number; readonly trace_id: string; readonly status: string }>(
      "SELECT version, record_json->>'trace_id' AS trace_id, freshness_status AS status FROM waspada.public_event_versions WHERE dataset_kind = 'live' AND event_id = $1",
      [eventId],
    )).rows;
    assert.ok(current, "the fixture event is published");
    const ledger = createSqlFreshnessTransitionLedger(h.database.executor);
    const appended = await ledger.append({
      datasetKind: "live",
      eventId,
      eventVersion: current.version,
      target: { kind: "event_claim_set" },
      expectedSequence: 1,
      previousStatus: current.status as "current" | "needs_update" | "expired",
      resultingStatus: "needs_update",
      reason: "review_deadline_missed",
      evaluatedAt: "2026-11-23T00:00:00Z",
      traceId: current.trace_id,
      idempotencyKey: `perf03:freshness:${eventId}`,
      evidenceReferenceIds: [],
    });
    assert.equal(appended.outcome, "written");

    // PERF-06: no push here, so the change is picked up by the background check once the snapshot is past the bound.
    h.clock.at += STALE_AFTER_MS + 1_000;
    const pending: Promise<unknown>[] = [];
    await store.read({ waitUntil: (promise) => pending.push(promise) });
    await Promise.all(pending);
    const after = await store.read();
    assert.ok(after);
    assert.notEqual(after.fingerprint, built.fingerprint, "the freshness change moved the fingerprint");
    const afterServed = await (await snapshotRead(h, store, "list", request(listPath))).text();
    assert.equal(afterServed, await (await dbRead(h, request(listPath))).text(), "the served page equals the DB path");
    assert.notEqual(afterServed, beforeServed, "the served page shows the new freshness");
  });

  it("PERF-03: a withdrawal moves the fingerprint, so the next check rebuilds, and a forced refresh always rebuilds", async () => {
    const kv = new FakeKv();
    const store = storeFor(h, kv);
    const built = await store.read();
    assert.ok(built);
    const putsBefore = kv.putKeys.length;

    const withdrawn = eventIdFor(3);
    await withdrawFixtureEvent(3);

    h.clock.at += STALE_AFTER_MS + 1_000;
    const pending: Promise<unknown>[] = [];
    await store.read({ waitUntil: (promise) => pending.push(promise) });
    await Promise.all(pending);
    const after = await store.read();
    assert.ok(after);
    assert.notEqual(after.fingerprint, built.fingerprint, "the withdrawal moved the fingerprint");
    assert.deepEqual(kv.putKeys.slice(putsBefore), [PUBLIC_SNAPSHOT_KEY, PUBLIC_SNAPSHOT_VERIFIED_KEY], "the background rebuild writes the snapshot, then its verified time");

    const path = "/api/v1/events?limit=20";
    const served = await (await snapshotRead(h, store, "list", request(path))).text();
    assert.equal(served, await (await dbRead(h, request(path))).text());
    const listed = (JSON.parse(served) as EventPage).data.map((event) => event.event_id);
    assert.equal(listed.includes(withdrawn), false);
    assert.equal(listed.length, PUBLISHED_EVENT_COUNT - 1, "one of the twenty is withdrawn; the freshness case withdraws none");

    // The moderator, auto-publish and refresh hooks call refresh(): a full rebuild even when nothing changed.
    const beforeForced = h.counter.queries;
    await store.refresh();
    assert.ok(h.counter.queries - beforeForced > 1, "a forced refresh runs the full build, not only the fingerprint");
    assert.equal(kv.putKeys.length, putsBefore + 4, "a forced refresh writes the snapshot and its verified time");
  });

  // PERF-06 cases. They read the published events and withdraw nothing, so they run before the final case.
  function pushTo(pending: Promise<unknown>[]): (promise: Promise<unknown>) => void {
    return (promise) => {
      pending.push(promise);
    };
  }

  it("PERF-06: a fresh isolate serves a KV snapshot with no statement when its verified time is recent, though built_at is 10 min old", async () => {
    const kv = new FakeKv();
    const built = await storeFor(h, kv).read();
    assert.ok(built);
    h.clock.at += 600_000;
    kv.values.set(PUBLIC_SNAPSHOT_VERIFIED_KEY, new Date(h.clock.at - 5_000).toISOString());

    const pending: Promise<unknown>[] = [];
    const timing = newPublicSnapshotTiming();
    const before = h.counter.queries;
    const served = await storeFor(h, kv).read({ timing, waitUntil: pushTo(pending) });
    assert.ok(served);
    assert.equal(served.built_at, built.built_at, "the KV content is served");
    assert.equal(timing.source, "kv");
    assert.equal(h.counter.queries - before, 0, "no statement on the request path");
    assert.equal(pending.length, 0, "the verified time is 5 s old, so no background check starts");
  });

  it("PERF-06: a fresh isolate with both times older than 5 min serves at once with no synchronous statement, then one background check writes the verified time", async () => {
    const kv = new FakeKv();
    assert.ok(await storeFor(h, kv).read());
    const writesBefore = kv.putKeys.length;
    h.clock.at += 600_000;

    const pending: Promise<unknown>[] = [];
    const timing = newPublicSnapshotTiming();
    const before = h.counter.queries;
    const gated = gatedStore(h, kv);
    gated.hold();
    const served = await gated.store.read({ timing, waitUntil: pushTo(pending) });
    assert.ok(served);
    assert.equal(timing.source, "kv");
    assert.equal(h.counter.queries - before, 0, "the request path issues no statement");
    assert.equal(pending.length, 1, "exactly one background check is handed to waitUntil");

    gated.release();
    await Promise.all(pending);
    assert.equal(h.counter.queries - before, 1, "the background check reads only the fingerprint");
    assert.equal(kv.values.get(PUBLIC_SNAPSHOT_VERIFIED_KEY), new Date(h.clock.at).toISOString(), "the verified time is now");
    assert.deepEqual(kv.putKeys.slice(writesBefore), [PUBLIC_SNAPSHOT_VERIFIED_KEY], "only the verified time is written");
  });

  it("PERF-06: two reads inside the window start one background check, and a read after that check starts none", async () => {
    const kv = new FakeKv();
    assert.ok(await storeFor(h, kv).read());
    h.clock.at += 600_000;

    const store = storeFor(h, kv);
    const pending: Promise<unknown>[] = [];
    const before = h.counter.queries;
    assert.ok(await store.read({ waitUntil: pushTo(pending) }));
    assert.ok(await store.read({ waitUntil: pushTo(pending) }));
    assert.equal(pending.length, 1, "the second read in the window does not start another check");

    await Promise.all(pending);
    assert.equal(h.counter.queries - before, 1, "one fingerprint statement for both reads");
    assert.ok(await store.read({ waitUntil: pushTo(pending) }));
    assert.equal(pending.length, 1, "the check just confirmed the content, so the next read starts none");
  });

  it("PERF-06: a KV miss still builds synchronously, so the first read of an empty KV answers with the rebuilt snapshot", async () => {
    const timing = newPublicSnapshotTiming();
    const before = h.counter.queries;
    const built = await storeFor(h, new FakeKv()).read({ timing });
    assert.ok(built);
    assert.equal(timing.source, "rebuild");
    assert.ok(h.counter.queries - before > 1, "the miss runs the full build on the request path");
  });

  it("PERF-06: the refresh route is inert without SNAPSHOT_REFRESH_KEY, rejects a missing or wrong bearer key, and accepts the right one with 202", async () => {
    const kv = new FakeKv();
    const key = "snapshot-refresh-test-secret-000000000000";
    const route = "https://waspada.example.invalid/api/v1/internal/public-snapshot/refresh";
    const envWith = (extra: Record<string, unknown>): WorkerEnvironment => ({
      DATASET_MODE: "live",
      SQL_EXECUTOR: h.database.executor,
      PUBLIC_SNAPSHOT: kv,
      ...extra,
    }) as unknown as WorkerEnvironment;
    const post = (authorization: string | null): Request => new Request(route, {
      method: "POST",
      headers: authorization === null ? {} : { authorization },
    });
    const ctxWith = (pending: Promise<unknown>[]) => ({ waitUntil: pushTo(pending) });

    const putsBefore = kv.putKeys.length;
    const unset = await worker.fetch(post(`Bearer ${key}`), envWith({}), ctxWith([]));
    assert.equal(unset.status, 404, "without the secret the route does not exist");
    await unset.text();

    const missing = await worker.fetch(post(null), envWith({ SNAPSHOT_REFRESH_KEY: key }), ctxWith([]));
    assert.equal(missing.status, 401);
    const wrong = await worker.fetch(post("Bearer snapshot-refresh-test-secret-00000000000x"), envWith({ SNAPSHOT_REFRESH_KEY: key }), ctxWith([]));
    assert.equal(wrong.status, 401);
    const wrongText = await wrong.text();
    assert.deepEqual(JSON.parse(wrongText), { ok: false, code: "UNAUTHORIZED", error: "UNAUTHORIZED" });
    assert.equal(kv.putKeys.length, putsBefore, "no refresh runs for a rejected request");

    const pending: Promise<unknown>[] = [];
    const accepted = await worker.fetch(post(`Bearer ${key}`), envWith({ SNAPSHOT_REFRESH_KEY: key }), ctxWith(pending));
    assert.equal(accepted.status, 202);
    const acceptedText = await accepted.text();
    assert.equal(acceptedText, '{"status":"accepted"}');
    assert.equal(acceptedText.includes(key), false, "the key is never echoed");
    assert.equal(pending.length, 1, "the refresh is handed to waitUntil");
    await Promise.all(pending);
    assert.ok(kv.putKeys.includes(PUBLIC_SNAPSHOT_KEY), "the refresh rebuilt and wrote the snapshot");

    const unbound = await worker.fetch(post(`Bearer ${key}`), envWith({ SNAPSHOT_REFRESH_KEY: key, PUBLIC_SNAPSHOT: undefined }), ctxWith([]));
    assert.equal(unbound.status, 503, "without the KV binding the route answers 503");
    await unbound.text();
  });

  it("PERF-06: with a Cache API the second read of an identical snapshot answer is an edge hit, a conditional read gets 304, and without one no edge part appears", async () => {
    const copies = new Map<string, Response>();
    let puts = 0;
    let matches = 0;
    const cache = {
      async match(req: Request): Promise<Response | undefined> {
        matches += 1;
        return copies.get(req.url)?.clone();
      },
      async put(req: Request, res: Response): Promise<void> {
        puts += 1;
        copies.set(req.url, res.clone());
      },
    };
    const holder = globalThis as unknown as { caches?: unknown };
    const previous = holder.caches;
    holder.caches = { default: cache };
    try {
      const store = storeFor(h, new FakeKv());
      const listPath = "/api/v1/events?limit=5";
      const pending: Promise<unknown>[] = [];
      const first = await snapshotRead(h, store, "list", request(listPath), pushTo(pending));
      const firstBody = await first.text();
      assert.match(serverTimingOf(first), /, edge;desc="miss"$/u, "the first answer is an edge miss");
      await Promise.all(pending);
      assert.equal(puts, 1, "the miss stores one copy");

      const second = await snapshotRead(h, store, "list", request(listPath), pushTo(pending));
      assert.match(serverTimingOf(second), /, edge;desc="hit"$/u, "the second answer is an edge hit");
      assert.equal(await second.text(), firstBody, "the edge copy equals the built body");
      assert.equal(second.headers.get("etag"), first.headers.get("etag"));
      assert.equal(second.headers.get("cache-control"), PUBLIC_READ_CACHE_CONTROL);
      assert.ok(matches >= 2);

      const etag = first.headers.get("etag")!;
      const conditional = await snapshotRead(h, store, "list", request(listPath, { "if-none-match": etag }), pushTo(pending));
      assert.equal(conditional.status, 304);
      assert.match(serverTimingOf(conditional), /, edge;desc="hit"$/u);
      await conditional.text();
    } finally {
      holder.caches = previous;
    }

    const plain = await snapshotRead(h, storeFor(h, new FakeKv()), "list", request("/api/v1/events?limit=5"));
    assert.equal(serverTimingOf(plain).includes("edge"), false, "without caches.default the header has no edge part");
    await plain.text();
  });

  // This case withdraws events, so it runs last: the cases above read the published events.
  it("PERF-03: a rebuild costs the same number of statements for 3 events and for 12", async (t: TestContext) => {
    const store = storeFor(h, new FakeKv());
    const rebuildCost = async (expectedEvents: number): Promise<number> => {
      const before = h.counter.queries;
      const snapshot = await store.refresh();
      assert.ok(snapshot, "the forced rebuild succeeds");
      assert.equal(snapshot.events.length, expectedEvents);
      return h.counter.queries - before;
    };
    // 19 are published before this case (3 withdrawn above). Withdrawing 7 more leaves 12.
    for (const index of [10, 11, 12, 13, 14, 15, 16]) await withdrawFixtureEvent(index);
    const twelve = await rebuildCost(12);
    for (const index of [4, 5, 6, 7, 8, 9, 17, 18, 19]) await withdrawFixtureEvent(index);
    const three = await rebuildCost(3);
    t.diagnostic(`PERF-03 SQL statements for one full rebuild: 12 events ${twelve}, 3 events ${three}`);
    assert.equal(three, twelve, "a rebuild costs the same number of statements for 3 events and for 12");
  });
});
