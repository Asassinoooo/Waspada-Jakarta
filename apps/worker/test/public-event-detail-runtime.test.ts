import assert from "node:assert/strict";
import test from "node:test";
import type { SqlExecutor } from "../../db/src/sql.js";
import {
  handlePublicApiRequest,
  type WorkerEnvironment,
} from "../src/layers/l4-application-integration/api.js";
import type { TelemetryRecord } from "../src/layers/l5-evaluation-monitoring/telemetry.js";
import {
  PublicEventDetailProjectionServiceError,
} from "../src/layers/l4-application-integration/public-event-detail-projection-service.js";
import {
  createPublicEventDetailRuntime,
  type PublicEventDetailRuntimeConfiguration,
  type PublicEventDetailSqlExecutorRunner,
} from "../src/runtime/public-event-detail-runtime.js";

/** Authored fictional live-shaped rows; they establish runtime boundaries only. */
const eventId = "event-synthetic-runtime-01";
const eventVersion = 3;
const geometryId = "geometry-synthetic-runtime-01";
const revisionId = "revision-synthetic-runtime-01";
const supportHash = "a".repeat(64);
const testConnectionString = "postgresql://test-user:test-password@hyperdrive.example.invalid/waspada?sslmode=require";

function makeSupportReference() {
  return {
    report_revision_id: revisionId,
    permitted_text_hash: supportHash,
    span_start: 1,
    span_end: 12,
    offset_unit: "unicode_code_points",
    relation: "supports",
    private_support_marker: "PRIVATE_SUPPORT_MARKER",
  };
}

function makeScope(values: {
  place_ids?: string[];
  service_ids?: string[];
  geometry_ids?: string[];
} = {}) {
  return {
    place_ids: values.place_ids ?? [],
    service_ids: values.service_ids ?? [],
    institution_ids: [],
    audience_ids: [],
    geometry_ids: values.geometry_ids ?? [],
    private_scope_marker: "PRIVATE_SCOPE_MARKER",
  };
}

function makeEventRecord() {
  return {
    schema_version: "2.0",
    trace_id: "trace-synthetic-runtime-private",
    record_type: "Event",
    dataset_kind: "live",
    event_id: eventId,
    version: eventVersion,
    supersedes_version: 2,
    title: "Synthetic runtime event",
    summary: "An authored fictional record for the detail runtime.",
    category: "transport_road_incidents",
    tags: [{ namespace: "topic", value: "synthetic_notice", private_tag_marker: "PRIVATE_TAG_MARKER" }],
    lifecycle: "ongoing",
    freshness: {
      status: "current",
      evaluated_at: "2026-09-26T03:00:00Z",
      review_due_at: null,
      basis: "manual_review",
    },
    event_time: { start: null, end: null, precision: "unknown" },
    validity: { valid_from: null, valid_until: null },
    scope: makeScope({
      place_ids: ["place-synthetic-runtime-01"],
      geometry_ids: [geometryId],
    }),
    claims: [{
      claim_id: "claim-synthetic-runtime-01",
      text: "Synthetic claim supported by a fictional source span.",
      event_time: { start: null, end: null, precision: "unknown" },
      validity: { valid_from: null, valid_until: null },
      scope: makeScope({
        service_ids: ["service-synthetic-runtime-01"],
        geometry_ids: [geometryId],
      }),
      qualifiers: [],
      support: [makeSupportReference()],
      contradictions: [],
      context_evidence: [],
      origin_ids: ["origin-synthetic-private"],
      evidence_label: "attributed_report",
      private_claim_marker: "PRIVATE_CLAIM_MARKER",
    }],
    impact_refs: [],
    publication_status: "published",
    withdrawal_reason: null,
    publication_decision_id: "decision-synthetic-private",
    published_at: "2026-09-26T03:01:00Z",
    withdrawn_at: null,
    private_event_marker: "PRIVATE_EVENT_MARKER",
  };
}

function makeGeometryRecord() {
  return {
    schema_version: "2.0",
    trace_id: "trace-synthetic-geometry-private",
    record_type: "Geometry",
    dataset_kind: "live",
    geometry_id: geometryId,
    role: "incident_scene",
    coordinate_reference_system: "OGC:CRS84",
    precision_basis: "source_supplied",
    precision_m: 25,
    display_label: "Synthetic test point",
    geojson: { type: "Point", coordinates: [106.8, -6.2] },
    source_evidence: [{
      report_revision_id: revisionId,
      permitted_text_hash: supportHash,
      span_start: 1,
      span_end: 12,
      offset_unit: "unicode_code_points",
      relation: "supports",
    }],
    private_geometry_marker: "PRIVATE_GEOMETRY_MARKER",
  };
}

