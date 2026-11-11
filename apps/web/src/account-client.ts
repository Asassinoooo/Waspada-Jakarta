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
  login(username: string, password: string): Promise<SessionEnvelope>;
  register(username: string, password: string, displayName?: string): Promise<SessionEnvelope>;
  changePassword(currentPassword: string, newPassword: string, csrfToken: string): Promise<SessionEnvelope>;
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
const MAX_USERNAME_LENGTH = 32;
const MAX_PASSWORD_LENGTH = 256;

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

function postHeaders(): Record<string, string> {
  // The marker is the pre-session CSRF guard for login and registration.
  return {
    accept: "application/json",
    "content-type": "application/json",
    "X-Waspada-Request": "1",
  };
}

function requireCredentialFields(username: string, password: string): void {
  if (typeof username !== "string" || username.length < 1 || username.length > MAX_USERNAME_LENGTH) {
    throw new AccountPayloadError();
  }
  if (typeof password !== "string" || password.length < 1 || password.length > MAX_PASSWORD_LENGTH) {
    throw new AccountPayloadError();
  }
}

function errorResponse(status: number): AccountHttpError {
  return new AccountHttpError(status);
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

    async login(username, password) {
      requireCredentialFields(username, password);
      const body = await requestJson("/api/v1/auth/login", {
        method: "POST",
        headers: postHeaders(),
        body: JSON.stringify({ username, password }),
      });
      return parseSessionEnvelope(body);
    },

    async register(username, password, displayName) {
      requireCredentialFields(username, password);
      const payload: { username: string; password: string; display_name?: string } = { username, password };
      if (displayName !== undefined) payload.display_name = displayName;
      const body = await requestJson("/api/v1/auth/register", {
        method: "POST",
        headers: postHeaders(),
        body: JSON.stringify(payload),
      });
      return parseSessionEnvelope(body);
    },

    async changePassword(currentPassword, newPassword, csrfToken) {
      requireCsrfToken(csrfToken);
      requireCredentialFields(currentPassword, newPassword);
      const body = await requestJson("/api/v1/auth/password", {
        method: "POST",
        headers: { ...postHeaders(), "X-CSRF-Token": csrfToken },
        body: JSON.stringify({ current_password: currentPassword, new_password: newPassword }),
      });
      return parseSessionEnvelope(body);
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
