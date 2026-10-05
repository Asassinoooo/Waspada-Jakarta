import type {
  AppendSourceRevisionFreshnessTransitionInput,
  FreshnessTransitionAppendResult,
  FreshnessTransitionLedgerRepository,
  AppendFreshnessTransitionInput,
  SourceRevisionFreshnessTransitionAppendResult,
} from '../../../../db/src/freshness-transition-ledger.js';
import type {
  FreshnessTargetIdentity,
  SourceRevisionFreshnessTarget,
  SourceRevisionFreshnessTargetReader,
  SourceRevisionFreshnessTargetRequest,
} from '../../../../db/src/source-revision-freshness-target-reader.js';
import type {
  SourceRevisionReviewCandidateCursor,
  SourceRevisionReviewCandidateReader,
  SourceRevisionReviewTargetIdentity,
} from '../../../../db/src/source-revision-review-candidate-reader.js';

export interface SourceRevisionFreshnessTransitionRequest {
  readonly datasetKind: 'live';
  readonly now: string;
  readonly limit: number;
  readonly cursor?: SourceRevisionReviewCandidateCursor | null;
  readonly traceId: string;
}

export interface SourceRevisionFreshnessTransitionPorts {
  readonly candidates: SourceRevisionReviewCandidateReader;
  readonly targets: SourceRevisionFreshnessTargetReader;
  readonly ledger: FreshnessTransitionLedgerRepository;
}

export interface SourceRevisionFreshnessTransitionCounts {
  readonly candidates: number;
  readonly invalidatingCandidates: number;
  readonly selectedTargets: number;
  readonly duplicateCandidates: number;
  readonly skippedCandidates: number;
  readonly written: number;
  readonly replayed: number;
  readonly noChange: number;
}

export type SourceRevisionFreshnessTransitionResult =
  | {
    readonly outcome: 'completed';
    readonly counts: SourceRevisionFreshnessTransitionCounts;
    readonly nextCursor: SourceRevisionReviewCandidateCursor | null;
  }
  | {
    readonly outcome: 'conflict';
    readonly code: 'stale_target';
    readonly counts: SourceRevisionFreshnessTransitionCounts;
    readonly resumeCursor: SourceRevisionReviewCandidateCursor | null;
  }
  | {
    readonly outcome: 'failed';
    readonly code:
      | 'candidate_read_failed'
      | 'candidate_page_invalid'
      | 'target_read_failed'
      | 'target_page_invalid'
      | 'idempotency_key_failed'
      | 'ledger_write_failed'
      | 'ledger_result_invalid';
    readonly counts: SourceRevisionFreshnessTransitionCounts;
    readonly resumeCursor: SourceRevisionReviewCandidateCursor | null;
  };

export class SourceRevisionFreshnessTransitionError extends Error {
  readonly code = 'invalid_request' as const;

  constructor() {
    super('The source-revision freshness transition request is invalid.');
    this.name = 'SourceRevisionFreshnessTransitionError';
  }
}

interface Candidate {
  readonly observationId: string;
  readonly assertedState: 'current' | 'superseded' | 'retracted' | 'withdrawn';
  readonly eventId: string;
  readonly eventVersion: number;
  readonly target: SourceRevisionReviewTargetIdentity;
}

interface ValidatedPage {
  readonly candidates: readonly Candidate[];
  readonly nextCursor: SourceRevisionReviewCandidateCursor | null;
}

interface ValidatedRequest {
  readonly now: string;
  readonly limit: number;
  readonly cursor: SourceRevisionReviewCandidateCursor | null;
  readonly traceId: string;
}

interface MutableCounts {
  candidates: number;
  invalidatingCandidates: number;
  selectedTargets: number;
  duplicateCandidates: number;
  skippedCandidates: number;
  written: number;
  replayed: number;
  noChange: number;
}

interface Instant {
  readonly seconds: bigint;
  readonly fraction: string;
}

