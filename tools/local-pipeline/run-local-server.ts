import { lstat, readFile, readdir, stat } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { postgis } from '@electric-sql/pglite-postgis';
import { vector } from '@electric-sql/pglite-pgvector';
import type { SqlExecutor, TransactionalSqlExecutor } from '../../apps/db/src/sql.js';
import { createLocalPipelineProcessor } from './processor.js';
import { parseAuthoredFeed } from './feed.js';
import { createLocalPipelineStore } from './store.js';
import { runLocalSchedule } from './scheduler.js';
import { resolveLocalModels } from './models.js';
import { openLocalPipelineDatabase, type LocalPipelineDatabase } from './database.js';
import { startLocalPipelinePreviewServer, type LocalPipelinePreviewServerHandle } from './server.js';
import type { LocalPreviewSchedulerState } from './preview.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LOCAL_STATE = /^[a-z0-9][a-z0-9-]{0,47}$/;
const DEFAULT_INTERVAL_MS = 5_000;
const DEFAULT_MAX_POLLS = 60;

export interface LocalServerOptions {
  readonly enabled: boolean;
  readonly realAi: boolean;
  readonly omitExtractionOutputLimits: boolean;
  readonly watch: boolean;
  readonly state: string | null;
  readonly intervalMs: number;
  readonly maxPolls: number;
}

/** Parse the deliberately small, finite and opt-in local-server command line. */
export function parseLocalServerOptions(args: readonly string[]): LocalServerOptions {
  const flags = new Set(['--enable', '--real-ai', '--omit-extraction-output-limits', '--watch']);
  const values = new Set(['--state', '--interval-ms', '--max-polls']);
  const seen = new Set<string>();
  const parsed = new Map<string, string>();
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if ((!flags.has(arg) && !values.has(arg)) || seen.has(arg)) throw new Error('invalid_local_server_options');
    seen.add(arg);
    if (values.has(arg)) {
      const value = args[++index];
      if (!value || value.startsWith('--')) throw new Error('invalid_local_server_options');
      parsed.set(arg, value);
    }
  }

  const state = parsed.get('--state') ?? null;
  const intervalMs = Number(parsed.get('--interval-ms') ?? DEFAULT_INTERVAL_MS);
  const maxPolls = Number(parsed.get('--max-polls') ?? DEFAULT_MAX_POLLS);
  const enabled = seen.has('--enable');
  const realAi = seen.has('--real-ai');
  const watch = seen.has('--watch');
  if ((!enabled && seen.size > 0)
    || (enabled && (state === null || !LOCAL_STATE.test(state)))
    || (state !== null && (!LOCAL_STATE.test(state) || state === '.' || state === '..'))
    || (realAi && (!enabled || watch || state === null || !/^real-[0-9a-f-]{36}$/i.test(state)
      || !UUID.test(state.slice('real-'.length))))
    || (!realAi && state?.startsWith('real-'))
    || (seen.has('--omit-extraction-output-limits') && !realAi)
    || (watch && (!enabled || realAi || !Number.isSafeInteger(intervalMs)
      || intervalMs < 1_000 || intervalMs > 3_600_000
      || !Number.isSafeInteger(maxPolls) || maxPolls < 1 || maxPolls > 10_000))
    || (!watch && (seen.has('--interval-ms') || seen.has('--max-polls')))) {
    throw new Error('invalid_local_server_options');
  }
  return {
    enabled, realAi, omitExtractionOutputLimits: seen.has('--omit-extraction-output-limits'),
    watch, state, intervalMs, maxPolls,
  };
}

