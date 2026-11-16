/**
 * HOSTED-12: Google AI Studio (Gemini API) provider for the live AI calls.
 *
 * Chat uses the documented OpenAI-compatible route. Mastra's `openai` provider and the
 * triage `choices[]` parser then work unchanged, and the shared rate gate still matches
 * `/chat/completions`. Embeddings use native `models/{model}:embedContent` with
 * `output_dimensionality`, because the compat embeddings route's `dimensions` parameter
 * is not documented.
 *
 * Fallback: one retry on the fallback model for HTTP 429, 500, 503 or 404 (model not
 * found). 400 and 403 are never retried. The fallback sits below the gate's `inspect`,
 * so a primary 429 never starts the chat cooldown. Only the final response is inspected.
 *
 * HOSTED-14: the free-tier caps are enforced at this same transport, beneath the gate. Every Google send
 * (chat primary, chat fallback, Mastra and triage through the gate, and embeddings) reserves one send against
 * its own model's per-run budget before it leaves the process. The budget is floor(RPD / runs per day) per model
 * in fixed windows of 24 h / runs per day. A refused send throws GoogleAiBudgetExhaustedError with code
 * `rate_limited`, so the job defers without consuming an attempt and stays queued. RPM pacing stays in the shared
 * gate. Each acquired slot sends at most one primary and one fallback request, so each model stays within its RPM.
 *
 * Imports nothing from Mastra, so the Worker can import it the same way it imports
 * `apps/db`. Logs carry counts and status codes only: never keys, endpoints that carry
 * keys, prompts, or response bodies.
 */
import {
  createNineRouterRateGate,
  getNineRouterRateGate,
  setNineRouterRateGate,
  type NineRouterFetch,
  type NineRouterRateGate,
} from "../../../db/src/ninerouter-rate-gate.js";

export const GOOGLE_AI_PROVIDER = "google_ai_studio" as const;
export const GOOGLE_AI_OPENAI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/openai";
export const GOOGLE_AI_NATIVE_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";
/** Owner decision 17 Nov 2026; bare IDs with the Gemini API directly, no provider prefix. */
export const GOOGLE_AI_DEFAULT_CHAT_MODEL = "gemini-3.5-flash-lite";
export const GOOGLE_AI_DEFAULT_FALLBACK_CHAT_MODEL = "gemini-3.1-flash-lite";
/** Verified on ai.google.dev (Embeddings, 17 Nov 2026): the stable ID, not the gateway's `-preview` alias. */
export const GOOGLE_AI_DEFAULT_EMBEDDING_MODEL = "gemini-embedding-2";
export const GOOGLE_AI_EMBEDDING_DIMENSIONS = 768;
export const GOOGLE_AI_DEFAULT_TIMEOUT_MS = 60_000;
/** Owner decision 17 Nov 2026: Google AI Studio free-tier caps, per model. Env values override them. */
export const GOOGLE_AI_DEFAULT_CHAT_RPM = 15;
export const GOOGLE_AI_DEFAULT_EMBED_RPM = 100;
export const GOOGLE_AI_DEFAULT_CHAT_RPD = 500;
export const GOOGLE_AI_DEFAULT_EMBED_RPD = 1000;
export const GOOGLE_AI_DEFAULT_RUNS_PER_DAY = 48;
/** Effectively unpaced RPM for tests that inject a fake clock. Not used for production config. */
export const GOOGLE_AI_UNPACED_RPM = 60_000;
const DAY_MS = 86_400_000;

export type AiProviderKind = "ninerouter" | typeof GOOGLE_AI_PROVIDER;
export type AiLogger = (line: string) => void;
export type EnvLookup = (name: string) => string | undefined;

export class AiProviderConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AiProviderConfigError";
  }
}

export function processEnvLookup(name: string): string | undefined {
  if (typeof process === "undefined") return undefined;
  const value = process.env?.[name]?.trim();
  return value ? value : undefined;
}

