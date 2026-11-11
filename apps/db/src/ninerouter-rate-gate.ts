/**
 * AI-RATE-01: process-wide pacing and cooldown for the NineRouter gateway.
 *
 * The free NineRouter model accepts only a few requests per minute. Every
 * NineRouter chat or embedding call in a process (Mastra job agents and the
 * live triage transport) goes through one gate instance, so the limit is
 * shared instead of per caller:
 *
 *  - chat bucket: paced to `NINEROUTER_CHAT_RPM` (default 10), one request in
 *    flight at a time, FIFO for waiting callers;
 *  - embedding bucket: paced to `NINEROUTER_EMBED_RPM` (default 30).
 *
 * HTTP 429, or 503 whose body mentions rate or quota, starts a cooldown for
 * that bucket. Every caller waits until the cooldown ends, and the gated call
 * throws `RateLimitedError` (`code === "rate_limited"`). Callers decide what a
 * rate limit means: the job runner defers the job, and triage records a
 * distinct `rate_limited` outcome. Nothing here retries.
 *
 * Logs never include keys, endpoints or response bodies.
 */

export type NineRouterRateBucket = "chat" | "embed";

export const DEFAULT_NINEROUTER_CHAT_RPM = 10;
export const DEFAULT_NINEROUTER_EMBED_RPM = 30;
/** Used when a 429/rate 503 carries no usable Retry-After. */
export const DEFAULT_RETRY_AFTER_MS = 60_000;
/** Floor so a `Retry-After: 0` cannot turn into a hot retry loop. */
export const MIN_RETRY_AFTER_MS = 1_000;
/** Upper bound on any cooldown, after jitter. */
export const MAX_RETRY_AFTER_MS = 15 * 60_000;
/** Jitter adds 0 to 20 percent to the base cooldown. */
export const RETRY_JITTER_FRACTION = 0.2;

const RATE_HINT_PATTERN = /\brate\b|rate[ _-]?limit|\bquota\b/i;

export class RateLimitedError extends Error {
  readonly code = "rate_limited" as const;
  readonly status: number;
  readonly retryAfterMs: number;
  readonly bucket: NineRouterRateBucket;

  constructor(input: { readonly retryAfterMs: number; readonly status: number; readonly bucket: NineRouterRateBucket }) {
    super(`NineRouter ${input.bucket} rate limited (HTTP ${input.status}); cooling down ${Math.ceil(input.retryAfterMs / 1000)} s`);
    this.name = "RateLimitedError";
    this.status = input.status;
    this.retryAfterMs = input.retryAfterMs;
    this.bucket = input.bucket;
  }
}

/**
 * Finds a `rate_limited` error in a value or its `.cause` chain. Mastra and
 * the AI SDK can wrap the gate's error. Returns null when there is none.
 */
export function findRateLimitedError(error: unknown): { readonly retryAfterMs: number | null } | null {
  let current: unknown = error;
  for (let depth = 0; depth < 8 && current !== null && typeof current === "object"; depth++) {
    const candidate = current as { code?: unknown; retryAfterMs?: unknown; cause?: unknown };
    if (candidate.code === "rate_limited") {
      const retryAfterMs = typeof candidate.retryAfterMs === "number" && Number.isFinite(candidate.retryAfterMs)
        ? candidate.retryAfterMs
        : null;
      return { retryAfterMs };
    }
    current = candidate.cause;
  }
  return null;
}

export function isRateLimitedError(error: unknown): boolean {
  return findRateLimitedError(error) !== null;
}

/** Parses Retry-After as delta-seconds or an HTTP date. Null when unusable. */
export function parseRetryAfterMs(header: string | null | undefined, nowMs: number): number | null {
  if (header === null || header === undefined) return null;
  const value = header.trim();
  if (value.length === 0) return null;
  if (/^\d+(\.\d+)?$/.test(value)) return Math.round(Number(value) * 1000);
  const dateMs = Date.parse(value);
  if (Number.isFinite(dateMs)) return Math.max(0, dateMs - nowMs);
  return null;
}

/**
 * Cooldown length for a rate-limited response: Retry-After (or 60 s), floored
 * at 1 s, plus 0-20 percent jitter, capped at 15 minutes.
 */
export function computeCooldownMs(
  retryAfterHeader: string | null | undefined,
  nowMs: number,
  random: () => number = Math.random,
): number {
  const base = Math.max(parseRetryAfterMs(retryAfterHeader, nowMs) ?? DEFAULT_RETRY_AFTER_MS, MIN_RETRY_AFTER_MS);
  const jitter = Math.min(Math.max(random(), 0), 1) * RETRY_JITTER_FRACTION;
  return Math.min(Math.round(base * (1 + jitter)), MAX_RETRY_AFTER_MS);
}

