import type {
  ActionOutcome,
  InvestigationCheckpointRecord,
  InvestigationLedgerRepository,
  ReconcileActionInput,
  ReserveActionInput,
} from '../../../../db/src/investigation-ledger.js';
import type { DatasetKind } from '../../../../db/src/ports.js';
import {
  createTelemetryInvestigationLedgerRepository,
} from './telemetry.js';
import type { TelemetrySink } from '../l5-evaluation-monitoring/telemetry.js';

const ACTION_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const MAX_INPUT_DEPTH = 16;
const MAX_INPUT_NODES = 1_000;
const MAX_INPUT_STRING_LENGTH = 16_384;
const MAX_OUTPUT_REFERENCES = 8;

export interface InvestigationActionInputParseResult {
  readonly ok: boolean;
  readonly value?: unknown;
}

export interface InvestigationActionHandlerContext {
  readonly signal: AbortSignal;
}

/** A capability supplied by trusted Worker composition. */
export interface InvestigationActionRegistration {
  readonly name: string;
  readonly enabled: boolean;
  readonly maxActiveSeconds: number;
  readonly parseInput: (input: unknown) => InvestigationActionInputParseResult;
  readonly handler: (
    input: unknown,
    context: InvestigationActionHandlerContext,
  ) => unknown | Promise<unknown>;
}

export interface SingleStepExecutorClock {
  /** Returns an RFC 3339 timestamp for ledger transitions. */
  readonly wallNow: () => string;
  /** Returns a non-decreasing monotonic time in milliseconds. */
  readonly monotonicNow: () => number;
}

export interface SingleStepExecutorTimer {
  readonly setTimeout: (callback: () => void, delayMs: number) => unknown;
  readonly clearTimeout: (handle: unknown) => void;
}

export interface SingleStepActionProposal {
  readonly datasetKind: DatasetKind;
  readonly investigationId: string;
  readonly expectedCheckpointVersion: number;
  readonly reservationId: string;
  readonly reservedAt: string;
  readonly actionName: string;
  readonly input: unknown;
}

export type SingleStepReviewReason =
  | 'invalid_proposal'
  | 'invalid_action_input'
  | 'clock_unavailable'
  | 'reservation_result_uncertain'
  | 'start_not_authorized';

export type SingleStepExecutorResult =
  | {
      readonly status: 'denied';
      readonly reason: 'unknown_action' | 'action_disabled';
    }
  | {
      readonly status: 'review_required';
      readonly reason: SingleStepReviewReason;
      readonly checkpoint?: InvestigationCheckpointRecord;
    }
  | {
      readonly status: 'replayed';
      readonly checkpoint: InvestigationCheckpointRecord;
    }
  | {
      readonly status: 'executed';
      readonly checkpoint: InvestigationCheckpointRecord;
      readonly receipt: {
        readonly outcome: ActionOutcome;
        readonly outputReferenceIds: readonly string[];
      };
    };

export interface SingleStepExecutorOptions {
  readonly ledger: InvestigationLedgerRepository;
  readonly registry: readonly InvestigationActionRegistration[];
  readonly clock: SingleStepExecutorClock;
  readonly timer: SingleStepExecutorTimer;
  readonly telemetry?: TelemetrySink;
}

export interface SingleStepExecutor {
  execute(proposal: unknown): Promise<SingleStepExecutorResult>;
}

interface ParsedProposal extends SingleStepActionProposal {}

interface ParsedHandlerReceipt {
  readonly outcome: Exclude<ActionOutcome, 'timed_out'>;
  readonly outputReferenceIds: readonly string[];
}

interface InvocationReceipt {
  readonly outcome: ActionOutcome;
  readonly outputReferenceIds: readonly string[];
  readonly actualActiveSeconds: number;
  readonly finishedAt: string;
}

type HandlerCompletion =
  | { readonly kind: 'result'; readonly value: unknown }
  | { readonly kind: 'error' }
  | { readonly kind: 'timeout' };

/**
 * Executes one caller-supplied action proposal after a durable reservation.
 * Inject only reviewed capabilities; this service does not plan or loop.
 */
