import {
  createPublicBriefingCandidateRepository,
  type PublicBriefingCandidate,
} from "../../../db/src/public-briefing-candidates.js";
import { createPublicEventSnapshotRepository } from "../../../db/src/public-event-snapshot.js";
import { createPublicProjectionLookupRepository } from "../../../db/src/public-projection-lookups.js";
import { withPostgresSqlExecutor } from "../../../db/src/postgres-sql-executor.js";
import type { SqlExecutor } from "../../../db/src/sql.js";
import type { BriefingRequest, BriefingResponse, EventView } from "../contracts/public-api.js";
import {
  projectPublicBriefing,
  PublicBriefingProjectionError,
} from "../layers/l4-application-integration/public-briefing-projection.js";
import {
  createPublicEventProjectionService,
  type PublicEventProjectionReadResult,
} from "../layers/l4-application-integration/public-event-projection-service.js";
import { PUBLIC_EVENT_LIST_PROJECTION_LIMITS } from "../layers/l4-application-integration/public-event-list-projection-service.js";
import { isValidHyperdriveConnectionString } from "./public-event-list-runtime.js";

const maxCandidates = 100;
const candidateIdentifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const canonicalTimestampPattern = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{6})Z$/u;
const transactionStart = "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY";

export interface PublicBriefingRuntimeConfiguration {
  readonly datasetMode?: string;
  readonly connectionString?: string;
}

export type PublicBriefingSqlExecutorRunner = <Result>(
  connectionString: string,
  operation: (executor: SqlExecutor) => Promise<Result>,
) => Promise<Result>;

export interface PublicBriefingRuntimeDependencies {
  /** Test seam for one fake client/executor; production uses the PostgreSQL adapter. */
  readonly withSqlExecutor?: PublicBriefingSqlExecutorRunner;
  readonly now?: () => number;
}

export interface PublicBriefingRuntime {
  read(request: unknown): Promise<BriefingResponse>;
}

export type PublicBriefingRuntimeErrorCode = "INVALID_REQUEST" | "READ_FAILED";

/** Stable errors never include interests, event data, SQL, or driver details. */
export class PublicBriefingRuntimeError extends Error {
  constructor(readonly code: PublicBriefingRuntimeErrorCode) {
    super(code === "INVALID_REQUEST"
      ? "The briefing request is invalid."
      : "The public briefing could not be completed.");
    this.name = "PublicBriefingRuntimeError";
  }
}

/**
 * Builds the exact-live transient briefing runtime only for a valid Hyperdrive
 * connection. A SQL client is opened only when a non-empty request is read.
 */
export function createPublicBriefingRuntime(
  configuration: PublicBriefingRuntimeConfiguration,
  dependencies: PublicBriefingRuntimeDependencies = {},
): PublicBriefingRuntime | undefined {
  if (configuration.datasetMode !== "live"
    || !isValidHyperdriveConnectionString(configuration.connectionString)) {
    return undefined;
  }

  const connectionString = configuration.connectionString;
  const withSqlExecutor = dependencies.withSqlExecutor ?? withPostgresSqlExecutor;
  const now = dependencies.now ?? Date.now;

  return {
    async read(request: unknown): Promise<BriefingResponse> {
      projectRequestWithoutDatabase(request, "2000-01-01T00:00:00.000Z");
      const generatedAt = currentUtcTimestamp(now);
      if (!hasEffectiveInterest(request as BriefingRequest)) {
        return projectRequestWithoutDatabase(request, generatedAt);
      }

      try {
        return await withSqlExecutor(connectionString, (executor) =>
          readBriefingInTransaction(executor, request as BriefingRequest, generatedAt));
      } catch {
        throw new PublicBriefingRuntimeError("READ_FAILED");
      }
    },
  };
}

function projectRequestWithoutDatabase(request: unknown, generatedAt: string): BriefingResponse {
  try {
    return projectPublicBriefing({
      datasetMode: "live",
      request,
      events: [],
      generatedAt,
    });
  } catch (error) {
    if (error instanceof PublicBriefingProjectionError && error.code === "REQUEST_INVALID") {
      throw new PublicBriefingRuntimeError("INVALID_REQUEST");
    }
    throw new PublicBriefingRuntimeError("READ_FAILED");
  }
}

function hasEffectiveInterest(request: BriefingRequest): boolean {
  const interests = request.interests;
  if (interests.categories.length > 0) return true;
  return [
    ...interests.places,
    ...interests.services,
    ...interests.institutions,
    ...interests.audiences,
  ].some((value) => value.normalize("NFC").trim().length > 0);
}

function currentUtcTimestamp(now: () => number): string {
  try {
    const value = new Date(now()).toISOString();
    if (!isDateTime(value)) throw new Error();
    return value;
  } catch {
    throw new PublicBriefingRuntimeError("READ_FAILED");
  }
}

