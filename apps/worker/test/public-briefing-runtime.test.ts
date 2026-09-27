import assert from "node:assert/strict";
import test from "node:test";
import type { SqlExecutor } from "../../db/src/sql.js";
import type { BriefingRequest } from "../src/contracts/public-api.js";
import { handlePublicApiRequest, type WorkerEnvironment } from "../src/layers/l4-application-integration/api.js";
import type { TelemetryRecord } from "../src/layers/l5-evaluation-monitoring/telemetry.js";
import {
  createPublicBriefingRuntime,
  PublicBriefingRuntimeError,
  type PublicBriefingSqlExecutorRunner,
  type PublicBriefingRuntime,
} from "../src/runtime/public-briefing-runtime.js";

const testConnectionString = "postgresql://test-user:test-password@hyperdrive.example.invalid/waspada?sslmode=require";
const generatedAt = "2026-09-27T03:00:00.000Z";
const privateMarker = "SYNTHETIC_PRIVATE_BRIEFING_RUNTIME_MARKER";
const bodyLimit = 256 * 1024;

function makeRequest(overrides: Partial<BriefingRequest["interests"]> = {}): BriefingRequest {
  return {
    interests: {
      places: [],
      services: [],
      institutions: [],
      audiences: [],
      categories: [],
      ...overrides,
    },
  };
}

interface Fixture {
  readonly eventId: string;
  readonly version: number;
  readonly eventRecord: Record<string, unknown>;
  readonly candidateRow: Record<string, unknown>;
  readonly snapshotRow: Record<string, unknown>;
  readonly scopeIds: readonly string[];
  readonly support: {
    readonly report_revision_id: string;
    readonly permitted_text_hash: string;
    readonly span_start: number;
    readonly span_end: number;
    readonly offset_unit: "unicode_code_points";
    readonly relation: "supports";
  };
}

function makeFixture(
  eventId: string,
  options: {
    readonly version?: number;
    readonly category?: string;
    readonly firstPublishedAt?: string;
    readonly scopeIds?: readonly string[];
  } = {},
): Fixture {
  const version = options.version ?? 3;
  const support = {
    report_revision_id: "revision-" + eventId,
    permitted_text_hash: "a".repeat(64),
    span_start: 1,
    span_end: 20,
    offset_unit: "unicode_code_points" as const,
    relation: "supports" as const,
  };
  const scopeIds = options.scopeIds ?? ["place-" + eventId];
  const scope = {
    place_ids: [...scopeIds],
    service_ids: [],
    institution_ids: [],
    audience_ids: [],
    geometry_ids: [],
    private_scope_marker: privateMarker,
  };
  const eventRecord: Record<string, unknown> = {
    schema_version: "2.0",
    trace_id: "trace-private-" + eventId,
    record_type: "Event",
    dataset_kind: "live",
    event_id: eventId,
    version,
    supersedes_version: version === 1 ? null : version - 1,
    title: "Pemberitahuan fiktif " + eventId,
    summary: "Keterangan fiktif untuk pengujian briefing.",
    category: options.category ?? "crime_personal_security",
    tags: [],
    lifecycle: "ongoing",
    freshness: {
      status: "current",
      evaluated_at: "2026-09-27T02:55:00Z",
      review_due_at: null,
      basis: "manual_review",
    },
    event_time: { start: "2026-09-27", end: null, precision: "date" },
    validity: { valid_from: null, valid_until: null },
    scope,
    claims: [{
      claim_id: "claim-" + eventId,
      text: "Klaim fiktif yang didukung sumber uji.",
      event_time: { start: null, end: null, precision: "unknown" },
      validity: { valid_from: null, valid_until: null },
      scope,
      qualifiers: [],
      support: [support],
      contradictions: [],
      context_evidence: [],
      origin_ids: ["private-origin-" + eventId],
      evidence_label: "attributed_report",
      private_claim_marker: privateMarker,
    }],
    impact_refs: [],
    publication_status: "published",
    withdrawal_reason: null,
    publication_decision_id: "private-decision-" + eventId,
    published_at: "2026-09-25T03:00:00Z",
    withdrawn_at: null,
    private_event_marker: privateMarker,
  };
  const snapshotRow = {
    dataset_kind: "live",
    event_id: eventId,
    version,
    record_json: eventRecord,
  };
  const candidateRow = {
    dataset_kind: "live",
    event_id: eventId,
    version,
    first_published_at: options.firstPublishedAt ?? "2026-09-25T03:00:00.000000Z",
  };
  return { eventId, version, eventRecord, candidateRow, snapshotRow, scopeIds, support };
}

