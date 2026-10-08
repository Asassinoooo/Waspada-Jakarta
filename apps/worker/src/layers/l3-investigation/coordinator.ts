import {
  InvestigationLedgerError,
  type ActionOutcome,
  type AdvanceReviewPendingRecord,
  type InvestigationCheckpointRecord,
  type InvestigationLedgerRepository,
  type MarkAdvanceReviewPendingInput,
  type InvestigationProgressSnapshotRecord,
  type ReservationRecord,
  type InvestigationStopReason,
} from '../../../../db/src/investigation-ledger.js';
import type { GroundingContextRecord } from '../../../../db/src/grounding-contexts.js';
import type { DatasetKind } from '../../../../db/src/ports.js';
import {
  INVESTIGATION_PLAN_VERSION,
  type InvestigationActionMenuEntry,
  type InvestigationPlanRequest,
  type ProposedInvestigationAction,
} from '../l2-model-grounding/investigation-planner.js';
import type { GroundingContext } from '../l2-model-grounding/contracts.js';
import { validateReasoningRequest } from '../l2-model-grounding/validation.js';
import {
  type L3FingerprintService,
} from './progress-fingerprint.js';
import type { InsufficientContextEntryService } from './entry.js';
import type { ReasoningStepExecutor } from './reasoning-step-executor.js';
import type { SingleStepExecutor } from './single-step-executor.js';
import type {
  InvestigationCoordinator,
  InvestigationCoordinatorAdvanceInput,
  InvestigationCoordinatorOutcome,
  InvestigationCoordinatorReviewReason,
  L1L2ContextRefreshPort,
} from './contracts.js';

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const ACTION_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/;
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
// This bounded RFC3339 app profile matches the L2 timestamp contract: at most 40 code units
// and 1–9 fractional digits. It intentionally rejects leap seconds and longer RFC3339 fractions.
// Use it only for the planner checkpoint and trusted action clock, not existing caller timestamps.
const RFC3339_TIMESTAMP_PATTERN = /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?([Zz]|([+-])(\d{2}):(\d{2}))$/;
const MAX_RFC3339_TIMESTAMP_LENGTH = 40;
const MAX_QUESTIONS = 20;
const KNOWN_PREWRITE_PROGRESS_ERRORS: ReadonlySet<InvestigationLedgerError['code']> = new Set([
  'investigation_not_found', 'invalid_state', 'stale_checkpoint', 'reservation_in_flight',
]);

interface ParsedRfc3339Instant {
  /** Whole Unix seconds after applying the timestamp's numeric UTC offset. */
  readonly epochSeconds: number;
  /** Fractional second with insignificant trailing zeros removed. */
  readonly fractionalSecond: string;
}

export interface InvestigationCoordinatorOptions {
  readonly entry: InsufficientContextEntryService;
  readonly ledger: InvestigationLedgerRepository;
  readonly fingerprints: L3FingerprintService;
  readonly reasoningStep: ReasoningStepExecutor;
  readonly singleStep: SingleStepExecutor;
  readonly refreshPort: L1L2ContextRefreshPort;
  readonly actionMenu: readonly InvestigationActionMenuEntry[];
  /** Trusted wall clock used for progress and stop timestamps. */
  readonly wallNow: () => string;
}

type ValidatedContextPair = {
  readonly context: GroundingContext;
  readonly persistedRecord: GroundingContextRecord;
};

