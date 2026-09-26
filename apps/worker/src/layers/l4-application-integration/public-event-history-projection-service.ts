import type { HistoryEntry, HistoryPage } from "../../contracts/public-api.js";

export const PUBLIC_EVENT_HISTORY_PROJECTION_LIMITS = Object.freeze({
  defaultPageSize: 50,
  maxPageSize: 100,
  eventIdLength: 128,
});

export interface PublicEventHistoryProjectionReadOptions {
  readonly limit: number;
  /** Null starts at the beginning; a number is the last version already read. */
  readonly afterVersion: number | null;
}

/** Narrow injected port for untrusted, bounded schema 2.0 version candidates. */
export interface PublicEventHistoryCandidateReadPort {
  read(eventId: string, options: PublicEventHistoryProjectionReadOptions): Promise<unknown>;
}

/** Narrow injected port for untrusted, exact-version disclosure metadata. */
export interface PublicEventHistoryDisclosureReadPort {
  read(eventId: string, options: PublicEventHistoryProjectionReadOptions): Promise<unknown>;
}

export interface PublicEventHistoryProjectionService {
  read(eventId: unknown, options?: unknown): Promise<PublicEventHistoryProjectionReadResult>;
}

export type PublicEventHistoryProjectionReadResult =
  | { readonly kind: "found"; readonly page: HistoryPage }
  | { readonly kind: "missing" };

export type PublicEventHistoryProjectionServiceErrorCode =
  | "INVALID_EVENT_ID"
  | "INVALID_PAGE"
  | "CANDIDATE_READ_FAILED"
  | "CANDIDATE_RESULT_INVALID"
  | "DISCLOSURE_READ_FAILED"
  | "DISCLOSURE_UNAVAILABLE"
  | "DISCLOSURE_RESULT_INVALID"
  | "DISCLOSURE_COVERAGE_INCOMPLETE"
  | "PAGE_MISMATCH";

const errorMessages: Record<PublicEventHistoryProjectionServiceErrorCode, string> = {
  INVALID_EVENT_ID: "The event identifier is invalid.",
  INVALID_PAGE: "The public event history page request is invalid.",
  CANDIDATE_READ_FAILED: "The public event history could not be read.",
  CANDIDATE_RESULT_INVALID: "The public event history result is invalid.",
  DISCLOSURE_READ_FAILED: "The public event history review metadata could not be read.",
  DISCLOSURE_UNAVAILABLE: "The public event history review metadata is unavailable.",
  DISCLOSURE_RESULT_INVALID: "The public event history review result is invalid.",
  DISCLOSURE_COVERAGE_INCOMPLETE: "The public event history review coverage is incomplete.",
  PAGE_MISMATCH: "The public event history pages do not match.",
};

/** Fixed errors never include event IDs, summaries, reviewer IDs, or repository details. */
export class PublicEventHistoryProjectionServiceError extends Error {
  constructor(readonly code: PublicEventHistoryProjectionServiceErrorCode) {
    super(errorMessages[code]);
    this.name = "PublicEventHistoryProjectionServiceError";
  }
}

interface ValidatedCandidateVersion {
  readonly eventId: string;
  readonly eventVersion: number;
  readonly publishedAt: string;
}

interface ValidatedCandidatePage {
  readonly versions: readonly ValidatedCandidateVersion[];
  readonly nextAfterVersion: number | null;
}

interface ValidatedDisclosureMetadata {
  readonly changeType: HistoryEntry["change_type"];
  readonly summary: string;
}

interface ValidatedDisclosureVersion {
  readonly eventId: string;
  readonly eventVersion: number;
  readonly metadata: ValidatedDisclosureMetadata;
}

interface ValidatedDisclosurePage {
  readonly versions: readonly ValidatedDisclosureVersion[];
  readonly nextAfterVersion: number | null;
}

interface ValidatedPageRequest {
  readonly limit: number;
  readonly afterVersion: number | null;
}

