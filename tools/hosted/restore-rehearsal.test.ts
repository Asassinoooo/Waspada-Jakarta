// NFR-06: restore rehearsal round trip on in-process PGlite. A source database is built from the migrations and a
// small authored fixture, exported with the same code the hosted command uses, restored into a fresh PGlite, and
// compared. No network. The output directories are under .codex-build/restore and are removed afterwards.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { appendFile, cp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { createAccountStore } from "../../apps/db/src/accounts.js";
import { applyMigrations, readMigrations } from "../../apps/db/src/migrations.js";
import type { TransactionalSqlExecutor, SqlExecutor } from "../../apps/db/src/sql.js";
import { createTestDatabase, type TestDatabase } from "../../apps/db/test/harness.js";
import { DEFAULT_NEWS_FEEDS } from "../../apps/worker/src/runtime/news-poll-runtime.js";
import { seedLiveSourcesInsertMissing } from "../live-sources-seed.js";
import {
  EXCLUDED_SECRET_TABLES,
  RESTORE_ROOT,
  REHEARSAL_FORMAT,
  exportDatabase,
  loadOrder,
  parseManifest,
  publicEventDigest,
  resolveRestoreDirectory,
  restoreDatabase,
  runCli,
  secretExclusionReason,
  type CatalogTable,
  type RehearsalManifest,
  type RestoreReport,
} from "./restore-rehearsal.js";

const MIGRATIONS = new URL("../../apps/db/migrations/", import.meta.url);
const FIRST = "2026-09-26T10:00:00.000000Z";
const SECOND = "2026-09-26T11:00:00.000000Z";
const TRACE = "rehearsal-fixture-trace";
const REVISION = "rehearsal-revision";
const CANDIDATE = "rehearsal-candidate";
const CONTEXT = "rehearsal-context";
const SOURCE_ID = DEFAULT_NEWS_FEEDS[0]?.sourceId ?? "";
const USERNAME = "rehearsal_user";
const PASSWORD_HASH = `pbkdf2-sha256$100000$${"A".repeat(22)}$${"B".repeat(43)}`;
const SESSION_TOKEN_SHA256 = "c".repeat(64);
const EVENT_IDS = ["rehearsal-event-a", "rehearsal-event-b"];

const createdDirectories: string[] = [];

function freshDirectory(): string {
  const dir = join(RESTORE_ROOT, `test-${randomUUID()}`);
  createdDirectories.push(dir);
  return dir;
}

function codeOf(error: unknown): string | undefined {
  return (error as { readonly code?: unknown } | null | undefined)?.code as string | undefined;
}