/** Compose one bounded L3 advance from the durable and injected layer ports. */
export function createInvestigationCoordinator(
  options: InvestigationCoordinatorOptions,
): InvestigationCoordinator {
  const actionMenu = copyTrustedActionMenu(options.actionMenu);

  const pendingOutcome = async (
    datasetKind: DatasetKind,
    investigationId: string,
    fallbackCheckpoint?: InvestigationCheckpointRecord,
  ): Promise<InvestigationCoordinatorOutcome | undefined> => {
    let marker: AdvanceReviewPendingRecord | null;
    try {
      marker = await options.ledger.getAdvanceReviewPending(datasetKind, investigationId);
    } catch {
      return review('ledger_uncertain', fallbackCheckpoint);
    }
    if (!marker) return undefined;

    let checkpoint = fallbackCheckpoint;
    try {
      const latest = await options.ledger.getLatest(datasetKind, investigationId);
      if (latest) checkpoint = latest;
    } catch {
      // The marker is sufficient to stop; the latest checkpoint is optional output context.
    }
    return review('advance_review_pending', checkpoint);
  };

  const latchReview = async (
    input: MarkAdvanceReviewPendingInput,
    fallbackCheckpoint?: InvestigationCheckpointRecord,
  ): Promise<InvestigationCoordinatorOutcome> => {
    try {
      await options.ledger.markAdvanceReviewPending(input);
      let checkpoint = fallbackCheckpoint;
      try {
        const latest = await options.ledger.getLatest(input.datasetKind, input.investigationId);
        if (latest) checkpoint = latest;
      } catch {
        // The durable marker is the gate; checkpoint detail is best-effort output context.
      }
      return review('advance_review_pending', checkpoint);
    } catch {
      return await pendingOutcome(input.datasetKind, input.investigationId, fallbackCheckpoint)
        ?? review('ledger_uncertain', fallbackCheckpoint);
    }
  };

  const latchIfReservationExists = async (
    input: Omit<MarkAdvanceReviewPendingInput, 'reservationId'> & { readonly reservationId: string },
    fallbackCheckpoint?: InvestigationCheckpointRecord,
  ): Promise<InvestigationCoordinatorOutcome | undefined> => {
    let reservation: ReservationRecord | null;
    try {
      reservation = await options.ledger.getActionReservation(
        input.datasetKind,
        input.investigationId,
        input.reservationId,
      );
    } catch {
      // A failed preliminary read is not proof that the reservation is absent. The
      // locked marker writer revalidates exact reservation lineage before inserting.
      return await latchReview(input, fallbackCheckpoint);
    }
    if (!reservation || reservation.investigationId !== input.investigationId
      || reservation.status === 'released') return undefined;
    return latchReview(input, fallbackCheckpoint);
  };

  return {
    async advance(rawInput: InvestigationCoordinatorAdvanceInput): Promise<InvestigationCoordinatorOutcome> {
      try {
        if (!actionMenu) return review('invalid_input');
        if (!isRecord(rawInput)) return review('invalid_input');

        if (rawInput.kind === 'sufficient_context') {
          const contextPair = await validateContextPair(rawInput.context, rawInput.persistedRecord);
          if (!contextPair) return review('invalid_context');
          if (!contextPair.context.sufficient) return review('invalid_context');
          if (rawInput.investigationId !== undefined) {
            if (!isId(rawInput.investigationId)) return review('invalid_input');
            const pending = await pendingOutcome(contextPair.context.datasetKind, rawInput.investigationId);
            if (pending) return pending;
          }
          return {
            status: 'sufficient_context',
            context: contextPair.context,
            persistedRecord: contextPair.persistedRecord,
          };
        }

        const replayKeys = parseReplayKeys(rawInput);
        if (!replayKeys) return review('invalid_input');

        let contextPair: ValidatedContextPair | undefined;
        let checkpoint: InvestigationCheckpointRecord | undefined;

        if (rawInput.kind === 'open') {
          const pairFromHandoff = await readHandoffContextPair(rawInput.outcome);
          if (!pairFromHandoff) return review('invalid_handoff');
          if (pairFromHandoff.context.sufficient) return review('insufficient_context_required');
          contextPair = pairFromHandoff;
          const callerInvestigationId = readDataProperty(rawInput.callerValues, 'investigationId');
          if (isId(callerInvestigationId)) {
            const pending = await pendingOutcome(pairFromHandoff.context.datasetKind, callerInvestigationId);
            if (pending) return pending;
          }
          let opened;
          try {
            opened = await options.entry.open(rawInput.outcome, rawInput.callerValues);
          } catch {
            if (isId(callerInvestigationId)) {
              const pending = await pendingOutcome(pairFromHandoff.context.datasetKind, callerInvestigationId);
              if (pending) return pending;
            }
            return review('entry_rejected');
          }
          if (opened.status !== 'opened') return review('entry_rejected');
          if (!isCheckpoint(opened.checkpoint)) return review('ledger_uncertain');
          const pending = await pendingOutcome(opened.checkpoint.dataset_kind, opened.checkpoint.investigation_id,
            opened.checkpoint);
          if (pending) return pending;
          // A progressed replay must be resumed with its returned checkpoint and context.
          if (opened.checkpoint.checkpoint_version !== 1) {
            return review('stale_checkpoint', opened.checkpoint);
          }
          checkpoint = await options.ledger.getLatest(
            opened.checkpoint.dataset_kind,
            opened.checkpoint.investigation_id,
          ) ?? undefined;
          if (!checkpoint) return review('case_not_found');
          if (checkpoint.checkpoint_version !== opened.checkpoint.checkpoint_version
            || checkpoint.checkpoint_id !== opened.checkpoint.checkpoint_id) {
            return review('stale_checkpoint', checkpoint);
          }
        } else if (rawInput.kind === 'resume') {
          contextPair = await validateContextPair(rawInput.context, rawInput.persistedRecord);
          if (!contextPair) return review('invalid_context');
          if (!isCheckpoint(rawInput.checkpoint)) return review('invalid_input');
          const suppliedCheckpoint = rawInput.checkpoint;
          const pending = await pendingOutcome(
            suppliedCheckpoint.dataset_kind,
            suppliedCheckpoint.investigation_id,
            suppliedCheckpoint,
          );
          if (pending) return pending;
          checkpoint = await options.ledger.getLatest(
            suppliedCheckpoint.dataset_kind,
            suppliedCheckpoint.investigation_id,
          ) ?? undefined;
          if (!checkpoint) return review('case_not_found');
          if (!sameCheckpointVersionIdentity(suppliedCheckpoint, checkpoint)) {
            return review('stale_checkpoint', checkpoint);
          }
          if (!sameCaseIdentity(checkpoint, contextPair.context)) {
            return review('context_identity_mismatch', checkpoint);
          }
          if (checkpoint.context_id !== contextPair.context.contextId) {
            return review('context_identity_mismatch', checkpoint);
          }
          if (contextPair.context.sufficient) {
            return {
              status: 'sufficient_context',
              checkpoint,
              context: contextPair.context,
              persistedRecord: contextPair.persistedRecord,
            };
          }
        } else {
          return review('invalid_input');
        }

        if (!checkpoint || !contextPair) return review('ledger_uncertain', checkpoint);
        if (checkpoint.case_status !== 'open') return review('case_not_open', checkpoint);
        const identity = planIdentity(checkpoint, contextPair.context);
        if (!identity) return review('context_identity_mismatch', checkpoint);
        if (identity.questions.length < 1 || identity.questions.length > MAX_QUESTIONS) {
          return review('invalid_context', checkpoint);
        }

        const request: InvestigationPlanRequest = {
          schemaVersion: INVESTIGATION_PLAN_VERSION,
          recordType: 'InvestigationPlanRequest',
          groundingContext: contextPair.context,
          questions: identity.questions,
          actionMenu,
        };
        let planning;
        try {
          planning = await options.reasoningStep.plan({
            datasetKind: checkpoint.dataset_kind,
            investigationId: checkpoint.investigation_id,
            expectedCheckpointVersion: checkpoint.checkpoint_version,
            reservationId: replayKeys.reasoningReservationId,
            reservedAt: replayKeys.reasoningReservedAt,
            request,
          });
        } catch {
          const pending = await pendingOutcome(checkpoint.dataset_kind, checkpoint.investigation_id, checkpoint);
          if (pending) return pending;
          return await reviewAndStop('planner_unavailable', checkpoint);
        }

        if (planning.status === 'replayed') {
          const latched = await latchIfReservationExists({
            datasetKind: checkpoint.dataset_kind,
            investigationId: checkpoint.investigation_id,
            observedCheckpointVersion: checkpoint.checkpoint_version,
            stage: 'planning',
            reason: 'planner_replayed',
            reservationId: replayKeys.reasoningReservationId,
          }, planning.checkpoint);
          if (latched) return latched;
          return await reviewAndStop('replayed_planner_step', planning.checkpoint);
        }
        if (planning.status === 'review_required') {
          if (planning.reason === 'reservation_state_uncertain'
            || planning.reason === 'start_not_authorized'
            || planning.reason === 'reconciliation_uncertain'
            || planning.reason === 'reservation_replayed') {
            const latched = await latchIfReservationExists({
              datasetKind: checkpoint.dataset_kind,
              investigationId: checkpoint.investigation_id,
              observedCheckpointVersion: checkpoint.checkpoint_version,
              stage: 'planning',
              reason: 'planner_result_uncertain',
              reservationId: replayKeys.reasoningReservationId,
            }, planning.checkpoint ?? checkpoint);
            if (latched) return latched;
          }
          const reason = mapPlannerReviewReason(planning.reason);
          return await reviewAndMaybeStop(reason, planning.checkpoint ?? checkpoint);
        }
        if (planning.status !== 'proposed') return await reviewAndStop('planner_unavailable', checkpoint);
        if (!isCheckpoint(planning.checkpoint)) {
          return await latchIfReservationExists({
            datasetKind: checkpoint.dataset_kind,
            investigationId: checkpoint.investigation_id,
            observedCheckpointVersion: checkpoint.checkpoint_version,
            stage: 'planning',
            reason: 'planner_result_uncertain',
            reservationId: replayKeys.reasoningReservationId,
          }, checkpoint) ?? review('ledger_uncertain', checkpoint);
        }
        if (planning.checkpoint.case_status !== 'open'
          || !sameCaseIdentity(planning.checkpoint, contextPair.context)
          || planning.checkpoint.checkpoint_version !== checkpoint.checkpoint_version + 2
          || planning.checkpoint.context_id !== contextPair.context.contextId) {
          // A proposed result means the planner executor already reconciled this exact
          // reasoning reservation. Its next checkpoint must be the expected open state;
          // a contradictory checkpoint is a post-stage uncertainty, not a stale retry.
          return await latchIfReservationExists({
            datasetKind: checkpoint.dataset_kind,
            investigationId: checkpoint.investigation_id,
            observedCheckpointVersion: checkpoint.checkpoint_version,
            stage: 'planning',
            reason: 'planner_result_uncertain',
            reservationId: replayKeys.reasoningReservationId,
          }, checkpoint) ?? review('ledger_uncertain', checkpoint);
        }

        const pendingAfterPlanning = await pendingOutcome(
          planning.checkpoint.dataset_kind,
          planning.checkpoint.investigation_id,
          planning.checkpoint,
        );
        if (pendingAfterPlanning) return pendingAfterPlanning;

        const proposal = parseProposedAction(planning.proposal, actionMenu);
        if (!proposal) {
          return await latchIfReservationExists({
            datasetKind: planning.checkpoint.dataset_kind,
            investigationId: planning.checkpoint.investigation_id,
            observedCheckpointVersion: planning.checkpoint.checkpoint_version,
            stage: 'planning',
            reason: 'planner_result_uncertain',
            reservationId: replayKeys.reasoningReservationId,
          }, planning.checkpoint) ?? review('invalid_context', planning.checkpoint);
        }
        const plannerCheckpointTime = parseRfc3339Instant(planning.checkpoint.updated_at);
        if (!plannerCheckpointTime) {
          return await latchIfReservationExists({
            datasetKind: planning.checkpoint.dataset_kind,
            investigationId: planning.checkpoint.investigation_id,
            observedCheckpointVersion: planning.checkpoint.checkpoint_version,
            stage: 'planning',
            reason: 'planner_result_uncertain',
            reservationId: replayKeys.reasoningReservationId,
          }, planning.checkpoint) ?? review('ledger_uncertain', planning.checkpoint);
        }
        const actionReservedAt = safeWallNow(options.wallNow);
        const actionReservedTime = parseRfc3339Instant(actionReservedAt);
        if (!actionReservedAt || !actionReservedTime
          || compareRfc3339Instants(actionReservedTime, plannerCheckpointTime) < 0) {
          return latchReview({
            datasetKind: planning.checkpoint.dataset_kind,
            investigationId: planning.checkpoint.investigation_id,
            observedCheckpointVersion: planning.checkpoint.checkpoint_version,
            stage: 'planning',
            reason: 'invalid_action_timestamp',
            reservationId: replayKeys.reasoningReservationId,
          }, planning.checkpoint);
        }

        let actionResult;
        try {
          actionResult = await options.singleStep.execute({
            datasetKind: planning.checkpoint.dataset_kind,
            investigationId: planning.checkpoint.investigation_id,
            expectedCheckpointVersion: planning.checkpoint.checkpoint_version,
            reservationId: replayKeys.actionReservationId,
            reservedAt: actionReservedAt,
            actionName: proposal.actionName,
            input: proposal.input,
          });
        } catch (error) {
          if (error instanceof InvestigationLedgerError && error.code === 'advance_review_pending') {
            return review('advance_review_pending', planning.checkpoint);
          }
          const pending = await pendingOutcome(
            planning.checkpoint.dataset_kind,
            planning.checkpoint.investigation_id,
            planning.checkpoint,
          );
          if (pending) return pending;
          if (error instanceof InvestigationLedgerError && error.code === 'budget_exhausted') {
            return await reviewAndStop('budget_exhausted', planning.checkpoint);
          }
          if (error instanceof InvestigationLedgerError && error.code === 'duplicate_action') {
            return await reviewAndStop('duplicate_action', planning.checkpoint);
          }
          if (!(error instanceof InvestigationLedgerError)
            || (error.code !== 'reservation_in_flight'
              && error.code !== 'stale_checkpoint'
              && error.code !== 'invalid_state'
              && error.code !== 'reservation_conflict')) {
            const latched = await latchIfReservationExists({
              datasetKind: planning.checkpoint.dataset_kind,
              investigationId: planning.checkpoint.investigation_id,
              observedCheckpointVersion: planning.checkpoint.checkpoint_version,
              stage: 'action',
              reason: 'action_result_uncertain',
              reservationId: replayKeys.actionReservationId,
            }, planning.checkpoint);
            if (latched) return latched;
          }
          return await reviewAndStop('action_uncertain', planning.checkpoint);
        }

        if (!isRecord(actionResult)
          || !['replayed', 'denied', 'review_required', 'executed'].includes(
            readDataProperty(actionResult, 'status') as string,
          )) {
          return await latchIfReservationExists({
            datasetKind: planning.checkpoint.dataset_kind,
            investigationId: planning.checkpoint.investigation_id,
            observedCheckpointVersion: planning.checkpoint.checkpoint_version,
            stage: 'action',
            reason: 'invalid_action_result',
            reservationId: replayKeys.actionReservationId,
          }, planning.checkpoint) ?? review('action_uncertain', planning.checkpoint);
        }

        if (actionResult.status === 'replayed') {
          const latched = await latchIfReservationExists({
            datasetKind: planning.checkpoint.dataset_kind,
            investigationId: planning.checkpoint.investigation_id,
            observedCheckpointVersion: planning.checkpoint.checkpoint_version,
            stage: 'action',
            reason: 'action_replayed',
            reservationId: replayKeys.actionReservationId,
          }, actionResult.checkpoint);
          if (latched) return latched;
          return await reviewAndStop('replayed_action_step', actionResult.checkpoint);
        }
        if (actionResult.status === 'denied') {
          return await reviewAndStop('action_denied', planning.checkpoint);
        }
        if (actionResult.status === 'review_required') {
          if (actionResult.reason === 'reservation_state_uncertain'
            || actionResult.reason === 'reservation_result_uncertain'
            || actionResult.reason === 'start_not_authorized') {
            const latched = await latchIfReservationExists({
              datasetKind: planning.checkpoint.dataset_kind,
              investigationId: planning.checkpoint.investigation_id,
              observedCheckpointVersion: planning.checkpoint.checkpoint_version,
              stage: 'action',
              reason: 'action_result_uncertain',
              reservationId: replayKeys.actionReservationId,
            }, actionResult.checkpoint ?? planning.checkpoint);
            if (latched) return latched;
          }
          const reason = mapActionReviewReason(actionResult.reason);
          return await reviewAndMaybeStop(reason, actionResult.checkpoint ?? planning.checkpoint);
        }
        if (!isCheckpoint(actionResult.checkpoint)
          || actionResult.checkpoint.case_status !== 'open'
          || !sameCaseIdentity(actionResult.checkpoint, contextPair.context)
          || actionResult.checkpoint.checkpoint_version !== planning.checkpoint.checkpoint_version + 2
          || !isActionReceipt(actionResult.receipt)) {
          return latchReview({
            datasetKind: planning.checkpoint.dataset_kind,
            investigationId: planning.checkpoint.investigation_id,
            observedCheckpointVersion: planning.checkpoint.checkpoint_version,
            stage: 'action',
            reason: 'invalid_action_result',
            reservationId: replayKeys.actionReservationId,
          }, planning.checkpoint);
        }

        const pendingAfterAction = await pendingOutcome(
          actionResult.checkpoint.dataset_kind,
          actionResult.checkpoint.investigation_id,
          actionResult.checkpoint,
        );
        if (pendingAfterAction) return pendingAfterAction;

        let refreshed;
        try {
          refreshed = await options.refreshPort.refresh({
            datasetKind: actionResult.checkpoint.dataset_kind,
            investigationId: actionResult.checkpoint.investigation_id,
            traceId: actionResult.checkpoint.trace_id,
            candidateId: actionResult.checkpoint.candidate_id,
            previousContextId: contextPair.context.contextId,
            eventId: actionResult.checkpoint.event_id,
            eventVersion: actionResult.checkpoint.event_version,
            outputReferenceIds: [...actionResult.receipt.outputReferenceIds],
          });
        } catch {
          return latchReview({
            datasetKind: actionResult.checkpoint.dataset_kind,
            investigationId: actionResult.checkpoint.investigation_id,
            observedCheckpointVersion: actionResult.checkpoint.checkpoint_version,
            stage: 'refresh',
            reason: 'refresh_failed',
            reservationId: replayKeys.actionReservationId,
          }, actionResult.checkpoint);
        }

        // A concurrent marker may arrive while refresh persists its L2 context. The context remains
        // unadopted here, and this advance stops before progress or any subsequent stage.
        const pendingAfterRefresh = await pendingOutcome(
          actionResult.checkpoint.dataset_kind,
          actionResult.checkpoint.investigation_id,
          actionResult.checkpoint,
        );
        if (pendingAfterRefresh) return pendingAfterRefresh;

        const refreshedPair = await validateContextPair(refreshed?.context, refreshed?.persistedRecord);
        if (!refreshedPair || !sameCaseIdentity(actionResult.checkpoint, refreshedPair.context)) {
          return latchReview({
            datasetKind: actionResult.checkpoint.dataset_kind,
            investigationId: actionResult.checkpoint.investigation_id,
            observedCheckpointVersion: actionResult.checkpoint.checkpoint_version,
            stage: 'refresh',
            reason: 'invalid_refreshed_context',
            reservationId: replayKeys.actionReservationId,
          }, actionResult.checkpoint);
        }

        const refreshedAt = safeWallNow(options.wallNow);
        if (!refreshedAt) {
          return latchReview({
            datasetKind: actionResult.checkpoint.dataset_kind,
            investigationId: actionResult.checkpoint.investigation_id,
            observedCheckpointVersion: actionResult.checkpoint.checkpoint_version,
            stage: 'progress',
            reason: 'progress_uncertain',
            reservationId: replayKeys.actionReservationId,
          }, actionResult.checkpoint);
        }
        const refreshedAtInstant = parseRfc3339Instant(refreshedAt);
        const actionCheckpointInstant = parseRfc3339Instant(actionResult.checkpoint.updated_at);
        if (!refreshedAtInstant || !actionCheckpointInstant
          || compareRfc3339Instants(refreshedAtInstant, actionCheckpointInstant) < 0) {
          return latchReview({
            datasetKind: actionResult.checkpoint.dataset_kind,
            investigationId: actionResult.checkpoint.investigation_id,
            observedCheckpointVersion: actionResult.checkpoint.checkpoint_version,
            stage: 'progress',
            reason: 'progress_uncertain',
            reservationId: replayKeys.actionReservationId,
          }, actionResult.checkpoint);
        }

        const pendingBeforeProgress = await pendingOutcome(
          actionResult.checkpoint.dataset_kind,
          actionResult.checkpoint.investigation_id,
          actionResult.checkpoint,
        );
        if (pendingBeforeProgress) return pendingBeforeProgress;

        let fingerprintKeyId: string | null;
        try {
          fingerprintKeyId = await options.ledger.getFingerprintKeyId(
            actionResult.checkpoint.dataset_kind,
            actionResult.checkpoint.investigation_id,
          );
        } catch {
          return latchReview({
            datasetKind: actionResult.checkpoint.dataset_kind,
            investigationId: actionResult.checkpoint.investigation_id,
            observedCheckpointVersion: actionResult.checkpoint.checkpoint_version,
            stage: 'progress',
            reason: 'progress_uncertain',
            reservationId: replayKeys.actionReservationId,
          }, actionResult.checkpoint);
        }
        if (fingerprintKeyId === null) {
          return latchReview({
            datasetKind: actionResult.checkpoint.dataset_kind,
            investigationId: actionResult.checkpoint.investigation_id,
            observedCheckpointVersion: actionResult.checkpoint.checkpoint_version,
            stage: 'progress',
            reason: 'progress_uncertain',
            reservationId: replayKeys.actionReservationId,
          }, actionResult.checkpoint);
        }

        let progressFingerprint;
        try {
          options.fingerprints.assertCaseKeyId(fingerprintKeyId);
          progressFingerprint = await options.fingerprints.fingerprintGrounding({
            datasetKind: actionResult.checkpoint.dataset_kind,
            investigationId: actionResult.checkpoint.investigation_id,
            keyId: fingerprintKeyId,
            context: refreshedPair.context,
          });
        } catch {
          return latchReview({
            datasetKind: actionResult.checkpoint.dataset_kind,
            investigationId: actionResult.checkpoint.investigation_id,
            observedCheckpointVersion: actionResult.checkpoint.checkpoint_version,
            stage: 'progress',
            reason: 'progress_uncertain',
            reservationId: replayKeys.actionReservationId,
          }, actionResult.checkpoint);
        }

        let progress;
        try {
          progress = await options.ledger.refreshGroundingProgress({
            datasetKind: actionResult.checkpoint.dataset_kind,
            investigationId: actionResult.checkpoint.investigation_id,
            expectedCheckpointVersion: actionResult.checkpoint.checkpoint_version,
            contextId: refreshedPair.context.contextId,
            fingerprintKeyId: progressFingerprint.keyId,
            digestHex: progressFingerprint.digestHex,
            refreshedAt,
          });
        } catch (error) {
          if (error instanceof InvestigationLedgerError && error.code === 'advance_review_pending') {
            return review('advance_review_pending', actionResult.checkpoint);
          }
          const pending = await pendingOutcome(
            actionResult.checkpoint.dataset_kind,
            actionResult.checkpoint.investigation_id,
            actionResult.checkpoint,
          );
          if (pending) return pending;
          if (error instanceof InvestigationLedgerError && KNOWN_PREWRITE_PROGRESS_ERRORS.has(error.code)) {
            return review('ledger_uncertain', actionResult.checkpoint);
          }
          return latchReview({
            datasetKind: actionResult.checkpoint.dataset_kind,
            investigationId: actionResult.checkpoint.investigation_id,
            observedCheckpointVersion: actionResult.checkpoint.checkpoint_version,
            stage: 'progress',
            reason: 'progress_uncertain',
            reservationId: replayKeys.actionReservationId,
          }, actionResult.checkpoint);
        }

        const pendingAfterProgress = await pendingOutcome(
          actionResult.checkpoint.dataset_kind,
          actionResult.checkpoint.investigation_id,
          actionResult.checkpoint,
        );
        if (pendingAfterProgress) return pendingAfterProgress;

        if (!progress || !isCheckpoint(progress.checkpoint) || !isProgressSnapshot(progress.snapshot)) {
          return latchReview({
            datasetKind: actionResult.checkpoint.dataset_kind,
            investigationId: actionResult.checkpoint.investigation_id,
            observedCheckpointVersion: actionResult.checkpoint.checkpoint_version,
            stage: 'progress',
            reason: 'progress_uncertain',
            reservationId: replayKeys.actionReservationId,
          }, actionResult.checkpoint);
        }
        if (progress.checkpoint.checkpoint_version !== actionResult.checkpoint.checkpoint_version + 1
          || !sameCaseIdentity(progress.checkpoint, refreshedPair.context)
          || progress.checkpoint.context_id !== refreshedPair.context.contextId
          || progress.snapshot.datasetKind !== actionResult.checkpoint.dataset_kind
          || progress.snapshot.investigationId !== actionResult.checkpoint.investigation_id
          || progress.snapshot.checkpointVersion !== progress.checkpoint.checkpoint_version
          || progress.snapshot.candidateId !== progress.checkpoint.candidate_id
          || progress.snapshot.contextId !== refreshedPair.context.contextId
          || progress.snapshot.fingerprintKeyId !== progressFingerprint.keyId
          || progress.snapshot.digestHex !== progressFingerprint.digestHex) {
          return latchReview({
            datasetKind: actionResult.checkpoint.dataset_kind,
            investigationId: actionResult.checkpoint.investigation_id,
            observedCheckpointVersion: actionResult.checkpoint.checkpoint_version,
            stage: 'progress',
            reason: 'progress_uncertain',
            reservationId: replayKeys.actionReservationId,
          }, actionResult.checkpoint);
        }

        if (progress.checkpoint.case_status === 'stopped_for_review'
          || progress.snapshot.consecutiveNoProgress >= 2) {
          return review('no_progress', progress.checkpoint);
        }
        if (refreshedPair.context.conflicts.length > 0) {
          return await reviewAndStop('material_dispute', progress.checkpoint);
        }
        if (actionResult.receipt.outcome === 'timed_out') {
          return await reviewAndStop('action_timed_out', progress.checkpoint);
        }
        if (actionResult.receipt.outcome !== 'succeeded') {
          return await reviewAndStop('action_failed', progress.checkpoint);
        }
        if (refreshedPair.context.sufficient) {
          return {
            status: 'sufficient_context',
            checkpoint: progress.checkpoint,
            context: refreshedPair.context,
            persistedRecord: refreshedPair.persistedRecord,
          };
        }
        const refreshedIdentity = planIdentity(progress.checkpoint, refreshedPair.context);
        if (!refreshedIdentity || refreshedIdentity.questions.length < 1
          || refreshedIdentity.questions.length > MAX_QUESTIONS) {
          return await reviewAndStop('invalid_refreshed_context', progress.checkpoint);
        }
        // One unchanged snapshot remains resumable; the durable second one is stopped above.
        return {
          status: 'continue',
          checkpoint: progress.checkpoint,
          context: refreshedPair.context,
          persistedRecord: refreshedPair.persistedRecord,
        };
      } catch {
        return review('invalid_input');
      }
    },
  };

  async function reviewAndMaybeStop(
    reason: InvestigationCoordinatorReviewReason,
    checkpoint: InvestigationCheckpointRecord | undefined,
  ): Promise<InvestigationCoordinatorOutcome> {
    if (checkpoint) {
      const pending = await pendingOutcome(checkpoint.dataset_kind, checkpoint.investigation_id, checkpoint);
      if (pending) return pending;
    }
    const stopReason = ledgerStopReason(reason);
    if (!checkpoint || !stopReason) return review(reason, checkpoint);
    const stopped = await stopIfCurrent(checkpoint, stopReason);
    const pending = await pendingOutcome(checkpoint.dataset_kind, checkpoint.investigation_id, stopped ?? checkpoint);
    return pending ?? review(reason, stopped);
  }

  async function reviewAndStop(
    reason: InvestigationCoordinatorReviewReason,
    checkpoint: InvestigationCheckpointRecord | undefined,
  ): Promise<InvestigationCoordinatorOutcome> {
    if (checkpoint) {
      const pending = await pendingOutcome(checkpoint.dataset_kind, checkpoint.investigation_id, checkpoint);
      if (pending) return pending;
    }
    const stopReason = ledgerStopReason(reason) ?? 'awaiting_moderator';
    if (!checkpoint) return review(reason);
    const stopped = await stopIfCurrent(checkpoint, stopReason);
    const pending = await pendingOutcome(checkpoint.dataset_kind, checkpoint.investigation_id, stopped ?? checkpoint);
    return pending ?? review(reason, stopped);
  }

  async function stopIfCurrent(
    checkpoint: InvestigationCheckpointRecord,
    stopReason: InvestigationStopReason,
  ): Promise<InvestigationCheckpointRecord | undefined> {
    if (!isCheckpoint(checkpoint) || checkpoint.case_status !== 'open') return checkpoint;
    try {
      const latest = await options.ledger.getLatest(checkpoint.dataset_kind, checkpoint.investigation_id);
      if (!latest || !sameCheckpointVersionIdentity(checkpoint, latest) || latest.case_status !== 'open') {
        return latest ?? checkpoint;
      }
      const completedAt = safeWallNow(options.wallNow);
      if (!completedAt) return latest;
      const stopped = await options.ledger.terminate({
        datasetKind: latest.dataset_kind,
        investigationId: latest.investigation_id,
        expectedCheckpointVersion: latest.checkpoint_version,
        status: 'stopped_for_review',
        stopReason,
        completedAt,
      });
      return stopped.checkpoint;
    } catch {
      return checkpoint;
    }
  }
}

