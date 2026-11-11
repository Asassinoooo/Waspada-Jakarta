// INTEL-02 B3: DATASET_KIND has no default in the standalone worker. Unit checks plus two child-process starts
// (each start loads Mastra, so it is slow; the invalid-value path is covered by the unit checks).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { DatasetKindConfigError, parseDatasetKind } from "../src/dataset-kind.js";

const WORKER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src/worker.ts");

describe("INTEL-02 DATASET_KIND parsing", () => {
  it("accepts the three dataset kinds, ignoring surrounding spaces", () => {
    assert.equal(parseDatasetKind("live"), "live");
    assert.equal(parseDatasetKind(" historical "), "historical");
    assert.equal(parseDatasetKind("synthetic"), "synthetic");
  });

  it("throws a clear error when DATASET_KIND is unset or blank (no live default)", () => {
    for (const raw of [undefined, "", "   "]) {
      assert.throws(() => parseDatasetKind(raw), (err: unknown) =>
        err instanceof DatasetKindConfigError && /DATASET_KIND is not set/.test(err.message) && /does not default to live/.test(err.message));
    }
  });

  it("throws on an unknown value instead of coercing it", () => {
    assert.throws(() => parseDatasetKind("LIVE"), /DATASET_KIND "LIVE" is not valid/);
    assert.throws(() => parseDatasetKind("prod"), DatasetKindConfigError);
  });
});

describe("INTEL-02 standalone worker start (child process, no DB, no network)", () => {
  function startWorker(env: Record<string, string | undefined>) {
    const childEnv: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined && !key.startsWith("DATASET_KIND") && !key.startsWith("DATABASE_URL") && !key.startsWith("HYPERDRIVE_URL")) {
        childEnv[key] = value;
      }
    }
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) delete childEnv[key];
      else childEnv[key] = value;
    }
    return spawnSync(process.execPath, ["--import", "tsx", WORKER], { env: childEnv, encoding: "utf8", timeout: 60_000 });
  }

  it("exits 1 with a clear message when DATASET_KIND is unset", () => {
    const result = startWorker({ DATASET_KIND: undefined });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /DATASET_KIND is not set/);
  });

  it("starts in standby with a valid DATASET_KIND and no database URL", () => {
    const result = startWorker({ DATASET_KIND: "synthetic", DATABASE_URL: undefined, HYPERDRIVE_URL: undefined });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Target dataset: synthetic/);
  });
});
