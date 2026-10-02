import type {
  FreshnessDueDatasetKind,
  FreshnessDueTarget,
  FreshnessDueTargetCursor,
  FreshnessDueTargetIdentity,
  FreshnessDueTargetPage,
  FreshnessDueTargetReader,
} from '../../../../db/src/freshness-due-target-reader.js';
import type {
  FreshnessTransitionRecorderInput,
  FreshnessTransitionRecorderResult,
} from './freshness-transition-recorder.js';

export interface FreshnessDueEvaluatorRequest {
  readonly datasetKind: FreshnessDueDatasetKind;
  readonly now: string;
  readonly limit: number;
  readonly cursor?: FreshnessDueTargetCursor | null;
  readonly traceId: string;
  readonly evaluationRunId: string;
}

export interface FreshnessDueEvaluatorRecorderPort {
  evaluateAndRecord(input: FreshnessTransitionRecorderInput): Promise<FreshnessTransitionRecorderResult>;
}

export interface FreshnessDueEvaluatorCounts {
  readonly written: number;
  readonly replayed: number;
  readonly noChange: number;
  readonly conflicts: number;
  readonly failures: number;
}

export type FreshnessDueEvaluatorResult =
  | {
    readonly outcome: 'completed';
    readonly counts: FreshnessDueEvaluatorCounts;
    readonly nextCursor: FreshnessDueTargetCursor | null;
  }
  | {
    readonly outcome: 'retry';
    readonly counts: FreshnessDueEvaluatorCounts;
    readonly resumeCursor: FreshnessDueTargetCursor | null;
  };

export interface FreshnessDueEvaluator {
  evaluate(request: unknown): Promise<FreshnessDueEvaluatorResult>;
}

export class FreshnessDueEvaluatorError extends Error {
  readonly code = 'INVALID_REQUEST' as const;

  constructor() {
    super('The freshness due-evaluator request is invalid.');
    this.name = 'FreshnessDueEvaluatorError';
  }
}

interface ValidatedRequest {
  readonly datasetKind: FreshnessDueDatasetKind;
  readonly now: string;
  readonly limit: number;
  readonly cursor: FreshnessDueTargetCursor | null;
  readonly traceId: string;
  readonly evaluationRunId: string;
}

interface MutableCounts {
  written: number;
  replayed: number;
  noChange: number;
  conflicts: number;
  failures: number;
}

const DATASETS = new Set<FreshnessDueDatasetKind>(['live', 'historical', 'synthetic']);
const TARGET_KINDS = new Set(['event_claim_set', 'impact']);
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const RFC3339_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|([+-])(\d{2}):(\d{2}))$/u;
const MAX_DATABASE_INTEGER = 2_147_483_647;
const MAX_TIMESTAMP_LENGTH = 128;
const MAX_PAGE_SIZE = 100;
const REQUIRED_REQUEST_KEYS = ['datasetKind', 'now', 'limit', 'traceId', 'evaluationRunId'] as const;
const ALLOWED_REQUEST_KEYS = new Set<string>([...REQUIRED_REQUEST_KEYS, 'cursor']);

/**
 * Evaluates one explicit-time page through the existing due-target reader and
 * exact-version recorder. The caller owns runtime wiring, tracing, and retries.
 */
export function createFreshnessDueEvaluator(ports: {
  readonly reader: FreshnessDueTargetReader;
  readonly recorder: FreshnessDueEvaluatorRecorderPort;
}): FreshnessDueEvaluator {
  if (!ports || typeof ports.reader?.read !== 'function'
    || typeof ports.recorder?.evaluateAndRecord !== 'function') {
    throw new TypeError('Freshness due evaluator requires reader and recorder ports');
  }

  return {
    async evaluate(value): Promise<FreshnessDueEvaluatorResult> {
      const request = validateRequest(value);
      const counts = emptyCounts();

      let page: FreshnessDueTargetPage;
      try {
        const rawPage = await ports.reader.read({
          datasetKind: request.datasetKind,
          now: request.now,
          limit: request.limit,
          cursor: request.cursor,
        });
        const validatedPage = validatePage(rawPage, request);
        if (validatedPage === null) return retryResult(counts, request.cursor, true);
        page = validatedPage;
      } catch {
        return retryResult(counts, request.cursor, true);
      }

      for (const target of page.targets) {
        let idempotencyKey: string;
        try {
          idempotencyKey = await deriveIdempotencyKey(request.evaluationRunId, target);
        } catch {
          return retryResult(counts, request.cursor, true);
        }

        let result: FreshnessTransitionRecorderResult;
        try {
          result = await ports.recorder.evaluateAndRecord({
            datasetKind: target.datasetKind,
            eventId: target.eventId,
            eventVersion: target.eventVersion,
            target: target.target,
            expectedSequence: target.transitionSequence + 1,
            previousStatus: target.status,
            validUntil: target.validUntil,
            reviewDueAt: target.reviewDueAt,
            now: request.now,
            newApplicableEvidenceEvaluated: false,
            evidenceReferenceIds: [],
            traceId: request.traceId,
            idempotencyKey,
          });
        } catch {
          return retryResult(counts, request.cursor, true);
        }

        let outcome: unknown;
        try {
          if (!isObject(result)) return retryResult(counts, request.cursor, true);
          outcome = result.outcome;
        } catch {
          return retryResult(counts, request.cursor, true);
        }
        switch (outcome) {
          case 'written':
            counts.written += 1;
            break;
          case 'replayed':
            counts.replayed += 1;
            break;
          case 'no_change':
            counts.noChange += 1;
            break;
          case 'conflict':
            counts.conflicts += 1;
            return retryResult(counts, request.cursor, false);
          default:
            return retryResult(counts, request.cursor, true);
        }
      }

      return {
        outcome: 'completed',
        counts: snapshotCounts(counts),
        nextCursor: page.nextCursor,
      };
    },
  };
}

