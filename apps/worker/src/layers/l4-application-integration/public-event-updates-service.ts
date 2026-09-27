import type { HistoryEntry } from "../../contracts/public-api.js";
import {
  createPublicEventUpdatesCursorCodec,
  PublicEventUpdatesCursorCodecError,
} from "./public-event-updates-cursor.js";

export const PUBLIC_EVENT_UPDATES_SERVICE_LIMITS = Object.freeze({
  defaultPageSize: 20,
  maxPageSize: 100,
  eventIdLength: 128,
  summaryCodePoints: 500,
  sequenceMax: "9223372036854775807",
});

export interface PublicEventUpdatesReadOptions {
  readonly afterSequence: string;
  readonly throughSequence: string;
  readonly limit: number;
}

/** Transaction-bound implementations must read both values in one repeatable-read snapshot. */
export interface PublicEventUpdatesReaderPort {
  readWatermark(): Promise<unknown>;
  readCandidates(options: PublicEventUpdatesReadOptions): Promise<unknown>;
}

export interface PublicEventUpdatesPage {
  readonly items: HistoryEntry[];
  readonly next_cursor: string;
  readonly cursor_expires_at: string;
  readonly checked_at: string;
}

export interface PublicEventUpdatesService {
  read(options?: unknown): Promise<PublicEventUpdatesPage>;
}

export type PublicEventUpdatesServiceErrorCode =
  | "INVALID_REQUEST"
  | "CURSOR_RESTART_REQUIRED"
  | "READER_READ_FAILED"
  | "READER_RESULT_INVALID"
  | "CURSOR_ISSUE_FAILED";

const errorMessages: Record<PublicEventUpdatesServiceErrorCode, string> = {
  INVALID_REQUEST: "The public update request is invalid.",
  CURSOR_RESTART_REQUIRED: "Update polling must restart from the current public snapshot.",
  READER_READ_FAILED: "Public updates could not be read.",
  READER_RESULT_INVALID: "The public update result is invalid.",
  CURSOR_ISSUE_FAILED: "The public update cursor could not be issued.",
};

const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const sequencePattern = /^(0|[1-9][0-9]{0,18})$/u;
const maximumDatabaseInteger = 2_147_483_647;
const timestampPattern = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|([+-])(\d{2}):(\d{2}))$/u;
const changeTypes = new Set<HistoryEntry["change_type"]>([
  "published",
  "corrected",
  "impact_changed",
  "retracted",
]);
const requestKeys = ["cursor", "limit"] as const;
const pageKeys = ["candidates", "hasMore"] as const;
const candidateKeys = [
  "datasetKind", "eventId", "eventVersion", "changeSequence", "changeType", "summary", "publishedAt",
] as const;

interface ValidatedRequest {
  readonly cursor: string | undefined;
  readonly limit: number;
}

interface ValidatedCandidate {
  readonly eventId: string;
  readonly eventVersion: number;
  readonly changeSequence: string;
  readonly changeType: HistoryEntry["change_type"];
  readonly summary: string;
  readonly publishedAt: string;
}

interface ValidatedCandidatePage {
  readonly candidates: readonly ValidatedCandidate[];
  readonly hasMore: boolean;
}

interface CursorToken {
  readonly sequence: string;
  readonly expiresAt: string;
}

/** Stable errors never contain cursor data, reader rows, SQL, or crypto details. */
export class PublicEventUpdatesServiceError extends Error {
  constructor(readonly code: PublicEventUpdatesServiceErrorCode) {
    super(errorMessages[code]);
    this.name = "PublicEventUpdatesServiceError";
  }
}

/**
 * Projects latest-approved reader candidates into the unchanged HistoryEntry
 * allowlist and adds a stateless 30-day continuation cursor.
 */
