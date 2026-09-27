import { createPublicEventUpdatesReader } from "../../../db/src/public-event-updates.js";
import { withPostgresSqlExecutor } from "../../../db/src/postgres-sql-executor.js";
import type { SqlExecutor } from "../../../db/src/sql.js";
import {
  createPublicEventUpdatesCursorCodec,
  PUBLIC_EVENT_UPDATES_CURSOR_TOKEN_MAX_LENGTH,
  PublicEventUpdatesCursorCodecError,
} from "../layers/l4-application-integration/public-event-updates-cursor.js";
import {
  createPublicEventUpdatesService,
  PUBLIC_EVENT_UPDATES_SERVICE_LIMITS,
  PublicEventUpdatesServiceError,
  type PublicEventUpdatesPage,
} from "../layers/l4-application-integration/public-event-updates-service.js";
import { isValidHyperdriveConnectionString } from "./public-event-list-runtime.js";

const cursorSecretPattern = /^[a-fA-F0-9]{64}$/u;
const transactionStart = "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY";
const requestKeys = ["cursor", "limit"] as const;
const canonicalLimitPattern = /^(?:[1-9]|[1-9][0-9]|100)$/u;

export interface PublicEventUpdatesRequest {
  readonly cursor: string | undefined;
  readonly limit: number;
}

export interface PublicEventUpdatesRuntimeConfiguration {
  readonly datasetMode?: string;
  readonly connectionString?: string;
  readonly cursorHmacKeyHex?: string;
}

export type PublicEventUpdatesSqlExecutorRunner = <Result>(
  connectionString: string,
  operation: (executor: SqlExecutor) => Promise<Result>,
) => Promise<Result>;

export interface PublicEventUpdatesRuntimeDependencies {
  /** Test seam for a fake SQL runner; production uses the PostgreSQL adapter. */
  readonly withSqlExecutor?: PublicEventUpdatesSqlExecutorRunner;
  readonly now?: () => number;
}

export interface PublicEventUpdatesRuntime {
  read(request: unknown): Promise<PublicEventUpdatesPage>;
}

type PublicEventUpdatesTransactionResult =
  | { readonly kind: "success"; readonly page: PublicEventUpdatesPage }
  | {
      readonly kind: "request_error";
      readonly code: "INVALID_REQUEST" | "CURSOR_RESTART_REQUIRED";
    };

export type PublicEventUpdatesRuntimeErrorCode =
  | "INVALID_REQUEST"
  | "CURSOR_RESTART_REQUIRED"
  | "READ_FAILED";

const errorMessages: Record<PublicEventUpdatesRuntimeErrorCode, string> = {
  INVALID_REQUEST: "The public update request is invalid.",
  CURSOR_RESTART_REQUIRED: "Update polling must restart from the current public snapshot.",
  READ_FAILED: "The public read could not be completed.",
};

/** Stable errors omit query data, cursors, SQL, and provider diagnostics. */
export class PublicEventUpdatesRuntimeError extends Error {
  constructor(readonly code: PublicEventUpdatesRuntimeErrorCode) {
    super(errorMessages[code]);
    this.name = "PublicEventUpdatesRuntimeError";
  }
}

/** Parses the exact documented query shape before any database work begins. */
export function readPublicEventUpdatesQuery(value: unknown): PublicEventUpdatesRequest {
  if (!(value instanceof URLSearchParams)) fail("INVALID_REQUEST");

  let cursor: string | undefined;
  let rawLimit: string | undefined;
  const seen = new Set<string>();
  for (const [key, entryValue] of value) {
    if ((key !== "cursor" && key !== "limit") || seen.has(key)) fail("INVALID_REQUEST");
    seen.add(key);

    if (key === "cursor") {
      if (entryValue.length === 0 || entryValue.length > PUBLIC_EVENT_UPDATES_CURSOR_TOKEN_MAX_LENGTH) {
        fail("INVALID_REQUEST");
      }
      cursor = entryValue;
    } else {
      rawLimit = entryValue;
    }
  }

  const limit = rawLimit === undefined
    ? PUBLIC_EVENT_UPDATES_SERVICE_LIMITS.defaultPageSize
    : parseLimit(rawLimit);
  return Object.freeze({ cursor, limit });
}

/**
 * Creates the exact-live runtime only with the existing connection and cursor
 * secret. The SQL client stays lazy until request parsing and cursor checks pass.
 */