/** Start the local read-only endpoint; mock scheduling is separately opt-in and finite. */
export async function runLocalPreviewServer(args: readonly string[]): Promise<void> {
  const options = parseLocalServerOptions(args);
  if (!options.enabled || options.state === null) {
    console.log(JSON.stringify({ status: 'disabled', reason: 'explicit_enable_flag_required', datasetKind: 'synthetic' }));
    return;
  }

  const stateDirectory = resolve(process.cwd(), '.codex-build', 'local-pipeline', options.state);
  if (options.realAi) await requireExistingPGliteState(stateDirectory);
  const models = resolveLocalModels({
    realAi: options.realAi,
    omitExtractionOutputLimits: options.omitExtractionOutputLimits,
    env: options.realAi ? process.env : {},
  });

  let database: LocalPipelineDatabase | undefined;
  let server: LocalPipelinePreviewServerHandle | undefined;
  let schedulerTask: Promise<void> | undefined;
  const controller = new AbortController();
  let resolveStop!: () => void;
  const stopSignal = new Promise<void>((resolvePromise) => { resolveStop = resolvePromise; });
  const stop = () => { controller.abort(); resolveStop(); };
  try {
    database = options.realAi
      ? await openExistingRealDatabase(stateDirectory, models.profileId)
      : await openLocalPipelineDatabase({ dataDir: stateDirectory, profileId: models.profileId });
    const schedulerState: { status: LocalPreviewSchedulerState['status']; polls: number; collectionFailures: number } = {
      status: 'idle', polls: 0, collectionFailures: 0,
    };
    server = await startLocalPipelinePreviewServer({
      executor: database.executor,
      models: options.realAi ? 'opt_in_gateway' : 'mock',
      scheduler: () => ({ ...schedulerState }),
    });
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);

    if (options.watch) {
      const store = createLocalPipelineStore(database.executor);
      const processor = createLocalPipelineProcessor({
        store,
        executor: database.executor,
        ...models,
        now: () => new Date().toISOString(),
        modelTimeoutMs: 5_000,
      });
      schedulerState.status = 'running';
      const fixturePath = fileURLToPath(new URL('./fixtures/feed.json', import.meta.url));
      schedulerTask = runLocalSchedule({
        store,
        processor,
        now: () => new Date().toISOString(),
        intervalMs: options.intervalMs,
        maxPolls: options.maxPolls,
        signal: controller.signal,
        readFeed: async () => parseAuthoredFeed(await readFile(fixturePath, 'utf8')),
        onPoll: (poll) => {
          schedulerState.polls = Math.min(options.maxPolls, schedulerState.polls + 1);
          console.log(JSON.stringify({ status: 'collected', datasetKind: 'synthetic', ...poll }));
        },
        onCollectionError: () => {
          schedulerState.polls = Math.min(options.maxPolls, schedulerState.polls + 1);
          schedulerState.collectionFailures = Math.min(options.maxPolls, schedulerState.collectionFailures + 1);
          console.log(JSON.stringify({ status: 'collection_pending', reason: 'local_feed_failed' }));
        },
      }).then((result) => {
        schedulerState.polls = result.polls;
        schedulerState.collectionFailures = result.collectionFailures;
        schedulerState.status = 'completed';
      }).catch(() => {
        schedulerState.status = 'failed';
        console.log(JSON.stringify({ status: 'scheduler_failed', datasetKind: 'synthetic' }));
      });
    }

    console.log(JSON.stringify({
      status: 'listening', host: server.host, port: server.port,
      datasetKind: 'synthetic', state: options.state,
      models: options.realAi ? 'opt_in_gateway' : 'mock', publication: false,
    }));
    await stopSignal;
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
    controller.abort();
    await Promise.allSettled([
      schedulerTask ?? Promise.resolve(),
      server?.close() ?? Promise.resolve(),
    ]);
    await database?.close();
  }
}

async function requireExistingPGliteState(dataDir: string): Promise<void> {
  try {
    const directory = await lstat(dataDir);
    if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error('missing_existing_local_state');
    const [version, base] = await Promise.all([stat(join(dataDir, 'PG_VERSION')), stat(join(dataDir, 'base'))]);
    if (!version.isFile() || !base.isDirectory()) throw new Error('missing_existing_local_state');
    const entries = await readdir(dataDir);
    if (entries.length < 3) throw new Error('missing_existing_local_state');
  } catch {
    throw new Error('existing_local_state_required');
  }
}

async function openExistingRealDatabase(dataDir: string, profileId: string): Promise<LocalPipelineDatabase> {
  const database = await PGlite.create({ dataDir, extensions: { postgis, vector } });
  const executor = createPGliteExecutor(database);
  try {
    await executor.execute('SET default_transaction_read_only = on');
    const owner = await executor.query<{
      profile_id: string;
      dataset_kind: string;
      pipeline_schema: string;
    }>(`SELECT profile_id, dataset_kind, pipeline_schema
       FROM waspada.local_pipeline_owner WHERE singleton = 1`);
    const namespace = await executor.query<{ dataset_kind: string }>(
      'SELECT dataset_kind FROM waspada.dataset_namespace_config',
    );
    if (owner.rows.length !== 1 || owner.rows[0]?.profile_id !== profileId
      || owner.rows[0]?.dataset_kind !== 'synthetic'
      || owner.rows[0]?.pipeline_schema !== 'local-private-pipeline-v1'
      || namespace.rows.length !== 1 || namespace.rows[0]?.dataset_kind !== 'synthetic') {
      throw new Error('existing_local_state_profile_mismatch');
    }
    const catalog = await executor.query<{ schema_migrations: string | null; source_registry: string | null }>(
      `SELECT to_regclass('waspada.schema_migrations')::text AS schema_migrations,
              to_regclass('waspada.source_registry')::text AS source_registry`,
    );
    if (!catalog.rows[0]?.schema_migrations || !catalog.rows[0].source_registry) {
      throw new Error('existing_local_state_profile_mismatch');
    }
    return { executor, close: () => database.close() };
  } catch {
    await database.close();
    throw new Error('existing_local_state_profile_mismatch');
  }
}

function createPGliteExecutor(database: PGlite): TransactionalSqlExecutor {
  return {
    async query<Row extends object>(statement: string, parameters?: readonly unknown[]) {
      const result = await database.query<Row>(statement, parameters ? [...parameters] : undefined);
      return { rows: result.rows };
    },
    async execute(statement: string) {
      await database.exec(statement);
    },
    async transaction<Result>(work: (transaction: SqlExecutor) => Promise<Result>): Promise<Result> {
      return database.transaction((client) => work({
        async query<Row extends object>(statement: string, parameters?: readonly unknown[]) {
          const result = await client.query<Row>(statement, parameters ? [...parameters] : undefined);
          return { rows: result.rows };
        },
        async execute(statement: string) {
          await client.exec(statement);
        },
      }));
    },
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runLocalPreviewServer(process.argv.slice(2)).catch(() => {
    console.log(JSON.stringify({ status: 'failed', reason: 'local_preview_server_failed', publication: false }));
    process.exitCode = 1;
  });
}
