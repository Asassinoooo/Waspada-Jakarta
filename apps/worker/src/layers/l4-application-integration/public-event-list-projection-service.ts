import type { EventView } from "../../contracts/public-api.js";
import type { PublicEventProjectionService } from "./public-event-projection-service.js";

export const PUBLIC_EVENT_LIST_PROJECTION_LIMITS = Object.freeze({
  defaultPageSize: 20,
  maxPageSize: 100,
  maxConcurrentProjections: 4,
  eventIdLength: 128,
});

export interface PublicEventListCursor {
  readonly firstPublishedAt: string;
  readonly eventId: string;
}

export interface PublicEventListCandidateReadOptions {
  readonly limit: number;
  /** Omitted to start at the beginning of the candidate list. */
  readonly cursor?: PublicEventListCursor;
}

/** Narrow injected port for the accepted, bounded current-public candidate reader. */
export interface PublicEventListCandidateReadPort {
  read(options: PublicEventListCandidateReadOptions): Promise<unknown>;
}

export interface PublicEventListProjectionResult {
  readonly events: readonly EventView[];
  readonly nextCursor: PublicEventListCursor | null;
}

export interface PublicEventListProjectionService {
  read(request?: unknown): Promise<PublicEventListProjectionResult>;
}

export type PublicEventListProjectionServiceErrorCode =
  | "INVALID_REQUEST"
  | "CANDIDATE_READ_FAILED"
  | "CANDIDATE_RESULT_INVALID"
  | "PROJECTION_READ_FAILED"
  | "PROJECTION_RESULT_INVALID";

const errorMessages: Record<PublicEventListProjectionServiceErrorCode, string> = {
  INVALID_REQUEST: "The public event list request is invalid.",
  CANDIDATE_READ_FAILED: "The public event list could not be read.",
  CANDIDATE_RESULT_INVALID: "The public event list result is invalid.",
  PROJECTION_READ_FAILED: "The public event list could not be projected.",
  PROJECTION_RESULT_INVALID: "The public event list projection is invalid.",
};

/** Stable errors never include event IDs, cursors, record content, or port details. */
export class PublicEventListProjectionServiceError extends Error {
  constructor(readonly code: PublicEventListProjectionServiceErrorCode) {
    super(errorMessages[code]);
    this.name = "PublicEventListProjectionServiceError";
  }
}

interface ValidatedRequest {
  readonly limit: number;
  readonly cursor: PublicEventListCursor | null;
}

interface ValidatedCandidate {
  readonly eventId: string;
  readonly eventVersion: number;
  readonly firstPublishedAt: string;
}

interface ValidatedCandidatePage {
  readonly candidates: readonly ValidatedCandidate[];
  readonly nextCursor: PublicEventListCursor | null;
}

const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const maxDatabaseInteger = 2_147_483_647;
const eventViewKeys = [
  "event_id", "version", "title", "summary", "category", "tags", "lifecycle",
  "freshness", "event_time", "validity", "scope", "claims", "impacts", "published_at",
] as const;

/**
 * Composes current-public event candidates through the strict Layer 4 projector.
 * Candidate data stays internal; only projected EventViews and the candidate
 * reader's immutable continuation cursor cross this service boundary.
 */
