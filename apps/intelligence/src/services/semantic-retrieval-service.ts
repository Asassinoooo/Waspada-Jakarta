import { createHash } from "node:crypto";
import type { DatasetKind } from "../../../db/src/ports.js";
import type { SqlExecutor, TransactionalSqlExecutor } from "../../../db/src/sql.js";
import {
  createSqlEmbeddingRunRepository,
  type EmbeddingRunRecord,
} from "../../../db/src/embedding-runs.js";
import {
  createSqlEvidenceRetrievalRepository,
  type EvidenceRetrievalCandidate,
} from "../../../db/src/evidence-retrieval.js";
import type { IncidentRecord } from "../../../db/src/incident-repository.js";
import {
  generateNineRouterEmbedding,
  getNineRouterConfig,
  type NineRouterConfig,
} from "../providers/ninerouter-adapter.js";

export const NINEROUTER_EMBEDDING_IDENTITY = {
  provider: "9router",
  modelVersion: "gemini/gemini-embedding-2-preview",
  dimensions: 768,
  distanceMetric: "cosine" as const,
  vectorIndexVersion: "ninerouter:gemini-embedding-2:raw-768-cosine:v1",
};

export interface CandidateIncidentMatch {
  readonly incident: IncidentRecord;
  readonly similarityScore: number;
  readonly matchedChunkId?: string;
  readonly matchedText?: string;
  readonly matchedReportRevisionId?: string;
}

export interface CandidateEvidenceResult {
  readonly queryVector: readonly number[];
  readonly candidates: readonly EvidenceRetrievalCandidate[];
  readonly candidateIncidents: readonly CandidateIncidentMatch[];
}

export interface SemanticRetrievalService {
  generateAndPersistEmbedding(input: {
    readonly traceId: string;
    readonly datasetKind: DatasetKind;
    readonly chunkId: string;
    readonly chunkText: string;
    readonly createdAt?: string;
  }): Promise<readonly number[]>;

  retrieveCandidates(input: {
    readonly datasetKind: DatasetKind;
    readonly queryText: string;
    readonly maxResults?: number;
  }): Promise<CandidateEvidenceResult>;
}