/** Authored fiction only. Same chain and record shape as the public event list tests, so the Worker's list reads it. */
async function seedPublishedEvents(executor: TransactionalSqlExecutor): Promise<void> {
  await executor.query(
    `INSERT INTO waspada.traces (trace_id, dataset_kind, started_at, outcome, metadata)
     VALUES ($1, 'live', $2, 'succeeded', '{"fixture":"authored-fiction-only"}'::jsonb)`,
    [TRACE, FIRST],
  );
  await executor.query(
    `INSERT INTO waspada.report_revisions
       (dataset_kind, report_revision_id, trace_id, source_id, canonical_url, content_hash,
        permitted_text, permitted_text_hash, normalization_version, retrieved_at, revision_status, record_json)
     VALUES ('live', $1, $2, $3, 'https://rehearsal.invalid/fixture', $4,
        'authored fixture text', $5, 'restore-rehearsal-v1', $6, 'unreviewed',
        '{"fixture":"authored-fiction-only"}'::jsonb)`,
    [REVISION, TRACE, SOURCE_ID, "b".repeat(64), "a".repeat(64), FIRST],
  );
  await executor.query(
    `INSERT INTO waspada.extraction_results
       (dataset_kind, candidate_id, trace_id, report_revision_id, category, record_json)
     VALUES ('live', $1, $2, $3, 'group_specific_critical_notices', '{"fixture":"authored-fiction-only"}'::jsonb)`,
    [CANDIDATE, TRACE, REVISION],
  );
  await executor.query(
    `INSERT INTO waspada.grounding_contexts
       (dataset_kind, context_id, trace_id, candidate_id, retrieval_version, index_version, sufficient, record_json)
     VALUES ('live', $1, $2, $3, 'restore-rehearsal-v1', 'restore-rehearsal-index-v1', true,
        '{"fixture":"authored-fiction-only"}'::jsonb)`,
    [CONTEXT, TRACE, CANDIDATE],
  );
  for (const [index, eventId] of EVENT_IDS.entries()) {
    const publishedAt = index === 0 ? FIRST : SECOND;
    const proposalId = `rehearsal-proposal-${eventId}`;
    const decisionId = `rehearsal-decision-${eventId}`;
    const record = eventRecord(eventId, publishedAt, decisionId);
    await executor.transaction(async (transaction) => {
      await transaction.execute("SET CONSTRAINTS ALL DEFERRED");
      await transaction.query(
        `INSERT INTO waspada.event_proposals
           (dataset_kind, proposal_id, trace_id, candidate_id, context_id, event_id,
            base_event_version, proposed_at, record_json)
         VALUES ('live', $1, $2, $3, $4, NULL, NULL, $5, '{"fixture":"authored-fiction-only"}'::jsonb)`,
        [proposalId, TRACE, CANDIDATE, CONTEXT, FIRST],
      );
      await transaction.query(
        `INSERT INTO waspada.publication_decisions
           (dataset_kind, decision_id, trace_id, proposal_id, policy_version, event_id, event_version,
            decided_at, record_json)
         VALUES ('live', $1, $2, $3, 'restore-rehearsal-policy-v1', $4, 1, $5,
           '{"fixture":"authored-fiction-only"}'::jsonb)`,
        [decisionId, TRACE, proposalId, eventId, publishedAt],
      );
      await transaction.query(
        `INSERT INTO waspada.event_versions
           (dataset_kind, event_id, version, trace_id, supersedes_version, title, summary, category,
            lifecycle, publication_status, withdrawal_reason, publication_decision_id, published_at,
            withdrawn_at, record_json)
         VALUES ('live', $1, 1, $2, NULL, $3, $4, $5, 'unknown', 'published', NULL, $6, $7, NULL, $8::jsonb)`,
        [eventId, TRACE, record.title, record.summary, record.category, decisionId, publishedAt, JSON.stringify(record)],
      );
    });
  }
}

function eventRecord(eventId: string, publishedAt: string, decisionId: string): {
  title: string;
  summary: string;
  category: string;
} & Record<string, unknown> {
  const title = "Fictional rehearsal event";
  const summary = "Authored fictional content for a restore rehearsal.";
  const category = "group_specific_critical_notices";
  return {
    schema_version: "2.0",
    trace_id: TRACE,
    record_type: "Event",
    dataset_kind: "live",
    event_id: eventId,
    version: 1,
    supersedes_version: null,
    title,
    summary,
    category,
    tags: [],
    lifecycle: "unknown",
    freshness: { status: "current", evaluated_at: FIRST, review_due_at: null, basis: "unknown" },
    event_time: { start: null, end: null, precision: "unknown" },
    validity: { valid_from: null, valid_until: null },
    scope: { place_ids: [], service_ids: [], institution_ids: [], audience_ids: [], geometry_ids: [] },
    claims: [{ claim_id: `claim-${eventId}-v1` }],
    impact_refs: [],
    publication_status: "published",
    withdrawal_reason: null,
    publication_decision_id: decisionId,
    published_at: publishedAt,
    withdrawn_at: null,
  };
}

/** A SqlExecutor that records statements and attempts one write from inside the export's transaction. */
interface WriteProbe {
  readonly statements: string[];
  writeError: string | undefined;
}

