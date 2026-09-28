import { InvestigationLedgerError } from '../../../../db/src/investigation-ledger.js';
import type {
  ActionOutcome,
  InvestigationCheckpointRecord,
  InvestigationLedgerRepository,
  ModelRun,
  ReconcileActionInput,
  ReservationOperationResult,
  ReserveActionInput,
} from '../../../../db/src/investigation-ledger.js';
import type { DatasetKind } from '../../../../db/src/ports.js';
import {
  INVESTIGATION_PLAN_CAPABILITY,
  INVESTIGATION_PLAN_VERSION,
  type InvestigationPlanResult,
  type InvestigationPlanUsage,
  type InvestigationPlanner,
  type InvestigationPlannerPreflightOutcome,
  type InvestigationPlanRequest,
  type ProposedInvestigationAction,
} from '../l2-model-grounding/investigation-planner.js';
import {
  createTelemetryInvestigationLedgerRepository,
} from './telemetry.js';
import type { TelemetrySink } from '../l5-evaluation-monitoring/telemetry.js';

const RESERVATION_ACTION_NAME = 'l2_investigation_planning';
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const MODEL_VERSION_PATTERN = /^[A-Za-z0-9@][A-Za-z0-9@._:\/-]{0,127}$/;

export interface ReasoningStepProposal {
  readonly datasetKind: DatasetKind;
  readonly investigationId: string;
  readonly expectedCheckpointVersion: number;
  readonly reservationId: string;
  readonly reservedAt: string;
  readonly request: unknown;
}

export interface ReasoningStepExecutorClock {
  readonly wallNow: () => string;
  readonly monotonicNow: () => number;
}

export interface ReasoningStepExecutorTimer {
  readonly setTimeout: (callback: () => void, delayMs: number) => unknown;
  readonly clearTimeout: (handle: unknown) => void;
}

export type ReasoningStepReviewReason =
  | 'invalid_proposal'
  | 'invalid_limits'
  | 'planner_preflight_rejected'
  | 'investigation_not_found'
  | 'investigation_not_open'
  | 'stale_checkpoint'
  | 'context_identity_mismatch'
  | 'reservation_in_flight'
  | 'budget_exhausted'
  | 'ledger_state_uncertain'
  | 'reservation_replayed'
  | 'reservation_state_uncertain'
  | 'start_not_authorized'
  | 'clock_unavailable'
  | 'timer_unavailable'
  | 'planner_failed'
  | 'planner_timed_out'
  | 'planner_abstained'
  | 'reconciliation_uncertain'
  | 'escalation_uncertain';

export type ReasoningStepExecutorResult =
  | {
      readonly status: 'proposed';
      readonly checkpoint: InvestigationCheckpointRecord;
      readonly proposal: ProposedInvestigationAction;
      readonly usage: InvestigationPlanUsage;
    }
  | {
      readonly status: 'replayed';
      readonly checkpoint: InvestigationCheckpointRecord;
    }
  | {
      readonly status: 'review_required';
      readonly reason: ReasoningStepReviewReason;
      readonly checkpoint?: InvestigationCheckpointRecord;
      readonly usage?: InvestigationPlanUsage;
    };

export interface ReasoningStepExecutorOptions {
  readonly ledger: InvestigationLedgerRepository;
  readonly planner: InvestigationPlanner;
  /** Trusted maximum active seconds reserved for one L2 planning call. */
  readonly maxActiveSeconds: number;
  /** Trusted maximum combined input and output tokens reserved for one call. */
  readonly maxModelTokens: number;
  readonly clock: ReasoningStepExecutorClock;
  readonly timer: ReasoningStepExecutorTimer;
  readonly telemetry?: TelemetrySink;
}

export interface ReasoningStepExecutor {
  plan(proposal: unknown): Promise<ReasoningStepExecutorResult>;
}

interface ParsedProposal extends ReasoningStepProposal {}

type ValidatedPlan =
  | { readonly outcome: 'proposed'; readonly value: ProposedInvestigationAction; readonly usage: InvestigationPlanUsage }
  | { readonly outcome: 'abstained'; readonly value: Extract<InvestigationPlanResult, { readonly outcome: 'abstained' }>; readonly usage: InvestigationPlanUsage };

