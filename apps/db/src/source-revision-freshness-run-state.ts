import type { SqlExecutor } from './sql.js';
import type { SourceRevisionReviewCandidateCursor } from './source-revision-review-candidate-reader.js';

export type SourceRevisionFreshnessRunStatus = 'open' | 'succeeded' | 'failed';
export type SourceRevisionFreshnessRunAdvanceOutcome = 'advanced' | 'replayed' | 'conflict';

export interface SourceRevisionFreshnessRunCounts {
  readonly candidates: number;
  readonly invalidatingCandidates: number;
  readonly selectedTargets: number;
  readonly duplicateCandidates: number;
  readonly skippedCandidates: number;
  readonly written: number;
  readonly replayed: number;
  readonly noChange: number;
}

export interface BeginSourceRevisionFreshnessRunInput {
  readonly traceId: string;
  readonly startedAt: string;
}

export interface BeginSourceRevisionFreshnessRunResult {
  readonly status: SourceRevisionFreshnessRunStatus;
  readonly inputCursor: SourceRevisionReviewCandidateCursor | null;
}

export interface AdvanceSourceRevisionFreshnessRunInput {
  readonly traceId: string;
  readonly startedAt: string;
  readonly inputCursor: SourceRevisionReviewCandidateCursor | null;
  readonly nextCursor: SourceRevisionReviewCandidateCursor | null;
}

export interface FinalizeSourceRevisionFreshnessRunInput {
  readonly traceId: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly outcome: 'succeeded' | 'failed';
  readonly summary: SourceRevisionFreshnessRunCounts;
}

export interface SourceRevisionFreshnessRunStateRepository {
  begin(input: unknown): Promise<BeginSourceRevisionFreshnessRunResult>;
  advance(input: unknown): Promise<SourceRevisionFreshnessRunAdvanceOutcome>;
  finalize(input: unknown): Promise<'succeeded' | 'failed'>;
}

export class SourceRevisionFreshnessRunStateInputError extends Error {
  constructor() {
    super('The source-revision freshness run-state input is invalid.');
    this.name = 'SourceRevisionFreshnessRunStateInputError';
  }
}

export class SourceRevisionFreshnessRunStateStorageError extends Error {
  constructor() {
    super('The source-revision freshness run state could not be read or written.');
    this.name = 'SourceRevisionFreshnessRunStateStorageError';
  }
}

interface BeginRow {
  readonly run_status: unknown;
  readonly input_cursor: unknown;
}

interface TextRow {
  readonly outcome: unknown;
}

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const RFC3339_PATTERN = /^([0-9]{4})-(0[1-9]|1[0-2])-([0-2][0-9]|3[01])T([01][0-9]|2[0-3]):([0-5][0-9]):([0-5][0-9])(?:\.([0-9]{1,6}))?(Z|([+-])([01][0-9]|2[0-3]):([0-5][0-9]))$/u;
const MAX_DATABASE_INTEGER = 2_147_483_647;
const CURSOR_KEYS = ['observationId', 'eventId', 'eventVersion', 'target'] as const;
const EVENT_TARGET_KEYS = ['kind'] as const;
const IMPACT_TARGET_KEYS = ['kind', 'impactId', 'impactVersion'] as const;
const SUMMARY_KEYS = [
  'candidates', 'invalidatingCandidates', 'selectedTargets', 'duplicateCandidates',
  'skippedCandidates', 'written', 'replayed', 'noChange',
] as const;

