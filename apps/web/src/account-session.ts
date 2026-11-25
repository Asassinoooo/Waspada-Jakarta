// PERF-09b: the account session read and the parsers it needs. The header (AppShell) reads the session on every page, so
// this module is the account code that the first chunk carries. The rest of the account client (sign-in, users, password)
// stays in account-client.ts and loads with the account pages.
import type { AccountRole, AccountUser, SessionEnvelope } from "@waspada/worker/account-contracts";

export class AccountHttpError extends Error {
  constructor(readonly status: number) {
    super("Account request failed with status " + status);
    this.name = "AccountHttpError";
  }
}

export class AccountPayloadError extends Error {
  constructor() {
    super("Account response could not be safely read");
    this.name = "AccountPayloadError";
  }
}

export type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export const ACCOUNT_VERSION = "account-v1";
export const ACCOUNT_ROLES: readonly AccountRole[] = ["user", "moderator", "admin"];
export const MAX_SESSION_BYTES = 16 * 1024;
export const MAX_ID_LENGTH = 200;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

export function isRole(value: unknown): value is AccountRole {
  return typeof value === "string" && ACCOUNT_ROLES.includes(value as AccountRole);
}

export function isInstant(value: unknown): value is string {
  return typeof value === "string"
    && value.length <= 100
    && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/u.test(value)
    && !Number.isNaN(Date.parse(value));
}

export function parseAccountUser(value: unknown): AccountUser {
  if (!isRecord(value) || !hasExactKeys(value, [
    "id",
    "display_name",
    "email",
    "role",
    "active",
    "onboarding_version",
    "onboarding_completed_at",
    "version",
  ])) {
    throw new AccountPayloadError();
  }

  if (
    typeof value.id !== "string" || value.id.length < 1 || value.id.length > MAX_ID_LENGTH ||
    typeof value.display_name !== "string" || value.display_name.length < 1 || value.display_name.length > 200 ||
    !(value.email === null || (typeof value.email === "string" && value.email.length >= 3 && value.email.length <= 320 && value.email.includes("@"))) ||
    !isRole(value.role) ||
    typeof value.active !== "boolean" ||
    (value.onboarding_version !== 0 && value.onboarding_version !== 1) ||
    !(value.onboarding_completed_at === null || isInstant(value.onboarding_completed_at)) ||
    !Number.isSafeInteger(value.version) || (value.version as number) < 1 ||
    (value.onboarding_version === 0 && value.onboarding_completed_at !== null) ||
    (value.onboarding_version === 1 && value.onboarding_completed_at === null)
  ) {
    throw new AccountPayloadError();
  }

  return value as unknown as AccountUser;
}

export function parseSessionEnvelope(value: unknown): SessionEnvelope {
  if (!isRecord(value) || !hasExactKeys(value, [
    "version",
    "status",
    "password_login_available",
    "registration_available",
    "csrf_token",
    "user",
  ])) {
    throw new AccountPayloadError();
  }

  if (
    value.version !== ACCOUNT_VERSION ||
    (value.status !== "anonymous" && value.status !== "authenticated") ||
    typeof value.password_login_available !== "boolean" ||
    typeof value.registration_available !== "boolean" ||
    !(value.csrf_token === null || (typeof value.csrf_token === "string" && value.csrf_token.length >= 16 && value.csrf_token.length <= 512))
  ) {
    throw new AccountPayloadError();
  }

  if (value.status === "anonymous") {
    if (value.user !== null || value.csrf_token !== null) throw new AccountPayloadError();
    return value as unknown as SessionEnvelope;
  }

  if (value.user === null || value.csrf_token === null) throw new AccountPayloadError();
  parseAccountUser(value.user);
  return value as unknown as SessionEnvelope;
}

export async function readBoundedJson(response: Response, maximumBytes: number): Promise<unknown> {
  const contentType = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
  if (contentType !== "application/json") throw new AccountPayloadError();

  const contentLength = response.headers.get("content-length");
  if (contentLength !== null && /^\d+$/u.test(contentLength) && Number(contentLength) > maximumBytes) {
    throw new AccountPayloadError();
  }

  if (!response.body) throw new AccountPayloadError();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      totalBytes += value.byteLength;
      if (totalBytes > maximumBytes) {
        await reader.cancel().catch(() => {});
        throw new AccountPayloadError();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch {
    throw new AccountPayloadError();
  }
}

export function errorResponse(status: number): AccountHttpError {
  return new AccountHttpError(status);
}

/** One JSON request to an account route. Every call uses the same credentials, cache and redirect rules. */
export async function requestAccountJson(fetcher: FetchLike, path: string, init: RequestInit, maximumBytes = MAX_SESSION_BYTES): Promise<unknown> {
  const response = await fetcher(path, {
    ...init,
    credentials: "same-origin",
    cache: "no-store",
    redirect: "error",
  });
  if (!response.ok) throw errorResponse(response.status);
  return readBoundedJson(response, maximumBytes);
}

/** GET /api/v1/auth/session through the given fetch. */
export async function readAccountSession(fetcher: FetchLike, signal?: AbortSignal): Promise<SessionEnvelope> {
  const body = await requestAccountJson(fetcher, "/api/v1/auth/session", {
    method: "GET",
    headers: { accept: "application/json" },
    ...(signal === undefined ? {} : { signal }),
  });
  return parseSessionEnvelope(body);
}

// The same global fetch that accountClient uses (its default), captured when this module loads.
const defaultFetcher: FetchLike = fetch;

/** The current session, for the header, the route shell and the access gate. */
export function getAccountSession(signal?: AbortSignal): Promise<SessionEnvelope> {
  return readAccountSession(defaultFetcher, signal);
}
