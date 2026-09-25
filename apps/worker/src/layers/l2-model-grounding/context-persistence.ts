import type { GroundingContextRecord, GroundingContextRepository } from "../../../../db/src/grounding-contexts.js";
import type { GroundingContext, ReasoningRequest } from "./contracts.js";
import { validateReasoningRequest } from "./validation.js";

export interface ReasoningContextPersistenceResult {
  readonly reasoningRequest: ReasoningRequest;
  readonly persistedRecord: GroundingContextRecord;
}

export interface ReasoningContextPersister {
  persist(request: unknown): Promise<ReasoningContextPersistenceResult>;
}

/**
 * Creates the injected boundary between the excerpt-bearing L2 request and
 * the canonical refs-only grounding-context repository record.
 */
export function createReasoningContextPersister(
  repository: GroundingContextRepository,
): ReasoningContextPersister {
  return {
    async persist(request: unknown): Promise<ReasoningContextPersistenceResult> {
      const reasoningRequest = await validateReasoningRequest(request);
      const record = toGroundingContextRecord(reasoningRequest.data.groundingContext);
      const persistedRecord = await repository.createOrVerify(record);
      return { reasoningRequest, persistedRecord };
    },
  };
}

function toGroundingContextRecord(context: GroundingContext): GroundingContextRecord {
  return {
    schema_version: context.schemaVersion,
    trace_id: context.traceId,
    record_type: context.recordType,
    dataset_kind: context.datasetKind,
    context_id: context.contextId,
    candidate_id: context.candidateId,
    evidence: context.evidence.map(({ reference }) => ({
      report_revision_id: reference.reportRevisionId,
      permitted_text_hash: reference.permittedTextHash,
      span_start: reference.spanStart,
      span_end: reference.spanEnd,
      offset_unit: reference.offsetUnit,
      relation: reference.relation,
    })),
    revision_states: context.revisionStates.map((state) => ({
      report_revision_id: state.reportRevisionId,
      revision_status: state.revisionStatus,
    })),
    candidate_events: context.candidateEvents.map((candidateEvent) => ({
      event_id: candidateEvent.eventId,
      event_version: candidateEvent.eventVersion,
    })),
    prior_decision_ids: [...context.priorDecisionIds],
    missing_fields: [...context.missingFields],
    conflicts: [...context.conflicts],
    retrieval_version: context.retrievalVersion,
    index_version: context.indexVersion,
    sufficient: context.sufficient,
  };
}
