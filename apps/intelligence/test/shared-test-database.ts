// One migrated PGlite database per test-file process, reset to its post-migration baseline before each test.
//
// Why: creating and closing several PGlite instances in one V8 process aborts natively with
// `ThreadIsolation::UnregisterWasmAllocation` under Node 24 (CI-INTEL-01). node --test already runs each
// file in its own process, so one shared database per file keeps the instance count at one.
//
// Isolation: sharedTestDatabase() truncates every waspada table except schema_migrations, restarts identity
// sequences and re-inserts the rows the migrations seeded (singleton counters and cursors). Four tables carry
// BEFORE TRUNCATE guards and are referenced by foreign keys from the rest of the schema, so a TRUNCATE that
// skips them is refused by PostgreSQL. Their guard triggers are therefore disabled only while the reset runs and
// are enabled again in a finally block. Assertions and production code are unchanged.
import { createTestDatabase, type TestDatabase } from "../../db/test/harness.js";
import { applyMigrations, readMigrations } from "../../db/src/migrations.js";

interface GuardTrigger {
  readonly table: string;
  readonly name: string;
}

interface SharedDatabase {
  readonly db: TestDatabase;
  readonly tables: readonly string[];
  readonly guards: readonly GuardTrigger[];
  /** Table name to its rows after migrations, as row_to_json text. Only tables that are not empty. */
  readonly seedRows: ReadonlyMap<string, readonly string[]>;
}

let shared: Promise<SharedDatabase> | undefined;

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

async function initialize(): Promise<SharedDatabase> {
  const db = await createTestDatabase();
  try {
    const migrations = await readMigrations(new URL("../../db/migrations/", import.meta.url));
    await applyMigrations(db.executor, migrations);

    const tables = (
      await db.executor.query<{ tablename: string }>(
        "SELECT tablename FROM pg_tables WHERE schemaname = 'waspada' AND tablename <> 'schema_migrations' ORDER BY tablename",
      )
    ).rows.map((row) => row.tablename);

    const guards = (
      await db.executor.query<{ table_name: string; trigger_name: string }>(
        `SELECT c.relname AS table_name, t.tgname AS trigger_name
           FROM pg_trigger t
           JOIN pg_class c ON c.oid = t.tgrelid
           JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'waspada' AND NOT t.tgisinternal AND (t.tgtype & 32) = 32
          ORDER BY 1, 2`,
      )
    ).rows.map((row) => ({ table: row.table_name, name: row.trigger_name }));

    const seedRows = new Map<string, readonly string[]>();
    for (const table of tables) {
      const rows = await db.executor.query<{ row: string }>(
        `SELECT row_to_json(seed)::text AS row FROM waspada.${quoteIdentifier(table)} AS seed`,
      );
      if (rows.rows.length > 0) seedRows.set(table, rows.rows.map((row) => row.row));
    }

    return { db, tables, guards, seedRows };
  } catch (error) {
    await db.close();
    throw error;
  }
}

async function resetToBaseline(state: SharedDatabase): Promise<void> {
  const { executor } = state.db;
  const disabled: GuardTrigger[] = [];
  try {
    for (const guard of state.guards) {
      await executor.execute(
        `ALTER TABLE waspada.${quoteIdentifier(guard.table)} DISABLE TRIGGER ${quoteIdentifier(guard.name)}`,
      );
      disabled.push(guard);
    }
    await executor.execute(
      `TRUNCATE ${state.tables.map((table) => `waspada.${quoteIdentifier(table)}`).join(", ")} RESTART IDENTITY`,
    );
    for (const [table, rows] of state.seedRows) {
      for (const row of rows) {
        await executor.query(
          `INSERT INTO waspada.${quoteIdentifier(table)} SELECT * FROM json_populate_record(NULL::waspada.${quoteIdentifier(table)}, $1::json)`,
          [row],
        );
      }
    }
  } finally {
    for (const guard of disabled) {
      await executor.execute(
        `ALTER TABLE waspada.${quoteIdentifier(guard.table)} ENABLE TRIGGER ${quoteIdentifier(guard.name)}`,
      );
    }
  }
}

/** The shared database, reset to its post-migration baseline. Call at the start of each test. */
export async function sharedTestDatabase(): Promise<TestDatabase> {
  shared ??= initialize();
  const state = await shared;
  await resetToBaseline(state);
  return state.db;
}

/** Closes the shared database. Call once from a file-level after() hook. */
export async function closeSharedTestDatabase(): Promise<void> {
  const pending = shared;
  shared = undefined;
  if (!pending) return;
  const state = await pending.catch(() => undefined);
  await state?.db.close();
}
