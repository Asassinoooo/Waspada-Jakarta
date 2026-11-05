import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";
import { createTestDatabase, type TestDatabase } from "../../db/test/harness.js";
import { applyMigrations, readMigrations } from "../../db/src/migrations.js";
import {
  createSemanticRetrievalService,
  NINEROUTER_EMBEDDING_IDENTITY,
} from "../src/services/semantic-retrieval-service.js";
import { generateMockVector } from "../src/providers/ninerouter-adapter.js";

const DUMMY_HASH = "a".repeat(64);

describe("SemanticRetrievalService Direct Incident Retrieval", () => {
  let db: TestDatabase;

  before(async () => {
    db = await createTestDatabase();
    const migrations = await readMigrations(new URL("../../db/migrations/", import.meta.url));
    await applyMigrations(db.executor, migrations);
  });

  after(async () => {
    await db?.close();
  });

  it("retrieves candidate incidents directly from pgvector vectors linked to incidents", async () => {
    const datasetKind = "synthetic";
    const reportRevisionId = "rev-seed-001";
    const chunkId = "chk-seed-001";
    const incidentId = "inc-seed-001";
    const traceId = "tr-seed-001";
    const sourceId = "source-detik-seed";
    const text = "Ledakan tabung gas 12 kg di Duri Kepa Kebon Jeruk Jakarta Barat merusak 3 rumah warga.";

    // 1. Trace & Source
    await db.executor.query(
      `INSERT INTO waspada.traces (trace_id, dataset_kind, started_at, outcome, metadata)
       VALUES ($1, $2, NOW(), 'succeeded', '{}'::jsonb)
       ON CONFLICT DO NOTHING`,
      [traceId, datasetKind],
    );

    await db.executor.query(
      `INSERT INTO waspada.source_registry (
        source_id, trace_id, registry_version, display_name, source_kind, remit,
        access_method, approved_hosts, access_restrictions, reuse_basis, registry_status,
        approval_status, health_status, auto_acquisition_enabled, auto_publication_policy
      ) VALUES (
        $1, $2, 1, 'Detik News', 'other', ARRAY['news'], 'manual_fixture',
        ARRAY['detik.com'], ARRAY[]::text[], ARRAY['public'], 'active', 'approved', 'healthy', true, 'never'
      ) ON CONFLICT DO NOTHING`,
      [sourceId, traceId],
    );

    // 2. Report Revision
    await db.executor.query(
      `INSERT INTO waspada.report_revisions (
        dataset_kind, report_revision_id, trace_id, source_id, canonical_url,
        content_hash, permitted_text, permitted_text_hash, normalization_version,
        retrieved_at, revision_status, record_json
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, NOW(), 'unreviewed', '{}'::jsonb
      )`,
      [
        datasetKind,
        reportRevisionId,
        traceId,
        sourceId,
        "https://news.detik.com/duri-kepa",
        DUMMY_HASH,
        text,
        DUMMY_HASH,
        "v1",
      ],
    );

    // 3. Evidence Chunk
    await db.executor.query(
      `INSERT INTO waspada.evidence_chunks (
        dataset_kind, chunk_id, trace_id, report_revision_id,
        permitted_text_hash, span_start, span_end, offset_unit,
        chunker_version, chunk_text_hash, status
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, 'unicode_code_points', $8, $9, 'active'
      )`,
      [
        datasetKind,
        chunkId,
        traceId,
        reportRevisionId,
        DUMMY_HASH,
        0,
        text.length,
        "v1",
        DUMMY_HASH,
      ],
    );

    // 4. Embedding Run & Vector
    const mockVec = generateMockVector(text, 768);
    const vectorLiteral = `[${mockVec.join(",")}]`;

    await db.executor.query(
      `INSERT INTO waspada.embedding_runs (
        dataset_kind, embedding_run_id, trace_id, chunk_id, capability,
        provider, model_version, dimensions, distance_metric,
        vector_index_version, input_text_hash, status, created_at
      ) VALUES (
        $1, $2, $3, $4, 'embedding', $5, $6, $7, $8, $9, $10, 'available', NOW()
      )`,
      [
        datasetKind,
        "emb-run-001",
        traceId,
        chunkId,
        NINEROUTER_EMBEDDING_IDENTITY.provider,
        NINEROUTER_EMBEDDING_IDENTITY.modelVersion,
        NINEROUTER_EMBEDDING_IDENTITY.dimensions,
        NINEROUTER_EMBEDDING_IDENTITY.distanceMetric,
        NINEROUTER_EMBEDDING_IDENTITY.vectorIndexVersion,
        DUMMY_HASH,
      ],
    );

    await db.executor.query(
      `INSERT INTO waspada.embedding_vectors (
        dataset_kind, embedding_run_id, dimensions, embedding
      ) VALUES (
        $1, $2, $3, $4::vector
      )`,
      [datasetKind, "emb-run-001", 768, vectorLiteral],
    );

    // 5. Incident & Incident Reports
    await db.executor.query(
      `INSERT INTO waspada.incidents (
        dataset_kind, incident_id, title, description, incident_type,
        primary_category, status, severity, location_label,
        shape, event_time, first_observed_at, last_updated_at,
        discrepancies, uncertainty_notes, record_json, created_at
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9,
        ST_SetSRID(ST_MakePoint(106.77, -6.17), 4326),
        $10, NOW(), NOW(), '[]'::jsonb, '[]'::jsonb, '{}'::jsonb, NOW()
      )`,
      [
        datasetKind,
        incidentId,
        "Ledakan Tabung Gas di Duri Kepa",
        "Ledakan gas merusak 3 rumah warga di Duri Kepa",
        "ledakan_gas",
        "fires_infrastructure_hazards",
        "active",
        "high",
        "Duri Kepa, Kebon Jeruk, Jakarta Barat",
        JSON.stringify({ value: "2026-11-05T08:00:00Z" }),
      ],
    );

    await db.executor.query(
      `INSERT INTO waspada.incident_reports (
        dataset_kind, incident_id, report_revision_id, relationship, linked_at
      ) VALUES (
        $1, $2, $3, $4, NOW()
      )`,
      [datasetKind, incidentId, reportRevisionId, "primary_initial"],
    );

    // 6. Test retrieveCandidates
    const service = createSemanticRetrievalService({ executor: db.executor });
    const result = await service.retrieveCandidates({
      datasetKind,
      queryText: text,
      maxResults: 5,
    });

    assert.ok(result.candidateIncidents.length > 0, "Should return at least 1 candidate incident");
    const top = result.candidateIncidents[0]!;
    assert.equal(top.incident.incidentId, incidentId);
    assert.equal(top.incident.title, "Ledakan Tabung Gas di Duri Kepa");
    assert.ok(top.similarityScore > 0.99, `Expected score ~1.0 for identical vector, got ${top.similarityScore}`);
    assert.equal(top.matchedChunkId, chunkId);
    assert.ok(top.matchedText?.includes("Duri Kepa"));
  });
});
