import { Client } from 'pg';
import type { SqlExecutor, TransactionalSqlExecutor } from './sql.js';

interface PostgresSqlClient {
  connect(): Promise<void>;
  query<Row extends object = Record<string, unknown>>(
    statement: string,
    parameters?: unknown[],
  ): Promise<{ readonly rows: readonly Row[] }>;
  end(): Promise<void>;
}

type PostgresSqlClientFactory = (connectionString: string) => PostgresSqlClient;

function createNodePostgresClient(connectionString: string): PostgresSqlClient {
  const client = new Client({ connectionString });

  return {
    connect: async () => { await client.connect(); },
    async query<Row extends object>(statement: string, parameters?: unknown[]) {
      const result = await client.query(statement, parameters);
      return { rows: result.rows as readonly Row[] };
    },
    end: () => client.end(),
  };
}

function createSqlExecutor(client: PostgresSqlClient): SqlExecutor {
  return {
    async query<Row extends object>(statement: string, parameters?: readonly unknown[]) {
      const result = await client.query<Row>(
        statement,
        parameters === undefined ? undefined : [...parameters],
      );
      return { rows: result.rows };
    },
    async execute(statement: string) {
      await client.query(statement);
    },
  };
}

function createTransactionalSqlExecutor(client: PostgresSqlClient): TransactionalSqlExecutor {
  return {
    ...createSqlExecutor(client),
    async transaction<Result>(work: (transaction: SqlExecutor) => Promise<Result>) {
      await client.query('BEGIN');

      try {
        const result = await work(createSqlExecutor(client));
        await client.query('COMMIT');
        return result;
      } catch (error) {
        try {
          await client.query('ROLLBACK');
        } catch {
          // Preserve the work or commit error that caused the rollback.
        }
        throw error;
      }
    },
  };
}

/** Runs one operation with a request-scoped node-postgres client. */
export async function withPostgresSqlExecutor<Result>(
  connectionString: string,
  operation: (executor: SqlExecutor) => Promise<Result>,
  createClient: PostgresSqlClientFactory = createNodePostgresClient,
): Promise<Result> {
  const client = createClient(connectionString);
  let outcome: { readonly ok: true; readonly result: Result } | { readonly ok: false; readonly error: unknown };

  try {
    await client.connect();
    outcome = { ok: true, result: await operation(createSqlExecutor(client)) };
  } catch (error) {
    outcome = { ok: false, error };
  }

  try {
    await client.end();
  } catch (closeError) {
    if (outcome.ok) throw closeError;
  }

  if (!outcome.ok) throw outcome.error;
  return outcome.result;
}

/** Runs one operation with a request-scoped client and explicit transactions. */
export async function withPostgresTransactionalSqlExecutor<Result>(
  connectionString: string,
  operation: (executor: TransactionalSqlExecutor) => Promise<Result>,
  createClient: PostgresSqlClientFactory = createNodePostgresClient,
): Promise<Result> {
  const client = createClient(connectionString);
  let outcome: { readonly ok: true; readonly result: Result } | { readonly ok: false; readonly error: unknown };

  try {
    await client.connect();
    outcome = { ok: true, result: await operation(createTransactionalSqlExecutor(client)) };
  } catch (error) {
    outcome = { ok: false, error };
  }

  try {
    await client.end();
  } catch (closeError) {
    if (outcome.ok) throw closeError;
  }

  if (!outcome.ok) throw outcome.error;
  return outcome.result;
}
