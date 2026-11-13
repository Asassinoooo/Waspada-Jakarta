/**
 * DET-FILTER-02 offline tests for the bounded one-shot shadow eval runner.
 *
 * Fully offline: synthetic XML strings only, injected mock `fetch`, fixed
 * timestamps. Network is never touched: every live-mode test supplies its own
 * `fetchFn` and asserts the exact call count. Assertions cover valid/invalid/
 * empty/missing-field/stale inputs, timeout, oversize, denied clearance (zero
 * fetches), evaluation limits (feed cap, 100-item cap, one-fetch-per-feed),
 * matcher integration, count arithmetic, labels math, review gating, and a
 * static no-persistence/no-AI import scan of the runner source.
 *
 * All fixtures are authored synthetic strings. They do not reuse real feed
 * content, establish source rights, verify an issuer, or prove an event.
 */
import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { readFileSync } from "node:fs";
import {
  computeLabelMetrics,
  EVAL_FETCH_TIMEOUT_MS,
  EVAL_MAX_ITEMS_TOTAL,
  EVAL_MAX_LIVE_FEEDS,
  EVAL_MODIFIER_KEYS,
  EVAL_USAGE,
  evaluateRssXml,
  fetchFeedBody,
  isSourceClearedForEval,
  loadRegistrySnapshot,
  MAX_EVAL_RESPONSE_BYTES,
  parseEvalArgs,
  parseLabelsFile,
  runShadowEval,
  runShadowEvalCli,
  SYNTHETIC_FIXTURE_NOW,
  type EvalFetchResponse,
  type EvalLabelEntry,
} from "../../../tools/evaluation/det-filter-shadow-eval.js";
import type { RegistryPermissionRow } from "../src/layers/l1-data-knowledge/news-triage.js";

// ---------------------------------------------------------------------------
// Runner source location (for the static isolation scan).
// ---------------------------------------------------------------------------

const RUNNER_URL = new URL(
  "../../../tools/evaluation/det-filter-shadow-eval.ts",
  import.meta.url,
);
const RUNNER_SOURCE = readFileSync(RUNNER_URL, "utf8");

// ---------------------------------------------------------------------------
// Synthetic XML helpers.
// ---------------------------------------------------------------------------

const NOW = "2026-11-02T12:00:00Z";
const LOOKBACK = 48;

function item(parts: {
  title?: string;
  link?: string;
  guid?: string;
  pubDate?: string;
  description?: string;
}): string {
  return (
    "<item>" +
    (parts.title !== undefined ? `<title>${parts.title}</title>` : "") +
    (parts.link !== undefined ? `<link>${parts.link}</link>` : "") +
    (parts.guid !== undefined ? `<guid>${parts.guid}</guid>` : "") +
    (parts.pubDate !== undefined ? `<pubDate>${parts.pubDate}</pubDate>` : "") +
    (parts.description !== undefined ? `<description>${parts.description}</description>` : "") +
    "</item>"
  );
}

function feed(body: string): string {
  return `<rss version="2.0"><channel><title>SYNTHETIC TEST ONLY</title>${body}</channel></rss>`;
}

const CANDIDATE = item({
  title: "SYNTHETIC TEST ONLY: Kebakaran rumah terjadi di Tebet Jakarta Selatan",
  link: "https://synthetic.invalid/candidate",
  guid: "urn:synthetic:candidate",
  pubDate: "2026-11-02T10:00:00Z",
  description: "SYNTHETIC TEST ONLY: Petugas damkar memadamkan kebakaran rumah di Tebet.",
});

const AMBIGUOUS = item({
  title: "SYNTHETIC TEST ONLY: Potensi banjir di Jakarta Selatan",
  link: "https://synthetic.invalid/ambiguous",
  guid: "urn:synthetic:ambiguous",
  pubDate: "2026-11-02T09:00:00Z",
  description: "SYNTHETIC TEST ONLY: Waspada banjir kiriman dari daerah hulu.",
});