export function createPublicEventListProjectionService(ports: {
  readonly candidates: PublicEventListCandidateReadPort;
  readonly projections: PublicEventProjectionService;
}): PublicEventListProjectionService {
  return {
    async read(request?: unknown): Promise<PublicEventListProjectionResult> {
      const validatedRequest = validateRequestBoundary(request);
      const readerOptions: PublicEventListCandidateReadOptions = validatedRequest.cursor === null
        ? { limit: validatedRequest.limit }
        : { limit: validatedRequest.limit, cursor: validatedRequest.cursor };

      let candidateResult: unknown;
      try {
        candidateResult = await ports.candidates.read(readerOptions);
      } catch {
        fail("CANDIDATE_READ_FAILED");
      }

      const page = validateCandidatePageBoundary(candidateResult, validatedRequest);
      const events: EventView[] = [];

      for (let offset = 0; offset < page.candidates.length; offset += PUBLIC_EVENT_LIST_PROJECTION_LIMITS.maxConcurrentProjections) {
        const batch = page.candidates.slice(
          offset,
          offset + PUBLIC_EVENT_LIST_PROJECTION_LIMITS.maxConcurrentProjections,
        );
        let projectionResults: readonly unknown[];
        try {
          projectionResults = await Promise.all(
            batch.map((candidate) => ports.projections.read(candidate.eventId)),
          );
        } catch {
          fail("PROJECTION_READ_FAILED");
        }

        for (let index = 0; index < batch.length; index += 1) {
          const candidate = batch[index]!;
          try {
            const event = validateProjectionResult(projectionResults[index], candidate);
            if (event !== null) events.push(event);
          } catch (error) {
            if (error instanceof PublicEventListProjectionServiceError) throw error;
            fail("PROJECTION_RESULT_INVALID");
          }
        }
      }

      return { events, nextCursor: page.nextCursor };
    },
  };
}

function validateRequestBoundary(value: unknown): ValidatedRequest {
  try {
    return validateRequest(value);
  } catch {
    fail("INVALID_REQUEST");
  }
}

function validateRequest(value: unknown): ValidatedRequest {
  if (value === undefined) {
    return { limit: PUBLIC_EVENT_LIST_PROJECTION_LIMITS.defaultPageSize, cursor: null };
  }

  const request = snapshotPlainRecord(value);
  if (request === null || !hasAllowedKeys(request, ["limit", "cursor"])) fail("INVALID_REQUEST");

  const limit = Object.hasOwn(request, "limit")
    ? request.limit
    : PUBLIC_EVENT_LIST_PROJECTION_LIMITS.defaultPageSize;
  if (!isSafeInteger(limit, 1, PUBLIC_EVENT_LIST_PROJECTION_LIMITS.maxPageSize)) fail("INVALID_REQUEST");

  const cursor = Object.hasOwn(request, "cursor")
    ? validateCursor(request.cursor)
    : null;
  return { limit, cursor };
}

function validateCandidatePageBoundary(value: unknown, request: ValidatedRequest): ValidatedCandidatePage {
  try {
    return validateCandidatePage(value, request);
  } catch {
    fail("CANDIDATE_RESULT_INVALID");
  }
}

function validateCandidatePage(value: unknown, request: ValidatedRequest): ValidatedCandidatePage {
  const page = snapshotPlainRecord(value);
  if (page === null
    || !hasExactKeys(page, ["candidates", "nextCursor"])
    || !Array.isArray(page.candidates)
    || page.candidates.length > request.limit) {
    fail("CANDIDATE_RESULT_INVALID");
  }

  const candidates: ValidatedCandidate[] = [];
  const seenEventIds = new Set<string>();
  let previous: ValidatedCandidate | null = null;

  for (const candidateValue of page.candidates) {
    const candidate = snapshotPlainRecord(candidateValue);
    if (candidate === null
      || !hasExactKeys(candidate, ["eventId", "eventVersion", "firstPublishedAt", "recordJson"])
      || !isIdentifier(candidate.eventId)
      || !isSafeInteger(candidate.eventVersion, 1, maxDatabaseInteger)
      || !isCanonicalTimestamp(candidate.firstPublishedAt)
      || snapshotPlainRecord(candidate.recordJson) === null
      || seenEventIds.has(candidate.eventId)) {
      fail("CANDIDATE_RESULT_INVALID");
    }

    const validatedCandidate: ValidatedCandidate = {
      eventId: candidate.eventId,
      eventVersion: candidate.eventVersion,
      firstPublishedAt: candidate.firstPublishedAt,
    };
    if (previous !== null && isNotAfterCandidate(previous, validatedCandidate)) {
      fail("CANDIDATE_RESULT_INVALID");
    }
    if (request.cursor !== null && !isAfterCursor(validatedCandidate, request.cursor)) {
      fail("CANDIDATE_RESULT_INVALID");
    }

    seenEventIds.add(validatedCandidate.eventId);
    candidates.push(validatedCandidate);
    previous = validatedCandidate;
  }

  const nextCursor = page.nextCursor === null ? null : validateCursor(page.nextCursor);
  if (nextCursor !== null) {
    const lastCandidate = candidates.at(-1);
    if (candidates.length !== request.limit
      || lastCandidate === undefined
      || nextCursor.eventId !== lastCandidate.eventId
      || nextCursor.firstPublishedAt !== lastCandidate.firstPublishedAt) {
      fail("CANDIDATE_RESULT_INVALID");
    }
  }

  return { candidates, nextCursor };
}

