import type { GroundingContext } from './contracts.js';
import { validateReasoningRequest } from './validation.js';

export const INVESTIGATION_PLAN_VERSION = '1.0' as const;
export const INVESTIGATION_PLAN_CAPABILITY = 'investigation_planning' as const;

const ACTION_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/;
const MAX_ACTION_DESCRIPTION_LENGTH = 256;
const MAX_PLAN_INPUT_BYTES = 8 * 1024;
const MAX_PLAN_INPUT_DEPTH = 8;
const MAX_PLAN_CONTAINER_ITEMS = 32;
const MAX_PLAN_KEY_LENGTH = 64;
const MAX_PLAN_STRING_LENGTH = 2_048;

export type InvestigationAbstentionReason =
  | 'no_available_action'
  | 'ambiguous_context'
  | 'cannot_form_valid_input';

export interface InvestigationActionMenuEntry {
  readonly name: string;
  readonly description: string;
}

/** An internal request for one proposed L3 action. It grants no execution authority. */
export interface InvestigationPlanRequest {
  readonly schemaVersion: typeof INVESTIGATION_PLAN_VERSION;
  readonly recordType: 'InvestigationPlanRequest';
  readonly groundingContext: GroundingContext;
  /** Stable position labels produced by L3; these must match the context's gap counts. */
  readonly questions: readonly string[];
  /** A bounded menu supplied by trusted server composition, never registered here. */
  readonly actionMenu: readonly InvestigationActionMenuEntry[];
}

export type InvestigationPlanJsonValue =
  | string
  | number
  | boolean
  | null
  | readonly InvestigationPlanJsonValue[]
  | { readonly [key: string]: InvestigationPlanJsonValue };

export interface ProposedInvestigationAction {
  readonly schemaVersion: typeof INVESTIGATION_PLAN_VERSION;
  readonly recordType: 'InvestigationPlanResult';
  readonly outcome: 'proposed';
  readonly actionName: string;
  readonly input: { readonly [key: string]: InvestigationPlanJsonValue };
}

export interface AbstainedInvestigationPlan {
  readonly schemaVersion: typeof INVESTIGATION_PLAN_VERSION;
  readonly recordType: 'InvestigationPlanResult';
  readonly outcome: 'abstained';
  readonly reason: InvestigationAbstentionReason;
}

/** One proposed action or one fixed abstention; neither can authorize or stop work. */
export type InvestigationPlanResult = ProposedInvestigationAction | AbstainedInvestigationPlan;

export interface InvestigationPlanProvider {
  /** Implementations are injected; this repository includes no live provider. */
  plan(request: InvestigationPlanRequest, options: InvestigationPlanProviderCallOptions): Promise<unknown>;
}

export interface InvestigationPlanProviderCallOptions {
  readonly signal: AbortSignal;
  readonly maxTotalTokens: number;
}

/** Values are supplied by trusted adapter configuration, never provider output. */
export interface InvestigationPlannerMetadata {
  readonly modelVersion: string;
  readonly promptVersion: string;
}

export interface InvestigationPlanUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
  readonly modelVersion: string;
  readonly promptVersion: string;
}

export type InvestigationPlannerOutcome =
  | {
      readonly status: 'succeeded';
      readonly capability: typeof INVESTIGATION_PLAN_CAPABILITY;
      readonly value: InvestigationPlanResult;
      readonly usage: InvestigationPlanUsage;
    }
  | {
      readonly status: 'not_configured';
      readonly capability: typeof INVESTIGATION_PLAN_CAPABILITY;
      readonly reason: 'provider_not_configured' | 'model_metadata_not_configured';
    }
  | {
      readonly status: 'invalid_request';
      readonly capability: typeof INVESTIGATION_PLAN_CAPABILITY;
      readonly reason: 'malformed_request' | 'sufficient_context' | 'invalid_question_labels' | 'invalid_action_menu';
    }
  | {
      readonly status: 'invalid_output';
      readonly capability: typeof INVESTIGATION_PLAN_CAPABILITY;
      readonly reason: 'invalid_output';
    }
  | {
      readonly status: 'provider_error';
      readonly capability: typeof INVESTIGATION_PLAN_CAPABILITY;
    };

