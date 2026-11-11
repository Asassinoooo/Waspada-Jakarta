import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createNineRouterRateGate,
  computeCooldownMs,
  findRateLimitedError,
  parseRetryAfterMs,
  RateLimitedError,
  type NineRouterFetch,
} from "../../db/src/ninerouter-rate-gate.js";

const BASE_MS = 1_000_000_000_000; // whole seconds, so HTTP dates round-trip exactly

function fakeClock() {
  let t = BASE_MS;
  const sleeps: number[] = [];
  return {
    clock: {
      now: () => t,
      sleep: async (ms: number) => {
        sleeps.push(ms);
        t += ms;
      },
    },
    get now() {
      return t;
    },
    sleeps,
  };
}

function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

const CHAT_URL = "http://nr.test/v1/chat/completions";
const EMBED_URL = "http://nr.test/v1/embeddings";

function transportReturning(make: () => Response, seen: string[] = []): NineRouterFetch {
  return async (input) => {
    seen.push(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
    return make();
  };
}

describe("NineRouter rate gate (AI-RATE-01)", () => {
  describe("pacing", () => {
    it("spaces chat calls to the configured RPM with a fake clock", async () => {
      const fc = fakeClock();
      const gate = createNineRouterRateGate({ clock: fc.clock, chatRpm: 10, random: () => 0, log: () => {} });
      const starts: number[] = [];
      for (let i = 0; i < 3; i++) {
        const slot = await gate.acquire("chat");
        starts.push(fc.now - BASE_MS);
        slot.release();
      }
      assert.deepEqual(starts, [0, 6_000, 12_000]);
    });

    it("spaces embedding calls to their own RPM without serializing them", async () => {
      const fc = fakeClock();
      const gate = createNineRouterRateGate({ clock: fc.clock, embedRpm: 30, log: () => {} });
      const first = await gate.acquire("embed");
      const second = await gate.acquire("embed"); // no release needed: not in-flight limited
      assert.equal(fc.now - BASE_MS, 2_000);
      first.release();
      second.release();
    });

    it("allows one chat request in flight and serves waiters FIFO", async () => {
      const fc = fakeClock();
      const gate = createNineRouterRateGate({ clock: fc.clock, chatRpm: 1_000_000, log: () => {} });
      const order: string[] = [];
      const holder = await gate.acquire("chat");
      const pB = gate.acquire("chat").then((slot) => {
        order.push("b");
        return slot;
      });
      const pC = gate.acquire("chat").then((slot) => {
        order.push("c");
        return slot;
      });
      await flush();
      assert.deepEqual(order, [], "no waiter runs while the slot is held");
      holder.release();
      const slotB = await pB;
      await flush();
      assert.deepEqual(order, ["b"], "c still waits for b");
      slotB.release();
      (await pC).release();
      assert.deepEqual(order, ["b", "c"]);
    });
  });

  describe("rate limit responses", () => {
    it("429 with Retry-After: 7 sets a ~7 s cooldown and throws RateLimitedError", async () => {
      const fc = fakeClock();
      const logs: string[] = [];
      const gate = createNineRouterRateGate({
        clock: fc.clock,
        random: () => 0,
        log: (m) => logs.push(m),
        transport: transportReturning(
          () => new Response('{"error":"slow down"}', { status: 429, headers: { "retry-after": "7" } }),
        ),
      });
      let caught: unknown;
      try {
        await gate.request(CHAT_URL, { method: "POST" });
      } catch (error) {
        caught = error;
      }
      assert.ok(caught instanceof RateLimitedError);
      assert.equal(caught.code, "rate_limited");
      assert.equal(caught.status, 429);
      assert.equal(caught.retryAfterMs, 7_000);
      assert.equal(gate.cooldownRemainingMs("chat"), 7_000);
      assert.deepEqual(logs, ["NineRouter chat: rate limited, cooling down 7 s"]);
    });

    it("parses an HTTP-date Retry-After relative to the gate clock", () => {
      const httpDate = new Date(BASE_MS + 30_000).toUTCString();
      assert.equal(parseRetryAfterMs(httpDate, BASE_MS), 30_000);
      assert.equal(parseRetryAfterMs(new Date(BASE_MS - 5_000).toUTCString(), BASE_MS), 0);
      assert.equal(parseRetryAfterMs("soon", BASE_MS), null);
    });

    it("uses a 60 s default when Retry-After is missing, with up to 20 percent jitter", () => {
      assert.equal(computeCooldownMs(null, BASE_MS, () => 0), 60_000);
      assert.equal(computeCooldownMs(undefined, BASE_MS, () => 1), 72_000);
      assert.equal(computeCooldownMs("not-a-date", BASE_MS, () => 0), 60_000);
    });

    it("caps cooldowns at 15 minutes and floors them at 1 second", () => {
      assert.equal(computeCooldownMs("3600", BASE_MS, () => 0), 900_000);
      assert.equal(computeCooldownMs("0", BASE_MS, () => 0), 1_000);
    });

    it("a cooldown blocks other callers until it ends", async () => {
      const fc = fakeClock();
      const gate = createNineRouterRateGate({
        clock: fc.clock,
        random: () => 0,
        log: () => {},
        transport: transportReturning(() => new Response("", { status: 429, headers: { "retry-after": "7" } })),
      });
      await assert.rejects(gate.request(CHAT_URL, { method: "POST" }), RateLimitedError);
      const other = await gate.acquire("chat");
      assert.equal(fc.now - BASE_MS, 7_000, "second caller starts only after the cooldown");
      other.release();
    });

    it("503 with a quota or rate body is rate limited; a plain 503 passes through", async () => {
      const fc = fakeClock();
      const quotaGate = createNineRouterRateGate({
        clock: fc.clock,
        random: () => 0,
        log: () => {},
        transport: transportReturning(() => new Response("monthly quota exhausted", { status: 503 })),
      });
      await assert.rejects(quotaGate.request(EMBED_URL, { method: "POST" }), (error: unknown) =>
        error instanceof RateLimitedError && error.status === 503,
      );

      const plainGate = createNineRouterRateGate({
        clock: fakeClock().clock,
        log: () => {},
        transport: transportReturning(() => new Response("upstream unavailable", { status: 503 })),
      });
      const response = await plainGate.request(CHAT_URL, { method: "POST" });
      assert.equal(response.status, 503);
      assert.equal(plainGate.cooldownRemainingMs("chat"), 0);

      // "generate" contains "rate" but is not a rate hint.
      const wordGate = createNineRouterRateGate({
        clock: fakeClock().clock,
        log: () => {},
        transport: transportReturning(() => new Response("unable to generate a response", { status: 503 })),
      });
      const notRateLimited = await wordGate.request(CHAT_URL, { method: "POST" });
      assert.equal(notRateLimited.status, 503);
      assert.equal(wordGate.cooldownRemainingMs("chat"), 0);
    });

    it("never logs endpoints, keys or response bodies", async () => {
      const logs: string[] = [];
      const gate = createNineRouterRateGate({
        clock: fakeClock().clock,
        random: () => 0,
        log: (m) => logs.push(m),
        transport: transportReturning(() => new Response("sk-secret-token leaked body", { status: 429 })),
      });
      await assert.rejects(gate.request("http://secret-host:9090/v1/chat/completions", { method: "POST" }));
      for (const line of logs) {
        assert.ok(!line.includes("secret"), "log line must not contain endpoint or body text");
        assert.ok(!line.includes("http"), "log line must not contain an endpoint");
      }
    });
  });

  describe("request routing", () => {
    it("passes non-NineRouter URLs through without pacing", async () => {
      const fc = fakeClock();
      const seen: string[] = [];
      const gate = createNineRouterRateGate({
        clock: fc.clock,
        transport: transportReturning(() => new Response("ok", { status: 200 }), seen),
      });
      await gate.request("https://example.test/feed.xml");
      await gate.request("https://example.test/feed.xml");
      assert.deepEqual(seen, ["https://example.test/feed.xml", "https://example.test/feed.xml"]);
      assert.deepEqual(fc.sleeps, []);
    });

    it("findRateLimitedError unwraps a cause chain and ignores other errors", () => {
      const inner = new RateLimitedError({ retryAfterMs: 5_000, status: 429, bucket: "chat" });
      const wrapped = new Error("Cannot connect to API", { cause: inner });
      assert.deepEqual(findRateLimitedError(wrapped), { retryAfterMs: 5_000 });
      assert.deepEqual(findRateLimitedError(inner), { retryAfterMs: 5_000 });
      assert.equal(findRateLimitedError(new Error("NineRouter 502 Bad Gateway")), null);
    });

    it("installGlobalFetch gates NineRouter calls made through globalThis.fetch", async () => {
      const original = globalThis.fetch;
      const seen: string[] = [];
      const bodies: Array<string | undefined> = [];
      const fakeOriginal = (async (input: string | URL | Request, init?: RequestInit) => {
        seen.push(String(input));
        bodies.push(typeof init?.body === "string" ? init.body : undefined);
        return new Response("{}", { status: 200 });
      }) as typeof fetch;
      globalThis.fetch = fakeOriginal;
      try {
        const gate = createNineRouterRateGate({ clock: fakeClock().clock, log: () => {} });
        gate.installGlobalFetch((url, init) => (url.includes("/chat/completions") ? { ...init, body: "rewritten" } : init));
        const res = await globalThis.fetch(CHAT_URL, { method: "POST", body: "original" });
        assert.equal(res.status, 200);
        assert.deepEqual(seen, [CHAT_URL]);
        assert.deepEqual(bodies, ["rewritten"]);
        assert.notEqual(globalThis.fetch, fakeOriginal, "the wrapper replaces globalThis.fetch");
        const wrapper = globalThis.fetch;
        gate.installGlobalFetch(); // idempotent: a second install keeps the same wrapper
        assert.equal(globalThis.fetch, wrapper);
      } finally {
        globalThis.fetch = original;
      }
    });
  });

  describe("call counts (AI-RPM-01)", () => {
    it("counts sent requests per bucket, including a direct triage-style acquire", async () => {
      const fc = fakeClock();
      const seen: string[] = [];
      const gate = createNineRouterRateGate({
        clock: fc.clock,
        random: () => 0,
        log: () => {},
        transport: transportReturning(() => new Response("{}", { status: 200 }), seen),
      });
      assert.deepEqual(gate.callCounts(), { chat: 0, embed: 0 });

      await gate.request(CHAT_URL, { method: "POST" });
      await gate.request(EMBED_URL, { method: "POST" });
      await gate.request(EMBED_URL, { method: "POST" });
      // The direct triage transport acquires a chat slot without request().
      const slot = await gate.acquire("chat");
      slot.release();

      assert.deepEqual(gate.callCounts(), { chat: 2, embed: 2 });
      assert.equal(seen.length, 3, "only request() sends through the transport");
    });

    it("does not count non-NineRouter URLs or a request that is never sent", async () => {
      const gate = createNineRouterRateGate({
        clock: fakeClock().clock,
        log: () => {},
        transport: transportReturning(() => new Response("{}", { status: 200 })),
      });
      await gate.request("http://other.test/not-nineRouter", { method: "GET" });
      assert.deepEqual(gate.callCounts(), { chat: 0, embed: 0 });
    });
  });
});
