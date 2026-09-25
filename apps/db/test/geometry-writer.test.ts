import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { applyMigrations, readMigrations } from "../src/migrations.js";
import { createRepositoryPorts, type NewReportRevision, type TraceRecord } from "../src/ports.js";
import {
  createSqlGeometryWriter,
  GeometryWriteError,
  type GeometryRecord,
  type GeometrySupportEvidenceRef,
} from "../src/geometry-writer.js";
import { createTestDatabase, type TestDatabase } from "./harness.js";

const permittedText = "Synthetic authored fixture: the station entrance is at Merdeka 🚧.";
const permittedTextHash = sha256(permittedText);
const codePointLength = Array.from(permittedText).length;

describe("GEO-STORE-CORE source-backed geometry writer", () => {
  let database: TestDatabase;
  let ports: ReturnType<typeof createRepositoryPorts>;
  let writer: ReturnType<typeof createSqlGeometryWriter>;
  let supportA: GeometrySupportEvidenceRef;
  let supportB: GeometrySupportEvidenceRef;
  let supportC: GeometrySupportEvidenceRef;
  let supportD: GeometrySupportEvidenceRef;
  let supportAId: string;
  let supportBId: string;
  let point: GeometryRecord;

  before(async () => {
    database = await createTestDatabase();
    ports = createRepositoryPorts(database.executor);
    writer = createSqlGeometryWriter(database.executor);
    const migrations = await readMigrations(new URL("../migrations/", import.meta.url));
    await applyMigrations(database.executor, migrations);

    await ports.tracesAndAudit.createTrace(makeTrace("trace-geometry-catalog", null));
    await ports.tracesAndAudit.createTrace(makeTrace("trace-geometry-source", "synthetic"));
    await ports.tracesAndAudit.createTrace(makeTrace("trace-geometry-alt", "synthetic"));
    await ports.tracesAndAudit.createTrace(makeTrace("trace-geometry-historical", "historical"));
    await database.executor.query(
      [
        "INSERT INTO waspada.source_registry",
        "  (source_id, trace_id, registry_version, display_name, source_kind, remit,",
        "   access_method, approved_hosts, access_restrictions, reuse_basis, registry_status,",
        "   approval_status, health_status, auto_acquisition_enabled, auto_publication_policy)",
        "VALUES ('source-geometry-fixture', 'trace-geometry-catalog', 1, 'Synthetic fixture source',",
        "  'other', ARRAY['authored geometry test fixtures'], 'manual_fixture', ARRAY[]::text[],",
        "  ARRAY['synthetic rows only'], ARRAY['test fixture'], 'active', 'approved',",
        "  'unknown', false, 'never')",
      ].join("\n"),
    );

    const revision = makeRevision();
    await ports.reportRevisions.create(revision);
    supportA = makeSupport(0, codePointLength);
    supportAForHelper = supportA;
    supportB = makeSupport(0, 12);
    supportC = makeSupport(18, 19);
    supportD = makeSupport(20, 24);
    supportAId = await insertEvidence(supportA, "supports");
    supportBId = await insertEvidence(supportB, "supports");
    await insertEvidence(supportC, "contradicts");
    await insertEvidence(supportD, "supports");
    await database.executor.query(
      [
        "INSERT INTO waspada.evidence_references",
        "  (dataset_kind, trace_id, report_revision_id, permitted_text_hash,",
        "   span_start, span_end, offset_unit, relation)",
        "VALUES ('synthetic', 'trace-geometry-source', $1, $2, $3, $4,",
        "  'unicode_code_points', 'supports')",
      ].join("\n"),
      [revision.reportRevisionId, permittedTextHash, codePointLength, codePointLength + 1],
    );

    point = makeGeometry("geometry-writer-point", {
      role: "approximate_place",
      geojson: { type: "Point", coordinates: [106.8272, -6.1754] },
    });
  });

  after(async () => {
    await database.close();
  });

  it("persists point, route, and polygon shapes exactly and retries identical records", async () => {
    const route = makeGeometry("geometry-writer-route", {
      role: "route_segment",
      geojson: { type: "LineString", coordinates: [[106.8269, -6.1751], [106.8275, -6.1759]] },
    });
    const area = makeGeometry("geometry-writer-area", {
      role: "affected_area",
      geojson: {
        type: "Polygon",
        coordinates: [[[106.82, -6.17], [106.83, -6.17], [106.83, -6.18], [106.82, -6.18], [106.82, -6.17]]],
      },
    });

    await runAsL1(database, async () => {
      assert.deepEqual(await writer.persist(point), {
        geometryId: point.geometry_id, outcome: "created",
      });
      assert.deepEqual(await writer.persist(point), {
        geometryId: point.geometry_id, outcome: "already_exists",
      });
      assert.deepEqual(await writer.persist(route), {
        geometryId: route.geometry_id, outcome: "created",
      });
      assert.deepEqual(await writer.persist(area), {
        geometryId: area.geometry_id, outcome: "created",
      });
    });

    for (const record of [point, route, area]) {
      const stored = await database.executor.query<{
        srid: number;
        shape_matches: boolean;
        geojson: unknown;
        source_evidence: unknown;
      }>(
        [
          "SELECT ST_SRID(shape) AS srid,",
          "       ST_AsEWKB(shape) = ST_AsEWKB(ST_SetSRID(ST_GeomFromGeoJSON($2::text), 4326)) AS shape_matches,",
          "       record_json -> 'geojson' AS geojson, record_json -> 'source_evidence' AS source_evidence",
          "FROM waspada.geometries",
          "WHERE dataset_kind = $1 AND geometry_id = $3",
        ].join("\n"),
        [record.dataset_kind, JSON.stringify(record.geojson), record.geometry_id],
      );
      assert.equal(stored.rows[0]?.srid, 4326);
      assert.equal(stored.rows[0]?.shape_matches, true);
      assert.deepEqual(stored.rows[0]?.geojson, record.geojson);
      assert.deepEqual(stored.rows[0]?.source_evidence, record.source_evidence);
    }

    const links = await database.executor.query<{ evidence_ref_id: string }>(
      [
        "SELECT evidence_ref_id::text AS evidence_ref_id",
        "FROM waspada.geometry_evidence",
        "WHERE dataset_kind = 'synthetic' AND geometry_id = $1",
      ].join("\n"),
      [point.geometry_id],
    );
    assert.deepEqual(links.rows, [{ evidence_ref_id: supportAId }]);
  });

  it("rejects reused IDs when any supplied geometry record field or support link changes", async () => {
    const changes: readonly [string, GeometryRecord][] = [
      ["trace", { ...point, trace_id: "trace-geometry-alt" }],
      ["role", { ...point, role: "incident_scene" }],
      ["shape", { ...point, geojson: { type: "Point", coordinates: [106.828, -6.176] } }],
      ["precision", { ...point, precision_m: 25 }],
      ["precision basis", { ...point, precision_basis: "source_supplied" }],
      ["label", { ...point, display_label: "Changed synthetic label" }],
      ["support links", { ...point, source_evidence: [supportB] }],
    ];
    await runAsL1(database, async () => {
      for (const [field, changed] of changes) {
        await assert.rejects(
          writer.persist(changed),
          isGeometryError("geometry_conflict"),
          "changed " + field + " must conflict",
        );
      }
    });
  });

  it("detects typed-column and persisted-link drift even when record_json is unchanged", async () => {
    const driftCases: readonly [string, GeometryRecord, Partial<GeometryRecord>][] = [
      ["trace", makeGeometry("geometry-writer-drift-trace"), { trace_id: "trace-geometry-alt" }],
      ["role", makeGeometry("geometry-writer-drift-role"), { role: "incident_scene" }],
      ["shape", makeGeometry("geometry-writer-drift-shape"), {
        geojson: { type: "Point", coordinates: [106.828, -6.176] },
      }],
      ["precision", makeGeometry("geometry-writer-drift-precision"), { precision_m: 15 }],
      ["precision basis", makeGeometry("geometry-writer-drift-basis"), { precision_basis: "source_supplied" }],
      ["label", makeGeometry("geometry-writer-drift-label"), { display_label: "Drifted synthetic label" }],
    ];

    for (const [field, record, changedColumns] of driftCases) {
      const storedColumns = { ...record, ...changedColumns };
      await insertDriftedGeometry(database, record, storedColumns, supportAId);
      await runAsL1(database, async () => {
        await assert.rejects(
          writer.persist(record),
          isGeometryError("geometry_conflict"),
          "persisted " + field + " drift must conflict",
        );
      });
    }

    const linkDrift = makeGeometry("geometry-writer-drift-link");
    await insertDriftedGeometry(database, linkDrift, linkDrift, supportBId);
    await runAsL1(database, async () => {
      await assert.rejects(writer.persist(linkDrift), isGeometryError("geometry_conflict"));
    });
  });

  it("checks role compatibility, coordinate bounds, ring closure, topology, IDs, and schema shape", async () => {
    const invalidRecords: readonly [string, unknown][] = [
      ["point role with area geometry", { ...point, role: "affected_area" }],
      ["area role with point geometry", { ...point, geojson: { type: "Polygon", coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] } }],
      ["longitude outside CRS84", { ...point, geojson: { type: "Point", coordinates: [181, 0] } }],
      ["latitude outside CRS84", { ...point, geojson: { type: "Point", coordinates: [0, -91] } }],
      ["third coordinate dimension", { ...point, geojson: { type: "Point", coordinates: [0, 0, 4] } }],
      ["non-finite coordinate", { ...point, geojson: { type: "Point", coordinates: [Number.NaN, 0] } }],
      ["too many coordinates", {
        ...point,
        role: "route_segment",
        geojson: {
          type: "LineString",
          coordinates: Array.from({ length: 10_001 }, (_, index) => [0, index % 80]),
        },
      }],
      ["unsupported geometry kind", { ...point, geojson: { type: "GeometryCollection", coordinates: [] } }],
      ["unsupported extra geometry field", { ...point, geojson: { type: "Point", coordinates: [0, 0], crs: "EPSG:3857" } }],
      ["open polygon ring", { ...point, role: "affected_area", geojson: { type: "Polygon", coordinates: [[[0, 0], [2, 0], [2, 2], [0, 2]]] } }],
      ["invalid polygon topology", {
        ...point,
        role: "affected_area",
        geojson: { type: "Polygon", coordinates: [[[0, 0], [2, 2], [0, 2], [2, 0], [0, 0]]] },
      }],
      ["bad schema version", { ...point, schema_version: "1.0" }],
      ["bad geometry ID", { ...point, geometry_id: "contains spaces" }],
      ["wrong coordinate reference system", { ...point, coordinate_reference_system: "EPSG:4326" }],
      ["negative precision", { ...point, precision_m: -0.1 }],
      ["empty display label", { ...point, display_label: "" }],
      ["extra record field", { ...point, inferred_radius_m: 500 }],
      ["empty support", { ...point, source_evidence: [] }],
      ["too many support references", { ...point, source_evidence: Array.from({ length: 33 }, () => supportA) }],
      ["duplicate support reference", { ...point, source_evidence: [supportA, supportA] }],
      ["wrong support relation", { ...point, source_evidence: [{ ...supportA, relation: "contradicts" }] }],
      ["wrong offset unit", { ...point, source_evidence: [{ ...supportA, offset_unit: "utf16" }] }],
    ];

    await runAsL1(database, async () => {
      for (const [label, invalid] of invalidRecords) {
        await assert.rejects(
          writer.persist(invalid),
          (error: unknown) => error instanceof GeometryWriteError,
          label + " must be rejected",
        );
      }
    });
  });

  it("requires one exact same-dataset persisted supporting reference and valid Unicode spans", async () => {
    const missing: GeometrySupportEvidenceRef = {
      ...supportA,
      report_revision_id: "revision-does-not-exist",
    };
    const wrongHash: GeometrySupportEvidenceRef = {
      ...supportA,
      permitted_text_hash: "f".repeat(64),
    };
    const wrongDataset = makeGeometry("geometry-writer-wrong-dataset", {
      dataset_kind: "historical",
      trace_id: "trace-geometry-historical",
      source_evidence: [supportA],
    });
    const nonSupport = makeGeometry("geometry-writer-non-support", {
      source_evidence: [supportC],
    });
    const ambiguous = makeGeometry("geometry-writer-ambiguous", {
      source_evidence: [supportD],
    });
    const invalidSpan = makeGeometry("geometry-writer-invalid-span", {
      source_evidence: [{
        report_revision_id: supportA.report_revision_id,
        permitted_text_hash: supportA.permitted_text_hash,
        span_start: codePointLength,
        span_end: codePointLength + 1,
        offset_unit: "unicode_code_points",
        relation: "supports",
      }],
    });

    await insertEvidence(supportD, "supports");
    await runAsL1(database, async () => {
      for (const [record, code] of [
        [makeGeometry("geometry-writer-missing", { source_evidence: [missing] }), "geometry_support_invalid"],
        [makeGeometry("geometry-writer-wrong-hash", { source_evidence: [wrongHash] }), "geometry_support_invalid"],
        [wrongDataset, "geometry_support_invalid"],
        [nonSupport, "geometry_support_invalid"],
        [ambiguous, "geometry_support_invalid"],
        [invalidSpan, "geometry_support_invalid"],
      ] as const) {
        await assert.rejects(
          writer.persist(record),
          isGeometryError(code),
        );
      }
    });
  });

  it("rolls back the geometry and earlier evidence links when a later relation insert fails", async () => {
    const record = makeGeometry("geometry-writer-rollback", {
      source_evidence: [supportA, supportB],
    });
    const functionSql = [
      "CREATE FUNCTION waspada.fail_geometry_link_fixture() RETURNS trigger",
      "LANGUAGE plpgsql AS $$",
      "BEGIN",
      "  IF NEW.geometry_id = 'geometry-writer-rollback' AND NEW.evidence_ref_id = " + supportBId + " THEN",
      "    RAISE EXCEPTION 'synthetic relation insert failure';",
      "  END IF;",
      "  RETURN NEW;",
      "END;",
      "$$",
    ].join("\n");
    await database.executor.execute(functionSql);
    await database.executor.execute(
      "CREATE TRIGGER fail_geometry_link_fixture BEFORE INSERT ON waspada.geometry_evidence "
      + "FOR EACH ROW EXECUTE FUNCTION waspada.fail_geometry_link_fixture()",
    );
    try {
      await runAsL1(database, async () => {
        await assert.rejects(writer.persist(record), /synthetic relation insert failure/);
      });
    } finally {
      await database.executor.execute("DROP TRIGGER fail_geometry_link_fixture ON waspada.geometry_evidence");
      await database.executor.execute("DROP FUNCTION waspada.fail_geometry_link_fixture()");
    }

    const counts = await database.executor.query<{ geometry_count: string; link_count: string }>(
      [
        "SELECT",
        "  (SELECT count(*)::text FROM waspada.geometries",
        "   WHERE dataset_kind = 'synthetic' AND geometry_id = 'geometry-writer-rollback') AS geometry_count,",
        "  (SELECT count(*)::text FROM waspada.geometry_evidence",
        "   WHERE dataset_kind = 'synthetic' AND geometry_id = 'geometry-writer-rollback') AS link_count",
      ].join("\n"),
    );
    assert.deepEqual(counts.rows, [{ geometry_count: "0", link_count: "0" }]);
  });

  it("uses only the L1 grants and denies unrelated reads or mutations", async () => {
    const before = await database.executor.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM waspada.evidence_references",
    );
    await runAsL1(database, async () => {
      assert.equal((await writer.persist(makeGeometry("geometry-writer-role-check"))).outcome, "created");
      await assert.rejects(
        database.executor.query("SELECT trace_id FROM waspada.evidence_references LIMIT 1"),
        /permission denied for table evidence_references|permission denied for column trace_id/i,
      );
      await assert.rejects(
        database.executor.query("SELECT * FROM waspada.publication_decisions LIMIT 1"),
        /permission denied for table publication_decisions/i,
      );
      await assert.rejects(
        database.executor.query(
          "UPDATE waspada.geometries SET display_label = 'changed' "
          + "WHERE dataset_kind = 'synthetic' AND geometry_id = 'geometry-writer-role-check'",
        ),
        /permission denied for table geometries/i,
      );
      await assert.rejects(
        database.executor.query(
          "DELETE FROM waspada.geometry_evidence "
          + "WHERE dataset_kind = 'synthetic' AND geometry_id = 'geometry-writer-role-check'",
        ),
        /permission denied for table geometry_evidence/i,
      );
    });
    const after = await database.executor.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM waspada.evidence_references",
    );
    assert.equal(after.rows[0]?.count, before.rows[0]?.count);
  });

  async function insertEvidence(
    reference: GeometrySupportEvidenceRef,
    relation: "supports" | "contradicts",
  ): Promise<string> {
    return ports.reportRevisions.createEvidenceReference({
      datasetKind: "synthetic",
      traceId: "trace-geometry-source",
      reportRevisionId: reference.report_revision_id,
      permittedTextHash: reference.permitted_text_hash,
      spanStart: reference.span_start,
      spanEnd: reference.span_end,
      relation,
    });
  }
});

