import {
  parsePetabencanaGeoJson,
  type GeoJsonPosition,
  type PetabencanaParseResult,
  type PetabencanaReport,
} from "./petabencana-geojson.js";
import { preparePermittedText, type PreparedText } from "./text-preparation.js";
import { chunkPreparedText, type EvidenceChunkInput } from "./evidence-chunking.js";

export const PETABENCANA_SOURCE_ID = "petabencana";
export const PETABENCANA_CANONICAL_BASE = "https://petabencana.id/";
export const PETABENCANA_ATTRIBUTION = "Data disediakan oleh PetaBencana.id, dilisensikan di bawah CC BY-NC 4.0.";
export const PETABENCANA_LICENSE_URL = "https://creativecommons.org/licenses/by-nc/4.0/";

export const PETABENCANA_JAKARTA_ENVELOPE = {
  west: 106.32,
  south: -6.40,
  east: 106.98,
  north: -5.16,
} as const;

export type DatasetKind = "live" | "historical" | "synthetic";

export interface PetabencanaIngestInput {
  readonly datasetKind: DatasetKind;
  readonly traceId: string;
  readonly sourceId?: string;
  readonly geoJsonText: string;
  readonly retrievedAt: string;
}

export interface NewReportRevisionInput {
  readonly datasetKind: DatasetKind;
  readonly reportRevisionId: string;
  readonly traceId: string;
  readonly sourceId: string;
  readonly canonicalUrl: string;
  readonly sourceRevisionKey: string | null;
  readonly contentHash: string;
  readonly permittedText: string;
  readonly permittedTextHash: string;
  readonly normalizationVersion: string;
  readonly publishedAt: string | null;
  readonly observedAt: string | null;
  readonly retrievedAt: string;
  readonly validFrom: string | null;
  readonly validUntil: string | null;
  readonly supersedesId: string | null;
  readonly revisionStatus: "unreviewed";
  readonly recordJson: Readonly<Record<string, unknown>>;
}

export interface NewEvidenceReferenceInput {
  readonly datasetKind: DatasetKind;
  readonly traceId: string;
  readonly reportRevisionId: string;
  readonly permittedTextHash: string;
  readonly spanStart: number;
  readonly spanEnd: number;
  readonly relation: "supports" | "contradicts" | "updates" | "context";
}

export interface GeometryEvidenceRef {
  readonly report_revision_id: string;
  readonly permitted_text_hash: string;
  readonly span_start: number;
  readonly span_end: number;
  readonly offset_unit: "unicode_code_points";
  readonly relation: "supports";
}

export interface IngestGeometryRecord {
  readonly schema_version: "2.0";
  readonly trace_id: string;
  readonly record_type: "Geometry";
  readonly dataset_kind: DatasetKind;
  readonly geometry_id: string;
  readonly role: "incident_scene" | "affected_area" | "warning_boundary" | "approximate_place";
  readonly geojson: { readonly type: "Point"; readonly coordinates: readonly [number, number] };
  readonly coordinate_reference_system: "OGC:CRS84";
  readonly precision_m: number | null;
  readonly precision_basis: "provider_accuracy" | "source_supplied" | "unknown";
  readonly display_label: string | null;
  readonly source_evidence: readonly GeometryEvidenceRef[];
}

export interface PetabencanaIngestPorts {
  readonly reportRevisions: {
    create(revision: NewReportRevisionInput): Promise<void>;
    createEvidenceReference(ref: NewEvidenceReferenceInput): Promise<string>;
  };
  readonly evidenceChunks: {
    persist(input: {
      readonly datasetKind: DatasetKind;
      readonly traceId: string;
      readonly reportRevisionId: string;
      readonly permittedTextHash: string;
      readonly normalizationVersion: string;
      readonly chunks: readonly EvidenceChunkInput[];
    }): Promise<unknown>;
  };
  readonly geometryWriter: {
    persist(geometry: IngestGeometryRecord): Promise<unknown>;
  };
}

export type PetabencanaIngestResult =
  | {
      readonly outcome: "completed";
      readonly empty: boolean;
      readonly reportCount: number;
      readonly chunkCount: number;
      readonly geometryCount: number;
      readonly evidenceReferenceCount: number;
      readonly reportRevisionIds: readonly string[];
    }
  | {
      readonly outcome: "failed";
      readonly code:
        | "invalid_timestamp"
        | "payload_too_large"
        | "invalid_payload"
        | "persistence_failed";
      readonly message: string;
    };

