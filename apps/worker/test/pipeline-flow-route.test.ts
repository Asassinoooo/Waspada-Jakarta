import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import worker from "../src/index.js";
import { createAccountRuntime } from "../src/runtime/account-runtime.js";
import { createPipelineRuntimeStatus } from "../src/runtime/pipeline-runtime-status.js";
import { createTestDatabase, type TestDatabase } from "../../db/test/harness.js";
import { applyMigrations, readMigrations } from "../../db/src/migrations.js";

/**
 * FLOW-VIS-01 route, end to end on PGlite: real account sessions, real role checks, and the flow
 * store under the read-only role. Synthetic accounts only.
 */

const origin = "http://127.0.0.1:5173";
const password = "kata-sandi-2026";

describe("FLOW-VIS-01 /api/v1/pipeline/flow with real sessions", () => {
  let db: TestDatabase;
  const cookies: Record<"user" | "moderator" | "admin", string> = { user: "", moderator: "", admin: "" };

  function env(overrides: Record<string, unknown> = {}) {
    return {
      DATASET_MODE: "live",
      AUTH_ENABLED: "true",
      AUTH_APP_ORIGIN: origin,
      SQL_EXECUTOR: db.executor,
      ...overrides,
    } as never;
  }

  before(async () => {
    db = await createTestDatabase();
    const migrations = await readMigrations(new URL("../../db/migrations/", import.meta.url));
    await applyMigrations(db.executor, migrations);

    const accounts = await createAccountRuntime(
      { DATASET_MODE: "live", AUTH_ENABLED: "true", AUTH_APP_ORIGIN: origin, SQL_EXECUTOR: db.executor },
      { trustedClientKey: () => "flow-route-test" },
    );
    const post = (path: string, body: unknown) => accounts!(new Request(`${origin}${path}`, {
      method: "POST",
      headers: { origin, "x-waspada-request": "1", "content-type": "application/json" },
      body: JSON.stringify(body),
    }));
    for (const name of ["flow.user", "flow.moderator", "flow.admin"]) {
      const res = await post("/api/v1/auth/register", { username: name, password });
      assert.equal(res?.status, 200, `${name} registers`);
    }
    await db.executor.query("UPDATE waspada.accounts SET role = 'moderator' WHERE username = 'flow.moderator'");
    await db.executor.query("UPDATE waspada.accounts SET role = 'admin' WHERE username = 'flow.admin'");
    for (const [key, name] of [["user", "flow.user"], ["moderator", "flow.moderator"], ["admin", "flow.admin"]] as const) {
      const res = await post("/api/v1/auth/login", { username: name, password });
      assert.equal(res?.status, 200, `${name} signs in`);
      cookies[key] = (res?.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
      assert.match(cookies[key], /^waspada_session_dev=/u);
    }
  });

  after(async () => db?.close());

  const get = (path: string, cookie?: string) => worker.fetch(new Request(`${origin}${path}`, {
    headers: cookie ? { cookie } : {},
  }), env());

  it("answers 401 to an anonymous caller and 403 to a registered user", async () => {
    assert.equal((await get("/api/v1/pipeline/flow")).status, 401);
    assert.equal((await get("/api/v1/pipeline/flow/nodes/gate/items")).status, 401);
    assert.equal((await get("/api/v1/pipeline/flow", cookies.user)).status, 403);
    assert.equal((await get("/api/v1/pipeline/flow/nodes/gate/items", cookies.user)).status, 403);
  });

  it("answers 200 to a moderator and an admin, with live counts and no runtime attached", async () => {
    for (const role of ["moderator", "admin"] as const) {
      const res = await get("/api/v1/pipeline/flow", cookies[role]);
      assert.equal(res.status, 200, `${role} may read the flow`);
      const body = await res.json() as {
        schema_version: string;
        dataset_mode: string;
        nodes: Array<{ id: string; health: string; counts: Record<string, number> }>;
        runtime: unknown;
      };
      assert.equal(body.schema_version, "pipeline-flow-v1");
      assert.equal(body.dataset_mode, "live");
      assert.equal(body.nodes.length, 18);
      assert.equal(body.runtime, null, "no PIPELINE_STATUS on the Worker path");
      assert.equal(body.nodes.find((node) => node.id === "cycle")?.health, "unavailable");
      assert.equal(body.nodes.find((node) => node.id === "gate")?.health, "idle", "an empty table is idle, not safe");
    }
  });

  it("answers drill-downs to moderators with metadata rows and 404 for unknown nodes", async () => {
    const res = await get("/api/v1/pipeline/flow/nodes/proposal/items?limit=5", cookies.moderator);
    assert.equal(res.status, 200);
    const body = await res.json() as { items: unknown[]; node_id: string; limit: number };
    assert.equal(body.node_id, "proposal");
    assert.equal(body.limit, 5);
    assert.deepEqual(body.items, []);
    assert.equal((await get("/api/v1/pipeline/flow/nodes/unknown/items", cookies.moderator)).status, 404);
  });

  it("FLOW-RANGE-01: a moderator gets the selected window, and a bad range is refused after the role check", async () => {
    const weekly = await get("/api/v1/pipeline/flow?range=7d", cookies.moderator);
    assert.equal(weekly.status, 200);
    const body = await weekly.json() as { window: { range: string; since: string } };
    assert.equal(body.window.range, "7d");
    assert.match(body.window.since, /^\d{4}-\d{2}-\d{2}T/u);
    assert.equal((await get("/api/v1/pipeline/flow/nodes/proposal/items?range=1h", cookies.moderator)).status, 200);
    assert.equal((await get("/api/v1/pipeline/flow?range=bogus", cookies.moderator)).status, 400);
    assert.equal((await get("/api/v1/pipeline/flow?range=bogus", cookies.user)).status, 403, "the role check comes before the range check");
  });

  it("attaches the runtime status only when the local server provides it", async () => {
    const status = createPipelineRuntimeStatus({
      ninerouter: () => ({
        chat: { rpm: 10, tokensAvailable: 10, cooldownRemainingMs: 0, inFlight: 0, queued: 0 },
        embed: { rpm: 30, tokensAvailable: 30, cooldownRemainingMs: 0, inFlight: 0, queued: 0 },
        callCounts: { chat: 0, embed: 0 },
      }),
    });
    status.recordCycleStart({ newItemsCap: 5, feedsTotal: 14 });
    status.recordCycleEnd({ newItemsUsed: 0, feedsFailed: 0 });
    const res = await worker.fetch(new Request(`${origin}/api/v1/pipeline/flow`, { headers: { cookie: cookies.moderator } }), env({ PIPELINE_STATUS: status }));
    assert.equal(res.status, 200);
    const body = await res.json() as { runtime: { cycle: { sequence: number }; ninerouter: { chat: { rpm: number } } } | null };
    assert.equal(body.runtime?.cycle.sequence, 1);
    assert.equal(body.runtime?.ninerouter.chat.rpm, 10);
  });
});