export function createSingleStepExecutor(options: SingleStepExecutorOptions): SingleStepExecutor {
  const actionRegistry = createRegistry(options.registry);
  const ledger = options.telemetry
    ? createTelemetryInvestigationLedgerRepository(options.ledger, options.telemetry)
    : options.ledger;

  return {
    async execute(rawProposal): Promise<SingleStepExecutorResult> {
      const proposal = parseProposal(rawProposal);
      if (!proposal) return { status: 'review_required', reason: 'invalid_proposal' };

      const action = actionRegistry.get(proposal.actionName);
      if (!action) return { status: 'denied', reason: 'unknown_action' };
      if (!action.enabled) return { status: 'denied', reason: 'action_disabled' };

      let parsedInput: InvestigationActionInputParseResult;
      try {
        parsedInput = action.parseInput(proposal.input);
      } catch {
        return { status: 'review_required', reason: 'invalid_action_input' };
      }
      const parsedActionInput = parseInputResult(parsedInput);
      if (!parsedActionInput.ok) return { status: 'review_required', reason: 'invalid_action_input' };

      const reserveInput: ReserveActionInput = {
        datasetKind: proposal.datasetKind,
        investigationId: proposal.investigationId,
        reservationId: proposal.reservationId,
        expectedCheckpointVersion: proposal.expectedCheckpointVersion,
        actionKind: 'tool',
        actionName: action.name,
        reservedActiveSeconds: action.maxActiveSeconds,
        reservedModelTokens: 0,
        reservedAt: proposal.reservedAt,
      };
      const reservation = await ledger.reserveAction(reserveInput);
      if (reservation.replayed === true) {
        return { status: 'replayed', checkpoint: reservation.checkpoint };
      }
      if (reservation.replayed !== false) {
        return {
          status: 'review_required',
          reason: 'reservation_result_uncertain',
          checkpoint: reservation.checkpoint,
        };
      }

      const startedAt = readWallTimestamp(options.clock);
      if (!startedAt || Date.parse(startedAt) < Date.parse(proposal.reservedAt)) {
        const released = await ledger.releaseUninvoked({
          datasetKind: proposal.datasetKind,
          investigationId: proposal.investigationId,
          reservationId: proposal.reservationId,
          expectedCheckpointVersion: reservation.checkpoint.checkpoint_version,
          releasedAt: proposal.reservedAt,
        });
        return {
          status: 'review_required',
          reason: 'clock_unavailable',
          checkpoint: released.checkpoint,
        };
      }

      const started = await ledger.startAction({
        datasetKind: proposal.datasetKind,
        investigationId: proposal.investigationId,
        reservationId: proposal.reservationId,
        startedAt,
      });
      if (started.mayInvoke !== true || started.replayed !== false) {
        if (started.replayed === true) {
          return { status: 'replayed', checkpoint: started.checkpoint };
        }
        return {
          status: 'review_required',
          reason: 'start_not_authorized',
          checkpoint: started.checkpoint,
        };
      }

      const invocation = await invokeWithDeadline({
        action,
        input: parsedActionInput.value,
        clock: options.clock,
        timer: options.timer,
        startedAt,
      });
      const reconcileInput: ReconcileActionInput = {
        datasetKind: proposal.datasetKind,
        investigationId: proposal.investigationId,
        reservationId: proposal.reservationId,
        expectedCheckpointVersion: reservation.checkpoint.checkpoint_version,
        outcome: invocation.outcome,
        actualActiveSeconds: invocation.actualActiveSeconds,
        actualModelTokens: 0,
        finishedAt: invocation.finishedAt,
      };
      const reconciled = await ledger.reconcileAction(reconcileInput);
      return {
        status: 'executed',
        checkpoint: reconciled.checkpoint,
        receipt: {
          outcome: invocation.outcome,
          outputReferenceIds: invocation.outputReferenceIds,
        },
      };
    },
  };
}

function createRegistry(
  registrations: readonly InvestigationActionRegistration[],
): ReadonlyMap<string, InvestigationActionRegistration> {
  if (!Array.isArray(registrations)) throw new Error('invalid_action_registry');
  const registry = new Map<string, InvestigationActionRegistration>();
  for (const candidate of registrations) {
    const record = readStrictObject(candidate, ['name', 'enabled', 'maxActiveSeconds', 'parseInput', 'handler']);
    if (!record
      || typeof record.name !== 'string'
      || !ACTION_NAME_PATTERN.test(record.name)
      || typeof record.enabled !== 'boolean'
      || !isIntegerIn(record.maxActiveSeconds, 1, 60)
      || typeof record.parseInput !== 'function'
      || typeof record.handler !== 'function'
      || registry.has(record.name)) {
      throw new Error('invalid_action_registry');
    }
    registry.set(record.name, {
      name: record.name,
      enabled: record.enabled,
      maxActiveSeconds: record.maxActiveSeconds,
      parseInput: record.parseInput as InvestigationActionRegistration['parseInput'],
      handler: record.handler as InvestigationActionRegistration['handler'],
    });
  }
  return registry;
}

