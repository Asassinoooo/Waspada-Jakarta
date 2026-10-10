import type { PreviewSource } from "../contracts/source-preview.js";
import {
  createSourcePreviewAdapters,
  SOURCE_PREVIEW_LIMITS,
  type SourcePreviewAdapterOptions,
  type SourcePreviewSourceRead,
} from "../layers/l1-data-knowledge/source-preview-adapters.js";

export interface SourcePreviewRuntime {
  readSnapshot(): SourcePreviewSourceRead;
  readFetched(): Promise<SourcePreviewSourceRead>;
}

/**
 * Composes the L1 source adapters with one isolate-local normalized-result
 * cache. Raw provider bodies are never stored beyond the adapter call.
 */
export function createSourcePreviewRuntime(
  options: SourcePreviewAdapterOptions = {},
): SourcePreviewRuntime {
  const adapters = createSourcePreviewAdapters(options);
  const clock = options.clock ?? {
    now: () => Date.now(),
    schedule: (callback: () => void, delayMs: number) => globalThis.setTimeout(callback, delayMs),
    cancel: (handle: unknown) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
  };

  let cached: { readonly storedAt: number; readonly expiresAt: number; readonly sources: readonly [PreviewSource, PreviewSource] }
    | undefined;
  let inFlight: Promise<readonly [PreviewSource, PreviewSource]> | undefined;

  function clearExpiredCache(now: number): void {
    if (cached !== undefined && (!Number.isFinite(now)
      || now < cached.storedAt || now >= cached.expiresAt)) {
      cached = undefined;
    }
  }

  return {
    readSnapshot() {
      clearExpiredCache(clock.now());
      return { sources: adapters.readSnapshot(), cached: false };
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
            expiresAt: completedAt + SOURCE_PREVIEW_LIMITS.cacheTtlMs,
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