const LOW_SIGNAL = item({
  title: "SYNTHETIC TEST ONLY: Jadwal kerja bakti warga minggu depan",
  link: "https://synthetic.invalid/low",
  guid: "urn:synthetic:low",
  pubDate: "2026-11-02T08:00:00Z",
  description: "SYNTHETIC TEST ONLY: Gotong royong rutin warga.",
});

function clearedRow(overrides?: Partial<RegistryPermissionRow>): RegistryPermissionRow {
  return {
    approval_status: "approved",
    auto_acquisition_enabled: true,
    registry_status: "active",
    reuse_basis: ["retain_title", "retain_description"],
    reuse_license_url: null,
    reuse_scope: null,
    reuse_reviewer: null,
    reuse_reviewed_at: null,
    reuse_expires_at: null,
    ...overrides,
  };
}

function okFetch(text: string): EvalFetchResponse {
  return {
    ok: true,
    status: 200,
    body: null,
    text: async () => text,
  };
}

function streamFetch(chunks: Uint8Array[], status = 200): { readonly response: EvalFetchResponse; readonly wasCancelled: () => boolean } {
  let cancelled = false;
  const queue = [...chunks];
  const response: EvalFetchResponse = {
    ok: status >= 200 && status < 300,
    status,
    body: {
      getReader() {
        return {
          async read() {
            if (queue.length === 0) return { done: true as const, value: undefined };
            return { done: false as const, value: queue.shift()! };
          },
          async cancel() {
            cancelled = true;
          },
        };
      },
    } as unknown as ReadableStream<Uint8Array>,
    text: async () => {
      throw new Error("stream path must not call text()");
    },
  };
  return { response, wasCancelled: () => cancelled };
}

// ---------------------------------------------------------------------------
// evaluateRssXml: parse classes.
// ---------------------------------------------------------------------------

test("valid RSS evaluates all three verdicts with a fixed now", () => {
  const result = evaluateRssXml(feed(CANDIDATE + AMBIGUOUS + LOW_SIGNAL), NOW, LOOKBACK);
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("expected valid parse");
  assert.equal(result.fetched, 3);
  assert.equal(result.parsed, 3);
  assert.equal(result.invalid, 0);
  assert.equal(result.stale, 0);
  assert.deepEqual(
    result.items.map((entry) => entry.status),
    ["candidate", "ambiguous", "low_signal"],
  );
});

test("invalid XML returns a bounded error with no items", () => {
  const result = evaluateRssXml("<rss><channel><oops>", NOW, LOOKBACK);
  assert.equal(result.ok, false);
  if (result.ok) throw new Error("expected parse failure");
  assert.match(result.error, /^[a-z_]+$/);
});

test("empty feed evaluates to zero counts without error", () => {
  const result = evaluateRssXml(feed(""), NOW, LOOKBACK);
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("expected empty feed to parse");
  assert.equal(result.fetched, 0);
  assert.equal(result.parsed, 0);
  assert.equal(result.items.length, 0);
});

test("missing titles and links count as invalid; missing descriptions still match", () => {
  const noTitle = item({ link: "https://synthetic.invalid/no-title", guid: "urn:synthetic:no-title" });
  const noLink = item({ title: "SYNTHETIC TEST ONLY: Kebakaran", guid: "urn:synthetic:no-link" });
  const noDescription = item({
    title: "SYNTHETIC TEST ONLY: Kebakaran rumah terjadi di Tebet Jakarta Selatan",
    link: "https://synthetic.invalid/no-desc",
    guid: "urn:synthetic:no-desc",
    pubDate: "2026-11-02T10:00:00Z",
  });
  const result = evaluateRssXml(feed(noTitle + noLink + noDescription), NOW, LOOKBACK);
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("expected parse");
  assert.equal(result.invalid, 2);
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0]!.status, "candidate");
});