type TransitionReason = AppendFreshnessTransitionInput['reason']
  | AppendSourceRevisionFreshnessTransitionInput['reason'];

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const RFC3339_PATTERN = /^([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})(?:\.([0-9]+))?(Z|([+-])([0-9]{2}):([0-9]{2}))$/u;
const MAX_DATABASE_INTEGER = 2_147_483_647;
const MAX_TIMESTAMP_LENGTH = 128;
const MAX_PAGE_SIZE = 100;
const REQUIRED_REQUEST_KEYS = ['datasetKind', 'now', 'limit', 'traceId'] as const;
const ALLOWED_REQUEST_KEYS = new Set<string>([...REQUIRED_REQUEST_KEYS, 'cursor']);
const PAGE_KEYS = ['candidates', 'nextCursor'] as const;
const CANDIDATE_KEYS = [
  'datasetKind', 'observationId', 'assertedState', 'targetReportRevisionId',
  'assertionReportRevisionId', 'replacementReportRevisionId', 'publisherObservedAt',
  'retrievedAt', 'recordedAt', 'eventId', 'eventVersion', 'target',
] as const;
const TARGET_KEYS = [
  'eventId', 'eventVersion', 'target', 'status', 'transitionSequence', 'validUntil',
] as const;

/** Applies one page of explicit live source-revision assertions to exact freshness targets. */
export function createSourceRevisionFreshnessTransitionCoordinator(
  ports: SourceRevisionFreshnessTransitionPorts,
): {
  processPage(request: unknown): Promise<SourceRevisionFreshnessTransitionResult>;
} {
  if (!ports || typeof ports.candidates?.read !== 'function'
    || typeof ports.targets?.read !== 'function' || typeof ports.ledger?.append !== 'function') {
    throw new TypeError('Source-revision freshness transition requires candidate, target, and ledger ports');
  }

  return {
    async processPage(value): Promise<SourceRevisionFreshnessTransitionResult> {
      const request = validateRequest(value);
      const counts = emptyCounts();

      let rawPage: unknown;
      try {
        rawPage = await ports.candidates.read({
          datasetKind: 'live',
          limit: request.limit,
          ...(request.cursor === null ? {} : { cursor: request.cursor }),
        });
      } catch {
        return failed('candidate_read_failed', counts, request.cursor);
      }

      const page = validatePage(rawPage, request);
      if (page === null) return failed('candidate_page_invalid', counts, request.cursor);
      counts.candidates = page.candidates.length;

      const chosenByTarget = new Map<string, Candidate>();
      for (const candidate of page.candidates) {
        if (candidate.assertedState === 'current') {
          counts.skippedCandidates += 1;
          continue;
        }
        counts.invalidatingCandidates += 1;
        const key = targetKey(candidate.eventId, candidate.eventVersion, candidate.target);
        const previous = chosenByTarget.get(key);
        if (previous === undefined || compareText(candidate.observationId, previous.observationId) < 0) {
          if (previous !== undefined) counts.duplicateCandidates += 1;
          chosenByTarget.set(key, candidate);
        } else {
          counts.duplicateCandidates += 1;
        }
      }
      const selected = [...chosenByTarget.values()].sort(compareCandidates);
      counts.selectedTargets = selected.length;

      if (selected.length === 0) {
        return completed(counts, page.nextCursor);
      }

      let rawTargets: unknown;
      try {
        rawTargets = await ports.targets.read({
          datasetKind: 'live',
          targets: selected.map(toTargetRequest),
        });
      } catch {
        return failed('target_read_failed', counts, request.cursor);
      }

      const targets = validateTargets(rawTargets, selected);
      if (targets === null) return failed('target_page_invalid', counts, request.cursor);
      if (targets.length !== selected.length) return conflict(counts, request.cursor);

      const targetsByKey = new Map(targets.map((target) => [
        targetKey(target.eventId, target.eventVersion, target.target), target,
      ]));
      for (const candidate of selected) {
        const target = targetsByKey.get(targetKey(candidate.eventId, candidate.eventVersion, candidate.target));
        if (target === undefined) return conflict(counts, request.cursor);

        const expired = target.validUntil !== null && compareInstants(target.validUntil, request.now) <= 0;
        let reason: TransitionReason | null = null;
        let resultingStatus: AppendFreshnessTransitionInput['resultingStatus'] | null = null;
        if (expired && (target.status === 'current' || target.status === 'needs_update')) {
          reason = 'issuer_validity_ended';
          resultingStatus = 'expired';
        } else if (!expired && target.status === 'current') {
          reason = candidate.assertedState === 'retracted'
            ? 'source_report_retracted'
            : candidate.assertedState === 'superseded'
              ? 'source_report_superseded'
              : 'source_report_withdrawn';
          resultingStatus = 'needs_update';
        } else {
          counts.noChange += 1;
          continue;
        }

        if (reason === null || resultingStatus === null) {
          return failed('ledger_result_invalid', counts, request.cursor);
        }
        if (target.transitionSequence >= MAX_DATABASE_INTEGER) return conflict(counts, request.cursor);
        let idempotencyKey: string;
        try {
          idempotencyKey = await deriveIdempotencyKey(candidate, reason);
        } catch {
          return failed('idempotency_key_failed', counts, request.cursor);
        }
        const commonInput = {
          datasetKind: 'live' as const,
          eventId: target.eventId,
          eventVersion: target.eventVersion,
          target: target.target,
          expectedSequence: target.transitionSequence + 1,
          previousStatus: target.status,
          resultingStatus,
          evaluatedAt: request.now,
          traceId: request.traceId,
          idempotencyKey,
          evidenceReferenceIds: [],
        };

        let result: FreshnessTransitionAppendResult | SourceRevisionFreshnessTransitionAppendResult;
        try {
          if (reason === 'source_report_retracted' || reason === 'source_report_superseded'
            || reason === 'source_report_withdrawn') {
            const sourceInput: AppendSourceRevisionFreshnessTransitionInput = {
              ...commonInput,
              reason,
              sourceObservationId: candidate.observationId,
            };
            result = await ports.ledger.append(sourceInput);
          } else {
            const issuerInput: AppendFreshnessTransitionInput = { ...commonInput, reason };
            result = await ports.ledger.append(issuerInput);
          }
        } catch {
          return failed('ledger_write_failed', counts, request.cursor);
        }
        if (!isObject(result)) return failed('ledger_result_invalid', counts, request.cursor);
        if (result.outcome === 'conflict') return conflict(counts, request.cursor);
        if (result.outcome === 'written') counts.written += 1;
        else if (result.outcome === 'replayed') counts.replayed += 1;
        else return failed('ledger_result_invalid', counts, request.cursor);
      }

      return completed(counts, page.nextCursor);
    },
  };
}

