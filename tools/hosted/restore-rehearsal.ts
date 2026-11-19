// NFR-06: recoverability rehearsal for the hosted Neon database. There is no pg_dump or docker on the rehearsal
// host, so the rehearsal is a logical export made in Node and a restore into a fresh PGlite.
//
//   npm run hosted:restore-rehearsal -- export --out .codex-build/restore/<run>
//   npm run hosted:restore-rehearsal -- restore --from .codex-build/restore/<run>
//
// export reads NEON_DATABASE_URL inside one REPEATABLE READ, READ ONLY transaction. Its first statement is
// SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY, so every read in the export sees one snapshot.
// Each table is streamed through a cursor into <table>.ndjson, one row_to_json document per line. The tool keeps
// one batch in memory, not the whole table. manifest.json records the migration ids and checksums from the ledger,
// row counts, and a SHA-256 and byte count per file. It also records the published event count and a digest of
// the sorted event ids and versions, read through the same public list repository the Worker uses.
//
// Secrets are never exported. The account, session, login-attempt and throttle tables are excluded by name, and any
// other table with a credential-style column is excluded too. Only their row counts go into the manifest.
//
// restore builds a fresh in-memory PGlite and applies apps/db/migrations with applyMigrations. It refuses the dump if
// the migration ids or checksums differ from the manifest, and it checks each file's SHA-256 before loading anything.
// The load runs in one transaction. Every foreign key on a restored table is made deferrable for that transaction,
// so cycles and self references are checked at commit and the load order does not depend on row order. User triggers
// are disabled during the load, as pg_restore --disable-triggers does, so insert-time sequence assignment does not
// rewrite the saved values. Foreign-key checks stay on. Afterwards the constraints go back to their original
// definitions, and the row counts and the public event digest are compared with the manifest. restore-report.json is
// written next to the dump.
//
// Dumps contain live source text and embeddings. Keep them under .codex-build/restore/ (gitignored) and delete them
// after the rehearsal. Output messages carry counts, file names and error codes only, never a URL or host.
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, type WriteStream } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { once } from "node:events";
import { finished } from "node:stream/promises";
import readline from "node:readline";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { applyMigrations, readMigrations, type SqlMigration } from "../../apps/db/src/migrations.js";
import { createPublicEventListRepository, type PublicEventListCursor } from "../../apps/db/src/public-event-list.js";
import type { SqlExecutor, TransactionalSqlExecutor } from "../../apps/db/src/sql.js";
import { createTestDatabase } from "../../apps/db/test/harness.js";
import { safeErrorLabel } from "../live-source-coverage.js";
import { createHostedSession } from "./hosted-session.js";

export const REHEARSAL_FORMAT = "waspada-restore-rehearsal-v1";
export const REHEARSAL_REPORT_FORMAT = "waspada-restore-rehearsal-report-v1";
export const REPO_ROOT = resolve(fileURLToPath(new URL("../../", import.meta.url)));
/** Dumps and reports may be written only under this gitignored directory. */
export const RESTORE_ROOT = resolve(REPO_ROOT, ".codex-build", "restore");
const MIGRATIONS_DIRECTORY = new URL("../../apps/db/migrations/", import.meta.url);
const SCHEMA = "waspada";
const MANIFEST_FILE = "manifest.json";
const REPORT_FILE = "restore-report.json";
/** The migrations ledger is read into the manifest, not exported as rows: a restore rebuilds it by applying migrations. */
const LEDGER_TABLE = "schema_migrations";
const FETCH_ROWS = 500;
const LOAD_LINES = 500;
const LOAD_BYTES = 4_000_000;
const PUBLIC_PAGE_SIZE = 100;
const EXPORT_CURSOR = "rehearsal_export_rows";

/** Account, session and credential state. Excluded by name, so a new column on one of these cannot leak. */
export const EXCLUDED_SECRET_TABLES: readonly string[] = [
  "accounts",
  "account_sessions",
  "account_login_attempts",
  "account_login_throttles",
  "account_admin_audit",
];
/** Any other table with one of these columns is excluded too (fails closed for a new credential table). */
export const SECRET_COLUMNS: ReadonlySet<string> = new Set([
  "password_hash",
  "token_sha256",
  "prior_session_token_sha256",
  "csrf_token",
  "code_verifier",
  "nonce",
  "state_sha256",
  "browser_cookie_sha256",
  "client_key_sha256",
]);

export class RehearsalError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = "RehearsalError";
    this.code = code;
  }
}

type Log = (line: string) => void;

export interface CatalogColumn {
  readonly name: string;
  readonly identity: boolean;
}