async function readHandoffContextPair(value: unknown): Promise<ValidatedContextPair | undefined> {
  try {
    if (!isRecord(value) || value.status !== 'investigation_required') return undefined;
    const reasoningRequest = readDataProperty(value, 'reasoningRequest');
    const data = readDataProperty(reasoningRequest, 'data');
    const rawContext = readDataProperty(data, 'groundingContext');
    const record = readDataProperty(value, 'persistedRecord');
    return validateContextPair(rawContext, record);
  } catch {
    return undefined;
  }
}

async function validateContextPair(
  rawContext: unknown,
  rawRecord: unknown,
): Promise<ValidatedContextPair | undefined> {
  try {
    const reasoningRequest = await validateReasoningRequest({ data: { groundingContext: rawContext } });
    const context = reasoningRequest.data.groundingContext;
    if (!matchesPersistedRecord(context, rawRecord)) return undefined;
    return { context, persistedRecord: rawRecord as GroundingContextRecord };
  } catch {
    return undefined;
  }
}

function matchesPersistedRecord(context: GroundingContext, value: unknown): value is GroundingContextRecord {
  try {
    if (!isRecord(value)
      || value.schema_version !== context.schemaVersion
      || value.record_type !== context.recordType
      || value.dataset_kind !== context.datasetKind
      || value.trace_id !== context.traceId
      || value.context_id !== context.contextId
      || value.candidate_id !== context.candidateId
      || value.retrieval_version !== context.retrievalVersion
      || value.index_version !== context.indexVersion
      || value.sufficient !== context.sufficient
      || !sameStringArray(value.missing_fields, context.missingFields)
      || !sameStringArray(value.conflicts, context.conflicts)
      || !sameStringArray(value.prior_decision_ids, context.priorDecisionIds)
      || !sameRevisionStates(value.revision_states, context.revisionStates)
      || !sameCandidateEvents(value.candidate_events, context.candidateEvents)
      || !sameEvidenceReferences(value.evidence, context.evidence)) return false;
    return true;
  } catch {
    return false;
  }
}

