import { InvestigationLedgerError } from '../../../../db/src/investigation-ledger.js';
import type {
  InvestigationLedgerRepository,
  InvestigationProgressOperationResult,
} from '../../../../db/src/investigation-ledger.js';
import type { DatasetKind } from '../../../../db/src/ports.js';
import type { GroundingContext } from '../l2-model-grounding/contracts.js';

type RuntimeSubtleCrypto = NonNullable<typeof globalThis.crypto>['subtle'];
type RuntimeCryptoKey = Parameters<RuntimeSubtleCrypto['sign']>[1];

const KEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAX_CANONICAL_INPUT_CODE_UNITS = 32_768;
const MAX_CANONICAL_INPUT_NODES = 1_000;
const MAX_CANONICAL_INPUT_DEPTH = 16;

export interface L3FingerprintKeyConfig {
  readonly keyId: unknown;
  readonly keyMaterial: unknown;
  readonly subtle?: RuntimeSubtleCrypto;
}

export interface L3FingerprintDigest {
  readonly keyId: string;
  readonly digestHex: string;
}

export interface L3FingerprintService {
  configuredKeyId(): string | undefined;
  assertCaseKeyId(keyId: string): void;
  fingerprintAction(input: {
    readonly datasetKind: DatasetKind;
    readonly investigationId: string;
    readonly keyId: string;
    readonly actionName: string;
    readonly parsedInput: unknown;
  }): Promise<L3FingerprintDigest>;
  fingerprintGrounding(input: {
    readonly datasetKind: DatasetKind;
    readonly investigationId: string;
    readonly keyId?: string;
    readonly context: GroundingContext;
  }): Promise<L3FingerprintDigest>;
}

export interface RecordGroundingProgressInput {
  readonly datasetKind: DatasetKind;
  readonly investigationId: string;
  readonly expectedCheckpointVersion: number;
  readonly context: GroundingContext;
  readonly refreshedAt: string;
}

/** Hash a trusted refreshed L2 context, then persist only its key ID and digest. */
export async function recordGroundingProgress(
  ledger: Pick<InvestigationLedgerRepository, 'getFingerprintKeyId' | 'refreshGroundingProgress'>,
  fingerprints: L3FingerprintService,
  input: RecordGroundingProgressInput,
): Promise<InvestigationProgressOperationResult> {
  const fingerprintKeyId = await ledger.getFingerprintKeyId(input.datasetKind, input.investigationId);
  if (fingerprintKeyId === null) throw new InvestigationLedgerError('fingerprint_unavailable');
  fingerprints.assertCaseKeyId(fingerprintKeyId);
  const digest = await fingerprints.fingerprintGrounding({
    datasetKind: input.datasetKind,
    investigationId: input.investigationId,
    keyId: fingerprintKeyId,
    context: input.context,
  });
  return ledger.refreshGroundingProgress({
    datasetKind: input.datasetKind,
    investigationId: input.investigationId,
    expectedCheckpointVersion: input.expectedCheckpointVersion,
    contextId: input.context.contextId,
    fingerprintKeyId: digest.keyId,
    digestHex: digest.digestHex,
    refreshedAt: input.refreshedAt,
  });
}

export type L3FingerprintErrorCode =
  | 'fingerprint_unavailable'
  | 'fingerprint_key_mismatch'
  | 'fingerprint_invalid_input';

export class L3FingerprintError extends Error {
  constructor(readonly code: L3FingerprintErrorCode) {
    super(code);
    this.name = 'L3FingerprintError';
  }
}

/**
 * HMACs closed L3 inputs with an injected key. The service never exposes key
 * bytes, canonical input, grounding excerpts, or crypto-provider error text.
 */