test("stale items use poller Date.parse semantics with a fixed now", () => {
  const stale = item({
    title: "SYNTHETIC TEST ONLY: Kebakaran gudang terjadi di Cakung Jakarta Timur",
    link: "https://synthetic.invalid/stale",
    guid: "urn:synthetic:stale",
    // 78h before NOW: stale under the 48h lookback.
    pubDate: "2026-10-30T06:00:00Z",
    description: "SYNTHETIC TEST ONLY: Api melalap gudang.",
  });
  const boundary = item({
    title: "SYNTHETIC TEST ONLY: Jadwal kerja bakti warga minggu depan",
    link: "https://synthetic.invalid/boundary",
    guid: "urn:synthetic:boundary",
    // Unparseable pubDate: never stale (same as the poller).
    description: "SYNTHETIC TEST ONLY: Gotong royong.",
  });
  const result = evaluateRssXml(feed(stale + boundary), NOW, LOOKBACK, { itemBudget: 10 });
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("expected parse");
  assert.equal(result.fetched, 2);
  assert.equal(result.stale, 1);
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0]!.status, "low_signal");
});

// ---------------------------------------------------------------------------
// fetchFeedBody: timeout, oversize, fetch errors.
// ---------------------------------------------------------------------------

test("fetch timeout aborts the signal and reports timeout", async () => {
  let seenSignal: AbortSignal | null = null;
  const hanging = async (_url: string, init: { readonly signal: AbortSignal }) => {
    seenSignal = init.signal;
    await new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(new Error("Request timed out after 5ms")));
    });
    throw new Error("unreachable");
  };
  const result = await fetchFeedBody(
    "https://synthetic.invalid/hang",
    hanging as never,
    5,
    MAX_EVAL_RESPONSE_BYTES,
  );
  assert.deepEqual(result, { ok: false, code: "timeout" });
  assert.ok(seenSignal!.aborted);
});

test("oversized response is discarded without buffering the body", async () => {
  const big = new Uint8Array(MAX_EVAL_RESPONSE_BYTES + 1).fill(120);
  const streamed = streamFetch([big.slice(0, 100), big.slice(100)]);
  const result = await fetchFeedBody(
    "https://synthetic.invalid/big",
    async () => streamed.response,
    EVAL_FETCH_TIMEOUT_MS,
    128,
  );
  assert.deepEqual(result, { ok: false, code: "oversized" });
  assert.equal(streamed.wasCancelled(), true);
});

test("HTTP error status reports fetch_error with no parse attempt", async () => {
  const result = await fetchFeedBody(
    "https://synthetic.invalid/404",
    async () => ({ ok: false, status: 404, body: null, text: async () => "nope" }),
    EVAL_FETCH_TIMEOUT_MS,
    MAX_EVAL_RESPONSE_BYTES,
  );
  assert.deepEqual(result, { ok: false, code: "fetch_error" });
});

// ---------------------------------------------------------------------------
// Clearance: denied sources are never fetched (fail closed).
// ---------------------------------------------------------------------------

test("uncleared source aborts with source_not_cleared and zero fetches", async () => {
  let calls = 0;
  const countingFetch = async () => {
    calls += 1;
    return okFetch(feed(CANDIDATE));
  };
  const denied: RegistryPermissionRow = clearedRow({ approval_status: "pending" });
  const output = await runShadowEval({
    mode: "live",
    lookbackHours: LOOKBACK,
    now: NOW,
    liveSourceIds: ["source-antara-metro"],
    registryRows: { "source-antara-metro": denied },
    fetchFn: countingFetch,
  });
  assert.equal(calls, 0);
  assert.equal(output.exitCode, 1);
  assert.deepEqual(output.errors, [{ sourceId: "source-antara-metro", error_code: "source_not_cleared" }]);
  assert.equal(output.result?.feeds[0]?.source_not_cleared, 1);
  assert.equal(output.result?.total.source_not_cleared, 1);
});