function parseProposal(value: unknown): ParsedProposal | undefined {
  const proposal = readStrictObject(value, [
    'datasetKind',
    'investigationId',
    'expectedCheckpointVersion',
    'reservationId',
    'reservedAt',
    'actionName',
    'input',
  ]);
  if (!proposal
    || !isDatasetKind(proposal.datasetKind)
    || !isId(proposal.investigationId)
    || !isIntegerIn(proposal.expectedCheckpointVersion, 1, 2_147_483_647)
    || !isId(proposal.reservationId)
    || !isTimestamp(proposal.reservedAt)
    || typeof proposal.actionName !== 'string'
    || !ACTION_NAME_PATTERN.test(proposal.actionName)) {
    return undefined;
  }
  const copiedInput = cloneJsonValue(proposal.input);
  if (!copiedInput.ok) return undefined;
  return {
    datasetKind: proposal.datasetKind,
    investigationId: proposal.investigationId,
    expectedCheckpointVersion: proposal.expectedCheckpointVersion,
    reservationId: proposal.reservationId,
    reservedAt: proposal.reservedAt,
    actionName: proposal.actionName,
    input: copiedInput.value,
  };
}

function parseInputResult(value: unknown): { readonly ok: true; readonly value: unknown } | { readonly ok: false } {
  try {
    if (!isPlainObject(value)) return { ok: false };
    const okDescriptor = Object.getOwnPropertyDescriptor(value, 'ok');
    if (!okDescriptor || !('value' in okDescriptor) || typeof okDescriptor.value !== 'boolean') return { ok: false };
    if (okDescriptor.value === false) return { ok: false };
    const result = readStrictObject(value, ['ok', 'value']);
    if (!result || result.ok !== true || !Object.prototype.hasOwnProperty.call(result, 'value')) return { ok: false };
    return { ok: true, value: result.value };
  } catch {
    return { ok: false };
  }
}

async function invokeWithDeadline(input: {
  readonly action: InvestigationActionRegistration;
  readonly input: unknown;
  readonly clock: SingleStepExecutorClock;
  readonly timer: SingleStepExecutorTimer;
  readonly startedAt: string;
}): Promise<InvocationReceipt> {
  const controller = new AbortController();
  let handle: unknown;
  let timeoutFired = false;
  let timeoutResolve: (() => void) | undefined;
  const timeoutPromise = new Promise<HandlerCompletion>((resolve) => {
    timeoutResolve = () => resolve({ kind: 'timeout' });
  });

  try {
    handle = input.timer.setTimeout(() => {
      timeoutFired = true;
      try {
        controller.abort();
      } catch {
        // The timeout result remains authoritative if a custom signal throws.
      }
      timeoutResolve?.();
    }, input.action.maxActiveSeconds * 1_000);
  } catch {
    return genericFailure(input.startedAt, input.action.maxActiveSeconds);
  }

  if (timeoutFired || controller.signal.aborted) {
    try {
      input.timer.clearTimeout(handle);
    } catch {
      // Timer cleanup must not replace the closed timeout result.
    }
    return timeoutReceipt(input.startedAt, readFinishTimestamp(input.clock, input.startedAt), input.action.maxActiveSeconds);
  }

  let startedMonotonic: number | undefined;
  try {
    startedMonotonic = input.clock.monotonicNow();
    if (!Number.isFinite(startedMonotonic)) startedMonotonic = undefined;
  } catch {
    startedMonotonic = undefined;
  }

  if (timeoutFired || controller.signal.aborted) {
    try {
      input.timer.clearTimeout(handle);
    } catch {
      // Timer cleanup must not replace the closed timeout result.
    }
    return timeoutReceipt(input.startedAt, readFinishTimestamp(input.clock, input.startedAt), input.action.maxActiveSeconds);
  }

  let handlerResult: Promise<HandlerCompletion>;
  try {
    handlerResult = Promise.resolve(input.action.handler(input.input, { signal: controller.signal }))
      .then<HandlerCompletion, HandlerCompletion>(
        (value) => ({ kind: 'result', value }),
        () => ({ kind: 'error' }),
      );
  } catch {
    handlerResult = Promise.resolve({ kind: 'error' });
  }

  let completion: HandlerCompletion;
  try {
    completion = await Promise.race([handlerResult, timeoutPromise]);
  } finally {
    try {
      input.timer.clearTimeout(handle);
    } catch {
      // Timer cleanup must not replace the action's closed result.
    }
  }

  if (completion.kind === 'timeout') {
    return timeoutReceipt(input.startedAt, readFinishTimestamp(input.clock, input.startedAt), input.action.maxActiveSeconds);
  }

  const measuredFinishedAt = readWallTimestamp(input.clock);
  const finishTimestampValid = measuredFinishedAt !== undefined
    && Date.parse(measuredFinishedAt) >= Date.parse(input.startedAt);
  const finishedAt = finishTimestampValid ? measuredFinishedAt : input.startedAt;
  const finishedMonotonic = readMonotonicTimestamp(input.clock);
  if (startedMonotonic !== undefined
    && finishedMonotonic !== undefined
    && finishedMonotonic >= startedMonotonic
    && finishedMonotonic - startedMonotonic >= input.action.maxActiveSeconds * 1_000) {
    try {
      controller.abort();
    } catch {
      // The deadline result remains authoritative.
    }
    return timeoutReceipt(input.startedAt, finishedAt, input.action.maxActiveSeconds);
  }
  if (completion.kind === 'error') return genericFailure(finishedAt, input.action.maxActiveSeconds);
  if (!finishTimestampValid) return genericFailure(input.startedAt, input.action.maxActiveSeconds);
  if (startedMonotonic === undefined || finishedMonotonic === undefined || finishedMonotonic < startedMonotonic) {
    return genericFailure(finishedAt, input.action.maxActiveSeconds);
  }

  const elapsedMs = finishedMonotonic - startedMonotonic;
  if (!Number.isFinite(elapsedMs) || elapsedMs >= input.action.maxActiveSeconds * 1_000) {
    try {
      controller.abort();
    } catch {
      // The deadline result remains authoritative.
    }
    return {
      outcome: 'timed_out',
      actualActiveSeconds: input.action.maxActiveSeconds,
      outputReferenceIds: [],
      finishedAt,
    };
  }

  const parsedReceipt = parseHandlerReceipt(completion.value);
  if (!parsedReceipt) return genericFailure(finishedAt, input.action.maxActiveSeconds);

  const actualActiveSeconds = Math.min(
    input.action.maxActiveSeconds,
    Math.ceil(elapsedMs / 1_000),
  );
  return {
    ...parsedReceipt,
    actualActiveSeconds,
    finishedAt,
  };
}