export interface CatalogTable {
  readonly name: string;
  readonly columns: readonly CatalogColumn[];
  readonly primaryKey: readonly string[];
}

export interface CatalogForeignKey {
  readonly name: string;
  readonly child: string;
  readonly parent: string;
  readonly deferrable: boolean;
}

export interface Catalog {
  readonly tables: readonly CatalogTable[];
  readonly foreignKeys: readonly CatalogForeignKey[];
}

export interface ManifestMigration {
  readonly version: string;
  readonly checksum_sha256: string;
}

export interface ManifestTable {
  readonly name: string;
  readonly status: "exported" | "excluded";
  readonly reason?: "secrets";
  readonly rowCount: number;
  readonly file?: string;
  readonly bytes?: number;
  readonly sha256?: string;
}

export interface PublicEventDigest {
  readonly count: number;
  readonly sha256: string;
}

export interface RehearsalManifest {
  readonly format: typeof REHEARSAL_FORMAT;
  readonly exportedAt: string;
  readonly exportSeconds: number;
  readonly schema: typeof SCHEMA;
  readonly migrations: readonly ManifestMigration[];
  readonly tables: readonly ManifestTable[];
  /** Parents before children over non-self foreign keys. Cycles are listed after the acyclic part. */
  readonly loadOrder: readonly string[];
  readonly cyclicTables: readonly string[];
  readonly publicEvents: PublicEventDigest;
}

export interface ExportSummary {
  readonly outDir: string;
  readonly exportedTables: number;
  readonly excludedTables: number;
  readonly rows: number;
  readonly bytes: number;
  readonly seconds: number;
}

export interface RestoreTarget {
  readonly executor: TransactionalSqlExecutor;
  close(): Promise<void>;
}

export interface TableCountCheck {
  readonly name: string;
  readonly expected: number;
  readonly actual: number;
  readonly match: boolean;
}

export interface RestoreReport {
  readonly format: typeof REHEARSAL_REPORT_FORMAT;
  readonly restoredAt: string;
  readonly sourceExportedAt: string;
  readonly export: {
    readonly bytes: number;
    readonly seconds: number;
    readonly exportedTables: number;
    readonly excludedTables: readonly string[];
    readonly rows: number;
  };
  readonly migrations: { readonly expected: number; readonly applied: number; readonly match: boolean };
  readonly tables: readonly TableCountCheck[];
  readonly countsMatch: boolean;
  readonly publicEvents: {
    readonly expectedCount: number;
    readonly actualCount: number;
    readonly match: boolean;
  };
  readonly foreignKeysDeferredDuringLoad: number;
  readonly foreignKeysRestored: boolean;
  readonly triggersDisabledDuringLoad: number;
  readonly timingsSeconds: {
    readonly verifyFiles: number;
    readonly restore: number;
    readonly verify: number;
  };
  readonly ok: boolean;
}

// ---- Catalog ------------------------------------------------------------------------------------------------

const COLUMNS_SQL = `
SELECT c.relname AS table_name, a.attname AS column_name, a.attidentity IN ('a', 'd') AS is_identity
FROM pg_class AS c
JOIN pg_namespace AS n ON n.oid = c.relnamespace
JOIN pg_attribute AS a ON a.attrelid = c.oid
WHERE n.nspname = '${SCHEMA}' AND c.relkind IN ('r', 'p') AND NOT c.relispartition
  AND a.attnum > 0 AND NOT a.attisdropped
ORDER BY c.relname, a.attnum`;

const PRIMARY_KEY_SQL = `
SELECT c.relname AS table_name, a.attname AS column_name
FROM pg_index AS i
JOIN pg_class AS c ON c.oid = i.indrelid
JOIN pg_namespace AS n ON n.oid = c.relnamespace
CROSS JOIN LATERAL unnest(i.indkey::int2[]) WITH ORDINALITY AS key(attnum, ordinal)
JOIN pg_attribute AS a ON a.attrelid = c.oid AND a.attnum = key.attnum
WHERE i.indisprimary AND n.nspname = '${SCHEMA}' AND c.relkind IN ('r', 'p') AND NOT c.relispartition
ORDER BY c.relname, key.ordinal`;

const FOREIGN_KEY_SQL = `
SELECT con.conname AS name, child.relname AS child_table, parent.relname AS parent_table, con.condeferrable AS deferrable
FROM pg_constraint AS con
JOIN pg_class AS child ON child.oid = con.conrelid
JOIN pg_namespace AS child_ns ON child_ns.oid = child.relnamespace
JOIN pg_class AS parent ON parent.oid = con.confrelid
JOIN pg_namespace AS parent_ns ON parent_ns.oid = parent.relnamespace
WHERE con.contype = 'f' AND child_ns.nspname = '${SCHEMA}' AND parent_ns.nspname = '${SCHEMA}'
ORDER BY child.relname, con.conname`;