function isValidRfc3339(timestamp: unknown): timestamp is string {
  if (typeof timestamp !== "string") return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.exec(timestamp);
  if (!match) return false;
  const parsed = Date.parse(timestamp);
  return Number.isFinite(parsed);
}

function isInsideEnvelope(
  coordinates: GeoJsonPosition,
  envelope: typeof PETABENCANA_JAKARTA_ENVELOPE,
): boolean {
  const [lon, lat] = coordinates;
  return (
    Number.isFinite(lon) &&
    Number.isFinite(lat) &&
    lon >= envelope.west &&
    lon <= envelope.east &&
    lat >= envelope.south &&
    lat <= envelope.north
  );
}

export function formatPetabencanaReportText(report: PetabencanaReport): string {
  const status = report.providerStatus ?? "laporan warga";
  const reportType = report.reportType ?? "banjir";
  const parts: string[] = [
    `Laporan ${reportType} PetaBencana ID ${report.featureId}: status laporan ${status}.`,
  ];
  if (report.geometry && report.geometry.type === "Point") {
    const [lon, lat] = report.geometry.coordinates;
    parts.push(`Koordinat lokasi [${lon.toFixed(5)}, ${lat.toFixed(5)}].`);
  }
  if (report.sourceCreatedAt) {
    parts.push(`Waktu pembuatan laporan: ${report.sourceCreatedAt}.`);
  }
  return parts.join(" ");
}

