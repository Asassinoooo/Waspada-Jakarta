import assert from "node:assert/strict";
import test from "node:test";
import type { HistoryPage } from "../src/contracts/public-api.js";
import type { SqlExecutor } from "../../db/src/sql.js";
import { handlePublicApiRequest } from "../src/layers/l4-application-integration/api.js";
import {
  createPublicEventHistoryRuntime,
  type PublicEventHistorySqlExecutorRunner,
} from "../src/runtime/public-event-history-runtime.js";

/** Authored fictional live-shaped rows establish runtime boundaries only. */
const eventId = "event-synthetic-history-runtime-01";
const testConnectionString = "postgresql://test-user:test-password@hyperdrive.example.invalid/waspada?sslmode=require";

function makeEventRecord(version: number) {
  return {
    schema_version: "2.0",
    trace_id: "trace-synthetic-history-private-" + version,
    record_type: "Event",
    dataset_kind: "live",
    event_id: eventId,
    version,
    supersedes_version: version === 1 ? null : version - 1,
    title: "Synthetic history event version " + version,
    summary: "An authored fictional storage summary that must never be serialized.",
    category: "transport_road_incidents",
    tags: [],
    lifecycle: "ongoing",
    freshness: {
      status: "current",
      evaluated_at: "2026-09-26T03:00:00Z",
      review_due_at: null,
      basis: "manual_review",
    },
    event_time: { start: null, end: null, precision: "unknown" },
    validity: { valid_from: null, valid_until: null },
    scope: { place_ids: [], service_ids: [], institution_ids: [], audience_ids: [], geometry_ids: [] },
    claims: [],
    impact_refs: [],
    publication_status: "published",
    withdrawal_reason: null,
    publication_decision_id: "decision-synthetic-history-" + version,
    published_at: "2026-09-26T03:0" + version + ":00Z",
    withdrawn_at: null,
  };
}

function makeCandidateRow(version: number) {
  return {
    current_dataset_kind: "live",
    current_event_id: eventId,
    current_version: 2,
    current_record_json: makeEventRecord(2),
    dataset_kind: "live",
    event_id: eventId,
    version,
    record_json: makeEventRecord(version),
  };
}

function makeDisclosureRow(version: number, coverage: "approved" | "missing" | "held" = "approved") {
  const hasMetadata = coverage !== "missing";
  return {
    current_dataset_kind: "live",
    current_event_id: eventId,
    current_version: 2,
    candidate_dataset_kind: "live",
    candidate_event_id: eventId,
    candidate_version: version,
    review_dataset_kind: hasMetadata ? "live" : null,
    review_event_id: hasMetadata ? eventId : null,
    review_event_version: hasMetadata ? version : null,
    review_status: hasMetadata ? coverage : null,
    change_type: hasMetadata ? (version === 1 ? "published" : "corrected") : null,
    summary: hasMetadata ? "Fictional reviewed disclosure for version " + version + "." : null,
    reviewer_id: hasMetadata ? "reviewer-synthetic-" + version : null,
    reviewed_at: hasMetadata ? "2026-09-26T03:0" + version + ":30Z" : null,
  };
}

function makeExecutor(
  onQuery: (statement: string, parameters: readonly unknown[]) => readonly object[],
): SqlExecutor {
  return {
    async query<Row extends object>(statement: string, parameters: readonly unknown[] = []) {
      return { rows: onQuery(statement, parameters) as readonly Row[] };
    },
    async execute() {
      throw new Error("a public history read must not execute a statement");
    },
  };
}

async function readJson<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

function makeRuntime(
  onQuery: (statement: string, parameters: readonly unknown[]) => readonly object[],
) {
  let operations = 0;
  let insideOperation = false;
  const statements: string[] = [];
  const executor = makeExecutor((statement, parameters) => {
    assert.equal(insideOperation, true);
    statements.push(statement);
    return onQuery(statement, parameters);
  });
  const withSqlExecutor: PublicEventHistorySqlExecutorRunner = async (connectionString, operation) => {
    operations += 1;
    assert.equal(connectionString, testConnectionString);
    insideOperation = true;
    try {
      return await operation(executor);
    } finally {
      insideOperation = false;
    }
  };
  const service = createPublicEventHistoryRuntime({
    datasetMode: "live",
    connectionString: testConnectionString,
  }, { withSqlExecutor });
  assert.ok(service, "history runtime accepts exact live mode without a cursor secret");
  return {
    service,
    statements,
    get operations() { return operations; },
  };
}