function validateRequest(value: unknown): ValidatedRequest {
  if (!isObject(value)) return invalidRequest();
  const keys = Object.keys(value);
  if (keys.some((key) => !ALLOWED_REQUEST_KEYS.has(key))
    || REQUIRED_REQUEST_KEYS.some((key) => !(key in value))) {
    return invalidRequest();
  }
  if (typeof value.datasetKind !== 'string' || !DATASETS.has(value.datasetKind as FreshnessDueDatasetKind)) {
    return invalidRequest();
  }
  if (typeof value.now !== 'string' || value.now.length > MAX_TIMESTAMP_LENGTH || !isRfc3339Instant(value.now)) {
    return invalidRequest();
  }
  if (!Number.isSafeInteger(value.limit) || (value.limit as number) < 1 || (value.limit as number) > MAX_PAGE_SIZE) {
    return invalidRequest();
  }
  if (!isId(value.traceId) || !isId(value.evaluationRunId)) return invalidRequest();

  let cursor: FreshnessDueTargetCursor | null = null;
  if ('cursor' in value) {
    if (value.cursor !== null) {
      cursor = validateCursor(value.cursor);
      if (cursor === null) return invalidRequest();
    }
  }

  return {
    datasetKind: value.datasetKind as FreshnessDueDatasetKind,
    now: value.now,
    limit: value.limit as number,
    cursor,
    traceId: value.traceId,
    evaluationRunId: value.evaluationRunId,
  };
}

function validatePage(value: unknown, request: ValidatedRequest): FreshnessDueTargetPage | null {
  if (!isObject(value) || !hasExactKeys(value, ['targets', 'nextCursor'])
    || !Array.isArray(value.targets) || value.targets.length > request.limit) {
    return null;
  }

  const targets: FreshnessDueTarget[] = [];
  for (const candidate of value.targets) {
    const target = validateTarget(candidate, request.datasetKind);
    if (target === null) return null;
    targets.push(target);
  }

  let nextCursor: FreshnessDueTargetCursor | null = null;
  if (value.nextCursor !== null) {
    nextCursor = validateCursor(value.nextCursor);
    const lastTarget = targets.at(-1);
    if (nextCursor === null || targets.length !== request.limit || lastTarget === undefined
      || !sameCursor(nextCursor, lastTarget)) {
      return null;
    }
  }

  return { targets, nextCursor };
}

function validateTarget(value: unknown, datasetKind: FreshnessDueDatasetKind): FreshnessDueTarget | null {
  if (!isObject(value) || !hasExactKeys(value, [
    'datasetKind', 'eventId', 'eventVersion', 'target', 'status', 'transitionSequence', 'validUntil', 'reviewDueAt',
  ]) || value.datasetKind !== datasetKind || !isId(value.eventId)
    || !isPositiveDatabaseInteger(value.eventVersion)
    || (value.status !== 'current' && value.status !== 'needs_update')
    || !isNonnegativeDatabaseInteger(value.transitionSequence)
    || !isNullableRfc3339(value.validUntil) || !isNullableRfc3339(value.reviewDueAt)) {
    return null;
  }

  const target = validateTargetIdentity(value.target);
  if (target === null) return null;

  return {
    datasetKind,
    eventId: value.eventId,
    eventVersion: value.eventVersion,
    target,
    status: value.status as FreshnessDueTarget['status'],
    transitionSequence: value.transitionSequence,
    validUntil: value.validUntil as string | null,
    reviewDueAt: value.reviewDueAt as string | null,
  };
}

