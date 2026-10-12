import { createHash } from 'node:crypto';
import { createModelCapabilityAdapter } from '../../apps/worker/src/layers/l2-model-grounding/adapter.js';
import { createNinerouterProvider } from '../../apps/worker/src/layers/l2-model-grounding/ninerouter-provider.js';
import { createLocalMockModels, type LocalMockModels } from './mock-models.js';

export interface ResolveLocalModelsOptions {
  readonly realAi: boolean;
  readonly omitExtractionOutputLimits: boolean;
  readonly env: NodeJS.ProcessEnv;
  readonly fetchImpl?: typeof fetch;
}

/** Resolve the private local model profile without performing provider I/O. */
export function resolveLocalModels({ realAi, omitExtractionOutputLimits, env, fetchImpl }: ResolveLocalModelsOptions): LocalMockModels {
  if (!realAi) {
    if (omitExtractionOutputLimits) throw new Error('invalid_local_options');
    // Keep mock runs independent of secrets and provider transport, even if env has accessors.
    return createLocalMockModels();
  }

  try {
    const baseUrl = env.NINEROUTER_URL;
    const apiKey = env.NINEROUTER_KEY;
    const epoch = env.NINEROUTER_CURATION_EPOCH;
    if (!baseUrl || !apiKey || !epoch || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(epoch)
      || epoch.includes(apiKey) || epoch.includes(baseUrl)) {
      throw new Error('invalid_local_configuration');
    }

    const providerOptions = {
      baseUrl,
      apiKey,
      chatModel: 'Waspada-Jakarta',
      embeddingModel: 'gemini/gemini-embedding-2-preview',
      curationEpoch: epoch,
      maxHttpRequests: 3,
      timeoutMs: 25_000,
      allowTailnetHttp: true,
      omitExtractionOutputLimits,
    } as const;
    const bundle = fetchImpl
      ? createNinerouterProvider(providerOptions, fetchImpl)
      : createNinerouterProvider(providerOptions);
    const gatewayFingerprint = new URL(baseUrl).href.replace(/\/+$/, '');
    // Preserve the established default fingerprint exactly. The diagnostic omission is a
    // separate profile policy so a resumable state cannot cross that boundary.
    const fingerprintInput = omitExtractionOutputLimits
      ? JSON.stringify([gatewayFingerprint, bundle.configuration, { omitExtractionOutputLimits: true }])
      : JSON.stringify([gatewayFingerprint, bundle.configuration]);
    const profileId = `real-${createHash('sha256').update(fingerprintInput).digest('hex')}`;
    return {
      adapter: createModelCapabilityAdapter(bundle.provider, bundle.configuration),
      configuration: bundle.configuration,
      profileId,
    };
  } catch {
    // Configuration and URL parsing errors may contain secrets; expose only a closed code.
    throw new Error('invalid_local_configuration');
  }
}
