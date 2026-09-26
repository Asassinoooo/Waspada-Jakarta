import type { GroundingContextRecord } from '../../../../db/src/grounding-contexts.js';
import type {
  BudgetLimits,
  CreateInvestigationInput,
  InvestigationCheckpointRecord,
  InvestigationLedgerRepository,
} from '../../../../db/src/investigation-ledger.js';
import type { InvestigationRequiredOutcome } from '../l2-model-grounding/direct-reasoning.js';

export interface InsufficientContextEntryCallerValues {
  readonly investigationId: string;
  readonly requestedAt: string;
  readonly policyVersion: string;
  readonly limits: BudgetLimits;
}

export type InsufficientContextReviewReason =
  | 'unsupported_outcome'
  | 'context_identity_mismatch'
  | 'context_not_insufficient'
  | 'invalid_candidate_events'
  | 'ambiguous_candidate_events'
  | 'invalid_question_input'
  | 'no_investigation_questions'
  | 'too_many_investigation_questions'
  | 'caller_values_missing';

export type InsufficientContextEntryResult =
  | {
      readonly status: 'opened';
      readonly checkpoint: InvestigationCheckpointRecord;
    }
  | {
      readonly status: 'review_required';
      readonly reason: InsufficientContextReviewReason;
    };

type InsufficientContextReviewRequired = Extract<InsufficientContextEntryResult, { readonly status: 'review_required' }>;

export interface InsufficientContextEntryService {
  open(
    outcome: InvestigationRequiredOutcome,
    callerValues: InsufficientContextEntryCallerValues,
  ): Promise<InsufficientContextEntryResult>;
}

/**
 * Opens or replays an L3 case from the persisted, insufficient result produced
 * by the L2 direct-reasoning service. Wrap the repository with
 * createTelemetryInvestigationLedgerRepository at composition time when write
 * telemetry is wanted; this adapter does not emit a second L3 event.
 */
export function createInsufficientContextEntryService(
  ledger: Pick<InvestigationLedgerRepository, 'create'>,
): InsufficientContextEntryService {
  return {
    async open(outcome, callerValues): Promise<InsufficientContextEntryResult> {
      const contextResult = readInvestigationRequiredContext(outcome);
      if (contextResult.status === 'review_required') return contextResult;

      const { context, persistedRecord } = contextResult;
      if (context.sufficient !== false || persistedRecord.sufficient !== false) {
        return reviewRequired('context_not_insufficient');
      }

      const candidateEvents: unknown = persistedRecord.candidate_events;
      if (!Array.isArray(candidateEvents)) return reviewRequired('invalid_candidate_events');
      if (candidateEvents.length > 1) return reviewRequired('ambiguous_candidate_events');

      let eventId: string | null = null;
      let eventVersion: number | null = null;
      if (candidateEvents.length === 1) {
        const candidateEvent = candidateEvents[0];
        if (!isRecord(candidateEvent)
          || typeof candidateEvent.event_id !== 'string'
          || typeof candidateEvent.event_version !== 'number'
          || !Number.isInteger(candidateEvent.event_version)) {
          return reviewRequired('invalid_candidate_events');
        }
        eventId = candidateEvent.event_id;
        eventVersion = candidateEvent.event_version;
      }

      const missingFields: unknown = persistedRecord.missing_fields;
      const conflicts: unknown = persistedRecord.conflicts;
      if (!Array.isArray(missingFields) || !Array.isArray(conflicts)) {
        return reviewRequired('invalid_question_input');
      }

      const questionCount = missingFields.length + conflicts.length;
      if (questionCount === 0) return reviewRequired('no_investigation_questions');
      if (questionCount > 20) return reviewRequired('too_many_investigation_questions');
      if (!hasExplicitCallerValues(callerValues)) return reviewRequired('caller_values_missing');

      const questions = [
        ...Array.from({ length: missingFields.length }, (_, index) => 'missing_field_' + (index + 1)),
        ...Array.from({ length: conflicts.length }, (_, index) => 'conflict_' + (index + 1)),
      ];
      const input: CreateInvestigationInput = {
        datasetKind: persistedRecord.dataset_kind,
        investigationId: callerValues.investigationId,
        traceId: persistedRecord.trace_id,
        candidateId: persistedRecord.candidate_id,
        contextId: persistedRecord.context_id,
        eventId,
        eventVersion,
        questions,
        policyVersion: callerValues.policyVersion,
        limits: callerValues.limits,
        requestedAt: callerValues.requestedAt,
      };

      const checkpoint = await ledger.create(input);
      return { status: 'opened', checkpoint };
    },
  };
}

function readInvestigationRequiredContext(
  outcome: unknown,
):
  | { readonly status: 'ok'; readonly context: Record<string, unknown>; readonly persistedRecord: GroundingContextRecord }
  | { readonly status: 'review_required'; readonly reason: InsufficientContextReviewReason } {
  if (!isRecord(outcome) || outcome.status !== 'investigation_required') {
    return reviewRequired('unsupported_outcome');
  }

  const reasoningRequest = outcome.reasoningRequest;
  if (!isRecord(reasoningRequest) || !isRecord(reasoningRequest.data)) {
    return reviewRequired('context_identity_mismatch');
  }
  const context = reasoningRequest.data.groundingContext;
  const persistedRecord = outcome.persistedRecord;
  if (!isRecord(context) || !isRecord(persistedRecord)) {
    return reviewRequired('context_identity_mismatch');
  }

  const identityMatches = context.schemaVersion === '2.0'
    && persistedRecord.schema_version === '2.0'
    && context.schemaVersion === persistedRecord.schema_version
    && context.recordType === 'GroundingContext'
    && persistedRecord.record_type === 'GroundingContext'
    && context.recordType === persistedRecord.record_type
    && typeof context.datasetKind === 'string'
    && context.datasetKind === persistedRecord.dataset_kind
    && typeof context.traceId === 'string'
    && context.traceId === persistedRecord.trace_id
    && typeof context.contextId === 'string'
    && context.contextId === persistedRecord.context_id
    && typeof context.candidateId === 'string'
    && context.candidateId === persistedRecord.candidate_id
    && typeof context.sufficient === 'boolean'
    && context.sufficient === persistedRecord.sufficient;

  if (!identityMatches) return reviewRequired('context_identity_mismatch');
  return {
    status: 'ok',
    context,
    persistedRecord: persistedRecord as unknown as GroundingContextRecord,
  };
}

function hasExplicitCallerValues(value: unknown): value is InsufficientContextEntryCallerValues {
  if (!isRecord(value)) return false;
  const requiredFields = ['investigationId', 'requestedAt', 'policyVersion', 'limits'];
  if (requiredFields.some((field) => !hasOwn(value, field) || value[field] === undefined)) return false;
  const limits = value.limits;
  if (!isRecord(limits)) return false;
  return ['toolAttempts', 'reasoningTurns', 'activeSeconds', 'modelTokens']
    .every((field) => hasOwn(limits, field) && limits[field] !== undefined);
}

function hasOwn(value: Record<string, unknown>, field: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, field);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function reviewRequired(reason: InsufficientContextReviewReason): InsufficientContextReviewRequired {
  return { status: 'review_required', reason };
}