function makeTrace(traceId: string, datasetKind: TraceRecord["datasetKind"]): TraceRecord {
  return {
    traceId,
    datasetKind,
    startedAt: "2026-09-25T02:00:00Z",
    endedAt: null,
    outcome: "open",
    metadata: { fixture: "authored-synthetic-geometry-test-only" },
  };
}

function makeRevision(): NewReportRevision {
  return {
    datasetKind: "synthetic",
    reportRevisionId: "revision-geometry-source",
    traceId: "trace-geometry-source",
    sourceId: "source-geometry-fixture",
    canonicalUrl: "https://synthetic.invalid/geometry-fixture",
    sourceRevisionKey: "geometry-test-v1",
    contentHash: sha256("authored synthetic geometry source bytes"),
    permittedText,
    permittedTextHash,
    normalizationVersion: "normalization-geometry-test-v1",
    publishedAt: "2026-09-25T01:59:00Z",
    observedAt: null,
    retrievedAt: "2026-09-25T02:00:00Z",
    validFrom: null,
    validUntil: null,
    supersedesId: null,
    revisionStatus: "eligible",
    recordJson: {
      schema_version: "2.0",
      trace_id: "trace-geometry-source",
      record_type: "ReportRevision",
      dataset_kind: "synthetic",
      report_revision_id: "revision-geometry-source",
      source_id: "source-geometry-fixture",
      canonical_url: "https://synthetic.invalid/geometry-fixture",
      source_revision_key: "geometry-test-v1",
      content_hash: sha256("authored synthetic geometry source bytes"),
      permitted_text: permittedText,
      permitted_text_hash: permittedTextHash,
      normalization_version: "normalization-geometry-test-v1",
      published_at: "2026-09-25T01:59:00Z",
      observed_at: null,
      retrieved_at: "2026-09-25T02:00:00Z",
      validity: { valid_from: null, valid_until: null },
      supersedes_id: null,
      revision_status: "eligible",
    },
  };
}