export type InvestigationPlannerPreflightOutcome =
  | {
      readonly status: 'ready';
      readonly capability: typeof INVESTIGATION_PLAN_CAPABILITY;
      readonly request: InvestigationPlanRequest;
    }
  | Exclude<InvestigationPlannerOutcome, { readonly status: 'succeeded' }>;

export interface InvestigationPlannerCallOptions {
  readonly signal: AbortSignal;
  readonly maxTotalTokens: number;
}

export interface InvestigationPlanner {
  /** Pure request/provider readiness check. It never invokes the provider. */
  preflight(request: unknown): Promise<InvestigationPlannerPreflightOutcome>;
  propose(request: unknown, options: InvestigationPlannerCallOptions): Promise<InvestigationPlannerOutcome>;
}

type RequestFailure = Extract<InvestigationPlannerOutcome, { readonly status: 'invalid_request' }>;
type JsonObject = { readonly [key: string]: InvestigationPlanJsonValue };

const MODEL_VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const PROMPT_VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/**
 * Creates a provider-injected proposal boundary. It validates retrieved context
 * and the trusted menu, then validates one provider result without executing it.
 */
export function createInvestigationPlanner(
  provider?: InvestigationPlanProvider,
  metadata?: InvestigationPlannerMetadata,
): InvestigationPlanner {
  const configuredMetadata = metadata && isTrustedMetadata(metadata)
    ? { modelVersion: metadata.modelVersion, promptVersion: metadata.promptVersion }
    : undefined;

  const preflight = async (rawRequest: unknown): Promise<InvestigationPlannerPreflightOutcome> => {
    const parsed = await parseRequest(rawRequest);
    if (!parsed.ok) {
      return {
        status: 'invalid_request',
        capability: INVESTIGATION_PLAN_CAPABILITY,
        reason: parsed.reason,
      };
    }
    if (!provider) {
      return {
        status: 'not_configured',
        capability: INVESTIGATION_PLAN_CAPABILITY,
        reason: 'provider_not_configured',
      };
    }
    if (!configuredMetadata) {
      return {
        status: 'not_configured',
        capability: INVESTIGATION_PLAN_CAPABILITY,
        reason: 'model_metadata_not_configured',
      };
    }
    try {
      if (typeof provider.plan !== 'function') {
        return {
          status: 'not_configured',
          capability: INVESTIGATION_PLAN_CAPABILITY,
          reason: 'provider_not_configured',
        };
      }
    } catch {
      return { status: 'provider_error', capability: INVESTIGATION_PLAN_CAPABILITY };
    }
    return {
      status: 'ready',
      capability: INVESTIGATION_PLAN_CAPABILITY,
      request: parsed.request,
    };
  };

  return {
    preflight,
    async propose(rawRequest, callOptions): Promise<InvestigationPlannerOutcome> {
      const ready = await preflight(rawRequest);
      if (ready.status !== 'ready') return ready;
      if (!provider || !configuredMetadata || !isCallOptions(callOptions)) {
        return { status: 'provider_error', capability: INVESTIGATION_PLAN_CAPABILITY };
      }

      let envelope: unknown;
      try {
        if (callOptions.signal.aborted) {
          return { status: 'provider_error', capability: INVESTIGATION_PLAN_CAPABILITY };
        }
        envelope = await provider.plan(ready.request, {
          signal: callOptions.signal,
          maxTotalTokens: callOptions.maxTotalTokens,
        });
      } catch {
        return { status: 'provider_error', capability: INVESTIGATION_PLAN_CAPABILITY };
      }

      try {
        const parsedEnvelope = parseProviderEnvelope(envelope, ready.request, callOptions.maxTotalTokens);
        return {
          status: 'succeeded',
          capability: INVESTIGATION_PLAN_CAPABILITY,
          value: parsedEnvelope.value,
          usage: {
            inputTokens: parsedEnvelope.inputTokens,
            outputTokens: parsedEnvelope.outputTokens,
            totalTokens: parsedEnvelope.inputTokens + parsedEnvelope.outputTokens,
            modelVersion: configuredMetadata.modelVersion,
            promptVersion: configuredMetadata.promptVersion,
          },
        };
      } catch {
        return {
          status: 'invalid_output',
          capability: INVESTIGATION_PLAN_CAPABILITY,
          reason: 'invalid_output',
        };
      }
    },
  };
}