function validateRequest(value: unknown): ValidatedRequest {
  if (!isObject(value)) return invalidRequest();
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== 'string' || !ALLOWED_REQUEST_KEYS.has(key))
    || REQUIRED_REQUEST_KEYS.some((key) => !Object.hasOwn(value, key))
    || value.datasetKind !== 'live'
    || !Number.isSafeInteger(value.limit) || (value.limit as number) < 1 || (value.limit as number) > MAX_PAGE_SIZE
    || typeof value.now !== 'string' || value.now.length > MAX_TIMESTAMP_LENGTH || parseInstant(value.now) === null
    || !isId(value.traceId)) {
    return invalidRequest();
  }

  let cursor: SourceRevisionReviewCandidateCursor | null = null;
  if (Object.hasOwn(value, 'cursor')) {
    if (value.cursor !== null) {
      cursor = validateCursor(value.cursor);
      if (cursor === null) return invalidRequest();
    }
  }
  return { now: value.now, limit: value.limit as number, cursor, traceId: value.traceId };
}

function validatePage(value: unknown, request: ValidatedRequest): ValidatedPage | null {
  if (!isObject(value) || !hasExactKeys(value, PAGE_KEYS)
    || !Array.isArray(value.candidates) || value.candidates.length > request.limit) return null;

  const candidates: Candidate[] = [];
  let previousKey: readonly [string, string, number, string, string, number] | null = null;
  const cursorKey = request.cursor === null ? null : candidateKey(request.cursor);
  for (const row of value.candidates) {
    const candidate = validateCandidate(row);
    if (candidate === null) return null;
    const key = candidateKey(candidate);
    if ((previousKey !== null && compareCandidateKeys(key, previousKey) <= 0)
      || (cursorKey !== null && compareCandidateKeys(key, cursorKey) <= 0)) return null;
    candidates.push(candidate);
    previousKey = key;
  }

  let nextCursor: SourceRevisionReviewCandidateCursor | null = null;
  if (value.nextCursor !== null) {
    nextCursor = validateCursor(value.nextCursor);
    const last = candidates.at(-1);
    if (nextCursor === null || candidates.length !== request.limit || last === undefined
      || !sameCandidateCursor(nextCursor, last)) return null;
  }
  return { candidates, nextCursor };
}

