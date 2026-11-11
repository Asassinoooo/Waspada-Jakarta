// LIVE-SERVER-02: restoring the live PGlite dir never deletes the broken dir. Temp dirs only.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { LiveDbRestoreError, resolveLiveDbBackupDir, restoreLiveDbFromBackup } from "./live-db-restore.js";

const FIXED_NOW = new Date("2026-11-11T14:30:00.000Z");
const STAMP = "2026-11-11T14-30-00-000Z";

let root: string;
let counter = 0;

function sandbox(): { dataDir: string; backupDir: string; parent: string } {
  counter += 1;
  const parent = path.join(root, `case-${counter}`);
  fs.mkdirSync(parent, { recursive: true });
  return { parent, dataDir: path.join(parent, "live-db"), backupDir: path.join(parent, "live-db-backup") };
}

function populate(dir: string, files: Record<string, string>): void {
  for (const [name, content] of Object.entries(files)) {
    const target = path.join(dir, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
}

function listNames(dir: string): string[] {
  return fs.readdirSync(dir).sort();
}

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "waspada-live-restore-"));
});

after(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("restoreLiveDbFromBackup", () => {
  it("copies the backup into place and keeps the broken dir under a timestamped name", () => {
    const { dataDir, backupDir, parent } = sandbox();
    populate(dataDir, { PG_VERSION: "broken", "base/broken.dat": "corrupt" });
    populate(backupDir, { PG_VERSION: "16", "base/good.dat": "good" });

    const result = restoreLiveDbFromBackup({ dataDir, backupDir, now: FIXED_NOW });

    assert.equal(result.brokenDir, `${dataDir}.broken-${STAMP}`);
    assert.equal(fs.readFileSync(path.join(dataDir, "base/good.dat"), "utf8"), "good");
    assert.equal(fs.readFileSync(path.join(result.brokenDir!, "base/broken.dat"), "utf8"), "corrupt", "the broken dir is kept, not deleted");
    assert.deepEqual(listNames(parent).sort(), ["live-db", "live-db-backup", `live-db.broken-${STAMP}`].sort(), "no temp copy is left behind");
    assert.equal(fs.readFileSync(path.join(backupDir, "base/good.dat"), "utf8"), "good", "the backup is only read");
  });

  it("does not copy owner pid files from the backup", () => {
    const { dataDir, backupDir } = sandbox();
    populate(backupDir, { PG_VERSION: "16", "serve-live.pid": "12345", "postmaster.pid": "67890" });
    restoreLiveDbFromBackup({ dataDir, backupDir, now: FIXED_NOW });
    assert.deepEqual(listNames(dataDir), ["PG_VERSION"]);
  });

  it("works when there is no data dir yet, with nothing to keep", () => {
    const { dataDir, backupDir } = sandbox();
    populate(backupDir, { PG_VERSION: "16" });
    const result = restoreLiveDbFromBackup({ dataDir, backupDir, now: FIXED_NOW });
    assert.equal(result.brokenDir, null);
    assert.deepEqual(listNames(dataDir), ["PG_VERSION"]);
  });

  it("uses a distinct broken-dir name when one with the same timestamp already exists", () => {
    const { dataDir, backupDir } = sandbox();
    populate(dataDir, { PG_VERSION: "first" });
    fs.mkdirSync(`${dataDir}.broken-${STAMP}`);
    populate(backupDir, { PG_VERSION: "16" });
    const result = restoreLiveDbFromBackup({ dataDir, backupDir, now: FIXED_NOW });
    assert.equal(result.brokenDir, `${dataDir}.broken-${STAMP}-2`);
    assert.equal(fs.readFileSync(path.join(result.brokenDir!, "PG_VERSION"), "utf8"), "first");
  });

  it("with a missing backup throws and does not touch the data dir", () => {
    const { dataDir, backupDir } = sandbox();
    populate(dataDir, { PG_VERSION: "keep-me" });
    assert.throws(() => restoreLiveDbFromBackup({ dataDir, backupDir, now: FIXED_NOW }), (err: unknown) =>
      err instanceof LiveDbRestoreError && /Backup directory not found/.test(err.message));
    assert.equal(fs.readFileSync(path.join(dataDir, "PG_VERSION"), "utf8"), "keep-me");
    assert.deepEqual(listNames(path.dirname(dataDir)).filter((n) => n.startsWith("live-db")), ["live-db"]);
  });

  it("with a backup that is not a PGlite dir throws and leaves the data dir and parent unchanged", () => {
    const { dataDir, backupDir, parent } = sandbox();
    populate(dataDir, { PG_VERSION: "keep-me" });
    populate(backupDir, { "notes.txt": "not a database" });
    assert.throws(() => restoreLiveDbFromBackup({ dataDir, backupDir, now: FIXED_NOW }), /no PG_VERSION/);
    assert.equal(fs.readFileSync(path.join(dataDir, "PG_VERSION"), "utf8"), "keep-me");
    assert.deepEqual(listNames(parent).sort(), ["live-db", "live-db-backup"]);
  });

  it("refuses to use the data dir as its own backup", () => {
    const { dataDir } = sandbox();
    populate(dataDir, { PG_VERSION: "16" });
    assert.throws(() => restoreLiveDbFromBackup({ dataDir, backupDir: dataDir, now: FIXED_NOW }), /must not be the live data directory/);
    assert.equal(fs.readFileSync(path.join(dataDir, "PG_VERSION"), "utf8"), "16");
  });
});

describe("resolveLiveDbBackupDir (the backup name the repo really uses)", () => {
  it("finds the newest live-db.bak-<epoch> sibling that is a PGlite dir, and ignores other names", () => {
    const { dataDir, parent } = sandbox();
    populate(path.join(parent, "live-db.bak-100"), { PG_VERSION: "old" });
    populate(path.join(parent, "live-db.bak-1793783356"), { PG_VERSION: "newest" });
    populate(path.join(parent, "live-db.bak-300"), { "notes.txt": "no PG_VERSION, skipped" });
    populate(path.join(parent, "live-db.bak-abc"), { PG_VERSION: "not numeric, ignored" });
    populate(path.join(parent, "live-db-old-copy"), { PG_VERSION: "ignored" });
    const resolved = resolveLiveDbBackupDir({ dataDir });
    assert.deepEqual(resolved, { dir: path.join(parent, "live-db.bak-1793783356"), source: "live-db.bak-timestamp" });
  });

  it("prefers the live-db-backup name when it exists", () => {
    const { dataDir, parent, backupDir } = sandbox();
    populate(backupDir, { PG_VERSION: "16" });
    populate(path.join(parent, "live-db.bak-999"), { PG_VERSION: "16" });
    assert.deepEqual(resolveLiveDbBackupDir({ dataDir }), { dir: backupDir, source: "live-db-backup" });
  });

  it("an explicit LIVE_DB_BACKUP_DIR wins, and must be a PGlite dir", () => {
    const { dataDir, parent, backupDir } = sandbox();
    populate(backupDir, { PG_VERSION: "16" });
    const explicit = path.join(parent, "elsewhere");
    populate(explicit, { PG_VERSION: "17" });
    assert.deepEqual(resolveLiveDbBackupDir({ dataDir, explicitDir: explicit }), { dir: explicit, source: "LIVE_DB_BACKUP_DIR" });

    const notPglite = path.join(parent, "not-pglite");
    populate(notPglite, { "readme.txt": "x" });
    assert.throws(() => resolveLiveDbBackupDir({ dataDir, explicitDir: notPglite }), (err: unknown) =>
      err instanceof LiveDbRestoreError && /LIVE_DB_BACKUP_DIR is not a PGlite data directory/.test(err.message));
    assert.throws(() => resolveLiveDbBackupDir({ dataDir, explicitDir: path.join(parent, "missing") }), LiveDbRestoreError);
  });

  it("returns null when no backup qualifies, and never touches the directory", () => {
    const { dataDir, parent } = sandbox();
    populate(dataDir, { PG_VERSION: "keep" });
    assert.equal(resolveLiveDbBackupDir({ dataDir }), null);
    assert.deepEqual(listNames(parent), ["live-db"]);
  });
});
