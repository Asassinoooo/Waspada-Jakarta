import { Client } from "pg";
import type { SqlExecutor, TransactionalSqlExecutor } from "../../db/src/sql.js";
import type { DatasetKind } from "../../db/src/ports.js";
import { createJobRunner } from "./job-runner.js";
import { getNineRouterConfig } from "./providers/ninerouter-adapter.js";

function createPgExecutor(client: Client): TransactionalSqlExecutor {
  const baseExecutor: SqlExecutor = {
    async query<Row extends object = Record<string, unknown>>(statement: string, parameters?: readonly unknown[]) {
      const res = await client.query(statement, parameters ? [...parameters] : undefined);
      return { rows: res.rows as readonly Row[] };
    },
    async execute(statement: string) {
      await client.query(statement);
    },
  };

  return {
    ...baseExecutor,
    async transaction<Result>(work: (tx: SqlExecutor) => Promise<Result>): Promise<Result> {
      await client.query("BEGIN");
      try {
        const result = await work(baseExecutor);
        await client.query("COMMIT");
        return result;
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      }
    },
  };
}

async function main() {
  console.log("Starting Waspada Jakarta Intelligence Worker...");
  const connectionString = process.env.DATABASE_URL || process.env.HYPERDRIVE_URL;
  const datasetKind = (process.env.DATASET_KIND as DatasetKind) || "live";
  const config = getNineRouterConfig();

  console.log(`Configured models: chat=${config.chatModel}, embedding=${config.embeddingModel}`);
  console.log(`Target dataset: ${datasetKind}`);

  const abortController = new AbortController();
  const onSignal = () => {
    console.log("Shutting down Intelligence Worker...");
    abortController.abort();
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  if (!connectionString) {
    console.log("DATABASE_URL not configured. Running in stand-by mode (waiting for database configuration).");
    return;
  }

  const client = new Client({ connectionString });
  await client.connect();
  console.log("Connected to PostgreSQL database.");

  const executor = createPgExecutor(client);
  const runner = createJobRunner({
    executor,
    transactionalExecutor: executor,
    config,
    leaseDurationMs: 300_000,
    pollIntervalMs: 3_000,
  });

  console.log("Polling for durable AI jobs in waspada.ai_jobs...");
  await runner.runLoop(abortController.signal, datasetKind);
  await client.end();
  console.log("Intelligence Worker stopped cleanly.");
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1])) {
  main().catch((err) => {
    console.error("Fatal worker error:", err);
    process.exit(1);
  });
}

export { main };