function sameEvidenceReferences(recordEvidence: unknown, contextEvidence: GroundingContext['evidence']): boolean {
  if (!Array.isArray(recordEvidence) || recordEvidence.length !== contextEvidence.length) return false;
  return recordEvidence.every((value, index) => {
    const record = value as Record<string, unknown>;
    const reference = contextEvidence[index]?.reference;
    return isRecord(record)
      && !!reference
      && record.report_revision_id === reference.reportRevisionId
      && record.permitted_text_hash === reference.permittedTextHash
      && record.span_start === reference.spanStart
      && record.span_end === reference.spanEnd
      && record.offset_unit === reference.offsetUnit
      && record.relation === reference.relation;
  });
}

function sameRevisionStates(recordStates: unknown, contextStates: GroundingContext['revisionStates']): boolean {
  if (!Array.isArray(recordStates) || recordStates.length !== contextStates.length) return false;
  return recordStates.every((value, index) => {
    const record = value as Record<string, unknown>;
    const state = contextStates[index];
    return isRecord(record)
      && !!state
      && record.report_revision_id === state.reportRevisionId
      && record.revision_status === state.revisionStatus;
  });
}

function sameCandidateEvents(recordEvents: unknown, contextEvents: GroundingContext['candidateEvents']): boolean {
  if (!Array.isArray(recordEvents) || recordEvents.length !== contextEvents.length) return false;
  return recordEvents.every((value, index) => {
    const record = value as Record<string, unknown>;
    const event = contextEvents[index];
    return isRecord(record)
      && !!event
      && record.event_id === event.eventId
      && record.event_version === event.eventVersion;
  });
}