const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const reviewerIdentifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u;
const maxDatabaseInteger = 2_147_483_647;
const historyChangeTypes = new Set<HistoryEntry["change_type"]>([
  "published",
  "corrected",
  "impact_changed",
  "retracted",
]);
const timestampPattern = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|([+-])(\d{2}):(\d{2}))$/u;
const eventRecordKeys = [
  "schema_version", "trace_id", "record_type", "dataset_kind", "event_id", "version",
  "supersedes_version", "title", "summary", "category", "tags", "lifecycle", "freshness",
  "event_time", "validity", "scope", "claims", "impact_refs", "publication_status",
  "withdrawal_reason", "publication_decision_id", "published_at", "withdrawn_at",
] as const;
const candidatePageKeys = ["eventId", "versions", "nextAfterVersion"] as const;
const candidateVersionKeys = ["datasetKind", "eventId", "eventVersion", "recordJson"] as const;
const disclosurePageKeys = ["eventId", "versions", "coverageComplete", "nextAfterVersion"] as const;
const disclosureVersionKeys = ["datasetKind", "eventId", "eventVersion", "disclosure"] as const;
const disclosureKeys = [
  "datasetKind", "eventId", "eventVersion", "reviewStatus", "changeType", "summary",
  "reviewerId", "reviewedAt",
] as const;

/**
 * Pairs the bounded version reader with exact-version reviewed disclosures,
 * validates both untrusted envelopes, then constructs the unchanged HistoryPage
 * allowlist. This service has no database or HTTP dependencies.
 */
export function createPublicEventHistoryProjectionService(ports: {
  readonly candidates: PublicEventHistoryCandidateReadPort;
  readonly disclosures: PublicEventHistoryDisclosureReadPort;
}): PublicEventHistoryProjectionService {
  return {
    async read(eventId: unknown, options?: unknown): Promise<PublicEventHistoryProjectionReadResult> {
      if (!isIdentifier(eventId)) fail("INVALID_EVENT_ID");

      let request: ValidatedPageRequest;
      try {
        request = validatePageRequest(options);
      } catch (error) {
        if (error instanceof PublicEventHistoryProjectionServiceError) throw error;
        fail("INVALID_PAGE");
      }

      const readOptions = Object.freeze({
        limit: request.limit,
        afterVersion: request.afterVersion,
      });

      let candidateValue: unknown;
      try {
        candidateValue = await ports.candidates.read(eventId, readOptions);
      } catch {
        fail("CANDIDATE_READ_FAILED");
      }

      const candidateResult = parseCandidateResult(candidateValue, eventId, request);
      if (candidateResult.kind === "missing") return { kind: "missing" };

      let disclosureValue: unknown;
      try {
        disclosureValue = await ports.disclosures.read(eventId, readOptions);
      } catch {
        fail("DISCLOSURE_READ_FAILED");
      }

      const disclosurePage = parseDisclosureResult(disclosureValue, eventId, request);
      if (disclosurePage === null) fail("DISCLOSURE_UNAVAILABLE");
      if (disclosurePage.versions.length !== candidateResult.page.versions.length
        || disclosurePage.nextAfterVersion !== candidateResult.page.nextAfterVersion
        || disclosurePage.versions.some((version, index) => {
          const candidate = candidateResult.page.versions[index];
          return candidate === undefined
            || version.eventId !== candidate.eventId
            || version.eventVersion !== candidate.eventVersion;
        })) {
        fail("PAGE_MISMATCH");
      }

      const data: HistoryEntry[] = candidateResult.page.versions.map((candidate, index) => {
        const disclosure = disclosurePage.versions[index]!.metadata;
        return {
          event_id: candidate.eventId,
          version: candidate.eventVersion,
          change_type: disclosure.changeType,
          changed_at: candidate.publishedAt,
          summary: disclosure.summary,
        };
      });

      return {
        kind: "found",
        page: {
          data,
          page: {
            next_cursor: candidateResult.page.nextAfterVersion === null
              ? null
              : String(candidateResult.page.nextAfterVersion),
            cursor_expires_at: null,
          },
        },
      };
    },
  };
}