export function createPublicEventUpdatesService(options: {
  readonly reader: PublicEventUpdatesReaderPort;
  readonly key: CryptoKey;
  readonly now: () => number;
}): PublicEventUpdatesService {
  const cursorCodec = createPublicEventUpdatesCursorCodec({
    key: options.key,
    now: options.now,
  });

  return {
    async read(value?: unknown): Promise<PublicEventUpdatesPage> {
      const request = validateRequest(value);
      let decodedCursor: CursorToken | null = null;

      if (request.cursor !== undefined) {
        try {
          decodedCursor = await cursorCodec.decode(request.cursor);
        } catch (error) {
          if (error instanceof PublicEventUpdatesCursorCodecError
            && error.code === "CURSOR_EXPIRED") {
            fail("CURSOR_RESTART_REQUIRED");
          }
          fail("INVALID_REQUEST");
        }
      }

      let watermarkValue: unknown;
      try {
        watermarkValue = await options.reader.readWatermark();
      } catch {
        fail("READER_READ_FAILED");
      }
      if (!isSequence(watermarkValue)) fail("READER_RESULT_INVALID");
      const watermark = watermarkValue;

      let items: HistoryEntry[] = [];
      let nextSequence = watermark;
      if (decodedCursor !== null) {
        if (compareSequences(decodedCursor.sequence, watermark) > 0) {
          fail("CURSOR_RESTART_REQUIRED");
        }

        let candidateValue: unknown;
        try {
          candidateValue = await options.reader.readCandidates(Object.freeze({
            afterSequence: decodedCursor.sequence,
            throughSequence: watermark,
            limit: request.limit,
          }));
        } catch {
          fail("READER_READ_FAILED");
        }

        const page = validateCandidatePage(
          candidateValue,
          decodedCursor.sequence,
          watermark,
          request.limit,
        );
        items = page.candidates.map((candidate) => ({
          event_id: candidate.eventId,
          version: candidate.eventVersion,
          change_type: candidate.changeType,
          changed_at: candidate.publishedAt,
          summary: candidate.summary,
        }));
        if (page.hasMore) {
          const lastCandidate = page.candidates[page.candidates.length - 1];
          if (lastCandidate === undefined) fail("READER_RESULT_INVALID");
          nextSequence = lastCandidate.changeSequence;
        }
      }

      const checkedAt = formatCheckedAt(options.now);
      let issuedCursor;
      try {
        issuedCursor = await cursorCodec.issue(nextSequence);
      } catch {
        fail("CURSOR_ISSUE_FAILED");
      }

      return {
        items,
        next_cursor: issuedCursor.token,
        cursor_expires_at: issuedCursor.expiresAt,
        checked_at: checkedAt,
      };
    },
  };
}

function validateRequest(value: unknown): ValidatedRequest {
  if (value === undefined) {
    return { cursor: undefined, limit: PUBLIC_EVENT_UPDATES_SERVICE_LIMITS.defaultPageSize };
  }

  const record = snapshotPlainRecord(value);
  if (record === null || !hasOnlyKeys(record, requestKeys)) fail("INVALID_REQUEST");

  let cursor: string | undefined;
  if (Object.hasOwn(record, "cursor") && record.cursor !== undefined) {
    if (typeof record.cursor !== "string"
      || record.cursor.length === 0
      || record.cursor.length > 2_048) {
      fail("INVALID_REQUEST");
    }
    cursor = record.cursor;
  }

  const limit = record.limit === undefined
    ? PUBLIC_EVENT_UPDATES_SERVICE_LIMITS.defaultPageSize
    : record.limit;
  if (!isSafeInteger(limit, 1, PUBLIC_EVENT_UPDATES_SERVICE_LIMITS.maxPageSize)) {
    fail("INVALID_REQUEST");
  }
  return { cursor, limit };
}