test("missing registry evidence fails closed with zero fetches", async () => {
  let calls = 0;
  const countingFetch = async () => {
    calls += 1;
    return okFetch(feed(CANDIDATE));
  };
  const output = await runShadowEval({
    mode: "live",
    lookbackHours: LOOKBACK,
    now: NOW,
    liveSourceIds: ["source-antara-metro"],
    registryRows: null,
    fetchFn: countingFetch,
  });
  assert.equal(calls, 0);
  assert.deepEqual(output.errors, [{ sourceId: "source-antara-metro", error_code: "source_not_cleared" }]);
});

test("public URL alone never clears: legacy-only tokens without evidence fail closed", () => {
  const legacyOnly = clearedRow({
    reuse_basis: ["public"],
    reuse_license_url: null,
    reuse_reviewer: null,
    reuse_scope: null,
    reuse_reviewed_at: null,
  });
  assert.equal(isSourceClearedForEval(legacyOnly, NOW, "source-antara-metro"), false);
  assert.equal(isSourceClearedForEval(clearedRow(), NOW, "source-antara-metro"), true);
  assert.equal(
    isSourceClearedForEval(clearedRow({ approval_status: "approved", auto_acquisition_enabled: false }), NOW, "source-x"),
    false,
  );
});

// ---------------------------------------------------------------------------
// Evaluation limits: feed cap, 100-item cap, one fetch per feed.
// ---------------------------------------------------------------------------

test("more than 5 live feeds is a usage error before any fetch", async () => {
  let calls = 0;
  const countingFetch = async () => {
    calls += 1;
    return okFetch(feed(CANDIDATE));
  };
  const ids = [
    "source-antara-metro",
    "source-antara-hukum",
    "source-antara-terkini",
    "source-antara-topnews",
    "source-antara-humaniora",
    "source-detik-news",
  ];
  assert.ok(ids.length > EVAL_MAX_LIVE_FEEDS);
  const output = await runShadowEval({
    mode: "live",
    lookbackHours: LOOKBACK,
    now: NOW,
    liveSourceIds: ids,
    registryRows: Object.fromEntries(ids.map((id) => [id, clearedRow()])),
    fetchFn: countingFetch,
  });
  assert.equal(calls, 0);
  assert.equal(output.exitCode, 2);
  assert.deepEqual(output.errors, [{ error_code: "USAGE" }]);
});

test("unknown feed ids fail closed per-feed and are never fetched", async () => {
  let calls = 0;
  const countingFetch = async () => {
    calls += 1;
    return okFetch(feed(CANDIDATE));
  };
  const output = await runShadowEval({
    mode: "live",
    lookbackHours: LOOKBACK,
    now: NOW,
    liveSourceIds: ["source-synthetic-unknown"],
    registryRows: { "source-synthetic-unknown": clearedRow() },
    fetchFn: countingFetch,
  });
  assert.equal(calls, 0);
  assert.equal(output.exitCode, 1);
  assert.deepEqual(output.errors, [{ sourceId: "source-synthetic-unknown", error_code: "USAGE" }]);
});

test("live mode issues exactly one fetch per cleared feed", async () => {
  const calls: string[] = [];
  const countingFetch = async (url: string) => {
    calls.push(url);
    return okFetch(feed(CANDIDATE + AMBIGUOUS));
  };
  const ids = ["source-antara-metro", "source-antara-hukum"];
  const output = await runShadowEval({
    mode: "live",
    lookbackHours: LOOKBACK,
    now: NOW,
    liveSourceIds: ids,
    registryRows: Object.fromEntries(ids.map((id) => [id, clearedRow()])),
    fetchFn: countingFetch,
  });
  assert.deepEqual(calls, [
    "https://www.antaranews.com/rss/metro.xml",
    "https://www.antaranews.com/rss/hukum.xml",
  ]);
  assert.equal(output.exitCode, 0);
  assert.equal(output.result?.feeds.length, 2);
  assert.equal(output.result?.total.candidate, 2);
  assert.equal(output.result?.total.ambiguous, 2);
});