function planIdentity(
  checkpoint: InvestigationCheckpointRecord,
  context: GroundingContext,
): { readonly questions: readonly string[] } | undefined {
  if (!isCheckpoint(checkpoint)
    || context.sufficient
    || !isDatasetKind(context.datasetKind)
    || !isId(context.traceId)
    || !isId(context.contextId)
    || !isId(context.candidateId)
    || checkpoint.dataset_kind !== context.datasetKind
    || checkpoint.trace_id !== context.traceId
    || checkpoint.context_id !== context.contextId
    || checkpoint.candidate_id !== context.candidateId
    || !Array.isArray(context.candidateEvents)
    || context.candidateEvents.length > 1) return undefined;
  let eventId: string | null = null;
  let eventVersion: number | null = null;
  const candidateEvent = context.candidateEvents[0];
  if (candidateEvent) {
    if (!isId(candidateEvent.eventId) || !isPositiveInteger(candidateEvent.eventVersion)) return undefined;
    eventId = candidateEvent.eventId;
    eventVersion = candidateEvent.eventVersion;
  }
  if (checkpoint.event_id !== eventId || checkpoint.event_version !== eventVersion) return undefined;
  if (!Array.isArray(context.missingFields) || !Array.isArray(context.conflicts)) return undefined;
  const count = context.missingFields.length + context.conflicts.length;
  if (count < 1 || count > MAX_QUESTIONS) return undefined;
  return {
    questions: [
      ...context.missingFields.map((_, index) => `missing_field_${index + 1}`),
      ...context.conflicts.map((_, index) => `conflict_${index + 1}`),
    ],
  };
}