test("exact-live history composes candidate and reviewed readers in one SQL operation", async () => {
  const queryParameters: unknown[][] = [];
  const runtime = makeRuntime((statement, parameters) => {
    queryParameters.push([...parameters]);
    const afterVersion = Number(parameters[1]);
    const versions = [1, 2].filter((version) => version > afterVersion);
    if (statement.includes("public_event_history_review_metadata AS disclosure")) {
      return versions.map((version) => makeDisclosureRow(version));
    }
    assert.ok(statement.includes("FROM waspada.public_event_versions AS event"));
    return versions.map((version) => makeCandidateRow(version));
  });
  const response = await handlePublicApiRequest(
    new Request("http://localhost/api/v1/events/" + eventId + "/history"),
    { DATASET_MODE: "live" },
    undefined,
    undefined,
    undefined,
    runtime.service,
  );
  const page = await readJson<HistoryPage>(response);

  assert.equal(response.status, 200);
  assert.equal(runtime.operations, 1);
  assert.equal(runtime.statements.length, 2);
  assert.ok(runtime.statements[0]?.includes("public_event_versions"));
  assert.ok(runtime.statements[1]?.includes("public_event_history_review_metadata"));
  assert.deepEqual(queryParameters, [[eventId, 0, 21], [eventId, 0, 21]]);
  assert.deepEqual(page, {
    data: [
      {
        event_id: eventId,
        version: 1,
        change_type: "published",
        changed_at: "2026-09-26T03:01:00Z",
        summary: "Fictional reviewed disclosure for version 1.",
      },
      {
        event_id: eventId,
        version: 2,
        change_type: "corrected",
        changed_at: "2026-09-26T03:02:00Z",
        summary: "Fictional reviewed disclosure for version 2.",
      },
    ],
    page: { next_cursor: null, cursor_expires_at: null },
  });
  const serialized = JSON.stringify(page);
  assert.ok(!serialized.includes("trace-synthetic-history-private"));
  assert.ok(!serialized.includes("reviewer-synthetic"));
  assert.ok(!serialized.includes("storage summary"));

  const cursorRuntime = makeRuntime((statement, parameters) => {
    const versions = [1, 2].filter((version) => version > Number(parameters[1]));
    return statement.includes("public_event_history_review_metadata AS disclosure")
      ? versions.map((version) => makeDisclosureRow(version))
      : versions.map((version) => makeCandidateRow(version));
  });
  const cursorResponse = await handlePublicApiRequest(
    new Request("http://localhost/api/v1/events/" + eventId + "/history?cursor=1&limit=5"),
    { DATASET_MODE: "live" },
    undefined,
    undefined,
    undefined,
    cursorRuntime.service,
  );
  const cursorPage = await readJson<HistoryPage>(cursorResponse);
  assert.equal(cursorResponse.status, 200);
  assert.equal(cursorRuntime.operations, 1);
  assert.equal(cursorPage.data.length, 1);
  assert.equal(cursorPage.data[0]?.version, 2);
  assert.deepEqual(cursorPage.page, { next_cursor: null, cursor_expires_at: null });
});

