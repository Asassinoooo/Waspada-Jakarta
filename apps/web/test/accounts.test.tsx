import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { AccountUser, AccountUserUpdate, SessionEnvelope } from "@waspada/worker/account-contracts";
import { ACCOUNT_ONBOARDING_STEPS, AccountAccessGate, AccountPage, adminUpdateErrorMessage, hasProtectedShellAccess } from "../src/AccountPages.js";
import {
  AccountHttpError,
  AccountPayloadError,
  createAccountClient,
  isExactLoopbackDemoConsentUrl,
  parseSessionEnvelope,
} from "../src/account-client.js";

const user: AccountUser = {
  id: "account-17",
  display_name: "Ayu Warga",
  email: "ayu@example.test",
  role: "user",
  active: true,
  onboarding_version: 0,
  onboarding_completed_at: null,
  version: 1,
};

const admin: AccountUser = {
  ...user,
  id: "admin-1",
  display_name: "Rani Admin",
  email: "rani@example.test",
  role: "admin",
  onboarding_version: 1,
  onboarding_completed_at: "2026-10-15T04:00:00.000Z",
};

const anonymousSession: SessionEnvelope = {
  version: "account-v1",
  status: "anonymous",
  google_login_available: true,
  native_login_available: false,
  csrf_token: null,
  user: null,
};

const userSession: SessionEnvelope = {
  ...anonymousSession,
  status: "authenticated",
  csrf_token: "csrf-token-with-enough-entropy",
  user,
};

const adminSession: SessionEnvelope = {
  ...userSession,
  user: admin,
};

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function sessionState(session: SessionEnvelope) {
  return session.status === "anonymous"
    ? { status: "anonymous" as const, session }
    : { status: "authenticated" as const, session };
}

test("session parser rejects extra fields, malformed users, and authenticated sessions without web CSRF", () => {
  assert.deepEqual(parseSessionEnvelope(anonymousSession), anonymousSession);
  assert.throws(() => parseSessionEnvelope({ ...anonymousSession, access_token: "should never be returned" }), AccountPayloadError);
  assert.throws(() => parseSessionEnvelope({ ...userSession, csrf_token: null }), AccountPayloadError);
  assert.throws(() => parseSessionEnvelope({ ...userSession, user: { ...user, email: "bad" } }), AccountPayloadError);
  assert.throws(() => parseSessionEnvelope({ ...anonymousSession, csrf_token: "not-anonymous" }), AccountPayloadError);
});

test("session fetch uses same-origin cookies, no-store, and a bounded account DTO", async () => {
  const calls: { path: string; init: RequestInit | undefined }[] = [];
  const client = createAccountClient(async (input, init) => {
    calls.push({ path: String(input), init });
    return jsonResponse(anonymousSession);
  });

  assert.deepEqual(await client.getSession(), anonymousSession);
  assert.equal(calls[0]?.path, "/api/v1/auth/session");
  assert.equal(calls[0]?.init?.method, "GET");
  assert.equal(calls[0]?.init?.credentials, "same-origin");
  assert.equal(calls[0]?.init?.cache, "no-store");
  assert.equal(calls[0]?.init?.redirect, "error");
});

test("Google start is a same-origin POST with its required request marker and a safe provider URL", async () => {
  const calls: { path: string; init: RequestInit | undefined }[] = [];
  const client = createAccountClient(async (input, init) => {
    calls.push({ path: String(input), init });
    return jsonResponse({ authorization_url: "https://accounts.google.com/o/oauth2/v2/auth?state=opaque" });
  });

  assert.equal(await client.startGoogleLogin("#akun"), "https://accounts.google.com/o/oauth2/v2/auth?state=opaque");
  assert.equal(calls[0]?.path, "/api/v1/auth/google/start");
  assert.equal(calls[0]?.init?.method, "POST");
  const headers = new Headers(calls[0]?.init?.headers);
  assert.equal(headers.get("X-Waspada-Request"), "1");
  assert.deepEqual(JSON.parse(String(calls[0]?.init?.body)), { return_to: "#akun" });
  assert.equal(calls[0]?.init?.credentials, "same-origin");
  assert.equal(calls[0]?.init?.cache, "no-store");

  const untrustedClient = createAccountClient(async () => jsonResponse({ authorization_url: "https://attacker.example/collect" }));
  await assert.rejects(untrustedClient.startGoogleLogin("#admin"), AccountPayloadError);
  await assert.rejects(client.startGoogleLogin("#external" as "#akun"), AccountPayloadError);
});

