import type { ContextSourceAdapters, ContextSourcesAdapterOptions, ContextSourcesPair } from "../layers/l1-data-knowledge/context-source-adapters.js";
import {
  CONTEXT_SOURCES_LIMITS,
  createContextSourceAdapters,
} from "../layers/l1-data-knowledge/context-source-adapters.js";

export interface ContextSourcesRead {
  readonly sources: ContextSourcesPair;
  readonly cached: boolean;
}

export interface ContextSourcesRuntime {
  readNotRequested(): ContextSourcesRead;
  readFetched(): Promise<ContextSourcesRead>;
}

/** Holds only normalized DTOs in an isolate-local, five-minute coalescing cache. */
export function createContextSourcesRuntime(
  options: ContextSourcesAdapterOptions = {},
): ContextSourcesRuntime {
  const adapters: ContextSourceAdapters = createContextSourceAdapters(options);
  const clock = options.clock ?? {
    now: () => Date.now(),
    schedule: (callback: () => void, delayMs: number) => globalThis.setTimeout(callback, delayMs),
    cancel: (handle: unknown) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
  };

  let cached: {
    readonly storedAt: number;
    readonly expiresAt: number;
    readonly sources: ContextSourcesPair;
  } | undefined;
  let inFlight: Promise<ContextSourcesPair> | undefined;

  function clearExpiredCache(now: number): void {
    if (cached !== undefined && (!Number.isFinite(now)
      || now < cached.storedAt || now >= cached.expiresAt)) {
      cached = undefined;
    }
  }

  return {
    readNotRequested() {
      clearExpiredCache(clock.now());
      return { sources: adapters.notRequested(), cached: false };
    },
    async readFetched() {
      const now = clock.now();
      if (cached !== undefined) {
        if (Number.isFinite(now) && now >= cached.storedAt && now < cached.expiresAt) {
          return { sources: cached.sources, cached: true };
        }
        cached = undefined;
      }
      if (inFlight !== undefined) {
        return { sources: await inFlight, cached: true };
      }

      const pending = adapters.fetchSources();
      inFlight = pending;
      try {
        const sources = await pending;
        const completedAt = clock.now();
        if (Number.isFinite(completedAt)) {
          cached = {
            storedAt: completedAt,
            expiresAt: completedAt + CONTEXT_SOURCES_LIMITS.cacheTtlMs,
            sources,
          };
        } else {
          cached = undefined;
        }
        return { sources, cached: false };
      } finally {
        if (inFlight === pending) inFlight = undefined;
      }
    },
  };
}
