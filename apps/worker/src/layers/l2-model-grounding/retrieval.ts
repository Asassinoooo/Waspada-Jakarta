import type {
  EvidenceRetrievalQuery,
  EvidenceRetrievalRepository,
  EvidenceRetrievalResult,
} from '../../../../db/src/evidence-retrieval.js';
import {
  L2_RETRIEVAL_EVENT_NAME,
  noOpTelemetry,
  type L2RetrievalErrorTelemetryRecord,
  type L2RetrievalSuccessTelemetryRecord,
  type TelemetrySink,
} from '../l5-evaluation-monitoring/telemetry.js';

/** Layer 2 retrieval surface: reads persisted candidates and returns evidence only. */
export interface CandidateEvidenceRetriever {
  retrieve(query: EvidenceRetrievalQuery): Promise<EvidenceRetrievalResult>;
}

/**
 * Bind the Layer 2 retrieval boundary to an injected SQL-backed repository.
 * This adapter has no model, source, geocoder, persistence-write, or L3 tools.
 */
export function createCandidateEvidenceRetriever(
  repository: EvidenceRetrievalRepository,
  telemetry: TelemetrySink = noOpTelemetry,
): CandidateEvidenceRetriever {
  return {
    async retrieve(query) {
      const startedAt = performance.now();
      try {
        const result = await repository.search(query);
        safelyRecord(telemetry, {
          eventName: L2_RETRIEVAL_EVENT_NAME,
          outcome: 'success',
          durationMs: elapsedSince(startedAt),
          candidateCount: result.candidates.length,
          rowsExamined: result.rowsExamined,
          scanTruncated: result.scanTruncated,
          resultTruncated: result.resultTruncated,
          semanticStatus: result.semanticStatus,
        });
        return result;
      } catch (error) {
        safelyRecord(telemetry, {
          eventName: L2_RETRIEVAL_EVENT_NAME,
          outcome: 'error',
          durationMs: elapsedSince(startedAt),
        });
        throw error;
      }
    },
  };
}

function elapsedSince(startedAt: number): number {
  const durationMs = performance.now() - startedAt;
  return Number.isFinite(durationMs) ? Math.max(0, durationMs) : 0;
}

function safelyRecord(
  telemetry: TelemetrySink,
  record: L2RetrievalErrorTelemetryRecord | L2RetrievalSuccessTelemetryRecord,
): void {
  try {
    telemetry.record(record);
  } catch {
    // Telemetry must not change a successful retrieval or mask its repository error.
  }
}