function parseProviderEnvelope(
  value: unknown,
  request: InvestigationPlanRequest,
  maxTotalTokens: number,
): { readonly value: InvestigationPlanResult; readonly inputTokens: number; readonly outputTokens: number } {
  const envelope = exactRecord(value, ['result', 'inputTokens', 'outputTokens']);
  if (!isNonNegativeInteger(envelope.inputTokens) || !isNonNegativeInteger(envelope.outputTokens)) {
    throw new Error('invalid_usage');
  }
  const totalTokens = envelope.inputTokens + envelope.outputTokens;
  if (!Number.isSafeInteger(totalTokens) || totalTokens > maxTotalTokens) throw new Error('invalid_usage');
  const result = parseResult(envelope.result, actionNamesFor(request));
  return {
    value: result,
    inputTokens: envelope.inputTokens,
    outputTokens: envelope.outputTokens,
  };
}

function actionNamesFor(request: InvestigationPlanRequest): ReadonlySet<string> {
  return new Set(request.actionMenu.map(({ name }) => name));
}

function isTrustedMetadata(value: unknown): value is InvestigationPlannerMetadata {
  try {
    const metadataRecord = exactRecord(value, ['modelVersion', 'promptVersion']);
    return typeof metadataRecord.modelVersion === 'string'
      && MODEL_VERSION_PATTERN.test(metadataRecord.modelVersion)
      && typeof metadataRecord.promptVersion === 'string'
      && PROMPT_VERSION_PATTERN.test(metadataRecord.promptVersion);
  } catch {
    return false;
  }
}

