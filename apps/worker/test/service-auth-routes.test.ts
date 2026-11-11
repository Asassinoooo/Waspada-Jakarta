import assert from "node:assert/strict";
import test from "node:test";
import worker from "../src/index.js";
import type { WorkerEnvironment } from "../src/layers/l4-application-integration/api.js";
import type { SqlExecutor } from "../../db/src/sql.js";

const origin = "https://waspada.example";
const liveAccounts = {
  AUTH_ENABLED: "true",
  AUTH_APP_ORIGIN: origin,
  DATASET_MODE: "live",
};

/** A database handle that fails the test if any route reaches it. Denials must happen before SQL. */
function untouchableExecutor(): SqlExecutor {
  const fail = async () => {
    throw new Error("the database must not be reached for this request");
  };
  return { query: fail, execute: fail, transaction: fail } as unknown as SqlExecutor;
}

/** A database handle whose session lookup fails, to prove database errors close the route. */
function failingSessionExecutor(): SqlExecutor {
  const fail = async () => {
    throw new Error("connection refused");
  };
  return { query: fail, execute: fail, transaction: fail } as unknown as SqlExecutor;
}

function env(overrides: Partial<WorkerEnvironment> = {}): WorkerEnvironment {
  return { ...overrides } as WorkerEnvironment;
}

test("demo login and the demo session shadows are gone from the Worker", async () => {
  for (const method of ["GET", "POST"]) {
    for (const path of ["/api/v1/auth/demo-login", "/api/v1/auth/demo/login"]) {
      const response = await worker.fetch(new Request(origin + path, { method }), env({ DATASET_MODE: "demo" }));
      assert.equal(response.status, 404, `${method} ${path} is not a route`);
      assert.equal(response.headers.get("set-cookie"), null, "no demo cookie is minted");
    }
  }
  const spoofed = await worker.fetch(
    new Request(origin + "/api/v1/auth/session", { headers: { cookie: "waspada_demo_session=moderator" } }),
    env({ DATASET_MODE: "demo" }),
  );
  assert.equal(((await spoofed.json()) as { status: string }).status, "anonymous",
    "the demo cookie does not authenticate anyone");
  const logout = await worker.fetch(new Request(origin + "/api/v1/auth/logout", { method: "POST" }), env());
  assert.notEqual(logout.status, 204, "the shadowing 204 logout no longer answers");
  assert.equal(logout.status, 503, "without accounts the real logout route is unavailable");
});

test("internal proposals route: 503 without a configured key, 401 on mismatch, 200 with the key", async () => {
  const body = JSON.stringify({ proposal_id: "prop-internal-1" });
  const post = (headers: Record<string, string>) => worker.fetch(
    new Request(origin + "/api/v1/internal/proposals", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body,
    }),
    env({ INTERNAL_SERVICE_KEY: "job-runner-secret-000000000000" }),
  );
  const unconfigured = await worker.fetch(
    new Request(origin + "/api/v1/internal/proposals", {
      method: "POST", headers: { "content-type": "application/json", "x-service-key": "dev-internal-key" }, body,
    }),
    env(),
  );
  assert.equal(unconfigured.status, 503, "the dev fallback key no longer works");
  assert.equal((await post({})).status, 401);
  assert.equal((await post({ "x-service-key": "dev-internal-key" })).status, 401, "the old fallback key is rejected");
  assert.equal((await post({ "x-service-key": "job-runner-secret-00000000000x" })).status, 401);
  const accepted = await post({ "x-service-key": "job-runner-secret-000000000000" });
  assert.equal(accepted.status, 200);
  assert.deepEqual(await accepted.json(), { ok: true, proposal_id: "prop-internal-1" });
});

test("webhook ingest requires WEBHOOK_SERVICE_KEY: 503 when unset, 401 on mismatch", async () => {
  const body = JSON.stringify({});
  const unconfigured = await worker.fetch(new Request(origin + "/api/v1/ingestion/events", {
    method: "POST", headers: { "content-type": "application/json" }, body,
  }), env());
  assert.equal(unconfigured.status, 503);

  const withKey = env({ WEBHOOK_SERVICE_KEY: "webhook-secret-0000000000000000" });
  const missing = await worker.fetch(new Request(origin + "/api/v1/ingest/incident", {
    method: "POST", headers: { "content-type": "application/json" }, body,
  }), withKey);
  assert.equal(missing.status, 401);
  const wrong = await worker.fetch(new Request(origin + "/api/v1/ingestion/events", {
    method: "POST", headers: { "content-type": "application/json", "x-service-key": "webhook-secret-0000000000000001" }, body,
  }), withKey);
  assert.equal(wrong.status, 401);
  const authorized = await worker.fetch(new Request(origin + "/api/v1/ingestion/events", {
    method: "POST", headers: { "content-type": "application/json", "x-service-key": "webhook-secret-0000000000000000" }, body,
  }), withKey);
  assert.notEqual(authorized.status, 401, "the correct key passes the gate and reaches the handler");
  assert.notEqual(authorized.status, 503);
});

test("moderation is unavailable without accounts, never open access", async () => {
  const response = await worker.fetch(new Request(origin + "/api/v1/moderation/proposals"), env({ DATASET_MODE: "demo" }));
  assert.equal(response.status, 503);
  assert.equal(((await response.json()) as { code: string }).code, "TEMPORARILY_UNAVAILABLE");

  const anonymous = await worker.fetch(new Request(origin + "/api/v1/moderation/proposals"), env({
    ...liveAccounts,
    SQL_EXECUTOR: untouchableExecutor(),
  }));
  assert.equal(anonymous.status, 401, "no cookie is a 401 without touching the database");
});

test("a database failure while reading the moderation session answers 503, not an anonymous page", async () => {
  const response = await worker.fetch(new Request(origin + "/api/v1/moderation/proposals", {
    headers: { cookie: `__Host-waspada_session=${"s".repeat(43)}` },
  }), env({ ...liveAccounts, SQL_EXECUTOR: failingSessionExecutor() }));
  assert.equal(response.status, 503);
  const text = await response.text();
  assert.equal(text.includes("connection refused"), false, "driver text is not rendered");
});

test("the moderation SSE stream requires a moderator session", async () => {
  const unconfigured = await worker.fetch(new Request(origin + "/api/v1/moderation/stream"), env());
  assert.equal(unconfigured.status, 503);
  const anonymous = await worker.fetch(new Request(origin + "/api/v1/moderation/stream"), env({
    ...liveAccounts,
    SQL_EXECUTOR: untouchableExecutor(),
  }));
  assert.equal(anonymous.status, 401);
  assert.equal(anonymous.headers.get("content-type")?.includes("text/event-stream") ?? false, false,
    "no event stream is opened for an anonymous caller");
});

test("the embedding visualization route is closed to anonymous callers in every configuration", async () => {
  const unconfigured = await worker.fetch(new Request(origin + "/api/v1/embeddings/visualization"), env({ DATASET_MODE: "demo" }));
  assert.equal(unconfigured.status, 503);
  const anonymous = await worker.fetch(new Request(origin + "/api/v1/embeddings/visualization?dataset_kind=live"), env({
    ...liveAccounts,
    SQL_EXECUTOR: untouchableExecutor(),
  }));
  assert.equal(anonymous.status, 401);
});

test("Google sign-in routes are not part of the Worker any more", async () => {
  for (const path of ["/api/v1/auth/google/start", "/api/v1/auth/google/callback", "/api/v1/auth/google/native"]) {
    const response = await worker.fetch(new Request(origin + path, { method: "POST" }), env(liveAccounts));
    assert.equal(response.status, 404, `${path} is closed`);
  }
});
