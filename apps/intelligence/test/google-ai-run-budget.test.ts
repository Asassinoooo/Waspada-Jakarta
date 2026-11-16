/**
 * HOSTED-14: the Google AI Studio free-tier caps are enforced in code. Fake clock and fake transport only: no network.
 * Budget per model = floor(RPD / runs per day). Window = 24 h / runs per day, aligned to the epoch.
 */
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import {
  GOOGLE_AI_DEFAULT_CHAT_RPM,
  GOOGLE_AI_DEFAULT_EMBED_RPM,
  GOOGLE_AI_OPENAI_BASE_URL,
  GoogleAiBudgetExhaustedError,
  GoogleAiRunBudget,
  createGoogleAiRunBudget,
  createGoogleChatFallbackFetch,
  generateGoogleAiEmbedding,
  getGoogleAiConfig,
  getGoogleAiRunBudget,
  installGoogleAiRateGate,
  setGoogleAiRunBudget,
  type GoogleAiConfig,
} from "../src/providers/google-ai-adapter.js";
import { classifyJobError } from "../src/job-runner.js";
import {
  createNineRouterRateGate,
  setNineRouterRateGate,
  type NineRouterFetch,
} from "../../db/src/ninerouter-rate-gate.js";

const TEST_KEY = "test-key-not-a-secret-0002";
const PRIMARY = "gemini-3.5-flash-lite";
const FALLBACK = "gemini-3.1-flash-lite";
const CHAT_URL = `${GOOGLE_AI_OPENAI_BASE_URL}/chat/completions`;
/** Aligned to a window boundary: 1_800_000 ms windows at 48 runs a day. */
const T0 = 1_800_000_000_000;
const WINDOW_MS = 1_800_000;

function config(overrides: Partial<GoogleAiConfig> = {}): GoogleAiConfig {
  return {
    apiKey: TEST_KEY,
    chatModel: PRIMARY,
    fallbackChatModel: FALLBACK,
    embeddingModel: "gemini-embedding-2",
    embeddingDimensions: 768,
    timeoutMs: 60_000,
    chatRpm: GOOGLE_AI_DEFAULT_CHAT_RPM,
    embedRpm: GOOGLE_AI_DEFAULT_EMBED_RPM,
    chatRpd: 500,
    embedRpd: 1000,
    runsPerDay: 48,
    ...overrides,
  };
}

/** Fake clock: `sleep` advances time, so pacing is deterministic. */
function fakeClock(startMs: number) {
  const state = { nowMs: startMs };
  return {
    state,
    clock: {
      now: () => state.nowMs,
      sleep: async (ms: number) => {
        state.nowMs += ms;
      },
    },
  };
}

interface Sent {
  readonly url: string;
  readonly model: string | undefined;
  readonly atMs: number;
}

/** Fake transport: records every send and answers with `respond`. */
function recordingTransport(now: () => number, respond: (url: string, model: string | undefined) => Response) {
  const sent: Sent[] = [];
  const transport: NineRouterFetch = async (input, init) => {
    const url = typeof input === "string" ? input : String(input);
    const model = typeof init?.body === "string" ? (JSON.parse(init.body) as { model?: string }).model : undefined;
    sent.push({ url, model, atMs: now() });
    return respond(url, model);
  };
  return { transport, sent };
}