test("synthetic consent URLs are accepted only for the exact development loopback target", () => {
  const localhostConsent = "http://localhost:5173/api/v1/auth/demo/consent?state=opaque-state_1";
  const ipConsent = "http://127.0.0.1:5173/api/v1/auth/demo/consent?state=opaque-state_1";

  assert.equal(isExactLoopbackDemoConsentUrl(localhostConsent, "http://localhost:5173"), true);
  assert.equal(isExactLoopbackDemoConsentUrl(ipConsent, "http://127.0.0.1:5173"), true);

  const rejected: [string, string | null][] = [
    [localhostConsent, "https://waspada.example"],
    [localhostConsent, "http://localhost:5174"],
    [localhostConsent, "http://127.0.0.1:5173"],
    [ipConsent, "http://localhost:5173"],
    ["/api/v1/auth/demo/consent?state=opaque", "http://localhost:5173"],
    ["http://localhost:5173/api/v1/auth/demo/other?state=opaque", "http://localhost:5173"],
    ["http://localhost:5173/api/v1/auth/demo/consent/extra?state=opaque", "http://localhost:5173"],
    ["http://localhost:5173/api/v1/auth/demo/../demo/consent?state=opaque", "http://localhost:5173"],
    ["http://localhost:5173/api/v1/auth/demo/consent?state=opaque&next=%2F", "http://localhost:5173"],
    ["http://localhost:5173/api/v1/auth/demo/consent?state=opaque&state=second", "http://localhost:5173"],
    ["http://localhost:5173/api/v1/auth/demo/consent?state=", "http://localhost:5173"],
    ["http://localhost:5173/api/v1/auth/demo/consent?state=opaque#next", "http://localhost:5173"],
    ["http://127.0.0.1:5174/api/v1/auth/demo/consent?state=opaque", "http://127.0.0.1:5174"],
    ["http://localhost.evil.example:5173/api/v1/auth/demo/consent?state=opaque", "http://localhost:5173"],
    ["https://attacker.example/api/v1/auth/demo/consent?state=opaque", "http://localhost:5173"],
    ["http://accounts.google.com/o/oauth2/v2/auth?state=opaque", null],
  ];

  for (const [target, origin] of rejected) {
    assert.equal(isExactLoopbackDemoConsentUrl(target, origin), false, target);
  }
});

test("account client still rejects demo consent outside the Vite development browser", async () => {
  const client = createAccountClient(async () => jsonResponse({
    authorization_url: "http://localhost:5173/api/v1/auth/demo/consent?state=opaque",
  }));
  await assert.rejects(client.startGoogleLogin("#akun"), AccountPayloadError);
});

test("onboarding completion sends only version 1 and remains safe to retry with the CSRF token", async () => {
  const calls: { path: string; init: RequestInit | undefined }[] = [];
  const completedSession: SessionEnvelope = {
    ...userSession,
    user: { ...user, onboarding_version: 1, onboarding_completed_at: "2026-10-15T04:02:00.000Z" },
  };
  const client = createAccountClient(async (input, init) => {
    calls.push({ path: String(input), init });
    return jsonResponse(completedSession);
  });

  assert.deepEqual(await client.completeOnboarding(String(userSession.csrf_token)), completedSession);
  assert.deepEqual(await client.completeOnboarding(String(userSession.csrf_token)), completedSession);
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.equal(call.path, "/api/v1/account/onboarding");
    assert.equal(call.init?.method, "POST");
    assert.equal(call.init?.credentials, "same-origin");
    assert.equal(call.init?.cache, "no-store");
    assert.equal(new Headers(call.init?.headers).get("X-CSRF-Token"), userSession.csrf_token);
    assert.deepEqual(JSON.parse(String(call.init?.body)), { version: 1 });
  }
});

test("logout uses the CSRF token and accepts only the frozen 204 response", async () => {
  let recorded: RequestInit | undefined;
  const client = createAccountClient(async (_input, init) => {
    recorded = init;
    return new Response(null, { status: 204 });
  });

  await client.logout(String(userSession.csrf_token));
  assert.equal(recorded?.method, "POST");
  assert.equal(recorded?.credentials, "same-origin");
  assert.equal(recorded?.cache, "no-store");
  assert.equal(new Headers(recorded?.headers).get("X-CSRF-Token"), userSession.csrf_token);
  await assert.rejects(client.logout("short"), AccountPayloadError);
});

test("admin account requests are bounded, versioned, reasoned, and carry CSRF", async () => {
  const calls: { path: string; init: RequestInit | undefined }[] = [];
  const otherUser: AccountUser = { ...user, id: "user/a", email: "other@example.test", version: 3 };
  const client = createAccountClient(async (input, init) => {
    calls.push({ path: String(input), init });
    return String(input).includes("?")
      ? jsonResponse({ data: [otherUser], next_cursor: "cursor-2" })
      : jsonResponse({ ...otherUser, role: "moderator", version: 4 });
  });

  assert.deepEqual(await client.listUsers({ limit: 20, after: "cursor-1" }), { data: [otherUser], next_cursor: "cursor-2" });
  const update: AccountUserUpdate = { role: "moderator", active: true, expected_version: 3, reason: "Penugasan moderator disetujui." };
  assert.equal((await client.updateUser(otherUser.id, update, String(userSession.csrf_token))).version, 4);
  assert.match(calls[0]?.path ?? "", /^\/api\/v1\/account\/users\?/u);
  assert.match(calls[0]?.path ?? "", /limit=20/u);
  assert.match(calls[0]?.path ?? "", /after=cursor-1/u);
  assert.equal(calls[0]?.init?.credentials, "same-origin");
  assert.equal(calls[1]?.path, "/api/v1/account/users/user%2Fa");
  assert.equal(calls[1]?.init?.method, "PATCH");
  assert.equal(new Headers(calls[1]?.init?.headers).get("X-CSRF-Token"), userSession.csrf_token);
  assert.deepEqual(JSON.parse(String(calls[1]?.init?.body)), update);
  await assert.rejects(client.listUsers({ limit: 51 }), AccountPayloadError);
});

