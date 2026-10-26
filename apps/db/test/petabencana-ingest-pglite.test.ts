import assert from "node:assert/strict";
import test from "node:test";
import { applyMigrations, readMigrations } from "../src/migrations.js";
import { createRepositoryPorts } from "../src/ports.js";
import { createSqlEvidenceChunkRepository } from "../src/evidence-chunks.js";
import { createSqlGeometryWriter } from "../src/geometry-writer.js";
import { createTestDatabase } from "./harness.js";
import {
  ingestPetabencanaGeoJson,
  PETABENCANA_SOURCE_ID,
  type PetabencanaIngestPorts,
} from "../../worker/src/layers/l1-data-knowledge/petabencana-ingest.js";

test("ING-01 PetaBencana L1 Ingestion: persists reports, chunks, evidence, and geometries in PGlite", async () => {
  const db = await createTestDatabase();
  try {
    const migrations = await readMigrations(new URL("../migrations/", import.meta.url));
    await applyMigrations(db.executor, migrations);

    const ports = createRepositoryPorts(db.executor);
    const chunkRepo = createSqlEvidenceChunkRepository(db.executor);
    const geometryWriter = createSqlGeometryWriter(db.executor);

    // 1. Setup audit trace
    const traceId = "trace-petabencana-ingest-test";
    await ports.tracesAndAudit.createTrace({
      traceId,
      datasetKind: "synthetic",
      startedAt: "2026-10-22T16:00:00.000Z",
      endedAt: null,
      outcome: "open",
      metadata: { action: "acquisition_ingest" },
    });

    // 2. Register PetaBencana in source_registry
    await db.executor.query(`
      INSERT INTO waspada.source_registry (
        source_id, trace_id, registry_version, display_name, source_kind, remit,
        access_method, approved_hosts, access_restrictions, reuse_basis, registry_status,
        approval_status, health_status, auto_acquisition_enabled, auto_publication_policy,
        polling_interval_seconds
      ) VALUES (
        $1, $2, 1, 'PetaBencana.id', 'crowdsourced_platform', ARRAY['flood', 'hazard_report'],
        'api', ARRAY['api.petabencana.id'], ARRAY['non_commercial', 'attribution_required'],
        ARRAY['CC BY-NC 4.0'], 'active', 'approved', 'healthy', true, 'never', 300
      )
    `, [PETABENCANA_SOURCE_ID, traceId]);

    // 3. Construct real DB ports for Petabencana Ingestion
    const ingestPorts: PetabencanaIngestPorts = {
      reportRevisions: ports.reportRevisions,
      evidenceChunks: chunkRepo,
      geometryWriter,
    };

    const petabencanaGeoJson = JSON.stringify({
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          geometry: {
            type: "Point",
            coordinates: [106.825, -6.215], // Jakarta Pusat (inside envelope)
          },
          properties: {
            pkey: "399901",
            created_at: "2026-10-22T15:00:00.000Z",
            status: "confirmed",
            report_type: "flood",
          },
        },
      ],
    });

    // 4. Ingest PetaBencana GeoJSON
    const result = await ingestPetabencanaGeoJson(
      {
        datasetKind: "synthetic",
        traceId,
        sourceId: PETABENCANA_SOURCE_ID,
        geoJsonText: petabencanaGeoJson,
        retrievedAt: "2026-10-22T16:00:00.000Z",
      },
      ingestPorts,
    );

    assert.equal(result.outcome, "completed");
    if (result.outcome === "completed") {
      assert.equal(result.empty, false);
      assert.equal(result.reportCount, 1);
      assert.equal(result.chunkCount, 1);
      assert.equal(result.geometryCount, 1);
      assert.equal(result.evidenceReferenceCount, 1);
      assert.deepEqual(result.reportRevisionIds, ["petabencana-report-399901"]);
    }

    // 5. Verify PostgreSQL report_revisions record
    const revRows = await db.executor.query<{
      report_revision_id: string;
      source_id: string;
      observed_at: string;
      valid_until: string;
      canonical_url: string;
      revision_status: string;
    }>(`
      SELECT report_revision_id, source_id, observed_at, valid_until, canonical_url, revision_status
      FROM waspada.report_revisions
      WHERE dataset_kind = 'synthetic' AND report_revision_id = 'petabencana-report-399901'
    `);
    assert.equal(revRows.rows.length, 1);
    const revRow = revRows.rows[0]!;
    assert.equal(revRow.source_id, PETABENCANA_SOURCE_ID);
    assert.equal(revRow.revision_status, "unreviewed");
    assert.equal(revRow.canonical_url, "https://petabencana.id/report/399901");

    // 6. Verify evidence_references record
    const refRows = await db.executor.query<{
      relation: string;
      offset_unit: string;
    }>(`
      SELECT relation, offset_unit
      FROM waspada.evidence_references
      WHERE dataset_kind = 'synthetic' AND report_revision_id = 'petabencana-report-399901'
    `);
    assert.equal(refRows.rows.length, 1);
    assert.equal(refRows.rows[0]!.relation, "supports");
    assert.equal(refRows.rows[0]!.offset_unit, "unicode_code_points");

    // 7. Verify evidence_chunks record
    const chunkRows = await db.executor.query<{
      chunk_id: string;
      chunker_version: string;
    }>(`
      SELECT chunk_id, chunker_version
      FROM waspada.evidence_chunks
      WHERE dataset_kind = 'synthetic' AND report_revision_id = 'petabencana-report-399901'
    `);
    assert.equal(chunkRows.rows.length, 1);

    // 8. Verify geometries record
    const geomRows = await db.executor.query<{
      geometry_id: string;
      role: string;
      precision_basis: string;
    }>(`
      SELECT geometry_id, role, precision_basis
      FROM waspada.geometries
      WHERE dataset_kind = 'synthetic' AND geometry_id = 'petabencana-geom-399901'
    `);
    assert.equal(geomRows.rows.length, 1);
    assert.equal(geomRows.rows[0]!.role, "incident_scene");
    assert.equal(geomRows.rows[0]!.precision_basis, "provider_accuracy");

    // 9. Verify Idempotent Replay
    const replayResult = await ingestPetabencanaGeoJson(
      {
        datasetKind: "synthetic",
        traceId,
        sourceId: PETABENCANA_SOURCE_ID,
        geoJsonText: petabencanaGeoJson,
        retrievedAt: "2026-10-22T16:00:00.000Z",
      },
      ingestPorts,
    );
    assert.equal(replayResult.outcome, "completed");

    // Counts in database must remain 1
    const totalRevs = await db.executor.query<{ count: string | number }>(`
      SELECT count(*) AS count FROM waspada.report_revisions WHERE report_revision_id = 'petabencana-report-399901'
    `);
    assert.equal(Number(totalRevs.rows[0]!.count), 1);

    // 10. Verify Empty GeoJSON ingestion
    const emptyResult = await ingestPetabencanaGeoJson(
      {
        datasetKind: "synthetic",
        traceId,
        sourceId: PETABENCANA_SOURCE_ID,
        geoJsonText: JSON.stringify({ type: "FeatureCollection", features: [] }),
        retrievedAt: "2026-10-22T16:05:00.000Z",
      },
      ingestPorts,
    );
    assert.equal(emptyResult.outcome, "completed");
    if (emptyResult.outcome === "completed") {
      assert.equal(emptyResult.empty, true);
      assert.equal(emptyResult.reportCount, 0);
    }
  } finally {
    await db.close();
  }
});