function validateCandidatePage(
  value: unknown,
  afterSequence: string,
  throughSequence: string,
  limit: number,
): ValidatedCandidatePage {
  try {
    const page = snapshotPlainRecord(value);
    if (page === null || !hasExactKeys(page, pageKeys)
      || !Array.isArray(page.candidates)
      || typeof page.hasMore !== "boolean"
      || page.candidates.length > limit
      || (page.hasMore && page.candidates.length !== limit)) {
      fail("READER_RESULT_INVALID");
    }

    const candidates: ValidatedCandidate[] = [];
    let previousSequence = afterSequence;
    for (let index = 0; index < page.candidates.length; index += 1) {
      const candidate = snapshotPlainRecord(page.candidates[index]);
      if (candidate === null || !hasExactKeys(candidate, candidateKeys)
        || candidate.datasetKind !== "live"
        || !isIdentifier(candidate.eventId)
        || !isPositiveDatabaseInteger(candidate.eventVersion)
        || !isSequence(candidate.changeSequence)
        || compareSequences(candidate.changeSequence, previousSequence) <= 0
        || compareSequences(candidate.changeSequence, throughSequence) > 0
        || !isChangeType(candidate.changeType)
        || !isValidSummary(candidate.summary)
        || !isDateTime(candidate.publishedAt)) {
        fail("READER_RESULT_INVALID");
      }

      candidates.push({
        eventId: candidate.eventId,
        eventVersion: candidate.eventVersion,
        changeSequence: candidate.changeSequence,
        changeType: candidate.changeType,
        summary: candidate.summary,
        publishedAt: candidate.publishedAt,
      });
      previousSequence = candidate.changeSequence;
    }

    return { candidates, hasMore: page.hasMore };
  } catch (error) {
    if (error instanceof PublicEventUpdatesServiceError) throw error;
    fail("READER_RESULT_INVALID");
  }
}

function isIdentifier(value: unknown): value is string {
  return typeof value === "string" && identifierPattern.test(value);
}

function isSequence(value: unknown): value is string {
  return typeof value === "string"
    && sequencePattern.test(value)
    && compareSequences(value, PUBLIC_EVENT_UPDATES_SERVICE_LIMITS.sequenceMax) <= 0;
}

function compareSequences(left: string, right: string): number {
  if (left.length !== right.length) return left.length < right.length ? -1 : 1;
  return left === right ? 0 : left < right ? -1 : 1;
}

function isChangeType(value: unknown): value is HistoryEntry["change_type"] {
  return typeof value === "string"
    && changeTypes.has(value as HistoryEntry["change_type"]);
}

function isValidSummary(value: unknown): value is string {
  if (typeof value !== "string" || value.trim().length === 0) return false;
  const codePoints = Array.from(value).length;
  return codePoints >= 1 && codePoints <= PUBLIC_EVENT_UPDATES_SERVICE_LIMITS.summaryCodePoints;
}

function isDateTime(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 128) return false;
  const match = timestampPattern.exec(value);
  if (match === null || !Number.isFinite(Date.parse(value))) return false;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetHour = match[10] === undefined ? 0 : Number(match[10]);
  const offsetMinute = match[11] === undefined ? 0 : Number(match[11]);
  if (year < 1 || month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59
    || offsetHour > 23 || offsetMinute > 59) {
    return false;
  }
  return day >= 1 && day <= daysInMonth(year, month);
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function isPositiveDatabaseInteger(value: unknown): value is number {
  return isSafeInteger(value, 1, maximumDatabaseInteger);
}

function isSafeInteger(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === "number"
    && Number.isSafeInteger(value)
    && value >= minimum
    && value <= maximum;
}

function formatCheckedAt(now: () => number): string {
  let value: number;
  try {
    value = now();
  } catch {
    fail("CURSOR_ISSUE_FAILED");
  }
  if (!Number.isSafeInteger(value)) fail("CURSOR_ISSUE_FAILED");
  try {
    const timestamp = new Date(value).toISOString();
    if (!isDateTime(timestamp)) fail("CURSOR_ISSUE_FAILED");
    return timestamp;
  } catch {
    fail("CURSOR_ISSUE_FAILED");
  }
}

function snapshotPlainRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;

    const copy: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string") return null;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !Object.hasOwn(descriptor, "value")) return null;
      copy[key] = descriptor.value;
    }
    return copy;
  } catch {
    return null;
  }
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Reflect.ownKeys(value).every((key) => typeof key === "string" && allowed.includes(key));
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Reflect.ownKeys(value);
  return actual.length === expected.length
    && actual.every((key) => typeof key === "string" && expected.includes(key));
}

function fail(code: PublicEventUpdatesServiceErrorCode): never {
  throw new PublicEventUpdatesServiceError(code);
}
