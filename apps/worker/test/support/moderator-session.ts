import { createHash } from "node:crypto";
import type { SqlResult, TransactionalSqlExecutor } from "../../../db/src/sql.js";

/**
 * Synthetic browser sessions for route tests. The real account store and the real moderator
 * authorization run; only the SQL executor is replaced, so no database starts. Synthetic data only.
 */

export type SessionRole = "user" | "moderator" | "admin";

/** The subset of Worker bindings that the account-gated demo routes read. */
export interface AccountTestEnvironment {
  DATASET_MODE?: string;
  SOURCE_PREVIEW_ENABLED?: string;
  AUTH_ENABLED?: string;
  AUTH_APP_ORIGIN?: string;
  SQL_EXECUTOR?: unknown;
}

/** Loopback origin, so the account cookie is the development cookie name. */
export const SESSION_APP_ORIGIN = "http://127.0.0.1:5173";
export const SESSION_COOKIE_NAME = "waspada_session_dev";
const SESSION_TOKEN = "t".repeat(43);
const SESSION_TOKEN_SHA256 = createHash("sha256").update(SESSION_TOKEN).digest("hex");

/**
 * An executor that answers only the session lookup for the synthetic token, with a row for the
 * given role. Every other statement, including the store's SET ROLE and touch update, is empty.
 */
export function sessionExecutor(options: { readonly role: SessionRole; readonly active?: boolean }): TransactionalSqlExecutor {
  const hourMs = 60 * 60_000;
  const now = Date.now();
  const row = {
    account_id: "7f1d0c5e-2b1a-4c6e-9d3f-5a8b7c6d5e4f",
    display_name: "Sesi uji",
    email: null,
    role: options.role,
    active: options.active ?? true,
    onboarding_version: 1,
    onboarding_completed_at: new Date(now - 24 * hourMs).toISOString(),
    version: 1,
    channel: "web",
    csrf_token: "c".repeat(43),
    session_revoked_at: null,
    idle_expires_at: new Date(now + hourMs / 2).toISOString(),
    absolute_expires_at: new Date(now + 8 * hourMs).toISOString(),
  };
  const executor: TransactionalSqlExecutor = {
    query: async <Result extends object = Record<string, unknown>>(
      statement: string,
      parameters?: readonly unknown[],
    ): Promise<SqlResult<Result>> => {
      const isSessionLookup = statement.includes("FROM waspada.account_sessions AS s")
        && parameters?.[1] === SESSION_TOKEN_SHA256;
      return { rows: isSessionLookup ? [row as unknown as Result] : [] };
    },
    execute: async () => {},
    transaction: async (work) => work(executor),
  };
  return executor;
}

/** An executor whose every call rejects, as an unreachable account database does. */
export function unreachableExecutor(): TransactionalSqlExecutor {
  const fail = async (): Promise<never> => {
    throw new Error("account database unavailable");
  };
  return { query: fail, execute: fail, transaction: fail };
}

/** The Cookie header value for the synthetic session, for callers that build raw headers. */
export const sessionCookieHeader = `${SESSION_COOKIE_NAME}=${SESSION_TOKEN}`;

/** Environment for a demo route. Passing an executor enables accounts on the loopback origin. */
export function accountEnvironment(
  base: { readonly DATASET_MODE: string; readonly SOURCE_PREVIEW_ENABLED?: string },
  executor?: TransactionalSqlExecutor,
): AccountTestEnvironment {
  if (executor === undefined) return { ...base };
  return { ...base, AUTH_ENABLED: "true", AUTH_APP_ORIGIN: SESSION_APP_ORIGIN, SQL_EXECUTOR: executor };
}

/** A request that carries the synthetic session cookie, or none for an anonymous caller. */
export function requestWithSession(url: string, withCookie: boolean): Request {
  if (!withCookie) return new Request(url);
  return new Request(url, { headers: { cookie: `${SESSION_COOKIE_NAME}=${SESSION_TOKEN}` } });
}
