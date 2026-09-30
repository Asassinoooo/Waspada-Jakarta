import type { FreshnessStatus } from "../../contracts/public-api.js";

export interface FreshnessTransitionInput {
  readonly previousStatus: FreshnessStatus;
  readonly validUntil: string | null;
  readonly reviewDueAt: string | null;
  readonly now: string;
  /** True only after Layer 4 evaluates newer, applicable evidence for this record. */
  readonly newApplicableEvidenceEvaluated: boolean;
}

export type FreshnessTransitionReason =
  | "issuer_validity_ended"
  | "new_applicable_evidence_evaluated"
  | "review_deadline_missed"
  | "stale_state_retained"
  | "current_state_retained";

export interface FreshnessTransitionResult {
  readonly status: FreshnessStatus;
  readonly reason: FreshnessTransitionReason;
}

export class FreshnessTransitionPolicyError extends Error {
  readonly code = "INVALID_INPUT" as const;

  constructor() {
    super("Invalid freshness transition input.");
    this.name = "FreshnessTransitionPolicyError";
  }
}

interface ParsedInstant {
  readonly epochSecond: number;
  /** Normalized decimal digits for the fractional second; trailing zeroes are omitted. */
  readonly fraction: string;
}

interface ValidatedInput {
  readonly previousStatus: FreshnessStatus;
  readonly validUntil: ParsedInstant | null;
  readonly reviewDueAt: ParsedInstant | null;
  readonly now: ParsedInstant;
  readonly newApplicableEvidenceEvaluated: boolean;
}

const RFC3339_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|([+-])(\d{2}):(\d{2}))$/;
const FRESHNESS_STATUSES: ReadonlySet<string> = new Set(["current", "needs_update", "expired"]);
const INPUT_KEYS: ReadonlySet<string> = new Set([
  "previousStatus",
  "validUntil",
  "reviewDueAt",
  "now",
  "newApplicableEvidenceEvaluated",
]);

/**
 * Evaluates freshness for exactly one event or impact record. It has no clock,
 * I/O, lifecycle, evidence-assessment, or publication behavior of its own.
 */
export function evaluateFreshnessTransition(
  input: FreshnessTransitionInput,
): FreshnessTransitionResult {
  const validated = validateInput(input);

  if (validated.validUntil !== null && compareInstants(validated.now, validated.validUntil) >= 0) {
    return { status: "expired", reason: "issuer_validity_ended" };
  }

  if (validated.newApplicableEvidenceEvaluated) {
    return { status: "current", reason: "new_applicable_evidence_evaluated" };
  }

  if (validated.previousStatus !== "current") {
    return { status: validated.previousStatus, reason: "stale_state_retained" };
  }

  if (validated.reviewDueAt !== null && compareInstants(validated.now, validated.reviewDueAt) >= 0) {
    return { status: "needs_update", reason: "review_deadline_missed" };
  }

  return { status: "current", reason: "current_state_retained" };
}

function validateInput(input: unknown): ValidatedInput {
  if (typeof input !== "object" || input === null || Array.isArray(input)) fail();

  const record = input as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== INPUT_KEYS.size || keys.some((key) => !INPUT_KEYS.has(key))) fail();

  if (typeof record.previousStatus !== "string" || !FRESHNESS_STATUSES.has(record.previousStatus)) fail();
  const now = parseRfc3339Instant(record.now);
  const validUntil = record.validUntil === null ? null : parseRfc3339Instant(record.validUntil);
  const reviewDueAt = record.reviewDueAt === null ? null : parseRfc3339Instant(record.reviewDueAt);
  if (now === null || (record.validUntil !== null && validUntil === null)
    || (record.reviewDueAt !== null && reviewDueAt === null)
    || typeof record.newApplicableEvidenceEvaluated !== "boolean") fail();

  return {
    previousStatus: record.previousStatus as FreshnessStatus,
    validUntil,
    reviewDueAt,
    now,
    newApplicableEvidenceEvaluated: record.newApplicableEvidenceEvaluated,
  };
}

function parseRfc3339Instant(value: unknown): ParsedInstant | null {
  if (typeof value !== "string") return null;
  const match = RFC3339_PATTERN.exec(value);
  if (match === null) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const fraction = (match[7] ?? "").replace(/0+$/u, "");
  const zoneSign = match[9];
  const offsetHour = match[10] === undefined ? 0 : Number(match[10]);
  const offsetMinute = match[11] === undefined ? 0 : Number(match[11]);

  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)
    || hour > 23 || minute > 59 || second > 59
    || offsetHour > 23 || offsetMinute > 59) return null;

  // Construct the wall-clock second without Date.UTC's special treatment of years 0–99.
  const wallClock = new Date(0);
  wallClock.setUTCFullYear(year, month - 1, day);
  wallClock.setUTCHours(hour, minute, second, 0);
  const offsetSeconds = (offsetHour * 60 + offsetMinute) * 60
    * (zoneSign === "+" ? 1 : zoneSign === "-" ? -1 : 0);
  const epochSecond = wallClock.getTime() / 1_000 - offsetSeconds;
  if (!Number.isSafeInteger(epochSecond)) return null;

  return { epochSecond, fraction };
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31;
}

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function compareInstants(left: ParsedInstant, right: ParsedInstant): number {
  if (left.epochSecond !== right.epochSecond) return left.epochSecond < right.epochSecond ? -1 : 1;

  const precision = Math.max(left.fraction.length, right.fraction.length);
  for (let index = 0; index < precision; index += 1) {
    const leftDigit = index < left.fraction.length ? left.fraction.charCodeAt(index) : 48;
    const rightDigit = index < right.fraction.length ? right.fraction.charCodeAt(index) : 48;
    if (leftDigit !== rightDigit) return leftDigit < rightDigit ? -1 : 1;
  }
  return 0;
}

function fail(): never {
  throw new FreshnessTransitionPolicyError();
}