type DeadlineResult =
  | { readonly kind: 'result'; readonly value: unknown; readonly actualActiveSeconds: number; readonly finishedAt: string }
  | { readonly kind: 'error'; readonly actualActiveSeconds: number; readonly finishedAt: string }
  | { readonly kind: 'timeout'; readonly actualActiveSeconds: number; readonly finishedAt: string }
  | { readonly kind: 'timer_error'; readonly actualActiveSeconds: number; readonly finishedAt: string };

/**
 * Authorizes exactly one Layer 2 planning call through the durable ledger.
 * A returned action remains data and never reaches the action executor here.
 */
export function createReasoningStepExecutor(options: ReasoningStepExecutorOptions): ReasoningStepExecutor {
  const ledger = options.telemetry
    ? createTelemetryInvestigationLedgerRepository(options.ledger, options.telemetry)
    : options.ledger;

  return {
    async plan(rawProposal): Promise<ReasoningStepExecutorResult> {
      const proposal = parseProposal(rawProposal);
      if (!proposal) return reviewRequired('invalid_proposal');
      if (!validLimits(options.maxActiveSeconds, options.maxModelTokens)) {
        return reviewRequired('invalid_limits');
      }

      let preflight: InvestigationPlannerPreflightOutcome;
      try {
        preflight = await options.planner.preflight(proposal.request);
      } catch {
        return reviewRequired('planner_preflight_rejected');
      }
      if (!isReadyPreflight(preflight)) return reviewRequired('planner_preflight_rejected');
      const plannerRequest = preflight.request;

      let checkpoint: InvestigationCheckpointRecord | null;
      try {
        checkpoint = await ledger.getLatest(proposal.datasetKind, proposal.investigationId);
      } catch {
        return reviewRequired('ledger_state_uncertain');
      }
      if (!checkpoint) return reviewRequired('investigation_not_found');
      if (checkpoint.case_status !== 'open') return reviewRequired('investigation_not_open', checkpoint);
      if (checkpoint.checkpoint_version !== proposal.expectedCheckpointVersion) {
        return reviewRequired('stale_checkpoint', checkpoint);
      }
      if (!matchesContextIdentity(checkpoint, proposal, plannerRequest)) {
        return reviewRequired('context_identity_mismatch', checkpoint);
      }
      if (Date.parse(proposal.reservedAt) < Date.parse(checkpoint.updated_at)) {
        return reviewRequired('invalid_proposal', checkpoint);
      }

      try {
        const inFlight = await ledger.getInFlightReservation(proposal.datasetKind, proposal.investigationId);
        if (inFlight) return reviewRequired('reservation_in_flight', checkpoint);
      } catch {
        return reviewRequired('ledger_state_uncertain', checkpoint);
      }

      const reserveInput: ReserveActionInput = {
        datasetKind: proposal.datasetKind,
        investigationId: proposal.investigationId,
        reservationId: proposal.reservationId,
        expectedCheckpointVersion: proposal.expectedCheckpointVersion,
        actionKind: 'reasoning',
        actionName: RESERVATION_ACTION_NAME,
        reservedActiveSeconds: options.maxActiveSeconds,
        reservedModelTokens: options.maxModelTokens,
        reservedAt: proposal.reservedAt,
      };
      let reservation: ReservationOperationResult;
      try {
        reservation = await ledger.reserveAction(reserveInput);
      } catch (error) {
        return reviewRequired(ledgerErrorReason(error), checkpoint);
      }
      if (reservation.replayed === true) {
        return { status: 'replayed', checkpoint: reservation.checkpoint };
      }
      if (reservation.replayed !== false) {
        return reviewRequired('reservation_state_uncertain', reservation.checkpoint);
      }

      const startedAt = readWallTimestamp(options.clock);
      if (!startedAt || Date.parse(startedAt) < Date.parse(proposal.reservedAt)) {
        try {
          const released = await ledger.releaseUninvoked({
            datasetKind: proposal.datasetKind,
            investigationId: proposal.investigationId,
            reservationId: proposal.reservationId,
            expectedCheckpointVersion: reservation.checkpoint.checkpoint_version,
            releasedAt: proposal.reservedAt,
          });
          return reviewRequired('clock_unavailable', released.checkpoint);
        } catch {
          return reviewRequired('ledger_state_uncertain', reservation.checkpoint);
        }
      }

      let started: ReservationOperationResult;
      try {
        started = await ledger.startAction({
          datasetKind: proposal.datasetKind,
          investigationId: proposal.investigationId,
          reservationId: proposal.reservationId,
          startedAt,
        });
      } catch (error) {
        return reviewRequired(ledgerErrorReason(error), reservation.checkpoint);
      }
      if (started.replayed === true) return { status: 'replayed', checkpoint: started.checkpoint };
      if (started.replayed !== false || started.mayInvoke !== true) {
        return reviewRequired('start_not_authorized', started.checkpoint);
      }

      const invocation = await invokePlannerWithDeadline({
        planner: options.planner,
        request: plannerRequest,
        maxTotalTokens: options.maxModelTokens,
        maxActiveSeconds: options.maxActiveSeconds,
        clock: options.clock,
        timer: options.timer,
        startedAt,
      });

      if (invocation.kind !== 'result') {
        const outcome: ActionOutcome = invocation.kind === 'timeout' ? 'timed_out' : 'failed';
        const failureReason: ReasoningStepReviewReason = invocation.kind === 'timeout'
          ? 'planner_timed_out'
          : invocation.kind === 'timer_error' ? 'timer_unavailable' : 'planner_failed';
        return reconcileFailure({
          ledger,
          proposal,
          reservation,
          outcome,
          finishedAt: invocation.finishedAt,
          actualActiveSeconds: options.maxActiveSeconds,
          actualModelTokens: options.maxModelTokens,
          reason: failureReason,
        });
      }

      let validPlan: ValidatedPlan | undefined;
      try {
        validPlan = parsePlannerSuccess(invocation.value, plannerRequest, options.maxModelTokens);
      } catch {
        validPlan = undefined;
      }
      if (!validPlan) {
        return reconcileFailure({
          ledger,
          proposal,
          reservation,
          outcome: 'failed',
          finishedAt: invocation.finishedAt,
          actualActiveSeconds: options.maxActiveSeconds,
          actualModelTokens: options.maxModelTokens,
          reason: 'planner_failed',
        });
      }

      const actualActiveSeconds = invocation.actualActiveSeconds;
      const modelRun = toModelRun(validPlan.usage);
      let reconciled;
      try {
        const input: ReconcileActionInput = {
          datasetKind: proposal.datasetKind,
          investigationId: proposal.investigationId,
          reservationId: proposal.reservationId,
          expectedCheckpointVersion: reservation.checkpoint.checkpoint_version,
          outcome: 'succeeded',
          actualActiveSeconds,
          actualModelTokens: validPlan.usage.totalTokens,
          finishedAt: invocation.finishedAt,
          modelRun,
        };
        reconciled = await ledger.reconcileAction(input);
      } catch {
        return reviewRequired('reconciliation_uncertain');
      }
      if (reconciled.replayed === true) return { status: 'replayed', checkpoint: reconciled.checkpoint };
      if (reconciled.replayed !== false) return reviewRequired('reconciliation_uncertain');

      if (validPlan.outcome === 'abstained') {
        try {
          const stopped = await ledger.terminate({
            datasetKind: proposal.datasetKind,
            investigationId: proposal.investigationId,
            expectedCheckpointVersion: reconciled.checkpoint.checkpoint_version,
            status: 'stopped_for_review',
            stopReason: 'awaiting_moderator',
            completedAt: invocation.finishedAt,
          });
          if (stopped.replayed !== false) return reviewRequired('escalation_uncertain', stopped.checkpoint);
          return reviewRequired('planner_abstained', stopped.checkpoint, validPlan.usage);
        } catch {
          return reviewRequired('escalation_uncertain', reconciled.checkpoint, validPlan.usage);
        }
      }

      return {
        status: 'proposed',
        checkpoint: reconciled.checkpoint,
        proposal: validPlan.value,
        usage: validPlan.usage,
      };
    },
  };
}

