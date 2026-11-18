import assert from "node:assert/strict";
import { test } from "node:test";

import { dispatchIngestWorkflow, isGithubDispatchMode } from "../src/ingest-dispatch.js";

const configured = {
  SCHEDULED_MODE: "github_dispatch",
  GITHUB_DISPATCH_TOKEN: "test-token",
  INGEST_DISPATCH_REPO: "owner/repo",
};

function recordingFetch(status: number) {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(null, { status });
  }) as unknown as typeof fetch;
  return { calls, impl };
}

test("dispatch mode is on only for the exact github_dispatch value", () => {
  assert.equal(isGithubDispatchMode({ SCHEDULED_MODE: "github_dispatch" }), true);
  assert.equal(isGithubDispatchMode({}), false);
  assert.equal(isGithubDispatchMode({ SCHEDULED_MODE: "GITHUB_DISPATCH" }), false);
});

test("missing token or repo is not_configured and sends nothing", async () => {
  const { calls, impl } = recordingFetch(204);
  assert.deepEqual(await dispatchIngestWorkflow({ INGEST_DISPATCH_REPO: "owner/repo" }, impl), { outcome: "not_configured" });
  assert.deepEqual(await dispatchIngestWorkflow({ GITHUB_DISPATCH_TOKEN: "t" }, impl), { outcome: "not_configured" });
  assert.deepEqual(
    await dispatchIngestWorkflow({ GITHUB_DISPATCH_TOKEN: "t", INGEST_DISPATCH_REPO: "owner/repo/../x" }, impl),
    { outcome: "not_configured" },
  );
  assert.equal(calls.length, 0);
});

test("204 is dispatched and the request targets ingest.yml on main", async () => {
  const { calls, impl } = recordingFetch(204);
  assert.deepEqual(await dispatchIngestWorkflow(configured, impl), { outcome: "dispatched", status: 204 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.github.com/repos/owner/repo/actions/workflows/ingest.yml/dispatches");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.body, JSON.stringify({ ref: "main" }));
  const headers = calls[0].init.headers as Record<string, string>;
  assert.equal(headers.authorization, "Bearer test-token");
  assert.equal(headers["user-agent"], "waspada-ingest-cron");
});

test("error statuses and network failures map to fixed outcome codes", async () => {
  assert.equal((await dispatchIngestWorkflow(configured, recordingFetch(401).impl)).outcome, "rejected_auth");
  assert.equal((await dispatchIngestWorkflow(configured, recordingFetch(403).impl)).outcome, "rejected_auth");
  assert.equal((await dispatchIngestWorkflow(configured, recordingFetch(404).impl)).outcome, "rejected_not_found");
  assert.equal((await dispatchIngestWorkflow(configured, recordingFetch(422).impl)).outcome, "rejected_other");
  const failing = (async () => { throw new Error("offline"); }) as unknown as typeof fetch;
  assert.deepEqual(await dispatchIngestWorkflow(configured, failing), { outcome: "network_error" });
});