async function readBriefingInTransaction(
  executor: SqlExecutor,
  request: BriefingRequest,
  generatedAt: string,
): Promise<BriefingResponse> {
  try {
    await executor.query(transactionStart);

    const candidates = await createPublicBriefingCandidateRepository(executor).read(request);
    const orderedCandidates = validateCandidates(candidates);
    const eventProjection = createPublicEventProjectionService({
      snapshots: createPublicEventSnapshotRepository(executor),
      lookups: createPublicProjectionLookupRepository(executor),
    });

    const events: EventView[] = [];
    const batchSize = PUBLIC_EVENT_LIST_PROJECTION_LIMITS.maxConcurrentProjections;
    for (let offset = 0; offset < orderedCandidates.length; offset += batchSize) {
      const batch = orderedCandidates.slice(offset, offset + batchSize);
      const settledResults = await Promise.allSettled(
        batch.map((candidate) => eventProjection.read(candidate.eventId)),
      );
      if (settledResults.length !== batch.length
        || settledResults.some((result) => result.status !== "fulfilled")) {
        throw new PublicBriefingRuntimeError("READ_FAILED");
      }
      const results: PublicEventProjectionReadResult[] = settledResults.map((result) => {
        if (result.status !== "fulfilled") throw new PublicBriefingRuntimeError("READ_FAILED");
        return result.value;
      });

      for (let index = 0; index < batch.length; index += 1) {
        const candidate = batch[index];
        const result = results[index];
        if (candidate === undefined || !isExactCandidateProjection(result, candidate)) {
          throw new PublicBriefingRuntimeError("READ_FAILED");
        }
        events.push(result.event);
      }
    }

    const response = projectPublicBriefing({
      datasetMode: "live",
      request,
      events,
      generatedAt,
    });
    await executor.query("COMMIT");
    return response;
  } catch {
    try {
      await executor.query("ROLLBACK");
    } catch {
      // A failed rollback must not expose the original read or transaction error.
    }
    throw new PublicBriefingRuntimeError("READ_FAILED");
  }
}

function validateCandidates(value: unknown): PublicBriefingCandidate[] {
  if (!Array.isArray(value) || value.length > maxCandidates) {
    throw new PublicBriefingRuntimeError("READ_FAILED");
  }

  const candidates: PublicBriefingCandidate[] = [];
  const seenEventIds = new Set<string>();
  let previous: PublicBriefingCandidate | undefined;
  for (const item of value) {
    if (!isPlainRecord(item)
      || !hasExactKeys(item, ["eventId", "eventVersion", "firstPublishedAt"])
      || typeof item.eventId !== "string"
      || item.eventId.length > 128
      || !candidateIdentifierPattern.test(item.eventId)
      || !isPositiveVersion(item.eventVersion)
      || !isCanonicalTimestamp(item.firstPublishedAt)
      || seenEventIds.has(item.eventId)) {
      throw new PublicBriefingRuntimeError("READ_FAILED");
    }

    const candidate: PublicBriefingCandidate = {
      eventId: item.eventId,
      eventVersion: item.eventVersion,
      firstPublishedAt: item.firstPublishedAt,
    };
    if (previous !== undefined
      && (previous.firstPublishedAt < candidate.firstPublishedAt
        || (previous.firstPublishedAt === candidate.firstPublishedAt
          && compareStrings(previous.eventId, candidate.eventId) >= 0))) {
      throw new PublicBriefingRuntimeError("READ_FAILED");
    }
    seenEventIds.add(candidate.eventId);
    candidates.push(candidate);
    previous = candidate;
  }
  return candidates;
}

function isExactCandidateProjection(
  value: unknown,
  candidate: PublicBriefingCandidate,
): value is { readonly kind: "found"; readonly event: EventView } {
  if (!isPlainRecord(value)
    || !hasExactKeys(value, ["kind", "event"])
    || value.kind !== "found"
    || !isPlainRecord(value.event)) {
    return false;
  }
  return value.event.event_id === candidate.eventId
    && value.event.version === candidate.eventVersion;
}

function isDateTime(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?Z$/u.exec(value);
  if (match === null) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)
    || hour > 23 || minute > 59 || second > 59) return false;
  return Number.isFinite(Date.parse(value));
}

function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = canonicalTimestampPattern.exec(value);
  if (match === null) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  return year >= 1 && month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth(year, month)
    && hour <= 23 && minute <= 59 && second <= 59;
}

function isPositiveVersion(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value)
    && value >= 1 && value <= 2_147_483_647;
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return actual.length === sortedExpected.length
    && actual.every((key, index) => key === sortedExpected[index]);
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}