async function reconcileFailure(input: {
  readonly ledger: InvestigationLedgerRepository;
  readonly proposal: ParsedProposal;
  readonly reservation: ReservationOperationResult;
  readonly outcome: Extract<ActionOutcome, 'failed' | 'timed_out'>;
  readonly finishedAt: string;
  readonly actualActiveSeconds: number;
  readonly actualModelTokens: number;
  readonly reason: ReasoningStepReviewReason;
}): Promise<ReasoningStepExecutorResult> {
  try {
    const reconciled = await input.ledger.reconcileAction({
      datasetKind: input.proposal.datasetKind,
      investigationId: input.proposal.investigationId,
      reservationId: input.proposal.reservationId,
      expectedCheckpointVersion: input.reservation.checkpoint.checkpoint_version,
      outcome: input.outcome,
      actualActiveSeconds: input.actualActiveSeconds,
      actualModelTokens: input.actualModelTokens,
      finishedAt: input.finishedAt,
    });
    if (reconciled.replayed === true) return { status: 'replayed', checkpoint: reconciled.checkpoint };
    if (reconciled.replayed !== false) return reviewRequired('reconciliation_uncertain');
    return reviewRequired(input.reason, reconciled.checkpoint);
  } catch {
    return reviewRequired('reconciliation_uncertain');
  }
}