export interface NineRouterRateClock {
  now(): number;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

export type NineRouterFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface NineRouterRateGateOptions {
  readonly chatRpm?: number;
  readonly embedRpm?: number;
  readonly clock?: NineRouterRateClock;
  readonly random?: () => number;
  readonly log?: (message: string) => void;
  /** Fixed transport for the gated calls. Defaults to the current global fetch. */
  readonly transport?: NineRouterFetch;
}

export interface NineRouterSlot {
  release(): void;
}

export interface NineRouterRateGate {
  /** Bucket for a NineRouter chat or embedding URL, or null when not gated. */
  classify(input: string | URL | Request): NineRouterRateBucket | null;
  /** Waits for FIFO in-flight capacity and pacing; the caller must release. */
  acquire(bucket: NineRouterRateBucket, signal?: AbortSignal): Promise<NineRouterSlot>;
  /** Starts a cooldown for 429 / rate-like 503 responses and throws RateLimitedError. */
  inspect(bucket: NineRouterRateBucket, response: Response): Promise<Response>;
  /** Acquire, send through the transport, inspect, release. Non-NineRouter URLs pass through. */
  request(input: string | URL | Request, init?: RequestInit): Promise<Response>;
  /** The transport used by gated calls; never the installed gate wrapper. */
  transport(): NineRouterFetch;
  cooldownRemainingMs(bucket: NineRouterRateBucket): number;
  /**
   * AI-RPM-01: gateway requests this gate has sent, per bucket, since it was
   * created. Counts sent requests (including rate-limited ones), never content.
   */
  callCounts(): Readonly<Record<NineRouterRateBucket, number>>;
  /** Patches globalThis.fetch so NineRouter calls made through it are gated. Idempotent. */
  installGlobalFetch(beforeRequest?: (url: string, init: RequestInit | undefined) => RequestInit | undefined): void;
}

interface BucketState {
  readonly minIntervalMs: number;
  readonly maxInFlight: number;
  nextAt: number;
  cooldownUntil: number;
  active: number;
  readonly waiters: Array<() => void>;
}

function abortError(): Error {
  const error = new Error("aborted");
  error.name = "AbortError";
  return error;
}

function urlOf(input: string | URL | Request): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

const defaultClock: NineRouterRateClock = {
  now: () => Date.now(),
  sleep: (ms, signal) =>
    new Promise<void>((resolve, reject) => {
      if (signal?.aborted) {
        reject(abortError());
        return;
      }
      const onAbort = () => {
        clearTimeout(timer);
        reject(abortError());
      };
      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }, Math.max(0, ms));
      signal?.addEventListener("abort", onAbort, { once: true });
    }),
};

