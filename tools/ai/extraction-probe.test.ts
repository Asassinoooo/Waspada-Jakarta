import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createNoTimeoutNodeFetch,
  runExtractionProbe,
} from "./run-extraction-probe.js";
import { createSyntheticModelSmokeFixtures } from "./ninerouter-fixtures.js";

const API_KEY = "synthetic-extraction-probe-key";

async function listen(server: Server): Promise<string> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return `http://127.0.0.1:${address.port}`;
}

async function close(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

async function validChatResponse(completionTokens = 30): Promise<string> {
  const fixtures = await createSyntheticModelSmokeFixtures();
  const content = JSON.stringify({
    category: "utilities_essential_services",
    tags: [],
    eventTime: { start: null, end: null, precision: "unknown" },
    scope: { placeIds: [], serviceIds: [], institutionIds: [], audienceIds: [], geometryIds: [] },
    evidence: [fixtures.supportReference],
    unknownFields: ["event_time"],
  });
  return JSON.stringify({
    model: "curated/chinese-preview-2026-10-12",
    choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }],
    usage: { prompt_tokens: 50, completion_tokens: completionTokens, total_tokens: 50 + completionTokens },
  });
}

function env(baseUrl: string): NodeJS.ProcessEnv {
  return {
    NINEROUTER_URL: baseUrl,
    NINEROUTER_KEY: API_KEY,
    NINEROUTER_CURATION_EPOCH: "weekly-2026-10-12",
  };
}

test("probe is disabled without both explicit flags and makes no request", async () => {
  let fetchCount = 0;
  const receipt = await runExtractionProbe({
    argv: ["--live"],
    env: env("http://127.0.0.1:1"),
    fetchImpl: (async () => {
      fetchCount += 1;
      throw new Error("must_not_fetch");
    }) as typeof fetch,
    log: () => undefined,
  });
  assert.equal(receipt.status, "disabled");
  assert.equal(fetchCount, 0);
});

test("one delayed local extraction completes with no deadline and writes a safe typed manifest", async () => {
  const responseBody = await validChatResponse(4_097);
  let requestCount = 0;
  let requestPayload: Record<string, unknown> | undefined;
  const server = createServer((request, response) => {
    requestCount += 1;
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer | string) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    request.on("end", () => {
      try {
        const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (typeof value === "object" && value !== null && !Array.isArray(value)) {
          requestPayload = value as Record<string, unknown>;
        }
      } catch {
        requestPayload = undefined;
      }
    });
    setTimeout(() => {
      if (response.destroyed) return;
      response.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(responseBody) });
      response.end(responseBody);
    }, 60);
  });
  const baseUrl = await listen(server);
  const manifestDirectory = await mkdtemp(join(tmpdir(), "waspada-extraction-probe-"));
  const logs: Readonly<Record<string, unknown>>[] = [];
  try {
    const receipt = await runExtractionProbe({
      argv: ["--live", "--no-timeout", "--omit-output-limits"],
      env: env(baseUrl),
      manifestDirectory,
      log: (record) => logs.push(record),
    });

    assert.equal(receipt.status, "passed");
    assert.equal(receipt.requestCount, 1);
    assert.equal(requestCount, 1);
    assert.ok((receipt.elapsedMs ?? 0) >= 50);
    assert.equal(logs[0]?.status, "pending");
    assert.equal(logs[1]?.status, "passed");
    assert.equal(logs.some((record) => record.status === "catalog_verified"), false);

    assert.ok(receipt.manifestPath);
    const serialized = await readFile(receipt.manifestPath, "utf8");
    const manifest = JSON.parse(serialized) as {
      status: string;
      requestCount: number;
      clientDeadlineMs: null;
      transportKind: string;
      request: {
        payloadKeys: string[];
        allowedPayloadKeys: string[];
        omittedOutputControlParameters: string[];
        outputTokensEnforced: boolean;
        totalTokensEnforced: boolean;
        applicationTotalTokenBudget: number;
      };
      responseShape: {
        finishReason: string;
        jsonValid: boolean;
        choiceCount: number | null;
        nonemptyContent: boolean;
        usagePresent: boolean;
      } | null;
      result: { status: string; schemaVersion: string; recordType: string; lineageMatches: boolean; counts: { evidence: number } };
      observation: { capability: string; outcome: string; usage: { status: string } };
      boundaries: { extractionOnly: boolean; semanticOracle: boolean; fullSmoke: boolean };
    };
    assert.equal(manifest.status, "passed");
    assert.equal(manifest.requestCount, 1);
    assert.equal(manifest.clientDeadlineMs, null);
    assert.equal(manifest.transportKind, "native_node_http");
    assert.deepEqual(Object.keys(requestPayload ?? {}).sort(), ["messages", "model", "stream"]);
    assert.equal(requestPayload?.stream, false);
    assert.deepEqual(manifest.request.payloadKeys, ["messages", "model", "stream"]);
    assert.deepEqual(manifest.request.allowedPayloadKeys, ["model", "messages", "stream"]);
    assert.deepEqual(manifest.request.omittedOutputControlParameters, [
      "max_tokens",
      "max_output_tokens",
      "max_completion_tokens",
      "stop",
      "temperature",
      "top_p",
      "top_k",
      "frequency_penalty",
      "presence_penalty",
    ]);
    assert.equal(manifest.request.outputTokensEnforced, false);
    assert.equal(manifest.request.totalTokensEnforced, true);
    assert.equal(manifest.request.applicationTotalTokenBudget, 12_000);
    assert.deepEqual(manifest.responseShape, {
      finishReason: "stop",
      jsonValid: true,
      choiceCount: 1,
      nonemptyContent: true,
      usagePresent: true,
    });
    assert.equal(manifest.result.status, "succeeded");
    assert.equal(manifest.result.schemaVersion, "2.0");
    assert.equal(manifest.result.recordType, "ExtractionResult");
    assert.equal(manifest.result.lineageMatches, true);
    assert.equal(manifest.result.counts.evidence, 1);
    assert.equal(manifest.observation.capability, "extraction");
    assert.equal(manifest.observation.outcome, "succeeded");
    assert.equal(manifest.observation.usage.status, "reported");
    assert.equal(manifest.boundaries.extractionOnly, true);
    assert.equal(manifest.boundaries.semanticOracle, false);
    assert.equal(manifest.boundaries.fullSmoke, false);
    assert.equal(serialized.includes(API_KEY), false);
    assert.equal(serialized.includes(baseUrl), false);
    assert.equal(serialized.includes(responseBody), false);
    assert.equal(serialized.includes("curated/chinese-preview-2026-10-12"), false);
    assert.equal(JSON.stringify(logs).includes(API_KEY), false);
    assert.equal(JSON.stringify(logs).includes(baseUrl), false);
  } finally {
    await close(server);
    await rm(manifestDirectory, { recursive: true, force: true });
  }
});