function validatePageRequest(value: unknown): ValidatedPageRequest {
  if (value === undefined) {
    return { limit: PUBLIC_EVENT_HISTORY_PROJECTION_LIMITS.defaultPageSize, afterVersion: null };
  }
  if (!isRecord(value) || !hasOnlyKeys(value, ["limit", "afterVersion"])) fail("INVALID_PAGE");

  const limit = Object.hasOwn(value, "limit")
    ? value.limit
    : PUBLIC_EVENT_HISTORY_PROJECTION_LIMITS.defaultPageSize;
  if (!isSafeInteger(limit, 1, PUBLIC_EVENT_HISTORY_PROJECTION_LIMITS.maxPageSize)) fail("INVALID_PAGE");

  let afterVersion: number | null = null;
  if (Object.hasOwn(value, "afterVersion")) {
    if (value.afterVersion === null) {
      afterVersion = null;
    } else if (isPositiveDatabaseInteger(value.afterVersion)) {
      afterVersion = value.afterVersion;
    } else {
      fail("INVALID_PAGE");
    }
  }
  return { limit, afterVersion };
}

function parseCandidateResult(
  value: unknown,
  eventId: string,
  request: ValidatedPageRequest,
): { readonly kind: "missing" } | { readonly kind: "found"; readonly page: ValidatedCandidatePage } {
  try {
    if (hasExactKeys(value, ["kind"]) && value.kind === "missing") return { kind: "missing" };
    if (!hasExactKeys(value, ["kind", "page"]) || value.kind !== "found"
      || !hasExactKeys(value.page, candidatePageKeys)
      || value.page.eventId !== eventId
      || !Array.isArray(value.page.versions)) {
      fail("CANDIDATE_RESULT_INVALID");
    }

    const afterVersion = request.afterVersion ?? 0;
    if (value.page.versions.length > request.limit) fail("CANDIDATE_RESULT_INVALID");
    const versions: ValidatedCandidateVersion[] = [];
    let previousVersion = afterVersion;
    for (const candidate of value.page.versions) {
      if (!hasExactKeys(candidate, candidateVersionKeys)
        || candidate.datasetKind !== "live"
        || candidate.eventId !== eventId
        || !isPositiveDatabaseInteger(candidate.eventVersion)
        || candidate.eventVersion <= previousVersion) {
        fail("CANDIDATE_RESULT_INVALID");
      }
      const publishedAt = validatePublishedEventRecord(candidate.recordJson, eventId, candidate.eventVersion);
      versions.push({ eventId, eventVersion: candidate.eventVersion, publishedAt });
      previousVersion = candidate.eventVersion;
    }

    const nextAfterVersion = readNextVersion(
      value.page.nextAfterVersion,
      versions,
      request.limit,
      "CANDIDATE_RESULT_INVALID",
    );
    return { kind: "found", page: { versions, nextAfterVersion } };
  } catch (error) {
    if (error instanceof PublicEventHistoryProjectionServiceError) throw error;
    fail("CANDIDATE_RESULT_INVALID");
  }
}

function parseDisclosureResult(
  value: unknown,
  eventId: string,
  request: ValidatedPageRequest,
): ValidatedDisclosurePage | null {
  try {
    if (hasExactKeys(value, ["kind"]) && value.kind === "missing") return null;
    if (!hasExactKeys(value, ["kind", "page"]) || value.kind !== "found"
      || !hasExactKeys(value.page, disclosurePageKeys)
      || value.page.eventId !== eventId
      || !Array.isArray(value.page.versions)
      || typeof value.page.coverageComplete !== "boolean") {
      fail("DISCLOSURE_RESULT_INVALID");
    }
    if (!value.page.coverageComplete) fail("DISCLOSURE_COVERAGE_INCOMPLETE");

    const afterVersion = request.afterVersion ?? 0;
    if (value.page.versions.length > request.limit) fail("DISCLOSURE_RESULT_INVALID");
    const versions: ValidatedDisclosureVersion[] = [];
    let previousVersion = afterVersion;
    for (const candidate of value.page.versions) {
      if (!hasExactKeys(candidate, disclosureVersionKeys)
        || candidate.datasetKind !== "live"
        || candidate.eventId !== eventId
        || !isPositiveDatabaseInteger(candidate.eventVersion)
        || candidate.eventVersion <= previousVersion) {
        fail("DISCLOSURE_RESULT_INVALID");
      }
      if (candidate.disclosure === null) fail("DISCLOSURE_COVERAGE_INCOMPLETE");
      const metadata = validateDisclosure(candidate.disclosure, eventId, candidate.eventVersion);
      versions.push({ eventId, eventVersion: candidate.eventVersion, metadata });
      previousVersion = candidate.eventVersion;
    }

    const nextAfterVersion = readNextVersion(
      value.page.nextAfterVersion,
      versions,
      request.limit,
      "DISCLOSURE_RESULT_INVALID",
    );
    return { versions, nextAfterVersion };
  } catch (error) {
    if (error instanceof PublicEventHistoryProjectionServiceError) throw error;
    fail("DISCLOSURE_RESULT_INVALID");
  }
}

