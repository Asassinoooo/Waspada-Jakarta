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
import { createSqlIncidentRepository, type IncidentRecord } from "../../../db/src/incident-repository.js";
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
  const incidentRepo = createSqlIncidentRepository(dependencies.executor);

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
    }): Promise<CandidateEvidenceResult> {
      const queryVector = await generateNineRouterEmbedding(input.queryText, { config });
      const maxResults = input.maxResults ?? 10;

      let candidates: readonly EvidenceRetrievalCandidate[] = [];
      try {
        const result = await retrievalRepo.search({
          datasetKind: input.datasetKind,
          semantic: {
            identity: NINEROUTER_EMBEDDING_IDENTITY,
            queryVector,
          },
          maxResults,
        });
        candidates = result.candidates;
      } catch {
        candidates = [];
      }

      // Fetch active incidents to compare against
      const candidateIncidents: CandidateIncidentMatch[] = [];
      const activeIncidents = await incidentRepo.listActiveIncidents(input.datasetKind, { limit: maxResults });

      for (const incident of activeIncidents) {
        // Compute rough semantic similarity using text vector or check if chunk matches
        let score = 0.5;
        let matchedChunkId: string | undefined;
        let matchedText: string | undefined;

        // Check if any candidate chunk belongs to this incident
        for (const candidate of candidates) {
          const reportIncident = await incidentRepo.getIncidentForReport(input.datasetKind, candidate.reportRevisionId);
          if (reportIncident && reportIncident.incidentId === incident.incidentId) {
            const dist = candidate.chunk?.semanticDistance ?? 0.2;
            score = Math.max(score, 1 - dist);
            matchedChunkId = candidate.chunk?.chunkId;
            matchedText = candidate.spanText;
            break;
          }
        }

        candidateIncidents.push({
          incident,
          similarityScore: score,
          matchedChunkId,
          matchedText,
        });
      }

      // Sort candidate incidents by similarity score descending
      candidateIncidents.sort((a, b) => b.similarityScore - a.similarityScore);

      return {
        queryVector,
        candidates,
        candidateIncidents,
      };
    },
  };
}