test("HTTP 401, 403, and stale-version 409 remain typed and map to safe admin messages", async () => {
  for (const status of [401, 403, 409]) {
    const client = createAccountClient(async () => new Response(JSON.stringify({ code: "internal-detail", message: "private provider detail", request_id: "req-1" }), {
      status,
      headers: { "content-type": "application/json" },
    }));
    await assert.rejects(client.listUsers(), (error: unknown) => error instanceof AccountHttpError && error.status === status);
    assert.equal(adminUpdateErrorMessage(new AccountHttpError(status)), status === 409 ? "conflict" : status === 401 || status === 403 ? "authorization" : "unavailable");
  }
  assert.equal(adminUpdateErrorMessage(new Error("network")), "unavailable");
});

test("current server roles decide admin and review access and a changed session removes access", () => {
  assert.equal(hasProtectedShellAccess("admin", adminSession), true);
  assert.equal(hasProtectedShellAccess("review", adminSession), true);
  assert.equal(hasProtectedShellAccess("admin", userSession), false);
  assert.equal(hasProtectedShellAccess("review", { ...userSession, user: { ...user, role: "moderator" } }), true);
  assert.equal(hasProtectedShellAccess("review", { ...adminSession, user: { ...admin, role: "user" } }), false);
  assert.equal(hasProtectedShellAccess("admin", { ...adminSession, user: { ...admin, active: false } }), false);

  const forbidden = renderToStaticMarkup(<AccountAccessGate shell="admin" sessionState={sessionState(userSession)} isNarrowScreen={false} onRefreshSession={() => {}} />);
  assert.match(forbidden, /Akses tidak tersedia/u);
  assert.doesNotMatch(forbidden, /Ruang operasi web/u);
  const mobile = renderToStaticMarkup(<AccountAccessGate shell="admin" sessionState={sessionState(adminSession)} isNarrowScreen={true} onRefreshSession={() => {}} />);
  assert.match(mobile, /tersedia di layar desktop/u);
  assert.doesNotMatch(mobile, /Ruang operasi web/u);
});

test("account loading and failure are non-blocking, and anonymous onboarding has no role control", () => {
  const loading = renderToStaticMarkup(<AccountPage screen="account" sessionState={{ status: "loading", session: null }} isNarrowScreen={false} onRefreshSession={() => {}} />);
  assert.match(loading, /Memeriksa sesi akun/u);
  assert.match(loading, /Peta dan laporan publik tetap dapat dibuka/u);

  const failure = renderToStaticMarkup(<AccountPage screen="account" sessionState={{ status: "error", session: null }} isNarrowScreen={false} onRefreshSession={() => {}} />);
  assert.match(failure, /Status akun belum dapat diperiksa/u);
  assert.match(failure, /Buka peta dan laporan/u);

  const guest = renderToStaticMarkup(<AccountPage screen="onboarding" sessionState={sessionState(anonymousSession)} isNarrowScreen={false} onRefreshSession={() => {}} />);
  assert.match(guest, /Langkah 1 dari 3/u);
  assert.match(guest, /Status laporan punya arti berbeda/u);
  assert.equal(ACCOUNT_ONBOARDING_STEPS.length, 3);
  assert.match(ACCOUNT_ONBOARDING_STEPS[1]?.body ?? "", /menyimpan kategori minat di perangkat ini/u);
  assert.match(ACCOUNT_ONBOARDING_STEPS[2]?.body ?? "", /Peran akun ditetapkan oleh server/u);
  assert.doesNotMatch(guest, /<select|Pilih peran/u);
});

test("profile shows the server role as read-only and keeps the local-interest destination", () => {
  const html = renderToStaticMarkup(<AccountPage screen="account" sessionState={sessionState(adminSession)} isNarrowScreen={false} onRefreshSession={() => {}} />);
  assert.match(html, /Administrator/u);
  assert.match(html, /Email Google/u);
  assert.match(html, /Selesai/u);
  assert.match(html, /href="#ringkasan-saya"/u);
  assert.doesNotMatch(html, /<select/u);
});