function probingExecutor(inner: TransactionalSqlExecutor, probe: WriteProbe): TransactionalSqlExecutor {
  return {
    query: (text, values) => inner.query(text, values),
    execute: (text) => inner.execute(text),
    transaction: (work) =>
      inner.transaction(async (transaction) => {
        let attempted = false;
        const attemptWrite = async (): Promise<void> => {
          if (attempted) return;
          attempted = true;
          // A failed statement aborts the transaction, so the attempt sits inside a savepoint.
          await transaction.execute("SAVEPOINT rehearsal_write_probe");
          try {
            await transaction.execute("UPDATE waspada.dataset_namespace_config SET dataset_kind = dataset_kind");
            probe.writeError = "write_succeeded";
          } catch (error) {
            probe.writeError = String(codeOf(error) ?? "unknown");
          }
          await transaction.execute("ROLLBACK TO SAVEPOINT rehearsal_write_probe");
          await transaction.execute("RELEASE SAVEPOINT rehearsal_write_probe");
        };
        const wrapped: SqlExecutor = {
          query: async (text, values) => {
            await attemptWrite();
            return transaction.query(text, values);
          },
          execute: async (text) => {
            probe.statements.push(text);
            await transaction.execute(text);
          },
        };
        return work(wrapped);
      }),
  };
}

async function countIn(executor: SqlExecutor, table: string): Promise<number> {
  const result = await executor.query<{ n: string }>(`SELECT count(*)::text AS n FROM "waspada"."${table}"`);
  return Number(result.rows[0]?.n);
}

async function listFiles(dir: string): Promise<string[]> {
  return readdir(dir);
}