function validateProjectionResult(value: unknown, candidate: ValidatedCandidate): EventView | null {
  const result = snapshotPlainRecord(value);
  if (result === null) fail("PROJECTION_RESULT_INVALID");
  if (hasExactKeys(result, ["kind"]) && result.kind === "missing") return null;
  if (!hasExactKeys(result, ["kind", "event"]) || result.kind !== "found") {
    fail("PROJECTION_RESULT_INVALID");
  }

  const event = snapshotPlainRecord(result.event);
  if (event === null
    || !hasExactKeys(event, eventViewKeys)
    || !isIdentifier(event.event_id)
    || event.event_id !== candidate.eventId
    || !isSafeInteger(event.version, 1, maxDatabaseInteger)
    || event.version < candidate.eventVersion) {
    fail("PROJECTION_RESULT_INVALID");
  }

  // Reconstruct the contract-shaped object so extra fields from an injected
  // projector cannot become part of the public list response.
  const projected: Record<string, unknown> = {};
  for (const key of eventViewKeys) projected[key] = event[key];
  return projected as unknown as EventView;
}

function validateCursor(value: unknown): PublicEventListCursor {
  const cursor = snapshotPlainRecord(value);
  if (cursor === null
    || !hasExactKeys(cursor, ["firstPublishedAt", "eventId"])
    || !isCanonicalTimestamp(cursor.firstPublishedAt)
    || !isIdentifier(cursor.eventId)) {
    fail("INVALID_REQUEST");
  }
  return {
    firstPublishedAt: cursor.firstPublishedAt,
    eventId: cursor.eventId,
  };
}

function isAfterCursor(candidate: ValidatedCandidate, cursor: PublicEventListCursor): boolean {
  return candidate.firstPublishedAt < cursor.firstPublishedAt
    || (candidate.firstPublishedAt === cursor.firstPublishedAt
      && compareStrings(candidate.eventId, cursor.eventId) > 0);
}

function isNotAfterCandidate(previous: ValidatedCandidate, current: ValidatedCandidate): boolean {
  return previous.firstPublishedAt < current.firstPublishedAt
    || (previous.firstPublishedAt === current.firstPublishedAt
      && compareStrings(previous.eventId, current.eventId) >= 0);
}

function isIdentifier(value: unknown): value is string {
  return typeof value === "string"
    && value.length <= PUBLIC_EVENT_LIST_PROJECTION_LIMITS.eventIdLength
    && identifierPattern.test(value);
}

/** Candidate cursors use canonical UTC timestamps with PostgreSQL microsecond precision. */
function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{6})Z$/u.exec(value);
  if (match === null) return false;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)
    || hour > 23 || minute > 59 || second > 59) {
    return false;
  }
  return true;
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function isSafeInteger(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === "number"
    && Number.isSafeInteger(value)
    && value >= minimum
    && value <= maximum;
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

function hasAllowedKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Reflect.ownKeys(value).every((key) => typeof key === "string" && allowed.includes(key));
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Reflect.ownKeys(value);
  return actual.length === expected.length
    && actual.every((key) => typeof key === "string" && expected.includes(key));
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function fail(code: PublicEventListProjectionServiceErrorCode): never {
  throw new PublicEventListProjectionServiceError(code);
}
