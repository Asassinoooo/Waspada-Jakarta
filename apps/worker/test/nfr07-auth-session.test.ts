/**
 * NFR-07 (privacy and security, C): browser writes need the exact Origin and the session CSRF token, a self-registered
 * (role user) session cannot reach moderation or admin routes, an expired session is anonymous, and the session cookie
 * is host-only, Secure, HttpOnly and SameSite=Strict, including when it is cleared. The real account store runs over a
 * fake SQL executor, so no database or network starts.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { createAccountApi } from "../src/accounts/api.js";
import { createAccountStore } from "../../db/src/accounts.js";
import type { SqlResult, TransactionalSqlExecutor } from "../../db/src/sql.js";
import { createModerationApiHandler } from "../src/layers/l4-application-integration/moderation-api.js";

const TOKEN = "t".repeat(43);
const TOKEN_SHA256 = createHash("sha256").update(TOKEN).digest("hex");
const CSRF = "c".repeat(43);
const HOST_ORIGIN = "https://waspada.example";
const LOOPBACK_ORIGIN = "http://127.0.0.1:5173";
const HOST_COOKIE = `__Host-waspada_session=${TOKEN}`;
const DEV_COOKIE = `waspada_session_dev=${TOKEN}`;
const HOUR = 60 * 60_000;

interface SessionRow {
  readonly role: string;
  readonly active: boolean;
  readonly idle_expires_at: string;
  readonly absolute_expires_at: string;
}

/**
 * A fake executor that answers the session lookup for the synthetic token with the given row, and records every
 * statement it receives. Writes are visible to the test through `statements`.
 */
function sessionFake(row: SessionRow, statements: string[]): TransactionalSqlExecutor {
  const executor: TransactionalSqlExecutor = {
    query: async <Result extends object = Record<string, unknown>>(statement: string, parameters?: readonly unknown[]): Promise<SqlResult<Result>> => {
      statements.push(statement);
      const isLookup = statement.includes("FROM waspada.account_sessions AS s") && parameters?.[1] === TOKEN_SHA256;
      const account = {
        account_id: "7f1d0c5e-2b1a-4c6e-9d3f-5a8b7c6d5e4f",
        display_name: "Sesi uji NFR-07",
        email: null,
        role: row.role,
        active: row.active,
        onboarding_version: 1,
        onboarding_completed_at: new Date(Date.now() - 24 * HOUR).toISOString(),
        version: 1,
        channel: "web",
        csrf_token: CSRF,
        session_revoked_at: null,
        idle_expires_at: row.idle_expires_at,
        absolute_expires_at: row.absolute_expires_at,
      };
      return { rows: isLookup ? [account as unknown as Result] : [] };
    },
    execute: async (statement: string) => {
      statements.push(statement);
    },
    transaction: async (work) => work(executor),
  };
  return executor;
}

const liveSession: SessionRow = {
  role: "user",
  active: true,
  idle_expires_at: new Date(Date.now() + HOUR / 2).toISOString(),
  absolute_expires_at: new Date(Date.now() + 8 * HOUR).toISOString(),
};

function accountApi(executor: TransactionalSqlExecutor, cookieMode: "host" | "loopback") {
  return createAccountApi({
    enabled: true,
    datasetMode: "live",
    store: createAccountStore(executor, "live"),
    appOrigin: cookieMode === "host" ? HOST_ORIGIN : LOOPBACK_ORIGIN,
    cookieMode,
  });
}

test("NFR-07 C4: a logout without the session CSRF token is refused before any session write", async () => {
  const statements: string[] = [];
  const api = accountApi(sessionFake(liveSession, statements), "host");
  const response = await api(new Request(`${HOST_ORIGIN}/api/v1/auth/logout`, {
    method: "POST",
    headers: { origin: HOST_ORIGIN, cookie: HOST_COOKIE },
  }));
  assert.equal(response?.status, 403);
  assert.equal(statements.some((statement) => /UPDATE waspada\.account_sessions SET revoked_at/u.test(statement)), false,
    "no revocation statement ran");
});

test("NFR-07 C4: logout with the exact Origin and the session CSRF token is accepted and revokes the session", async () => {
  const statements: string[] = [];
  const api = accountApi(sessionFake(liveSession, statements), "host");
  const response = await api(new Request(`${HOST_ORIGIN}/api/v1/auth/logout`, {
    method: "POST",
    headers: { origin: HOST_ORIGIN, "x-csrf-token": CSRF, cookie: HOST_COOKIE },
  }));
  assert.equal(response?.status, 204, "the control request is accepted");
  assert.equal(statements.some((statement) => /UPDATE waspada\.account_sessions SET revoked_at/u.test(statement)), true);
});

