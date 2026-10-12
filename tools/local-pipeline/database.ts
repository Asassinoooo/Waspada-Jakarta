import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { postgis } from '@electric-sql/pglite-postgis';
import { vector } from '@electric-sql/pglite-pgvector';
import { applyMigrations, readMigrations } from '../../apps/db/src/migrations.js';
import type { SqlExecutor, TransactionalSqlExecutor } from '../../apps/db/src/sql.js';
import { LOCAL_PIPELINE_SCHEMA, LOCAL_SOURCE_ID } from './contracts.js';

export interface OpenLocalPipelineDatabaseInput {
  readonly dataDir?: string;
  readonly profileId: string;
}

export interface LocalPipelineDatabase {
  readonly executor: TransactionalSqlExecutor;
  close(): Promise<void>;
}

const PROFILE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/**
 * Opens the opt-in local PGlite database, applies the repository's canonical
 * migrations, then applies only the local-tool schema and synthetic source seed.
 */
export async function openLocalPipelineDatabase(
  input: OpenLocalPipelineDatabaseInput,
): Promise<LocalPipelineDatabase> {
  validateInput(input);
  const database = await PGlite.create({
    ...(input.dataDir === undefined ? {} : { dataDir: input.dataDir }),
    extensions: { postgis, vector },
  });
  const executor = createDatabaseExecutor(database);
  try {
    await preflightOwnership(executor, input.profileId);
    const migrations = await readMigrations(new URL('../../apps/db/migrations/', import.meta.url));
    await applyMigrations(executor, migrations);
    await executor.execute(await readFile(new URL('./local-schema.sql', import.meta.url), 'utf8'));
    await bindSyntheticProfile(executor, input.profileId);
    return { executor, close: () => database.close() };
  } catch (error) {
    await database.close();
    throw error;
  }
}

async function preflightOwnership(executor: TransactionalSqlExecutor, profileId: string): Promise<void> {
  const catalog = await executor.query<{
    has_local_owner: boolean;
    has_schema_migrations: boolean;
    has_source_registry: boolean;
    has_namespace_config: boolean;
    has_waspada_objects: boolean;
  }>(
    `SELECT
       to_regclass('waspada.local_pipeline_owner') IS NOT NULL AS has_local_owner,
       to_regclass('waspada.schema_migrations') IS NOT NULL AS has_schema_migrations,
       to_regclass('waspada.source_registry') IS NOT NULL AS has_source_registry,
       to_regclass('waspada.dataset_namespace_config') IS NOT NULL AS has_namespace_config,
       EXISTS (
         SELECT 1 FROM pg_class AS relation
         JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
         WHERE namespace.nspname = 'waspada' AND relation.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')
       ) AS has_waspada_objects`,
  );
  const state = catalog.rows[0];
  if (!state) throw new Error('Local database ownership preflight could not inspect the schema');
  if (!state.has_local_owner) {
    if (state.has_waspada_objects) {
      throw new Error('Refusing to initialize a PGlite database that already contains unowned waspada data');
    }
    return;
  }
  if (!state.has_schema_migrations || !state.has_source_registry || !state.has_namespace_config) {
    throw new Error('Local profile marker exists without the canonical synthetic database schema');
  }

  const owner = await executor.query<{ profile_id: string; dataset_kind: string; pipeline_schema: string }>(
    `SELECT profile_id, dataset_kind, pipeline_schema
     FROM waspada.local_pipeline_owner WHERE singleton = 1`,
  );
  const storedOwner = owner.rows[0];
  if (owner.rows.length !== 1 || storedOwner?.profile_id !== profileId
    || storedOwner.dataset_kind !== 'synthetic' || storedOwner.pipeline_schema !== LOCAL_PIPELINE_SCHEMA) {
    throw new Error('Local PGlite database is already owned by another profile or schema');
  }
  const namespace = await executor.query<{ dataset_kind: string }>(
    'SELECT dataset_kind FROM waspada.dataset_namespace_config',
  );
  if (namespace.rows.length !== 1 || namespace.rows[0]?.dataset_kind !== 'synthetic') {
    throw new Error('Local profile database must be configured for the synthetic dataset namespace');
  }
}

function validateInput(input: OpenLocalPipelineDatabaseInput): void {
  if (input === null || typeof input !== 'object' || !PROFILE_ID_PATTERN.test(input.profileId)) {
    throw new Error('profileId must be a bounded local identifier');
  }
  if (input.dataDir !== undefined
    && (typeof input.dataDir !== 'string' || input.dataDir.length === 0 || input.dataDir.trim() !== input.dataDir)) {
    throw new Error('dataDir must be an omitted value or a non-empty local path');
  }
}