interface HarnessOptions {
  readonly candidateRows?: readonly Record<string, unknown>[];
  readonly omitSnapshots?: readonly string[];
  readonly snapshotDelayMs?: Readonly<Record<string, number>>;
}

function makeRuntime(fixtures: readonly Fixture[], options: HarnessOptions = {}) {
  let operations = 0;
  let insideOperation = false;
  let transactionOpen = false;
  let snapshotReadsCompleted = 0;
  let snapshotReadsCompletedAtRollback = -1;
  let readsOutsideTransaction = 0;
  const statements: string[] = [];
  const fixtureById = new Map(fixtures.map((fixture) => [fixture.eventId, fixture]));
  const scopeNameById = new Map<string, string>();
  for (const fixture of fixtures) {
    for (const id of fixture.scopeIds) scopeNameById.set(id, id);
  }

  const executor: SqlExecutor = {
    async query<Row extends object>(statement: string, parameters: readonly unknown[] = []) {
      if (statement !== "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY"
        && statement !== "COMMIT"
        && statement !== "ROLLBACK"
        && !transactionOpen) readsOutsideTransaction += 1;
      assert.equal(insideOperation, true, "all SQL must use the request-scoped executor");
      statements.push(statement);
      let rows: readonly object[];
      if (statement === "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY") {
        assert.equal(transactionOpen, false);
        transactionOpen = true;
        rows = [];
      } else if (statement === "COMMIT") {
        assert.equal(transactionOpen, true);
        transactionOpen = false;
        rows = [];
      } else if (statement === "ROLLBACK") {
        snapshotReadsCompletedAtRollback = snapshotReadsCompleted;
        transactionOpen = false;
        rows = [];
      } else if (statement.includes("WITH trim_characters AS")) {
        rows = options.candidateRows ?? fixtures.map(({ candidateRow }) => candidateRow);
      } else if (statement.includes("FROM waspada.public_event_versions AS event")) {
        const eventId = String(parameters[0]);
        const delayMs = options.snapshotDelayMs?.[eventId] ?? 0;
        if (delayMs > 0) await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
        const fixture = fixtureById.get(eventId);
        snapshotReadsCompleted += 1;

        rows = fixture !== undefined && !options.omitSnapshots?.includes(eventId)
          ? [fixture.snapshotRow]
          : [];
      } else if (statement.includes("FROM waspada.public_event_impacts AS impact")) {
        rows = [];
      } else if (statement.includes("FROM waspada.public_scope_names AS names")) {
        const entityTypes = parameters[0] as readonly string[];
        const entityIds = parameters[1] as readonly string[];
        rows = entityIds.map((id, index) => ({
          entity_type: entityTypes[index],
          id,
          display_name: scopeNameById.get(id) ?? id,
        }));
      } else if (statement.includes("FROM waspada.public_source_attributions AS attribution")) {
        const revisionIds = parameters[0] as readonly string[];
        const hashes = parameters[1] as readonly string[];
        const starts = parameters[2] as readonly number[];
        const ends = parameters[3] as readonly number[];
        rows = revisionIds.map((reportRevisionId, index) => ({
          dataset_kind: "live",
          report_revision_id: reportRevisionId,
          permitted_text_hash: hashes[index],
          span_start: starts[index],
          span_end: ends[index],
          offset_unit: "unicode_code_points",
          relation: "supports",
          public_use_approved: true,
          display_name: "Sumber fiktif",
          url: "https://source.example.invalid/" + reportRevisionId,
          published_at: "2026-09-25T02:50:00Z",
          observed_at: null,
          excerpt_public_use_approved: false,
          excerpt: null,
        }));
      } else {
        assert.fail("Unexpected SQL in briefing runtime test: " + statement);
      }
      return { rows: rows as readonly Row[] };
    },
    async execute() {
      assert.fail("The public briefing runtime must not execute write statements.");
    },
  };

  const withSqlExecutor: PublicBriefingSqlExecutorRunner = async (connectionString, operation) => {
    operations += 1;
    assert.equal(connectionString, testConnectionString);
    assert.equal(insideOperation, false);
    insideOperation = true;
    try {
      return await operation(executor);
    } finally {
      insideOperation = false;
    }
  };

  const runtime = createPublicBriefingRuntime({
    datasetMode: "live",
    connectionString: testConnectionString,
  }, {
    withSqlExecutor,
    now: () => Date.parse(generatedAt),
  });
  assert.ok(runtime);
  return {
    runtime,
    statements,
    get operations() { return operations; },
    get transactionOpen() { return transactionOpen; },
    get snapshotReadsCompletedAtRollback() { return snapshotReadsCompletedAtRollback; },
    get readsOutsideTransaction() { return readsOutsideTransaction; },
  };
}