async function sha256Hex(value: string): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error("Web Crypto subtle is unavailable");
  const digest = await subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function ingestPetabencanaGeoJson(
  input: PetabencanaIngestInput,
  ports: PetabencanaIngestPorts,
): Promise<PetabencanaIngestResult> {
  if (!isValidRfc3339(input.retrievedAt)) {
    return {
      outcome: "failed",
      code: "invalid_timestamp",
      message: "The caller-supplied retrieval timestamp must be a valid RFC3339 string.",
    };
  }

  const sourceId = input.sourceId ?? PETABENCANA_SOURCE_ID;

  let parsed: PetabencanaParseResult;
  try {
    parsed = parsePetabencanaGeoJson(input.geoJsonText, input.retrievedAt);
  } catch (error) {
    return {
      outcome: "failed",
      code: "invalid_payload",
      message: error instanceof Error ? error.message : "PetaBencana GeoJSON parsing failed",
    };
  }

  if (parsed.kind === "error") {
    return {
      outcome: "failed",
      code: parsed.error.kind === "malformed" ? "invalid_payload" : "payload_too_large",
      message: `PetaBencana parser error: ${parsed.error.code}`,
    };
  }

  if (parsed.kind === "empty" || parsed.reports.length === 0) {
    return {
      outcome: "completed",
      empty: true,
      reportCount: 0,
      chunkCount: 0,
      geometryCount: 0,
      evidenceReferenceCount: 0,
      reportRevisionIds: [],
    };
  }

  let reportCount = 0;
  let chunkCount = 0;
  let geometryCount = 0;
  let evidenceReferenceCount = 0;
  const reportRevisionIds: string[] = [];

  try {
    for (const report of parsed.reports) {
      if (report.featureId === null) continue;
      const rawFeatureId = String(report.featureId);

      // Validate coordinates within Jakarta coverage envelope
      if (report.geometry && report.geometry.type === "Point") {
        if (!isInsideEnvelope(report.geometry.coordinates, PETABENCANA_JAKARTA_ENVELOPE)) {
          continue; // Skip out-of-envelope reports outside DKI Jakarta
        }
      }

      const formattedText = formatPetabencanaReportText(report);
      const prepared: PreparedText = await preparePermittedText(formattedText);
      const codePointLength = Array.from(prepared.permittedText).length;

      const sanitizedId = rawFeatureId.replace(/[^A-Za-z0-9._:-]/g, "_");
      const reportRevisionId = `petabencana-report-${sanitizedId}`;
      const canonicalUrl = `${PETABENCANA_CANONICAL_BASE}report/${encodeURIComponent(rawFeatureId)}`;

      // Compute validity: 24 hours from sourceCreatedAt if available
      let validFrom: string | null = null;
      let validUntil: string | null = null;
      if (report.sourceCreatedAt && isValidRfc3339(report.sourceCreatedAt)) {
        validFrom = report.sourceCreatedAt;
        const validUntilMs = Date.parse(report.sourceCreatedAt) + 24 * 60 * 60 * 1000;
        validUntil = new Date(validUntilMs).toISOString();
      }

      const rawReportJson: Record<string, unknown> = {
        feature_id: rawFeatureId,
        provider_status: report.providerStatus,
        report_type: report.reportType,
        source_created_at: report.sourceCreatedAt,
        retrieved_at: report.retrievedAt,
        geometry: report.geometry,
      };

      const contentHash = await sha256Hex(JSON.stringify(rawReportJson));

      const revisionInput: NewReportRevisionInput = {
        datasetKind: input.datasetKind,
        reportRevisionId,
        traceId: input.traceId,
        sourceId,
        canonicalUrl,
        sourceRevisionKey: rawFeatureId,
        contentHash,
        permittedText: prepared.permittedText,
        permittedTextHash: prepared.permittedTextHash,
        normalizationVersion: prepared.normalizationVersion,
        publishedAt: null,
        observedAt: report.sourceCreatedAt && isValidRfc3339(report.sourceCreatedAt) ? report.sourceCreatedAt : null,
        retrievedAt: input.retrievedAt,
        validFrom,
        validUntil,
        supersedesId: null,
        revisionStatus: "unreviewed",
        recordJson: rawReportJson,
      };

      // 1. Create Report Revision
      await ports.reportRevisions.create(revisionInput);
      reportRevisionIds.push(reportRevisionId);
      reportCount += 1;

      // 2. Create Supporting Evidence Reference
      const refInput: NewEvidenceReferenceInput = {
        datasetKind: input.datasetKind,
        traceId: input.traceId,
        reportRevisionId,
        permittedTextHash: prepared.permittedTextHash,
        spanStart: 0,
        spanEnd: codePointLength,
        relation: "supports",
      };
      await ports.reportRevisions.createEvidenceReference(refInput);
      evidenceReferenceCount += 1;

      // 3. Chunk Permitted Text
      const chunks = await chunkPreparedText(input.datasetKind, reportRevisionId, prepared);
      await ports.evidenceChunks.persist({
        datasetKind: input.datasetKind,
        traceId: input.traceId,
        reportRevisionId,
        permittedTextHash: prepared.permittedTextHash,
        normalizationVersion: prepared.normalizationVersion,
        chunks,
      });
      chunkCount += chunks.length;

      // 4. Persist Geometry if Point is available
      if (report.geometry && report.geometry.type === "Point") {
        const [lon, lat] = report.geometry.coordinates;
        const geomRecord: IngestGeometryRecord = {
          schema_version: "2.0",
          trace_id: input.traceId,
          record_type: "Geometry",
          dataset_kind: input.datasetKind,
          geometry_id: `petabencana-geom-${sanitizedId}`,
          role: "incident_scene",
          geojson: {
            type: "Point",
            coordinates: [lon, lat],
          },
          coordinate_reference_system: "OGC:CRS84",
          precision_m: 10,
          precision_basis: "provider_accuracy",
          display_label: `Lokasi laporan banjir PetaBencana ${rawFeatureId}`,
          source_evidence: [
            {
              report_revision_id: reportRevisionId,
              permitted_text_hash: prepared.permittedTextHash,
              span_start: 0,
              span_end: codePointLength,
              offset_unit: "unicode_code_points",
              relation: "supports",
            },
          ],
        };

        await ports.geometryWriter.persist(geomRecord);
        geometryCount += 1;
      }
    }

    return {
      outcome: "completed",
      empty: reportCount === 0,
      reportCount,
      chunkCount,
      geometryCount,
      evidenceReferenceCount,
      reportRevisionIds,
    };
  } catch (error) {
    return {
      outcome: "failed",
      code: "persistence_failed",
      message: error instanceof Error ? error.message : "Persistence failed during ingestion",
    };
  }
}