function sameCaseIdentity(checkpoint: InvestigationCheckpointRecord, context: GroundingContext): boolean {
  return isCheckpoint(checkpoint)
    && checkpoint.dataset_kind === context.datasetKind
    && checkpoint.trace_id === context.traceId
    && checkpoint.candidate_id === context.candidateId
    && checkpoint.event_id === candidateEventId(context)
    && checkpoint.event_version === candidateEventVersion(context);
}

function candidateEventId(context: GroundingContext): string | null | undefined {
  if (!Array.isArray(context.candidateEvents) || context.candidateEvents.length > 1) return undefined;
  return context.candidateEvents[0]?.eventId ?? null;
}

function candidateEventVersion(context: GroundingContext): number | null | undefined {
  if (!Array.isArray(context.candidateEvents) || context.candidateEvents.length > 1) return undefined;
  return context.candidateEvents[0]?.eventVersion ?? null;
}

function parseReplayKeys(value: Record<string, unknown>): {
  readonly reasoningReservationId: string;
  readonly reasoningReservedAt: string;
  readonly actionReservationId: string;
} | undefined {
  try {
    const reasoningReservationId = value.reasoningReservationId;
    const reasoningReservedAt = value.reasoningReservedAt;
    const actionReservationId = value.actionReservationId;
    if (!isId(reasoningReservationId)
      || !isTimestamp(reasoningReservedAt)
      || !isId(actionReservationId)
      || reasoningReservationId === actionReservationId) return undefined;
    return { reasoningReservationId, reasoningReservedAt, actionReservationId };
  } catch {
    return undefined;
  }
}