function validateCandidate(value: unknown): Candidate | null {
  if (!isObject(value) || !hasExactKeys(value, CANDIDATE_KEYS)
    || value.datasetKind !== 'live' || !isId(value.observationId)
    || !isId(value.targetReportRevisionId) || !isId(value.assertionReportRevisionId)
    || !isIdOrNull(value.replacementReportRevisionId)
    || !isNullableInstant(value.publisherObservedAt)
    || !isInstant(value.retrievedAt) || !isInstant(value.recordedAt)
    || !isId(value.eventId) || !isPositiveDatabaseInteger(value.eventVersion)
    || (value.assertedState !== 'current' && value.assertedState !== 'superseded'
      && value.assertedState !== 'retracted' && value.assertedState !== 'withdrawn')) return null;
  if ((value.assertedState === 'superseded') !== (value.replacementReportRevisionId !== null)) return null;
  const target = validateCandidateTarget(value.target);
  if (target === null) return null;
  return {
    observationId: value.observationId,
    assertedState: value.assertedState,
    eventId: value.eventId,
    eventVersion: value.eventVersion,
    target,
  };
}

function validateCandidateTarget(value: unknown): SourceRevisionReviewTargetIdentity | null {
  if (!isObject(value) || typeof value.kind !== 'string') return null;
  if (value.kind === 'event_claim_set' && hasExactKeys(value, ['kind'])) return { kind: 'event_claim_set' };
  if (value.kind === 'impact' && hasExactKeys(value, ['kind', 'impactId', 'impactVersion'])
    && isId(value.impactId) && isPositiveDatabaseInteger(value.impactVersion)) {
    return { kind: 'impact', impactId: value.impactId, impactVersion: value.impactVersion };
  }
  return null;
}

function validateCursor(value: unknown): SourceRevisionReviewCandidateCursor | null {
  if (!isObject(value) || !hasExactKeys(value, ['observationId', 'eventId', 'eventVersion', 'target'])
    || !isId(value.observationId) || !isId(value.eventId) || !isPositiveDatabaseInteger(value.eventVersion)) return null;
  const target = validateCandidateTarget(value.target);
  return target === null ? null : {
    observationId: value.observationId,
    eventId: value.eventId,
    eventVersion: value.eventVersion,
    target,
  };
}