export function createNineRouterRateGate(options: NineRouterRateGateOptions = {}): NineRouterRateGate {
  const clock = options.clock ?? defaultClock;
  const random = options.random ?? Math.random;
  const log = options.log ?? ((message: string) => console.warn(message));
  const chatRpm = options.chatRpm ?? DEFAULT_NINEROUTER_CHAT_RPM;
  const embedRpm = options.embedRpm ?? DEFAULT_NINEROUTER_EMBED_RPM;

  const states: Record<NineRouterRateBucket, BucketState> = {
    chat: { minIntervalMs: 60_000 / chatRpm, maxInFlight: 1, nextAt: 0, cooldownUntil: 0, active: 0, waiters: [] },
    embed: { minIntervalMs: 60_000 / embedRpm, maxInFlight: Number.POSITIVE_INFINITY, nextAt: 0, cooldownUntil: 0, active: 0, waiters: [] },
  };

  const sentCounts: Record<NineRouterRateBucket, number> = { chat: 0, embed: 0 };

  let installedWrapper: typeof fetch | undefined;
  let originalFetch: NineRouterFetch | undefined;

  async function takeSlot(state: BucketState, signal: AbortSignal | undefined): Promise<void> {
    if (signal?.aborted) throw abortError();
    if (state.active < state.maxInFlight && state.waiters.length === 0) {
      state.active += 1;
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        const index = state.waiters.indexOf(waiter);
        if (index >= 0) state.waiters.splice(index, 1);
        reject(abortError());
      };
      const waiter = () => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      };
      state.waiters.push(waiter);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
    // The slot was handed over by releaseSlot; `active` already counts it.
  }

  function releaseSlot(state: BucketState): void {
    const next = state.waiters.shift();
    if (next) {
      next();
      return;
    }
    state.active -= 1;
  }

  async function waitUntil(targetMs: number, signal: AbortSignal | undefined): Promise<void> {
    const delay = targetMs - clock.now();
    if (delay > 0) await clock.sleep(delay, signal);
    if (signal?.aborted) throw abortError();
  }

  async function pace(state: BucketState, signal: AbortSignal | undefined): Promise<void> {
    const start = Math.max(clock.now(), state.nextAt, state.cooldownUntil);
    state.nextAt = start + state.minIntervalMs;
    await waitUntil(start, signal);
    // A cooldown started while this caller was queued still applies.
    while (clock.now() < state.cooldownUntil) {
      await clock.sleep(state.cooldownUntil - clock.now(), signal);
    }
  }

  const gate: NineRouterRateGate = {
    classify(input) {
      let pathname: string;
      try {
        pathname = new URL(urlOf(input)).pathname;
      } catch {
        return null;
      }
      if (pathname.endsWith("/chat/completions")) return "chat";
      if (pathname.endsWith("/embeddings")) return "embed";
      return null;
    },

    async acquire(bucket, signal) {
      const state = states[bucket];
      await takeSlot(state, signal);
      try {
        await pace(state, signal);
      } catch (error) {
        releaseSlot(state);
        throw error;
      }
      // Counted once the slot is held: every acquire is followed by one send,
      // including the direct triage transport that bypasses request().
      sentCounts[bucket] += 1;
      let released = false;
      return {
        release() {
          if (released) return;
          released = true;
          releaseSlot(state);
        },
      };
    },

    async inspect(bucket, response) {
      let rateLimited = response.status === 429;
      if (!rateLimited && response.status === 503) {
        // The body is only inspected for a rate or quota hint; it is never logged.
        const hint = await response.clone().text().catch(() => "");
        rateLimited = RATE_HINT_PATTERN.test(hint);
      }
      if (!rateLimited) return response;

      const state = states[bucket];
      const now = clock.now();
      const cooldownMs = computeCooldownMs(response.headers.get("retry-after"), now, random);
      state.cooldownUntil = Math.max(state.cooldownUntil, now + cooldownMs);
      state.nextAt = Math.max(state.nextAt, state.cooldownUntil);
      log(`NineRouter ${bucket}: rate limited, cooling down ${Math.ceil(cooldownMs / 1000)} s`);
      throw new RateLimitedError({ retryAfterMs: cooldownMs, status: response.status, bucket });
    },

    async request(input, init) {
      const bucket = gate.classify(input);
      const send = gate.transport();
      if (bucket === null) return send(input, init);
      const slot = await gate.acquire(bucket, init?.signal ?? undefined);
      try {
        const response = await send(input, init);
        return await gate.inspect(bucket, response);
      } finally {
        slot.release();
      }
    },

    transport() {
      if (options.transport) return options.transport;
      const current = globalThis.fetch;
      if (installedWrapper !== undefined && current === installedWrapper && originalFetch !== undefined) {
        return originalFetch;
      }
      return current;
    },

    cooldownRemainingMs(bucket) {
      return Math.max(0, states[bucket].cooldownUntil - clock.now());
    },

    callCounts() {
      return { ...sentCounts };
    },

    installGlobalFetch(beforeRequest) {
      if (installedWrapper !== undefined) return;
      const previous = globalThis.fetch;
      const wrapper = (async (input: string | URL | Request, init?: RequestInit) => {
        const next = beforeRequest ? beforeRequest(urlOf(input), init) : init;
        return gate.request(input, next);
      }) as typeof fetch;
      originalFetch = previous as NineRouterFetch;
      installedWrapper = wrapper;
      globalThis.fetch = wrapper;
    },
  };

  return gate;
}

let sharedGate: NineRouterRateGate | undefined;

function readRpmFromEnv(name: string, fallback: number): number {
  const raw = typeof process !== "undefined" ? process.env?.[name] : undefined;
  const parsed = Number(raw);
  return raw && Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * The process-wide gate. Intelligence (Mastra and embeddings) and the worker
 * triage transport share it, so serve:live paces one NineRouter budget.
 */
export function getNineRouterRateGate(): NineRouterRateGate {
  if (sharedGate === undefined) {
    sharedGate = createNineRouterRateGate({
      chatRpm: readRpmFromEnv("NINEROUTER_CHAT_RPM", DEFAULT_NINEROUTER_CHAT_RPM),
      embedRpm: readRpmFromEnv("NINEROUTER_EMBED_RPM", DEFAULT_NINEROUTER_EMBED_RPM),
    });
  }
  return sharedGate;
}

/** AI-RPM-01: requests sent through the shared gate, per bucket. Counts only. */
export function getNineRouterCallCounts(): Readonly<Record<NineRouterRateBucket, number>> {
  return getNineRouterRateGate().callCounts();
}

/** Replaces the shared gate (tests inject a fake clock or a high RPM). */
export function setNineRouterRateGate(gate: NineRouterRateGate | undefined): void {
  sharedGate = gate;
}