async function invokePlannerWithDeadline(input: {
  readonly planner: InvestigationPlanner;
  readonly request: InvestigationPlanRequest;
  readonly maxTotalTokens: number;
  readonly maxActiveSeconds: number;
  readonly clock: ReasoningStepExecutorClock;
  readonly timer: ReasoningStepExecutorTimer;
  readonly startedAt: string;
}): Promise<DeadlineResult> {
  const controller = new AbortController();
  const startedMonotonic = readMonotonicTimestamp(input.clock);
  if (startedMonotonic === undefined) {
    return {
      kind: 'timer_error',
      actualActiveSeconds: input.maxActiveSeconds,
      finishedAt: input.startedAt,
    };
  }

  let resolveTimeout!: () => void;
  let didTimeout = false;
  const timeout = new Promise<'timeout'>((resolve) => {
    resolveTimeout = () => resolve('timeout');
  });
  let timerHandle: unknown;
  try {
    timerHandle = input.timer.setTimeout(() => {
      didTimeout = true;
      controller.abort();
      resolveTimeout();
    }, input.maxActiveSeconds * 1_000);
  } catch {
    return {
      kind: 'timer_error',
      actualActiveSeconds: input.maxActiveSeconds,
      finishedAt: input.startedAt,
    };
  }

  if (didTimeout || controller.signal.aborted) {
    clearTimer(input.timer, timerHandle);
    return {
      kind: 'timeout',
      actualActiveSeconds: input.maxActiveSeconds,
      finishedAt: finishTimestamp(input.clock, input.startedAt),
    };
  }

  const call = Promise.resolve().then(() => {
    if (controller.signal.aborted) throw new Error('aborted_before_call');
    return input.planner.propose(input.request, {
      signal: controller.signal,
      maxTotalTokens: input.maxTotalTokens,
    });
  }).then(
    (value) => ({ kind: 'result' as const, value }),
    () => ({ kind: 'error' as const }),
  );

  const completion = await Promise.race([call, timeout.then(() => ({ kind: 'timeout' as const }))]);
  clearTimer(input.timer, timerHandle);
  if (completion.kind === 'timeout') {
    if (!controller.signal.aborted) controller.abort();
    return {
      kind: 'timeout',
      actualActiveSeconds: input.maxActiveSeconds,
      finishedAt: finishTimestamp(input.clock, input.startedAt),
    };
  }
  const elapsed = elapsedActiveSeconds(input.clock, startedMonotonic, input.maxActiveSeconds);
  if (!elapsed.certain || elapsed.timedOut) {
    if (!controller.signal.aborted) controller.abort();
    return {
      kind: 'timeout',
      actualActiveSeconds: input.maxActiveSeconds,
      finishedAt: finishTimestamp(input.clock, input.startedAt),
    };
  }
  if (completion.kind === 'error') {
    return { kind: 'error', actualActiveSeconds: elapsed.seconds, finishedAt: finishTimestamp(input.clock, input.startedAt) };
  }
  return {
    kind: 'result',
    value: completion.value,
    actualActiveSeconds: elapsed.seconds,
    finishedAt: finishTimestamp(input.clock, input.startedAt),
  };
}

