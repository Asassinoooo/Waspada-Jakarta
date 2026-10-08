import type { GroundingContextRecord } from '../../../../db/src/grounding-contexts.js';
import type { InvestigationCheckpointRecord } from '../../../../db/src/investigation-ledger.js';
import type { InvestigationRequiredOutcome } from '../l2-model-grounding/direct-reasoning.js';
import type {
  GroundingContext,
  DatasetKind,
} from '../l2-model-grounding/contracts.js';
import type { InsufficientContextEntryCallerValues } from './entry.js';

export interface InvestigationStepReplayKeys {
  /** Reuse these exact values when retrying the same coordinator invocation. */
  readonly reasoningReservationId: string;
  readonly reasoningReservedAt: string;
  /** Reuse this action reservation ID when retrying the same advance. */
  readonly actionReservationId: string;
}

export interface OpenInvestigationAdvance extends InvestigationStepReplayKeys {
  readonly kind: 'open';
  readonly outcome: InvestigationRequiredOutcome;
  readonly callerValues: InsufficientContextEntryCallerValues;
}

export interface ResumeInvestigationAdvance extends InvestigationStepReplayKeys {
  readonly kind: 'resume';
  /** The exact checkpoint returned to the caller by the prior advance. */
  readonly checkpoint: InvestigationCheckpointRecord;
  /** The persisted schema 2.0 L2 context identified by checkpoint.context_id. */
  readonly context: GroundingContext;
  readonly persistedRecord: GroundingContextRecord;
}

export interface SufficientContextAdvance {
  readonly kind: 'sufficient_context';
  /** Present when this sufficient result is associated with an existing investigation case. */
  readonly investigationId?: string;
  readonly context: GroundingContext;
  readonly persistedRecord: GroundingContextRecord;
}

export type InvestigationCoordinatorAdvanceInput =
  | OpenInvestigationAdvance
  | ResumeInvestigationAdvance
  | SufficientContextAdvance;

/**
 * L1/L2 boundary for one post-action refresh. Any new report must be ingested,
 * cleaned, extracted and persisted by L1, then persisted, retrieved and grounded
 * by L2 before this port returns. Raw report content never crosses this port.
 */
export interface L1L2ContextRefreshPort {
  refresh(input: {
    readonly datasetKind: DatasetKind;
    readonly investigationId: string;
    readonly traceId: string;
    readonly candidateId: string;
    readonly previousContextId: string;
    readonly eventId: string | null;
    readonly eventVersion: number | null;
    readonly outputReferenceIds: readonly string[];
  }): Promise<{
    readonly context: GroundingContext;
    readonly persistedRecord: GroundingContextRecord;
  }>;
}

export type InvestigationCoordinatorReviewReason =
  | 'invalid_input'
  | 'invalid_handoff'
  | 'entry_rejected'
  | 'insufficient_context_required'
  | 'invalid_context'
  | 'context_identity_mismatch'
  | 'case_not_found'
  | 'case_not_open'
  | 'stale_checkpoint'
  | 'budget_exhausted'
  | 'planner_abstained'
  | 'planner_timed_out'
  | 'planner_unavailable'
  | 'replayed_planner_step'
  | 'action_denied'
  | 'duplicate_action'
  | 'action_timed_out'
  | 'action_failed'
  | 'replayed_action_step'
  | 'action_uncertain'
  | 'refresh_failed'
  | 'invalid_refreshed_context'
  | 'material_dispute'
  | 'no_progress'
  | 'ledger_uncertain'
  | 'advance_review_pending';

export type InvestigationCoordinatorOutcome =
  | {
      readonly status: 'continue';
      readonly checkpoint: InvestigationCheckpointRecord;
      readonly context: GroundingContext;
      readonly persistedRecord: GroundingContextRecord;
    }
  | {
      readonly status: 'sufficient_context';
      readonly checkpoint?: InvestigationCheckpointRecord;
      readonly context: GroundingContext;
      readonly persistedRecord: GroundingContextRecord;
    }
  | {
      readonly status: 'review_required';
      readonly reason: InvestigationCoordinatorReviewReason;
      readonly checkpoint?: InvestigationCheckpointRecord;
    };

export interface InvestigationCoordinator {
  advance(input: InvestigationCoordinatorAdvanceInput): Promise<InvestigationCoordinatorOutcome>;
}