function assertReadFailed(value: Promise<unknown>): Promise<void> {
  return assert.rejects(value, (error: unknown) =>
    error instanceof PublicBriefingRuntimeError
    && error.code === "READ_FAILED"
    && error.message === "The public briefing could not be completed.");
}

function postRequest(
  body: string | Uint8Array,
  headers: HeadersInit = { "content-type": "application/json" },
  path = "/api/v1/briefings",
): Request {
  return new Request("http://localhost" + path, {
    method: "POST",
    headers,
    body: body as BodyInit,
  });
}

function streamingPostRequest(chunks: readonly Uint8Array[], headers: HeadersInit = {}) {
  let index = 0;
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[index];
      if (chunk === undefined) {
        controller.close();
      } else {
        index += 1;
        controller.enqueue(chunk);
      }
    },
    cancel() {
      cancelled = true;
    },
  });
  const request = new Request("http://localhost/api/v1/briefings", {
    method: "POST",
    headers: new Headers({ "content-type": "application/json", ...Object.fromEntries(new Headers(headers)) }),
    body: stream,
    duplex: "half",
  } as RequestInit & { duplex: "half" });
  return {
    request,
    get cancelled() { return cancelled; },
  };
}

async function callApi(
  request: Request,
  runtime: PublicBriefingRuntime | undefined,
  telemetry?: { record(record: TelemetryRecord): void },
  env: WorkerEnvironment = { DATASET_MODE: "live" },
): Promise<Response> {
  return handlePublicApiRequest(request, env, telemetry, undefined, undefined, undefined, undefined, runtime);
}

test("the runtime factory requires exact live mode and a valid Hyperdrive connection without opening SQL", () => {
  const withSqlExecutor: PublicBriefingSqlExecutorRunner = async () => {
    assert.fail("The runtime factory must not open SQL.");
  };
  for (const datasetMode of ["demo", "historical", "Live", "live ", undefined]) {
    assert.equal(createPublicBriefingRuntime({
      datasetMode,
      connectionString: testConnectionString,
    }, { withSqlExecutor }), undefined);
  }
  for (const connectionString of [
    undefined,
    "",
    "https://database.example.invalid",
    "postgresql://user@database.example.invalid/db",
    "postgresql://user:password@database.example.invalid",
  ]) {
    assert.equal(createPublicBriefingRuntime({
      datasetMode: "live",
      connectionString,
    }, { withSqlExecutor }), undefined);
  }
});

