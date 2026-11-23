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
  PUBLIC_SNAPSHOT_KEY,
  type PublicSnapshotKvNamespace,
  type PublicSnapshotStore,
} from "../src/runtime/public-snapshot.js";
import {
  publicSnapshotRouteFor,
  PUBLIC_READ_CACHE_CONTROL,
  readPublicSnapshotRoute,
  type PublicSnapshotRouteKind,
} from "../src/runtime/public-snapshot-route.js";

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
    assert.deepEqual(kv.putKeys, [PUBLIC_SNAPSHOT_KEY]);
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

  it("PERF-03: an unchanged fingerprint costs one statement, no rebuild and no KV write", async () => {
    const kv = new FakeKv();
    const store = storeFor(h, kv);
    const built = await store.read();
    assert.ok(built, "the first read builds the snapshot");
    const putsBefore = kv.putKeys.length;

    const beforeCheck = h.counter.queries;
    h.clock.at += 61_000;
    const checked = await store.read();
    assert.equal(h.counter.queries - beforeCheck, 1, "the 60 s check reads only the fingerprint");
    assert.equal(checked?.built_at, built.built_at, "no rebuild: built_at is unchanged");
    assert.equal(kv.putKeys.length, putsBefore, "no KV write");

    const pending: Promise<unknown>[] = [];
    const beforeBackground = h.counter.queries;
    h.clock.at += 31_000;
    const served = await store.read({ waitUntil: (promise) => pending.push(promise) });
    assert.ok(served, "the snapshot is served while the 30 s check runs");
    assert.equal(pending.length, 1, "the 30 s check is handed to waitUntil");
    await Promise.all(pending);
    assert.equal(h.counter.queries - beforeBackground, 1, "the 30 s check reads only the fingerprint");
    assert.equal(kv.putKeys.length, putsBefore, "still no KV write");
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

    h.clock.at += 61_000;
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

    h.clock.at += 61_000;
    const after = await store.read();
    assert.ok(after);
    assert.notEqual(after.fingerprint, built.fingerprint, "the withdrawal moved the fingerprint");
    assert.equal(kv.putKeys.length, putsBefore + 1, "the rebuild writes the snapshot once");

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
    assert.equal(kv.putKeys.length, putsBefore + 2, "a forced refresh writes KV");
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
