import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openLocalPipelineDatabase } from './database.js';
import { createLocalPipelineStore } from './store.js';
import { parseAuthoredFeed } from './feed.js';
import { resolveLocalModels } from './models.js';
import { createLocalPipelineProcessor } from './processor.js';
import { runLocalSchedule } from './scheduler.js';
import { LOCAL_FEED_SCHEMA, LOCAL_SOURCE_ID } from './contracts.js';

export interface LocalCliOptions {
  readonly enabled: boolean;
  readonly status: boolean;
  readonly realAi: boolean;
  readonly omitExtractionOutputLimits: boolean;
  readonly watch: boolean;
  readonly state: string;
  readonly intervalMs: number;
  readonly maxPolls: number;
}
export function parseLocalOptions(args: readonly string[]): LocalCliOptions {
  const flags = new Set(['--enable', '--status', '--real-ai', '--omit-extraction-output-limits', '--once', '--watch']);
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
      (seen.has('--status') && (seen.has('--watch') || seen.has('--enable'))) ||
      (seen.has('--omit-extraction-output-limits') && !seen.has('--real-ai')) ||
      (seen.has('--real-ai') && ((!seen.has('--status') && (!seen.has('--enable') || !seen.has('--once'))) || seen.has('--watch') ||
        (seen.has('--state') && !/^real-[0-9a-f-]{36}$/.test(state)) || (seen.has('--status') && !seen.has('--state'))))) {
    throw new Error('invalid_local_options');
  }
  return { enabled: seen.has('--enable'), status: seen.has('--status'), realAi: seen.has('--real-ai'),
    omitExtractionOutputLimits: seen.has('--omit-extraction-output-limits'), watch: seen.has('--watch'), state, intervalMs, maxPolls };
}

export async function runLocalCli(args: readonly string[]): Promise<void> {
  const options = parseLocalOptions(args);
  if (!options.enabled && !options.status) {
    console.log(JSON.stringify({ status: 'disabled', reason: 'explicit_enable_flag_required', datasetKind: 'synthetic' }));
    return;
  }
  const models = resolveLocalModels({ realAi: options.realAi,
    omitExtractionOutputLimits: options.omitExtractionOutputLimits,
    env: options.realAi ? process.env : {},
  });
  let state = options.state;
  if (options.realAi) {
    // New probes get fresh state; explicit resume reuses its pinned synthetic profile.
    state = args.includes('--state') ? options.state : `real-${randomUUID()}`;
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
    let realAiAttempts = 0;
    const boundedProcessor = options.realAi ? {
      processIngestion: () => processor.processIngestion(),
      processAi: () => realAiAttempts++ === 0 ? processor.processAi() : Promise.resolve(null),
    } : processor;
    const fixturePath = fileURLToPath(new URL('./fixtures/feed.json', import.meta.url));
    const result = await runLocalSchedule({ store, processor: boundedProcessor, now, intervalMs: options.intervalMs, maxPolls: options.maxPolls, signal: controller.signal,
      readFeed: async () => {
        // Resumes process the captured snapshot, never a newly edited fixture.
        if (options.realAi && args.includes('--state')) return { schemaVersion: LOCAL_FEED_SCHEMA, sourceId: LOCAL_SOURCE_ID, datasetKind: 'synthetic', reports: [] };
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
