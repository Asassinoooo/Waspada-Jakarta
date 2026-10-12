import { readFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createModelCapabilityAdapter } from '../../apps/worker/src/layers/l2-model-grounding/adapter.js';
import { createNinerouterProvider } from '../../apps/worker/src/layers/l2-model-grounding/ninerouter-provider.js';
import { openLocalPipelineDatabase } from './database.js';
import { createLocalPipelineStore } from './store.js';
import { parseAuthoredFeed } from './feed.js';
import { createLocalMockModels } from './mock-models.js';
import { createLocalPipelineProcessor } from './processor.js';
import { runLocalSchedule } from './scheduler.js';

export interface LocalCliOptions {
  readonly enabled: boolean;
  readonly status: boolean;
  readonly realAi: boolean;
  readonly watch: boolean;
  readonly state: string;
  readonly intervalMs: number;
  readonly maxPolls: number;
}
export function parseLocalOptions(args: readonly string[]): LocalCliOptions {
  const flags = new Set(['--enable', '--status', '--real-ai', '--once', '--watch']);
  const values = new Set(['--state', '--interval-ms', '--max-polls']);
  const seen = new Set<string>();
  const parsed = new Map<string, string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if ((!flags.has(arg) && !values.has(arg)) || seen.has(arg)) throw new Error('invalid_local_options');
    seen.add(arg);
    if (values.has(arg)) {
      const value = args[++i];
      if (!value || value.startsWith('--')) throw new Error('invalid_local_options');
      parsed.set(arg, value);
    }
  }
  const state = parsed.get('--state') ?? 'mock-default';
  const intervalMs = Number(parsed.get('--interval-ms') ?? '5000');
  const maxPolls = Number(parsed.get('--max-polls') ?? (seen.has('--watch') ? '60' : '1'));
  if (!/^[a-z0-9][a-z0-9-]{0,47}$/.test(state) ||
      !Number.isSafeInteger(intervalMs) || intervalMs < 1000 || intervalMs > 3_600_000 ||
      !Number.isSafeInteger(maxPolls) || maxPolls < 1 || maxPolls > 10_000 ||
      (seen.has('--once') && seen.has('--watch')) ||
      (!seen.has('--watch') && (maxPolls !== 1 || seen.has('--interval-ms'))) ||
      (seen.has('--status') && (seen.has('--real-ai') || seen.has('--watch') || seen.has('--enable'))) ||
      (seen.has('--real-ai') && (!seen.has('--enable') || !seen.has('--once') || seen.has('--watch') || seen.has('--state')))) {
    throw new Error('invalid_local_options');
  }
  return { enabled: seen.has('--enable'), status: seen.has('--status'), realAi: seen.has('--real-ai'), watch: seen.has('--watch'), state, intervalMs, maxPolls };
}

export async function runLocalCli(args: readonly string[]): Promise<void> {
  const options = parseLocalOptions(args);
  if (!options.enabled && !options.status) {
    console.log(JSON.stringify({ status: 'disabled', reason: 'explicit_enable_flag_required', datasetKind: 'synthetic' }));
    return;
  }
  let models = createLocalMockModels();
  let state = options.state;
  if (options.realAi) {
    const baseUrl = process.env.NINEROUTER_URL;
    const apiKey = process.env.NINEROUTER_KEY;
    const epoch = process.env.NINEROUTER_CURATION_EPOCH;
    if (!baseUrl || !apiKey || !epoch || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(epoch) || epoch.includes(apiKey) || epoch.includes(baseUrl)) {
      throw new Error('invalid_local_configuration');
    }
    // No discovery request or planner call: the three-call budget is extraction/embedding/reasoning.
    const bundle = createNinerouterProvider({ baseUrl, apiKey, chatModel: 'Waspada-Jakarta',
      embeddingModel: 'gemini/gemini-embedding-2-preview', curationEpoch: epoch,
      maxHttpRequests: 3, timeoutMs: 25_000, allowTailnetHttp: true });
    const profileId = `real-${createHash('sha256').update(JSON.stringify(bundle.configuration)).digest('hex')}`;
    models = { adapter: createModelCapabilityAdapter(bundle.provider, bundle.configuration), configuration: bundle.configuration, profileId };
    // Every real invocation gets a fresh state so old pending jobs cannot consume its bounded budget.
    state = `real-${randomUUID()}`;
  }
  const dataDir = resolve(process.cwd(), '.codex-build', 'local-pipeline', state);
  const database = await openLocalPipelineDatabase({ dataDir, profileId: models.profileId });
  const controller = new AbortController();
  const stop = () => { controller.abort(); };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    const store = createLocalPipelineStore(database.executor);
    if (options.status) {
      console.log(JSON.stringify({ status: 'local_state', datasetKind: 'synthetic', state, summary: await store.summary(), publication: false }));
      return;
    }
    const now = () => new Date().toISOString();
    const processor = createLocalPipelineProcessor({ store, executor: database.executor, ...models, now, modelTimeoutMs: options.realAi ? 26_000 : 5_000 });
    const fixturePath = fileURLToPath(new URL('./fixtures/feed.json', import.meta.url));
    const result = await runLocalSchedule({ store, processor, now, intervalMs: options.intervalMs, maxPolls: options.maxPolls, signal: controller.signal,
      readFeed: async () => {
        const feed = parseAuthoredFeed(await readFile(fixturePath, 'utf8'));
        return options.realAi ? { ...feed, reports: feed.reports.slice(0, 1) } : feed;
      },
      onPoll: (poll) => console.log(JSON.stringify({ status: 'collected', datasetKind: 'synthetic', ...poll })),
      onCollectionError: () => console.log(JSON.stringify({ status: 'collection_pending', reason: 'local_feed_failed' })),
    });
    console.log(JSON.stringify({ status: controller.signal.aborted ? 'stopped' : 'local_cycle_complete', datasetKind: 'synthetic', state, ...result, summary: await store.summary(), publication: false, models: options.realAi ? 'opt_in_gateway' : 'mock' }));
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
    await database.close();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runLocalCli(process.argv.slice(2)).catch(() => {
    // No untrusted exception, stack, URL, body or secret is emitted.
    console.log(JSON.stringify({ status: 'failed', reason: 'local_pipeline_failed', publication: false }));
    process.exitCode = 1;
  });
}