test("evaluation stops deterministically after 100 raw items", async () => {
  const many = Array.from(
    { length: EVAL_MAX_ITEMS_TOTAL + 25 },
    (_, index) =>
      item({
        title: `SYNTHETIC TEST ONLY: Jadwal kerja bakti warga ${index} minggu depan`,
        link: `https://synthetic.invalid/many/${index}`,
        guid: `urn:synthetic:many:${index}`,
        pubDate: "2026-11-02T10:00:00Z",
        description: "SYNTHETIC TEST ONLY: Gotong royong.",
      }),
  ).join("");
  const output = await runShadowEval({
    mode: "synthetic",
    lookbackHours: LOOKBACK,
    now: NOW,
    fixtureXmls: [{ sourceId: "synthetic-overflow", xmlText: feed(many) }],
  });
  assert.equal(output.exitCode, 0);
  assert.equal(output.result?.total.fetched, EVAL_MAX_ITEMS_TOTAL);
  assert.equal(output.result?.total.low_signal, EVAL_MAX_ITEMS_TOTAL);
  assert.equal(output.result?.truncated, true);
});

// ---------------------------------------------------------------------------
// Matcher integration and count arithmetic.
// ---------------------------------------------------------------------------

test("matcher integration records breakdowns by location, group, role, modifier", async () => {
  const output = await runShadowEval({
    mode: "synthetic",
    lookbackHours: LOOKBACK,
    now: NOW,
    fixtureXmls: [{ sourceId: "synthetic-mix", xmlText: feed(CANDIDATE + AMBIGUOUS + LOW_SIGNAL) }],
  });
  assert.equal(output.exitCode, 0);
  const report = output.result!;
  assert.equal(report.total.considered, 3);
  assert.equal(report.total.enforce_skipped, 2);
  assert.equal(report.total.candidate_rate, 1 / 3);
  assert.equal(report.total.ai_call_reduction, 2 / 3);
  assert.ok(report.breakdowns.byRole.scene >= 1);
  assert.ok(report.breakdowns.byModifier.forecast_override_applied >= 1);
  for (const key of EVAL_MODIFIER_KEYS) {
    assert.ok(typeof report.breakdowns.byModifier[key] === "number");
  }
  assert.equal(report.versions.detRuleVersion, "det-filter-v2");
  assert.equal(report.versions.detGazetteerVersion, "2026-11-13-det-filter-03");
  assert.equal(report.versions.detLexiconVersion, "2026-11-13-det-filter-03");
});

test("count arithmetic holds on multi-feed totals", async () => {
  const output = await runShadowEval({
    mode: "synthetic",
    lookbackHours: LOOKBACK,
    now: NOW,
    fixtureXmls: [
      { sourceId: "synthetic-b", xmlText: feed(CANDIDATE) },
      { sourceId: "synthetic-a", xmlText: feed(AMBIGUOUS + LOW_SIGNAL) },
    ],
  });
  assert.equal(output.exitCode, 0);
  const feeds = output.result!.feeds;
  // Deterministic feed order: sorted by sourceId.
  assert.deepEqual(
    feeds.map((entry) => entry.sourceId),
    ["synthetic-a", "synthetic-b"],
  );
  const total = output.result!.total;
  for (const entry of [...feeds, total]) {
    assert.equal(entry.considered, entry.candidate + entry.ambiguous + entry.low_signal);
    assert.equal(entry.enforce_skipped, entry.ambiguous + entry.low_signal);
  }
  assert.equal(total.candidate, 1);
  assert.equal(total.ambiguous, 1);
  assert.equal(total.low_signal, 1);
});

// ---------------------------------------------------------------------------
// Labels math and arg parsing.
// ---------------------------------------------------------------------------

