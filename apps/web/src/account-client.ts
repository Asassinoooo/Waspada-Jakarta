import type {
  AccountRole,
  AccountUser,
  AccountUserPage,
  AccountUserUpdate,
  SessionEnvelope,
} from "@waspada/worker/account-contracts";

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

export interface AccountClient {
  getSession(signal?: AbortSignal): Promise<SessionEnvelope>;
  startGoogleLogin(returnTo: AccountReturnTarget): Promise<string>;
  completeOnboarding(csrfToken: string): Promise<SessionEnvelope>;
  logout(csrfToken: string): Promise<void>;
  listUsers(options?: { limit?: number; after?: string; signal?: AbortSignal }): Promise<AccountUserPage>;
  updateUser(id: string, update: AccountUserUpdate, csrfToken: string): Promise<AccountUser>;
}

export type AccountReturnTarget = "#akun" | "#mulai" | "#admin" | "#tinjau-bukti";

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

const ACCOUNT_VERSION = "account-v1";
const ACCOUNT_ROLES: readonly AccountRole[] = ["user", "moderator", "admin"];
const MAX_SESSION_BYTES = 16 * 1024;
const MAX_USER_PAGE_BYTES = 128 * 1024;
const MAX_CURSOR_LENGTH = 2_048;
const MAX_ID_LENGTH = 200;
const MAX_REASON_LENGTH = 500;
const LOCAL_DEMO_ORIGINS = new Set([
  "http://127.0.0.1:5173",
  "http://localhost:5173",
]);
const LOCAL_DEMO_PATH = "/api/v1/auth/demo/consent";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function isRole(value: unknown): value is AccountRole {
  return typeof value === "string" && ACCOUNT_ROLES.includes(value as AccountRole);
}

function isInstant(value: unknown): value is string {
  return typeof value === "string"
    && value.length <= 100
    && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/u.test(value)
    && !Number.isNaN(Date.parse(value));
}

