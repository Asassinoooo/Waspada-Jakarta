import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  AiProviderConfigError,
  GOOGLE_AI_DEFAULT_CHAT_MODEL,
  GOOGLE_AI_DEFAULT_EMBEDDING_MODEL,
  GOOGLE_AI_DEFAULT_FALLBACK_CHAT_MODEL,
  GOOGLE_AI_OPENAI_BASE_URL,
  GOOGLE_AI_UNPACED_RPM,
  createGoogleChatFallbackFetch,
  generateGoogleAiEmbedding,
  getGoogleAiConfig,
  resolveAiProviderKind,
  type GoogleAiConfig,
} from "../src/providers/google-ai-adapter.js";
import {
  createNineRouterRateGate,
  RateLimitedError,
  type NineRouterFetch,
} from "../../db/src/ninerouter-rate-gate.js";

// Fake key only. The tests assert it never reaches a log line or a URL.
const TEST_KEY = "test-key-not-a-secret-0001";
const PROMPT_SENTINEL = "PROMPT-SENTINEL-DO-NOT-LOG";
const BODY_SENTINEL = "RESPONSE-BODY-SENTINEL-DO-NOT-LOG";

const CONFIG: GoogleAiConfig = {
  apiKey: TEST_KEY,
  chatModel: GOOGLE_AI_DEFAULT_CHAT_MODEL,
  fallbackChatModel: GOOGLE_AI_DEFAULT_FALLBACK_CHAT_MODEL,
  embeddingModel: GOOGLE_AI_DEFAULT_EMBEDDING_MODEL,
  embeddingDimensions: 768,
  timeoutMs: 60_000,
  chatRpm: GOOGLE_AI_UNPACED_RPM,
  embedRpm: GOOGLE_AI_UNPACED_RPM,
};

const CHAT_URL = `${GOOGLE_AI_OPENAI_BASE_URL}/chat/completions`;

interface RecordedCall {
  readonly url: string;
  readonly body: string | undefined;
  readonly headers: Record<string, string>;
}

