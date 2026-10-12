import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const CLI_PATH = fileURLToPath(new URL("./run-ninerouter-smoke.ts", import.meta.url));
const SECRET = "synthetic-key-sentinel";
const ENDPOINT = "http://127.0.0.1:9";
const NO_NETWORK_PRELOAD = `data:text/javascript,${encodeURIComponent("globalThis.fetch = async () => { throw new Error('mock_network_disabled'); };")}`;

function invoke(args: readonly string[], values: Record<string, string> = {}) {
  const env = { ...process.env };
  delete env.NINEROUTER_URL;
  delete env.NINEROUTER_KEY;
  delete env.NINEROUTER_CURATION_EPOCH;
  delete env.NODE_OPTIONS;
  return spawnSync(process.execPath, ["--import", NO_NETWORK_PRELOAD, "--import", "tsx", CLI_PATH, ...args], {
    cwd: process.cwd(), env: { ...env, ...values }, encoding: "utf8", timeout: 10_000,
  });
}

function assertClosedResult(result: ReturnType<typeof invoke>, status: string, code: number) {
  assert.equal(result.error, undefined);
  assert.equal(result.status, code);
  assert.equal(result.stderr, "");
  const value = JSON.parse(result.stdout) as Record<string, unknown>;
  assert.equal(value.status, status);
  assert.equal(result.stdout.includes(SECRET), false);
  assert.equal(result.stdout.includes(ENDPOINT), false);
  return value;
}

test("gateway CLI stays disabled without the explicit live flag even with configuration", () => {
  const value = assertClosedResult(invoke([], {
    NINEROUTER_URL: ENDPOINT, NINEROUTER_KEY: SECRET,
  }), "disabled", 0);
  assert.deepEqual(value, {
    status: "disabled", reason: "explicit_live_flag_required", datasetKind: "synthetic",
  });
});

test("explicit live flag without credentials fails before discovery", () => {
  const value = assertClosedResult(invoke(["--live"]), "not_configured", 1);
  assert.equal(value.reason, "missing_gateway_environment");
});

test("configuration errors expose no endpoint, credentials or stack", () => {
  const value = assertClosedResult(invoke(["--live"], {
    NINEROUTER_URL: `${ENDPOINT}/v1?credential=${SECRET}`, NINEROUTER_KEY: SECRET,
  }), "failed", 1);
  assert.deepEqual(value, { status: "failed", reason: "gateway_smoke_failed" });
});

test("oversized or credential-bearing epoch fails before any request", () => {
  for (const epoch of ["x".repeat(65), `run-${SECRET}`]) {
    const value = assertClosedResult(invoke(["--live"], {
      NINEROUTER_URL: ENDPOINT, NINEROUTER_KEY: SECRET, NINEROUTER_CURATION_EPOCH: epoch,
    }), "invalid_configuration", 1);
    assert.equal(value.reason, "invalid_run_epoch");
    assert.equal(JSON.stringify(value).includes(epoch), false);
  }
});

test("CLI tailnet opt-in does not permit public, LAN or DNS HTTP endpoints", () => {
  for (const endpoint of ["http://100.63.255.255:9", "http://100.128.0.0:9", "http://192.168.1.1:9", "http://gateway.invalid:9"]) {
    const value = assertClosedResult(invoke(["--live"], {
      NINEROUTER_URL: endpoint, NINEROUTER_KEY: SECRET,
    }), "failed", 1);
    assert.deepEqual(value, { status: "failed", reason: "gateway_smoke_failed" });
    assert.equal(JSON.stringify(value).includes(endpoint), false);
  }
});