export function createL3FingerprintService(
  config: L3FingerprintKeyConfig | undefined,
): L3FingerprintService {
  const keyId = config && typeof config.keyId === 'string' && KEY_ID_PATTERN.test(config.keyId)
    ? config.keyId
    : undefined;
  const keyMaterial: ArrayBuffer | undefined = config?.keyMaterial instanceof Uint8Array
    && config.keyMaterial.byteLength >= 32
    && config.keyMaterial.byteLength <= 64
    ? Uint8Array.from(config.keyMaterial).buffer as ArrayBuffer
    : undefined;
  const subtle = config?.subtle ?? globalThis.crypto?.subtle;
  let importedKey: Promise<RuntimeCryptoKey> | undefined;

  const requireKey = (expectedKeyId?: string): { readonly keyId: string; readonly material: ArrayBuffer } => {
    if (!keyId || !keyMaterial || !subtle || typeof subtle.importKey !== 'function' || typeof subtle.sign !== 'function') {
      throw new L3FingerprintError('fingerprint_unavailable');
    }
    if (expectedKeyId !== undefined) {
      if (!KEY_ID_PATTERN.test(expectedKeyId)) throw new L3FingerprintError('fingerprint_unavailable');
      if (expectedKeyId !== keyId) throw new L3FingerprintError('fingerprint_key_mismatch');
    }
    return { keyId, material: keyMaterial };
  };

  const sign = async (expectedKeyId: string | undefined, message: string): Promise<L3FingerprintDigest> => {
    const selected = requireKey(expectedKeyId);
    try {
      importedKey ??= subtle!.importKey(
        'raw',
        selected.material,
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign'],
      );
      const messageBytes = new TextEncoder().encode(message);
      const signature = await subtle!.sign('HMAC', await importedKey, messageBytes.buffer as ArrayBuffer);
      const bytes = new Uint8Array(signature);
      if (bytes.byteLength !== 32) throw new Error();
      return { keyId: selected.keyId, digestHex: bytesToHex(bytes) };
    } catch {
      throw new L3FingerprintError('fingerprint_unavailable');
    }
  };

  return {
    configuredKeyId: () => (keyId && keyMaterial && subtle ? keyId : undefined),

    assertCaseKeyId(caseKeyId) {
      requireKey(caseKeyId);
    },

    async fingerprintAction(input) {
      const { datasetKind, investigationId, keyId: caseKeyId, actionName } = input;
      if (!isDatasetKind(datasetKind) || !isId(investigationId) || !isId(actionName)) {
        throw new L3FingerprintError('fingerprint_invalid_input');
      }
      const canonicalInput = canonicalizeClosedJson(input.parsedInput);
      if (canonicalInput === undefined) throw new L3FingerprintError('fingerprint_invalid_input');
      const envelope = 'waspada:l3:registered-action:v1\u0000'
        + datasetKind + '\u0000' + investigationId + '\u0000' + actionName + '\u0000' + canonicalInput;
      return sign(caseKeyId, envelope);
    },

    async fingerprintGrounding(input) {
      const { datasetKind, investigationId, keyId: caseKeyId, context } = input;
      if (!isDatasetKind(datasetKind) || !isId(investigationId)) {
        throw new L3FingerprintError('fingerprint_invalid_input');
      }
      const projection = groundingProjection(datasetKind, context);
      const envelope = 'waspada:l3:grounding-progress:v1\u0000'
        + datasetKind + '\u0000' + investigationId + '\u0000' + canonicalizeTrustedJson(projection);
      return sign(caseKeyId, envelope);
    },
  };
}

/** Canonical JSON for validated JSON values; accessors, prototypes and cycles fail closed. */
export function canonicalizeClosedJson(value: unknown): string | undefined {
  return canonicalizeJson(value, false);
}

function canonicalizeTrustedJson(value: unknown): string {
  const canonical = canonicalizeJson(value, true);
  if (canonical === undefined) throw new L3FingerprintError('fingerprint_invalid_input');
  return canonical;
}

