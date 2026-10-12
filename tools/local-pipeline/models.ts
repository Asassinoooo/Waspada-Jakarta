import { createHash } from 'node:crypto';
import { createModelCapabilityAdapter } from '../../apps/worker/src/layers/l2-model-grounding/adapter.js';
import { createNinerouterProvider, type NinerouterObservation } from '../../apps/worker/src/layers/l2-model-grounding/ninerouter-provider.js';
import { createNoTimeoutNodeFetch } from '../ai/run-extraction-probe.js';
import { createLocalMockModels, type LocalMockModels } from './mock-models.js';

const DEFAULT_REAL_REQUEST_TIMEOUT_MS = 900_000;
const MIN_REAL_REQUEST_TIMEOUT_MS = 1_000;
const MAX_REAL_REQUEST_TIMEOUT_MS = 900_000;
const LEGACY_REAL_REQUEST_TIMEOUT_MS = 25_000;
const NATIVE_TRANSPORT_THRESHOLD_MS = 120_000;
const PROCESSOR_TIMEOUT_GRACE_MS = 1_000;

export interface ResolveLocalModelsOptions {
  readonly realAi: boolean;
  readonly omitExtractionOutputLimits: boolean;
  readonly env: NodeJS.ProcessEnv;
  readonly fetchImpl?: typeof fetch;
  readonly onObservation?: (observation: NinerouterObservation) => void;
}

export interface ResolvedLocalModels extends LocalMockModels {
  readonly requestTimeoutMs?: number;
  readonly modelTimeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly cancel?: () => void;
}

/** Resolve the private local model profile without performing provider I/O. */
export function resolveLocalModels({ realAi, omitExtractionOutputLimits, env, fetchImpl, onObservation }: ResolveLocalModelsOptions): ResolvedLocalModels {
  if (!realAi) {
    if (omitExtractionOutputLimits) throw new Error('invalid_local_options');
    // Keep mock runs independent of secrets and provider transport, even if env has accessors.
    return createLocalMockModels();
  }

  try {
    const baseUrl = env.NINEROUTER_URL;
    const apiKey = env.NINEROUTER_KEY;
    const epoch = env.NINEROUTER_CURATION_EPOCH;
    const requestTimeoutMs = resolveRequestTimeoutMs(env.NINEROUTER_TIMEOUT_MS);
    if (!baseUrl || !apiKey || !epoch || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(epoch)
      || epoch.includes(apiKey) || epoch.includes(baseUrl)) {
      throw new Error('invalid_local_configuration');
    }

    const controller = new AbortController();
    const underlyingFetch = fetchImpl ?? (requestTimeoutMs > NATIVE_TRANSPORT_THRESHOLD_MS
      ? createNoTimeoutNodeFetch()
      : fetch);
    const cancellableFetch = createCancellableFetch(underlyingFetch, controller.signal);
    const providerOptions = {
      baseUrl,
      apiKey,
      chatModel: 'Waspada-Jakarta',
      embeddingModel: 'gemini/gemini-embedding-2-preview',
      curationEpoch: epoch,
      maxHttpRequests: 3,
      timeoutMs: requestTimeoutMs,
      allowTailnetHttp: true,
      omitExtractionOutputLimits,
      ...(onObservation ? { onObservation } : {}),
    } as const;
    const bundle = createNinerouterProvider(providerOptions, cancellableFetch);
    const gatewayFingerprint = new URL(baseUrl).href.replace(/\/+$/, '');
    // Preserve the established 25-second profile IDs. Every other timeout and the
    // diagnostic omission are owned policies so a resume cannot cross either boundary.
    const profilePolicy = {
      ...(requestTimeoutMs === LEGACY_REAL_REQUEST_TIMEOUT_MS ? {} : { requestTimeoutMs }),
      ...(omitExtractionOutputLimits ? { omitExtractionOutputLimits: true } : {}),
    };
    const fingerprintInput = Object.keys(profilePolicy).length > 0
      ? JSON.stringify([gatewayFingerprint, bundle.configuration, profilePolicy])
      : JSON.stringify([gatewayFingerprint, bundle.configuration]);
    const profileId = `real-${createHash('sha256').update(fingerprintInput).digest('hex')}`;
    return {
      adapter: createModelCapabilityAdapter(bundle.provider, bundle.configuration),
      configuration: bundle.configuration,
      profileId,
      requestTimeoutMs,
      modelTimeoutMs: requestTimeoutMs + PROCESSOR_TIMEOUT_GRACE_MS,
      signal: controller.signal,
      cancel: () => controller.abort(),
    };
  } catch {
    // Configuration and URL parsing errors may contain secrets; expose only a closed code.
    throw new Error('invalid_local_configuration');
  }
}

