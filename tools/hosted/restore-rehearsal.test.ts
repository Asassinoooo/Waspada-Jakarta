// NFR-06: restore rehearsal round trip on in-process PGlite. A source database is built from the migrations and a
// small authored fixture, exported with the same code the hosted command uses, restored into a fresh PGlite, and
// compared. No network. The output directories are under .codex-build/restore and are removed afterwards.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { appendFile, cp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { createAccountStore } from "../../apps/db/src/accounts.js";
import { applyMigrations, readMigrations } from "../../apps/db/src/migrations.js";
import { createPublicEventListRepository, type PublicEventListCursor } from "../../apps/db/src/public-event-list.js";
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
  tombstoneSummary,
  type CatalogTable,
  type RehearsalManifest,
  type RestoreReport,
} from "./restore-rehearsal.js";

const MIGRATIONS = new URL("../../apps/db/migrations/", import.meta.url);
const FIRST = "2026-09-26T10:00:00.000000Z";
const SECOND = "2026-09-26T11:00:00.000000Z";
const TRACE = "rehearsal-fixture-trace";
const REVISION = "rehearsal-revision";
/** The publisher's notice revision, whose observation withdraws REVISION. */
const NOTICE_REVISION = "rehearsal-revision-notice";
const WITHDRAWAL_OBSERVATION = "rehearsal-observation-withdrawn";
const CANDIDATE = "rehearsal-candidate";
const CONTEXT = "rehearsal-context";
const SOURCE_ID = DEFAULT_NEWS_FEEDS[0]?.sourceId ?? "";
const USERNAME = "rehearsal_user";
const PASSWORD_HASH = `pbkdf2-sha256$100000$${"A".repeat(22)}$${"B".repeat(43)}`;
const SESSION_TOKEN_SHA256 = "c".repeat(64);
const EVENT_IDS = ["rehearsal-event-a", "rehearsal-event-b"];
/** Published at version 1, then withdrawn at version 2. It must stay hidden from the public views after a restore. */
const WITHDRAWN_EVENT_ID = "rehearsal-event-withdrawn";
const WITHDRAWN_AT = "2026-09-26T12:00:00.000000Z";
/** Two live events at version 1, and the withdrawn event at versions 1 and 2. */
const EVENT_VERSION_ROWS = EVENT_IDS.length + 2;

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
    `INSERT INTO waspada.report_revisions
       (dataset_kind, report_revision_id, trace_id, source_id, canonical_url, content_hash,
        permitted_text, permitted_text_hash, normalization_version, retrieved_at, revision_status, record_json)
     VALUES ('live', $1, $2, $3, 'https://rehearsal.invalid/notice', $4,
        'authored notice text', $5, 'restore-rehearsal-v1', $6, 'unreviewed',
        '{"fixture":"authored-fiction-only"}'::jsonb)`,
    [NOTICE_REVISION, TRACE, SOURCE_ID, "d".repeat(64), "e".repeat(64), SECOND],
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
  for (const [index, eventId] of [...EVENT_IDS, WITHDRAWN_EVENT_ID].entries()) {
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

  // The withdrawal the moderator path writes: a withdraw decision and a withdrawn tombstone version (no claims).
  const withdrawalDecisionId = `rehearsal-decision-${WITHDRAWN_EVENT_ID}-withdraw`;
  const published = eventRecord(WITHDRAWN_EVENT_ID, SECOND, `rehearsal-decision-${WITHDRAWN_EVENT_ID}`);
  const tombstone = {
    ...published,
    version: 2,
    supersedes_version: 1,
    claims: [],
    impact_refs: [],
    publication_status: "withdrawn",
    withdrawal_reason: "source_retracted",
    publication_decision_id: withdrawalDecisionId,
    published_at: null,
    withdrawn_at: WITHDRAWN_AT,
    freshness: { status: "needs_update", evaluated_at: WITHDRAWN_AT, review_due_at: null, basis: "unknown" },
  };
  await executor.transaction(async (transaction) => {
    await transaction.execute("SET CONSTRAINTS ALL DEFERRED");
    await transaction.query(
      `INSERT INTO waspada.publication_decisions
         (dataset_kind, decision_id, trace_id, proposal_id, policy_version, event_id, event_version,
          reviewer_id, decided_at, record_json)
       VALUES ('live', $1, $2, $3, 'restore-rehearsal-policy-v1', $4, 2, NULL, $5,
         '{"disposition":"withdraw","reason_category":"source_retracted","supersedes_version":1}'::jsonb)`,
      [withdrawalDecisionId, TRACE, `rehearsal-proposal-${WITHDRAWN_EVENT_ID}`, WITHDRAWN_EVENT_ID, WITHDRAWN_AT],
    );
    await transaction.query(
      `INSERT INTO waspada.event_versions
         (dataset_kind, event_id, version, trace_id, supersedes_version, title, summary, category,
          lifecycle, publication_status, withdrawal_reason, publication_decision_id, published_at,
          withdrawn_at, record_json)
       VALUES ('live', $1, 2, $2, 1, $3, $4, $5, 'unknown', 'withdrawn', 'source_retracted', $6, NULL, $7, $8::jsonb)`,
      [
        WITHDRAWN_EVENT_ID, TRACE, tombstone.title, tombstone.summary, tombstone.category, withdrawalDecisionId,
        WITHDRAWN_AT, JSON.stringify(tombstone),
      ],
    );
  });

  // The publisher withdraws REVISION by observation, and SOURCE_ID is revoked (approval only; collection continues).
  await executor.query(
    `INSERT INTO waspada.report_revision_source_observations
       (dataset_kind, observation_id, trace_id, source_id, target_report_revision_id,
        assertion_report_revision_id, asserted_state, replacement_report_revision_id,
        publisher_observed_at, retrieved_at)
     VALUES ('live', $1, $2, $3, $4, $5, 'withdrawn', NULL, NULL, $6)`,
    [WITHDRAWAL_OBSERVATION, TRACE, SOURCE_ID, REVISION, NOTICE_REVISION, SECOND],
  );
  await executor.query(
    `UPDATE waspada.source_registry SET approval_status = 'revoked', auto_publication_policy = 'never'
     WHERE source_id = $1`,
    [SOURCE_ID],
  );
}