function canonicalizeJson(value: unknown, alreadyProjected: boolean): string | undefined {
  let nodeCount = 0;
  let codeUnits = 0;
  const active = new Set<object>();

  const visit = (current: unknown, depth: number): string | undefined => {
    nodeCount += 1;
    if (nodeCount > MAX_CANONICAL_INPUT_NODES || depth > MAX_CANONICAL_INPUT_DEPTH) return undefined;

    if (current === null) return 'null';
    if (typeof current === 'boolean') return current ? 'true' : 'false';
    if (typeof current === 'number') return Number.isFinite(current) ? JSON.stringify(current) : undefined;
    if (typeof current === 'string') {
      codeUnits += current.length;
      if (current.length > 16_384 || codeUnits > MAX_CANONICAL_INPUT_CODE_UNITS) return undefined;
      return JSON.stringify(current);
    }
    if (typeof current !== 'object') return undefined;
    if (active.has(current)) return undefined;
    active.add(current);
    try {
      if (Array.isArray(current)) {
        if (Object.getPrototypeOf(current) !== Array.prototype || current.length > MAX_CANONICAL_INPUT_NODES) return undefined;
        const keys = Reflect.ownKeys(current);
        if (keys.length !== current.length + 1 || keys.some((key) => typeof key !== 'string')) return undefined;
        const items: string[] = [];
        for (let index = 0; index < current.length; index += 1) {
          const descriptor = Object.getOwnPropertyDescriptor(current, String(index));
          if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) return undefined;
          const item = visit(descriptor.value, depth + 1);
          if (item === undefined) return undefined;
          items.push(item);
        }
        if ((keys as string[]).some((key) => key !== 'length' && (!/^\d+$/.test(key) || Number(key) >= current.length))) {
          return undefined;
        }
        return '[' + items.join(',') + ']';
      }

      const prototype = Object.getPrototypeOf(current);
      if (prototype !== Object.prototype && prototype !== null) return undefined;
      const keys = Reflect.ownKeys(current);
      if (keys.some((key) => typeof key !== 'string') || keys.length > MAX_CANONICAL_INPUT_NODES) return undefined;
      const sortedKeys = (keys as string[]).sort();
      const properties: string[] = [];
      for (const key of sortedKeys) {
        codeUnits += key.length;
        if (key.length > 128 || codeUnits > MAX_CANONICAL_INPUT_CODE_UNITS) return undefined;
        const descriptor = Object.getOwnPropertyDescriptor(current, key);
        if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) return undefined;
        const property = visit(descriptor.value, depth + 1);
        if (property === undefined) return undefined;
        properties.push(JSON.stringify(key) + ':' + property);
      }
      return '{' + properties.join(',') + '}';
    } catch {
      return undefined;
    } finally {
      active.delete(current);
    }
  };

  const result = visit(value, 0);
  if (alreadyProjected && result === undefined) return undefined;
  return result;
}