test("empty or whitespace-only interests use the pure projector before any runner or snapshot read", async () => {
  const harness = makeRuntime([]);
  const response = await harness.runtime.read(makeRequest({ places: ["  ", "\t"] }));

  assert.deepEqual(response, { items: [], generated_at: generatedAt });
  assert.equal(harness.operations, 0);
  assert.deepEqual(harness.statements, []);
});

test("closed request validation precedes clock and SQL access", async () => {
  let clockCalls = 0;
  let runnerCalls = 0;
  const runtime = createPublicBriefingRuntime({
    datasetMode: "live",
    connectionString: testConnectionString,
  }, {
    now() {
      clockCalls += 1;
      throw new Error("private clock detail");
    },
    async withSqlExecutor() {
      runnerCalls += 1;
      throw new Error("private SQL detail");
    },
  });
  assert.ok(runtime);

  await assert.rejects(runtime.read({ interests: { places: [], services: [], institutions: [], audiences: [], categories: [], extra: privateMarker } }),
    (error: unknown) => error instanceof PublicBriefingRuntimeError && error.code === "INVALID_REQUEST");
  assert.equal(clockCalls, 0);
  assert.equal(runnerCalls, 0);
});

test("one read-only repeatable-read operation composes candidates, exact snapshots and public lookups", async () => {
  const fixture = makeFixture("event-synthetic-briefing-01", {
    scopeIds: ["place-synthetic-briefing-01"],
  });
  const harness = makeRuntime([fixture]);
  const response = await harness.runtime.read(makeRequest({
    categories: ["crime_personal_security"],
    places: ["place-synthetic-briefing-01"],
  }));

  assert.equal(harness.operations, 1);
  assert.equal(harness.transactionOpen, false);
  assert.equal(harness.statements[0], "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  assert.equal(harness.statements.at(-1), "COMMIT");
  assert.ok(harness.statements.some((statement) => statement.includes("WITH trim_characters AS")));
  assert.ok(harness.statements.some((statement) => statement.includes("FROM waspada.public_event_versions AS event")));
  assert.ok(harness.statements.some((statement) => statement.includes("FROM waspada.public_scope_names AS names")));
  assert.ok(harness.statements.some((statement) => statement.includes("FROM waspada.public_source_attributions AS attribution")));
  assert.ok(harness.statements.every((statement) =>
    statement === "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY"
      || statement === "COMMIT"
      || statement === "ROLLBACK"
      || statement.trimStart().startsWith("WITH ")
      || statement.trimStart().startsWith("SELECT ")));
  assert.equal(response.generated_at, generatedAt);
  assert.deepEqual(response.items.map((item) => item.event.event_id), [fixture.eventId]);
  assert.deepEqual(response.items[0]?.relevance_reasons, [
    "Sesuai kategori yang Anda ikuti",
    "Mencakup tempat yang Anda ikuti",
  ]);
  assert.equal(response.items[0]?.event.version, fixture.version);
  assert.deepEqual(Object.keys(response).sort(), ["generated_at", "items"]);
});

test("concurrent event projections preserve candidate order and require exact current versions", async () => {
  const first = makeFixture("event-synthetic-briefing-first", {
    firstPublishedAt: "2026-09-26T03:00:00.000000Z",
  });
  const second = makeFixture("event-synthetic-briefing-second", {
    firstPublishedAt: "2026-09-25T03:00:00.000000Z",
  });
  const harness = makeRuntime([first, second], {
    snapshotDelayMs: {
      [first.eventId]: 15,
      [second.eventId]: 0,
    },
  });
  const response = await harness.runtime.read(makeRequest({
    categories: ["crime_personal_security"],
  }));

  assert.deepEqual(response.items.map((item) => item.event.event_id), [first.eventId, second.eventId]);
  assert.equal(harness.operations, 1);
  assert.equal(harness.statements.at(-1), "COMMIT");
});

test("a candidate version mismatch fails the whole response and rolls back", async () => {
  const fixture = makeFixture("event-synthetic-briefing-version-mismatch", { version: 4 });
  const candidateRows = [{
    dataset_kind: "live",
    event_id: fixture.eventId,
    version: 3,
    first_published_at: "2026-09-25T03:00:00.000000Z",
  }];
  const harness = makeRuntime([fixture], { candidateRows });

  await assertReadFailed(harness.runtime.read(makeRequest({ categories: ["crime_personal_security"] })));
  assert.equal(harness.operations, 1);
  assert.equal(harness.transactionOpen, false);
  assert.equal(harness.statements.at(-1), "ROLLBACK");
});

test("a stale candidate hidden by latest withdrawal fails closed with no partial briefing", async () => {
  const fixture = makeFixture("event-synthetic-briefing-withdrawn");
  const partial = makeFixture("event-synthetic-briefing-visible");
  const harness = makeRuntime([partial, fixture], {
    candidateRows: [partial.candidateRow, fixture.candidateRow],
    omitSnapshots: [fixture.eventId],
  });

  await assertReadFailed(harness.runtime.read(makeRequest({ categories: ["crime_personal_security"] })));
  assert.equal(harness.statements.at(-1), "ROLLBACK");
});

test("waits for sibling candidate projections to settle before rolling back", async () => {
  const missing = makeFixture("event-synthetic-briefing-missing-snapshot");
  const delayed = makeFixture("event-synthetic-briefing-slow-snapshot");
  const harness = makeRuntime([missing, delayed], {
    omitSnapshots: [missing.eventId],
    snapshotDelayMs: { [delayed.eventId]: 25 },
  });

  await assertReadFailed(harness.runtime.read(makeRequest({ categories: ["crime_personal_security"] })));
  await new Promise<void>((resolve) => setTimeout(resolve, 40));
  assert.equal(harness.snapshotReadsCompletedAtRollback, 2);
  assert.equal(harness.readsOutsideTransaction, 0);
  assert.equal(harness.transactionOpen, false);
});

test("latest-withdrawn events absent from the candidate reader produce no historical item", async () => {
  const harness = makeRuntime([], { candidateRows: [] });
  const response = await harness.runtime.read(makeRequest({
    places: ["place-withdrawn-after-latest-version"],
  }));

  assert.deepEqual(response.items, []);
  assert.ok(harness.statements.every((statement) =>
    !statement.includes("FROM waspada.public_event_versions AS event")));
  assert.equal(harness.statements.at(-1), "COMMIT");
});

test("candidate overflow and invalid ordering fail the whole request", async () => {
  const overflowRows = Array.from({ length: 101 }, (_, index) => ({
    dataset_kind: "live",
    event_id: "event-synthetic-overflow-" + String(index).padStart(3, "0"),
    version: 1,
    first_published_at: "2026-09-25T03:00:00.000000Z",
  }));
  const overflow = makeRuntime([], { candidateRows: overflowRows });
  await assertReadFailed(overflow.runtime.read(makeRequest({ categories: ["crime_personal_security"] })));
  assert.equal(overflow.statements.at(-1), "ROLLBACK");
  assert.ok(!overflow.statements.some((statement) => statement.includes("public_event_versions AS event")));

  const outOfOrderRows = [
    {
      dataset_kind: "live",
      event_id: "event-synthetic-order-z",
      version: 1,
      first_published_at: "2026-09-25T03:00:00.000000Z",
    },
    {
      dataset_kind: "live",
      event_id: "event-synthetic-order-a",
      version: 1,
      first_published_at: "2026-09-25T03:00:00.000000Z",
    },
  ];
  const invalidOrder = makeRuntime([], { candidateRows: outOfOrderRows });
  await assertReadFailed(invalidOrder.runtime.read(makeRequest({ categories: ["crime_personal_security"] })));
  assert.equal(invalidOrder.statements.at(-1), "ROLLBACK");
});

test("transaction and projection failures return only generic runtime errors and attempt rollback", async () => {
  let operations = 0;
  const statements: string[] = [];
  const executor: SqlExecutor = {
    async query<Row extends object>(statement: string) {
      statements.push(statement);
      if (statement === "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY") return { rows: [] };
      if (statement.includes("WITH trim_characters AS")) throw new Error(privateMarker + " SQL details");
      return { rows: [] as Row[] };
    },
    async execute() {
      assert.fail("No SQL write method is permitted.");
    },
  };
  const runtime = createPublicBriefingRuntime({
    datasetMode: "live",
    connectionString: testConnectionString,
  }, {
    now: () => Date.parse(generatedAt),
    async withSqlExecutor(connectionString, operation) {
      operations += 1;
      assert.equal(connectionString, testConnectionString);
      return operation(executor);
    },
  });
  assert.ok(runtime);

  await assertReadFailed(runtime.read(makeRequest({ categories: ["crime_personal_security"] })));
  assert.equal(operations, 1);
  assert.equal(statements.at(0), "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  assert.equal(statements.at(-1), "ROLLBACK");
  assert.ok(!statements.join("\n").includes(privateMarker));
});

test("API gates the exact live POST route and keeps demo, GET, and other paths off the runtime", async () => {
  let calls = 0;
  const runtime: PublicBriefingRuntime = {
    async read() {
      calls += 1;
      return { items: [], generated_at: generatedAt };
    },
  };
  const success = () => postRequest(JSON.stringify(makeRequest()));

  const demo = await callApi(success(), runtime, undefined, { DATASET_MODE: "demo" });
  const liveGet = await callApi(new Request("http://localhost/api/v1/briefings"), runtime);
  const unsupported = await callApi(new Request("http://localhost/api/v1/briefings", { method: "PUT" }), runtime);
  const trailingPath = await callApi(successPath("/api/v1/briefings/"), runtime);
  const unavailable = await callApi(success(), undefined);

  assert.equal(demo.status, 503);
  assert.equal(liveGet.status, 405);
  assert.equal(unsupported.status, 405);
  assert.equal(trailingPath.status, 405);
  assert.equal(unavailable.status, 503);
  assert.equal(calls, 0);

  const response = await callApi(success(), runtime);
  assert.equal(response.status, 200);
  assert.equal(calls, 1);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
});

function successPath(path: string): Request {
  return postRequest(JSON.stringify(makeRequest()), { "content-type": "application/json" }, path);
}

test("API maps media type, malformed JSON, invalid UTF-8, query, and invalid content length to one stable 400", async () => {
  const calls: unknown[] = [];
  const runtime: PublicBriefingRuntime = {
    async read(value) {
      calls.push(value);
      return { items: [], generated_at: generatedAt };
    },
  };
  const malformed = [
    postRequest("{}", { "content-type": "text/plain" }),
    postRequest("{ " + privateMarker, { "content-type": "application/json" }),
    postRequest(new Uint8Array([0xc3, 0x28]), { "content-type": "application/json" }),
    postRequest(JSON.stringify(makeRequest()), { "content-type": "application/json", "content-length": "12x" }),
    successPath("/api/v1/briefings?private=" + privateMarker),
  ];

  for (const request of malformed) {
    const response = await callApi(request, runtime);
    const body = await response.json() as Record<string, unknown>;
    assert.equal(response.status, 400);
    assert.deepEqual(Object.keys(body).sort(), ["code", "message", "request_id"]);
    assert.equal(body.code, "INVALID_REQUEST");
    assert.equal(body.message, "The briefing request is invalid.");
    assert.ok(!JSON.stringify(body).includes(privateMarker));
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  }
  assert.equal(calls.length, 0);
});

test("API accepts an ordinary decimal Content-Length and JSON UTF-8 request", async () => {
  const payload = JSON.stringify(makeRequest({ categories: ["crime_personal_security"] }));
  const received: unknown[] = [];
  const runtime: PublicBriefingRuntime = {
    async read(value) {
      received.push(value);
      return { items: [], generated_at: generatedAt };
    },
  };
  const request = postRequest(payload, {
    "content-type": "application/json; charset=utf-8",
    "content-length": String(new TextEncoder().encode(payload).byteLength),
  });
  const response = await callApi(request, runtime);

  assert.equal(response.status, 200);
  assert.deepEqual(received, [makeRequest({ categories: ["crime_personal_security"] })]);
  assert.deepEqual(await response.json(), { items: [], generated_at: generatedAt });
});

test("API counts streamed bytes and rejects an advertised oversized body before consuming it", async () => {
  let runtimeCalls = 0;
  const runtime: PublicBriefingRuntime = {
    async read() {
      runtimeCalls += 1;
      return { items: [], generated_at: generatedAt };
    },
  };
  const payload = new TextEncoder().encode(JSON.stringify(makeRequest()));
  const streamed = streamingPostRequest([
    payload,
    new Uint8Array(bodyLimit + 1).fill(0x20),
  ]);
  const streamedResponse = await callApi(streamed.request, runtime);
  assert.equal(streamedResponse.status, 400);
  assert.equal(runtimeCalls, 0);
  assert.equal(streamed.request.bodyUsed, true);
  assert.equal(streamed.cancelled, true);

  const advertised = streamingPostRequest(
    [payload],
    { "content-length": String(bodyLimit + 1) },
  );
  const advertisedResponse = await callApi(advertised.request, runtime);
  assert.equal(advertisedResponse.status, 400);
  assert.equal(advertised.request.bodyUsed, false);
  assert.equal(runtimeCalls, 0);
});

test("request telemetry contains only fixed route bucket, status, and duration with no interest echo", async () => {
  const sensitiveInterest = "Kelurahan Privat 0042 " + privateMarker;
  const records: TelemetryRecord[] = [];
  const runtime: PublicBriefingRuntime = {
    async read(value) {
      assert.ok(JSON.stringify(value).includes(sensitiveInterest));
      return { items: [], generated_at: generatedAt };
    },
  };
  const response = await callApi(
    postRequest(JSON.stringify(makeRequest({ places: [sensitiveInterest] }))),
    runtime,
    { record(record) { records.push(record); } },
  );

  assert.equal(response.status, 200);
  assert.equal(records.length, 1);
  const record = records[0];
  assert.ok(record);
  assert.equal(record.eventName, "api_request");
  if (record.eventName !== "api_request") assert.fail("Expected API telemetry.");
  assert.equal(record.route, "other");
  assert.equal(record.status, 200);
  assert.ok(Number.isFinite(record.durationMs) && record.durationMs >= 0);
  assert.deepEqual(Object.keys(record).sort(), ["durationMs", "eventName", "route", "status"]);
  assert.ok(!JSON.stringify(records).includes(sensitiveInterest));
  assert.ok(!JSON.stringify(await response.json()).includes(sensitiveInterest));
});

test("runtime input errors map to 400 and public read failures map to generic 503 without partial output", async () => {
  const invalidRuntime: PublicBriefingRuntime = {
    async read() {
      throw new PublicBriefingRuntimeError("INVALID_REQUEST");
    },
  };
  const unavailableRuntime: PublicBriefingRuntime = {
    async read() {
      throw new Error(privateMarker + " candidate SQL detail");
    },
  };

  const invalid = await callApi(successPath("/api/v1/briefings"), invalidRuntime);
  const unavailable = await callApi(successPath("/api/v1/briefings"), unavailableRuntime);
  const invalidBody = await invalid.json() as Record<string, unknown>;
  const unavailableBody = await unavailable.json() as Record<string, unknown>;

  assert.equal(invalid.status, 400);
  assert.equal(invalidBody.code, "INVALID_REQUEST");
  assert.equal(invalidBody.message, "The briefing request is invalid.");
  assert.equal(unavailable.status, 503);
  assert.equal(unavailableBody.code, "TEMPORARILY_UNAVAILABLE");
  assert.equal(unavailableBody.message, "The public read could not be completed.");
  assert.ok(!JSON.stringify(unavailableBody).includes(privateMarker));
  assert.ok(!Object.hasOwn(unavailableBody, "items"));
});