export async function readCatalog(executor: SqlExecutor): Promise<Catalog> {
  const columns = await executor.query<{ table_name: string; column_name: string; is_identity: boolean }>(COLUMNS_SQL);
  const keys = await executor.query<{ table_name: string; column_name: string }>(PRIMARY_KEY_SQL);
  const foreignKeys = await executor.query<{
    name: string;
    child_table: string;
    parent_table: string;
    deferrable: boolean;
  }>(FOREIGN_KEY_SQL);

  const tables = new Map<string, { columns: CatalogColumn[]; primaryKey: string[] }>();
  for (const row of columns.rows) {
    let table = tables.get(row.table_name);
    if (table === undefined) {
      table = { columns: [], primaryKey: [] };
      tables.set(row.table_name, table);
    }
    table.columns.push({ name: row.column_name, identity: row.is_identity === true });
  }
  for (const row of keys.rows) tables.get(row.table_name)?.primaryKey.push(row.column_name);

  return {
    tables: [...tables.entries()].map(([name, table]) => ({ name, columns: table.columns, primaryKey: table.primaryKey })),
    foreignKeys: foreignKeys.rows.map((row) => ({
      name: row.name,
      child: row.child_table,
      parent: row.parent_table,
      deferrable: row.deferrable === true,
    })),
  };
}

/**
 * Parents before children over the non-self foreign keys between the given tables. Any table left in a cycle is
 * returned in `cyclic`, sorted by name. The restore defers every foreign key for its load, so a cycle does not stop
 * it, and the order is only a reading aid.
 */
export function loadOrder(
  tables: readonly string[],
  foreignKeys: readonly { readonly child: string; readonly parent: string }[],
): { readonly order: readonly string[]; readonly cyclic: readonly string[] } {
  const names = new Set(tables);
  const parentsOf = new Map<string, Set<string>>();
  for (const name of names) parentsOf.set(name, new Set());
  for (const fk of foreignKeys) {
    if (fk.child === fk.parent || !names.has(fk.child) || !names.has(fk.parent)) continue;
    parentsOf.get(fk.child)?.add(fk.parent);
  }
  const order: string[] = [];
  const placed = new Set<string>();
  let remaining = [...names].sort();
  for (;;) {
    const ready = remaining.filter((name) => [...(parentsOf.get(name) ?? [])].every((parent) => placed.has(parent)));
    if (ready.length === 0) break;
    for (const name of ready) {
      order.push(name);
      placed.add(name);
    }
    remaining = remaining.filter((name) => !placed.has(name));
  }
  return { order, cyclic: remaining };
}