function parseProposal(value: unknown): ParsedProposal | undefined {
  const proposal = readStrictObject(value, [
    'datasetKind',
    'investigationId',
    'expectedCheckpointVersion',
    'reservationId',
    'reservedAt',
    'request',
  ]);
  if (!proposal
    || !isDatasetKind(proposal.datasetKind)
    || !isId(proposal.investigationId)
    || !isIntegerIn(proposal.expectedCheckpointVersion, 1, 2_147_483_647)
    || !isId(proposal.reservationId)
    || !isTimestamp(proposal.reservedAt)
    || !Object.prototype.hasOwnProperty.call(proposal, 'request')) {
    return undefined;
  }
  return {
    datasetKind: proposal.datasetKind,
    investigationId: proposal.investigationId,
    expectedCheckpointVersion: proposal.expectedCheckpointVersion as number,
    reservationId: proposal.reservationId,
    reservedAt: proposal.reservedAt as string,
    request: proposal.request,
  };
}

function isReadyPreflight(value: unknown): value is Extract<InvestigationPlannerPreflightOutcome, { readonly status: 'ready' }> {
  const result = readStrictObject(value, ['status', 'capability', 'request']);
  if (!result || result.status !== 'ready' || result.capability !== INVESTIGATION_PLAN_CAPABILITY) return false;
  const request = readStrictObject(result.request, ['schemaVersion', 'recordType', 'groundingContext', 'questions', 'actionMenu']);
  return request?.schemaVersion === INVESTIGATION_PLAN_VERSION
    && request.recordType === 'InvestigationPlanRequest'
    && Array.isArray(request.questions)
    && Array.isArray(request.actionMenu)
    && isRecord(request.groundingContext);
}

function matchesContextIdentity(
  checkpoint: InvestigationCheckpointRecord,
  proposal: ParsedProposal,
  request: InvestigationPlanRequest,
): boolean {
  try {
    const context = request.groundingContext;
    if (!isRecord(context) || context.sufficient !== false || context.datasetKind !== proposal.datasetKind) return false;
    const candidateEvents = context.candidateEvents;
    if (!Array.isArray(candidateEvents) || candidateEvents.length > 1) return false;
    let eventId: string | null = null;
    let eventVersion: number | null = null;
    if (candidateEvents.length === 1) {
      const candidateEvent = readStrictObject(candidateEvents[0], ['eventId', 'eventVersion']);
      if (!candidateEvent || typeof candidateEvent.eventId !== 'string'
        || !isIntegerIn(candidateEvent.eventVersion, 1, 2_147_483_647)) return false;
      eventId = candidateEvent.eventId;
      eventVersion = candidateEvent.eventVersion;
    }
    const questions = request.questions;
    if (!Array.isArray(context.missingFields) || !Array.isArray(context.conflicts)) return false;
    const questionCount = context.missingFields.length + context.conflicts.length;
    if (questionCount < 1 || questionCount > 20) return false;
    const expectedQuestions = [
      ...Array.from({ length: context.missingFields.length }, (_, index) => `missing_field_${index + 1}`),
      ...Array.from({ length: context.conflicts.length }, (_, index) => `conflict_${index + 1}`),
    ];
    return checkpoint.dataset_kind === proposal.datasetKind
      && checkpoint.investigation_id === proposal.investigationId
      && checkpoint.trace_id === context.traceId
      && checkpoint.candidate_id === context.candidateId
      && checkpoint.context_id === context.contextId
      && checkpoint.event_id === eventId
      && checkpoint.event_version === eventVersion
      && expectedQuestions.length === questionCount
      && sameStringArray(questions, expectedQuestions);
  } catch {
    return false;
  }
}