export async function createPublicEventUpdatesRuntime(
  configuration: PublicEventUpdatesRuntimeConfiguration,
  dependencies: PublicEventUpdatesRuntimeDependencies = {},
): Promise<PublicEventUpdatesRuntime | undefined> {
  if (configuration.datasetMode !== "live"
    || !isValidHyperdriveConnectionString(configuration.connectionString)
    || !isValidCursorSecret(configuration.cursorHmacKeyHex)) {
    return undefined;
  }

  let key: CryptoKey;
  try {
    key = await globalThis.crypto.subtle.importKey(
      "raw",
      decodeHex(configuration.cursorHmacKeyHex),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign", "verify"],
    );
  } catch {
    return undefined;
  }

  const connectionString = configuration.connectionString;
  const withSqlExecutor = dependencies.withSqlExecutor ?? withPostgresSqlExecutor;
  const now = dependencies.now ?? Date.now;

  return {
    async read(value: unknown): Promise<PublicEventUpdatesPage> {
      const request = validateRequest(value);
      const requestClock = snapshotClock(now);
      const cursorCodec = createPublicEventUpdatesCursorCodec({ key, now: requestClock });
      if (request.cursor !== undefined) {
        try {
          await cursorCodec.decode(request.cursor);
        } catch (error) {
          if (error instanceof PublicEventUpdatesCursorCodecError
            && error.code === "CURSOR_EXPIRED") {
            fail("CURSOR_RESTART_REQUIRED");
          }
          fail("INVALID_REQUEST");
        }
      }

      try {
        const result = await withSqlExecutor(connectionString, (executor) =>
          readPublicEventUpdatesInTransaction(executor, request, key, requestClock));
        if (result.kind === "request_error") fail(result.code);
        return result.page;
      } catch (error) {
        if (error instanceof PublicEventUpdatesRuntimeError) throw error;
        throw new PublicEventUpdatesRuntimeError("READ_FAILED");
      }
    },
  };
}

async function readPublicEventUpdatesInTransaction(
  executor: SqlExecutor,
  request: PublicEventUpdatesRequest,
  key: CryptoKey,
  now: () => number,
): Promise<PublicEventUpdatesTransactionResult> {
  let transactionStarted = false;
  try {
    await executor.query(transactionStart);
    transactionStarted = true;

    const reader = createPublicEventUpdatesReader(executor);
    const service = createPublicEventUpdatesService({ reader, key, now });
    const page = await service.read(request);
    await executor.query("COMMIT");
    transactionStarted = false;
    return { kind: "success", page };
  } catch (error) {
    if (transactionStarted) {
      try {
        await executor.query("ROLLBACK");
      } catch {
        throw new PublicEventUpdatesRuntimeError("READ_FAILED");
      }
    }

    if (error instanceof PublicEventUpdatesServiceError) {
      if (error.code === "INVALID_REQUEST") {
        return { kind: "request_error", code: "INVALID_REQUEST" };
      }
      if (error.code === "CURSOR_RESTART_REQUIRED") {
        return { kind: "request_error", code: "CURSOR_RESTART_REQUIRED" };
      }
    }
    throw new PublicEventUpdatesRuntimeError("READ_FAILED");
  }
}

function validateRequest(value: unknown): PublicEventUpdatesRequest {
  if (value instanceof URLSearchParams) return readPublicEventUpdatesQuery(value);
  if (!isPlainRecord(value) || !hasExactKeys(value, requestKeys)) fail("INVALID_REQUEST");

  const cursor = value.cursor;
  if (cursor !== undefined && (typeof cursor !== "string"
    || cursor.length === 0
    || cursor.length > PUBLIC_EVENT_UPDATES_CURSOR_TOKEN_MAX_LENGTH)) {
    fail("INVALID_REQUEST");
  }
  const limit = value.limit === undefined
    ? PUBLIC_EVENT_UPDATES_SERVICE_LIMITS.defaultPageSize
    : value.limit;
  if (typeof limit !== "number"
    || !Number.isSafeInteger(limit)
    || limit < 1
    || limit > PUBLIC_EVENT_UPDATES_SERVICE_LIMITS.maxPageSize) {
    fail("INVALID_REQUEST");
  }
  return Object.freeze({ cursor, limit });
}

function snapshotClock(now: () => number): () => number {
  let timestamp: number;
  try {
    timestamp = now();
  } catch {
    fail("READ_FAILED");
  }
  if (!Number.isSafeInteger(timestamp)) fail("READ_FAILED");
  return () => timestamp;
}

function parseLimit(value: string): number {
  if (!canonicalLimitPattern.test(value)) fail("INVALID_REQUEST");
  const limit = Number(value);
  if (!Number.isSafeInteger(limit)
    || limit < 1
    || limit > PUBLIC_EVENT_UPDATES_SERVICE_LIMITS.maxPageSize) {
    fail("INVALID_REQUEST");
  }
  return limit;
}

function isValidCursorSecret(value: unknown): value is string {
  return typeof value === "string" && cursorSecretPattern.test(value);
}

function decodeHex(value: string): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(new ArrayBuffer(value.length / 2));
  for (let offset = 0; offset < value.length; offset += 2) {
    bytes[offset / 2] = Number.parseInt(value.slice(offset, offset + 2), 16);
  }
  return bytes;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return actual.length === sortedExpected.length
    && actual.every((key, index) => key === sortedExpected[index]);
}

function fail(code: PublicEventUpdatesRuntimeErrorCode): never {
  throw new PublicEventUpdatesRuntimeError(code);
}
