// HOSTED-03 / H1: one-time (and idempotent) bootstrap of a hosted Neon database for headless live ingest.
//
//   npm run hosted:bootstrap      (reads NEON_DATABASE_URL and the optional WASPADA_ADMIN_* from .env.local)
//
// Steps: check server version, apply every migration, check the layer roles against pg_roles and grant
// them to the owner login (WITH SET TRUE), set the dataset namespace to live, insert missing live sources
// (never changing an existing row), then seed the administrator if credentials are set. It prints step
// names and counts only. Errors print a code or error class, never a message, URL or host.
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createAccountStore } from "../../apps/db/src/accounts.js";
import { applyMigrations, readMigrations } from "../../apps/db/src/migrations.js";
import { seedAdminAccount } from "../../apps/worker/src/accounts/seed-admin.js";
import {
  checkLiveSourceCoverage,
  expectedLiveSourceIds,
  formatCoverageFailure,
  formatCoverageSkips,
  livePollSourceIds,
  loadRegistryRows,
  safeErrorLabel,
} from "../live-source-coverage.js";
import { seedLiveSourcesInsertMissing } from "../live-sources-seed.js";
import { createHostedSession, HostedConfigError } from "./hosted-session.js";
import { diffLayerRoles, LAYER_ROLES, LAYER_ROLE_NAME_PATTERN } from "./layer-roles.js";

export { diffLayerRoles, LAYER_ROLES } from "./layer-roles.js";

const LIVE_DATASET = "live" as const;
// WITH SET TRUE on GRANT needs PostgreSQL 16 or later. Neon's current default is newer.
const MIN_SERVER_VERSION_NUM = 160000;

type Log = (line: string) => void;

export async function runHostedBootstrap(env: NodeJS.ProcessEnv, log: Log = console.log): Promise<number> {
  const session = createHostedSession({
    connectionString: env.NEON_DATABASE_URL ?? "",
    log,
  });
  try {
    const executor = session.executor;

    const version = await executor.query<{ version_num: string }>(
      "SELECT current_setting('server_version_num') AS version_num",
    );
    const versionNum = Number(version.rows[0]?.version_num ?? 0);
    if (!(versionNum >= MIN_SERVER_VERSION_NUM)) throw new HostedConfigError("postgres_version_below_16");
    log(`[1/6] Server version check passed (server_version_num ${versionNum}).`);

    const migrations = await readMigrations(new URL("../../apps/db/migrations/", import.meta.url));
    const applied = await applyMigrations(executor, migrations);
    log(`[2/6] Migrations: ${applied.applied.length} applied, ${applied.skipped.length} already applied (${migrations.length} files).`);

    const present = await executor.query<{ rolname: string }>(
      "SELECT rolname FROM pg_roles WHERE rolname LIKE 'waspada%' ORDER BY rolname",
    );
    const diff = diffLayerRoles(LAYER_ROLES, present.rows.map((row) => row.rolname));
    if (diff.missing.length > 0) {
      log(`[3/6] Missing layer roles (a migration did not create them): ${diff.missing.join(", ")}`);
      throw new HostedConfigError("layer_roles_missing");
    }
    if (diff.unexpected.length > 0) {
      log(`[3/6] Warning: waspada roles not in the layer list: ${diff.unexpected.join(", ")}`);
    }
    for (const role of LAYER_ROLES) {
      if (!LAYER_ROLE_NAME_PATTERN.test(role)) throw new HostedConfigError("layer_role_name_invalid");
      await executor.execute(`GRANT "${role}" TO CURRENT_USER WITH SET TRUE`);
    }
    log(`[3/6] Layer roles granted to the owner login: ${LAYER_ROLES.length}.`);

    const namespace = await executor.query<{ dataset_kind: string }>(
      "SELECT dataset_kind FROM waspada.dataset_namespace_config",
    );
    const existingKind = namespace.rows[0]?.dataset_kind;
    if (existingKind !== undefined && existingKind !== LIVE_DATASET) {
      log(`[4/6] Dataset namespace is already '${existingKind}'. Refusing to change it.`);
      throw new HostedConfigError("namespace_not_live");
    }
    if (existingKind === undefined) {
      await executor.query(
        "INSERT INTO waspada.dataset_namespace_config (singleton, dataset_kind) VALUES (true, $1) ON CONFLICT (singleton) DO NOTHING",
        [LIVE_DATASET],
      );
    }
    log(`[4/6] Dataset namespace: ${LIVE_DATASET} (${existingKind === undefined ? "created" : "already set"}).`);

    const sources = await seedLiveSourcesInsertMissing(executor);
    log(`[5/6] Live sources: ${sources.inserted} inserted, ${sources.existing} already present (never modified).`);
    const expectedIds = expectedLiveSourceIds();
    const coverage = checkLiveSourceCoverage({
      expectedIds,
      pollSetIds: livePollSourceIds(),
      rows: await loadRegistryRows(executor, expectedIds),
    });
    if (coverage.ok) {
      log(`[5/6] Source readiness: ${coverage.expected - coverage.notReady.length} of ${coverage.expected} ready; ${coverage.notReady.length} skipped (revoked or disabled rows are never changed here).`);
      for (const line of formatCoverageSkips(coverage)) log(`[5/6] ${line}`);
    } else {
      for (const line of formatCoverageFailure(coverage)) log(line);
      log("[5/6] A live source row is missing or the poll set is inconsistent. Headless ingest will refuse to start until it is fixed.");
    }

    const username = env.WASPADA_ADMIN_USERNAME;
    const password = env.WASPADA_ADMIN_PASSWORD;
    if (username && password) {
      const seeded = await seedAdminAccount(createAccountStore(executor, LIVE_DATASET), {
        username,
        password,
        now: new Date().toISOString(),
      });
      log(`[6/6] Administrator account: ${seeded.status}.`);
    } else {
      log("[6/6] Administrator seeding skipped (WASPADA_ADMIN_USERNAME / WASPADA_ADMIN_PASSWORD not set).");
    }
    // 0: complete (skipped sources are reported, not fatal). 2: a live source row is missing, so headless ingest refuses to start.
    return coverage.ok ? 0 : 2;
  } finally {
    await session.close();
  }
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && fileURLToPath(import.meta.url) === resolve(entry);
}

if (isDirectRun()) {
  runHostedBootstrap(process.env)
    .then((code) => {
      console.log(code === 0 ? "Hosted bootstrap finished." : "Hosted bootstrap finished; a live source row is missing (exit 2).");
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      // Only a code or error class is printed. Messages can contain hosts.
      console.error(JSON.stringify({ status: "error", reason: safeErrorLabel(error) }));
      process.exitCode = 1;
    });
}