function validateDisclosure(
  value: unknown,
  eventId: string,
  eventVersion: number,
): ValidatedDisclosureMetadata {
  if (!hasExactKeys(value, disclosureKeys)
    || value.datasetKind !== "live"
    || value.eventId !== eventId
    || value.eventVersion !== eventVersion
    || value.reviewStatus !== "approved"
    || typeof value.changeType !== "string"
    || !historyChangeTypes.has(value.changeType as HistoryEntry["change_type"])
    || !isValidSummary(value.summary)
    || !isReviewerIdentifier(value.reviewerId)
    || !isDateTime(value.reviewedAt)) {
    fail("DISCLOSURE_RESULT_INVALID");
  }
  return {
    changeType: value.changeType as HistoryEntry["change_type"],
    summary: value.summary,
  };
}

function validatePublishedEventRecord(value: unknown, eventId: string, eventVersion: number): string {
  if (!hasExactKeys(value, eventRecordKeys)
    || value.schema_version !== "2.0"
    || value.record_type !== "Event"
    || value.dataset_kind !== "live"
    || !isIdentifier(value.trace_id)
    || value.event_id !== eventId
    || value.version !== eventVersion
    || value.supersedes_version !== (eventVersion === 1 ? null : eventVersion - 1)
    || !isIdentifier(value.publication_decision_id)
    || value.publication_status !== "published"
    || value.withdrawal_reason !== null
    || value.withdrawn_at !== null
    || typeof value.published_at !== "string"
    || !isDateTime(value.published_at)) {
    fail("CANDIDATE_RESULT_INVALID");
  }
  return value.published_at;
}

function readNextVersion(
  value: unknown,
  versions: readonly { readonly eventVersion: number }[],
  limit: number,
  errorCode: "CANDIDATE_RESULT_INVALID" | "DISCLOSURE_RESULT_INVALID",
): number | null {
  if (value === null) {
    return null;
  }
  if (!isPositiveDatabaseInteger(value)
    || versions.length !== limit
    || versions[versions.length - 1]?.eventVersion !== value) {
    fail(errorCode);
  }
  return value;
}

function isIdentifier(value: unknown): value is string {
  return typeof value === "string" && identifierPattern.test(value);
}

function isReviewerIdentifier(value: unknown): value is string {
  return typeof value === "string" && reviewerIdentifierPattern.test(value);
}

function isPositiveDatabaseInteger(value: unknown): value is number {
  return isSafeInteger(value, 1, maxDatabaseInteger);
}

function isSafeInteger(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === "number"
    && Number.isSafeInteger(value)
    && value >= minimum
    && value <= maximum;
}

function isValidSummary(value: unknown): value is string {
  return typeof value === "string"
    && value.length <= 1_000
    && value.trim().length > 0
    && Array.from(value).length <= 500;
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
  const offsetHour = match[9] === undefined ? 0 : Number(match[9]);
  const offsetMinute = match[10] === undefined ? 0 : Number(match[10]);
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  try {
    return Reflect.ownKeys(value).every((key) => typeof key === "string" && keys.includes(key));
  } catch {
    return false;
  }
}

function hasExactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  try {
    const actual = Reflect.ownKeys(value);
    if (actual.length !== keys.length || actual.some((key) => typeof key !== "string")) return false;
    const actualStrings = actual as string[];
    return keys.every((key) => actualStrings.includes(key));
  } catch {
    return false;
  }
}

function fail(code: PublicEventHistoryProjectionServiceErrorCode): never {
  throw new PublicEventHistoryProjectionServiceError(code);
}