test("labels compute precision/recall/f1 over the labeled sample only", () => {
  const labels: EvalLabelEntry[] = [
    { id: "a", label: "actionable_jakarta_incident" },
    { id: "b", label: "not_actionable" },
    { id: "c", label: "actionable_jakarta_incident" },
    { id: "missing", label: "actionable_jakarta_incident" },
  ];
  const metrics = computeLabelMetrics(
    new Map([
      ["a", "candidate"],
      ["b", "ambiguous"],
      ["c", "ambiguous"],
    ]),
    labels,
  );
  assert.deepEqual(metrics, {
    sampleSize: 3,
    tp: 1,
    fp: 0,
    fn: 1,
    tn: 1,
    precision: 1,
    recall: 0.5,
    f1: 2 / 3,
  });
});

test("label files reject unknown labels, empty ids, and duplicates", () => {
  assert.equal(parseLabelsFile('{"labels": [{"id": "a", "label": "bogus"}]}').ok, false);
  assert.equal(parseLabelsFile('{"labels": [{"id": "", "label": "not_actionable"}]}').ok, false);
  assert.equal(
    parseLabelsFile('{"labels": [{"id": "a", "label": "not_actionable"}, {"id": "a", "label": "not_actionable"}]}').ok,
    false,
  );
  assert.equal(parseLabelsFile("not-json").ok, false);
  const good = parseLabelsFile('{"labels": [{"id": "a", "label": "actionable_jakarta_incident"}]}');
  assert.equal(good.ok, true);
  assert.deepEqual(good.labels, [{ id: "a", label: "actionable_jakarta_incident" }]);
});

test("arg parsing rejects live/source/review misuse", () => {
  assert.deepEqual(parseEvalArgs(["--source", "source-antara-metro"]), {
    ok: false,
    errorCode: "USAGE",
  });
  assert.deepEqual(parseEvalArgs(["--live", "--source", "source-unknown"]), {
    ok: false,
    errorCode: "USAGE",
  });
  assert.deepEqual(parseEvalArgs(["--review", "0"]), { ok: false, errorCode: "USAGE" });
  assert.deepEqual(parseEvalArgs(["--lookback-hours", "-1"]), { ok: false, errorCode: "USAGE" });
  const ok = parseEvalArgs(["--live", "--source", "source-antara-metro", "--lookback-hours", "24"]);
  assert.equal(ok.ok, true);
  if (!ok.ok) throw new Error("expected valid args");
  assert.equal(ok.options.live, true);
  assert.equal(ok.options.lookbackHours, 24);
});

// ---------------------------------------------------------------------------
// Review gating: retention evidence required; never persisted.
// ---------------------------------------------------------------------------

test("review without registry evidence errors out", async () => {
  const output = await runShadowEval({
    mode: "synthetic",
    lookbackHours: LOOKBACK,
    now: NOW,
    fixtureXmls: [{ sourceId: "synthetic-mix", xmlText: feed(CANDIDATE) }],
    registryRows: null,
    reviewLimit: 1,
  });
  assert.equal(output.exitCode, 2);
  assert.deepEqual(output.errors, [{ error_code: "review_not_permitted" }]);
  assert.equal(output.result, null);
  assert.equal(output.reviewSample, null);
});

test("review with retention evidence returns truncated transient samples", async () => {
  // Over the 500-code-point review truncation but under every parser field
  // cap, so the item evaluates and the sample asserts truncation.
  const longTitle = `SYNTHETIC TEST ONLY: Kebakaran rumah terjadi di Tebet ${"x".repeat(440)}`;
  const longExcerpt = `SYNTHETIC TEST ONLY: Petugas damkar memadamkan kebakaran ${"y".repeat(900)}`;
  const output = await runShadowEval({
    mode: "synthetic",
    lookbackHours: LOOKBACK,
    now: NOW,
    fixtureXmls: [
      {
        sourceId: "synthetic-mix",
        xmlText: feed(
          item({
            title: longTitle,
            link: "https://synthetic.invalid/long",
            guid: "urn:synthetic:long",
            pubDate: "2026-11-02T10:00:00Z",
            description: longExcerpt,
          }),
        ),
      },
    ],
    registryRows: { "synthetic-mix": clearedRow() },
    reviewLimit: 1,
  });
  assert.equal(output.exitCode, 0);
  assert.equal(output.reviewSample?.length, 1);
  const sample = output.reviewSample![0]!;
  assert.ok(Array.from(sample.title).length <= 500);
  assert.ok(sample.excerpt === null || Array.from(sample.excerpt).length <= 500);
});