function parseHandlerReceipt(value: unknown): ParsedHandlerReceipt | undefined {
  try {
    const receipt = readOptionalReferenceObject(value);
    if (!receipt
      || (receipt.status !== 'succeeded'
        && receipt.status !== 'failed'
        && receipt.status !== 'denied'
        && receipt.status !== 'cancelled')) {
      return undefined;
    }

    let references: readonly string[] = [];
    if (Object.prototype.hasOwnProperty.call(receipt, 'outputReferenceIds')) {
      const parsedReferences = parseOutputReferences(receipt.outputReferenceIds);
      if (!parsedReferences) return undefined;
      references = parsedReferences;
    }
    if (receipt.status !== 'succeeded' && references.length > 0) return undefined;
    return { outcome: receipt.status, outputReferenceIds: references };
  } catch {
    return undefined;
  }
}

function readOptionalReferenceObject(value: unknown): Record<string, unknown> | undefined {
  if (!isPlainObject(value)) return undefined;
  const keys = Reflect.ownKeys(value);
  if (keys.length < 1 || keys.length > 2 || keys.some((key) => typeof key !== 'string')) return undefined;
  const stringKeys = keys as string[];
  if (!stringKeys.includes('status')
    || stringKeys.some((key) => key !== 'status' && key !== 'outputReferenceIds')) return undefined;
  const record: Record<string, unknown> = {};
  for (const key of stringKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) return undefined;
    Object.defineProperty(record, key, { value: descriptor.value, enumerable: true, writable: true, configurable: true });
  }
  return record;
}

function parseOutputReferences(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return undefined;
  if (value.length > MAX_OUTPUT_REFERENCES) return undefined;
  const keys = Reflect.ownKeys(value);
  if (keys.length !== value.length + 1 || keys.some((key) => typeof key !== 'string')) return undefined;
  const stringKeys = keys as string[];
  const references: string[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable
      || typeof descriptor.value !== 'string' || !isId(descriptor.value) || seen.has(descriptor.value)) {
      return undefined;
    }
    seen.add(descriptor.value);
    references.push(descriptor.value);
  }
  if (stringKeys.some((key) => key !== 'length' && (!/^\d+$/.test(key) || Number(key) >= value.length))) return undefined;
  return references;
}

