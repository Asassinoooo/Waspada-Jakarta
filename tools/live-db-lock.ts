// LIVE-SERVER-02: owner checks for the local live PGlite data dir (.data/live-db).
// serve:live records its pid in serve-live.pid (AI-RATE-01) and holds the dir until shutdown.
// A live owner blocks startup and the requeue/consolidate tools. A dead or stale pid is removed.
// postmaster.pid is removed only when no live owner exists, and never when it names a live process.
import fs from "node:fs";
import path from "node:path";

export const SERVE_LIVE_PID_FILE = "serve-live.pid";
export const POSTMASTER_PID_FILE = "postmaster.pid";

export class LiveDbBusyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LiveDbBusyError";
  }
}

export interface LiveDbOwnerOptions {
  /** Pid that is never treated as a conflict. Defaults to process.pid. */
  readonly ownPid?: number;
  /** Liveness probe. Defaults to signal 0 against the pid. */
  readonly isProcessAlive?: (pid: number) => boolean;
}

export interface LiveDbClaim {
  readonly pid: number;
  /** Files removed as stale while claiming (dead or own pid). */
  readonly removedStale: readonly string[];
  /** Removes serve-live.pid only while it still names this process. */
  release(): void;
}

type PidState =
  | { readonly kind: "missing" }
  | { readonly kind: "unreadable" }
  | { readonly kind: "pid"; readonly pid: number };

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to another user.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function readPidState(file: string): PidState {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "missing" };
    return { kind: "unreadable" };
  }
  const first = raw.trim().split(/\s+/)[0] ?? "";
  const pid = /^\d+$/.test(first) ? Number(first) : Number.NaN;
  return Number.isSafeInteger(pid) && pid > 0 ? { kind: "pid", pid } : { kind: "unreadable" };
}

/**
 * Read-only check for tools that open the live dir (requeue, consolidate).
 * Throws LiveDbBusyError when serve-live.pid or postmaster.pid names another live process.
 * It never removes a file.
 */
export function assertLiveDbUnowned(dataDir: string, options: LiveDbOwnerOptions = {}): void {
  const ownPid = options.ownPid ?? process.pid;
  const probe = options.isProcessAlive ?? isProcessAlive;
  for (const name of [SERVE_LIVE_PID_FILE, POSTMASTER_PID_FILE]) {
    const state = readPidState(path.join(dataDir, name));
    if (state.kind === "pid" && state.pid !== ownPid && probe(state.pid)) {
      throw new LiveDbBusyError(`${name} names live process ${state.pid}. Stop serve:live first.`);
    }
    if (state.kind === "unreadable" && name === SERVE_LIVE_PID_FILE) {
      throw new LiveDbBusyError(`${name} is unreadable. If no serve:live is running, delete it and retry.`);
    }
  }
}

/**
 * serve:live startup. Claims serve-live.pid with an exclusive create, so two starts cannot
 * both win. A live owner throws LiveDbBusyError and nothing is removed. A dead or own pid is
 * stale and is replaced. Then postmaster.pid is cleared, unless it names a live process,
 * in which case the claim is released and LiveDbBusyError is thrown.
 * The caller creates dataDir first.
 */
export function claimLiveDb(dataDir: string, options: LiveDbOwnerOptions = {}): LiveDbClaim {
  const ownPid = options.ownPid ?? process.pid;
  const probe = options.isProcessAlive ?? isProcessAlive;
  const pidFile = path.join(dataDir, SERVE_LIVE_PID_FILE);
  const postmasterFile = path.join(dataDir, POSTMASTER_PID_FILE);
  const removedStale: string[] = [];

  let claimed = false;
  for (let attempt = 1; attempt <= 3 && !claimed; attempt++) {
    try {
      const fd = fs.openSync(pidFile, "wx");
      try {
        fs.writeSync(fd, `${ownPid}\n`);
      } finally {
        fs.closeSync(fd);
      }
      claimed = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const state = readPidState(pidFile);
      if (state.kind === "unreadable") {
        throw new LiveDbBusyError(`${SERVE_LIVE_PID_FILE} is unreadable. If no serve:live is running, delete it and retry.`);
      }
      if (state.kind === "pid" && state.pid !== ownPid && probe(state.pid)) {
        throw new LiveDbBusyError(`Refusing to start: serve:live already runs as pid ${state.pid} (${SERVE_LIVE_PID_FILE}).`);
      }
      fs.rmSync(pidFile, { force: true });
      removedStale.push(SERVE_LIVE_PID_FILE);
    }
  }
  if (!claimed) {
    throw new LiveDbBusyError(`Could not claim ${SERVE_LIVE_PID_FILE}: it keeps being recreated by another process.`);
  }

  const release = (): void => {
    const state = readPidState(pidFile);
    if (state.kind === "pid" && state.pid === ownPid) fs.rmSync(pidFile, { force: true });
  };

  const postmaster = readPidState(postmasterFile);
  if (postmaster.kind === "pid" && postmaster.pid !== ownPid && probe(postmaster.pid)) {
    release();
    throw new LiveDbBusyError(`Refusing to start: ${POSTMASTER_PID_FILE} names live process ${postmaster.pid}.`);
  }
  if (postmaster.kind !== "missing") {
    fs.rmSync(postmasterFile, { force: true });
    removedStale.push(POSTMASTER_PID_FILE);
  }

  return { pid: ownPid, removedStale, release };
}
