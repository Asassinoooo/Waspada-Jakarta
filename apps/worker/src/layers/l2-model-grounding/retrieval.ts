import type {
  EvidenceRetrievalQuery,
  EvidenceRetrievalRepository,
  EvidenceRetrievalResult,
} from '../../../../db/src/evidence-retrieval.js';

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
): CandidateEvidenceRetriever {
  return {
    retrieve(query) {
      return repository.search(query);
    },
  };
}