function makeRowsForStatement(statement: string, parameters: readonly unknown[]): readonly object[] {
  if (statement.includes("FROM waspada.public_event_versions AS event")) {
    return [{
      dataset_kind: "live",
      event_id: eventId,
      version: eventVersion,
      record_json: makeEventRecord(),
    }];
  }
  if (statement.includes("FROM waspada.public_event_impacts AS impact")) return [];
  if (statement.includes("FROM waspada.public_scope_names AS names")) {
    const entityTypes = parameters[0] as readonly string[];
    const entityIds = parameters[1] as readonly string[];
    return entityIds.map((id, index) => ({
      entity_type: entityTypes[index],
      id,
      display_name: `Synthetic ${id}`,
    }));
  }
  if (statement.includes("FROM waspada.public_source_attributions AS attribution")) {
    return [{
      dataset_kind: "live",
      report_revision_id: revisionId,
      permitted_text_hash: supportHash,
      span_start: 1,
      span_end: 12,
      offset_unit: "unicode_code_points",
      relation: "supports",
      public_use_approved: true,
      display_name: "Synthetic fictional source",
      url: "https://source.example.invalid/synthetic-runtime",
      published_at: "2026-09-26T02:50:00Z",
      observed_at: null,
      excerpt_public_use_approved: false,
      excerpt: null,
    }];
  }
  if (statement.includes("FROM waspada.public_event_geometries AS geometry")) {
    assert.deepEqual(parameters, [[geometryId]]);
    return [{ dataset_kind: "live", geometry_id: geometryId, record_json: makeGeometryRecord() }];
  }
  assert.fail("Unexpected public detail query: " + statement);
}

function makeExecutor(onQuery: (statement: string, parameters: readonly unknown[]) => void): SqlExecutor {
  return {
    async query<Row extends object>(statement: string, parameters: readonly unknown[] = []) {
      onQuery(statement, parameters);
      return { rows: makeRowsForStatement(statement, parameters) as readonly Row[] };
    },
    async execute() {
      throw new Error("a public detail read must not execute a statement");
    },
  };
}

async function readJson<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

function assertApiError(value: object, code: string, message: string): void {
  assert.deepEqual(Object.keys(value).sort(), ["code", "message", "request_id"]);
  assert.equal((value as { code: string }).code, code);
  assert.equal((value as { message: string }).message, message);
  assert.match((value as { request_id: string }).request_id, /^[0-9a-f-]{36}$/i);
}

test("an exact-live detail read projects approved fields and exact geometry in one SQL operation", async () => {
  let operations = 0;
  let insideOperation = false;
  const statements: string[] = [];
  const executor = makeExecutor((statement) => {
    assert.equal(insideOperation, true);
    statements.push(statement);
  });
  const withSqlExecutor: PublicEventDetailSqlExecutorRunner = async (connectionString, operation) => {
    operations += 1;
    assert.equal(connectionString, testConnectionString);
    insideOperation = true;
    try {
      return await operation(executor);
    } finally {
      insideOperation = false;
    }
  };
  const service = createPublicEventDetailRuntime({
    datasetMode: "live",
    connectionString: testConnectionString,
  }, { withSqlExecutor });
  assert.ok(service, "detail runtime does not require a cursor-signing secret");

  const response = await handlePublicApiRequest(
    new Request(`http://localhost/api/v1/events/${eventId}`),
    { DATASET_MODE: "live" },
    undefined,
    undefined,
    service,
  );
  const detail = await readJson<{
    event_id: string;
    title: string;
    claims: Array<{ text: string; sources: Array<{ excerpt: string | null }> }>;
    geometries: Array<{ geometry_id: string; geometry: { type: string } }>;
  }>(response);

  assert.equal(response.status, 200);
  assert.equal(operations, 1);
  assert.equal(statements.length, 5);
  assert.ok(statements.some((statement) => statement.includes("public_event_versions")));
  assert.ok(statements.some((statement) => statement.includes("public_event_impacts")));
  assert.ok(statements.some((statement) => statement.includes("public_scope_names")));
  assert.ok(statements.some((statement) => statement.includes("public_source_attributions")));
  assert.ok(statements.some((statement) => statement.includes("public_event_geometries")));
  assert.equal(detail.event_id, eventId);
  assert.equal(detail.title, "Synthetic runtime event");
  assert.equal(detail.claims[0]?.text, "Synthetic claim supported by a fictional source span.");
  assert.equal(detail.claims[0]?.sources[0]?.excerpt, null);
  assert.deepEqual(detail.geometries, [{
    geometry_id: geometryId,
    role: "incident_scene",
    geometry: { type: "Point", coordinates: [106.8, -6.2] },
    precision_m: 25,
    label: "Synthetic test point",
  }]);
  const serialized = JSON.stringify(detail);
  for (const marker of [
    "trace-synthetic-runtime-private",
    "PRIVATE_SUPPORT_MARKER",
    "PRIVATE_SCOPE_MARKER",
    "PRIVATE_TAG_MARKER",
    "PRIVATE_CLAIM_MARKER",
    "PRIVATE_EVENT_MARKER",
    "PRIVATE_GEOMETRY_MARKER",
    "origin-synthetic-private",
    "decision-synthetic-private",
  ]) {
    assert.equal(serialized.includes(marker), false, marker);
  }
});