/** Fixed-purpose DB access for resumable, one-page live source-revision freshness runs. */
export function createSourceRevisionFreshnessRunStateRepository(
  executor: SqlExecutor,
): SourceRevisionFreshnessRunStateRepository {
  if (!executor || typeof executor.query !== 'function') {
    throw new TypeError('Source-revision freshness run state requires a SQL executor');
  }

  return {
    async begin(value): Promise<BeginSourceRevisionFreshnessRunResult> {
      const input = validateRunIdentity(value);
      let rows: unknown;
      try {
        const result: unknown = await executor.query<BeginRow>(
          `SELECT run_status, input_cursor
           FROM waspada.begin_source_revision_freshness_run($1, $2)`,
          [input.traceId, input.startedAt],
        );
        rows = isObject(result) ? result.rows : undefined;
      } catch {
        throw new SourceRevisionFreshnessRunStateStorageError();
      }
      if (!Array.isArray(rows) || rows.length !== 1 || !isObject(rows[0])) {
        throw new SourceRevisionFreshnessRunStateStorageError();
      }
      const row = rows[0] as unknown as BeginRow;
      if (row.run_status !== 'open' && row.run_status !== 'succeeded' && row.run_status !== 'failed') {
        throw new SourceRevisionFreshnessRunStateStorageError();
      }
      const inputCursor = row.input_cursor === null ? null : validateCursor(row.input_cursor);
      if (row.input_cursor !== null && inputCursor === null) {
        throw new SourceRevisionFreshnessRunStateStorageError();
      }
      return { status: row.run_status, inputCursor };
    },

    async advance(value): Promise<SourceRevisionFreshnessRunAdvanceOutcome> {
      const input = validateAdvance(value);
      let rows: unknown;
      try {
        const result: unknown = await executor.query<TextRow>(
          `SELECT waspada.advance_source_revision_freshness_run($1, $2, $3::jsonb, $4::jsonb)
             AS outcome`,
          [
            input.traceId,
            input.startedAt,
            input.inputCursor === null ? null : JSON.stringify(input.inputCursor),
            input.nextCursor === null ? null : JSON.stringify(input.nextCursor),
          ],
        );
        rows = isObject(result) ? result.rows : undefined;
      } catch {
        throw new SourceRevisionFreshnessRunStateStorageError();
      }
      const outcome = singleText(rows);
      if (outcome !== 'advanced' && outcome !== 'replayed' && outcome !== 'conflict') {
        throw new SourceRevisionFreshnessRunStateStorageError();
      }
      return outcome;
    },

    async finalize(value): Promise<'succeeded' | 'failed'> {
      const input = validateFinalize(value);
      let rows: unknown;
      try {
        const result: unknown = await executor.query<TextRow>(
          `SELECT waspada.finalize_source_revision_freshness_run($1, $2, $3, $4, $5::jsonb)
             AS outcome`,
          [input.traceId, input.startedAt, input.finishedAt, input.outcome, JSON.stringify(input.summary)],
        );
        rows = isObject(result) ? result.rows : undefined;
      } catch {
        throw new SourceRevisionFreshnessRunStateStorageError();
      }
      const outcome = singleText(rows);
      if (outcome !== input.outcome) throw new SourceRevisionFreshnessRunStateStorageError();
      return input.outcome;
    },
  };
}

function validateRunIdentity(value: unknown): BeginSourceRevisionFreshnessRunInput {
  if (!isObject(value) || !hasExactKeys(value, ['traceId', 'startedAt'])
    || !isId(value.traceId) || !isTimestamp(value.startedAt)) {
    return invalidInput();
  }
  return { traceId: value.traceId, startedAt: value.startedAt };
}

function validateAdvance(value: unknown): AdvanceSourceRevisionFreshnessRunInput {
  if (!isObject(value)
    || !hasExactKeys(value, ['traceId', 'startedAt', 'inputCursor', 'nextCursor'])
    || !isId(value.traceId)
    || !isTimestamp(value.startedAt)) {
    return invalidInput();
  }
  const inputCursor = value.inputCursor === null ? null : validateCursor(value.inputCursor);
  const nextCursor = value.nextCursor === null ? null : validateCursor(value.nextCursor);
  if ((value.inputCursor !== null && inputCursor === null)
    || (value.nextCursor !== null && nextCursor === null)
    || (inputCursor !== null && nextCursor !== null && compareCursor(nextCursor, inputCursor) <= 0)) {
    return invalidInput();
  }
  return { traceId: value.traceId, startedAt: value.startedAt, inputCursor, nextCursor };
}

function validateFinalize(value: unknown): FinalizeSourceRevisionFreshnessRunInput {
  if (!isObject(value)
    || !hasExactKeys(value, ['traceId', 'startedAt', 'finishedAt', 'outcome', 'summary'])
    || !isId(value.traceId)
    || !isTimestamp(value.startedAt)
    || !isTimestamp(value.finishedAt)) {
    return invalidInput();
  }
  const outcome = value.outcome;
  if (outcome !== 'succeeded' && outcome !== 'failed') return invalidInput();
  const summary = validateSummary(value.summary, outcome);
  if (summary === null || compareTimestamps(value.finishedAt, value.startedAt) < 0) return invalidInput();
  return {
    traceId: value.traceId,
    startedAt: value.startedAt,
    finishedAt: value.finishedAt,
    outcome,
    summary,
  };
}

function validateCursor(value: unknown): SourceRevisionReviewCandidateCursor | null {
  if (!isObject(value)
    || !hasExactKeys(value, CURSOR_KEYS)
    || !isId(value.observationId)
    || !isId(value.eventId)
    || !isPositiveDatabaseInteger(value.eventVersion)) {
    return null;
  }
  if (!isObject(value.target) || typeof value.target.kind !== 'string') return null;
  if (value.target.kind === 'event_claim_set' && hasExactKeys(value.target, EVENT_TARGET_KEYS)) {
    return {
      observationId: value.observationId,
      eventId: value.eventId,
      eventVersion: value.eventVersion,
      target: { kind: 'event_claim_set' },
    };
  }
  if (value.target.kind === 'impact'
    && hasExactKeys(value.target, IMPACT_TARGET_KEYS)
    && isId(value.target.impactId)
    && isPositiveDatabaseInteger(value.target.impactVersion)) {
    return {
      observationId: value.observationId,
      eventId: value.eventId,
      eventVersion: value.eventVersion,
      target: {
        kind: 'impact',
        impactId: value.target.impactId,
        impactVersion: value.target.impactVersion,
      },
    };
  }
  return null;
}