const chatOk = (): Response =>
  new Response(JSON.stringify({ choices: [{ message: { content: "{}" } }] }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
const statusOnly = (status: number): Response => new Response("", { status });
const embedOk = (): Response =>
  new Response(JSON.stringify({ embedding: { values: Array.from({ length: 768 }, () => 0.1) } }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

function chatInit(model: string): RequestInit {
  return { method: "POST", body: JSON.stringify({ model, messages: [], stream: false }) };
}

function isBudgetRefusal(err: unknown): boolean {
  return err instanceof GoogleAiBudgetExhaustedError && err.code === "rate_limited" && classifyJobError(err) === "rate_limited";
}

describe("HOSTED-14 config defaults", () => {
  it("defaults to the owner's free-tier caps and env values override them", () => {
    const defaults = getGoogleAiConfig(() => undefined);
    assert.equal(defaults.chatRpm, 15);
    assert.equal(defaults.embedRpm, 100);
    assert.equal(defaults.chatRpd, 500);
    assert.equal(defaults.embedRpd, 1000);
    assert.equal(defaults.runsPerDay, 48);

    const env: Record<string, string> = { GOOGLE_AI_CHAT_RPD: "960", GOOGLE_AI_EMBED_RPD: "bogus", GOOGLE_AI_RUNS_PER_DAY: "24" };
    const overridden = getGoogleAiConfig((name) => env[name]);
    assert.equal(overridden.chatRpd, 960);
    assert.equal(overridden.embedRpd, 1000, "an invalid value falls back to the default");
    assert.equal(overridden.runsPerDay, 24);
  });

  it("derives the chat budget: 10 sends per 30-minute window", async () => {
    const { state } = fakeClock(T0);
    const budget = createGoogleAiRunBudget(config(), { now: () => state.nowMs, log: () => undefined });
    const { transport, sent } = recordingTransport(() => state.nowMs, () => chatOk());
    const wrapper = createGoogleChatFallbackFetch({
      transport,
      primaryModel: PRIMARY,
      fallbackModel: FALLBACK,
      timeoutMs: 60_000,
      budget,
      log: () => undefined,
    });
    for (let i = 0; i < 10; i++) await wrapper(CHAT_URL, chatInit(PRIMARY));
    await assert.rejects(() => wrapper(CHAT_URL, chatInit(PRIMARY)), isBudgetRefusal);
    assert.equal(sent.length, 10, "the eleventh chat call is not sent");
  });
});

describe("HOSTED-14 per-run chat budget", () => {
  it("refuses the eleventh chat call before any send and keeps the job queued", async () => {
    const { state } = fakeClock(T0 + 1_000);
    const logs: string[] = [];
    const budget = createGoogleAiRunBudget(config(), { now: () => state.nowMs, log: (line) => logs.push(line) });
    const { transport, sent } = recordingTransport(() => state.nowMs, () => chatOk());
    const wrapper = createGoogleChatFallbackFetch({
      transport,
      primaryModel: PRIMARY,
      fallbackModel: FALLBACK,
      timeoutMs: 60_000,
      budget,
      log: () => undefined,
    });

    for (let i = 0; i < 10; i++) {
      const response = await wrapper(CHAT_URL, chatInit(PRIMARY));
      assert.equal(response.status, 200);
    }
    let refusal: unknown;
    await assert.rejects(
      () => wrapper(CHAT_URL, chatInit(PRIMARY)),
      (err: unknown) => {
        refusal = err;
        return isBudgetRefusal(err);
      },
    );
    assert.equal(sent.length, 10, "exactly the budgeted sends reached the transport");
    // The job runner defers by retryAfterMs: the rest of the current 30-minute window, here 1_799_000 ms.
    assert.equal((refusal as GoogleAiBudgetExhaustedError).retryAfterMs, WINDOW_MS - 1_000);
    assert.ok(logs.includes("[AI] budget chat remaining=0"));
    assert.ok(logs.includes("[AI] budget chat exhausted for this run"));
  });

  it("resets when the next window starts, which is the next run", async () => {
    const { state } = fakeClock(T0);
    const budget = createGoogleAiRunBudget(config(), { now: () => state.nowMs, log: () => undefined });
    const { transport, sent } = recordingTransport(() => state.nowMs, () => chatOk());
    const wrapper = createGoogleChatFallbackFetch({ transport, primaryModel: PRIMARY, fallbackModel: FALLBACK, timeoutMs: 60_000, budget, log: () => undefined });

    for (let i = 0; i < 10; i++) await wrapper(CHAT_URL, chatInit(PRIMARY));
    await assert.rejects(() => wrapper(CHAT_URL, chatInit(PRIMARY)), isBudgetRefusal);
    state.nowMs = T0 + WINDOW_MS;
    const response = await wrapper(CHAT_URL, chatInit(PRIMARY));
    assert.equal(response.status, 200);
    assert.equal(sent.length, 11);
  });

  it("paces each acquired chat slot at the RPM interval on a fake clock", async () => {
    const { state, clock } = fakeClock(T0);
    const budget = createGoogleAiRunBudget(config(), { now: () => state.nowMs, log: () => undefined });
    const { transport, sent } = recordingTransport(() => state.nowMs, () => chatOk());
    const wrapper = createGoogleChatFallbackFetch({ transport, primaryModel: PRIMARY, fallbackModel: FALLBACK, timeoutMs: 60_000, budget, log: () => undefined });
    const gate = createNineRouterRateGate({ chatRpm: 15, embedRpm: 100, clock, log: () => undefined, transport: wrapper });

    await gate.request(CHAT_URL, chatInit(PRIMARY));
    await gate.request(CHAT_URL, chatInit(PRIMARY));
    assert.equal(sent.length, 2);
    assert.ok(sent[1]!.atMs - sent[0]!.atMs >= 4_000, "15 RPM is one chat slot every 4 s");
  });
});

describe("HOSTED-14 fallback and primary budgets are separate", () => {
  it("a primary 429 spends the fallback's own budget, and an exhausted primary never routes to the fallback", async () => {
    const { state } = fakeClock(T0);
    const budget = new GoogleAiRunBudget({ chatPerRun: 2, embedPerRun: 20, windowMs: WINDOW_MS, now: () => state.nowMs, log: () => undefined });
    const { transport, sent } = recordingTransport(() => state.nowMs, (_url, model) => (model === PRIMARY ? statusOnly(429) : chatOk()));
    const wrapper = createGoogleChatFallbackFetch({ transport, primaryModel: PRIMARY, fallbackModel: FALLBACK, timeoutMs: 60_000, budget, log: () => undefined });

    assert.equal((await wrapper(CHAT_URL, chatInit(PRIMARY))).status, 200);
    assert.equal((await wrapper(CHAT_URL, chatInit(PRIMARY))).status, 200);
    await assert.rejects(() => wrapper(CHAT_URL, chatInit(PRIMARY)), isBudgetRefusal);
    assert.deepEqual(sent.map((s) => s.model), [PRIMARY, FALLBACK, PRIMARY, FALLBACK], "the refused third call sends nothing");
  });

  it("an exhausted primary leaves the fallback budget unspent", async () => {
    const { state } = fakeClock(T0);
    const budget = new GoogleAiRunBudget({ chatPerRun: 3, embedPerRun: 20, windowMs: WINDOW_MS, now: () => state.nowMs, log: () => undefined });
    const { transport, sent } = recordingTransport(() => state.nowMs, () => chatOk());
    const wrapper = createGoogleChatFallbackFetch({ transport, primaryModel: PRIMARY, fallbackModel: FALLBACK, timeoutMs: 60_000, budget, log: () => undefined });

    for (let i = 0; i < 3; i++) await wrapper(CHAT_URL, chatInit(PRIMARY));
    await assert.rejects(() => wrapper(CHAT_URL, chatInit(PRIMARY)), isBudgetRefusal);
    assert.equal((await wrapper(CHAT_URL, chatInit(FALLBACK))).status, 200, "the fallback still has its own budget");
    assert.deepEqual(sent.map((s) => s.model), [PRIMARY, PRIMARY, PRIMARY, FALLBACK]);
  });

  it("refuses a fallback attempt when the fallback budget is spent, and does not send it", async () => {
    const { state } = fakeClock(T0);
    const budget = new GoogleAiRunBudget({ chatPerRun: 1, embedPerRun: 20, windowMs: WINDOW_MS, now: () => state.nowMs, log: () => undefined });
    const { transport, sent } = recordingTransport(() => state.nowMs, (_url, model) => (model === PRIMARY ? statusOnly(429) : chatOk()));
    const wrapper = createGoogleChatFallbackFetch({ transport, primaryModel: PRIMARY, fallbackModel: FALLBACK, timeoutMs: 60_000, budget, log: () => undefined });

    assert.equal((await wrapper(CHAT_URL, chatInit(FALLBACK))).status, 200, "one direct fallback send uses the fallback budget");
    await assert.rejects(() => wrapper(CHAT_URL, chatInit(PRIMARY)), isBudgetRefusal);
    assert.deepEqual(sent.map((s) => s.model), [FALLBACK, PRIMARY], "the primary was sent, its fallback was refused and never sent");
  });
});

describe("HOSTED-14 embedding budget", () => {
  it("allows 20 embeddings per run, refuses the 21st before sending, and keeps the chat budget separate", async () => {
    const { state, clock } = fakeClock(T0);
    const logs: string[] = [];
    const budget = createGoogleAiRunBudget(config(), { now: () => state.nowMs, log: (line) => logs.push(line) });
    const { transport, sent } = recordingTransport(() => state.nowMs, (url) => (url.includes(":embedContent") ? embedOk() : chatOk()));
    const gate = createNineRouterRateGate({ chatRpm: 15, embedRpm: 100, clock, log: () => undefined, transport });

    for (let i = 0; i < 20; i++) {
      const vector = await generateGoogleAiEmbedding(`teks ${i}`, { config: config(), gate, budget });
      assert.equal(vector.length, 768);
    }
    await assert.rejects(
      () => generateGoogleAiEmbedding("teks 21", { config: config(), gate, budget }),
      isBudgetRefusal,
    );
    assert.equal(sent.filter((s) => s.url.includes(":embedContent")).length, 20);
    assert.ok(logs.includes("[AI] budget embed remaining=0"));

    const wrapper = createGoogleChatFallbackFetch({ transport, primaryModel: PRIMARY, fallbackModel: FALLBACK, timeoutMs: 60_000, budget, log: () => undefined });
    assert.equal((await wrapper(CHAT_URL, chatInit(PRIMARY))).status, 200, "embedding use does not spend the chat budget");
  });

  it("logs carry counts only: never the key, the endpoint or the prompt", async () => {
    const { state } = fakeClock(T0);
    const logs: string[] = [];
    const budget = createGoogleAiRunBudget(config(), { now: () => state.nowMs, log: (line) => logs.push(line) });
    const { transport } = recordingTransport(() => state.nowMs, () => chatOk());
    const wrapper = createGoogleChatFallbackFetch({ transport, primaryModel: PRIMARY, fallbackModel: FALLBACK, timeoutMs: 60_000, budget, log: (line) => logs.push(line) });
    for (let i = 0; i < 10; i++) await wrapper(CHAT_URL, chatInit(PRIMARY));
    await assert.rejects(() => wrapper(CHAT_URL, chatInit(PRIMARY)), isBudgetRefusal);

    assert.ok(logs.length > 0);
    for (const line of logs) {
      assert.ok(!line.includes(TEST_KEY), "no key");
      assert.ok(!line.includes("generativelanguage"), "no endpoint");
      assert.ok(!line.includes("messages"), "no prompt");
    }
  });
});

describe("HOSTED-14 one process-wide budget", () => {
  after(() => {
    setGoogleAiRunBudget(undefined);
    setNineRouterRateGate(undefined);
  });

  it("every caller gets the same instance, created once from the first config", () => {
    setGoogleAiRunBudget(undefined);
    const first = getGoogleAiRunBudget(getGoogleAiConfig(() => undefined));
    const second = getGoogleAiRunBudget();
    const third = getGoogleAiRunBudget(config({ chatRpd: 1 }));
    assert.strictEqual(second, first);
    assert.strictEqual(third, first, "a later config does not create a second budget");
    assert.equal(first.remaining("chat", PRIMARY), 10, "defaults: 500 / 48 per run");
    assert.equal(first.remaining("embed", "gemini-embedding-2"), 20, "defaults: 1000 / 48 per run");
  });

  it("a call through one caller lowers the remaining count that the other caller sees", async () => {
    const { state } = fakeClock(T0);
    setGoogleAiRunBudget(createGoogleAiRunBudget(config(), { now: () => state.nowMs, log: () => undefined }));
    const observer = getGoogleAiRunBudget();
    assert.equal(observer.remaining("chat", PRIMARY), 10);

    // Caller A: the chat wrapper, as installGoogleAiRateGate builds it.
    const { transport, sent } = recordingTransport(() => state.nowMs, (url) => (url.includes(":embedContent") ? embedOk() : chatOk()));
    const chatCaller = createGoogleChatFallbackFetch({
      transport,
      primaryModel: PRIMARY,
      fallbackModel: FALLBACK,
      timeoutMs: 60_000,
      budget: getGoogleAiRunBudget(),
      log: () => undefined,
    });
    await chatCaller(CHAT_URL, chatInit(PRIMARY));
    assert.equal(observer.remaining("chat", PRIMARY), 9, "the chat call is visible to the other caller");

    // Caller B: an embedding that takes the default budget, not one passed in.
    const { clock } = fakeClock(T0);
    const gate = createNineRouterRateGate({ chatRpm: 15, embedRpm: 100, clock, log: () => undefined, transport });
    await generateGoogleAiEmbedding("teks bersama", { config: config(), gate });
    assert.equal(observer.remaining("embed", "gemini-embedding-2"), 19, "the embedding is visible to the chat caller's budget too");
    assert.equal(sent.filter((s) => s.url.includes(":embedContent")).length, 1);
  });

  it("combined callers cannot exceed the chat cap of 10 per run", async () => {
    const { state } = fakeClock(T0);
    setGoogleAiRunBudget(createGoogleAiRunBudget(config(), { now: () => state.nowMs, log: () => undefined }));
    const { transport, sent } = recordingTransport(() => state.nowMs, () => chatOk());
    const make = () => createGoogleChatFallbackFetch({
      transport,
      primaryModel: PRIMARY,
      fallbackModel: FALLBACK,
      timeoutMs: 60_000,
      budget: getGoogleAiRunBudget(),
      log: () => undefined,
    });
    const callerA = make();
    const callerB = make();
    for (let i = 0; i < 6; i++) await callerA(CHAT_URL, chatInit(PRIMARY));
    for (let i = 0; i < 4; i++) await callerB(CHAT_URL, chatInit(PRIMARY));
    await assert.rejects(() => callerA(CHAT_URL, chatInit(PRIMARY)), isBudgetRefusal);
    await assert.rejects(() => callerB(CHAT_URL, chatInit(PRIMARY)), isBudgetRefusal);
    assert.equal(sent.length, 10, "the two callers together sent exactly the shared budget");
  });

  it("the Google-mode gate used by worker triage and Mastra reaches the same instance", async () => {
    const { state } = fakeClock(T0);
    setGoogleAiRunBudget(createGoogleAiRunBudget(config(), { now: () => state.nowMs, log: () => undefined }));
    setNineRouterRateGate(undefined);
    const { transport, sent } = recordingTransport(() => state.nowMs, () => chatOk());
    const gate = installGoogleAiRateGate(config(), { transport, log: () => undefined });
    // news-triage-composition sends chat through gate.transport(), the same wrapper the gate's global fetch uses.
    await gate.transport()(CHAT_URL, chatInit(PRIMARY));
    assert.equal(sent.length, 1);
    assert.equal(getGoogleAiRunBudget().remaining("chat", PRIMARY), 9);
  });
});
