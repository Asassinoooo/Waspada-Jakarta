import type { FreshnessStatus } from '../../contracts/public-api.js';
import {
  evaluateFreshnessTransition,
  FreshnessTransitionPolicyError,
  type FreshnessTransitionReason,
} from './freshness-transition-policy.js';

export type FreshnessRecorderDatasetKind = 'live' | 'historical' | 'synthetic';
export type FreshnessRecorderTarget =
  | { readonly kind: 'event_claim_set' }
  | { readonly kind: 'impact'; readonly impactId: string; readonly impactVersion: number };
export type PersistedFreshnessReason = Exclude<
  FreshnessTransitionReason,
  'stale_state_retained' | 'current_state_retained'
>;

export interface FreshnessTransitionRecorderInput {
  readonly datasetKind: FreshnessRecorderDatasetKind;
  readonly eventId: string;
  readonly eventVersion: number;
  readonly target: FreshnessRecorderTarget;
  readonly expectedSequence: number;
  readonly previousStatus: FreshnessStatus;
  readonly validUntil: string | null;
  readonly reviewDueAt: string | null;
  readonly now: string;
  readonly newApplicableEvidenceEvaluated: boolean;
  readonly evidenceReferenceIds: readonly string[];
  readonly traceId: string;
  readonly idempotencyKey: string;
}

export interface FreshnessTransitionAppendCommand {
  readonly datasetKind: FreshnessRecorderDatasetKind;
  readonly eventId: string;
  readonly eventVersion: number;
  readonly target: FreshnessRecorderTarget;
  readonly expectedSequence: number;
  readonly previousStatus: FreshnessStatus;
  readonly resultingStatus: FreshnessStatus;
  readonly reason: PersistedFreshnessReason;
  readonly evaluatedAt: string;
  readonly traceId: string;
  readonly idempotencyKey: string;
  readonly evidenceReferenceIds: readonly string[];
}

export interface FreshnessTransitionRecorderRepository {
  append(command: FreshnessTransitionAppendCommand): Promise<FreshnessRecorderPersistResult>;
}

export interface FreshnessRecorderTransitionRecord {
  readonly transitionId: string;
  readonly datasetKind: FreshnessRecorderDatasetKind;
  readonly eventId: string;
  readonly eventVersion: number;
  readonly target: FreshnessRecorderTarget;
  readonly transitionSequence: number;
  readonly previousStatus: FreshnessStatus;
  readonly resultingStatus: FreshnessStatus;
  readonly reason: PersistedFreshnessReason;
  readonly evaluatedAt: string;
  readonly traceId: string;
  readonly idempotencyKey: string;
  readonly requestFingerprint: string;
  readonly evidenceReferenceIds: readonly string[];
}

export type FreshnessRecorderPersistResult =
  | { readonly outcome: 'written' | 'replayed'; readonly record: FreshnessRecorderTransitionRecord }
  | {
      readonly outcome: 'conflict';
      readonly code:
        | 'idempotency_key_reused'
        | 'event_version_not_current'
        | 'impact_version_not_referenced'
        | 'stale_sequence'
        | 'prior_status_mismatch'
        | 'target_status_invalid'
        | 'trace_not_found'
        | 'evidence_reference_not_found'
        | 'target_changed';
    };

export type FreshnessTransitionRecorderResult =
  | { readonly outcome: 'no_change'; readonly status: FreshnessStatus; readonly reason: FreshnessTransitionReason }
  | FreshnessRecorderPersistResult;

export class FreshnessTransitionRecorderError extends Error {
  constructor(readonly code: 'invalid_input' | 'evidence_references_required' | 'evidence_references_not_applicable') {
    super(code);
    this.name = 'FreshnessTransitionRecorderError';
  }
}

const DATASETS = new Set<FreshnessRecorderDatasetKind>(['live', 'historical', 'synthetic']);
const STATUSES = new Set<FreshnessStatus>(['current', 'needs_update', 'expired']);
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const IDEMPOTENCY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const EVIDENCE_ID_PATTERN = /^[1-9][0-9]{0,18}$/;
const PG_BIGINT_MAX = 9_223_372_036_854_775_807n;
const MAX_INT = 2_147_483_647;
const INPUT_KEYS = [
  'datasetKind', 'eventId', 'eventVersion', 'target', 'expectedSequence', 'previousStatus',
  'validUntil', 'reviewDueAt', 'now', 'newApplicableEvidenceEvaluated', 'evidenceReferenceIds',
  'traceId', 'idempotencyKey',
] as const;

