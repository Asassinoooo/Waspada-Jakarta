import assert from "node:assert/strict";
import test from "node:test";
import {
  ingestPetabencanaGeoJson,
  formatPetabencanaReportText,
  PETABENCANA_SOURCE_ID,
  type NewReportRevisionInput,
  type NewEvidenceReferenceInput,
  type IngestGeometryRecord,
  type PetabencanaIngestPorts,
} from "../src/layers/l1-data-knowledge/petabencana-ingest.js";
import type { EvidenceChunkInput } from "../src/layers/l1-data-knowledge/evidence-chunking.js";

function createMockPorts(): {
  ports: PetabencanaIngestPorts;
  revisions: NewReportRevisionInput[];
  references: NewEvidenceReferenceInput[];
  chunks: Array<{ reportRevisionId: string; chunks: readonly EvidenceChunkInput[] }>;
  geometries: IngestGeometryRecord[];
} {
  const revisions: NewReportRevisionInput[] = [];
  const references: NewEvidenceReferenceInput[] = [];
  const chunks: Array<{ reportRevisionId: string; chunks: readonly EvidenceChunkInput[] }> = [];
  const geometries: IngestGeometryRecord[] = [];

  const ports: PetabencanaIngestPorts = {
    reportRevisions: {
      async create(revision: NewReportRevisionInput): Promise<void> {
        revisions.push(revision);
      },
      async createEvidenceReference(ref: NewEvidenceReferenceInput): Promise<string> {
        references.push(ref);
        return `ref-${references.length}`;
      },
    },
    evidenceChunks: {
      async persist(input): Promise<unknown> {
        chunks.push({ reportRevisionId: input.reportRevisionId, chunks: input.chunks });
        return { count: input.chunks.length };
      },
    },
    geometryWriter: {
      async persist(geom: IngestGeometryRecord): Promise<unknown> {
        geometries.push(geom);
        return { geometryId: geom.geometry_id, outcome: "created" };
      },
    },
  };

  return { ports, revisions, references, chunks, geometries };
}

test("ingestPetabencanaGeoJson: rejects invalid or non-RFC3339 retrievedAt timestamp", async () => {
  const { ports } = createMockPorts();
  const result = await ingestPetabencanaGeoJson(
    {
      datasetKind: "synthetic",
      traceId: "trace-test-1",
      geoJsonText: JSON.stringify({ type: "FeatureCollection", features: [] }),
      retrievedAt: "not-a-timestamp",
    },
    ports,
  );

  assert.equal(result.outcome, "failed");
  if (result.outcome === "failed") {
    assert.equal(result.code, "invalid_timestamp");
  }
});

test("ingestPetabencanaGeoJson: succeeds with empty FeatureCollection", async () => {
  const { ports, revisions, geometries } = createMockPorts();
  const emptyGeoJson = JSON.stringify({
    type: "FeatureCollection",
    features: [],
  });

  const result = await ingestPetabencanaGeoJson(
    {
      datasetKind: "synthetic",
      traceId: "trace-test-2",
      geoJsonText: emptyGeoJson,
      retrievedAt: "2026-10-22T16:00:00.000Z",
    },
    ports,
  );

  assert.equal(result.outcome, "completed");
  if (result.outcome === "completed") {
    assert.equal(result.empty, true);
    assert.equal(result.reportCount, 0);
    assert.equal(result.chunkCount, 0);
    assert.equal(result.geometryCount, 0);
  }
  assert.equal(revisions.length, 0);
  assert.equal(geometries.length, 0);
});