function validateTargets(value: unknown, selected: readonly Candidate[]): readonly SourceRevisionFreshnessTarget[] | null {
  if (!Array.isArray(value) || value.length > selected.length) return null;
  const requested = new Set(selected.map((candidate) => targetKey(candidate.eventId, candidate.eventVersion, candidate.target)));
  const seen = new Set<string>();
  const targets: SourceRevisionFreshnessTarget[] = [];
  let previousKey: readonly [string, number, string, string, number] | null = null;
  for (const row of value) {
    if (!isObject(row) || !hasExactKeys(row, TARGET_KEYS)
      || !isId(row.eventId) || !isPositiveDatabaseInteger(row.eventVersion)
      || (row.status !== 'current' && row.status !== 'needs_update' && row.status !== 'expired')
      || !isNonnegativeDatabaseInteger(row.transitionSequence)
      || !isNullableInstant(row.validUntil)) return null;
    const target = validateFreshnessTarget(row.target);
    if (target === null) return null;
    const key = targetKey(row.eventId, row.eventVersion, target);
    const sortKey = freshnessKey(row.eventId, row.eventVersion, target);
    if (!requested.has(key) || seen.has(key)
      || (previousKey !== null && compareFreshnessKeys(sortKey, previousKey) <= 0)) return null;
    seen.add(key);
    previousKey = sortKey;
    targets.push({
      eventId: row.eventId,
      eventVersion: row.eventVersion,
      target,
      status: row.status,
      transitionSequence: row.transitionSequence,
      validUntil: row.validUntil,
    });
  }
  return targets;
}

function validateFreshnessTarget(value: unknown): FreshnessTargetIdentity | null {
  if (!isObject(value) || typeof value.kind !== 'string') return null;
  if (value.kind === 'event_claim_set' && hasExactKeys(value, ['kind'])) return { kind: 'event_claim_set' };
  if (value.kind === 'impact' && hasExactKeys(value, ['kind', 'impactId', 'impactVersion'])
    && isId(value.impactId) && isPositiveDatabaseInteger(value.impactVersion)) {
    return { kind: 'impact', impactId: value.impactId, impactVersion: value.impactVersion };
  }
  return null;
}

async function deriveIdempotencyKey(
  candidate: Candidate,
  reason: TransitionReason,
): Promise<string> {
  const identity = JSON.stringify([
    'waspada:source-revision-freshness:v1', candidate.eventId, candidate.eventVersion,
    candidate.target.kind,
    candidate.target.kind === 'impact' ? candidate.target.impactId : null,
    candidate.target.kind === 'impact' ? candidate.target.impactVersion : null,
    candidate.observationId, reason,
  ]);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(identity));
  const hex = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `source-revision-freshness:${hex}`;
}

function toTargetRequest(candidate: Candidate): SourceRevisionFreshnessTargetRequest {
  return {
    eventId: candidate.eventId,
    eventVersion: candidate.eventVersion,
    target: candidate.target,
  };
}

function targetKey(eventId: string, eventVersion: number, target: FreshnessTargetIdentity): string {
  return JSON.stringify([
    eventId, eventVersion, target.kind,
    target.kind === 'impact' ? target.impactId : null,
    target.kind === 'impact' ? target.impactVersion : null,
  ]);
}

function candidateKey(value: Candidate | SourceRevisionReviewCandidateCursor): readonly [string, string, number, string, string, number] {
  return [
    value.observationId,
    value.eventId,
    value.eventVersion,
    value.target.kind,
    value.target.kind === 'impact' ? value.target.impactId : '',
    value.target.kind === 'impact' ? value.target.impactVersion : 0,
  ];
}

function freshnessKey(
  eventId: string,
  eventVersion: number,
  target: FreshnessTargetIdentity,
): readonly [string, number, string, string, number] {
  return [eventId, eventVersion, target.kind,
    target.kind === 'impact' ? target.impactId : '',
    target.kind === 'impact' ? target.impactVersion : 0];
}

function compareCandidates(left: Candidate, right: Candidate): number {
  return compareCandidateKeys(candidateKey(left), candidateKey(right));
}

function compareCandidateKeys(
  left: readonly [string, string, number, string, string, number],
  right: readonly [string, string, number, string, string, number],
): number {
  return compareText(left[0], right[0]) || compareText(left[1], right[1])
    || compareNumbers(left[2], right[2]) || compareText(left[3], right[3])
    || compareText(left[4], right[4]) || compareNumbers(left[5], right[5]);
}

function compareFreshnessKeys(
  left: readonly [string, number, string, string, number],
  right: readonly [string, number, string, string, number],
): number {
  return compareText(left[0], right[0]) || compareNumbers(left[1], right[1])
    || compareText(left[2], right[2]) || compareText(left[3], right[3])
    || compareNumbers(left[4], right[4]);
}