/** Evaluates one supplied event claim-set or impact and records only status changes. */
export function createFreshnessTransitionRecorder(
  repository: FreshnessTransitionRecorderRepository,
): { evaluateAndRecord(input: FreshnessTransitionRecorderInput): Promise<FreshnessTransitionRecorderResult> } {
  if (!repository || typeof repository.append !== 'function') {
    throw new TypeError('Freshness transition recorder requires a persistence port');
  }
  return {
    async evaluateAndRecord(input: FreshnessTransitionRecorderInput): Promise<FreshnessTransitionRecorderResult> {
      const request = snapshotRecorderInput(input);
      let evaluation;
      try {
        evaluation = evaluateFreshnessTransition({
          previousStatus: request.previousStatus,
          validUntil: request.validUntil,
          reviewDueAt: request.reviewDueAt,
          now: request.now,
          newApplicableEvidenceEvaluated: request.newApplicableEvidenceEvaluated,
        });
      } catch (error) {
        if (error instanceof FreshnessTransitionPolicyError) {
          throw new FreshnessTransitionRecorderError('invalid_input');
        }
        throw error;
      }

      if (evaluation.status === request.previousStatus
        || evaluation.reason === 'stale_state_retained'
        || evaluation.reason === 'current_state_retained') {
        return { outcome: 'no_change', status: evaluation.status, reason: evaluation.reason };
      }

      if (evaluation.reason === 'new_applicable_evidence_evaluated' && request.evidenceReferenceIds.length === 0) {
        throw new FreshnessTransitionRecorderError('evidence_references_required');
      }
      if (evaluation.reason !== 'new_applicable_evidence_evaluated' && request.evidenceReferenceIds.length > 0) {
        throw new FreshnessTransitionRecorderError('evidence_references_not_applicable');
      }

      return repository.append({
        datasetKind: request.datasetKind,
        eventId: request.eventId,
        eventVersion: request.eventVersion,
        target: request.target,
        expectedSequence: request.expectedSequence,
        previousStatus: request.previousStatus,
        resultingStatus: evaluation.status,
        reason: evaluation.reason,
        evaluatedAt: request.now,
        traceId: request.traceId,
        idempotencyKey: request.idempotencyKey,
        evidenceReferenceIds: request.evidenceReferenceIds,
      });
    },
  };
}

interface RecorderSnapshot extends FreshnessTransitionRecorderInput {
  readonly evidenceReferenceIds: readonly string[];
}

function snapshotRecorderInput(value: unknown): RecorderSnapshot {
  if (!isObject(value) || !hasExactKeys(value, INPUT_KEYS)) return invalid();
  if (typeof value.datasetKind !== 'string' || !DATASETS.has(value.datasetKind as FreshnessRecorderDatasetKind)) return invalid();
  if (!isId(value.eventId) || !isId(value.traceId) || !isIdempotencyKey(value.idempotencyKey)) return invalid();
  if (!positiveInt(value.eventVersion) || !positiveInt(value.expectedSequence)) return invalid();
  if (typeof value.previousStatus !== 'string' || !STATUSES.has(value.previousStatus as FreshnessStatus)) return invalid();
  if (value.validUntil !== null && typeof value.validUntil !== 'string') return invalid();
  if (value.reviewDueAt !== null && typeof value.reviewDueAt !== 'string') return invalid();
  if (typeof value.now !== 'string' || typeof value.newApplicableEvidenceEvaluated !== 'boolean') return invalid();
  if (!isObject(value.target)) return invalid();

  let target: FreshnessRecorderTarget;
  if (value.target.kind === 'event_claim_set' && hasExactKeys(value.target, ['kind'])) {
    target = { kind: 'event_claim_set' };
  } else if (value.target.kind === 'impact' && hasExactKeys(value.target, ['kind', 'impactId', 'impactVersion'])
    && isId(value.target.impactId) && positiveInt(value.target.impactVersion)) {
    target = { kind: 'impact', impactId: value.target.impactId, impactVersion: value.target.impactVersion };
  } else {
    return invalid();
  }

  if (!Array.isArray(value.evidenceReferenceIds) || value.evidenceReferenceIds.length > 32) return invalid();
  const evidenceReferenceIds: string[] = [];
  for (const item of value.evidenceReferenceIds) {
    if (typeof item !== 'string' || !EVIDENCE_ID_PATTERN.test(item) || BigInt(item) > PG_BIGINT_MAX) return invalid();
    evidenceReferenceIds.push(item);
  }
  if (new Set(evidenceReferenceIds).size !== evidenceReferenceIds.length) return invalid();
  evidenceReferenceIds.sort((left, right) => BigInt(left) < BigInt(right) ? -1 : BigInt(left) > BigInt(right) ? 1 : 0);

  return {
    datasetKind: value.datasetKind as FreshnessRecorderDatasetKind,
    eventId: value.eventId,
    eventVersion: value.eventVersion,
    target,
    expectedSequence: value.expectedSequence,
    previousStatus: value.previousStatus as FreshnessStatus,
    validUntil: value.validUntil as string | null,
    reviewDueAt: value.reviewDueAt as string | null,
    now: value.now,
    newApplicableEvidenceEvaluated: value.newApplicableEvidenceEvaluated,
    evidenceReferenceIds,
    traceId: value.traceId,
    idempotencyKey: value.idempotencyKey,
  };
}

function hasExactKeys(value: Record<string, unknown>, expectedKeys: readonly string[]): boolean {
  const expected = new Set<string>(expectedKeys);
  return Object.keys(value).length === expected.size && Object.keys(value).every((key) => expected.has(key));
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isId(value: unknown): value is string {
  return typeof value === 'string' && ID_PATTERN.test(value);
}

function isIdempotencyKey(value: unknown): value is string {
  return typeof value === 'string' && IDEMPOTENCY_PATTERN.test(value);
}

function positiveInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= MAX_INT;
}

function invalid(): never {
  throw new FreshnessTransitionRecorderError('invalid_input');
}