function makeSupport(spanStart: number, spanEnd: number): GeometrySupportEvidenceRef {
  return {
    report_revision_id: "revision-geometry-source",
    permitted_text_hash: permittedTextHash,
    span_start: spanStart,
    span_end: spanEnd,
    offset_unit: "unicode_code_points",
    relation: "supports",
  };
}

function makeGeometry(
  geometryId: string,
  overrides: Partial<GeometryRecord> = {},
): GeometryRecord {
  return {
    schema_version: "2.0",
    trace_id: "trace-geometry-source",
    record_type: "Geometry",
    dataset_kind: "synthetic",
    geometry_id: geometryId,
    role: "approximate_place",
    geojson: { type: "Point", coordinates: [106.8272, -6.1754] },
    coordinate_reference_system: "OGC:CRS84",
    precision_m: null,
    precision_basis: "unknown",
    display_label: "Synthetic geometry fixture",
    source_evidence: [supportAForHelper],
    ...overrides,
  };
}

let supportAForHelper: GeometrySupportEvidenceRef;

function isGeometryError(code: string): (error: unknown) => boolean {
  return (error) => error instanceof GeometryWriteError && error.code === code;
}

async function runAsL1<Result>(
  database: TestDatabase,
  operation: () => Promise<Result>,
): Promise<Result> {
  await database.executor.execute("SET ROLE waspada_l1_pipeline");
  try {
    return await operation();
  } finally {
    await database.executor.execute("RESET ROLE");
  }
}