function validateSummary(value: unknown, outcome: 'succeeded' | 'failed'): SourceRevisionFreshnessRunCounts | null {
  if (!isObject(value) || !hasExactKeys(value, SUMMARY_KEYS)) return null;
  const summary: Record<string, number> = {};
  for (const key of SUMMARY_KEYS) {
    const count = value[key];
    if (!Number.isSafeInteger(count) || (count as number) < 0 || (count as number) > 100) return null;
    summary[key] = count as number;
  }
  const candidates = summary.candidates!;
  const invalidating = summary.invalidatingCandidates!;
  const selected = summary.selectedTargets!;
  const duplicates = summary.duplicateCandidates!;
  const skipped = summary.skippedCandidates!;
  const processed = summary.written! + summary.replayed! + summary.noChange!;
  if (candidates !== invalidating + skipped
    || invalidating !== selected + duplicates
    || processed > selected
    || (outcome === 'succeeded' && processed !== selected)) {
    return null;
  }
  return {
    candidates,
    invalidatingCandidates: invalidating,
    selectedTargets: selected,
    duplicateCandidates: duplicates,
    skippedCandidates: skipped,
    written: summary.written!,
    replayed: summary.replayed!,
    noChange: summary.noChange!,
  };
}

function compareCursor(left: SourceRevisionReviewCandidateCursor, right: SourceRevisionReviewCandidateCursor): number {
  const leftKey = cursorKey(left);
  const rightKey = cursorKey(right);
  for (let index = 0; index < leftKey.length; index += 1) {
    const a = leftKey[index]!;
    const b = rightKey[index]!;
    if (a === b) continue;
    return a < b ? -1 : 1;
  }
  return 0;
}

function cursorKey(cursor: SourceRevisionReviewCandidateCursor): readonly (string | number)[] {
  return [
    cursor.observationId,
    cursor.eventId,
    cursor.eventVersion,
    cursor.target.kind,
    cursor.target.kind === 'impact' ? cursor.target.impactId : '',
    cursor.target.kind === 'impact' ? cursor.target.impactVersion : 0,
  ];
}

function compareTimestamps(left: string, right: string): number {
  const a = timestampParts(left);
  const b = timestampParts(right);
  if (a.seconds !== b.seconds) return a.seconds < b.seconds ? -1 : 1;
  const fractionOrder = a.fraction.localeCompare(b.fraction);
  return fractionOrder;
}

function timestampParts(value: string): { readonly seconds: bigint; readonly fraction: string } {
  const match = RFC3339_PATTERN.exec(value)!;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, fractionText,
    zone, sign, offsetHourText, offsetMinuteText] = match;
  const date = `${yearText}-${monthText}-${dayText}T${hourText}:${minuteText}:${secondText}Z`;
  let seconds = BigInt(Date.parse(date) / 1000);
  if (zone !== 'Z') {
    const offset = BigInt(Number(offsetHourText) * 3600 + Number(offsetMinuteText) * 60);
    seconds += sign === '+' ? -offset : offset;
  }
  return { seconds, fraction: (fractionText ?? '').padEnd(6, '0') };
}

function isTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = RFC3339_PATTERN.exec(value);
  if (!match) return false;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  if (year < 1 || month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) return false;
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysByMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (day < 1 || day > daysByMonth[month - 1]!) return false;
  try {
    const parts = timestampParts(value);
    return Number.isFinite(Number(parts.seconds));
  } catch {
    return false;
  }
}

function isId(value: unknown): value is string {
  return typeof value === 'string' && ID_PATTERN.test(value);
}

function isPositiveDatabaseInteger(value: unknown): value is number {
  return Number.isSafeInteger(value)
    && (value as number) > 0
    && (value as number) <= MAX_DATABASE_INTEGER;
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const expected = new Set<string>(keys);
  const actual = Reflect.ownKeys(value);
  return actual.length === expected.size
    && actual.every((key) => typeof key === 'string' && expected.has(key));
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function singleText(rows: unknown): unknown {
  if (!Array.isArray(rows) || rows.length !== 1 || !isObject(rows[0])) return undefined;
  return (rows[0] as unknown as TextRow).outcome;
}

function invalidInput(): never {
  throw new SourceRevisionFreshnessRunStateInputError();
}
