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
/**
 * Pacing sentinel used when no RPM cap is configured. It is not a Google quota: the AI Studio
 * rate-limit page sits behind a Google login and could not be read. Concurrency stays at one
 * call at a time regardless.
 */
export const GOOGLE_AI_UNPACED_RPM = 60_000;

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
    chatRpm: positiveNumber(lookup("GOOGLE_AI_CHAT_RPM")) ?? GOOGLE_AI_UNPACED_RPM,
    embedRpm: positiveNumber(lookup("GOOGLE_AI_EMBED_RPM")) ?? GOOGLE_AI_UNPACED_RPM,
  };
}

const defaultLog: AiLogger = (line) => console.log(line);

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
  readonly fallbackModel: string;
  readonly timeoutMs: number;
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

  return async (input, init) => {
    if (!isGoogleChatUrl(requestUrl(input)) || typeof init?.body !== "string") {
      return options.transport(input, init);
    }
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(init.body) as Record<string, unknown>;
    } catch {
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
  options: { readonly transport?: NineRouterFetch; readonly log?: AiLogger } = {},
): NineRouterRateGate {
  const current = getNineRouterRateGate();
  if (installedGoogleGate !== undefined && current === installedGoogleGate) return current;
  const transport = createGoogleChatFallbackFetch({
    transport: options.transport ?? NATIVE_FETCH,
    fallbackModel: config.fallbackChatModel,
    timeoutMs: config.timeoutMs,
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
}

let embeddingQueue: Promise<unknown> = Promise.resolve();

async function postEmbedding(gate: NineRouterRateGate, endpoint: string, init: RequestInit): Promise<Response> {
  const slot = await gate.acquire("embed");
  try {
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
    const endpoint = `${GOOGLE_AI_NATIVE_BASE_URL}/models/${encodeURIComponent(config.embeddingModel)}:embedContent`;
    const response = await postEmbedding(gate, endpoint, {
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
