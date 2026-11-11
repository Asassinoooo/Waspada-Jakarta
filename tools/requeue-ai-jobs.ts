// AI-RATE-01 manual re-drive: moves needs_review AI jobs that failed with
// model_failed or rate_limited back to pending. serve:live does the same once
// at start; this is for a stopped server. It opens the live PGlite data dir
// directly, so it refuses to run while a live process still holds that dir.
import fs from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { postgis } from "@electric-sql/pglite-postgis";
import { vector } from "@electric-sql/pglite-pgvector";
import { applyMigrations, readMigrations } from "../apps/db/src/migrations.js";
import type { SqlExecutor, TransactionalSqlExecutor } from "../apps/db/src/sql.js";
import { requeueStrandedAiJobs } from "../apps/db/src/incident-repository.js";

const REQUEUE_CODES = ["model_failed", "rate_limited"] as const;
const OWNER_FILES = ["serve-live.pid", "postmaster.pid"] as const;

function readPid(file: string): number | null {
  if (!fs.existsSync(file)) return null;
  const pid = Number.parseInt(fs.readFileSync(file, "utf8").trim().split(/\s+/)[0] ?? "", 10);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

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

  for (const name of OWNER_FILES) {
    const pid = readPid(path.join(dataDir, name));
    if (pid !== null && isProcessAlive(pid)) {
      console.error(`Refusing to run: ${name} names live process ${pid}. Stop serve:live first.`);
      process.exitCode = 1;
      return;
    }
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