function parseAccountUser(value: unknown): AccountUser {
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
    typeof value.email !== "string" || value.email.length < 3 || value.email.length > 254 || !value.email.includes("@") ||
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
    "google_login_available",
    "native_login_available",
    "csrf_token",
    "user",
  ])) {
    throw new AccountPayloadError();
  }

  if (
    value.version !== ACCOUNT_VERSION ||
    (value.status !== "anonymous" && value.status !== "authenticated") ||
    typeof value.google_login_available !== "boolean" ||
    typeof value.native_login_available !== "boolean" ||
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

function parseUserPage(value: unknown): AccountUserPage {
  if (!isRecord(value) || !hasExactKeys(value, ["data", "next_cursor"]) || !Array.isArray(value.data) || value.data.length > 50) {
    throw new AccountPayloadError();
  }
  if (!(value.next_cursor === null || (typeof value.next_cursor === "string" && value.next_cursor.length >= 1 && value.next_cursor.length <= MAX_CURSOR_LENGTH))) {
    throw new AccountPayloadError();
  }

  const data = value.data.map(parseAccountUser);
  const ids = new Set(data.map((user) => user.id));
  if (ids.size !== data.length) throw new AccountPayloadError();
  return { data, next_cursor: value.next_cursor as string | null };
}

async function readBoundedJson(response: Response, maximumBytes: number): Promise<unknown> {
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

function requireCsrfToken(token: string): void {
  if (typeof token !== "string" || token.length < 16 || token.length > 512) throw new AccountPayloadError();
}

function errorResponse(status: number): AccountHttpError {
  return new AccountHttpError(status);
}

/**
 * Validate an authorization target returned by the server. The local consent
 * endpoint exists only for the explicitly synthetic Vite development harness;
 * callers in the application pass the actual build and browser environment.
 */
export function isExactLoopbackDemoConsentUrl(value: string, currentOrigin: string | null): boolean {
  if (currentOrigin === null || !LOCAL_DEMO_ORIGINS.has(currentOrigin)) return false;

  let target: URL;
  try {
    target = new URL(value);
  } catch {
    return false;
  }

  const exactPrefix = currentOrigin + LOCAL_DEMO_PATH + "?state=";
  if (
    target.origin !== currentOrigin ||
    target.pathname !== LOCAL_DEMO_PATH ||
    target.username !== "" ||
    target.password !== "" ||
    target.hash !== "" ||
    !value.startsWith(exactPrefix) ||
    target.search.slice(1).split("&").length !== 1
  ) {
    return false;
  }

  const state = target.searchParams.get("state");
  return target.searchParams.size === 1 && state !== null && state.length > 0 && state.length <= 512 && !/[\u0000-\u001f\u007f]/u.test(state);
}

function isAllowedAuthorizationUrl(value: string): boolean {
  let target: URL;
  try {
    target = new URL(value);
  } catch {
    return false;
  }

  if (
    target.protocol === "https:" &&
    target.hostname === "accounts.google.com" &&
    target.username === "" &&
    target.password === "" &&
    target.port === ""
  ) {
    return true;
  }

  if (import.meta.env?.DEV === true) {
    const currentOrigin = typeof window === "undefined" ? null : window.location.origin;
    if (isExactLoopbackDemoConsentUrl(value, currentOrigin)) return true;
  }
  return false;
}

export function createAccountClient(fetcher: FetchLike = fetch): AccountClient {
  async function requestJson(path: string, init: RequestInit, maximumBytes = MAX_SESSION_BYTES): Promise<unknown> {
    const response = await fetcher(path, {
      ...init,
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
    });
    if (!response.ok) throw errorResponse(response.status);
    return readBoundedJson(response, maximumBytes);
  }

  return {
    async getSession(signal) {
      const body = await requestJson("/api/v1/auth/session", {
        method: "GET",
        headers: { accept: "application/json" },
        ...(signal === undefined ? {} : { signal }),
      });
      return parseSessionEnvelope(body);
    },

    async startGoogleLogin(returnTo) {
      if (!["#akun", "#mulai", "#admin", "#tinjau-bukti"].includes(returnTo)) throw new AccountPayloadError();
      const body = await requestJson("/api/v1/auth/google/start", {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          "X-Waspada-Request": "1",
        },
        body: JSON.stringify({ return_to: returnTo }),
      });
      if (!isRecord(body) || !hasExactKeys(body, ["authorization_url"]) || typeof body.authorization_url !== "string" || body.authorization_url.length > 4_096) {
        throw new AccountPayloadError();
      }

      if (!isAllowedAuthorizationUrl(body.authorization_url)) {
        throw new AccountPayloadError();
      }
      return new URL(body.authorization_url).toString();
    },

    async completeOnboarding(csrfToken) {
      requireCsrfToken(csrfToken);
      const body = await requestJson("/api/v1/account/onboarding", {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          "X-CSRF-Token": csrfToken,
        },
        body: JSON.stringify({ version: 1 }),
      });
      return parseSessionEnvelope(body);
    },

    async logout(csrfToken) {
      requireCsrfToken(csrfToken);
      const response = await fetcher("/api/v1/auth/logout", {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        redirect: "error",
        headers: {
          accept: "application/json",
          "X-CSRF-Token": csrfToken,
        },
      });
      if (response.status !== 204) throw errorResponse(response.status);
    },

    async listUsers(options = {}) {
      const limit = options.limit ?? 20;
      if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new AccountPayloadError();
      if (options.after !== undefined && (options.after.length < 1 || options.after.length > MAX_CURSOR_LENGTH)) {
        throw new AccountPayloadError();
      }
      const query = new URLSearchParams({ limit: String(limit) });
      if (options.after !== undefined) query.set("after", options.after);
      const body = await requestJson("/api/v1/account/users?" + query.toString(), {
        method: "GET",
        headers: { accept: "application/json" },
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      }, MAX_USER_PAGE_BYTES);
      return parseUserPage(body);
    },

    async updateUser(id, update, csrfToken) {
      requireCsrfToken(csrfToken);
      if (
        typeof id !== "string" || id.length < 1 || id.length > MAX_ID_LENGTH ||
        !isRole(update.role) || typeof update.active !== "boolean" ||
        !Number.isSafeInteger(update.expected_version) || update.expected_version < 1 ||
        typeof update.reason !== "string" || update.reason.trim().length < 1 || update.reason.length > MAX_REASON_LENGTH
      ) {
        throw new AccountPayloadError();
      }

      let encodedId: string;
      try {
        encodedId = encodeURIComponent(id);
      } catch {
        throw new AccountPayloadError();
      }
      const body = await requestJson("/api/v1/account/users/" + encodedId, {
        method: "PATCH",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          "X-CSRF-Token": csrfToken,
        },
        body: JSON.stringify({
          role: update.role,
          active: update.active,
          expected_version: update.expected_version,
          reason: update.reason,
        }),
      });
      return parseAccountUser(body);
    },
  };
}

export const accountClient = createAccountClient();