test("SIGINT/SIGTERM cancellation signal aborts the native request and records only a closed outcome", async () => {
  let markRequestStarted: (() => void) | undefined;
  const requestStarted = new Promise<void>((resolve) => { markRequestStarted = resolve; });
  const server = createServer((request, response) => {
    request.resume();
    markRequestStarted?.();
    setTimeout(() => {
      if (!response.destroyed) response.end("{}\n");
    }, 150);
  });
  const baseUrl = await listen(server);
  const manifestDirectory = await mkdtemp(join(tmpdir(), "waspada-extraction-cancel-"));
  const controller = new AbortController();
  try {
    const pending = runExtractionProbe({
      argv: ["--live", "--no-timeout"],
      env: env(baseUrl),
      manifestDirectory,
      signal: controller.signal,
      log: () => undefined,
    });
    await requestStarted;
    controller.abort();
    const receipt = await pending;
    assert.equal(receipt.status, "failed");
    assert.equal(receipt.requestCount, 1);
    assert.ok(receipt.manifestPath);
    const serialized = await readFile(receipt.manifestPath, "utf8");
    const manifest = JSON.parse(serialized) as {
      result: { status: string };
      observation: { outcome: string; reason?: string };
    };
    assert.equal(manifest.result.status, "provider_error");
    assert.equal(manifest.observation.outcome, "failed");
    assert.equal(manifest.observation.reason, "aborted");
    assert.equal(serialized.includes(API_KEY), false);
    assert.equal(serialized.includes(baseUrl), false);
  } finally {
    await close(server);
    await rm(manifestDirectory, { recursive: true, force: true });
  }
});

test("invalid typed extraction stays failed and is never retried", async () => {
  const manifestDirectory = await mkdtemp(join(tmpdir(), "waspada-extraction-invalid-"));
  let requestCount = 0;
  const rawProviderOutput = "{\"category\":\"invented_category\"}";
  const fetchImpl = (async () => {
    requestCount += 1;
    return new Response(JSON.stringify({
      model: "curated/chinese-preview-2026-10-12",
      choices: [{ message: { role: "assistant", content: rawProviderOutput }, finish_reason: "stop" }],
      usage: { prompt_tokens: 50, completion_tokens: 30, total_tokens: 80 },
    }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    const receipt = await runExtractionProbe({
      argv: ["--live", "--no-timeout"],
      env: env("https://router.example.invalid"),
      fetchImpl,
      manifestDirectory,
      log: () => undefined,
    });
    assert.equal(receipt.status, "failed");
    assert.equal(requestCount, 1);
    assert.equal(receipt.requestCount, 1);
    assert.ok(receipt.manifestPath);
    const serialized = await readFile(receipt.manifestPath, "utf8");
    const manifest = JSON.parse(serialized) as {
      result: { status: string; schemaVersion: string | null; counts: unknown };
      observation: { outcome: string };
    };
    assert.equal(manifest.result.status, "invalid_output");
    assert.equal(manifest.result.schemaVersion, null);
    assert.equal(manifest.result.counts, null);
    assert.equal(manifest.observation.outcome, "succeeded");
    assert.equal(serialized.includes(API_KEY), false);
    assert.equal(serialized.includes("https://router.example.invalid"), false);
    assert.equal(serialized.includes(rawProviderOutput), false);
  } finally {
    await rm(manifestDirectory, { recursive: true, force: true });
  }
});

test("native transport rejects a response above the byte cap without following redirects", async () => {
  let requests = 0;
  const server = createServer((request, response) => {
    requests += 1;
    if (request.url === "/redirect") {
      response.writeHead(302, { location: "/large" });
      response.end("redirect body");
      return;
    }
    response.writeHead(200, {
      "content-type": "application/json",
      "content-length": 256 * 1024 + 1,
    });
    response.end(Buffer.alloc(256 * 1024 + 1, 0x78));
  });
  const baseUrl = await listen(server);
  const fetchImpl = createNoTimeoutNodeFetch();
  try {
    const redirect = await fetchImpl(`${baseUrl}/redirect`, { redirect: "manual" });
    assert.equal(redirect.status, 302);
    assert.equal(requests, 1);
    await assert.rejects(fetchImpl(`${baseUrl}/large`), (error: unknown) => (
      error instanceof Error && error.message === "response_too_large"
    ));
    assert.equal(requests, 2);
  } finally {
    await close(server);
  }
});
