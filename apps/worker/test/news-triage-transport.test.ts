import assert from "node:assert/strict";
import test from "node:test";
import { buildLiveTriageGate, triageChatEndpoint } from "../src/runtime/news-triage-composition.js";
import type { SqlExecutor } from "../../db/src/sql.js";
const fakeExecutor = {
  async query() {
    return { rows: [{ approval_status: "approved", auto_acquisition_enabled: true, registry_status: "active", reuse_basis: ["public"], remit: "general news" }] };
  },
  async execute() {},
} as unknown as SqlExecutor;

test("triageChatEndpoint normalizes bases with and without /v1", () => {
  assert.equal(
    triageChatEndpoint("http://100.104.120.115:9090/v1"),
    "http://100.104.120.115:9090/v1/chat/completions",
  );
  assert.equal(
    triageChatEndpoint("http://100.104.120.115:9090/v1/"),
    "http://100.104.120.115:9090/v1/chat/completions",
  );
  assert.equal(
    triageChatEndpoint("http://100.104.120.115:9090"),
    "http://100.104.120.115:9090/v1/chat/completions",
  );
  assert.equal(
    triageChatEndpoint("http://100.104.120.115:9090///"),
    "http://100.104.120.115:9090/v1/chat/completions",
  );
});

test("missing credentials yield a chat-less gate that never calls fetch", async () => {
  const calls: string[] = [];
  const originalFetch = globalThis.fetch;
  (globalThis as Record<string, unknown>).fetch = async (...args: unknown[]) => {
    calls.push(String((args[0] as unknown) ?? ""));
    throw new Error("must not be called");
  };
  try {
    const gate = buildLiveTriageGate({}, fakeExecutor);
    assert.equal(gate.callChat, undefined);
    assert.equal(typeof gate.checkAuthorization, "function");
    const auth = await gate.checkAuthorization("source-antara-metro");
    assert.equal(auth.cleared, true);
    assert.equal(calls.length, 0);
  } finally {
    (globalThis as Record<string, unknown>).fetch = originalFetch;
  }
});

test("reuse_basis without a model token fails closed without a chat call", async () => {
  const denied = {
    async query() {
      return { rows: [{ approval_status: "approved", auto_acquisition_enabled: true, registry_status: "active", reuse_basis: ["attribution_required"], remit: "general news" }] };
    },
    async execute() {},
  } as unknown as SqlExecutor;
  const gate = buildLiveTriageGate({ NINEROUTER_URL: "http://x:9090", NINEROUTER_KEY: "k" }, denied);
  const auth = await gate.checkAuthorization("source-x");
  assert.equal(auth.cleared, false);
});

test("missing reuse_basis fails closed without a chat call", async () => {
  const missing = {
    async query() {
      return { rows: [{ approval_status: "approved", auto_acquisition_enabled: true, registry_status: "active", reuse_basis: null, remit: "general news" }] };
    },
    async execute() {},
  } as unknown as SqlExecutor;
  const gate = buildLiveTriageGate({ NINEROUTER_URL: "http://x:9090", NINEROUTER_KEY: "k" }, missing);
  const auth = await gate.checkAuthorization("source-x");
  assert.equal(auth.cleared, false);
});

test("transport failures and garbage responses resolve without leaking secrets", async () => {
  const seenBodies: string[] = [];
  const logged: string[] = [];
  const originalFetch = globalThis.fetch;
  const originalLog = console.log;
  (console as unknown as { log: (...args: unknown[]) => void }).log = (...args: unknown[]) => {
    logged.push(args.map(String).join(" "));
  };
  const secretKey = "sk-test-secret-abc123";
  const secretBase = "http://secret-host:9090";
  try {
    // HTTP 500
    (globalThis as Record<string, unknown>).fetch = async () => new Response("err", { status: 500 });
    const gate500 = buildLiveTriageGate({ NINEROUTER_URL: secretBase, NINEROUTER_KEY: secretKey }, fakeExecutor);
    await assert.rejects(gate500.callChat!("s", "u"), /triage chat HTTP 500/);

    // bad envelope
    (globalThis as Record<string, unknown>).fetch = async () =>
      new Response(JSON.stringify({ nope: true }), { status: 200 });
    const gateBad = buildLiveTriageGate({ NINEROUTER_URL: secretBase, NINEROUTER_KEY: secretKey }, fakeExecutor);
    await assert.rejects(gateBad.callChat!("s", "u"), /bad envelope/);

    // empty content
    (globalThis as Record<string, unknown>).fetch = async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: "" } }] }), { status: 200 });
    const gateEmpty = buildLiveTriageGate({ NINEROUTER_URL: secretBase, NINEROUTER_KEY: secretKey }, fakeExecutor);
    await assert.rejects(gateEmpty.callChat!("s", "u"), /empty content/);

    // valid envelope returns parsed JSON
    (globalThis as Record<string, unknown>).fetch = async (_url: unknown, init: unknown) => {
      seenBodies.push(JSON.stringify((init as { body?: unknown }).body));
      return new Response(
        JSON.stringify({ choices: [{ message: { content: '{"disposition":"ingest"} extra' } }] }),
        { status: 200 },
      );
    };
    const gateOk = buildLiveTriageGate({ NINEROUTER_URL: `${secretBase}/v1/`, NINEROUTER_KEY: secretKey }, fakeExecutor);
    const parsed = await gateOk.callChat!("system-prompt", "user-prompt");
    assert.deepEqual(parsed, { disposition: "ingest" });
    assert.ok(seenBodies.some((b) => b.includes("ag/gemini-3.8-flash")));
    for (const blob of [...seenBodies, ...logged]) {
      assert.ok(!blob.includes(secretKey), "secret key must never appear in bodies or logs");
    }
  } finally {
    (globalThis as Record<string, unknown>).fetch = originalFetch;
    (console as unknown as { log: (...args: unknown[]) => void }).log = originalLog;
  }
});