async function bindSyntheticProfile(executor: TransactionalSqlExecutor, profileId: string): Promise<void> {
  const now = new Date().toISOString();
  const bootstrapTraceId = 'local-bootstrap:' + createHash('sha256').update(profileId, 'utf8').digest('hex').slice(0, 32);
  await executor.transaction(async (transaction) => {
    const tx = transactionExecutor(transaction);
    await tx.query(
      `INSERT INTO waspada.local_pipeline_owner
         (singleton, profile_id, dataset_kind, pipeline_schema, initialized_at)
       VALUES (1, $1, 'synthetic', $2, $3)
       ON CONFLICT (singleton) DO NOTHING`,
      [profileId, LOCAL_PIPELINE_SCHEMA, now],
    );
    const owner = await tx.query<{ profile_id: string; dataset_kind: string; pipeline_schema: string }>(
      `SELECT profile_id, dataset_kind, pipeline_schema
       FROM waspada.local_pipeline_owner WHERE singleton = 1`,
    );
    const storedOwner = owner.rows[0];
    if (storedOwner?.profile_id !== profileId || storedOwner.dataset_kind !== 'synthetic'
      || storedOwner.pipeline_schema !== LOCAL_PIPELINE_SCHEMA) {
      throw new Error('Local PGlite database is already owned by another profile or schema');
    }

    await tx.query(
      `INSERT INTO waspada.dataset_namespace_config (singleton, dataset_kind, configured_at)
       VALUES (true, 'synthetic', $1)
       ON CONFLICT (singleton) DO NOTHING`,
      [now],
    );
    const namespace = await tx.query<{ dataset_kind: string }>(
      'SELECT dataset_kind FROM waspada.dataset_namespace_config',
    );
    if (namespace.rows.length !== 1 || namespace.rows[0]?.dataset_kind !== 'synthetic') {
      throw new Error('Local profile database must use only the synthetic dataset namespace');
    }

    await tx.query(
      `INSERT INTO waspada.traces
         (trace_id, dataset_kind, started_at, ended_at, outcome, metadata)
       VALUES ($1, 'synthetic', $2, NULL, 'open', $3::jsonb)
       ON CONFLICT (trace_id) DO NOTHING`,
      [bootstrapTraceId, now, JSON.stringify({ purpose: 'local_synthetic_pipeline_bootstrap', profile_id: profileId })],
    );
    const trace = await tx.query<{ dataset_kind: string }>(
      'SELECT dataset_kind FROM waspada.traces WHERE trace_id = $1', [bootstrapTraceId],
    );
    if (trace.rows[0]?.dataset_kind !== 'synthetic') {
      throw new Error('Local synthetic source bootstrap trace conflicts with stored state');
    }

    await tx.query(
      `INSERT INTO waspada.source_registry
         (source_id, trace_id, registry_version, display_name, source_kind, remit,
          access_method, approved_hosts, access_restrictions, reuse_basis,
          registry_status, approval_status, health_status, auto_acquisition_enabled,
          auto_publication_policy, polling_interval_seconds)
       VALUES ($1, $2, 1, 'Local authored synthetic fixtures', 'other',
          ARRAY['synthetic demonstration only'], 'manual_fixture', ARRAY[]::text[],
          ARRAY['authored synthetic fixture; local reads only'],
          ARRAY['content authored for local synthetic testing'],
          'active', 'approved', 'unknown', true, 'never', 60)
       ON CONFLICT (source_id) DO NOTHING`,
      [LOCAL_SOURCE_ID, bootstrapTraceId],
    );
    const source = await tx.query<{
      trace_id: string;
      source_kind: string;
      access_method: string;
      registry_status: string;
      approval_status: string;
      auto_acquisition_enabled: boolean;
      auto_publication_policy: string;
      polling_interval_seconds: number;
      approved_hosts: readonly string[];
    }>(
      `SELECT trace_id, source_kind, access_method, registry_status, approval_status,
              auto_acquisition_enabled, auto_publication_policy, polling_interval_seconds,
              approved_hosts
       FROM waspada.source_registry WHERE source_id = $1`,
      [LOCAL_SOURCE_ID],
    );
    const storedSource = source.rows[0];
    if (!storedSource || storedSource.trace_id !== bootstrapTraceId || storedSource.source_kind !== 'other'
      || storedSource.access_method !== 'manual_fixture' || storedSource.registry_status !== 'active'
      || storedSource.approval_status !== 'approved' || storedSource.auto_acquisition_enabled !== true
      || storedSource.auto_publication_policy !== 'never' || Number(storedSource.polling_interval_seconds) !== 60
      || storedSource.approved_hosts.length !== 0) {
      throw new Error('Local authored source conflicts with stored registry state');
    }
  });
}

function createDatabaseExecutor(database: PGlite): TransactionalSqlExecutor {
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

/** Adds a no-savepoint transaction runner for repository ports used inside a transaction. */
function transactionExecutor(executor: SqlExecutor): TransactionalSqlExecutor {
  return {
    query: <Row extends object>(statement: string, parameters?: readonly unknown[]) =>
      executor.query<Row>(statement, parameters),
    execute: (statement: string) => executor.execute(statement),
    transaction: async <Result>(work: (transaction: SqlExecutor) => Promise<Result>) => {
      return work(executor);
    },
  };
}
