import assert from "node:assert/strict";
import test from "node:test";
import type { SqlExecutor } from "../../db/src/sql.js";
import { handlePublicApiRequest } from "../src/layers/l4-application-integration/api.js";
import { QueryValidationError } from "../src/layers/l4-application-integration/public-read-model.js";
import {
  createPublicEventGeoJSONRuntime,
  PublicEventGeoJSONRuntimeError,
  type PublicEventGeoJSONSqlExecutorRunner,
} from "../src/runtime/public-event-geojson-runtime.js";

/** Authored fictional live-shaped rows establish runtime boundaries only. */
const testConnectionString = "postgresql://test-user:test-password@hyperdrive.example.invalid/waspada?sslmode=require";
const privateMarker = "SYNTHETIC_PRIVATE_GEOJSON_RUNTIME_MARKER";

interface SupportReference {
  readonly report_revision_id: string;
  readonly permitted_text_hash: string;
  readonly span_start: number;
  readonly span_end: number;
  readonly offset_unit: "unicode_code_points";
  readonly relation: "supports";
}

interface RuntimeFixture {
  readonly eventId: string;
  readonly version: number;
  readonly geometryId: string;
  readonly event: Record<string, unknown>;
  readonly geometry: Record<string, unknown>;
  readonly candidate: Record<string, unknown>;
  readonly snapshotRow: Record<string, unknown>;
  readonly supportReferences: readonly SupportReference[];
  readonly scopeIds: readonly string[];
}

function makeFixture(
  eventId: string,
  options: { readonly version?: number; readonly scopeCount?: number; readonly supportCount?: number } = {},
): RuntimeFixture {
  const version = options.version ?? 3;
  const geometryId = `geometry-${eventId}`;
  const scopeIds = Array.from({ length: options.scopeCount ?? 1 }, (_, index) =>
    `place-${eventId}-${String(index).padStart(3, "0")}`);
  const supportReferences: SupportReference[] = Array.from({ length: options.supportCount ?? 1 }, (_, index) => ({
    report_revision_id: `revision-${eventId}-${String(index).padStart(3, "0")}`,
    permitted_text_hash: "a".repeat(64),
    span_start: index * 2 + 1,
    span_end: index * 2 + 9,
    offset_unit: "unicode_code_points",
    relation: "supports",
  }));
  const scope = (geometryIds: readonly string[]) => ({
    place_ids: [...scopeIds],
    service_ids: [],
    institution_ids: [],
    audience_ids: [],
    geometry_ids: [...geometryIds],
    private_scope_marker: privateMarker,
  });
  const event: Record<string, unknown> = {
    schema_version: "2.0",
    trace_id: `trace-private-${eventId}`,
    record_type: "Event",
    dataset_kind: "live",
    event_id: eventId,
    version,
    supersedes_version: version === 1 ? null : version - 1,
    title: `Synthetic GeoJSON event ${eventId}`,
    summary: "An authored fictional event used only by runtime tests.",
    category: "transport_road_incidents",
    tags: [],
    lifecycle: "ongoing",
    freshness: {
      status: "current",
      evaluated_at: "2026-09-27T03:00:00Z",
      review_due_at: null,
      basis: "manual_review",
    },
    event_time: { start: null, end: null, precision: "unknown" },
    validity: { valid_from: null, valid_until: null },
    scope: scope([geometryId]),
    claims: [{
      claim_id: `claim-${eventId}`,
      text: "A fictional source-supported claim for a route composition test.",
      event_time: { start: null, end: null, precision: "unknown" },
      validity: { valid_from: null, valid_until: null },
      scope: scope([geometryId]),
      qualifiers: [],
      support: supportReferences,
      contradictions: [],
      context_evidence: [],
      origin_ids: [`origin-private-${eventId}`],
      evidence_label: "attributed_report",
    }],
    impact_refs: [],
    publication_status: "published",
    withdrawal_reason: null,
    publication_decision_id: `decision-private-${eventId}`,
    published_at: "2026-09-27T03:01:00Z",
    withdrawn_at: null,
    private_event_marker: privateMarker,
  };
  const geometry: Record<string, unknown> = {
    schema_version: "2.0",
    trace_id: `trace-geometry-private-${eventId}`,
    record_type: "Geometry",
    dataset_kind: "live",
    geometry_id: geometryId,
    role: "incident_scene",
    geojson: { type: "Point", coordinates: [106.812345, -6.201234] },
    coordinate_reference_system: "OGC:CRS84",
    precision_m: 25,
    precision_basis: "source_supplied",
    display_label: "Synthetic exact source point",
    source_evidence: [supportReferences[0]],
    private_geometry_marker: privateMarker,
  };
  const candidate: Record<string, unknown> = {
    datasetKind: "live",
    eventId,
    eventVersion: version,
    category: "transport_road_incidents",
    lifecycle: "ongoing",
    freshness: "current",
    geometryId,
    eventRecordJson: event,
    geometryRecordJson: geometry,
  };
  const snapshotRow = {
    dataset_kind: "live",
    event_id: eventId,
    version,
    record_json: event,
  };
  return { eventId, version, geometryId, event, geometry, candidate, snapshotRow, supportReferences, scopeIds };
}

