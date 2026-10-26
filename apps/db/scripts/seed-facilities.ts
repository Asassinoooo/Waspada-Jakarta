import { PGlite } from "@electric-sql/pglite";
import { postgis } from "@electric-sql/pglite-postgis";
import { vector } from "@electric-sql/pglite-pgvector";
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { applyMigrations, readMigrations } from "../src/migrations.js";
import {
  createFacilityRepository,
  type FacilityRecord,
} from "../src/facility-repository.js";
import { JAKARTA_FACILITIES } from "../src/jakarta-facilities-data.js";
import type { TransactionalSqlExecutor, SqlExecutor } from "../src/sql.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

async function main() {
  console.log("=== Seeding Jakarta Facilities into Local Database ===");

  // 1. Gather all unique facilities (combining snapshot + JAKARTA_FACILITIES)
  const snapshotPath = resolve(__dirname, "../../worker/src/demo/osm-reference-snapshot.json");
  const facilitiesMap = new Map<string, FacilityRecord>();

  if (existsSync(snapshotPath)) {
    try {
      const raw = JSON.parse(readFileSync(snapshotPath, "utf-8")) as { records?: FacilityRecord[] };
      if (Array.isArray(raw.records)) {
        for (const r of raw.records) {
          facilitiesMap.set(r.id, r);
        }
      }
    } catch (err) {
      console.warn("Could not read snapshot file:", err);
    }
  }

  for (const f of JAKARTA_FACILITIES) {
    facilitiesMap.set(f.id, f);
  }

  const allFacilities = Array.from(facilitiesMap.values());
  console.log(`Prepared ${allFacilities.length} facilities across DKI Jakarta.`);

  // 2. Initialize database
  const dbDir = resolve(__dirname, "../.pglite-data");
  const pglite = await PGlite.create({
    dataDir: dbDir,
    extensions: { postgis, vector },
  });

  const executor: TransactionalSqlExecutor = {
    async query<Row extends object>(statement: string, parameters?: readonly unknown[]) {
      const result = await pglite.query<Row>(statement, parameters ? [...parameters] : undefined);
      return { rows: result.rows };
    },
    async execute(statement: string) {
      await pglite.exec(statement);
    },
    async transaction<Result>(work: (tx: SqlExecutor) => Promise<Result>): Promise<Result> {
      return pglite.transaction(async (client) => {
        const tx: SqlExecutor = {
          async query<Row extends object>(statement: string, parameters?: readonly unknown[]) {
            const result = await client.query<Row>(statement, parameters ? [...parameters] : undefined);
            return { rows: result.rows };
          },
          async execute(statement: string) {
            await client.exec(statement);
          },
        };
        return work(tx);
      });
    },
  };

  const migrations = await readMigrations(new URL("../migrations/", import.meta.url));
  await applyMigrations(executor, migrations);

  // 3. Seed facilities
  const repo = createFacilityRepository(executor);
  const seeded = await repo.seedFacilities(allFacilities, "live");
  console.log(`Successfully seeded ${seeded} facilities into waspada.geometries.`);

  // 4. Verification count from DB
  const verifyResult = await executor.query<{ count: string; kind: string }>(
    `SELECT count(*) as count, record_json->>'kind' as kind
     FROM waspada.geometries
     WHERE role = 'facility' AND dataset_kind = 'live'
     GROUP BY record_json->>'kind'`
  );

  console.log("Database facility counts by kind:");
  for (const row of verifyResult.rows) {
    console.log(`- ${row.kind}: ${row.count}`);
  }

  await pglite.close();
  console.log("=== Seeding Completed Successfully ===");
}

main().catch((err) => {
  console.error("Seeding failed:", err);
  process.exit(1);
});