function genericFailure(finishedAt: string, maximumSeconds: number): InvocationReceipt {
  return {
    outcome: 'failed',
    actualActiveSeconds: maximumSeconds,
    outputReferenceIds: [],
    finishedAt,
  };
}

function timeoutReceipt(startedAt: string, finishedAt: string, maximumSeconds: number): InvocationReceipt {
  return {
    outcome: 'timed_out',
    actualActiveSeconds: maximumSeconds,
    outputReferenceIds: [],
    finishedAt: Date.parse(finishedAt) >= Date.parse(startedAt) ? finishedAt : startedAt,
  };
}

function readFinishTimestamp(clock: SingleStepExecutorClock, startedAt: string): string {
  const value = readWallTimestamp(clock);
  return value && Date.parse(value) >= Date.parse(startedAt) ? value : startedAt;
}

function readWallTimestamp(clock: SingleStepExecutorClock): string | undefined {
  try {
    const value = clock.wallNow();
    return isTimestamp(value) ? new Date(value).toISOString() : undefined;
  } catch {
    return undefined;
  }
}

function readMonotonicTimestamp(clock: SingleStepExecutorClock): number | undefined {
  try {
    const value = clock.monotonicNow();
    return Number.isFinite(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function readStrictObject(value: unknown, expectedKeys: readonly string[]): Record<string, unknown> | undefined {
  try {
    if (!isPlainObject(value)) return undefined;
    const keys = Reflect.ownKeys(value);
    if (keys.length !== expectedKeys.length || keys.some((key) => typeof key !== 'string')) return undefined;
    const stringKeys = keys as string[];
    const record: Record<string, unknown> = {};
    for (const expectedKey of expectedKeys) {
      if (!stringKeys.includes(expectedKey)) return undefined;
      const descriptor = Object.getOwnPropertyDescriptor(value, expectedKey);
      if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) return undefined;
      Object.defineProperty(record, expectedKey, {
        value: descriptor.value,
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return record;
  } catch {
    return undefined;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

type CloneResult = { readonly ok: true; readonly value: unknown } | { readonly ok: false };

function cloneJsonValue(value: unknown): CloneResult {
  const seen = new WeakSet<object>();
  let nodeCount = 0;

  const clone = (current: unknown, depth: number): CloneResult => {
    nodeCount += 1;
    if (nodeCount > MAX_INPUT_NODES || depth > MAX_INPUT_DEPTH) return { ok: false };
    if (current === null || typeof current === 'boolean') return { ok: true, value: current };
    if (typeof current === 'string') {
      return current.length <= MAX_INPUT_STRING_LENGTH ? { ok: true, value: current } : { ok: false };
    }
    if (typeof current === 'number') return Number.isFinite(current) ? { ok: true, value: current } : { ok: false };
    if (typeof current !== 'object') return { ok: false };
    if (seen.has(current)) return { ok: false };
    seen.add(current);

    if (Array.isArray(current)) {
      if (Object.getPrototypeOf(current) !== Array.prototype || current.length > MAX_INPUT_NODES) return { ok: false };
      const keys = Reflect.ownKeys(current);
      if (keys.length !== current.length + 1 || keys.some((key) => typeof key !== 'string')) return { ok: false };
      const stringKeys = keys as string[];
      const items: unknown[] = [];
      for (let index = 0; index < current.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(current, String(index));
        if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) return { ok: false };
        const item = clone(descriptor.value, depth + 1);
        if (!item.ok) return item;
        items.push(item.value);
      }
      if (stringKeys.some((key) => key !== 'length' && (!/^\d+$/.test(key) || Number(key) >= current.length))) {
        return { ok: false };
      }
      return { ok: true, value: items };
    }

    if (!isPlainObject(current)) return { ok: false };
    const keys = Reflect.ownKeys(current);
    if (keys.length > MAX_INPUT_NODES || keys.some((key) => typeof key !== 'string')) return { ok: false };
    const output: Record<string, unknown> = {};
    for (const key of keys as string[]) {
      const descriptor = Object.getOwnPropertyDescriptor(current, key);
      if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) return { ok: false };
      const property = clone(descriptor.value, depth + 1);
      if (!property.ok) return property;
      Object.defineProperty(output, key, {
        value: property.value,
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return { ok: true, value: output };
  };

  try {
    return clone(value, 0);
  } catch {
    return { ok: false };
  }
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
  return typeof value === 'number' && Number.isInteger(value) && value >= minimum && value <= maximum;
}
