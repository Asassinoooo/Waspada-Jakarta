import type {
  AccountUser,
  AccountUserPage,
  AccountUserUpdate,
  PasswordResetCodeIssue,
  SessionEnvelope,
} from "@waspada/worker/account-contracts";
import {
  AccountPayloadError,
  MAX_ID_LENGTH,
  MAX_SESSION_BYTES,
  errorResponse,
  hasExactKeys,
  isInstant,
  isRecord,
  isRole,
  parseAccountUser,
  parseSessionEnvelope,
  readAccountSession,
  requestAccountJson,
  type FetchLike,
} from "./account-session.js";

export { AccountHttpError, AccountPayloadError, parseSessionEnvelope } from "./account-session.js";

export interface AccountClient {
  getSession(signal?: AbortSignal): Promise<SessionEnvelope>;
  login(username: string, password: string): Promise<SessionEnvelope>;
  register(username: string, password: string, displayName?: string): Promise<SessionEnvelope>;
  changePassword(currentPassword: string, newPassword: string, csrfToken: string): Promise<SessionEnvelope>;
  completeOnboarding(csrfToken: string): Promise<SessionEnvelope>;
  logout(csrfToken: string): Promise<void>;
  listUsers(options?: { limit?: number; after?: string; signal?: AbortSignal }): Promise<AccountUserPage>;
  updateUser(id: string, update: AccountUserUpdate, csrfToken: string): Promise<AccountUser>;
  /** Administrator only. The returned code is shown once and must not be stored or logged. */
  issuePasswordResetCode(accountId: string, csrfToken: string): Promise<PasswordResetCodeIssue>;
  /** Signed-out reset. Resolves on success; the person then signs in with the new password. */
  resetPasswordWithCode(input: { username: string; code: string; newPassword: string }): Promise<void>;
}

export type AccountReturnTarget = "#akun" | "#mulai" | "#admin" | "#tinjau-bukti";

const MAX_USER_PAGE_BYTES = 128 * 1024;
const MAX_CURSOR_LENGTH = 2_048;
const MAX_REASON_LENGTH = 500;
const MAX_USERNAME_LENGTH = 32;
const MAX_PASSWORD_LENGTH = 256;
const MAX_RESET_CODE_LENGTH = 64;
const RESET_CODE_PATTERN = /^[0-9A-HJKMNP-TV-Z]{10}$/u;

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

function parsePasswordResetCodeIssue(value: unknown): PasswordResetCodeIssue {
  if (!isRecord(value) || !hasExactKeys(value, ["code", "expires_at", "username"])) {
    throw new AccountPayloadError();
  }
  if (
    typeof value.code !== "string" || !RESET_CODE_PATTERN.test(value.code) ||
    !isInstant(value.expires_at) ||
    typeof value.username !== "string" || value.username.length < 1 || value.username.length > MAX_USERNAME_LENGTH
  ) {
    throw new AccountPayloadError();
  }
  return { code: value.code, expires_at: value.expires_at, username: value.username };
}

function requireCredentialFields(username: string, password: string): void {
  if (typeof username !== "string" || username.length < 1 || username.length > MAX_USERNAME_LENGTH) {
    throw new AccountPayloadError();
  }
  if (typeof password !== "string" || password.length < 1 || password.length > MAX_PASSWORD_LENGTH) {
    throw new AccountPayloadError();
  }
}

export function createAccountClient(fetcher: FetchLike = fetch): AccountClient {
  async function requestJson(path: string, init: RequestInit, maximumBytes = MAX_SESSION_BYTES): Promise<unknown> {
    return requestAccountJson(fetcher, path, init, maximumBytes);
  }

  return {
    async getSession(signal) {
      return readAccountSession(fetcher, signal);
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

    async issuePasswordResetCode(accountId, csrfToken) {
      requireCsrfToken(csrfToken);
      if (typeof accountId !== "string" || accountId.length < 1 || accountId.length > MAX_ID_LENGTH) {
        throw new AccountPayloadError();
      }
      let encodedId: string;
      try {
        encodedId = encodeURIComponent(accountId);
      } catch {
        throw new AccountPayloadError();
      }
      const body = await requestJson("/api/v1/account/users/" + encodedId + "/password-reset-code", {
        method: "POST",
        headers: {
          accept: "application/json",
          "X-CSRF-Token": csrfToken,
        },
      });
      return parsePasswordResetCodeIssue(body);
    },

    async resetPasswordWithCode({ username, code, newPassword }) {
      requireCredentialFields(username, newPassword);
      if (typeof code !== "string" || code.length < 1 || code.length > MAX_RESET_CODE_LENGTH) {
        throw new AccountPayloadError();
      }
      // A 204 has no body, so this reads the status directly, as logout does.
      const response = await fetcher("/api/v1/auth/password-reset", {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        redirect: "error",
        headers: postHeaders(),
        body: JSON.stringify({ username, code, new_password: newPassword }),
      });
      if (response.status !== 204) throw errorResponse(response.status);
    },
  };
}

export const accountClient = createAccountClient();
