import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { freshDatabase, publicReadDatabase } from "../src/index.js";
import { runScheduledReviewExpiry } from "../src/runtime/review-expiry-runtime.js";

/**
 * HOSTED-37 (owner decision, 18 Nov 2026): moderation, admin, account/auth, pipeline flow and all writes read
 * through the no-cache Hyperdrive config (FRESH_HYPERDRIVE). Public GET reads keep the cached HYPERDRIVE config.
 * Connection strings below are fake labels; no database is opened.
 */

const cachedConfig = { connectionString: "postgres://cached-config.test/db" };
const freshConfig = { connectionString: "postgres://fresh-config.test/db" };

/** Records which binding was read, so a test can prove the other config was never touched. */
function recordingEnv(reads: string[], bindings: { HYPERDRIVE?: unknown; FRESH_HYPERDRIVE?: unknown }) {
  return {
    get HYPERDRIVE() {
      reads.push("HYPERDRIVE");
      return bindings.HYPERDRIVE as { readonly connectionString?: string } | undefined;
    },
    get FRESH_HYPERDRIVE() {
      reads.push("FRESH_HYPERDRIVE");
      return bindings.FRESH_HYPERDRIVE as { readonly connectionString?: string } | undefined;
    },
  };
}

test("freshDatabase prefers FRESH_HYPERDRIVE when it is bound", () => {
  assert.equal(freshDatabase({ HYPERDRIVE: cachedConfig, FRESH_HYPERDRIVE: freshConfig }), freshConfig);
});

test("freshDatabase falls back to HYPERDRIVE when FRESH_HYPERDRIVE is unset (tests and dev)", () => {
  assert.equal(freshDatabase({ HYPERDRIVE: cachedConfig }), cachedConfig);
  assert.equal(freshDatabase({ HYPERDRIVE: cachedConfig, FRESH_HYPERDRIVE: undefined }), cachedConfig);
});

test("freshDatabase is undefined when neither binding is present", () => {
  assert.equal(freshDatabase({}), undefined);
  assert.equal(freshDatabase({ HYPERDRIVE: undefined, FRESH_HYPERDRIVE: undefined }), undefined);
});

test("freshDatabase fails closed: a bound FRESH_HYPERDRIVE without a connection string never falls back to the cache", () => {
  const unusable = {} as { readonly connectionString?: string };
  assert.equal(freshDatabase({ HYPERDRIVE: cachedConfig, FRESH_HYPERDRIVE: unusable }), unusable);
  assert.equal(freshDatabase({ HYPERDRIVE: cachedConfig, FRESH_HYPERDRIVE: unusable })?.connectionString, undefined);
});

test("moderation and write paths read only FRESH_HYPERDRIVE when it is bound", () => {
  const reads: string[] = [];
  const selected = freshDatabase(recordingEnv(reads, { HYPERDRIVE: cachedConfig, FRESH_HYPERDRIVE: freshConfig }));
  assert.equal(selected, freshConfig);
  assert.deepEqual(reads, ["FRESH_HYPERDRIVE"]);
});

test("public GET reads keep the cached HYPERDRIVE even when FRESH_HYPERDRIVE is bound", () => {
  const reads: string[] = [];
  const selected = publicReadDatabase(recordingEnv(reads, { HYPERDRIVE: cachedConfig, FRESH_HYPERDRIVE: freshConfig }));
  assert.equal(selected, cachedConfig);
  assert.deepEqual(reads, ["HYPERDRIVE"]);
});

test("routing: distinct fake configs send moderation and admin to FRESH and public reads to HYPERDRIVE", () => {
  const env = { HYPERDRIVE: cachedConfig, FRESH_HYPERDRIVE: freshConfig };
  assert.notEqual(freshDatabase(env), publicReadDatabase(env));
  assert.equal(freshDatabase(env)?.connectionString, freshConfig.connectionString);
  assert.equal(publicReadDatabase(env)?.connectionString, cachedConfig.connectionString);
});

test("scheduled review expiry (a write) passes its guard on FRESH_HYPERDRIVE alone", async () => {
  const sentinel = new Error("reached the executor");
  await assert.rejects(
    runScheduledReviewExpiry({
      env: { DATASET_MODE: "live", FRESH_HYPERDRIVE: freshConfig },
      now: new Date("2026-11-19T00:00:00.000Z"),
      withSqlExecutor: async () => {
        throw sentinel;
      },
    }),
    sentinel,
  );
});

test("scheduled review expiry reports no_database when neither binding is present", async () => {
  const outcome = await runScheduledReviewExpiry({
    env: { DATASET_MODE: "live" },
    now: new Date("2026-11-19T00:00:00.000Z"),
    withSqlExecutor: async () => {
      throw new Error("must not open a database");
    },
  });
  assert.deepEqual(outcome, { ran: false, reason: "no_database" });
});

/**
 * Reads the production Hyperdrive blocks as text: binding name to config id. TOML is not parsed by a library
 * here, so the block format used in wrangler.toml (one `binding` and one `id` per block) is matched directly.
 */
function productionHyperdriveIds(toml: string): Record<string, string> {
  const blocks: { binding?: string; id?: string }[] = [];
  let inProductionHyperdrive = false;
  for (const raw of toml.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("[")) {
      inProductionHyperdrive = line === "[[env.production.hyperdrive]]";
      if (inProductionHyperdrive) blocks.push({});
      continue;
    }
    const current = blocks[blocks.length - 1];
    if (!inProductionHyperdrive || current === undefined) continue;
    const binding = /^binding\s*=\s*"([^"]+)"$/.exec(line);
    const id = /^id\s*=\s*"([^"]+)"$/.exec(line);
    if (binding) current.binding = binding[1];
    if (id) current.id = id[1];
  }
  return Object.fromEntries(
    blocks.flatMap((block) => (block.binding && block.id ? [[block.binding, block.id] as const] : [])),
  );
}

test("wrangler.toml production: FRESH_HYPERDRIVE and AUTH_HYPERDRIVE use the no-cache config, HYPERDRIVE the cached one", () => {
  const toml = readFileSync(new URL("../wrangler.toml", import.meta.url), "utf8");
  assert.deepEqual(productionHyperdriveIds(toml), {
    HYPERDRIVE: "7dad8907f83b4ab9b7499e0de586b222",
    AUTH_HYPERDRIVE: "4e16ee874a1349589a764189d54856ba",
    FRESH_HYPERDRIVE: "4e16ee874a1349589a764189d54856ba",
  });
});