test("NFR-07 C4: an Origin that is not the exact app origin is refused, and a missing Origin is refused", async () => {
  const badOrigins = [
    "http://waspada.example",
    "https://waspada.example:8443",
    "https://waspada.example.evil.test",
    "https://WASPADA.example.invalid",
    "null",
  ];
  for (const origin of badOrigins) {
    const statements: string[] = [];
    const api = accountApi(sessionFake(liveSession, statements), "host");
    const response = await api(new Request(`${HOST_ORIGIN}/api/v1/auth/logout`, {
      method: "POST",
      headers: { origin, "x-csrf-token": CSRF, cookie: HOST_COOKIE },
    }));
    assert.equal(response?.status, 403, `refused for Origin ${origin}`);
    assert.equal(statements.some((statement) => /revoked_at = \$3/u.test(statement)), false, `no write for ${origin}`);
  }
  const noOrigin = accountApi(sessionFake(liveSession, []), "host");
  const response = await noOrigin(new Request(`${HOST_ORIGIN}/api/v1/auth/logout`, {
    method: "POST",
    headers: { "x-csrf-token": CSRF, cookie: HOST_COOKIE },
  }));
  assert.equal(response?.status, 403, "a missing Origin is refused");
});

test("NFR-07 C5: the cleared session cookie keeps HttpOnly, Secure and SameSite=Strict in host mode", async () => {
  const api = accountApi(sessionFake(liveSession, []), "host");
  const response = await api(new Request(`${HOST_ORIGIN}/api/v1/auth/logout`, {
    method: "POST",
    headers: { origin: HOST_ORIGIN, "x-csrf-token": CSRF, cookie: HOST_COOKIE },
  }));
  assert.equal(response?.headers.get("set-cookie"), "__Host-waspada_session=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict; Secure");
});

test("NFR-07 C2: an expired session is anonymous on the account route and refused on moderation", async () => {
  const expired: SessionRow = {
    role: "moderator",
    active: true,
    idle_expires_at: new Date(Date.now() - 60_000).toISOString(),
    absolute_expires_at: new Date(Date.now() + 8 * HOUR).toISOString(),
  };
  const api = accountApi(sessionFake(expired, []), "host");
  const session = await api(new Request(`${HOST_ORIGIN}/api/v1/auth/session`, { headers: { cookie: HOST_COOKIE } }));
  assert.equal(((await session?.json()) as { status: string }).status, "anonymous", "the account route reads the session as anonymous");

  const moderation = createModerationApiHandler({
    datasetScope: "live",
    accountStore: createAccountStore(sessionFake(expired, []), "live"),
    cookieMode: "host",
  });
  const refused = await moderation(new Request(`${HOST_ORIGIN}/api/v1/moderation/proposals`, { headers: { cookie: HOST_COOKIE } }));
  assert.equal(refused?.status, 401, "an expired moderator session is not a principal");
});

test("NFR-07 C3: a self-registered (role user) session gets 403 on moderation and on the admin account list, while a moderator session passes", async () => {
  const userStore = createAccountStore(sessionFake({ ...liveSession, role: "user" }, []), "live");
  const moderation = createModerationApiHandler({
    datasetScope: "live",
    accountStore: userStore,
    cookieMode: "loopback",
  });
  const denied = await moderation(new Request(`${LOOPBACK_ORIGIN}/api/v1/moderation/proposals`, { headers: { cookie: DEV_COOKIE } }));
  assert.equal(denied?.status, 403, "role user cannot read moderation");

  const admin = accountApi(sessionFake({ ...liveSession, role: "user" }, []), "loopback");
  const list = await admin(new Request(`${LOOPBACK_ORIGIN}/api/v1/account/users`, { headers: { cookie: DEV_COOKIE } }));
  assert.equal(list?.status, 403, "role user cannot read the admin account list");

  const moderator = createModerationApiHandler({
    datasetScope: "live",
    accountStore: createAccountStore(sessionFake({ ...liveSession, role: "moderator" }, []), "live"),
    cookieMode: "loopback",
  });
  const allowed = await moderator(new Request(`${LOOPBACK_ORIGIN}/api/v1/moderation/proposals`, { headers: { cookie: DEV_COOKIE } }));
  assert.notEqual(allowed?.status, 403, "the control moderator is not refused by role");
  assert.notEqual(allowed?.status, 401, "the control moderator session is accepted");
});