function validateCursor(value: unknown): FreshnessDueTargetCursor | null {
  if (!isObject(value) || !hasExactKeys(value, ['eventId', 'eventVersion', 'target'])
    || !isId(value.eventId) || !isPositiveDatabaseInteger(value.eventVersion)) {
    return null;
  }
  const target = validateTargetIdentity(value.target);
  return target === null ? null : { eventId: value.eventId, eventVersion: value.eventVersion, target };
}

function validateTargetIdentity(value: unknown): FreshnessDueTargetIdentity | null {
  if (!isObject(value) || typeof value.kind !== 'string' || !TARGET_KINDS.has(value.kind)) return null;
  if (value.kind === 'event_claim_set' && hasExactKeys(value, ['kind'])) return { kind: 'event_claim_set' };
  if (value.kind === 'impact' && hasExactKeys(value, ['kind', 'impactId', 'impactVersion'])
    && isId(value.impactId) && isPositiveDatabaseInteger(value.impactVersion)) {
    return { kind: 'impact', impactId: value.impactId, impactVersion: value.impactVersion };
  }
  return null;
}

async function deriveIdempotencyKey(evaluationRunId: string, target: FreshnessDueTarget): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle || typeof subtle.digest !== 'function') throw new Error();

  const identity = JSON.stringify([
    'waspada:freshness-due-evaluator:idempotency:v1',
    evaluationRunId,
    target.datasetKind,
    target.eventId,
    target.eventVersion,
    target.target.kind,
    target.target.kind === 'impact' ? target.target.impactId : null,
    target.target.kind === 'impact' ? target.target.impactVersion : null,
    target.transitionSequence,
  ]);
  const bytes = new TextEncoder().encode(identity);
  const digest = await subtle.digest('SHA-256', bytes.buffer as ArrayBuffer);
  const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `freshness-due:${hex}`;
}

function sameCursor(left: FreshnessDueTargetCursor, right: FreshnessDueTargetCursor): boolean {
  if (left.eventId !== right.eventId || left.eventVersion !== right.eventVersion
    || left.target.kind !== right.target.kind) return false;
  if (left.target.kind === 'event_claim_set' || right.target.kind === 'event_claim_set') {
    return left.target.kind === 'event_claim_set' && right.target.kind === 'event_claim_set';
  }
  return left.target.impactId === right.target.impactId && left.target.impactVersion === right.target.impactVersion;
}

function isRfc3339Instant(value: string): boolean {
  const match = RFC3339_PATTERN.exec(value);
  if (match === null) return false;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetHour = match[10] === undefined ? 0 : Number(match[10]);
  const offsetMinute = match[11] === undefined ? 0 : Number(match[11]);
  return year >= 1 && month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth(year, month)
    && hour <= 23 && minute <= 59 && second <= 59 && offsetHour <= 23 && offsetMinute <= 59;
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31;
}

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function isNullableRfc3339(value: unknown): value is string | null {
  return value === null || (typeof value === 'string' && value.length <= MAX_TIMESTAMP_LENGTH && isRfc3339Instant(value));
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expectedKeys: readonly string[]): boolean {
  const expected = new Set(expectedKeys);
  return Object.keys(value).length === expected.size && Object.keys(value).every((key) => expected.has(key));
}

function isId(value: unknown): value is string {
  return typeof value === 'string' && ID_PATTERN.test(value);
}

function isPositiveDatabaseInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0 && (value as number) <= MAX_DATABASE_INTEGER;
}

function isNonnegativeDatabaseInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= MAX_DATABASE_INTEGER;
}

function emptyCounts(): MutableCounts {
  return { written: 0, replayed: 0, noChange: 0, conflicts: 0, failures: 0 };
}

function snapshotCounts(value: MutableCounts): FreshnessDueEvaluatorCounts {
  return {
    written: value.written,
    replayed: value.replayed,
    noChange: value.noChange,
    conflicts: value.conflicts,
    failures: value.failures,
  };
}

function retryResult(
  counts: MutableCounts,
  resumeCursor: FreshnessDueTargetCursor | null,
  failed: boolean,
): FreshnessDueEvaluatorResult {
  if (failed) counts.failures += 1;
  return { outcome: 'retry', counts: snapshotCounts(counts), resumeCursor };
}

function invalidRequest(): never {
  throw new FreshnessDueEvaluatorError();
}