describe("restore rehearsal", () => {
  let source: TestDatabase;
  let exportDir: string;
  let exportSummary: Awaited<ReturnType<typeof exportDatabase>>;
  let manifest: RehearsalManifest;
  let report: RestoreReport;
  let restored: TestDatabase | undefined;
  let migrationCount: number;

  before(async () => {
    source = await createTestDatabase();
    const migrations = await readMigrations(MIGRATIONS);
    migrationCount = migrations.length;
    await applyMigrations(source.executor, migrations);
    await source.executor.query("INSERT INTO waspada.dataset_namespace_config (singleton, dataset_kind) VALUES (true, 'live')");
    await seedLiveSourcesInsertMissing(source.executor);
    await seedPublishedEvents(source.executor);

    const accounts = createAccountStore(source.executor, "live");
    const now = "2026-09-26T09:00:00.000000Z";
    const account = await accounts.createPasswordAccount({
      datasetMode: "live",
      username: USERNAME,
      passwordHash: PASSWORD_HASH,
      displayName: "Rehearsal user",
      role: "user",
      now,
    });
    await accounts.createSession({
      accountId: account.id,
      tokenSha256: SESSION_TOKEN_SHA256,
      channel: "mobile",
      csrfToken: null,
      createdAt: now,
      idleExpiresAt: "2026-09-26T10:00:00.000000Z",
      absoluteExpiresAt: "2026-09-27T09:00:00.000000Z",
    });

    exportDir = freshDirectory();
    exportSummary = await exportDatabase({ executor: source.executor, outDir: exportDir });
    manifest = parseManifest(JSON.parse(await readFile(join(exportDir, "manifest.json"), "utf8")));
    report = await restoreDatabase({
      fromDir: exportDir,
      createDatabase: async () => {
        // The test keeps the database open for the digest check below, so the restore must not close it.
        restored = await createTestDatabase();
        return { executor: restored.executor, close: async () => {} };
      },
    });
  });

  after(async () => {
    await Promise.allSettled([restored?.close(), source?.close()]);
    for (const dir of createdDirectories) await rm(dir, { recursive: true, force: true });
  });

  it("excludes account and session state, recording only counts", async () => {
    for (const name of EXCLUDED_SECRET_TABLES) {
      const entry = manifest.tables.find((table) => table.name === name);
      assert.ok(entry, `${name} is listed in the manifest`);
      assert.equal(entry.status, "excluded");
      assert.equal(entry.reason, "secrets");
      assert.equal(entry.file, undefined);
    }
    assert.equal(manifest.tables.find((table) => table.name === "accounts")?.rowCount, 1);
    assert.equal(manifest.tables.find((table) => table.name === "account_sessions")?.rowCount, 1);
    assert.ok(!manifest.tables.some((table) => table.name === "schema_migrations"), "the ledger is not a data table");

    const files = await listFiles(exportDir);
    for (const name of EXCLUDED_SECRET_TABLES) {
      assert.ok(!files.includes(`${name}.ndjson`), `${name}.ndjson is not written`);
    }
    assert.equal(exportSummary.excludedTables, EXCLUDED_SECRET_TABLES.length);
  });

  it("keeps password hashes, session token hashes and usernames out of every dump file", async () => {
    const files = await listFiles(exportDir);
    for (const file of files) {
      const text = await readFile(join(exportDir, file), "utf8");
      assert.ok(!text.includes(PASSWORD_HASH), `${file} has no password hash`);
      assert.ok(!text.includes(SESSION_TOKEN_SHA256), `${file} has no session token hash`);
      assert.ok(!text.includes(USERNAME), `${file} has no account username`);
      assert.ok(!text.includes("pbkdf2-sha256"), `${file} has no credential string`);
    }
  });

  it("records the migration ids and checksums from the ledger, matching the repository", async () => {
    const migrations = await readMigrations(MIGRATIONS);
    assert.equal(manifest.migrations.length, migrations.length);
    assert.equal(manifest.format, REHEARSAL_FORMAT);
    assert.deepEqual(
      manifest.migrations.map((migration) => migration.version),
      migrations.map((migration) => migration.version),
    );
    for (const migration of manifest.migrations) {
      assert.match(migration.checksum_sha256, /^[0-9a-f]{64}$/u);
    }
  });

  it("writes manifest row counts that match the source database", async () => {
    for (const entry of manifest.tables.filter((table) => table.status === "exported")) {
      assert.equal(entry.rowCount, await countIn(source.executor, entry.name), `${entry.name} count`);
    }
    const registry = manifest.tables.find((table) => table.name === "source_registry");
    assert.ok(registry !== undefined && registry.rowCount >= EVENT_IDS.length, "seeded sources are exported");
    assert.equal(manifest.tables.find((table) => table.name === "event_versions")?.rowCount, EVENT_IDS.length);
  });

  it("restores every table to the manifest counts and the same published events", async () => {
    assert.equal(report.ok, true);
    assert.equal(report.countsMatch, true);
    assert.equal(report.tables.length, exportSummary.exportedTables);
    assert.ok(report.tables.every((check) => check.match), "every table count matches");
    assert.equal(report.migrations.applied, migrationCount);
    assert.equal(report.migrations.match, true);
    assert.equal(report.publicEvents.expectedCount, EVENT_IDS.length);
    assert.equal(report.publicEvents.actualCount, EVENT_IDS.length);
    assert.equal(report.publicEvents.match, true);
    assert.equal(report.foreignKeysRestored, true, "foreign keys are back to their original definitions");
    assert.ok(report.foreignKeysDeferredDuringLoad > 0);
    assert.ok(report.triggersDisabledDuringLoad > 0);
  });

  it("reads the same public event digest from the source and from the restored database", async () => {
    assert.ok(restored, "the restore target was created");
    const fromSource = await publicEventDigest(source.executor);
    const fromRestore = await publicEventDigest(restored.executor);
    assert.deepEqual(fromRestore, fromSource);
    assert.deepEqual(fromSource, manifest.publicEvents);
    assert.equal(fromSource.count, EVENT_IDS.length);
  });

  it("writes restore-report.json next to the dump with timings and counts", async () => {
    const written = JSON.parse(await readFile(join(exportDir, "restore-report.json"), "utf8")) as RestoreReport;
    assert.equal(written.ok, true);
    assert.equal(written.countsMatch, true);
    assert.equal(typeof written.timingsSeconds.restore, "number");
    assert.ok(written.export.bytes > 0, "export bytes are reported");
  });

  it("reads the export in one read-only snapshot and rejects a write attempt made inside it", async () => {
    const probe: WriteProbe = { statements: [], writeError: undefined };
    const dir = freshDirectory();
    const summary = await exportDatabase({ executor: probingExecutor(source.executor, probe), outDir: dir });
    assert.equal(probe.statements[0], "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY");
    assert.equal(probe.writeError, "25006", "an UPDATE inside the export fails with read_only_sql_transaction");
    assert.equal(summary.rows, exportSummary.rows);
  });

  it("refuses to write into a directory that already has files", async () => {
    await assert.rejects(
      exportDatabase({ executor: source.executor, outDir: exportDir }),
      (error: unknown) => codeOf(error) === "out_dir_not_empty",
    );
  });

  it("refuses a dump whose file was changed, before any restore database exists", async () => {
    const copy = freshDirectory();
    await cp(exportDir, copy, { recursive: true });
    await appendFile(join(copy, "source_registry.ndjson"), "\n");
    await assert.rejects(
      restoreDatabase({
        fromDir: copy,
        createDatabase: async () => {
          throw new Error("no database is expected");
        },
      }),
      (error: unknown) => codeOf(error) === "file_checksum_mismatch",
    );
  });

  it("refuses a dump whose migration checksum differs, before any restore database exists", async () => {
    const copy = freshDirectory();
    await cp(exportDir, copy, { recursive: true });
    const altered = JSON.parse(await readFile(join(copy, "manifest.json"), "utf8")) as RehearsalManifest;
    const changed = {
      ...altered,
      migrations: altered.migrations.map((migration, index) =>
        index === 0 ? { ...migration, checksum_sha256: "0".repeat(64) } : migration),
    };
    await writeFile(join(copy, "manifest.json"), `${JSON.stringify(changed)}\n`);
    await assert.rejects(
      restoreDatabase({
        fromDir: copy,
        createDatabase: async () => {
          throw new Error("no database is expected");
        },
      }),
      (error: unknown) => codeOf(error) === "migrations_mismatch",
    );
  });
});