function isCallOptions(value: unknown): value is InvestigationPlannerCallOptions {
  try {
    const options = exactRecord(value, ['signal', 'maxTotalTokens']);
    const signal = options.signal;
    return signal !== null
      && typeof signal === 'object'
      && typeof (signal as AbortSignal).aborted === 'boolean'
      && typeof (signal as AbortSignal).addEventListener === 'function'
      && isIntegerIn(options.maxTotalTokens, 1, 12_000);
  } catch {
    return false;
  }
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isIntegerIn(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}

async function parseRequest(
  value: unknown,
): Promise<{ readonly ok: true; readonly request: InvestigationPlanRequest; readonly allowedActionNames: ReadonlySet<string> }
  | { readonly ok: false; readonly reason: RequestFailure['reason'] }> {
  try {
    const request = exactRecord(value, ['schemaVersion', 'recordType', 'groundingContext', 'questions', 'actionMenu']);
    if (request.schemaVersion !== INVESTIGATION_PLAN_VERSION || request.recordType !== 'InvestigationPlanRequest') {
      return { ok: false, reason: 'malformed_request' };
    }

    const reasoningRequest = await validateReasoningRequest({
      data: { groundingContext: request.groundingContext },
    });
    const groundingContext = reasoningRequest.data.groundingContext;
    if (groundingContext.sufficient) return { ok: false, reason: 'sufficient_context' };

    const questions = readArray(request.questions, 1, 20);
    if (!questions) return { ok: false, reason: 'invalid_question_labels' };
    const expectedQuestions = [
      ...groundingContext.missingFields.map((_, index) => `missing_field_${index + 1}`),
      ...groundingContext.conflicts.map((_, index) => `conflict_${index + 1}`),
    ];
    if (expectedQuestions.length < 1 || expectedQuestions.length > 20
      || questions.length !== expectedQuestions.length
      || questions.some((question, index) => question !== expectedQuestions[index])) {
      return { ok: false, reason: 'invalid_question_labels' };
    }

    const menuEntries = readArray(request.actionMenu, 1, 16);
    if (!menuEntries) return { ok: false, reason: 'invalid_action_menu' };
    const actionMenu: InvestigationActionMenuEntry[] = [];
    const allowedActionNames = new Set<string>();
    for (const entry of menuEntries) {
      let menuEntry: Record<string, unknown>;
      try {
        menuEntry = exactRecord(entry, ['name', 'description']);
      } catch {
        return { ok: false, reason: 'invalid_action_menu' };
      }
      if (typeof menuEntry.name !== 'string' || !ACTION_NAME_PATTERN.test(menuEntry.name)
        || typeof menuEntry.description !== 'string'
        || codePointLength(menuEntry.description) < 1
        || codePointLength(menuEntry.description) > MAX_ACTION_DESCRIPTION_LENGTH
        || menuEntry.description.trim().length === 0
        || allowedActionNames.has(menuEntry.name)) {
        return { ok: false, reason: 'invalid_action_menu' };
      }
      allowedActionNames.add(menuEntry.name);
      actionMenu.push({ name: menuEntry.name, description: menuEntry.description });
    }

    const validatedRequest: InvestigationPlanRequest = {
      schemaVersion: INVESTIGATION_PLAN_VERSION,
      recordType: 'InvestigationPlanRequest',
      groundingContext,
      questions: [...questions] as string[],
      actionMenu,
    };
    deepFreeze(validatedRequest);
    return { ok: true, request: validatedRequest, allowedActionNames };
  } catch {
    return { ok: false, reason: 'malformed_request' };
  }
}

function parseResult(value: unknown, allowedActionNames: ReadonlySet<string>): InvestigationPlanResult {
  const record = readPlainDataRecord(value, 5);
  if (!record
    || record.schemaVersion !== INVESTIGATION_PLAN_VERSION
    || record.recordType !== 'InvestigationPlanResult') {
    throw new Error('invalid_output');
  }

  if (record.outcome === 'proposed') {
    const proposal = exactRecord(value, ['schemaVersion', 'recordType', 'outcome', 'actionName', 'input']);
    if (proposal.schemaVersion !== INVESTIGATION_PLAN_VERSION
      || proposal.recordType !== 'InvestigationPlanResult'
      || proposal.outcome !== 'proposed'
      || typeof proposal.actionName !== 'string'
      || !ACTION_NAME_PATTERN.test(proposal.actionName)
      || !allowedActionNames.has(proposal.actionName)) {
      throw new Error('invalid_output');
    }
    const input = cloneBoundedJsonObject(proposal.input);
    deepFreeze(input);
    return {
      schemaVersion: INVESTIGATION_PLAN_VERSION,
      recordType: 'InvestigationPlanResult',
      outcome: 'proposed',
      actionName: proposal.actionName,
      input,
    };
  }

  if (record.outcome === 'abstained') {
    const abstention = exactRecord(value, ['schemaVersion', 'recordType', 'outcome', 'reason']);
    if (abstention.schemaVersion !== INVESTIGATION_PLAN_VERSION
      || abstention.recordType !== 'InvestigationPlanResult'
      || abstention.outcome !== 'abstained'
      || (abstention.reason !== 'no_available_action'
        && abstention.reason !== 'ambiguous_context'
        && abstention.reason !== 'cannot_form_valid_input')) {
      throw new Error('invalid_output');
    }
    return {
      schemaVersion: INVESTIGATION_PLAN_VERSION,
      recordType: 'InvestigationPlanResult',
      outcome: 'abstained',
      reason: abstention.reason,
    };
  }

  throw new Error('invalid_output');
}

function cloneBoundedJsonObject(value: unknown): JsonObject {
  const byteCounter = { count: 0 };
  const active = new WeakSet<object>();
  const cloned = cloneJsonValue(value, 1, byteCounter, active);
  if (cloned === null || typeof cloned !== 'object' || Array.isArray(cloned)) throw new Error('invalid_output');
  if (byteCounter.count > MAX_PLAN_INPUT_BYTES) throw new Error('invalid_output');
  return cloned as JsonObject;
}

function cloneJsonValue(
  value: unknown,
  depth: number,
  byteCounter: { count: number },
  active: WeakSet<object>,
): InvestigationPlanJsonValue {
  if (value === null) {
    addBytes(byteCounter, 4);
    return null;
  }
  if (typeof value === 'string') {
    if (codePointLength(value) > MAX_PLAN_STRING_LENGTH) throw new Error('invalid_output');
    addBytes(byteCounter, encodedJsonStringLength(value));
    return value;
  }
  if (typeof value === 'boolean') {
    addBytes(byteCounter, value ? 4 : 5);
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('invalid_output');
    addBytes(byteCounter, new TextEncoder().encode(JSON.stringify(value)).length);
    return value;
  }
  if (typeof value !== 'object') throw new Error('invalid_output');
  if (depth > MAX_PLAN_INPUT_DEPTH || active.has(value)) throw new Error('invalid_output');
  active.add(value);
  try {
    if (Array.isArray(value)) return cloneJsonArray(value, depth, byteCounter, active);
    return cloneJsonRecord(value, depth, byteCounter, active);
  } finally {
    active.delete(value);
  }
}

function cloneJsonArray(
  value: unknown[],
  depth: number,
  byteCounter: { count: number },
  active: WeakSet<object>,
): readonly InvestigationPlanJsonValue[] {
  if (Object.getPrototypeOf(value) !== Array.prototype) throw new Error('invalid_output');
  const keys = Reflect.ownKeys(value);
  const length = value.length;
  if (length > MAX_PLAN_CONTAINER_ITEMS || keys.length !== length + 1) {
    throw new Error('invalid_output');
  }
  if (keys.some((key) => typeof key !== 'string'
    || (key !== 'length' && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= length)))) {
    throw new Error('invalid_output');
  }
  const output: InvestigationPlanJsonValue[] = [];
  addBytes(byteCounter, 2 + Math.max(0, length - 1));
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) throw new Error('invalid_output');
    output.push(cloneJsonValue(descriptor.value, depth + 1, byteCounter, active));
  }
  return output;
}

