import type {
  CreateInvestigationInput,
  InvestigationCheckpointRecord,
  InvestigationLedgerRepository,
  ReconcileActionInput,
} from '../../../../db/src/investigation-ledger.js';
import {
  L3_LEDGER_OPERATION_EVENT_NAME,
  noOpTelemetry,
  type L3LedgerOperation,
  type L3LedgerOperationErrorTelemetryRecord,
  type L3LedgerOperationSuccessTelemetryRecord,
  type TelemetrySink,
} from '../l5-evaluation-monitoring/telemetry.js';

/**
 * Decorate the local L3 ledger port with opt-in operational summaries.
 * Reads are forwarded directly and never produce telemetry.
 */
export function createTelemetryInvestigationLedgerRepository(
  repository: InvestigationLedgerRepository,
  telemetry: TelemetrySink = noOpTelemetry,
): InvestigationLedgerRepository {
  const instrument = <T>(
    operation: L3LedgerOperation,
    invoke: () => Promise<T>,
    checkpointFrom: (result: T) => unknown,
  ): Promise<T> => instrumentLedgerOperation(telemetry, operation, invoke, checkpointFrom);

  const decorated: InvestigationLedgerRepository = {
    create: (input: CreateInvestigationInput) => instrument(
      'create',
      () => repository.create(input),
      (checkpoint) => checkpoint,
    ),
    getLatest: (datasetKind, investigationId) => repository.getLatest(datasetKind, investigationId),
    getInFlightReservation: (datasetKind, investigationId) => (
      repository.getInFlightReservation(datasetKind, investigationId)
    ),
    reserveAction: (input) => instrument(
      'reserve_action',
      () => repository.reserveAction(input),
      (result) => result.checkpoint,
    ),
    startAction: (input) => instrument(
      'start_action',
      () => repository.startAction(input),
      (result) => result.checkpoint,
    ),
    reconcileAction: (input: ReconcileActionInput) => instrument(
      'reconcile_action',
      () => repository.reconcileAction(input),
      (result) => result.checkpoint,
    ),
    reconcileInterrupted: (input) => instrument(
      'reconcile_interrupted',
      () => repository.reconcileInterrupted(input),
      (result) => result.checkpoint,
    ),
    releaseUninvoked: (input) => instrument(
      'release_uninvoked',
      () => repository.releaseUninvoked(input),
      (result) => result.checkpoint,
    ),
    pause: (input) => instrument(
      'pause',
      () => repository.pause(input),
      (result) => result.checkpoint,
    ),
    resume: (input) => instrument(
      'resume',
      () => repository.resume(input),
      (result) => result.checkpoint,
    ),
    terminate: (input) => instrument(
      'terminate',
      () => repository.terminate(input),
      (result) => result.checkpoint,
    ),
  };

  return decorated;
}

async function instrumentLedgerOperation<T>(
  telemetry: TelemetrySink,
  operation: L3LedgerOperation,
  invoke: () => Promise<T>,
  checkpointFrom: (result: T) => unknown,
): Promise<T> {
  const startedAt = readMonotonicTime();
  try {
    const result = await invoke();
    safelyRecordSuccess(telemetry, operation, elapsedSince(startedAt), checkpointFrom, result);
    return result;
  } catch (error) {
    safelyRecord(telemetry, {
      eventName: L3_LEDGER_OPERATION_EVENT_NAME,
      operation,
      outcome: 'error',
      durationMs: elapsedSince(startedAt),
    });
    throw error;
  }
}

function safelyRecordSuccess<T>(
  telemetry: TelemetrySink,
  operation: L3LedgerOperation,
  durationMs: number,
  checkpointFrom: (result: T) => unknown,
  result: T,
): void {
  try {
    const checkpoint = checkpointFrom(result);
    const summary = summarizeCheckpoint(checkpoint);
    if (!summary) return;
    safelyRecord(telemetry, {
      eventName: L3_LEDGER_OPERATION_EVENT_NAME,
      operation,
      outcome: 'success',
      durationMs,
      ...summary,
    });
  } catch {
    // Invalid runtime data or telemetry must not alter the repository result.
  }
}

function summarizeCheckpoint(checkpoint: unknown): Pick<
  L3LedgerOperationSuccessTelemetryRecord,
  | 'caseStatus'
  | 'stopReason'
  | 'consumedToolAttempts'
  | 'consumedReasoningTurns'
  | 'consumedActiveSeconds'
  | 'consumedModelTokens'
> | undefined {
  const caseStatus = readOwnDataProperty(checkpoint, 'case_status');
  const stopReason = readOwnDataProperty(checkpoint, 'stop_reason');
  const budget = readOwnDataProperty(checkpoint, 'budget');
  const consumed = readOwnDataProperty(budget, 'consumed');
  const toolAttempts = readOwnDataProperty(consumed, 'tool_attempts');
  const reasoningTurns = readOwnDataProperty(consumed, 'reasoning_turns');
  const activeSeconds = readOwnDataProperty(consumed, 'active_seconds');
  const modelTokens = readOwnDataProperty(consumed, 'model_tokens');

  if (!isCaseStatus(caseStatus)
    || !(stopReason === null || isStopReason(stopReason))
    || !isNonNegativeInteger(toolAttempts)
    || !isNonNegativeInteger(reasoningTurns)
    || !isFiniteNonNegative(activeSeconds)
    || !isNonNegativeInteger(modelTokens)) {
    return undefined;
  }

  return {
    caseStatus,
    stopReason,
    consumedToolAttempts: toolAttempts,
    consumedReasoningTurns: reasoningTurns,
    consumedActiveSeconds: activeSeconds,
    consumedModelTokens: modelTokens,
  };
}

function readOwnDataProperty(value: unknown, key: string): unknown {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && 'value' in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

function readMonotonicTime(): number | undefined {
  try {
    const value = performance.now();
    return Number.isFinite(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function elapsedSince(startedAt: number | undefined): number {
  const finishedAt = readMonotonicTime();
  if (startedAt === undefined || finishedAt === undefined) return 0;
  const durationMs = finishedAt - startedAt;
  return Number.isFinite(durationMs) && durationMs >= 0 ? durationMs : 0;
}

function isCaseStatus(value: unknown): value is InvestigationCheckpointRecord['case_status'] {
  return value === 'open' || value === 'paused' || value === 'completed' || value === 'stopped_for_review';
}

function isStopReason(value: unknown): value is NonNullable<InvestigationCheckpointRecord['stop_reason']> {
  return value === 'limit_exhausted'
    || value === 'no_progress'
    || value === 'material_conflict'
    || value === 'tool_unavailable'
    || value === 'awaiting_moderator'
    || value === 'completed';
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function safelyRecord(
  telemetry: TelemetrySink,
  record: L3LedgerOperationErrorTelemetryRecord | L3LedgerOperationSuccessTelemetryRecord,
): void {
  try {
    telemetry.record(record);
  } catch {
    // Telemetry must not change a successful result or mask the original repository error.
  }
}