function quoteIdentifier(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

function qualifiedTable(name: string): string {
  return `${quoteIdentifier(SCHEMA)}.${quoteIdentifier(name)}`;
}

/** A table is excluded when it is on the account list or has a credential-style column. */
export function secretExclusionReason(table: CatalogTable): "secrets" | undefined {
  if (EXCLUDED_SECRET_TABLES.includes(table.name)) return "secrets";
  return table.columns.some((column) => SECRET_COLUMNS.has(column.name)) ? "secrets" : undefined;
}

// ---- Public read ---------------------------------------------------------------------------------------------

/** The published event count and a digest of the sorted `event_id<TAB>version` keys, read through the Worker's list repository. */
export async function publicEventDigest(executor: SqlExecutor): Promise<PublicEventDigest> {
  const repository = createPublicEventListRepository(executor);
  const keys: string[] = [];
  let cursor: PublicEventListCursor | null = null;
  do {
    const page = await repository.read(cursor === null ? { limit: PUBLIC_PAGE_SIZE } : { limit: PUBLIC_PAGE_SIZE, cursor });
    if (page.candidates.length === 0 && page.nextCursor !== null) throw new RehearsalError("public_read_stalled");
    for (const candidate of page.candidates) keys.push(`${candidate.eventId}\t${candidate.eventVersion}`);
    cursor = page.nextCursor;
  } while (cursor !== null);
  keys.sort();
  const hash = createHash("sha256");
  for (const key of keys) hash.update(`${key}\n`);
  return { count: keys.length, sha256: hash.digest("hex") };
}

// ---- Export --------------------------------------------------------------------------------------------------

/** Accepts only a directory strictly inside .codex-build/restore, so dumps never land in a tracked path. */
export function resolveRestoreDirectory(input: string, base: string = RESTORE_ROOT): string {
  const target = resolve(process.cwd(), input);
  const rel = relative(base, target);
  if (rel === "" || isAbsolute(rel) || rel.split(sep)[0] === "..") throw new RehearsalError("dir_outside_restore_root");
  return target;
}

async function requireEmptyDirectory(dir: string): Promise<void> {
  let entries: string[] = [];
  try {
    entries = await readdir(dir);
  } catch (error) {
    if ((error as { code?: unknown }).code !== "ENOENT") throw error;
  }
  if (entries.length > 0) throw new RehearsalError("out_dir_not_empty");
  await mkdir(dir, { recursive: true });
}

interface NdjsonWriter {
  write(lines: readonly string[]): Promise<void>;
  close(): Promise<{ readonly bytes: number; readonly sha256: string }>;
  destroy(): void;
}

async function openNdjsonWriter(path: string): Promise<NdjsonWriter> {
  const stream: WriteStream = createWriteStream(path, { flags: "wx" });
  let failure: Error | undefined;
  stream.on("error", (error) => {
    failure = error;
  });
  const hash = createHash("sha256");
  let bytes = 0;
  return {
    async write(lines) {
      if (failure !== undefined) throw failure;
      if (lines.length === 0) return;
      const chunk = Buffer.from(`${lines.join("\n")}\n`, "utf8");
      hash.update(chunk);
      bytes += chunk.length;
      if (!stream.write(chunk)) await once(stream, "drain");
    },
    async close() {
      stream.end();
      await finished(stream);
      return { bytes, sha256: hash.digest("hex") };
    },
    destroy() {
      stream.destroy();
    },
  };
}

function exportSelect(table: CatalogTable): string {
  const order = table.primaryKey.length > 0 ? ` ORDER BY ${table.primaryKey.map(quoteIdentifier).join(", ")}` : "";
  return `SELECT row_to_json(t)::text AS doc FROM ${qualifiedTable(table.name)} AS t${order}`;
}

async function countRows(executor: SqlExecutor, table: string): Promise<number> {
  const result = await executor.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${qualifiedTable(table)}`);
  const count = Number(result.rows[0]?.n);
  if (!Number.isSafeInteger(count)) throw new RehearsalError("count_unreadable");
  return count;
}

async function writeTableFile(
  executor: SqlExecutor,
  table: CatalogTable,
  path: string,
): Promise<{ readonly rows: number; readonly bytes: number; readonly sha256: string }> {
  const writer = await openNdjsonWriter(path);
  try {
    await executor.execute(`DECLARE ${EXPORT_CURSOR} NO SCROLL CURSOR FOR ${exportSelect(table)}`);
    let rows = 0;
    for (;;) {
      const page = await executor.query<{ doc: unknown }>(`FETCH FORWARD ${FETCH_ROWS} FROM ${EXPORT_CURSOR}`);
      if (page.rows.length === 0) break;
      const docs = page.rows.map((row) => {
        if (typeof row.doc !== "string" || row.doc.includes("\n")) throw new RehearsalError("row_not_single_line");
        return row.doc;
      });
      await writer.write(docs);
      rows += docs.length;
    }
    await executor.execute(`CLOSE ${EXPORT_CURSOR}`);
    const closed = await writer.close();
    return { rows, bytes: closed.bytes, sha256: closed.sha256 };
  } catch (error) {
    writer.destroy();
    throw error;
  }
}

/** Reads the whole export inside one read-only snapshot and writes the dump to outDir. */
export async function exportDatabase(options: {
  readonly executor: TransactionalSqlExecutor;
  readonly outDir: string;
  readonly log?: Log;
}): Promise<ExportSummary> {
  const log = options.log ?? (() => {});
  const started = performance.now();
  await requireEmptyDirectory(options.outDir);

  const snapshot = await options.executor.transaction(async (tx) => {
    // The first statement of the transaction. Nothing below can write, because the transaction is read-only.
    await tx.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY");

    const catalog = await readCatalog(tx);
    const ledger = await tx.query<{ version: string; checksum_sha256: string }>(
      `SELECT version, checksum_sha256 FROM ${qualifiedTable(LEDGER_TABLE)} ORDER BY version`,
    );
    const migrations = ledger.rows.map((row) => ({ version: row.version, checksum_sha256: row.checksum_sha256 }));

    const dataTables = catalog.tables.filter((table) => table.name !== LEDGER_TABLE);
    const byName = new Map(dataTables.map((table) => [table.name, table]));
    const exported = dataTables.filter((table) => secretExclusionReason(table) === undefined);
    const order = loadOrder(
      exported.map((table) => table.name),
      catalog.foreignKeys.filter((fk) => exported.some((table) => table.name === fk.child)),
    );

    const counts = new Map<string, number>();
    for (const table of dataTables) counts.set(table.name, await countRows(tx, table.name));
    const publicEvents = await publicEventDigest(tx);

    const entries: ManifestTable[] = [];
    for (const table of dataTables) {
      const reason = secretExclusionReason(table);
      if (reason === undefined) continue;
      entries.push({ name: table.name, status: "excluded", reason, rowCount: counts.get(table.name) ?? 0 });
      log(`[export] ${table.name}: excluded (secrets); count recorded only`);
    }
    let rows = 0;
    let bytes = 0;
    for (const name of [...order.order, ...order.cyclic]) {
      const table = byName.get(name);
      if (table === undefined) throw new RehearsalError("catalog_inconsistent");
      const file = `${name}.ndjson`;
      const written = await writeTableFile(tx, table, join(options.outDir, file));
      if (written.rows !== (counts.get(name) ?? -1)) throw new RehearsalError("export_row_count_mismatch");
      rows += written.rows;
      bytes += written.bytes;
      entries.push({ name, status: "exported", rowCount: written.rows, file, bytes: written.bytes, sha256: written.sha256 });
      log(`[export] ${name}: ${written.rows} row(s)`);
    }

    return { migrations, entries, loadOrder: [...order.order, ...order.cyclic], cyclicTables: order.cyclic, publicEvents, rows, bytes };
  });

  const seconds = roundSeconds(performance.now() - started);
  const document: RehearsalManifest = {
    format: REHEARSAL_FORMAT,
    exportedAt: new Date().toISOString(),
    exportSeconds: seconds,
    schema: SCHEMA,
    migrations: snapshot.migrations,
    tables: [...snapshot.entries].sort(byTableName),
    loadOrder: snapshot.loadOrder,
    cyclicTables: snapshot.cyclicTables,
    publicEvents: snapshot.publicEvents,
  };
  await writeFile(join(options.outDir, MANIFEST_FILE), `${JSON.stringify(document, null, 2)}\n`, { flag: "wx" });

  const exportedTables = snapshot.entries.filter((table) => table.status === "exported").length;
  return {
    outDir: options.outDir,
    exportedTables,
    excludedTables: snapshot.entries.length - exportedTables,
    rows: snapshot.rows,
    bytes: snapshot.bytes,
    seconds,
  };
}

function byTableName(left: { readonly name: string }, right: { readonly name: string }): number {
  if (left.name === right.name) return 0;
  return left.name < right.name ? -1 : 1;
}

// ---- Restore -------------------------------------------------------------------------------------------------

const SHA256_PATTERN = /^[0-9a-f]{64}$/u;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** Validates the manifest shape before anything is trusted. A file name must be a bare `<table>.ndjson`. */
export function parseManifest(value: unknown): RehearsalManifest {
  if (!isRecord(value) || value.format !== REHEARSAL_FORMAT || value.schema !== SCHEMA) {
    throw new RehearsalError("manifest_invalid");
  }
  if (!Array.isArray(value.migrations) || !Array.isArray(value.tables) || !Array.isArray(value.loadOrder)) {
    throw new RehearsalError("manifest_invalid");
  }
  if (!isRecord(value.publicEvents) || !isCount(value.publicEvents.count)
    || typeof value.publicEvents.sha256 !== "string" || !SHA256_PATTERN.test(value.publicEvents.sha256)) {
    throw new RehearsalError("manifest_invalid");
  }
  for (const migration of value.migrations) {
    if (!isRecord(migration) || typeof migration.version !== "string"
      || typeof migration.checksum_sha256 !== "string" || !SHA256_PATTERN.test(migration.checksum_sha256)) {
      throw new RehearsalError("manifest_invalid");
    }
  }
  for (const table of value.tables) {
    if (!isRecord(table) || typeof table.name !== "string" || !isCount(table.rowCount)) {
      throw new RehearsalError("manifest_invalid");
    }
    if (table.status === "excluded") {
      if (table.reason !== "secrets" || table.file !== undefined) throw new RehearsalError("manifest_invalid");
      continue;
    }
    if (table.status !== "exported" || table.file !== `${table.name}.ndjson` || basename(table.name) !== table.name
      || !isCount(table.bytes) || typeof table.sha256 !== "string" || !SHA256_PATTERN.test(table.sha256)) {
      throw new RehearsalError("manifest_invalid");
    }
  }
  return value as unknown as RehearsalManifest;
}

async function readManifest(dir: string): Promise<RehearsalManifest> {
  let text: string;
  try {
    text = await readFile(join(dir, MANIFEST_FILE), "utf8");
  } catch {
    throw new RehearsalError("manifest_missing");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new RehearsalError("manifest_invalid");
  }
  return parseManifest(parsed);
}

function exportedEntries(manifest: RehearsalManifest): ManifestTable[] {
  return manifest.tables.filter((table): table is ManifestTable => table.status === "exported");
}

/** Streams each dump file and checks its byte count, newline count and SHA-256 against the manifest. */
async function verifyExportFiles(dir: string, manifest: RehearsalManifest): Promise<void> {
  for (const table of exportedEntries(manifest)) {
    if (table.file === undefined || table.bytes === undefined || table.sha256 === undefined) {
      throw new RehearsalError("manifest_invalid");
    }
    const hash = createHash("sha256");
    let bytes = 0;
    let lines = 0;
    try {
      for await (const chunk of createReadStream(join(dir, table.file))) {
        const buffer = chunk as Buffer;
        hash.update(buffer);
        bytes += buffer.length;
        for (let index = buffer.indexOf(10); index !== -1; index = buffer.indexOf(10, index + 1)) lines += 1;
      }
    } catch {
      throw new RehearsalError("file_missing");
    }
    if (bytes !== table.bytes || hash.digest("hex") !== table.sha256) throw new RehearsalError("file_checksum_mismatch");
    if (lines !== table.rowCount) throw new RehearsalError("file_row_count_mismatch");
  }
}

async function checkMigrations(manifest: RehearsalManifest): Promise<SqlMigration[]> {
  const migrations = await readMigrations(MIGRATIONS_DIRECTORY);
  const expected = migrations
    .map((migration) => ({
      version: migration.version,
      checksum_sha256: createHash("sha256").update(migration.sql, "utf8").digest("hex"),
    }))
    .sort((left, right) => left.version.localeCompare(right.version));
  const recorded = [...manifest.migrations].sort((left, right) => left.version.localeCompare(right.version));
  const same = expected.length === recorded.length
    && expected.every((item, index) => item.version === recorded[index]?.version
      && item.checksum_sha256 === recorded[index]?.checksum_sha256);
  if (!same) throw new RehearsalError("migrations_mismatch");
  return migrations;
}

function identityColumns(table: CatalogTable): string[] {
  return table.columns.filter((column) => column.identity).map((column) => column.name);
}

async function insertBatch(executor: SqlExecutor, table: string, lines: readonly string[]): Promise<void> {
  await executor.query(
    `INSERT INTO ${qualifiedTable(table)} OVERRIDING SYSTEM VALUE`
      + ` SELECT r.* FROM json_populate_recordset(NULL::${qualifiedTable(table)}, $1::json) AS r`,
    [`[${lines.join(",")}]`],
  );
}

async function loadFile(executor: SqlExecutor, table: string, path: string): Promise<number> {
  const reader = readline.createInterface({ input: createReadStream(path, { encoding: "utf8" }), crlfDelay: Infinity });
  let batch: string[] = [];
  let batchBytes = 0;
  let loaded = 0;
  for await (const line of reader) {
    if (line === "") throw new RehearsalError("file_line_empty");
    batch.push(line);
    batchBytes += line.length;
    if (batch.length >= LOAD_LINES || batchBytes >= LOAD_BYTES) {
      await insertBatch(executor, table, batch);
      loaded += batch.length;
      batch = [];
      batchBytes = 0;
    }
  }
  if (batch.length > 0) {
    await insertBatch(executor, table, batch);
    loaded += batch.length;
  }
  return loaded;
}

/**
 * Restores the dump into a fresh database and returns the report. Throws a RehearsalError (code only) when the dump
 * cannot be trusted or cannot be loaded. A count or digest mismatch returns a report with ok false.
 */
export async function restoreDatabase(options: {
  readonly fromDir: string;
  readonly createDatabase?: () => Promise<RestoreTarget>;
  readonly log?: Log;
}): Promise<RestoreReport> {
  const log = options.log ?? (() => {});
  const manifest = await readManifest(options.fromDir);
  const exported = exportedEntries(manifest);
  const exportBytes = exported.reduce((total, table) => total + (table.bytes ?? 0), 0);

  const verifyFilesStarted = performance.now();
  await verifyExportFiles(options.fromDir, manifest);
  const verifyFiles = roundSeconds(performance.now() - verifyFilesStarted);
  log(`[restore] dump files verified: ${exported.length} table file(s), ${exportBytes} bytes.`);

  // Checked before any database exists, so a dump from another schema is refused without a restore target.
  const migrations = await checkMigrations(manifest);
  const restoreStarted = performance.now();
  const target = await (options.createDatabase ?? createTestDatabase)();
  try {
    const applied = await applyMigrations(target.executor, migrations);
    log(`[restore] migrations: ${applied.applied.length} applied on a fresh database (${migrations.length} expected).`);

    const catalog = await readCatalog(target.executor);
    const restoredNames = new Set(exported.map((table) => table.name));
    const catalogTables = new Map(catalog.tables.map((table) => [table.name, table]));
    for (const name of restoredNames) {
      if (!catalogTables.has(name)) throw new RehearsalError("table_missing_after_migrations");
    }
    const planned = loadOrder([...restoredNames], catalog.foreignKeys.filter((fk) => restoredNames.has(fk.child)));
    const load = [...planned.order, ...planned.cyclic]
      .map((name) => {
        const table = exported.find((entry) => entry.name === name);
        if (table?.file === undefined) throw new RehearsalError("manifest_invalid");
        const catalogTable = catalogTables.get(name);
        if (catalogTable === undefined) throw new RehearsalError("table_missing_after_migrations");
        return { name, file: table.file, identity: identityColumns(catalogTable) };
      });
    // Every non-deferrable foreign key on a restored table is deferred for the load and put back afterwards.
    const toDefer = catalog.foreignKeys.filter((fk) => restoredNames.has(fk.child) && !fk.deferrable);

    let triggersDisabled = 0;
    await target.executor.transaction(async (tx) => {
      for (const fk of toDefer) {
        await tx.execute(
          `ALTER TABLE ${qualifiedTable(fk.child)} ALTER CONSTRAINT ${quoteIdentifier(fk.name)} DEFERRABLE INITIALLY DEFERRED`,
        );
      }
      await tx.execute("SET CONSTRAINTS ALL DEFERRED");
      for (const entry of load) {
        await tx.execute(`ALTER TABLE ${qualifiedTable(entry.name)} DISABLE TRIGGER USER`);
        triggersDisabled += 1;
      }
      // The target is a fresh database, so the only rows here are the ones migrations seeded. The dump replaces them.
      for (const entry of [...load].reverse()) {
        await tx.execute(`DELETE FROM ${qualifiedTable(entry.name)}`);
      }
      for (const entry of load) {
        const loaded = await loadFile(tx, entry.name, join(options.fromDir, entry.file));
        log(`[restore] ${entry.name}: ${loaded} row(s) loaded`);
        for (const column of entry.identity) {
          await tx.query(
            `SELECT setval(pg_get_serial_sequence($1, $2), (SELECT COALESCE(max(${quoteIdentifier(column)}), 0) + 1 FROM ${qualifiedTable(entry.name)}), false)`,
            [`${SCHEMA}.${entry.name}`, column],
          );
        }
      }
    });
    // Foreign-key checks ran at commit. Put the triggers and the original constraint definitions back in a second
    // transaction: ALTER TABLE is refused while deferred trigger events are still pending in the load transaction.
    await target.executor.transaction(async (tx) => {
      for (const entry of load) await tx.execute(`ALTER TABLE ${qualifiedTable(entry.name)} ENABLE TRIGGER USER`);
      for (const fk of toDefer) {
        await tx.execute(
          `ALTER TABLE ${qualifiedTable(fk.child)} ALTER CONSTRAINT ${quoteIdentifier(fk.name)} NOT DEFERRABLE`,
        );
      }
    });
    const restoreSeconds = roundSeconds(performance.now() - restoreStarted);

    const verifyStarted = performance.now();
    const after = await readCatalog(target.executor);
    const foreignKeysRestored = foreignKeyFlags(after.foreignKeys) === foreignKeyFlags(catalog.foreignKeys);
    const tableChecks: TableCountCheck[] = [];
    for (const table of exported) {
      const actual = await countRows(target.executor, table.name);
      tableChecks.push({ name: table.name, expected: table.rowCount, actual, match: actual === table.rowCount });
    }
    const countsMatch = tableChecks.every((check) => check.match);
    const publicNow = await publicEventDigest(target.executor);
    const publicMatch = publicNow.count === manifest.publicEvents.count && publicNow.sha256 === manifest.publicEvents.sha256;
    const verifySeconds = roundSeconds(performance.now() - verifyStarted);

    const report: RestoreReport = {
      format: REHEARSAL_REPORT_FORMAT,
      restoredAt: new Date().toISOString(),
      sourceExportedAt: manifest.exportedAt,
      export: {
        bytes: exportBytes,
        seconds: manifest.exportSeconds,
        exportedTables: exported.length,
        excludedTables: manifest.tables.filter((table) => table.status === "excluded").map((table) => table.name),
        rows: exported.reduce((total, table) => total + table.rowCount, 0),
      },
      migrations: { expected: migrations.length, applied: applied.applied.length, match: true },
      tables: tableChecks,
      countsMatch,
      publicEvents: { expectedCount: manifest.publicEvents.count, actualCount: publicNow.count, match: publicMatch },
      foreignKeysDeferredDuringLoad: toDefer.length,
      foreignKeysRestored,
      triggersDisabledDuringLoad: triggersDisabled,
      timingsSeconds: { verifyFiles, restore: restoreSeconds, verify: verifySeconds },
      ok: countsMatch && publicMatch && foreignKeysRestored,
    };
    await writeFile(join(options.fromDir, REPORT_FILE), `${JSON.stringify(report, null, 2)}\n`);
    return report;
  } finally {
    await target.close();
  }
}

/** Comparable text of every foreign key's name and deferrability, so a restore can be checked against the original. */
function foreignKeyFlags(foreignKeys: readonly CatalogForeignKey[]): string {
  return foreignKeys
    .map((fk) => `${fk.child}.${fk.name}:${fk.deferrable ? "deferrable" : "immediate"}`)
    .sort()
    .join("\n");
}

function roundSeconds(milliseconds: number): number {
  return Math.round(milliseconds) / 1000;
}

// ---- Command line --------------------------------------------------------------------------------------------

const USAGE = [
  "usage:",
  "  hosted:restore-rehearsal -- export --out .codex-build/restore/<run>   (reads NEON_DATABASE_URL, read only)",
  "  hosted:restore-rehearsal -- restore --from .codex-build/restore/<run> (fresh PGlite, writes restore-report.json)",
].join("\n");

interface CliArguments {
  readonly command: string | undefined;
  readonly out: string | undefined;
  readonly from: string | undefined;
}

/** Undefined for any unknown flag, a stray positional, or a missing value. */
function parseCliArguments(argv: readonly string[]): CliArguments | undefined {
  try {
    const parsed = parseArgs({
      args: [...argv],
      allowPositionals: true,
      strict: true,
      options: { out: { type: "string" }, from: { type: "string" } },
    });
    if (parsed.positionals.length > 1) return undefined;
    return { command: parsed.positionals[0], out: parsed.values.out, from: parsed.values.from };
  } catch {
    return undefined;
  }
}

export async function runCli(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
  log: Log = console.log,
): Promise<number> {
  const args = parseCliArguments(argv);
  if (args === undefined) {
    log(USAGE);
    throw new RehearsalError("usage");
  }
  const { command, out, from } = args;

  if (command === "export") {
    if (out === undefined) throw new RehearsalError("usage");
    const outDir = resolveRestoreDirectory(out);
    const url = env.NEON_DATABASE_URL;
    if (url === undefined || url.length === 0) throw new RehearsalError("neon_url_missing");
    const session = createHostedSession({ connectionString: url, log });
    try {
      const summary = await exportDatabase({ executor: session.executor, outDir, log });
      log(JSON.stringify({ status: "exported", ...summary }));
      return 0;
    } finally {
      await session.close();
    }
  }

  if (command === "restore") {
    if (from === undefined) throw new RehearsalError("usage");
    const fromDir = resolveRestoreDirectory(from);
    const report = await restoreDatabase({ fromDir, log });
    log(JSON.stringify({
      status: report.ok ? "restored" : "mismatch",
      countsMatch: report.countsMatch,
      publicEventsMatch: report.publicEvents.match,
      publicEvents: report.publicEvents.actualCount,
      foreignKeysRestored: report.foreignKeysRestored,
      restoreSeconds: report.timingsSeconds.restore,
      exportBytes: report.export.bytes,
    }));
    return report.ok ? 0 : 1;
  }

  log(USAGE);
  throw new RehearsalError("usage");
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && fileURLToPath(import.meta.url) === resolve(entry);
}

if (isDirectRun()) {
  runCli(process.argv.slice(2), process.env)
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      // Only a code or error class is printed. Messages can contain hosts.
      console.error(JSON.stringify({ status: "error", reason: safeErrorLabel(error) }));
      process.exitCode = 1;
    });
}