export function resolveAiProviderKind(raw: string | undefined): AiProviderKind {
  const value = raw?.trim().toLowerCase();
  if (!value || value === "ninerouter") return "ninerouter";
  if (value === GOOGLE_AI_PROVIDER) return GOOGLE_AI_PROVIDER;
  throw new AiProviderConfigError("AI_PROVIDER must be ninerouter or google_ai_studio");
}

export function getAiProviderKind(lookup: EnvLookup = processEnvLookup): AiProviderKind {
  return resolveAiProviderKind(lookup("AI_PROVIDER"));
}

export interface GoogleAiConfig {
  readonly apiKey: string;
  readonly chatModel: string;
  readonly fallbackChatModel: string;
  readonly embeddingModel: string;
  readonly embeddingDimensions: number;
  readonly timeoutMs: number;
  readonly chatRpm: number;
  readonly embedRpm: number;
  /** HOSTED-14: requests per day, per chat model (primary and fallback each). */
  readonly chatRpd: number;
  /** HOSTED-14: requests per day, for the embedding model. */
  readonly embedRpd: number;
  /** HOSTED-14: scheduled runs per day. The per-run budget is the daily cap divided by this. */
  readonly runsPerDay: number;
}

function positiveNumber(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

export function getGoogleAiConfig(lookup: EnvLookup = processEnvLookup): GoogleAiConfig {
  return {
    apiKey: lookup("GOOGLE_AI_API_KEY") ?? "",
    chatModel: lookup("GOOGLE_AI_CHAT_MODEL") ?? GOOGLE_AI_DEFAULT_CHAT_MODEL,
    fallbackChatModel: lookup("GOOGLE_AI_FALLBACK_CHAT_MODEL") ?? GOOGLE_AI_DEFAULT_FALLBACK_CHAT_MODEL,
    embeddingModel: lookup("GOOGLE_AI_EMBEDDING_MODEL") ?? GOOGLE_AI_DEFAULT_EMBEDDING_MODEL,
    embeddingDimensions: GOOGLE_AI_EMBEDDING_DIMENSIONS,
    timeoutMs:
      positiveNumber(lookup("GOOGLE_AI_TIMEOUT_MS")) ??
      positiveNumber(lookup("NINEROUTER_TIMEOUT_MS")) ??
      GOOGLE_AI_DEFAULT_TIMEOUT_MS,
    chatRpm: positiveNumber(lookup("GOOGLE_AI_CHAT_RPM")) ?? GOOGLE_AI_DEFAULT_CHAT_RPM,
    embedRpm: positiveNumber(lookup("GOOGLE_AI_EMBED_RPM")) ?? GOOGLE_AI_DEFAULT_EMBED_RPM,
    chatRpd: positiveNumber(lookup("GOOGLE_AI_CHAT_RPD")) ?? GOOGLE_AI_DEFAULT_CHAT_RPD,
    embedRpd: positiveNumber(lookup("GOOGLE_AI_EMBED_RPD")) ?? GOOGLE_AI_DEFAULT_EMBED_RPD,
    runsPerDay: positiveNumber(lookup("GOOGLE_AI_RUNS_PER_DAY")) ?? GOOGLE_AI_DEFAULT_RUNS_PER_DAY,
  };
}

const defaultLog: AiLogger = (line) => console.log(line);

/** HOSTED-14: a send refused by the per-run budget. It carries the gate's `rate_limited` code, so it defers the job. */
export class GoogleAiBudgetExhaustedError extends Error {
  readonly code = "rate_limited" as const;
  readonly retryAfterMs: number;

  constructor(kind: "chat" | "embed", retryAfterMs: number) {
    super(`Google AI Studio ${kind} budget for this run is spent; the job stays queued`);
    this.name = "GoogleAiBudgetExhaustedError";
    this.retryAfterMs = retryAfterMs;
  }
}

export interface GoogleAiRunBudgetOptions {
  /** Sends allowed per chat model in one window. The primary and the fallback each get this. */
  readonly chatPerRun: number;
  /** Sends allowed for the embedding model in one window. */
  readonly embedPerRun: number;
  /** Window length: 24 h divided by the runs per day. */
  readonly windowMs: number;
  readonly now?: () => number;
  readonly log?: AiLogger;
}

/**
 * HOSTED-14: per-model send budgets. Windows are fixed and aligned to the epoch, so a long-lived process
 * (serve:live, headless ingest) and a fresh process per run both stay within floor(RPD / runs) per model per
 * window, and so within RPD per day. Counts are per process. Logs carry counts only.
 */
export class GoogleAiRunBudget {
  private readonly windows = new Map<string, { index: number; sent: number }>();
  private readonly options: GoogleAiRunBudgetOptions;
  private readonly now: () => number;
  private readonly log: AiLogger;

  constructor(options: GoogleAiRunBudgetOptions) {
    this.options = options;
    this.now = options.now ?? (() => Date.now());
    this.log = options.log ?? defaultLog;
  }

  /** Reserves one send for `model`, or throws before anything is sent. Call only immediately before the send. */
  reserve(kind: "chat" | "embed", model: string, label: string): void {
    const now = this.now();
    const windowMs = this.options.windowMs;
    const index = Math.floor(now / windowMs);
    const limit = kind === "chat" ? this.options.chatPerRun : this.options.embedPerRun;
    const key = `${kind}:${model}`;
    let entry = this.windows.get(key);
    if (entry === undefined || entry.index !== index) {
      entry = { index, sent: 0 };
      this.windows.set(key, entry);
    }
    if (entry.sent >= limit) {
      this.log(`[AI] budget ${label} exhausted for this run`);
      throw new GoogleAiBudgetExhaustedError(kind, (index + 1) * windowMs - now);
    }
    entry.sent += 1;
    this.log(`[AI] budget ${label} remaining=${limit - entry.sent}`);
  }

  /** Sends still allowed for `model` in the current window. Read-only: it reserves nothing. */
  remaining(kind: "chat" | "embed", model: string): number {
    const index = Math.floor(this.now() / this.options.windowMs);
    const limit = kind === "chat" ? this.options.chatPerRun : this.options.embedPerRun;
    const entry = this.windows.get(`${kind}:${model}`);
    const sent = entry !== undefined && entry.index === index ? entry.sent : 0;
    return Math.max(0, limit - sent);
  }
}

/** Per-run budgets from the config: floor(RPD / runs per day) for each model, in windows of 24 h / runs per day. */
export function createGoogleAiRunBudget(
  config: GoogleAiConfig,
  options: { readonly now?: () => number; readonly log?: AiLogger } = {},
): GoogleAiRunBudget {
  const runs = config.runsPerDay;
  return new GoogleAiRunBudget({
    chatPerRun: Math.floor(config.chatRpd / runs),
    embedPerRun: Math.floor(config.embedRpd / runs),
    windowMs: Math.floor(DAY_MS / runs),
    now: options.now,
    log: options.log,
  });
}

let processBudget: GoogleAiRunBudget | undefined;

/**
 * HOSTED-14: the one RPD budget for this process. Worker triage (news-triage-composition imports this module) and the
 * intelligence job runner both reach it through this getter, so every chat and embedding send in the process counts
 * against the same per-model windows. It is created once, from the config passed by the first caller (env by default),
 * and every later caller gets the same instance, whatever config it passes.
 */
export function getGoogleAiRunBudget(config?: GoogleAiConfig): GoogleAiRunBudget {
  if (processBudget === undefined) {
    processBudget = createGoogleAiRunBudget(config ?? getGoogleAiConfig(processEnvLookup));
  }
  return processBudget;
}

/**
 * Test seam, the same pattern as setNineRouterRateGate. Passing undefined clears the singleton, so the next
 * getGoogleAiRunBudget call creates it again.
 */
export function setGoogleAiRunBudget(budget: GoogleAiRunBudget | undefined): void {
  processBudget = budget;
}

function requestUrl(input: string | URL | Request): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

export function isGoogleChatUrl(url: string): boolean {
  return url.startsWith(`${GOOGLE_AI_OPENAI_BASE_URL}/chat/completions`);
}

/** Only these statuses move a chat call to the fallback model. 400 and 403 never do. */
export function isFallbackStatus(status: number): boolean {
  return status === 429 || status === 500 || status === 503 || status === 404;
}

export interface GoogleChatFallbackOptions {
  /** Real transport. Must never be the gate's own wrapper, or the call re-enters the gate. */
  readonly transport: NineRouterFetch;
  readonly primaryModel: string;
  readonly fallbackModel: string;
  readonly timeoutMs: number;
  /** HOSTED-14: reserves each send against its own model's per-run budget. */
  readonly budget: GoogleAiRunBudget;
  readonly log?: AiLogger;
}

/**
 * Wraps a transport so that Google chat completions retry once on the fallback model when the
 * primary answers with a fallback status. Any other URL passes through untouched.
 */
export function createGoogleChatFallbackFetch(options: GoogleChatFallbackOptions): NineRouterFetch {
  const log = options.log ?? defaultLog;

  const send = (input: string | URL | Request, init: RequestInit | undefined, body?: string): Promise<Response> => {
    const signal = init?.signal
      ? AbortSignal.any([init.signal, AbortSignal.timeout(options.timeoutMs)])
      : AbortSignal.timeout(options.timeoutMs);
    return options.transport(input, { ...init, body: body ?? init?.body, signal });
  };

  const labelFor = (model: string): string => (model === options.fallbackModel ? "chat-fallback" : "chat");

  return async (input, init) => {
    if (!isGoogleChatUrl(requestUrl(input))) {
      return options.transport(input, init);
    }
    // HOSTED-14: the send is reserved against its own model before it leaves. A body that is not JSON counts as the primary.
    const rawBody = typeof init?.body === "string" ? init.body : undefined;
    let parsed: Record<string, unknown> | null = null;
    if (rawBody !== undefined) {
      try {
        parsed = JSON.parse(rawBody) as Record<string, unknown>;
      } catch {
        parsed = null;
      }
    }
    const requested = typeof parsed?.model === "string" ? parsed.model : options.primaryModel;
    options.budget.reserve("chat", requested, labelFor(requested));
    if (rawBody === undefined || parsed === null) {
      return options.transport(input, init);
    }
    if (typeof parsed.model !== "string" || parsed.model === options.fallbackModel) {
      return send(input, init);
    }

    const primary = await send(input, init);
    if (!isFallbackStatus(primary.status)) {
      log(primary.ok ? "[AI] model=primary ok" : `[AI] model=primary failed status=${primary.status}`);
      return primary;
    }
    await primary.body?.cancel().catch(() => undefined);
    log(`[AI] model=primary failed status=${primary.status}`);
    log("[AI] fallback used");
    options.budget.reserve("chat", options.fallbackModel, "chat-fallback");
    const fallback = await send(
      input,
      init,
      JSON.stringify({ ...parsed, model: options.fallbackModel }),
    );
    log(fallback.ok ? "[AI] model=fallback ok" : `[AI] model=fallback failed status=${fallback.status}`);
    return fallback;
  };
}

/** Captured at module load, before any gate wrapper is installed on globalThis.fetch. */
const NATIVE_FETCH: NineRouterFetch = globalThis.fetch.bind(globalThis);

let installedGoogleGate: NineRouterRateGate | undefined;

/**
 * Installs the process-wide gate for Google mode: pacing and one-in-flight chat from the
 * shared AI-RATE-01 gate, with the fallback transport beneath it. It must run before the
 * global fetch is patched. Idempotent for the same process-wide gate.
 */
export function installGoogleAiRateGate(
  config: GoogleAiConfig,
  options: { readonly transport?: NineRouterFetch; readonly log?: AiLogger; readonly budget?: GoogleAiRunBudget } = {},
): NineRouterRateGate {
  const current = getNineRouterRateGate();
  if (installedGoogleGate !== undefined && current === installedGoogleGate) return current;
  const transport = createGoogleChatFallbackFetch({
    transport: options.transport ?? NATIVE_FETCH,
    primaryModel: config.chatModel,
    fallbackModel: config.fallbackChatModel,
    timeoutMs: config.timeoutMs,
    budget: options.budget ?? getGoogleAiRunBudget(config),
    log: options.log,
  });
  const gate = createNineRouterRateGate({ chatRpm: config.chatRpm, embedRpm: config.embedRpm, transport });
  setNineRouterRateGate(gate);
  installedGoogleGate = gate;
  return gate;
}

export interface GoogleEmbeddingOptions {
  readonly config?: GoogleAiConfig;
  readonly gate?: NineRouterRateGate;
  /** HOSTED-14: defaults to the process budget for the config. */
  readonly budget?: GoogleAiRunBudget;
}

let embeddingQueue: Promise<unknown> = Promise.resolve();

async function postEmbedding(
  gate: NineRouterRateGate,
  budget: GoogleAiRunBudget,
  model: string,
  endpoint: string,
  init: RequestInit,
): Promise<Response> {
  const slot = await gate.acquire("embed");
  try {
    // HOSTED-14: reserved after pacing and right before the send. A refused send is never transmitted.
    budget.reserve("embed", model, "embed");
    const response = await gate.transport()(endpoint, init);
    // AI-RATE-01: a 429 or rate-like 503 throws RateLimitedError here.
    return await gate.inspect("embed", response);
  } finally {
    slot.release();
  }
}

/**
 * One Gemini embedding at a time, paced by the embed bucket. Fails closed: a non-768
 * vector or a non-finite value throws, and no response body is ever included in an error.
 */
export async function generateGoogleAiEmbedding(
  text: string,
  options: GoogleEmbeddingOptions = {},
): Promise<readonly number[]> {
  const config = options.config ?? getGoogleAiConfig();
  if (!config.apiKey) {
    throw new AiProviderConfigError(
      "Google AI Studio credentials required: GOOGLE_AI_API_KEY must be set in live mode",
    );
  }
  const run = async (): Promise<readonly number[]> => {
    const gate = options.gate ?? getNineRouterRateGate();
    const budget = options.budget ?? getGoogleAiRunBudget(config);
    const endpoint = `${GOOGLE_AI_NATIVE_BASE_URL}/models/${encodeURIComponent(config.embeddingModel)}:embedContent`;
    const response = await postEmbedding(gate, budget, config.embeddingModel, endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": config.apiKey,
      },
      body: JSON.stringify({
        content: { parts: [{ text }] },
        output_dimensionality: config.embeddingDimensions,
      }),
      signal: AbortSignal.timeout(config.timeoutMs),
    });
    if (!response.ok) {
      throw new Error(`Google AI embedding request failed (HTTP ${response.status})`);
    }
    const payload = (await response.json()) as { embedding?: { values?: unknown } } | null;
    const values = payload?.embedding?.values;
    const expected = config.embeddingDimensions;
    if (!Array.isArray(values) || values.length !== expected) {
      const got = Array.isArray(values) ? values.length : 0;
      throw new Error(`Google AI embedding dimension mismatch: expected ${expected}, got ${got}`);
    }
    for (let i = 0; i < values.length; i++) {
      if (typeof values[i] !== "number" || !Number.isFinite(values[i])) {
        throw new Error(`Google AI embedding has a non-finite value at index ${i}`);
      }
    }
    return values as number[];
  };

  const next = embeddingQueue.then(run, run);
  embeddingQueue = next.catch(() => undefined);
  return next;
}