/**
 * Rewrites one exported table file without the rows `drop` accepts, and rewrites that table's manifest entry, so the
 * file checks (bytes, SHA-256, line count) and the row count still match. Returns how many rows were removed.
 */
async function dropRowsFromDumpTable(
  dir: string,
  table: string,
  drop: (row: Record<string, unknown>) => boolean,
): Promise<number> {
  const file = join(dir, `${table}.ndjson`);
  const lines = (await readFile(file, "utf8")).split("\n").filter((line) => line !== "");
  const kept = lines.filter((line) => !drop(JSON.parse(line) as Record<string, unknown>));
  const text = `${kept.join("\n")}\n`;
  await writeFile(file, text);

  const manifestPath = join(dir, "manifest.json");
  const document = JSON.parse(await readFile(manifestPath, "utf8")) as RehearsalManifest;
  const tables = document.tables.map((entry) => (entry.name !== table || entry.status !== "exported"
    ? entry
    : {
      ...entry,
      rowCount: kept.length,
      bytes: Buffer.byteLength(text, "utf8"),
      sha256: createHash("sha256").update(text, "utf8").digest("hex"),
    }));
  await writeFile(manifestPath, `${JSON.stringify({ ...document, tables })}\n`);
  return lines.length - kept.length;
}

/**
 * Tampering for the negative test: removes the withdrawal from the dump, meaning the withdraw decision and the
 * withdrawn version row. They are removed together because publication_decisions has a deferred foreign key to
 * event_versions. The dump stays consistent, so the only thing that changes is the tombstone.
 */
async function dropWithdrawalFromDump(dir: string): Promise<void> {
  const decisions = await dropRowsFromDumpTable(dir, "publication_decisions", (row) =>
    row.event_id === WITHDRAWN_EVENT_ID && row.event_version === 2);
  const versions = await dropRowsFromDumpTable(dir, "event_versions", (row) =>
    row.event_id === WITHDRAWN_EVENT_ID && row.publication_status === "withdrawn");
  assert.equal(decisions, 1, "the withdraw decision is dropped");
  assert.equal(versions, 1, "the withdrawn version row is dropped");
}