test("review denied when any evaluated feed lacks description retention", async () => {
  const output = await runShadowEval({
    mode: "synthetic",
    lookbackHours: LOOKBACK,
    now: NOW,
    fixtureXmls: [{ sourceId: "synthetic-mix", xmlText: feed(CANDIDATE) }],
    registryRows: { "synthetic-mix": clearedRow({ reuse_basis: ["retain_title"] }) },
    reviewLimit: 1,
  });
  assert.equal(output.exitCode, 2);
  assert.deepEqual(output.errors, [{ error_code: "review_not_permitted" }]);
});

// ---------------------------------------------------------------------------
// Isolation: no persistence, no AI, no queues in the runner (static scan).
// The runner's only worker imports are the four pure eval helpers plus the
// feed allowlist and the read-only permission semantics; its transitive
// closure is pure (node:crypto, saxes, versioned JSON datasets).
// ---------------------------------------------------------------------------

const FORBIDDEN_RUNNER_PATTERNS: readonly { readonly pattern: RegExp; readonly label: string }[] = [
  { pattern: /\brunGatedRssCycle\b/, label: "runGatedRssCycle" },
  { pattern: /\bpersistAcceptedRssItem\b/, label: "persistAcceptedRssItem" },
  { pattern: /\bpersistHeldTriageItem\b/, label: "persistHeldTriageItem" },
  { pattern: /\bStoredReportRevision\b/, label: "StoredReportRevision" },
  { pattern: /\bPreparedNewsReportRevision\b/, label: "PreparedNewsReportRevision" },
  { pattern: /\breport_revision_id\b/, label: "report_revision_id" },
  { pattern: /\btriageNewsItemSemantic\b/, label: "triageNewsItemSemantic" },
  { pattern: /\bprecheckNewsItem\b/, label: "precheckNewsItem" },
  { pattern: /\bcallChat\b/, label: "callChat" },
  { pattern: /\bchatProvider\b/i, label: "chatProvider" },
  { pattern: /\bembedding\b/i, label: "embedding" },
  { pattern: /\bqueue\b/i, label: "queue" },
  { pattern: /\bPGlite\b/, label: "PGlite" },
  { pattern: /\bexecutor\b/i, label: "executor" },
  { pattern: /\.query\(/, label: ".query(" },
  { pattern: /\bINSERT INTO\b/, label: "INSERT INTO" },
  { pattern: /\bprocess\.env\b/, label: "process.env" },
  { pattern: /\bNEWS_DETERMINISTIC_FILTER_MODE\b/, label: "NEWS_DETERMINISTIC_FILTER_MODE" },
  { pattern: /\bNEWS_MAX_AGE_HOURS\b/, label: "NEWS_MAX_AGE_HOURS" },
  { pattern: /\barticles?\b/i, label: "article(s)" },
];

test("runner imports no gated persistence, AI, embedding, or queue code", () => {
  for (const { pattern, label } of FORBIDDEN_RUNNER_PATTERNS) {
    assert.ok(!pattern.test(RUNNER_SOURCE), `runner source must not contain ${label}`);
  }
});

test("runner imports only the allowed worker modules", () => {
  const imports = [...RUNNER_SOURCE.matchAll(/from "([^"]+)"/g)].map((match) => match[1]!);
  const workerImports = imports.filter((spec) => spec.startsWith("../../apps/worker/"));
  assert.deepEqual(workerImports, [
    "../../apps/worker/src/layers/l1-data-knowledge/rss-discovery.js",
    "../../apps/worker/src/layers/l1-data-knowledge/rss-news-ingest.js",
    "../../apps/worker/src/layers/l1-data-knowledge/deterministic-relevance.js",
    "../../apps/worker/src/runtime/news-poll-runtime.js",
    "../../apps/worker/src/layers/l1-data-knowledge/news-triage.js",
  ]);
});

test("registry snapshot loader rejects non-object and malformed rows", () => {
  assert.equal(loadRegistrySnapshot("[]").ok, false);
  assert.equal(loadRegistrySnapshot('{"a": 1}').ok, false);
  assert.equal(loadRegistrySnapshot('{"a": {}}').ok, false);
  const snapshot = loadRegistrySnapshot(JSON.stringify({ "source-x": clearedRow() }));
  assert.equal(snapshot.ok, true);
  assert.deepEqual(Object.keys(snapshot.rows), ["source-x"]);
});

// ---------------------------------------------------------------------------
// CLI: pinned synthetic clock, all-stale fail-closed, --help.
// ---------------------------------------------------------------------------

async function runCli(
  argv: readonly string[],
): Promise<{ readonly exitCode: 0 | 1 | 2; readonly stdout: string; readonly stderr: string }> {
  let stdout = "";
  let stderr = "";
  const exitCode = await runShadowEvalCli(argv, {
    stdout: {
      write: (chunk: string) => {
        stdout += chunk;
        return true;
      },
    },
    stderr: {
      write: (chunk: string) => {
        stderr += chunk;
        return true;
      },
    },
  });
  return { exitCode, stdout, stderr };
}

test("default synthetic run pins its clock and evaluates fixtures on a later wall clock", async () => {
  // Wall clock set well past the fixture window: an unpinned default would
  // mark every item stale and exit 0 with zero considered items.
  mock.timers.enable({ apis: ["Date"], now: Date.parse("2030-01-01T00:00:00Z") });
  try {
    assert.equal(new Date().getUTCFullYear(), 2030);
    const run = await runCli([]);
    assert.equal(run.exitCode, 0);
    assert.equal(run.stderr, "");
    const report = JSON.parse(run.stdout) as {
      mode: string;
      now: string;
      total: { considered: number };
    };
    assert.equal(report.mode, "synthetic");
    assert.equal(report.now, SYNTHETIC_FIXTURE_NOW);
    assert.ok(report.total.considered > 0, "fixtures must yield evaluated items inside the lookback");
  } finally {
    mock.timers.reset();
  }
});

test("all-stale input fails closed with all_items_stale and exit 1", async () => {
  const run = await runCli(["--now", "2030-01-01T00:00:00Z"]);
  assert.equal(run.exitCode, 1);
  assert.deepEqual(
    run.stderr.trim().split("\n").map((line) => JSON.parse(line) as unknown),
    [{ error_code: "all_items_stale" }],
  );
  const report = JSON.parse(run.stdout) as { total: { considered: number; stale: number } };
  assert.equal(report.total.considered, 0);
  assert.ok(report.total.stale > 0);
});

test("all-stale check ignores a feed with no items at all", async () => {
  const output = await runShadowEval({
    mode: "synthetic",
    lookbackHours: LOOKBACK,
    now: NOW,
    fixtureXmls: [{ sourceId: "synthetic-empty", xmlText: feed("") }],
  });
  assert.equal(output.exitCode, 0);
  assert.deepEqual(output.errors, []);
});

test("--help prints usage to stdout and exits 0 without evaluating", async () => {
  const run = await runCli(["--help"]);
  assert.equal(run.exitCode, 0);
  assert.equal(run.stdout, EVAL_USAGE);
  assert.equal(run.stderr, "");
});
