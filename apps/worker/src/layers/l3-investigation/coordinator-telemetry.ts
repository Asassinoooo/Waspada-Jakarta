import type {
  InvestigationCoordinator,
  InvestigationCoordinatorAdvanceInput,
  InvestigationCoordinatorOutcome,
  InvestigationCoordinatorReviewReason,
} from './contracts.js';
import {
  L3_COORDINATOR_ADVANCE_EVENT_NAME,
  noOpTelemetry,
  type L3CoordinatorAdvanceOutcome,
  type TelemetrySink,
} from '../l5-evaluation-monitoring/telemetry.js';

const COORDINATOR_OUTCOMES = new Set<InvestigationCoordinatorOutcome['status']>([
  'continue',
  'sufficient_context',
  'review_required',
]);
const COORDINATOR_REVIEW_REASONS = new Set<InvestigationCoordinatorReviewReason>([
  'invalid_input',
  'invalid_handoff',
  'entry_rejected',
  'insufficient_context_required',
  'invalid_context',
  'context_identity_mismatch',
  'case_not_found',
  'case_not_open',
  'stale_checkpoint',
  'budget_exhausted',
  'planner_abstained',
  'planner_timed_out',
  'planner_unavailable',
  'replayed_planner_step',
  'action_denied',
  'duplicate_action',
  'action_timed_out',
  'action_failed',
  'replayed_action_step',
  'action_uncertain',
  'refresh_failed',
  'invalid_refreshed_context',
  'material_dispute',
  'no_progress',
  'ledger_uncertain',
]);

/** Add opt-in, content-free measurements around one bounded coordinator advance. */
export function createTelemetryInvestigationCoordinator(
  coordinator: InvestigationCoordinator,
  telemetry: TelemetrySink = noOpTelemetry,
  monotonicNow: () => number = () => performance.now(),
): InvestigationCoordinator {
  return {
    advance: (input: InvestigationCoordinatorAdvanceInput) => (
      instrumentAdvance(coordinator, input, telemetry, monotonicNow)
    ),
  };
}

async function instrumentAdvance(
  coordinator: InvestigationCoordinator,
  input: InvestigationCoordinatorAdvanceInput,
  telemetry: TelemetrySink,
  monotonicNow: () => number,
): Promise<InvestigationCoordinatorOutcome> {
  const startedAt = readMonotonicTime(monotonicNow);
  let result: InvestigationCoordinatorOutcome;

  try {
    result = await coordinator.advance(input);
  } catch (error) {
    safelyRecord(telemetry, 'error', elapsedSince(startedAt, monotonicNow));
    throw error;
  }

  const outcome = readOutcome(result);
  safelyRecord(telemetry, outcome, elapsedSince(startedAt, monotonicNow));
  return result;
}

/**
 * Validate the closed status envelope and required plain-record presence only.
 * Nested record semantics belong to the coordinator, L2, and database contracts.
 */
function readOutcome(value: unknown): L3CoordinatorAdvanceOutcome {
  try {
    if (!isPlainRecord(value)) return 'error';
    const status = readOwnDataProperty(value, 'status');
    if (!COORDINATOR_OUTCOMES.has(status as InvestigationCoordinatorOutcome['status'])) return 'error';

    if (status === 'continue') {
      return hasExactOutcomeKeys(value, ['status', 'checkpoint', 'context', 'persistedRecord'])
        && hasRequiredRecord(value, 'checkpoint')
        && hasRequiredRecord(value, 'context')
        && hasRequiredRecord(value, 'persistedRecord')
        ? status
        : 'error';
    }

    if (status === 'sufficient_context') {
      return hasExactOutcomeKeys(value, ['status', 'context', 'persistedRecord'], ['checkpoint'])
        && hasRequiredRecord(value, 'context')
        && hasRequiredRecord(value, 'persistedRecord')
        && hasOptionalRecord(value, 'checkpoint')
        ? status
        : 'error';
    }

    if (status !== 'review_required') return 'error';
    const reason = readOwnDataProperty(value, 'reason');
    return hasExactOutcomeKeys(value, ['status', 'reason'], ['checkpoint'])
      && COORDINATOR_REVIEW_REASONS.has(reason as InvestigationCoordinatorReviewReason)
      && hasOptionalRecord(value, 'checkpoint')
      ? status
      : 'error';
  } catch {
    return 'error';
  }
}

function hasExactOutcomeKeys(
  value: object,
  requiredKeys: readonly string[],
  optionalKeys: readonly string[] = [],
): boolean {
  try {
    const allowed = new Set([...requiredKeys, ...optionalKeys]);
    const keys = Reflect.ownKeys(value);
    return requiredKeys.every((key) => keys.includes(key))
      && keys.every((key) => typeof key === 'string' && allowed.has(key));
  } catch {
    return false;
  }
}

function readOwnDataProperty(value: unknown, key: string): unknown {
  const descriptor = readOwnDataDescriptor(value, key);
  return descriptor && Object.prototype.hasOwnProperty.call(descriptor, 'value')
    ? descriptor.value
    : undefined;
}

function hasRequiredRecord(value: object, key: string): boolean {
  const descriptor = readOwnDataDescriptor(value, key);
  return descriptor !== undefined
    && Object.prototype.hasOwnProperty.call(descriptor, 'value')
    && isPlainRecord(descriptor.value);
}

function hasOptionalRecord(value: object, key: string): boolean {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor === undefined
      || (descriptor.enumerable === true
        && Object.prototype.hasOwnProperty.call(descriptor, 'value')
        && isPlainRecord(descriptor.value));
  } catch {
    return false;
  }
}

function readOwnDataDescriptor(value: unknown, key: string): PropertyDescriptor | undefined {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || descriptor.enumerable !== true
      || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) return undefined;
    return descriptor;
  } catch {
    return undefined;
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

function readMonotonicTime(monotonicNow: () => number): number | undefined {
  try {
    const value = monotonicNow();
    return Number.isFinite(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function elapsedSince(startedAt: number | undefined, monotonicNow: () => number): number {
  const finishedAt = readMonotonicTime(monotonicNow);
  if (startedAt === undefined || finishedAt === undefined) return 0;
  const durationMs = finishedAt - startedAt;
  return Number.isFinite(durationMs) && durationMs >= 0 ? durationMs : 0;
}

function safelyRecord(
  telemetry: TelemetrySink,
  outcome: L3CoordinatorAdvanceOutcome,
  durationMs: number,
): void {
  try {
    telemetry.record({
      eventName: L3_COORDINATOR_ADVANCE_EVENT_NAME,
      outcome,
      durationMs,
    });
  } catch {
    // Telemetry cannot change the coordinator result or mask its original error.
  }
}