async function insertDriftedGeometry(
  database: TestDatabase,
  record: GeometryRecord,
  storedColumns: GeometryRecord,
  evidenceRefId: string,
): Promise<void> {
  await database.executor.query(
    [
      "INSERT INTO waspada.geometries",
      "  (dataset_kind, geometry_id, trace_id, role, shape, coordinate_reference_system,",
      "   precision_m, precision_basis, display_label, record_json)",
      "VALUES ($1, $2, $3, $4, ST_SetSRID(ST_GeomFromGeoJSON($5::text), 4326),",
      "  $6, $7, $8, $9, $10::jsonb)",
    ].join("\n"),
    [
      storedColumns.dataset_kind,
      storedColumns.geometry_id,
      storedColumns.trace_id,
      storedColumns.role,
      JSON.stringify(storedColumns.geojson),
      storedColumns.coordinate_reference_system,
      storedColumns.precision_m,
      storedColumns.precision_basis,
      storedColumns.display_label,
      JSON.stringify(record),
    ],
  );
  await database.executor.query(
    "INSERT INTO waspada.geometry_evidence (dataset_kind, geometry_id, evidence_ref_id) VALUES ($1, $2, $3)",
    [storedColumns.dataset_kind, storedColumns.geometry_id, evidenceRefId],
  );
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