test("an absent or currently withdrawn public event maps to the existing not-found envelope", async () => {
  let operations = 0;
  let queries = 0;
  const withSqlExecutor: PublicEventDetailSqlExecutorRunner = async (_connectionString, operation) => {
    operations += 1;
    const missingExecutor: SqlExecutor = {
      async query<Row extends object>(statement: string) {
        queries += 1;
        assert.ok(statement.includes("public_event_versions"));
        return { rows: [] as readonly Row[] };
      },
      async execute() { throw new Error("read-only"); },
    };
    return operation(missingExecutor);
  };
  const service = createPublicEventDetailRuntime({
    datasetMode: "live",
    connectionString: testConnectionString,
  }, { withSqlExecutor });
  assert.ok(service);

  const response = await handlePublicApiRequest(
    new Request(`http://localhost/api/v1/events/${eventId}`),
    { DATASET_MODE: "live" },
    undefined,
    undefined,
    service,
  );
  const body = await readJson<{ code: string; message: string; request_id: string }>(response);

  assert.equal(operations, 1);
  assert.equal(queries, 1);
  assert.equal(response.status, 404);
  assertApiError(body, "NOT_FOUND", "The requested public route was not found.");
});

test("missing and malformed configuration never invokes the SQL executor", () => {
  let operations = 0;
  const withSqlExecutor: PublicEventDetailSqlExecutorRunner = async (_connectionString, operation) => {
    operations += 1;
    return operation(makeExecutor(() => undefined));
  };
  const invalidConfigurations: PublicEventDetailRuntimeConfiguration[] = [
    {},
    { datasetMode: "demo", connectionString: testConnectionString },
    { datasetMode: "Live", connectionString: testConnectionString },
    { datasetMode: "live ", connectionString: testConnectionString },
    { datasetMode: "live" },
    { datasetMode: "live", connectionString: "not-a-postgres-url" },
    { datasetMode: "live", connectionString: "postgresql://host/db" },
    { datasetMode: "live", connectionString: "postgresql://user:password@/db" },
    { datasetMode: "live", connectionString: ` ${testConnectionString}` },
    { datasetMode: "live", connectionString: "postgresql://u:p@host/" + "x".repeat(4100) },
  ];

  for (const configuration of invalidConfigurations) {
    assert.equal(createPublicEventDetailRuntime(configuration, { withSqlExecutor }), undefined);
  }
  assert.equal(operations, 0);
});

test("invalid event IDs are rejected before opening the request-scoped SQL executor", async () => {
  let operations = 0;
  const withSqlExecutor: PublicEventDetailSqlExecutorRunner = async (_connectionString, operation) => {
    operations += 1;
    return operation(makeExecutor(() => undefined));
  };
  const service = createPublicEventDetailRuntime({
    datasetMode: "live",
    connectionString: testConnectionString,
  }, { withSqlExecutor });
  assert.ok(service);

  for (const invalidId of ["", "bad id", "évent-01", "x".repeat(129), "event/01", "event\u0000id"]) {
    await assert.rejects(
      service.read(invalidId),
      (error: unknown) => error instanceof PublicEventDetailProjectionServiceError
        && error.code === "INVALID_EVENT_ID",
    );
  }
  assert.equal(operations, 0);
});

test("database and projection failures stay generic and redact event and connection details", async () => {
  const privateMarker = `${eventId} postgres://private-user:private-password@db.invalid source excerpt`;
  let operations = 0;
  const withSqlExecutor: PublicEventDetailSqlExecutorRunner = async () => {
    operations += 1;
    throw new Error(privateMarker);
  };
  const service = createPublicEventDetailRuntime({
    datasetMode: "live",
    connectionString: testConnectionString,
  }, { withSqlExecutor });
  assert.ok(service);

  const telemetry: TelemetryRecord[] = [];
  const response = await handlePublicApiRequest(
    new Request(`http://localhost/api/v1/events/${eventId}`),
    { DATASET_MODE: "live" } satisfies WorkerEnvironment,
    { record: (record) => telemetry.push(record) },
    undefined,
    service,
  );
  const body = await readJson<{ code: string; message: string; request_id: string }>(response);

  assert.equal(operations, 1);
  assert.equal(response.status, 500);
  assertApiError(body, "TEMPORARILY_UNAVAILABLE", "The public read could not be completed.");
  assert.equal(JSON.stringify(body).includes(privateMarker), false);
  assert.equal(JSON.stringify(body).includes(eventId), false);
  assert.equal(JSON.stringify(telemetry).includes(eventId), false);
  assert.equal(JSON.stringify(telemetry).includes("private-password"), false);
});