function resolveRequestTimeoutMs(rawValue: string | undefined): number {
  if (rawValue === undefined) return DEFAULT_REAL_REQUEST_TIMEOUT_MS;
  if (!/^\d+$/.test(rawValue)) throw new Error('invalid_local_configuration');
  const value = Number(rawValue);
  if (!Number.isSafeInteger(value) || value < MIN_REAL_REQUEST_TIMEOUT_MS || value > MAX_REAL_REQUEST_TIMEOUT_MS) {
    throw new Error('invalid_local_configuration');
  }
  return value;
}

function createCancellableFetch(fetchImpl: typeof fetch, localSignal: AbortSignal): typeof fetch {
  return async (input, init = {}) => {
    const providerSignal = init.signal;
    const combined = new AbortController();
    const sourceSignals = [providerSignal, localSignal].filter((signal): signal is AbortSignal => signal != null);
    const sourceListeners = sourceSignals.map((signal) => {
      const abort = () => combined.abort();
      if (signal.aborted) abort();
      else signal.addEventListener('abort', abort, { once: true });
      return { signal, abort };
    });
    let cleaned = false;
    let removeBodyAbort = (): void => undefined;
    let rejectOnAbort: (() => void) | undefined;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      removeBodyAbort();
      if (rejectOnAbort) combined.signal.removeEventListener('abort', rejectOnAbort);
      for (const { signal, abort } of sourceListeners) signal.removeEventListener('abort', abort);
    };
    if (combined.signal.aborted) {
      cleanup();
      throw createAbortError();
    }
    const aborted = new Promise<never>((_resolve, reject) => {
      rejectOnAbort = () => {
        const error = createAbortError();
        reject(error);
      };
      combined.signal.addEventListener('abort', rejectOnAbort, { once: true });
      if (combined.signal.aborted) rejectOnAbort();
    });

    try {
      const request = Promise.resolve().then(() => {
        if (combined.signal.aborted) throw createAbortError();
        return fetchImpl(input, { ...init, signal: combined.signal });
      }).then((response) => {
        if (!combined.signal.aborted) return response;
        cancelResponseBody(response);
        throw createAbortError();
      });
      const response = await Promise.race([request, aborted]);
      if (combined.signal.aborted) {
        cancelResponseBody(response);
        throw createAbortError();
      }
      const status = response.status;
      // Provider code rejects these responses before reading their body. Release
      // the source listeners and transport promptly on these closed outcomes.
      if (!response.body || status === 0 || !response.ok || (status >= 300 && status < 400)) {
        cleanup();
        if (response.body && (!response.ok || (status >= 300 && status < 400))) {
          void response.body.cancel().catch(() => undefined);
        }
        return response;
      }

      const reader = response.body.getReader();
      const abortBodyRead = () => { void reader.cancel(createAbortError()).catch(() => undefined); };
      combined.signal.addEventListener('abort', abortBodyRead, { once: true });
      removeBodyAbort = () => combined.signal.removeEventListener('abort', abortBodyRead);
      const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            if (combined.signal.aborted) throw createAbortError();
            const chunk = await Promise.race([reader.read(), aborted]);
            if (chunk.done) {
              controller.close();
              cleanup();
              return;
            }
            controller.enqueue(chunk.value);
          } catch (error) {
            try { controller.error(error); } catch { /* The consumer may already have cancelled. */ }
            cleanup();
          }
        },
        async cancel(reason) {
          cleanup();
          await reader.cancel(reason);
        },
      });
      return new Response(body, { status, statusText: response.statusText, headers: response.headers });
    } catch (error) {
      cleanup();
      throw error;
    }
  };
}

function createAbortError(): Error {
  const error = new Error('aborted');
  error.name = 'AbortError';
  return error;
}

function cancelResponseBody(response: Response): void {
  if (!response.body) return;
  try {
    void response.body.cancel().catch(() => undefined);
  } catch {
    // Preserve the closed abort classification if an injected response is already locked.
  }
}