export function createSemanticRetrievalService(dependencies: {
  readonly executor: SqlExecutor;
  readonly transactionalExecutor?: TransactionalSqlExecutor;
  readonly config?: NineRouterConfig;
}): SemanticRetrievalService {
  const config = dependencies.config ?? getNineRouterConfig();
  const retrievalRepo = createSqlEvidenceRetrievalRepository(dependencies.executor);

  return {
    async generateAndPersistEmbedding(input: {
      readonly traceId: string;
      readonly datasetKind: DatasetKind;
      readonly chunkId: string;
      readonly chunkText: string;
      readonly createdAt?: string;
    }): Promise<readonly number[]> {
      const vector = await generateNineRouterEmbedding(input.chunkText, { config });
      const hash = createHash("sha256").update(input.chunkText).digest("hex");
      const now = input.createdAt ?? new Date().toISOString();

      if (dependencies.transactionalExecutor) {
        const embeddingRepo = createSqlEmbeddingRunRepository(dependencies.transactionalExecutor);
        const record: EmbeddingRunRecord = {
          schema_version: "2.0",
          trace_id: input.traceId,
          record_type: "EmbeddingRun",
          dataset_kind: input.datasetKind,
          embedding_run_id: `emb-${input.chunkId}-${hash.slice(0, 16)}`,
          chunk_id: input.chunkId,
          capability: "embedding",
          provider: NINEROUTER_EMBEDDING_IDENTITY.provider,
          model_version: NINEROUTER_EMBEDDING_IDENTITY.modelVersion,
          dimensions: NINEROUTER_EMBEDDING_IDENTITY.dimensions,
          distance_metric: NINEROUTER_EMBEDDING_IDENTITY.distanceMetric,
          vector_index_version: NINEROUTER_EMBEDDING_IDENTITY.vectorIndexVersion,
          input_text_hash: hash,
          status: "available",
          created_at: now,
        };

        try {
          await embeddingRepo.createOrVerify(record, vector);
        } catch {
          // If chunk or trace is not in DB yet (e.g. lightweight pipeline or test), continue with computed vector
        }
      }

      return vector;
    },

    async retrieveCandidates(input: {
      readonly datasetKind: DatasetKind;
      readonly queryText: string;
      readonly maxResults?: number;
      readonly candidateThreshold?: number;
    }): Promise<CandidateEvidenceResult> {
      const queryVector = await generateNineRouterEmbedding(input.queryText, { config });
      const maxResults = input.maxResults ?? 10;
      const candidateThreshold = input.candidateThreshold ?? 0.40;
      const vectorLiteral = `[${queryVector.join(",")}]`;

      // 1. Direct pgvector search against active/monitoring/investigating incidents
      try {
        const directMatches = await dependencies.executor.query<{
          incident_id: string;
          dataset_kind: DatasetKind;
          title: string;
          description: string;
          incident_type: string;
          primary_category: string | null;
          status: string;
          severity: string;
          location_label: string | null;
          shape_geojson: string | null;
          event_time: unknown;
          first_observed_at: string | Date;
          last_updated_at: string | Date;
          discrepancies: unknown;
          uncertainty_notes: unknown;
          record_json: unknown;
          created_at: string | Date;
          chunk_id: string;
          report_revision_id: string;
          span_text: string | null;
          cosine_distance: string | number;
          similarity_score: string | number;
        }>(
          `SELECT
             i.incident_id,
             i.dataset_kind,
             i.title,
             i.description,
             i.incident_type,
             i.primary_category,
             i.status,
             i.severity,
             i.location_label,
             ST_AsGeoJSON(i.shape) AS shape_geojson,
             i.event_time,
             i.first_observed_at,
             i.last_updated_at,
             i.discrepancies,
             i.uncertainty_notes,
             i.record_json,
             i.created_at,
             c.chunk_id,
             c.report_revision_id,
             substr(rev.permitted_text, c.span_start + 1, c.span_end - c.span_start) AS span_text,
             (v.embedding <=> $1::vector) AS cosine_distance,
             (1.0 - (v.embedding <=> $1::vector)) AS similarity_score
           FROM waspada.embedding_vectors v
           JOIN waspada.embedding_runs r
             ON r.dataset_kind = v.dataset_kind AND r.embedding_run_id = v.embedding_run_id
           JOIN waspada.evidence_chunks c
             ON c.dataset_kind = r.dataset_kind AND c.chunk_id = r.chunk_id
           JOIN waspada.report_revisions rev
             ON rev.dataset_kind = c.dataset_kind AND rev.report_revision_id = c.report_revision_id
           JOIN waspada.incident_reports ir
             ON ir.dataset_kind = c.dataset_kind AND ir.report_revision_id = c.report_revision_id
           JOIN waspada.incidents i
             ON i.dataset_kind = ir.dataset_kind AND i.incident_id = ir.incident_id
           WHERE v.dataset_kind = $2
             AND r.status = 'available'
             AND i.status IN ('active', 'investigating', 'monitoring')
             AND (v.embedding <=> $1::vector) < $3
           ORDER BY v.embedding <=> $1::vector ASC
           LIMIT $4`,
          [vectorLiteral, input.datasetKind, candidateThreshold, maxResults * 2],
        );

        if (directMatches.rows.length > 0) {
          const incidentMap = new Map<string, {
            incident: IncidentRecord;
            bestDistance: number;
            similarityScore: number;
            matchedChunkId?: string;
            matchedText?: string;
            matchedReportRevisionId?: string;
          }>();

          for (const row of directMatches.rows) {
            const distance = typeof row.cosine_distance === "number" ? row.cosine_distance : parseFloat(String(row.cosine_distance));
            const sim = typeof row.similarity_score === "number" ? row.similarity_score : parseFloat(String(row.similarity_score));
            const existing = incidentMap.get(row.incident_id);
            if (!existing || distance < existing.bestDistance) {
              let coordinates: [number, number] | null = null;
              if (row.shape_geojson) {
                try {
                  const parsed = typeof row.shape_geojson === "string" ? JSON.parse(row.shape_geojson) : row.shape_geojson;
                  if (parsed && parsed.type === "Point" && Array.isArray(parsed.coordinates)) {
                    coordinates = [Number(parsed.coordinates[0]), Number(parsed.coordinates[1])];
                  }
                } catch {
                  // ignore malformed geometry
                }
              }

              const incident: IncidentRecord = {
                incidentId: row.incident_id,
                datasetKind: row.dataset_kind,
                title: row.title,
                description: row.description,
                incidentType: row.incident_type,
                primaryCategory: row.primary_category ?? null,
                status: row.status as any,
                severity: row.severity as any,
                locationLabel: row.location_label,
                coordinates,
                eventTime: (typeof row.event_time === "object" && row.event_time !== null ? row.event_time : {}) as Record<string, unknown>,
                firstObservedAt: new Date(row.first_observed_at).toISOString(),
                lastUpdatedAt: new Date(row.last_updated_at).toISOString(),
                discrepancies: Array.isArray(row.discrepancies) ? row.discrepancies : [],
                uncertaintyNotes: Array.isArray(row.uncertainty_notes) ? row.uncertainty_notes : [],
                recordJson: (typeof row.record_json === "object" && row.record_json !== null ? row.record_json : {}) as Record<string, unknown>,
                createdAt: new Date(row.created_at).toISOString(),
              };

              incidentMap.set(row.incident_id, {
                incident,
                bestDistance: distance,
                similarityScore: Math.max(0, Math.min(1, sim)),
                matchedChunkId: row.chunk_id,
                matchedText: row.span_text ?? undefined,
                matchedReportRevisionId: row.report_revision_id,
              });
            }
          }

          const candidateIncidents: CandidateIncidentMatch[] = Array.from(incidentMap.values())
            .map((match) => ({
              incident: match.incident,
              similarityScore: match.similarityScore,
              matchedChunkId: match.matchedChunkId,
              matchedText: match.matchedText,
              matchedReportRevisionId: match.matchedReportRevisionId,
            }))
            .sort((a, b) => b.similarityScore - a.similarityScore)
            .slice(0, maxResults);

          const candidates: EvidenceRetrievalCandidate[] = directMatches.rows.map((row) => ({
            datasetKind: row.dataset_kind,
            candidateId: `cand-${row.chunk_id}`,
            reportRevisionId: row.report_revision_id,
            permittedTextHash: "",
            evidenceReferenceId: `ref-${row.chunk_id}`,
            spanStart: 0,
            spanEnd: (row.span_text ?? "").length,
            offsetUnit: "unicode_code_points",
            relation: "supports",
            spanText: row.span_text ?? "",
            spanTextStart: 0,
            spanTextEnd: (row.span_text ?? "").length,
            spanTextTruncated: false,
            revisionStatus: "unreviewed",
            source: {
              sourceId: "source-unknown",
              displayName: "Source",
              sourceKind: "other",
              publisherGroupId: null,
              registryStatus: "active",
              approvalStatus: "approved",
              healthStatus: "healthy",
            },
            publishedAt: null,
            observedAt: null,
            retrievedAt: new Date().toISOString(),
            validFrom: null,
            validUntil: null,
            eventTime: {
              start: null,
              end: null,
              precision: null,
              status: "unknown",
            },
            origins: [],
            originLineageStatus: "unknown",
            geometryMatches: [],
            matchFacets: {
              identifiers: [],
              audienceIds: [],
              exactTerms: [],
              reportTimeFields: [],
              eventTime: false,
              geometry: false,
              semanticDistance: Number(row.cosine_distance),
            },
            chunk: {
              chunkId: row.chunk_id,
              permittedTextHash: "",
              chunkTextHash: "",
              spanStart: 0,
              spanEnd: (row.span_text ?? "").length,
              chunkerVersion: "v1",
              embeddingStatus: "matched",
              embeddingRunId: null,
              embeddingProvider: NINEROUTER_EMBEDDING_IDENTITY.provider,
              embeddingModelVersion: NINEROUTER_EMBEDDING_IDENTITY.modelVersion,
              embeddingDimensions: NINEROUTER_EMBEDDING_IDENTITY.dimensions,
              embeddingDistanceMetric: NINEROUTER_EMBEDDING_IDENTITY.distanceMetric,
              embeddingIndexVersion: NINEROUTER_EMBEDDING_IDENTITY.vectorIndexVersion,
              semanticDistance: Number(row.cosine_distance),
            },
          }));

          return {
            queryVector,
            candidates,
            candidateIncidents,
          };
        }
      } catch {
        // Fall back to retrievalRepo.search if direct incident table join fails
      }

      // Fallback: search candidate evidence chunks via extraction retrievalRepo
      const result = await retrievalRepo.search({
        datasetKind: input.datasetKind,
        semantic: {
          identity: NINEROUTER_EMBEDDING_IDENTITY,
          queryVector,
        },
        maxResults,
      });
      const candidates = result.candidates;

      if (candidates.length === 0) {
        // Fallback: Lexical matching against active incidents in waspada.incidents
        try {
          const activeIncidents = await dependencies.executor.query<{
            incident_id: string;
            dataset_kind: DatasetKind;
            title: string;
            description: string;
            incident_type: string;
            primary_category: string | null;
            status: string;
            severity: string;
            location_label: string | null;
            shape_geojson: string | null;
            event_time: unknown;
            first_observed_at: string | Date;
            last_updated_at: string | Date;
            discrepancies: unknown;
            uncertainty_notes: unknown;
            record_json: unknown;
            created_at: string | Date;
          }>(
            `SELECT
               i.incident_id, i.dataset_kind, i.title, i.description, i.incident_type, i.primary_category,
               i.status, i.severity, i.location_label, ST_AsGeoJSON(i.shape) AS shape_geojson,
               i.event_time, i.first_observed_at, i.last_updated_at, i.discrepancies,
               i.uncertainty_notes, i.record_json, i.created_at
             FROM waspada.incidents i
             WHERE i.dataset_kind = $1 AND i.status IN ('active', 'investigating', 'monitoring')
             ORDER BY i.last_updated_at DESC
             LIMIT 20`,
            [input.datasetKind],
          );

          if (activeIncidents.rows.length > 0) {
            const queryWords = new Set(
              input.queryText.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((w) => w.length > 2),
            );

            const matches: CandidateIncidentMatch[] = [];
            for (const row of activeIncidents.rows) {
              const incText = `${row.title} ${row.description} ${row.location_label ?? ""}`.toLowerCase();
              const incWords = incText.replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((w) => w.length > 2);
              let common = 0;
              for (const w of incWords) {
                if (queryWords.has(w)) common++;
              }
              const sim = common / Math.max(1, queryWords.size);
              if (sim >= 0.10) {
                let coordinates: [number, number] | null = null;
                if (row.shape_geojson) {
                  try {
                    const parsed = typeof row.shape_geojson === "string" ? JSON.parse(row.shape_geojson) : row.shape_geojson;
                    if (parsed && parsed.type === "Point" && Array.isArray(parsed.coordinates)) {
                      coordinates = [Number(parsed.coordinates[0]), Number(parsed.coordinates[1])];
                    }
                  } catch {
                    // ignore
                  }
                }

                matches.push({
                  incident: {
                    incidentId: row.incident_id,
                    datasetKind: row.dataset_kind,
                    title: row.title,
                    description: row.description,
                    incidentType: row.incident_type,
                    primaryCategory: row.primary_category ?? null,
                    status: row.status as any,
                    severity: row.severity as any,
                    locationLabel: row.location_label,
                    coordinates,
                    eventTime: (typeof row.event_time === "object" && row.event_time !== null ? row.event_time : {}) as Record<string, unknown>,
                    firstObservedAt: new Date(row.first_observed_at).toISOString(),
                    lastUpdatedAt: new Date(row.last_updated_at).toISOString(),
                    discrepancies: Array.isArray(row.discrepancies) ? row.discrepancies : [],
                    uncertaintyNotes: Array.isArray(row.uncertainty_notes) ? row.uncertainty_notes : [],
                    recordJson: (typeof row.record_json === "object" && row.record_json !== null ? row.record_json : {}) as Record<string, unknown>,
                    createdAt: new Date(row.created_at).toISOString(),
                  },
                  similarityScore: Math.min(1.0, 0.60 + sim * 0.40),
                  matchedText: row.title,
                });
              }
            }

            if (matches.length > 0) {
              matches.sort((a, b) => b.similarityScore - a.similarityScore);
              return {
                queryVector,
                candidates: [],
                candidateIncidents: matches.slice(0, maxResults),
              };
            }
          }
        } catch {
          // ignore fallback error
        }

        return {
          queryVector,
          candidates: [],
          candidateIncidents: [],
        };
      }

      // 2. Extract unique report revision IDs from retrieved candidates
      const reportRevisionIds = Array.from(new Set(candidates.map((c) => c.reportRevisionId)));

      // 3. Single bulk query linking retrieved reports to their persistent incidents
      const incidentRows = await dependencies.executor.query<{
        incident_id: string;
        dataset_kind: DatasetKind;
        title: string;
        description: string;
        incident_type: string;
        primary_category: string | null;
        status: string;
        severity: string;
        location_label: string | null;
        shape_geojson: string | null;
        event_time: unknown;
        first_observed_at: string | Date;
        last_updated_at: string | Date;
        discrepancies: unknown;
        uncertainty_notes: unknown;
        record_json: unknown;
        created_at: string | Date;
        report_revision_id: string;
        relationship: string;
      }>(
        `SELECT
           i.incident_id, i.dataset_kind, i.title, i.description, i.incident_type, i.primary_category,
           i.status, i.severity, i.location_label, ST_AsGeoJSON(i.shape) AS shape_geojson,
           i.event_time, i.first_observed_at, i.last_updated_at, i.discrepancies,
           i.uncertainty_notes, i.record_json, i.created_at,
           r.report_revision_id, r.relationship
         FROM waspada.incidents i
         JOIN waspada.incident_reports r
           ON r.dataset_kind = i.dataset_kind AND r.incident_id = i.incident_id
         WHERE r.dataset_kind = $1 AND r.report_revision_id = ANY($2::text[])`,
        [input.datasetKind, reportRevisionIds],
      );

      // Build map from reportRevisionId -> incident and map from incidentId -> IncidentRecord
      const reportToIncidentId = new Map<string, string>();
      const incidentMap = new Map<string, IncidentRecord>();

      for (const row of incidentRows.rows) {
        reportToIncidentId.set(row.report_revision_id, row.incident_id);
        if (!incidentMap.has(row.incident_id)) {
          let coordinates: [number, number] | null = null;
          if (row.shape_geojson) {
            try {
              const parsed = typeof row.shape_geojson === "string" ? JSON.parse(row.shape_geojson) : row.shape_geojson;
              if (parsed && parsed.type === "Point" && Array.isArray(parsed.coordinates)) {
                coordinates = [Number(parsed.coordinates[0]), Number(parsed.coordinates[1])];
              }
            } catch {
              // ignore malformed geometry
            }
          }

          incidentMap.set(row.incident_id, {
            incidentId: row.incident_id,
            datasetKind: row.dataset_kind,
            title: row.title,
            description: row.description,
            incidentType: row.incident_type,
            primaryCategory: row.primary_category ?? null,
            status: row.status as any,
            severity: row.severity as any,
            locationLabel: row.location_label,
            coordinates,
            eventTime: (typeof row.event_time === "object" && row.event_time !== null ? row.event_time : {}) as Record<string, unknown>,
            firstObservedAt: new Date(row.first_observed_at).toISOString(),
            lastUpdatedAt: new Date(row.last_updated_at).toISOString(),
            discrepancies: Array.isArray(row.discrepancies) ? row.discrepancies : [],
            uncertaintyNotes: Array.isArray(row.uncertainty_notes) ? row.uncertainty_notes : [],
            recordJson: (typeof row.record_json === "object" && row.record_json !== null ? row.record_json : {}) as Record<string, unknown>,
            createdAt: new Date(row.created_at).toISOString(),
          });
        }
      }

      // Group candidate chunks by incident and find best matching chunk per incident
      const incidentMatches = new Map<string, {
        incident: IncidentRecord;
        bestDistance: number;
        matchedChunkId?: string;
        matchedText?: string;
        matchedReportRevisionId?: string;
      }>();

      for (const candidate of candidates) {
        const incidentId = reportToIncidentId.get(candidate.reportRevisionId);
        if (!incidentId) continue;
        const incident = incidentMap.get(incidentId);
        if (!incident) continue;

        const distance = candidate.chunk?.semanticDistance ?? 1.0;
        const existing = incidentMatches.get(incidentId);
        if (!existing || distance < existing.bestDistance) {
          incidentMatches.set(incidentId, {
            incident,
            bestDistance: distance,
            matchedChunkId: candidate.chunk?.chunkId,
            matchedText: candidate.spanText,
            matchedReportRevisionId: candidate.reportRevisionId,
          });
        }
      }

      // Transform into CandidateIncidentMatch[] with genuine similarity score
      const candidateIncidents: CandidateIncidentMatch[] = Array.from(incidentMatches.values()).map((match: any) => ({
        incident: match.incident,
        similarityScore: Math.max(0, Math.min(1, 1 - match.bestDistance)),
        matchedChunkId: match.matchedChunkId,
        matchedText: match.matchedText,
        matchedReportRevisionId: match.matchedReportRevisionId,
      }));

      // Sort by similarity score descending
      candidateIncidents.sort((a, b) => b.similarityScore - a.similarityScore);

      return {
        queryVector,
        candidates,
        candidateIncidents,
      };
    },
  };
}