function groundingProjection(datasetKind: DatasetKind, value: GroundingContext): unknown {
  const context = readObject(value);
  if (!context
    || context.schemaVersion !== '2.0'
    || context.recordType !== 'GroundingContext'
    || context.datasetKind !== datasetKind
    || !isId(context.candidateId)
    || !Array.isArray(context.evidence)
    || !Array.isArray(context.revisionStates)
    || !Array.isArray(context.candidateEvents)
    || !Array.isArray(context.priorDecisionIds)
    || !Array.isArray(context.missingFields)
    || !Array.isArray(context.conflicts)) {
    throw new L3FingerprintError('fingerprint_invalid_input');
  }

  const evidence = dataArray(context.evidence, 8).map((entry) => {
    const record = readObject(entry);
    const reference = record ? readObject(record.reference) : undefined;
    if (!record || !reference
      || typeof reference.reportRevisionId !== 'string' || !isId(reference.reportRevisionId)
      || typeof reference.permittedTextHash !== 'string' || !/^[a-f0-9]{64}$/.test(reference.permittedTextHash)
      || !isInteger(reference.spanStart, 0, 10_000_000)
      || !isInteger(reference.spanEnd, 1, 10_000_000)
      || reference.spanEnd <= reference.spanStart
      || reference.offsetUnit !== 'unicode_code_points'
      || !isRelation(reference.relation)
      || typeof record.sourceId !== 'string' || !isId(record.sourceId)
      || !isRevisionStatus(record.revisionStatus)
      || !Array.isArray(record.origins)) {
      throw new L3FingerprintError('fingerprint_invalid_input');
    }
    const origins = dataArray(record.origins, 128).map((originValue) => {
      const origin = readObject(originValue);
      if (!origin
        || typeof origin.originId !== 'string' || !isId(origin.originId)
        || !isIndependenceStatus(origin.independenceStatus)
        || !Array.isArray(origin.dependsOnOriginIds)) {
        throw new L3FingerprintError('fingerprint_invalid_input');
      }
      const dependsOnOriginIds = dataArray(origin.dependsOnOriginIds, 128).map((id) => {
        if (typeof id !== 'string' || !isId(id)) throw new L3FingerprintError('fingerprint_invalid_input');
        return id;
      }).sort();
      return {
        originId: origin.originId,
        independenceStatus: origin.independenceStatus,
        dependsOnOriginIds,
      };
    }).sort((left, right) => compareCodeUnits(left.originId, right.originId));

    return {
      reportRevisionId: reference.reportRevisionId,
      permittedTextHash: reference.permittedTextHash,
      spanStart: reference.spanStart,
      spanEnd: reference.spanEnd,
      offsetUnit: reference.offsetUnit,
      relation: reference.relation,
      sourceId: record.sourceId,
      revisionStatus: record.revisionStatus,
      origins,
    };
  }).sort((left, right) => compareCodeUnits(canonicalizeTrustedJson(left), canonicalizeTrustedJson(right)));

  const revisionStates = dataArray(context.revisionStates, 128).map((stateValue) => {
    const state = readObject(stateValue);
    if (!state || typeof state.reportRevisionId !== 'string' || !isId(state.reportRevisionId)
      || !isRevisionStatus(state.revisionStatus)) throw new L3FingerprintError('fingerprint_invalid_input');
    return { reportRevisionId: state.reportRevisionId, revisionStatus: state.revisionStatus };
  }).sort((left, right) => compareCodeUnits(left.reportRevisionId, right.reportRevisionId));

  const candidateEvents = dataArray(context.candidateEvents, 20).map((eventValue) => {
    const event = readObject(eventValue);
    if (!event || typeof event.eventId !== 'string' || !isId(event.eventId)
      || !isInteger(event.eventVersion, 1, 2_147_483_647)) throw new L3FingerprintError('fingerprint_invalid_input');
    return { eventId: event.eventId, eventVersion: event.eventVersion };
  }).sort((left, right) => compareCodeUnits(left.eventId, right.eventId) || left.eventVersion - right.eventVersion);

  const priorDecisionIds = dataArray(context.priorDecisionIds, 100).map((id) => {
    if (typeof id !== 'string' || !isId(id)) throw new L3FingerprintError('fingerprint_invalid_input');
    return id;
  }).sort();
  const missingFieldCount = dataArray(context.missingFields, 100).length;
  const conflictCount = dataArray(context.conflicts, 100).length;

  return {
    projectionVersion: 2,
    datasetKind,
    candidateId: context.candidateId,
    evidence,
    revisionStates,
    candidateEvents,
    priorDecisionIds,
    missingFieldCount,
    conflictCount,
  };
}

function compareCodeUnits(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function dataArray(value: unknown[], maximum: number): unknown[] {
  if (Object.getPrototypeOf(value) !== Array.prototype || value.length > maximum) {
    throw new L3FingerprintError('fingerprint_invalid_input');
  }
  const keys = Reflect.ownKeys(value);
  if (keys.length !== value.length + 1 || keys.some((key) => typeof key !== 'string')) {
    throw new L3FingerprintError('fingerprint_invalid_input');
  }
  const items: unknown[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) {
      throw new L3FingerprintError('fingerprint_invalid_input');
    }
    items.push(descriptor.value);
  }
  return items;
}

function readObject(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return undefined;
    const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string') return undefined;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) return undefined;
      output[key] = descriptor.value;
    }
    return output;
  } catch {
    return undefined;
  }
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function isDatasetKind(value: unknown): value is DatasetKind {
  return value === 'live' || value === 'historical' || value === 'synthetic';
}

function isId(value: unknown): value is string {
  return typeof value === 'string' && ID_PATTERN.test(value);
}

function isInteger(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}

function isRevisionStatus(value: unknown): boolean {
  return value === 'unreviewed'
    || value === 'eligible'
    || value === 'quarantined'
    || value === 'superseded'
    || value === 'retracted';
}

function isRelation(value: unknown): boolean {
  return value === 'supports' || value === 'contradicts' || value === 'updates' || value === 'context';
}

function isIndependenceStatus(value: unknown): boolean {
  return value === 'established' || value === 'dependent' || value === 'unknown';
}