/** Fake transport that answers each call from a queue. Records every call. */
function fakeTransport(answers: Array<() => Response>) {
  const calls: RecordedCall[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const transport: NineRouterFetch = async (input, init) => {
    calls.push({
      url: typeof input === "string" ? input : String(input),
      body: typeof init?.body === "string" ? init.body : undefined,
      headers: (init?.headers ?? {}) as Record<string, string>,
    });
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    try {
      await new Promise((resolve) => setTimeout(resolve, 2));
      const next = answers.shift();
      if (next === undefined) throw new Error("fake transport: unexpected extra call");
      return next();
    } finally {
      inFlight -= 1;
    }
  };
  return { transport, calls, maxInFlight: () => maxInFlight };
}

function json(status: number, payload: unknown, headers: Record<string, string> = {}): () => Response {
  return () =>
    new Response(JSON.stringify(payload), {
      status,
      headers: { "content-type": "application/json", ...headers },
    });
}

function chatBody(model: string): string {
  return JSON.stringify({ model, messages: [{ role: "user", content: PROMPT_SENTINEL }], stream: false });
}

function chatOk(): () => Response {
  return json(200, { choices: [{ message: { content: "{}" } }] });
}

function fakeClock() {
  let now = 1_700_000_000_000;
  const sleeps: number[] = [];
  return {
    clock: {
      now: () => now,
      sleep: async (ms: number) => {
        sleeps.push(ms);
        now += ms;
      },
    },
    sleeps,
  };
}

function modelOf(call: RecordedCall): string | undefined {
  return call.body ? (JSON.parse(call.body) as { model?: string }).model : undefined;
}

describe("Google AI Studio provider config", () => {
  it("resolves the default provider to ninerouter and the verified Google model IDs", () => {
    assert.equal(resolveAiProviderKind(undefined), "ninerouter");
    assert.equal(resolveAiProviderKind(""), "ninerouter");
    assert.equal(resolveAiProviderKind("google_ai_studio"), "google_ai_studio");

    const config = getGoogleAiConfig(() => undefined);
    assert.equal(config.apiKey, "");
    assert.equal(config.chatModel, "gemini-3.5-flash-lite");
    assert.equal(config.fallbackChatModel, "gemini-3.1-flash-lite");
    assert.equal(config.embeddingModel, "gemini-embedding-2");
    assert.equal(config.embeddingDimensions, 768);
    assert.equal(config.timeoutMs, 60_000);
    assert.equal(config.chatRpm, GOOGLE_AI_UNPACED_RPM);
  });

  it("rejects an unknown AI_PROVIDER value instead of guessing", () => {
    assert.throws(() => resolveAiProviderKind("openai"), AiProviderConfigError);
  });

  it("reads timeout and RPM caps from env and ignores invalid values", () => {
    const env: Record<string, string> = {
      GOOGLE_AI_CHAT_RPM: "7",
      GOOGLE_AI_EMBED_RPM: "not-a-number",
      GOOGLE_AI_TIMEOUT_MS: "-5",
      NINEROUTER_TIMEOUT_MS: "12000",
    };
    const config = getGoogleAiConfig((name) => env[name]);
    assert.equal(config.chatRpm, 7);
    assert.equal(config.embedRpm, GOOGLE_AI_UNPACED_RPM);
    assert.equal(config.timeoutMs, 12_000);
  });
});

describe("Google chat fallback", () => {
  it("primary success makes one call on the primary model and logs it", async () => {
    const logs: string[] = [];
    const { transport, calls } = fakeTransport([chatOk()]);
    const fetchWithFallback = createGoogleChatFallbackFetch({
      transport,
      fallbackModel: CONFIG.fallbackChatModel,
      timeoutMs: 60_000,
      log: (line) => logs.push(line),
    });

    const response = await fetchWithFallback(CHAT_URL, {
      method: "POST",
      body: chatBody(CONFIG.chatModel),
    });

    assert.equal(response.status, 200);
    assert.equal(calls.length, 1);
    assert.equal(modelOf(calls[0]!), CONFIG.chatModel);
    assert.deepEqual(logs, ["[AI] model=primary ok"]);
  });

  it("primary 429 then fallback success retries once on the fallback and records it", async () => {
    const logs: string[] = [];
    const { transport, calls } = fakeTransport([
      json(429, { error: { message: BODY_SENTINEL } }, { "retry-after": "30" }),
      chatOk(),
    ]);
    const fetchWithFallback = createGoogleChatFallbackFetch({
      transport,
      fallbackModel: CONFIG.fallbackChatModel,
      timeoutMs: 60_000,
      log: (line) => logs.push(line),
    });

    const response = await fetchWithFallback(CHAT_URL, {
      method: "POST",
      body: chatBody(CONFIG.chatModel),
    });

    assert.equal(response.status, 200);
    assert.equal(calls.length, 2);
    assert.equal(modelOf(calls[0]!), CONFIG.chatModel);
    assert.equal(modelOf(calls[1]!), CONFIG.fallbackChatModel);
    assert.ok(logs.includes("[AI] fallback used"));
    assert.ok(logs.includes("[AI] model=fallback ok"));
  });

  it("a 400 is never retried", async () => {
    const { transport, calls } = fakeTransport([json(400, { error: { message: "bad" } })]);
    const fetchWithFallback = createGoogleChatFallbackFetch({
      transport,
      fallbackModel: CONFIG.fallbackChatModel,
      timeoutMs: 60_000,
      log: () => undefined,
    });

    const response = await fetchWithFallback(CHAT_URL, { method: "POST", body: chatBody(CONFIG.chatModel) });

    assert.equal(response.status, 400);
    assert.equal(calls.length, 1);
  });

  it("a 403 is never retried", async () => {
    const { transport, calls } = fakeTransport([json(403, { error: { message: "denied" } })]);
    const fetchWithFallback = createGoogleChatFallbackFetch({
      transport,
      fallbackModel: CONFIG.fallbackChatModel,
      timeoutMs: 60_000,
      log: () => undefined,
    });

    const response = await fetchWithFallback(CHAT_URL, { method: "POST", body: chatBody(CONFIG.chatModel) });

    assert.equal(response.status, 403);
    assert.equal(calls.length, 1);
  });

  it("through the gate, a primary 429 with a fallback success starts no chat cooldown", async () => {
    const { transport } = fakeTransport([
      json(429, { error: { message: BODY_SENTINEL } }, { "retry-after": "30" }),
      chatOk(),
    ]);
    const { clock, sleeps } = fakeClock();
    const gate = createNineRouterRateGate({
      chatRpm: GOOGLE_AI_UNPACED_RPM,
      embedRpm: GOOGLE_AI_UNPACED_RPM,
      clock,
      log: () => undefined,
      transport: createGoogleChatFallbackFetch({
        transport,
        fallbackModel: CONFIG.fallbackChatModel,
        timeoutMs: 60_000,
        log: () => undefined,
      }),
    });

    const response = await gate.request(CHAT_URL, { method: "POST", body: chatBody(CONFIG.chatModel) });

    assert.equal(response.status, 200);
    assert.equal(gate.cooldownRemainingMs("chat"), 0);
    assert.ok(sleeps.every((ms) => ms < 1_000), `no cooldown-length sleep expected, got ${sleeps.join(",")}`);
  });

  it("through the gate, a primary and a fallback 429 raise RateLimitedError for the job runner", async () => {
    const { transport } = fakeTransport([
      json(429, { error: { message: BODY_SENTINEL } }, { "retry-after": "30" }),
      json(429, { error: { message: BODY_SENTINEL } }, { "retry-after": "30" }),
    ]);
    const { clock } = fakeClock();
    const gate = createNineRouterRateGate({
      chatRpm: GOOGLE_AI_UNPACED_RPM,
      embedRpm: GOOGLE_AI_UNPACED_RPM,
      clock,
      log: () => undefined,
      transport: createGoogleChatFallbackFetch({
        transport,
        fallbackModel: CONFIG.fallbackChatModel,
        timeoutMs: 60_000,
        log: () => undefined,
      }),
    });

    await assert.rejects(
      () => gate.request(CHAT_URL, { method: "POST", body: chatBody(CONFIG.chatModel) }),
      (error: unknown) => error instanceof RateLimitedError && error.bucket === "chat",
    );
    assert.ok(gate.cooldownRemainingMs("chat") > 0);
  });

  it("logs never contain the key, the prompt, or a response body", async () => {
    const logs: string[] = [];
    const { transport } = fakeTransport([
      json(503, { error: { message: BODY_SENTINEL } }),
      json(400, { error: { message: BODY_SENTINEL } }),
    ]);
    const fetchWithFallback = createGoogleChatFallbackFetch({
      transport,
      fallbackModel: CONFIG.fallbackChatModel,
      timeoutMs: 60_000,
      log: (line) => logs.push(line),
    });
    await fetchWithFallback(CHAT_URL, { method: "POST", body: chatBody(CONFIG.chatModel) });
    const joined = logs.join("\n");
    assert.ok(joined.includes("[AI] model=primary failed status=503"));
    assert.ok(!joined.includes(TEST_KEY));
    assert.ok(!joined.includes(PROMPT_SENTINEL));
    assert.ok(!joined.includes(BODY_SENTINEL));
  });
});

describe("Google embeddings", () => {
  it("accepts a 768-dimension vector and sends the key only in the header", async () => {
    const values = Array.from({ length: 768 }, (_, i) => (i % 7) / 10);
    const { transport, calls } = fakeTransport([json(200, { embedding: { values } })]);
    const { clock } = fakeClock();
    const gate = createNineRouterRateGate({ chatRpm: GOOGLE_AI_UNPACED_RPM, embedRpm: GOOGLE_AI_UNPACED_RPM, clock, log: () => undefined, transport });

    const vector = await generateGoogleAiEmbedding("teks uji", { config: CONFIG, gate });

    assert.equal(vector.length, 768);
    assert.equal(calls.length, 1);
    assert.ok(calls[0]!.url.endsWith("/models/gemini-embedding-2:embedContent"));
    assert.ok(!calls[0]!.url.includes(TEST_KEY));
    assert.equal(calls[0]!.headers["x-goog-api-key"], TEST_KEY);
    const body = JSON.parse(calls[0]!.body ?? "{}") as { output_dimensionality?: number };
    assert.equal(body.output_dimensionality, 768);
  });

  it("rejects a vector that is not 768 dimensions (fail closed)", async () => {
    for (const length of [767, 3072]) {
      const values = Array.from({ length }, () => 0.1);
      const { transport } = fakeTransport([json(200, { embedding: { values } })]);
      const { clock } = fakeClock();
      const gate = createNineRouterRateGate({ chatRpm: GOOGLE_AI_UNPACED_RPM, embedRpm: GOOGLE_AI_UNPACED_RPM, clock, log: () => undefined, transport });
      await assert.rejects(
        () => generateGoogleAiEmbedding("teks uji", { config: CONFIG, gate }),
        /dimension mismatch: expected 768/,
      );
    }
  });

  it("rejects a non-finite component", async () => {
    const values: Array<number | null> = Array.from({ length: 768 }, () => 0.1);
    values[5] = null;
    const { transport } = fakeTransport([json(200, { embedding: { values } })]);
    const { clock } = fakeClock();
    const gate = createNineRouterRateGate({ chatRpm: GOOGLE_AI_UNPACED_RPM, embedRpm: GOOGLE_AI_UNPACED_RPM, clock, log: () => undefined, transport });
    await assert.rejects(() => generateGoogleAiEmbedding("teks uji", { config: CONFIG, gate }), /non-finite value at index 5/);
  });

  it("an HTTP error names the status but never the response body", async () => {
    const { transport } = fakeTransport([json(503, { error: { message: BODY_SENTINEL } })]);
    const { clock } = fakeClock();
    const gate = createNineRouterRateGate({ chatRpm: GOOGLE_AI_UNPACED_RPM, embedRpm: GOOGLE_AI_UNPACED_RPM, clock, log: () => undefined, transport });
    await assert.rejects(
      () => generateGoogleAiEmbedding("teks uji", { config: CONFIG, gate }),
      (error: unknown) => error instanceof Error && error.message.includes("HTTP 503") && !error.message.includes(BODY_SENTINEL),
    );
  });

  it("missing key throws a config error and makes no call", async () => {
    const { transport, calls } = fakeTransport([]);
    const { clock } = fakeClock();
    const gate = createNineRouterRateGate({ chatRpm: GOOGLE_AI_UNPACED_RPM, embedRpm: GOOGLE_AI_UNPACED_RPM, clock, log: () => undefined, transport });
    await assert.rejects(
      () => generateGoogleAiEmbedding("teks uji", { config: { ...CONFIG, apiKey: "" }, gate }),
      AiProviderConfigError,
    );
    assert.equal(calls.length, 0);
  });

  it("serializes embeddings: one call in flight at a time", async () => {
    const values = Array.from({ length: 768 }, () => 0.1);
    const { transport, maxInFlight } = fakeTransport([
      json(200, { embedding: { values } }),
      json(200, { embedding: { values } }),
      json(200, { embedding: { values } }),
    ]);
    const { clock } = fakeClock();
    const gate = createNineRouterRateGate({ chatRpm: GOOGLE_AI_UNPACED_RPM, embedRpm: GOOGLE_AI_UNPACED_RPM, clock, log: () => undefined, transport });
    await Promise.all([
      generateGoogleAiEmbedding("a", { config: CONFIG, gate }),
      generateGoogleAiEmbedding("b", { config: CONFIG, gate }),
      generateGoogleAiEmbedding("c", { config: CONFIG, gate }),
    ]);
    assert.equal(maxInFlight(), 1);
  });
});