function parsePlannerSuccess(
  value: unknown,
  request: InvestigationPlanRequest,
  maxTotalTokens: number,
): ValidatedPlan | undefined {
  const result = readStrictObject(value, ['status', 'capability', 'value', 'usage']);
  if (!result || result.status !== 'succeeded' || result.capability !== INVESTIGATION_PLAN_CAPABILITY) return undefined;
  const usageRecord = readStrictObject(result.usage, [
    'inputTokens', 'outputTokens', 'totalTokens', 'modelVersion', 'promptVersion',
  ]);
  if (!usageRecord
    || !isNonNegativeInteger(usageRecord.inputTokens)
    || !isNonNegativeInteger(usageRecord.outputTokens)
    || !isNonNegativeInteger(usageRecord.totalTokens)
    || usageRecord.totalTokens !== (usageRecord.inputTokens as number) + (usageRecord.outputTokens as number)
    || (usageRecord.totalTokens as number) > maxTotalTokens
    || typeof usageRecord.modelVersion !== 'string'
    || !MODEL_VERSION_PATTERN.test(usageRecord.modelVersion)
    || typeof usageRecord.promptVersion !== 'string'
    || !MODEL_VERSION_PATTERN.test(usageRecord.promptVersion)) return undefined;
  const usage: InvestigationPlanUsage = {
    inputTokens: usageRecord.inputTokens as number,
    outputTokens: usageRecord.outputTokens as number,
    totalTokens: usageRecord.totalTokens as number,
    modelVersion: usageRecord.modelVersion,
    promptVersion: usageRecord.promptVersion,
  };

  const plan = result.value;
  const planHeader = readPlainDataRecord(plan, 5);
  if (!planHeader || planHeader.schemaVersion !== INVESTIGATION_PLAN_VERSION
    || planHeader.recordType !== 'InvestigationPlanResult') return undefined;
  if (planHeader.outcome === 'proposed') {
    const proposed = readStrictObject(plan, ['schemaVersion', 'recordType', 'outcome', 'actionName', 'input']);
    const trustedNames = new Set(request.actionMenu.map(({ name }) => name));
    if (!proposed || typeof proposed.actionName !== 'string' || !trustedNames.has(proposed.actionName)
      || !isRecord(proposed.input)) return undefined;
    return {
      outcome: 'proposed',
      value: {
        schemaVersion: INVESTIGATION_PLAN_VERSION,
        recordType: 'InvestigationPlanResult',
        outcome: 'proposed',
        actionName: proposed.actionName,
        input: proposed.input as ProposedInvestigationAction['input'],
      },
      usage,
    };
  }
  if (planHeader.outcome === 'abstained') {
    const abstained = readStrictObject(plan, ['schemaVersion', 'recordType', 'outcome', 'reason']);
    if (!abstained
      || (abstained.reason !== 'no_available_action'
        && abstained.reason !== 'ambiguous_context'
        && abstained.reason !== 'cannot_form_valid_input')) return undefined;
    return {
      outcome: 'abstained',
      value: {
        schemaVersion: INVESTIGATION_PLAN_VERSION,
        recordType: 'InvestigationPlanResult',
        outcome: 'abstained',
        reason: abstained.reason,
      },
      usage,
    };
  }
  return undefined;
}

function toModelRun(usage: InvestigationPlanUsage): ModelRun {
  return {
    capability: 'reasoning',
    model_version: usage.modelVersion,
    prompt_version: usage.promptVersion,
    input_tokens: usage.inputTokens,
    output_tokens: usage.outputTokens,
  };
}

function validLimits(maxActiveSeconds: number, maxModelTokens: number): boolean {
  return isIntegerIn(maxActiveSeconds, 1, 60) && isIntegerIn(maxModelTokens, 1, 12_000);
}

function ledgerErrorReason(error: unknown): ReasoningStepReviewReason {
  if (!(error instanceof InvestigationLedgerError)) return 'ledger_state_uncertain';
  switch (error.code) {
    case 'investigation_not_found':
      return 'investigation_not_found';
    case 'invalid_state':
      return 'investigation_not_open';
    case 'stale_checkpoint':
      return 'stale_checkpoint';
    case 'reservation_in_flight':
      return 'reservation_in_flight';
    case 'budget_exhausted':
      return 'budget_exhausted';
    case 'context_mismatch':
    case 'sufficient_context':
      return 'context_identity_mismatch';
    default:
      return 'ledger_state_uncertain';
  }
}

