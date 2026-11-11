// AI-RATE-01 manual re-drive: moves needs_review AI jobs that failed with
// model_failed or rate_limited back to pending. serve:live does the same once
// at start; this is for a stopped server. It opens the live PGlite data dir
// directly, so it refuses to run while a live process still holds that dir (LIVE-SERVER-02 shared check).
import fs from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { postgis } from "@electric-sql/pglite-postgis";
import { vector } from "@electric-sql/pglite-pgvector";
import { applyMigrations, readMigrations } from "../apps/db/src/migrations.js";
import type { SqlExecutor, TransactionalSqlExecutor } from "../apps/db/src/sql.js";
import { requeueStrandedAiJobs } from "../apps/db/src/incident-repository.js";
import { assertLiveDbUnowned } from "./live-db-lock.js";

const REQUEUE_CODES = ["model_failed", "rate_limited"] as const;

function executorFor(database: PGlite): TransactionalSqlExecutor {
  const executor: TransactionalSqlExecutor = {
    async query<Row extends object>(statement: string, parameters?: readonly unknown[]) {
      const result = await database.query<Row>(statement, parameters ? [...parameters] : undefined);
      return { rows: result.rows };
    },
    async execute(statement: string) {
      await database.exec(statement);
    },
    async transaction<Result>(work: (tx: SqlExecutor) => Promise<Result>): Promise<Result> {
      return database.transaction(async (client) => {
        const tx: SqlExecutor = {
          async query<Row extends object>(stmt: string, params?: readonly unknown[]) {
            const result = await client.query<Row>(stmt, params ? [...params] : undefined);
            return { rows: result.rows };
          },
          async execute(stmt: string) {
            await client.exec(stmt);
          },
        };
        return work(tx);
      });
    },
  };
  return executor;
}

async function main(): Promise<void> {
  const dataDir = path.resolve(process.cwd(), ".data/live-db");
  if (!fs.existsSync(path.join(dataDir, "PG_VERSION"))) {
    console.error(`No live database at ${dataDir}. Nothing to requeue.`);
    process.exitCode = 1;
    return;
  }

  try {
    // LIVE-SERVER-02: the same owner check serve:live uses (serve-live.pid, postmaster.pid).
    assertLiveDbUnowned(dataDir);
  } catch (error) {
    console.error(`Refusing to run: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
    return;
  }

  const database = await PGlite.create({ dataDir, extensions: { postgis, vector } });
  try {
    const executor = executorFor(database);
    const migrations = await readMigrations(new URL("../apps/db/migrations/", import.meta.url));
    await applyMigrations(executor, migrations);
    const requeued = await requeueStrandedAiJobs(executor, { codes: REQUEUE_CODES });
    console.log(`Requeued ${requeued.length} needs_review AI jobs (${REQUEUE_CODES.join(", ")}).`);
  } finally {
    await database.close();
  }
}

main().catch((error: unknown) => {
  console.error("Requeue failed:", error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