function sameCandidateCursor(cursor: SourceRevisionReviewCandidateCursor, candidate: Candidate): boolean {
  return compareCandidateKeys(candidateKey(cursor), candidateKey(candidate)) === 0;
}

function compareInstants(left: string, right: string): number {
  const leftInstant = parseInstant(left)!;
  const rightInstant = parseInstant(right)!;
  if (leftInstant.seconds !== rightInstant.seconds) return leftInstant.seconds < rightInstant.seconds ? -1 : 1;
  const width = Math.max(leftInstant.fraction.length, rightInstant.fraction.length);
  const leftFraction = leftInstant.fraction.padEnd(width, '0');
  const rightFraction = rightInstant.fraction.padEnd(width, '0');
  return compareText(leftFraction, rightFraction);
}

function parseInstant(value: string): Instant | null {
  const match = RFC3339_PATTERN.exec(value);
  if (match === null) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetHour = match[10] === undefined ? 0 : Number(match[10]);
  const offsetMinute = match[11] === undefined ? 0 : Number(match[11]);
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)
    || hour > 23 || minute > 59 || second > 59 || offsetHour > 23 || offsetMinute > 59) return null;

  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, 0);
  const localOffset = (offsetHour * 60 + offsetMinute) * 60;
  const signedOffset = match[9] === '-' ? -localOffset : localOffset;
  const seconds = BigInt(Math.floor(date.getTime() / 1000) - signedOffset);
  return { seconds, fraction: (match[7] ?? '').replace(/0+$/u, '') };
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28;
  return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31;
}

function isInstant(value: unknown): value is string {
  return typeof value === 'string' && value.length <= MAX_TIMESTAMP_LENGTH && parseInstant(value) !== null;
}

function isNullableInstant(value: unknown): value is string | null {
  return value === null || isInstant(value);
}

function isId(value: unknown): value is string {
  return typeof value === 'string' && ID_PATTERN.test(value);
}

function isIdOrNull(value: unknown): value is string | null {
  return value === null || isId(value);
}

function isPositiveDatabaseInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0 && (value as number) <= MAX_DATABASE_INTEGER;
}

function isNonnegativeDatabaseInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= MAX_DATABASE_INTEGER;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareNumbers(left: number, right: number): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function hasExactKeys(value: Record<string, unknown>, expectedKeys: readonly string[]): boolean {
  const expected = new Set<string>(expectedKeys);
  const actual = Reflect.ownKeys(value);
  return actual.length === expected.size
    && actual.every((key) => typeof key === 'string' && expected.has(key));
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function emptyCounts(): MutableCounts {
  return {
    candidates: 0,
    invalidatingCandidates: 0,
    selectedTargets: 0,
    duplicateCandidates: 0,
    skippedCandidates: 0,
    written: 0,
    replayed: 0,
    noChange: 0,
  };
}

function snapshotCounts(counts: MutableCounts): SourceRevisionFreshnessTransitionCounts {
  return { ...counts };
}

function completed(
  counts: MutableCounts,
  nextCursor: SourceRevisionReviewCandidateCursor | null,
): SourceRevisionFreshnessTransitionResult {
  return { outcome: 'completed', counts: snapshotCounts(counts), nextCursor };
}

function conflict(
  counts: MutableCounts,
  resumeCursor: SourceRevisionReviewCandidateCursor | null,
): SourceRevisionFreshnessTransitionResult {
  return { outcome: 'conflict', code: 'stale_target', counts: snapshotCounts(counts), resumeCursor };
}

function failed(
  code: Extract<SourceRevisionFreshnessTransitionResult, { outcome: 'failed' }>['code'],
  counts: MutableCounts,
  resumeCursor: SourceRevisionReviewCandidateCursor | null,
): SourceRevisionFreshnessTransitionResult {
  return { outcome: 'failed', code, counts: snapshotCounts(counts), resumeCursor };
}

function invalidRequest(): never {
  throw new SourceRevisionFreshnessTransitionError();
}