function readStrictObject(value: unknown, expectedKeys: readonly string[]): Record<string, unknown> | undefined {
  try {
    if (!isRecord(value) || Object.getPrototypeOf(value) !== Object.prototype) return undefined;
    const keys = Reflect.ownKeys(value);
    if (keys.length !== expectedKeys.length || keys.some((key) => typeof key !== 'string')) return undefined;
    const stringKeys = keys as string[];
    const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const key of expectedKeys) {
      if (!stringKeys.includes(key)) return undefined;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) return undefined;
      Object.defineProperty(result, key, { value: descriptor.value, enumerable: true });
    }
    return result;
  } catch {
    return undefined;
  }
}

function readPlainDataRecord(value: unknown, maximumKeys: number): Record<string, unknown> | undefined {
  try {
    if (!isRecord(value) || Object.getPrototypeOf(value) !== Object.prototype) return undefined;
    const keys = Reflect.ownKeys(value);
    if (keys.length > maximumKeys || keys.some((key) => typeof key !== 'string')) return undefined;
    const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const key of keys as string[]) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) return undefined;
      Object.defineProperty(result, key, { value: descriptor.value, enumerable: true });
    }
    return result;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function sameStringArray(left: unknown, right: unknown): boolean {
  return Array.isArray(left) && Array.isArray(right) && left.length === right.length
    && left.every((value, index) => typeof value === 'string' && value === right[index]);
}

function readWallTimestamp(clock: ReasoningStepExecutorClock): string | undefined {
  try {
    const value = clock.wallNow();
    return isTimestamp(value) ? new Date(Date.parse(value)).toISOString() : undefined;
  } catch {
    return undefined;
  }
}

function finishTimestamp(clock: ReasoningStepExecutorClock, startedAt: string): string {
  const value = readWallTimestamp(clock);
  return value && Date.parse(value) >= Date.parse(startedAt) ? value : startedAt;
}

function readMonotonicTimestamp(clock: ReasoningStepExecutorClock): number | undefined {
  try {
    const value = clock.monotonicNow();
    return Number.isFinite(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function elapsedActiveSeconds(
  clock: ReasoningStepExecutorClock,
  startedMonotonic: number,
  maximum: number,
): { readonly seconds: number; readonly certain: boolean; readonly timedOut: boolean } {
  const finishedMonotonic = readMonotonicTimestamp(clock);
  if (finishedMonotonic === undefined || finishedMonotonic < startedMonotonic) {
    return { seconds: maximum, certain: false, timedOut: false };
  }
  const elapsedMilliseconds = finishedMonotonic - startedMonotonic;
  const timedOut = elapsedMilliseconds >= maximum * 1_000;
  const seconds = Math.ceil(elapsedMilliseconds / 1_000);
  return { seconds: Math.min(maximum, Math.max(0, seconds)), certain: true, timedOut };
}

function clearTimer(timer: ReasoningStepExecutorTimer, handle: unknown): void {
  try {
    timer.clearTimeout(handle);
  } catch {
    // Timer cleanup is best effort; a late callback cannot repeat the planner call.
  }
}

function reviewRequired(
  reason: ReasoningStepReviewReason,
  checkpoint?: InvestigationCheckpointRecord,
  usage?: InvestigationPlanUsage,
): ReasoningStepExecutorResult {
  return {
    status: 'review_required',
    reason,
    ...(checkpoint ? { checkpoint } : {}),
    ...(usage ? { usage } : {}),
  };
}

function isDatasetKind(value: unknown): value is DatasetKind {
  return value === 'live' || value === 'historical' || value === 'synthetic';
}

function isId(value: unknown): value is string {
  return typeof value === 'string' && ID_PATTERN.test(value);
}

function isTimestamp(value: unknown): value is string {
  return typeof value === 'string' && TIMESTAMP_PATTERN.test(value) && Number.isFinite(Date.parse(value));
}

function isIntegerIn(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