function cloneJsonRecord(
  value: object,
  depth: number,
  byteCounter: { count: number },
  active: WeakSet<object>,
): { readonly [key: string]: InvestigationPlanJsonValue } {
  if (Object.getPrototypeOf(value) !== Object.prototype) throw new Error('invalid_output');
  const keys = Reflect.ownKeys(value);
  if (keys.length > MAX_PLAN_CONTAINER_ITEMS || keys.some((key) => typeof key !== 'string')) {
    throw new Error('invalid_output');
  }
  const output: Record<string, InvestigationPlanJsonValue> = {};
  addBytes(byteCounter, 2 + Math.max(0, keys.length - 1) + keys.length);
  for (const key of keys as string[]) {
    if (codePointLength(key) > MAX_PLAN_KEY_LENGTH) throw new Error('invalid_output');
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) throw new Error('invalid_output');
    addBytes(byteCounter, encodedJsonStringLength(key));
    Object.defineProperty(output, key, {
      value: cloneJsonValue(descriptor.value, depth + 1, byteCounter, active),
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return output;
}

function encodedJsonStringLength(value: string): number {
  const encoded = JSON.stringify(value);
  if (typeof encoded !== 'string') throw new Error('invalid_output');
  return new TextEncoder().encode(encoded).length;
}

function addBytes(counter: { count: number }, count: number): void {
  counter.count += count;
  if (counter.count > MAX_PLAN_INPUT_BYTES) throw new Error('invalid_output');
}

function readArray(value: unknown, minimum: number, maximum: number): unknown[] | undefined {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return undefined;
  const length = value.length;
  if (length < minimum || length > maximum) return undefined;
  const keys = Reflect.ownKeys(value);
  if (keys.length !== length + 1 || keys.some((key) => typeof key !== 'string'
    || (key !== 'length' && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= length)))) return undefined;
  const result: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) return undefined;
    result.push(descriptor.value);
  }
  return result;
}

function exactRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  const record = readPlainDataRecord(value, keys.length);
  if (!record || Reflect.ownKeys(record).length !== keys.length
    || keys.some((key) => !Object.prototype.hasOwnProperty.call(record, key))) {
    throw new Error('invalid_record');
  }
  return record;
}

function readPlainDataRecord(value: unknown, maximumKeys: number): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) return undefined;
  const keys = Reflect.ownKeys(value);
  if (keys.length > maximumKeys || keys.some((key) => typeof key !== 'string')) return undefined;
  const record: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of keys as string[]) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) return undefined;
    Object.defineProperty(record, key, { value: descriptor.value, enumerable: true });
  }
  return record;
}

function codePointLength(value: string): number {
  return Array.from(value).length;
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor && 'value' in descriptor) deepFreeze(descriptor.value);
  }
  return value;
}