function makeRuntime(
  fixtures: readonly RuntimeFixture[],
  options: {
    readonly candidateRows?: readonly Record<string, unknown>[];
    readonly snapshotRows?: readonly Record<string, unknown>[];
  } = {},
) {
  let operations = 0;
  let insideOperation = false;
  const statements: Array<{ statement: string; parameters: readonly unknown[] }> = [];
  const scopeIds = new Map<string, string>();
  for (const fixture of fixtures) {
    for (const id of fixture.scopeIds) scopeIds.set(id, id);
  }

  const executor: SqlExecutor = {
    async query<Row extends object>(statement: string, parameters: readonly unknown[] = []) {
      assert.equal(insideOperation, true, "all SQL stays inside the request-scoped operation");
      statements.push({ statement, parameters });
      let rows: readonly object[];
      if (statement.includes("FROM waspada.public_event_geojson_candidates AS candidate")) {
        rows = options.candidateRows ?? fixtures.map(({ candidate }) => ({
          dataset_kind: "live",
          event_id: candidate.eventId,
          event_version: candidate.eventVersion,
          category: candidate.category,
          lifecycle: candidate.lifecycle,
          freshness: candidate.freshness,
          geometry_id: candidate.geometryId,
          event_record_json: candidate.eventRecordJson,
          geometry_record_json: candidate.geometryRecordJson,
        }));
      } else if (statement.includes("FROM waspada.public_event_versions AS event")) {
        rows = options.snapshotRows ?? fixtures.map(({ snapshotRow }) => snapshotRow);
      } else if (statement.includes("FROM waspada.public_event_impacts AS impact")) {
        rows = [];
      } else if (statement.includes("FROM waspada.public_scope_names AS names")) {
        const entityTypes = parameters[0] as readonly string[];
        const entityIds = parameters[1] as readonly string[];
        rows = entityIds.map((id, index) => ({
          entity_type: entityTypes[index],
          id,
          display_name: `Synthetic public place ${scopeIds.get(id) ?? id}`,
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
          display_name: "Synthetic fictional source",
          url: `https://source.example.invalid/${reportRevisionId}`,
          published_at: "2026-09-27T02:50:00Z",
          observed_at: null,
          excerpt_public_use_approved: false,
          excerpt: null,
        }));
      } else {
        assert.fail("Unexpected GeoJSON SQL statement: " + statement);
      }
      return { rows: rows as readonly Row[] };
    },
    async execute() {
      assert.fail("The read-only GeoJSON runtime must not execute SQL statements");
    },
  };

  const withSqlExecutor: PublicEventGeoJSONSqlExecutorRunner = async (connectionString, operation) => {
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
  const service = createPublicEventGeoJSONRuntime({
    datasetMode: "live",
    connectionString: testConnectionString,
  }, { withSqlExecutor });
  assert.ok(service);
  return {
    service,
    statements,
    get operations() { return operations; },
  };
}

test("exact live GeoJSON composes candidates, current snapshots and approved lookups in one SQL operation", async () => {
  const fixture = makeFixture("event-synthetic-geojson-runtime-01");
  const runtime = makeRuntime([fixture]);
  const collection = await runtime.service.read(new URLSearchParams(
    "bbox=106.70,-6.30,106.90,-6.10&category=transport_road_incidents&lifecycle=ongoing&freshness=current",
  ));

  assert.equal(runtime.operations, 1);
  assert.equal(runtime.statements.length, 5);
  assert.ok(runtime.statements[0]?.statement.includes("public_event_geojson_candidates"));
  assert.deepEqual(runtime.statements[0]?.parameters, [106.7, -6.3, 106.9, -6.1,
    "transport_road_incidents", "ongoing", "current"]);
  assert.deepEqual(runtime.statements[1]?.parameters, [[fixture.eventId], 501]);
  assert.deepEqual(runtime.statements[2]?.parameters, [[fixture.eventId], [fixture.version], 10_001]);
  assert.ok(runtime.statements[3]?.statement.includes("public_scope_names"));
  assert.ok(runtime.statements[4]?.statement.includes("public_source_attributions"));
  assert.deepEqual(collection.type, "FeatureCollection");
  assert.equal(collection.features.length, 1);
  assert.deepEqual(collection.features[0]?.geometry, {
    type: "Point",
    coordinates: [106.812345, -6.201234],
  });
  assert.equal(collection.features[0]?.properties.event_id, fixture.eventId);
  const serialized = JSON.stringify(collection);
  assert.equal(serialized.includes(privateMarker), false);
  assert.equal(serialized.includes(fixture.supportReferences[0]?.report_revision_id ?? "missing"), false);
});

test("an empty candidate read returns the exact empty collection without snapshot or lookup queries", async () => {
  const runtime = makeRuntime([], { candidateRows: [] });
  assert.deepEqual(await runtime.service.read(new URLSearchParams()), {
    type: "FeatureCollection",
    features: [],
  });
  assert.equal(runtime.operations, 1);
  assert.equal(runtime.statements.length, 1);
  assert.ok(runtime.statements[0]?.statement.includes("public_event_geojson_candidates"));
});

test("query and connection validation leave the SQL operation unopened", async () => {
  let operations = 0;
  const service = createPublicEventGeoJSONRuntime({
    datasetMode: "live",
    connectionString: testConnectionString,
  }, {
    withSqlExecutor: async () => {
      operations += 1;
      throw new Error("Invalid query input must not start SQL.");
    },
  });
  assert.ok(service);
  for (const raw of [
    "bbox=106.7,-6.3,106.9,-6.1&bbox=106.7,-6.3,106.9,-6.1",
    "unknown=value",
    "bbox=106.31,-6.3,106.9,-6.1",
    "bbox=" + "x".repeat(101),
  ]) {
    await assert.rejects(
      service.read(new URLSearchParams(raw)),
      (error: unknown) => error instanceof QueryValidationError,
    );
  }
  assert.equal(operations, 0);

  assert.equal(createPublicEventGeoJSONRuntime({ datasetMode: "demo", connectionString: testConnectionString }), undefined);
  assert.equal(createPublicEventGeoJSONRuntime({ datasetMode: "live", connectionString: "not-a-postgres-url" }), undefined);
});

test("lookup requests are deduplicated and split into deterministic batches of at most 100 keys", async () => {
  const first = makeFixture("event-synthetic-geojson-batch-a", { scopeCount: 100, supportCount: 100 });
  const second = makeFixture("event-synthetic-geojson-batch-b", { scopeCount: 1, supportCount: 1 });
  const sharedScopeId = first.scopeIds[0]!;
  const secondScopeId = second.scopeIds[0]!;
  const sharedSupport = first.supportReferences[0]!;
  const secondSupport = second.supportReferences[0]!;
  const secondClaims = second.event.claims as Array<Record<string, unknown>>;
  (second.event.scope as Record<string, unknown>).place_ids = [sharedScopeId, secondScopeId];
  (secondClaims[0]!.scope as Record<string, unknown>).place_ids = [sharedScopeId, secondScopeId];
  secondClaims[0]!.support = [sharedSupport, secondSupport];
  second.geometry.source_evidence = [sharedSupport];
  const runtime = makeRuntime([first, second]);
  const collection = await runtime.service.read(new URLSearchParams());
  const scopeCalls = runtime.statements.filter(({ statement }) => statement.includes("public_scope_names"));
  const attributionCalls = runtime.statements.filter(({ statement }) => statement.includes("public_source_attributions"));

  assert.equal(runtime.operations, 1);
  assert.equal(collection.features.length, 2);
  assert.equal(scopeCalls.length, 2);
  assert.equal(attributionCalls.length, 2);
  assert.deepEqual(scopeCalls.map(({ parameters }) => (parameters[1] as readonly string[]).length), [100, 1]);
  assert.deepEqual(attributionCalls.map(({ parameters }) => (parameters[0] as readonly string[]).length), [100, 1]);
  for (const { parameters } of [...scopeCalls, ...attributionCalls]) {
    assert.ok((parameters[0] as readonly unknown[]).length <= 100);
  }
});

test("candidate/current version mismatch fails closed without any lookup or fallback", async () => {
  const candidateFixture = makeFixture("event-synthetic-geojson-version", { version: 2 });
  const staleFixture = makeFixture(candidateFixture.eventId, { version: 1 });
  const runtime = makeRuntime([candidateFixture], { snapshotRows: [staleFixture.snapshotRow] });
  await assert.rejects(
    runtime.service.read(new URLSearchParams()),
    (error: unknown) => error instanceof PublicEventGeoJSONRuntimeError
      && error.code === "READ_FAILED"
      && !error.message.includes(candidateFixture.eventId)
      && !error.message.includes(privateMarker),
  );
  assert.equal(runtime.operations, 1);
  assert.equal(runtime.statements.length, 3, "candidate read and current snapshot set read stop before lookup");
});

test("a withdrawn latest event cannot fall back to a stale candidate version or return partial features", async () => {
  const oldFixture = makeFixture("event-synthetic-geojson-withdrawn", { version: 1 });
  const runtime = makeRuntime([oldFixture], { snapshotRows: [] });
  const response = await handlePublicApiRequest(
    new Request("http://localhost/api/v1/events.geojson"),
    { DATASET_MODE: "live" },
    undefined,
    undefined,
    undefined,
    undefined,
    runtime.service,
  );
  const body = await response.json() as { code: string; message: string };

  assert.equal(response.status, 500);
  assert.equal(body.code, "TEMPORARILY_UNAVAILABLE");
  assert.equal(body.message, "The public read could not be completed.");
  assert.equal(JSON.stringify(body).includes(oldFixture.eventId), false);
  assert.equal(runtime.operations, 1);
  assert.equal(runtime.statements.length, 2, "the withdrawn current view returns no row and no older impact fallback is read");
});
