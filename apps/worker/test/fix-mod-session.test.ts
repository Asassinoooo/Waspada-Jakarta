import assert from "node:assert/strict";
import test from "node:test";
import type { AccountTransactionalSqlExecutorRunner, AccountRuntimeConfig } from "../src/runtime/account-runtime.js";
import { resolveAccountRuntime } from "../src/runtime/account-runtime.js";
import { moderatorSurfaceDenial, readModeratorPrincipal } from "../src/runtime/moderator-session.js";
import {
  SESSION_APP_ORIGIN,
  sessionCookieHeader,
  sessionExecutor,
} from "./support/moderator-session.js";

/**
 * FIX-MOD-SESSION: moderation, SSE and embedding surfaces are cookie-only. A request without a
 * session cookie is refused before the account store is touched, so it never opens a Neon
 * connection. With a valid cookie the principal and the decision are unchanged.
 */

const moderationEnvironment = {
  DATASET_MODE: "live",
  AUTH_ENABLED: "true",
  AUTH_APP_ORIGIN: SESSION_APP_ORIGIN,
  AUTH_HYPERDRIVE: { connectionString: "postgresql://auth:local@db.example/waspada?sslmode=require" },
};
const surfaceUrl = `${SESSION_APP_ORIGIN}/api/v1/moderation/events`;
const syntheticBearer = `Bearer ${"b".repeat(43)}`;

function moderationConfig(): AccountRuntimeConfig {
  const config = resolveAccountRuntime(moderationEnvironment);
  assert.ok(config, "the live account runtime resolves on the loopback origin");
  return config;
}

/** Counts every database open. Each open answers with the synthetic session fixture for `role`. */
function openCounter(role: "user" | "moderator" | "admin" = "moderator"): {
  readonly runner: AccountTransactionalSqlExecutorRunner;
  readonly opened: () => number;
} {
  let opened = 0;
  return {
    runner: async (_connectionString, operation) => {
      opened += 1;
      return operation(sessionExecutor({ role }));
    },
    opened: () => opened,
  };
}

/** A runner that fails like an unreachable database, for the no-cookie case that must not reach it. */
function unreachableRunner(): { readonly runner: AccountTransactionalSqlExecutorRunner; readonly opened: () => number } {
  let opened = 0;
  return {
    runner: async () => {
      opened += 1;
      throw new Error("connect ECONNREFUSED postgresql://auth:local@db.example");
    },
    opened: () => opened,
  };
}

const anonymousRequests: readonly { readonly label: string; readonly headers: Record<string, string> }[] = [
  { label: "no credentials at all", headers: {} },
  { label: "only a session cookie under the production name", headers: { cookie: `__Host-waspada_session=${"s".repeat(43)}` } },
  { label: "only a malformed session cookie", headers: { cookie: "waspada_session_dev=short" } },
  { label: "only a bearer token", headers: { authorization: syntheticBearer } },
  { label: "a bearer token alongside a valid session cookie", headers: { authorization: syntheticBearer, cookie: sessionCookieHeader } },
];

for (const anonymous of anonymousRequests) {
  test(`readModeratorPrincipal refuses ${anonymous.label} without opening the account database`, async () => {
    const spy = openCounter();
    const principal = await readModeratorPrincipal(
      new Request(surfaceUrl, { headers: anonymous.headers }),
      moderationConfig(),
      { withTransactionalSqlExecutor: spy.runner },
    );
    assert.equal(principal, null);
    assert.equal(spy.opened(), 0, "no connection is opened for a request that cannot be a cookie session");
  });
}

test("moderatorSurfaceDenial answers 401 UNAUTHORIZED without a cookie and never opens the account database", async () => {
  const spy = unreachableRunner();
  const response = await moderatorSurfaceDenial(
    new Request(surfaceUrl),
    moderationConfig(),
    "review_evidence",
    { withTransactionalSqlExecutor: spy.runner },
  );
  assert.ok(response, "the anonymous request is denied");
  assert.equal(response.status, 401);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal((await response.json() as { code: string }).code, "UNAUTHORIZED");
  assert.equal(spy.opened(), 0, "an unreachable database is not consulted, so the answer is 401 rather than 503");
});

test("readModeratorPrincipal with a valid moderator cookie returns the same principal and opens one connection", async () => {
  const spy = openCounter("moderator");
  const principal = await readModeratorPrincipal(
    new Request(surfaceUrl, { headers: { cookie: sessionCookieHeader } }),
    moderationConfig(),
    { withTransactionalSqlExecutor: spy.runner },
  );
  assert.deepEqual(principal, {
    actorId: "7f1d0c5e-2b1a-4c6e-9d3f-5a8b7c6d5e4f",
    role: "moderator",
    active: true,
    csrfToken: "c".repeat(43),
    channel: "web",
    datasetScope: "live",
  });
  assert.equal(spy.opened(), 1);
});

test("moderatorSurfaceDenial allows a valid moderator cookie and still refuses a registered user with 403", async () => {
  const moderator = openCounter("moderator");
  assert.equal(await moderatorSurfaceDenial(
    new Request(surfaceUrl, { headers: { cookie: sessionCookieHeader } }),
    moderationConfig(),
    "review_evidence",
    { withTransactionalSqlExecutor: moderator.runner },
  ), null);
  assert.equal(moderator.opened(), 1);

  const user = openCounter("user");
  const denied = await moderatorSurfaceDenial(
    new Request(surfaceUrl, { headers: { cookie: sessionCookieHeader } }),
    moderationConfig(),
    "review_evidence",
    { withTransactionalSqlExecutor: user.runner },
  );
  assert.equal(denied?.status, 403);
  assert.equal(user.opened(), 1);
});