function parseProposedAction(
  value: unknown,
  actionMenu: readonly InvestigationActionMenuEntry[],
): ProposedInvestigationAction | undefined {
  try {
    if (!isRecord(value) || Object.getPrototypeOf(value) !== Object.prototype) return undefined;
    const keys = Reflect.ownKeys(value);
    const expectedKeys = ['schemaVersion', 'recordType', 'outcome', 'actionName', 'input'];
    if (keys.length !== expectedKeys.length || keys.some((key) => typeof key !== 'string')) return undefined;
    const stringKeys = keys as string[];
    if (expectedKeys.some((key) => !stringKeys.includes(key))) return undefined;

    const fields: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const key of expectedKeys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) return undefined;
      Object.defineProperty(fields, key, { value: descriptor.value, enumerable: true });
    }
    if (fields.schemaVersion !== INVESTIGATION_PLAN_VERSION
      || fields.recordType !== 'InvestigationPlanResult'
      || fields.outcome !== 'proposed'
      || typeof fields.actionName !== 'string'
      || !actionMenu.some((entry) => entry.name === fields.actionName)
      || !isRecord(fields.input)) return undefined;
    const inputPrototype = Object.getPrototypeOf(fields.input);
    if (inputPrototype !== Object.prototype && inputPrototype !== null) return undefined;

    return {
      schemaVersion: INVESTIGATION_PLAN_VERSION,
      recordType: 'InvestigationPlanResult',
      outcome: 'proposed',
      actionName: fields.actionName,
      input: fields.input as ProposedInvestigationAction['input'],
    };
  } catch {
    return undefined;
  }
}

function copyTrustedActionMenu(value: readonly InvestigationActionMenuEntry[]): readonly InvestigationActionMenuEntry[] | undefined {
  try {
    if (!Array.isArray(value) || value.length < 1 || value.length > 16) return undefined;
    const names = new Set<string>();
    const copied: InvestigationActionMenuEntry[] = [];
    for (const item of value) {
      if (!isRecord(item)
        || !isId(item.name)
        || !ACTION_NAME_PATTERN.test(item.name)
        || typeof item.description !== 'string'
        || item.description.trim().length === 0
        || Array.from(item.description).length > 256
        || names.has(item.name)) return undefined;
      names.add(item.name);
      copied.push(Object.freeze({ name: item.name, description: item.description }));
    }
    return Object.freeze(copied);
  } catch {
    return undefined;
  }
}

function mapPlannerReviewReason(reason: string): InvestigationCoordinatorReviewReason {
  if (reason === 'planner_abstained') return 'planner_abstained';
  if (reason === 'budget_exhausted') return 'budget_exhausted';
  if (reason === 'planner_timed_out') return 'planner_timed_out';
  if (reason === 'stale_checkpoint') return 'stale_checkpoint';
  if (reason === 'context_identity_mismatch') return 'context_identity_mismatch';
  if (reason === 'investigation_not_found') return 'case_not_found';
  if (reason === 'investigation_not_open') return 'case_not_open';
  if (reason === 'reservation_replayed' || reason === 'reservation_state_uncertain') return 'replayed_planner_step';
  if (reason === 'invalid_proposal' || reason === 'planner_preflight_rejected') return 'invalid_context';
  return 'planner_unavailable';
}

function mapActionReviewReason(reason: string): InvestigationCoordinatorReviewReason {
  if (reason === 'duplicate_action') return 'duplicate_action';
  if (reason === 'stale_checkpoint') return 'stale_checkpoint';
  if (reason === 'investigation_not_found') return 'case_not_found';
  if (reason === 'investigation_not_open') return 'case_not_open';
  if (reason === 'invalid_action_input' || reason === 'invalid_proposal') return 'action_denied';
  return 'action_uncertain';
}

function isActionReceipt(value: unknown): value is {
  readonly outcome: ActionOutcome;
  readonly outputReferenceIds: readonly string[];
} {
  return isRecord(value)
    && (value.outcome === 'succeeded' || value.outcome === 'failed' || value.outcome === 'timed_out'
      || value.outcome === 'denied' || value.outcome === 'cancelled')
    && Array.isArray(value.outputReferenceIds)
    && value.outputReferenceIds.length <= 8
    && value.outputReferenceIds.every(isId);
}

