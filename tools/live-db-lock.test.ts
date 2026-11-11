// LIVE-SERVER-02: owner checks for the live PGlite dir. Temp dirs and injected liveness; no PGlite.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import {
  assertLiveDbUnowned,
  claimLiveDb,
  LiveDbBusyError,
  POSTMASTER_PID_FILE,
  SERVE_LIVE_PID_FILE,
} from "./live-db-lock.js";

const OWN_PID = 4242;
const LIVE_OTHER = 5001;
const DEAD_PID = 5002;
const liveOnly = (...livePids: number[]) => (pid: number) => livePids.includes(pid);

let root: string;
let counter = 0;

function freshDataDir(): string {
  counter += 1;
  const dir = path.join(root, `dir-${counter}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function write(dir: string, name: string, content: string): void {
  fs.writeFileSync(path.join(dir, name), content);
}

function exists(dir: string, name: string): boolean {
  return fs.existsSync(path.join(dir, name));
}

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "waspada-live-lock-"));
});

after(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("claimLiveDb (serve:live startup)", () => {
  it("claims an empty dir and writes its own pid; release removes it", () => {
    const dir = freshDataDir();
    const claim = claimLiveDb(dir, { ownPid: OWN_PID, isProcessAlive: liveOnly() });
    assert.equal(fs.readFileSync(path.join(dir, SERVE_LIVE_PID_FILE), "utf8").trim(), String(OWN_PID));
    assert.deepEqual(claim.removedStale, []);
    claim.release();
    assert.equal(exists(dir, SERVE_LIVE_PID_FILE), false);
  });

  it("refuses when serve-live.pid names another live process, and leaves every file as it was", () => {
    const dir = freshDataDir();
    write(dir, SERVE_LIVE_PID_FILE, `${LIVE_OTHER}\n`);
    write(dir, POSTMASTER_PID_FILE, "9999\n");
    assert.throws(
      () => claimLiveDb(dir, { ownPid: OWN_PID, isProcessAlive: liveOnly(LIVE_OTHER) }),
      (err: unknown) => err instanceof LiveDbBusyError && /already runs as pid 5001/.test(err.message),
    );
    assert.equal(fs.readFileSync(path.join(dir, SERVE_LIVE_PID_FILE), "utf8"), `${LIVE_OTHER}\n`);
    assert.equal(exists(dir, POSTMASTER_PID_FILE), true, "postmaster.pid is not removed while a live owner exists");
  });

  it("replaces a serve-live.pid whose pid is dead and reports it as stale", () => {
    const dir = freshDataDir();
    write(dir, SERVE_LIVE_PID_FILE, `${DEAD_PID}\n`);
    const claim = claimLiveDb(dir, { ownPid: OWN_PID, isProcessAlive: liveOnly(LIVE_OTHER) });
    assert.deepEqual(claim.removedStale, [SERVE_LIVE_PID_FILE]);
    assert.equal(fs.readFileSync(path.join(dir, SERVE_LIVE_PID_FILE), "utf8").trim(), String(OWN_PID));
  });

  it("treats a serve-live.pid naming our own pid as ours, not a conflict", () => {
    const dir = freshDataDir();
    write(dir, SERVE_LIVE_PID_FILE, `${OWN_PID}\n`);
    const claim = claimLiveDb(dir, { ownPid: OWN_PID, isProcessAlive: liveOnly(OWN_PID) });
    assert.equal(fs.readFileSync(path.join(dir, SERVE_LIVE_PID_FILE), "utf8").trim(), String(OWN_PID));
    assert.deepEqual(claim.removedStale, [SERVE_LIVE_PID_FILE]);
  });

  it("refuses an unreadable serve-live.pid instead of guessing that it is stale", () => {
    const dir = freshDataDir();
    write(dir, SERVE_LIVE_PID_FILE, "");
    assert.throws(() => claimLiveDb(dir, { ownPid: OWN_PID, isProcessAlive: liveOnly() }), LiveDbBusyError);
    assert.equal(exists(dir, SERVE_LIVE_PID_FILE), true);
  });

  it("removes a postmaster.pid with a dead pid, and one with unreadable content", () => {
    const dir = freshDataDir();
    write(dir, POSTMASTER_PID_FILE, `${DEAD_PID}\n/some/path\n`);
    const claim = claimLiveDb(dir, { ownPid: OWN_PID, isProcessAlive: liveOnly() });
    assert.equal(exists(dir, POSTMASTER_PID_FILE), false);
    assert.ok(claim.removedStale.includes(POSTMASTER_PID_FILE));
    claim.release();

    const dir2 = freshDataDir();
    write(dir2, POSTMASTER_PID_FILE, "not-a-pid");
    claimLiveDb(dir2, { ownPid: OWN_PID, isProcessAlive: liveOnly() });
    assert.equal(exists(dir2, POSTMASTER_PID_FILE), false);
  });

  it("refuses when postmaster.pid names a live process, releases its own claim, and keeps postmaster.pid", () => {
    const dir = freshDataDir();
    write(dir, POSTMASTER_PID_FILE, `${LIVE_OTHER}\n`);
    assert.throws(
      () => claimLiveDb(dir, { ownPid: OWN_PID, isProcessAlive: liveOnly(LIVE_OTHER) }),
      /postmaster.pid names live process 5001/,
    );
    assert.equal(exists(dir, SERVE_LIVE_PID_FILE), false, "our claim is released on refusal");
    assert.equal(exists(dir, POSTMASTER_PID_FILE), true);
  });

  it("uses the real liveness probe: a live parent process blocks the claim", () => {
    const dir = freshDataDir();
    write(dir, SERVE_LIVE_PID_FILE, `${process.ppid}\n`);
    assert.throws(() => claimLiveDb(dir, { ownPid: process.pid }), LiveDbBusyError);
  });

  it("release only removes serve-live.pid while it still names this process", () => {
    const dir = freshDataDir();
    const claim = claimLiveDb(dir, { ownPid: OWN_PID, isProcessAlive: liveOnly() });
    write(dir, SERVE_LIVE_PID_FILE, `${LIVE_OTHER}\n`);
    claim.release();
    assert.equal(fs.readFileSync(path.join(dir, SERVE_LIVE_PID_FILE), "utf8"), `${LIVE_OTHER}\n`);
  });
});

describe("assertLiveDbUnowned (read-only tools: requeue, consolidate)", () => {
  it("passes on an empty dir and on dead owners, and removes nothing", () => {
    const dir = freshDataDir();
    write(dir, SERVE_LIVE_PID_FILE, `${DEAD_PID}\n`);
    write(dir, POSTMASTER_PID_FILE, `${DEAD_PID}\n`);
    assert.doesNotThrow(() => assertLiveDbUnowned(dir, { ownPid: OWN_PID, isProcessAlive: liveOnly() }));
    assert.equal(exists(dir, SERVE_LIVE_PID_FILE), true);
    assert.equal(exists(dir, POSTMASTER_PID_FILE), true);
  });

  it("throws when serve-live.pid or postmaster.pid names a live process", () => {
    const dir = freshDataDir();
    write(dir, SERVE_LIVE_PID_FILE, `${LIVE_OTHER}\n`);
    assert.throws(() => assertLiveDbUnowned(dir, { ownPid: OWN_PID, isProcessAlive: liveOnly(LIVE_OTHER) }), /serve-live.pid names live process 5001/);

    const dir2 = freshDataDir();
    write(dir2, POSTMASTER_PID_FILE, `${LIVE_OTHER}\n`);
    assert.throws(() => assertLiveDbUnowned(dir2, { ownPid: OWN_PID, isProcessAlive: liveOnly(LIVE_OTHER) }), /postmaster.pid names live process 5001/);
  });

  it("ignores our own pid and a dir with no owner files", () => {
    const dir = freshDataDir();
    write(dir, SERVE_LIVE_PID_FILE, `${OWN_PID}\n`);
    assert.doesNotThrow(() => assertLiveDbUnowned(dir, { ownPid: OWN_PID, isProcessAlive: liveOnly(OWN_PID) }));
    assert.doesNotThrow(() => assertLiveDbUnowned(freshDataDir(), { ownPid: OWN_PID, isProcessAlive: liveOnly() }));
  });
});