describe("restore rehearsal helpers", () => {
  it("accepts only a directory strictly inside .codex-build/restore", () => {
    const inside = join(RESTORE_ROOT, "run-1");
    assert.equal(resolveRestoreDirectory(inside), inside);
    assert.throws(() => resolveRestoreDirectory(RESTORE_ROOT), (error: unknown) => codeOf(error) === "dir_outside_restore_root");
    assert.throws(() => resolveRestoreDirectory("/etc"), (error: unknown) => codeOf(error) === "dir_outside_restore_root");
    assert.throws(
      () => resolveRestoreDirectory(join(RESTORE_ROOT, "..", "..", "src")),
      (error: unknown) => codeOf(error) === "dir_outside_restore_root",
    );
  });

  it("orders parents before children and reports the cyclic remainder", () => {
    const result = loadOrder(
      ["a", "b", "c", "x", "y"],
      [
        { child: "b", parent: "a" },
        { child: "c", parent: "b" },
        { child: "c", parent: "c" },
        { child: "x", parent: "y" },
        { child: "y", parent: "x" },
      ],
    );
    assert.deepEqual([...result.order], ["a", "b", "c"]);
    assert.deepEqual([...result.cyclic], ["x", "y"]);
  });

  it("excludes any table with a credential-style column, and nothing else", () => {
    const credential: CatalogTable = {
      name: "new_login_state",
      columns: [{ name: "id", identity: false }, { name: "csrf_token", identity: false }],
      primaryKey: ["id"],
    };
    const plain: CatalogTable = {
      name: "ai_jobs",
      columns: [{ name: "id", identity: false }, { name: "lease_token", identity: false }],
      primaryKey: ["id"],
    };
    assert.equal(secretExclusionReason(credential), "secrets");
    assert.equal(secretExclusionReason(plain), undefined);
    assert.equal(secretExclusionReason({ name: "accounts", columns: [], primaryKey: [] }), "secrets");
  });

  it("refuses a dump directory outside the restore root before any connection", async () => {
    const quiet = (): void => {};
    await assert.rejects(
      runCli(["export", "--out", "/etc/restore-rehearsal-test"], { NEON_DATABASE_URL: "" }, quiet),
      (error: unknown) => codeOf(error) === "dir_outside_restore_root",
    );
    await assert.rejects(runCli([], {}, quiet), (error: unknown) => codeOf(error) === "usage");
    await assert.rejects(
      runCli(["export", "--out", join(RESTORE_ROOT, "no-url")], {}, quiet),
      (error: unknown) => codeOf(error) === "neon_url_missing",
    );
  });
});