test("invalid live history paths and query parameters fail before SQL setup", async () => {
  const runtime = makeRuntime(() => {
    assert.fail("invalid path/query must not execute SQL");
  });
  const badQueries = [
    "cursor=0",
    "cursor=01",
    "cursor=opaque-token",
    "cursor=2147483648",
    "limit=0",
    "limit=101",
    "limit=1.5",
    "cursor=1&cursor=2",
    "limit=1&limit=2",
    "unknown=private-query-marker",
    "cursor=" + "1".repeat(2_049),
  ];

  for (const query of badQueries) {
    const response = await handlePublicApiRequest(
      new Request("http://localhost/api/v1/events/" + eventId + "/history?" + query),
      { DATASET_MODE: "live" },
      undefined,
      undefined,
      undefined,
      runtime.service,
    );
    const body = await readJson<{ code: string; message: string }>(response);
    assert.equal(response.status, 400, query.slice(0, 32));
    assert.equal(body.code, "INVALID_REQUEST");
    assert.equal(body.message, "The public event history request is invalid.");
    assert.equal(JSON.stringify(body).includes("private-query-marker"), false);
  }

  const invalidPaths = [
    "/api/v1/events/" + eventId.replace("-runtime", " bad") + "/history",
    "/api/v1/events/%E0%A4%A/history",
  ];
  for (const path of invalidPaths) {
    const response = await handlePublicApiRequest(
      new Request("http://localhost" + path),
      { DATASET_MODE: "live" },
      undefined,
      undefined,
      undefined,
      runtime.service,
    );
    assert.equal(response.status, 400, path);
  }
  assert.equal(runtime.operations, 0);
  assert.equal(runtime.statements.length, 0);
});

/**
 * The safe current-public view has no current row for a withdrawn latest
 * version. Earlier history stays joined to that missing current row and cannot
 * become a fallback page.
 */
test("a latest-withdrawn event returns not-found without reading earlier history", async () => {
  const runtime = makeRuntime((statement) => {
    assert.ok(statement.includes("public_event_versions"));
    return [];
  });
  const response = await handlePublicApiRequest(
    new Request("http://localhost/api/v1/events/" + eventId + "/history"),
    { DATASET_MODE: "live" },
    undefined,
    undefined,
    undefined,
    runtime.service,
  );
  const body = await readJson<{ code: string; message: string }>(response);

  assert.equal(response.status, 404);
  assert.equal(body.code, "NOT_FOUND");
  assert.equal(runtime.operations, 1);
  assert.equal(runtime.statements.length, 1, "no disclosure or prior-version fallback query runs");
});

test("incomplete or held review coverage fails closed with a redacted unavailable response", async () => {
  for (const coverage of ["missing", "held"] as const) {
    const runtime = makeRuntime((statement, parameters) => {
      const versions = [1, 2].filter((version) => version > Number(parameters[1]));
      return statement.includes("public_event_history_review_metadata AS disclosure")
        ? versions.map((version) => makeDisclosureRow(version, version === 2 ? coverage : "approved"))
        : versions.map((version) => makeCandidateRow(version));
    });
    const response = await handlePublicApiRequest(
      new Request("http://localhost/api/v1/events/" + eventId + "/history"),
      { DATASET_MODE: "live" },
      undefined,
      undefined,
      undefined,
      runtime.service,
    );
    const body = await readJson<{ code: string; message: string }>(response);

    assert.equal(response.status, 500, coverage);
    assert.equal(body.code, "TEMPORARILY_UNAVAILABLE");
    assert.equal(body.message, "The public read could not be completed.");
    assert.equal(runtime.operations, 1);
    const serialized = JSON.stringify(body);
    assert.ok(!serialized.includes("Fictional reviewed disclosure"));
    assert.ok(!serialized.includes("reviewer-synthetic"));
    assert.ok(!serialized.includes("SQL"));
  }
});

test("history runtime is unavailable without exact live mode and a valid injected connection", () => {
  const calls: string[] = [];
  const withSqlExecutor: PublicEventHistorySqlExecutorRunner = async (connectionString, operation) => {
    calls.push(connectionString);
    return operation(makeExecutor(() => []));
  };

  for (const configuration of [
    {},
    { datasetMode: "demo", connectionString: testConnectionString },
    { datasetMode: "LIVE", connectionString: testConnectionString },
    { datasetMode: "live" },
    { datasetMode: "live", connectionString: "https://example.invalid/database" },
  ]) {
    assert.equal(createPublicEventHistoryRuntime(configuration, { withSqlExecutor }), undefined);
  }
  assert.deepEqual(calls, []);
});