test("ingestPetabencanaGeoJson: ingests valid reports and filters out-of-envelope reports", async () => {
  const { ports, revisions, references, chunks, geometries } = createMockPorts();

  const validGeoJson = JSON.stringify({
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        geometry: {
          type: "Point",
          coordinates: [106.82, -6.21], // Jakarta Pusat (inside envelope)
        },
        properties: {
          pkey: "report-jk-101",
          created_at: "2026-10-22T15:30:00.000Z",
          status: "confirmed",
          report_type: "flood",
        },
      },
      {
        type: "Feature",
        geometry: {
          type: "Point",
          coordinates: [110.36, -7.79], // Yogyakarta (outside Jakarta envelope)
        },
        properties: {
          pkey: "report-outside-102",
          created_at: "2026-10-22T15:30:00.000Z",
          status: "confirmed",
          report_type: "flood",
        },
      },
    ],
  });

  const result = await ingestPetabencanaGeoJson(
    {
      datasetKind: "synthetic",
      traceId: "trace-test-3",
      geoJsonText: validGeoJson,
      retrievedAt: "2026-10-22T16:00:00.000Z",
    },
    ports,
  );

  assert.equal(result.outcome, "completed");
  if (result.outcome === "completed") {
    assert.equal(result.empty, false);
    assert.equal(result.reportCount, 1); // Yogyakarta report was filtered out
    assert.equal(result.chunkCount, 1);
    assert.equal(result.geometryCount, 1);
    assert.equal(result.evidenceReferenceCount, 1);
    assert.deepEqual(result.reportRevisionIds, ["petabencana-report-report-jk-101"]);
  }

  // Verify Revision Record
  assert.equal(revisions.length, 1);
  const rev = revisions[0]!;
  assert.equal(rev.reportRevisionId, "petabencana-report-report-jk-101");
  assert.equal(rev.sourceId, PETABENCANA_SOURCE_ID);
  assert.equal(rev.observedAt, "2026-10-22T15:30:00.000Z");
  assert.equal(rev.validFrom, "2026-10-22T15:30:00.000Z");
  assert.equal(rev.validUntil, "2026-10-23T15:30:00.000Z"); // Exactly 24h later
  assert.equal(rev.revisionStatus, "unreviewed");
  assert.match(rev.canonicalUrl, /https:\/\/petabencana\.id\/report\/report-jk-101/);

  // Verify Evidence Reference
  assert.equal(references.length, 1);
  const ref = references[0]!;
  assert.equal(ref.reportRevisionId, rev.reportRevisionId);
  assert.equal(ref.spanStart, 0);
  assert.equal(ref.spanEnd, Array.from(rev.permittedText).length);
  assert.equal(ref.relation, "supports");

  // Verify Chunks
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0]!.chunks.length, 1);
  assert.equal(chunks[0]!.chunks[0]!.reportRevisionId, rev.reportRevisionId);

  // Verify Geometry
  assert.equal(geometries.length, 1);
  const geom = geometries[0]!;
  assert.equal(geom.geometry_id, "petabencana-geom-report-jk-101");
  assert.equal(geom.role, "incident_scene");
  assert.equal(geom.precision_basis, "provider_accuracy");
  assert.deepEqual(geom.geojson.coordinates, [106.82, -6.21]);
  assert.equal(geom.source_evidence.length, 1);
  assert.equal(geom.source_evidence[0]!.report_revision_id, rev.reportRevisionId);
});

test("ingestPetabencanaGeoJson: fails on malformed GeoJSON syntax", async () => {
  const { ports } = createMockPorts();
  const result = await ingestPetabencanaGeoJson(
    {
      datasetKind: "synthetic",
      traceId: "trace-test-4",
      geoJsonText: "{ malformed json",
      retrievedAt: "2026-10-22T16:00:00.000Z",
    },
    ports,
  );

  assert.equal(result.outcome, "failed");
  if (result.outcome === "failed") {
    assert.equal(result.code, "invalid_payload");
  }
});

test("ingestPetabencanaGeoJson: handles persistence failure cleanly", async () => {
  const { ports } = createMockPorts();
  // Override reportRevisions.create to simulate DB failure
  ports.reportRevisions.create = async () => {
    throw new Error("DB connection timeout");
  };

  const geoJson = JSON.stringify({
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        geometry: { type: "Point", coordinates: [106.82, -6.21] },
        properties: { pkey: "report-fail-1", created_at: "2026-10-22T15:00:00Z" },
      },
    ],
  });

  const result = await ingestPetabencanaGeoJson(
    {
      datasetKind: "synthetic",
      traceId: "trace-test-5",
      geoJsonText: geoJson,
      retrievedAt: "2026-10-22T16:00:00.000Z",
    },
    ports,
  );

  assert.equal(result.outcome, "failed");
  if (result.outcome === "failed") {
    assert.equal(result.code, "persistence_failed");
    assert.match(result.message, /DB connection timeout/);
  }
});

test("formatPetabencanaReportText: formats deterministic Bahasa Indonesia summary", () => {
  const text = formatPetabencanaReportText({
    featureId: "399904",
    providerStatus: "confirmed",
    reportType: "flood",
    sourceCreatedAt: "2026-10-22T13:15:56.402Z",
    sourceCreatedAtState: "valid",
    retrievedAt: "2026-10-22T13:20:00.000Z",
    geometry: {
      type: "Point",
      coordinates: [106.825123, -6.215432],
    },
  });

  assert.match(text, /Laporan flood PetaBencana ID 399904: status laporan confirmed\./);
  assert.match(text, /Koordinat lokasi \[106\.82512, -6\.21543\]\./);
  assert.match(text, /Waktu pembuatan laporan: 2026-10-22T13:15:56\.402Z\./);
});