function isProgressSnapshot(value: unknown): value is InvestigationProgressSnapshotRecord {
  try {
    return isRecord(value)
      && isDatasetKind(value.datasetKind)
      && isId(value.investigationId)
      && isPositiveInteger(value.checkpointVersion)
      && isId(value.candidateId)
      && isId(value.contextId)
      && isId(value.fingerprintKeyId)
      && typeof value.digestHex === 'string'
      && /^[a-f0-9]{64}$/.test(value.digestHex)
      && typeof value.consecutiveNoProgress === 'number'
      && Number.isSafeInteger(value.consecutiveNoProgress)
      && value.consecutiveNoProgress >= 0
      && value.consecutiveNoProgress <= 2
      && isTimestamp(value.recordedAt);
  } catch {
    return false;
  }
}

function ledgerStopReason(reason: InvestigationCoordinatorReviewReason): InvestigationStopReason | undefined {
  if (reason === 'budget_exhausted') return 'limit_exhausted';
  if (reason === 'material_dispute') return 'material_conflict';
  if (reason === 'no_progress') return 'no_progress';
  if (reason === 'action_denied' || reason === 'action_failed' || reason === 'action_timed_out') return 'tool_unavailable';
  if (reason === 'duplicate_action' || reason === 'action_uncertain' || reason === 'refresh_failed'
    || reason === 'invalid_refreshed_context' || reason === 'planner_abstained' || reason === 'planner_timed_out'
    || reason === 'planner_unavailable') return 'awaiting_moderator';
  return undefined;
}

function isCheckpoint(value: unknown): value is InvestigationCheckpointRecord {
  try {
    return isRecord(value)
      && value.schema_version === '2.0'
      && value.record_type === 'InvestigationCheckpoint'
      && isDatasetKind(value.dataset_kind)
      && isId(value.trace_id)
      && isId(value.checkpoint_id)
      && isId(value.investigation_id)
      && isPositiveInteger(value.checkpoint_version)
      && isId(value.candidate_id)
      && isId(value.context_id)
      && (value.event_id === null || isId(value.event_id))
      && (value.event_version === null || isPositiveInteger(value.event_version))
      && ((value.event_id === null) === (value.event_version === null))
      && (value.case_status === 'open' || value.case_status === 'paused'
        || value.case_status === 'completed' || value.case_status === 'stopped_for_review');
  } catch {
    return false;
  }
}

function sameCheckpointVersionIdentity(
  left: InvestigationCheckpointRecord,
  right: InvestigationCheckpointRecord,
): boolean {
  return isCheckpoint(left) && isCheckpoint(right)
    && left.schema_version === right.schema_version
    && left.record_type === right.record_type
    && left.dataset_kind === right.dataset_kind
    && left.trace_id === right.trace_id
    && left.checkpoint_id === right.checkpoint_id
    && left.investigation_id === right.investigation_id
    && left.checkpoint_version === right.checkpoint_version
    && left.candidate_id === right.candidate_id
    && left.context_id === right.context_id
    && left.event_id === right.event_id
    && left.event_version === right.event_version;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function readDataProperty(value: unknown, name: string): unknown {
  if (!isRecord(value)) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, name);
  return descriptor && 'value' in descriptor ? descriptor.value : undefined;
}

function sameStringArray(left: unknown, right: readonly string[]): boolean {
  return Array.isArray(left)
    && left.length === right.length
    && left.every((value, index) => typeof value === 'string' && value === right[index]);
}

function isDatasetKind(value: unknown): value is DatasetKind {
  return value === 'live' || value === 'historical' || value === 'synthetic';
}

function isId(value: unknown): value is string {
  return typeof value === 'string' && ID_PATTERN.test(value);
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;
}

function isTimestamp(value: unknown): value is string {
  return typeof value === 'string'
    && TIMESTAMP_PATTERN.test(value)
    && Number.isFinite(Date.parse(value));
}

function safeWallNow(wallNow: () => string): string | undefined {
  try {
    const value = wallNow();
    if (!parseRfc3339Instant(value)) return undefined;
    const normalized = `${value.slice(0, 10)}T${value.slice(11)}`;
    return normalized.endsWith('z') ? `${normalized.slice(0, -1)}Z` : normalized;
  } catch {
    return undefined;
  }
}

function parseRfc3339Instant(value: unknown): ParsedRfc3339Instant | undefined {
  // Bound both representation length and fractional precision before comparing caller-visible time.
  if (typeof value !== 'string' || value.length > MAX_RFC3339_TIMESTAMP_LENGTH) return undefined;
  const match = RFC3339_TIMESTAMP_PATTERN.exec(value);
  if (!match || match[0] !== value) return undefined;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  if (month < 1 || month > 12
    || day < 1 || day > daysInMonth(year, month)
    || hour > 23 || minute > 59 || second > 59) return undefined;

  let offsetSeconds = 0;
  if (match[9]) {
    const offsetHour = Number(match[10]);
    const offsetMinute = Number(match[11]);
    if (offsetHour > 23 || offsetMinute > 59) return undefined;
    const sign = match[9] === '+' ? 1 : -1;
    offsetSeconds = sign * (offsetHour * 60 + offsetMinute) * 60;
  }

  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, 0);
  const utcMilliseconds = date.getTime();
  if (!Number.isFinite(utcMilliseconds)) return undefined;

  return {
    epochSeconds: utcMilliseconds / 1_000 - offsetSeconds,
    fractionalSecond: (match[7] ?? '').replace(/0+$/, ''),
  };
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    return leapYear ? 29 : 28;
  }
  return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31;
}

function compareRfc3339Instants(left: ParsedRfc3339Instant, right: ParsedRfc3339Instant): number {
  if (left.epochSeconds < right.epochSeconds) return -1;
  if (left.epochSeconds > right.epochSeconds) return 1;
  const length = Math.max(left.fractionalSecond.length, right.fractionalSecond.length);
  for (let index = 0; index < length; index += 1) {
    const leftDigit = index < left.fractionalSecond.length
      ? left.fractionalSecond.charCodeAt(index)
      : 48;
    const rightDigit = index < right.fractionalSecond.length
      ? right.fractionalSecond.charCodeAt(index)
      : 48;
    if (leftDigit < rightDigit) return -1;
    if (leftDigit > rightDigit) return 1;
  }
  return 0;
}

function review(
  reason: InvestigationCoordinatorReviewReason,
  checkpoint?: InvestigationCheckpointRecord,
): InvestigationCoordinatorOutcome {
  return { status: 'review_required', reason, ...(checkpoint ? { checkpoint } : {}) };
}
