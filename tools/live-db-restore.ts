// LIVE-SERVER-02: restore the live PGlite data dir from a backup without deleting anything.
// The backup is copied to a temp dir next to the data dir first. Only then is the broken dir
// renamed to `<dataDir>.broken-<timestamp>` (kept for inspection) and the temp copy renamed into
// place. Owner pid files are never copied: the caller claims the restored dir afterwards.
import fs from "node:fs";
import path from "node:path";
import { POSTMASTER_PID_FILE, SERVE_LIVE_PID_FILE } from "./live-db-lock.js";

const OWNER_FILES: ReadonlySet<string> = new Set([SERVE_LIVE_PID_FILE, POSTMASTER_PID_FILE]);

export class LiveDbRestoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LiveDbRestoreError";
  }
}

export interface RestoreLiveDbOptions {
  /** Absolute path of the live data dir. */
  readonly dataDir: string;
  /** Absolute path of the backup dir. It is only read. */
  readonly backupDir: string;
  readonly now?: Date;
}

export interface RestoreLiveDbResult {
  /** Where the broken data dir was kept, or null when there was no dir to keep. */
  readonly brokenDir: string | null;
  readonly restoredFrom: string;
}

/** The fixed backup name the restore code has always looked for. */
export const LIVE_DB_BACKUP_DIR_NAME = "live-db-backup";
/**
 * The backup name the repo actually uses: `live-db.bak-<unix seconds>`, a sibling of the live dir
 * (the local copy taken 4 Nov 2026 has this form). The epoch part orders candidates.
 */
const TIMESTAMPED_BACKUP_PATTERN = /^live-db\.bak-(\d+)$/;

export interface ResolvedLiveDbBackup {
  readonly dir: string;
  readonly source: "LIVE_DB_BACKUP_DIR" | "live-db-backup" | "live-db.bak-timestamp";
}

function isDirectory(target: string): boolean {
  try {
    return fs.statSync(target).isDirectory();
  } catch {
    return false;
  }
}

function isPgliteDir(target: string): boolean {
  return isDirectory(target) && fs.existsSync(path.join(target, "PG_VERSION"));
}

/**
 * Chooses the backup to restore from, in this order:
 *  1. an explicit dir (LIVE_DB_BACKUP_DIR). It must exist and be a PGlite dir, or this throws.
 *  2. `<parent>/live-db-backup`, the name the code has always used.
 *  3. the newest `<parent>/live-db.bak-<epoch>` that is a PGlite dir (the name the repo really uses).
 * Returns null when none qualifies. It never creates, moves or deletes anything.
 */
export function resolveLiveDbBackupDir(options: { readonly dataDir: string; readonly explicitDir?: string }): ResolvedLiveDbBackup | null {
  const explicit = options.explicitDir?.trim() ?? "";
  if (explicit !== "") {
    const dir = path.resolve(explicit);
    if (!isPgliteDir(dir)) {
      throw new LiveDbRestoreError(`LIVE_DB_BACKUP_DIR is not a PGlite data directory (no PG_VERSION): ${dir}`);
    }
    return { dir, source: "LIVE_DB_BACKUP_DIR" };
  }

  const parent = path.dirname(path.resolve(options.dataDir));
  const named = path.join(parent, LIVE_DB_BACKUP_DIR_NAME);
  if (isPgliteDir(named)) return { dir: named, source: "live-db-backup" };

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(parent, { withFileTypes: true });
  } catch {
    return null;
  }
  const stamped = entries
    .map((entry) => ({ entry, match: TIMESTAMPED_BACKUP_PATTERN.exec(entry.name) }))
    .filter((item): item is { entry: fs.Dirent; match: RegExpExecArray } => item.match !== null && item.entry.isDirectory())
    .sort((a, b) => Number(b.match[1]) - Number(a.match[1]));
  for (const { entry } of stamped) {
    const dir = path.join(parent, entry.name);
    if (isPgliteDir(dir)) return { dir, source: "live-db.bak-timestamp" };
  }
  return null;
}

/** Returns `base`, or `base-2`, `base-3`, ... when that path already exists. */
function uniquePath(base: string): string {
  if (!fs.existsSync(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`;
    if (!fs.existsSync(candidate)) return candidate;
  }
}

export function restoreLiveDbFromBackup(options: RestoreLiveDbOptions): RestoreLiveDbResult {
  const dataDir = path.resolve(options.dataDir);
  const backupDir = path.resolve(options.backupDir);
  if (dataDir === backupDir) {
    throw new LiveDbRestoreError("The backup directory must not be the live data directory.");
  }
  if (!isDirectory(backupDir)) {
    throw new LiveDbRestoreError(`Backup directory not found: ${backupDir}`);
  }
  if (!fs.existsSync(path.join(backupDir, "PG_VERSION"))) {
    throw new LiveDbRestoreError(`Backup is not a PGlite data directory (no PG_VERSION): ${backupDir}`);
  }

  const stamp = (options.now ?? new Date()).toISOString().replace(/[:.]/g, "-");
  const tempDir = uniquePath(`${dataDir}.restore-${stamp}`);
  try {
    fs.cpSync(backupDir, tempDir, {
      recursive: true,
      errorOnExist: true,
      force: false,
      filter: (source) => !OWNER_FILES.has(path.basename(source)),
    });
    if (!fs.existsSync(path.join(tempDir, "PG_VERSION"))) {
      throw new LiveDbRestoreError("Copied backup has no PG_VERSION; the data directory was not changed.");
    }
  } catch (error) {
    // The temp copy is ours, so removing it is safe. The data dir has not been touched yet.
    fs.rmSync(tempDir, { recursive: true, force: true });
    if (error instanceof LiveDbRestoreError) throw error;
    throw new LiveDbRestoreError(`Copying the backup failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  let brokenDir: string | null = null;
  if (fs.existsSync(dataDir)) {
    brokenDir = uniquePath(`${dataDir}.broken-${stamp}`);
    fs.renameSync(dataDir, brokenDir);
  }
  try {
    fs.renameSync(tempDir, dataDir);
  } catch (error) {
    // Put the broken dir back so the data dir is never left missing.
    if (brokenDir !== null) fs.renameSync(brokenDir, dataDir);
    fs.rmSync(tempDir, { recursive: true, force: true });
    throw new LiveDbRestoreError(`Moving the restored copy into place failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  return { brokenDir, restoredFrom: backupDir };
}
