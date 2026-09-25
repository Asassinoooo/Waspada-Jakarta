import { PGlite } from '@electric-sql/pglite';
import { postgis } from '@electric-sql/pglite-postgis';
import { vector } from '@electric-sql/pglite-pgvector';
import type { SqlExecutor, TransactionalSqlExecutor } from '../src/sql.js';

export interface TestDatabase {
  readonly database: PGlite;
  readonly executor: TransactionalSqlExecutor;
  close(): Promise<void>;
}

export async function createTestDatabase(): Promise<TestDatabase> {
  const database = await PGlite.create({ extensions: { postgis, vector } });
  const executor: TransactionalSqlExecutor = {
    async query<Row extends object>(statement: string, parameters?: readonly unknown[]) {
      const result = await database.query<Row>(statement, parameters ? [...parameters] : undefined);
      return { rows: result.rows };
    },
    async execute(statement: string) {
      await database.exec(statement);
    },
    async transaction<Result>(work: (transaction: SqlExecutor) => Promise<Result>): Promise<Result> {
      return database.transaction(async (client) => {
        const transaction: SqlExecutor = {
          async query<Row extends object>(statement: string, parameters?: readonly unknown[]) {
            const result = await client.query<Row>(statement, parameters ? [...parameters] : undefined);
            return { rows: result.rows };
          },
          async execute(statement: string) {
            await client.exec(statement);
          },
        };
        return work(transaction);
      });
    },
  };

  return { database, executor, close: () => database.close() };
}