/** The public list as the Worker reads it: every page, the candidate event ids and versions. */
async function listedPublicEvents(executor: SqlExecutor): Promise<string[]> {
  const repository = createPublicEventListRepository(executor);
  const listed: string[] = [];
  let cursor: PublicEventListCursor | null = null;
  do {
    const page = await repository.read(cursor === null ? { limit: 100 } : { limit: 100, cursor });
    for (const candidate of page.candidates) listed.push(`${candidate.eventId}@${candidate.eventVersion}`);
    cursor = page.nextCursor;
  } while (cursor !== null);
  return listed;
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
    assert.equal(manifest.tables.find((table) => table.name === "event_versions")?.rowCount, EVENT_VERSION_ROWS);
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

  it("NFR-06: the withdrawn event is still withdrawn after restore and absent from the public list and views", async () => {
    assert.ok(restored, "the restore target was created");
    const latest = await restored.executor.query<{
      version: number;
      publication_status: string;
      withdrawal_reason: string | null;
    }>(
      `SELECT version, publication_status, withdrawal_reason FROM waspada.event_versions
       WHERE dataset_kind = 'live' AND event_id = $1 ORDER BY version DESC LIMIT 1`,
      [WITHDRAWN_EVENT_ID],
    );
    assert.deepEqual(latest.rows[0], { version: 2, publication_status: "withdrawn", withdrawal_reason: "source_retracted" });

    const shown = await restored.executor.query<{ versions: string; history: string }>(
      `SELECT
         (SELECT count(*) FROM waspada.public_event_versions WHERE event_id = $1)::text AS versions,
         (SELECT count(*) FROM waspada.public_event_history_versions WHERE event_id = $1)::text AS history`,
      [WITHDRAWN_EVENT_ID],
    );
    assert.deepEqual(shown.rows[0], { versions: "0", history: "0" });
    const listed = (await listedPublicEvents(restored.executor)).map((entry) => entry.split("@")[0]);
    assert.deepEqual([...listed].sort(), [...EVENT_IDS].sort(), "only the live events are listed");
  });

  it("NFR-06: the tombstone summary is identical on the source and on the restored database", async () => {
    assert.ok(restored, "the restore target was created");
    const fromSource = await tombstoneSummary(source.executor);
    const fromRestore = await tombstoneSummary(restored.executor);
    assert.deepEqual(fromRestore, fromSource);
    assert.deepEqual(manifest.tombstones, fromSource);
    assert.equal(fromSource.withdrawnEvents.count, 1, "one withdrawn event");
    assert.equal(fromSource.withdrawnRevisions.count, 1, "one withdrawn source revision");
    assert.equal(fromSource.revokedSources.count, 1, "one revoked source");
    assert.equal(fromSource.withdrawnVisibleInPublic, 0, "no withdrawn event is public on the source");
  });

  it("NFR-06: the restore report records the tombstone counts and tombstonesPreserved true", async () => {
    const written = JSON.parse(await readFile(join(exportDir, "restore-report.json"), "utf8")) as RestoreReport;
    assert.equal(written.tombstonesPreserved, true);
    assert.deepEqual(written.tombstones.withdrawnEvents, { expected: 1, actual: 1, match: true });
    assert.deepEqual(written.tombstones.withdrawnRevisions, { expected: 1, actual: 1, match: true });
    assert.deepEqual(written.tombstones.revokedSources, { expected: 1, actual: 1, match: true });
    assert.equal(written.tombstones.withdrawnVisibleInPublic, 0);
  });

  it("NFR-06: a restore that drops the withdrawal reports tombstonesPreserved false", async () => {
    const copy = freshDirectory();
    await cp(exportDir, copy, { recursive: true });
    await dropWithdrawalFromDump(copy);
    const tampered = await createTestDatabase();
    try {
      const tamperedReport = await restoreDatabase({
        fromDir: copy,
        createDatabase: async () => ({ executor: tampered.executor, close: async () => {} }),
      });
      assert.equal(tamperedReport.tombstonesPreserved, false);
      assert.equal(tamperedReport.tombstones.withdrawnEvents.match, false, "the withdrawn event set no longer matches");
      assert.equal(tamperedReport.tombstones.withdrawnEvents.actual, 0, "the restored database holds no withdrawal");
      assert.equal(tamperedReport.ok, false, "the rehearsal fails when a withdrawal is lost");
    } finally {
      await tampered.close();
    }
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
