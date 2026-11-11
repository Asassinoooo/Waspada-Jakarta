import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createNineRouterMastraAgent } from "../src/providers/ninerouter-adapter.js";
import { createNineRouterRateGate, findRateLimitedError, setNineRouterRateGate } from "../../db/src/ninerouter-rate-gate.js";
import { classifyJobError } from "../src/job-runner.js";

/**
 * A real Mastra agent against a fake NineRouter (no network). Checks two
 * assumptions the job runner relies on: an agent sends exactly one request on
 * a 429 (maxRetries 0), and the rate limit reaches the caller as rate_limited.
 */
describe("Mastra NineRouter agent under a rate limit (AI-RATE-01)", () => {
  it("sends one request on 429 and surfaces it as a rate limit", async () => {
    const originalFetch = globalThis.fetch;
    let requests = 0;
    globalThis.fetch = (async () => {
      requests += 1;
      return new Response('{"error":{"message":"rate limit exceeded"}}', {
        status: 429,
        headers: { "retry-after": "7" },
      });
    }) as typeof fetch;
    let now = 1_000_000_000_000;
    const gate = createNineRouterRateGate({
      clock: {
        now: () => now,
        sleep: async (ms: number) => {
          now += ms;
        },
      },
      random: () => 0,
      log: () => {},
    });
    setNineRouterRateGate(gate);
    try {
      const agent = createNineRouterMastraAgent({
        id: "rate-limit-probe",
        name: "Rate Limit Probe",
        instructions: "Reply with JSON.",
        modelOverride: "Waspada-Jakarta",
      });
      assert.equal(agent.maxRetries, 0, "in-process retries are disabled");

      let caught: unknown;
      try {
        await agent.generate("Ringkas laporan ini.");
      } catch (error) {
        caught = error;
      }
      assert.ok(caught, "the rate-limited call throws");
      assert.equal(requests, 1, "exactly one request reached the gateway");
      assert.ok(
        findRateLimitedError(caught) !== null || classifyJobError(caught) === "rate_limited",
        "the job runner classifies the Mastra error as rate_limited",
      );
      assert.equal(gate.cooldownRemainingMs("chat"), 7_000, "the shared chat cooldown started");
    } finally {
      globalThis.fetch = originalFetch;
      setNineRouterRateGate(undefined);
    }
  });
});
