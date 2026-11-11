/**
 * AI-RATE-01 triage behavior under NineRouter rate limits.
 *
 * - a rate-limited Stage B call is a distinct `rate_limited` outcome;
 * - the live chat transport turns a 429 into one RateLimitedError, with no retry inside the call;
 * - during a chat cooldown, fresh Stage B items are held without a model call;
 * - rate-limited attempts never consume the provider_error retry budget.
 *
 * Fake clock, fake fetch and PGlite only. No network, no credentials.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { applyMigrations, readMigrations } from "../../db/src/migrations.js";
import type { SqlExecutor } from "../../db/src/sql.js";
import {
  createNineRouterRateGate,
  RateLimitedError,
  setNineRouterRateGate,
} from "../../db/src/ninerouter-rate-gate.js";
import {
  NEWS_TRIAGE_POLICY_VERSION,
  recordTriageAttempt,
  recordTriageDecision,
} from "../../db/src/news-triage-store.js";
import { createTestDatabase } from "../../db/test/harness.js";
import { triageNewsItemSemantic } from "../src/layers/l1-data-knowledge/news-triage.js";
import { buildLiveTriageGate } from "../src/runtime/news-triage-composition.js";
import { applyTriageGate, type StoredReportRevision } from "../src/runtime/news-poll-runtime.js";

const RETRIEVED_AT = "2026-11-11T08:00:00Z";

function fakeClock(startMs = 1_000_000_000_000) {
  let t = startMs;
  return {
    clock: {
      now: () => t,
      sleep: async (ms: number) => {
        t += ms;
      },
    },
    get now() {
      return t;
    },
  };
}

const fakeExecutor = {
  async query() {
    return {
      rows: [{
        approval_status: "approved",
        auto_acquisition_enabled: true,
        registry_status: "active",
        reuse_basis: ["model_triage", "model_description", "retain_title", "retain_description", "retain_derived", "public_display"],
        remit: "general news",
      }],
    };
  },
  async execute() {},
} as unknown as SqlExecutor;

const CANDIDATE_TITLE = "Kebakaran rumah terjadi di Tebet Jakarta Selatan";
const CANDIDATE_EXCERPT = "Petugas damkar memadamkan kebakaran rumah yang terjadi di Tebet";

function storedRevision(guid: string): StoredReportRevision {
  const permittedText = `${CANDIDATE_TITLE}\n\n${CANDIDATE_EXCERPT}`;
  return {
    report_revision_id: `rep-rl-${guid}`,
    source_id: "source-rate-limit-test",
    canonical_url: `https://example.test/news/${guid}`,
    permitted_text: permittedText,
    permitted_text_hash: "0".repeat(64),
    published_at: "2026-11-11T07:30:00.000Z",
    retrieved_at: RETRIEVED_AT,
    revision_status: "unreviewed",
    chunks: [{ chunk_index: 0, text: permittedText, span_start: 0, span_end: permittedText.length }],
    content_hash: "1".repeat(64),
    source_revision_key: guid,
  };
}

function triageOptions(overrides: Record<string, unknown> = {}) {
  return {
    sourceRemit: "general news",
    checkAuthorization: async () => ({
      cleared: true,
      permissions: {
        acquisition: true,
        titleModel: true,
        descriptionModel: true,
        titleRetention: true,
        descriptionRetention: true,
        derivedRetention: true,
        publicDisplay: false,
      },
    }),
    findPriorDecision: async () => null,
    policyVersion: NEWS_TRIAGE_POLICY_VERSION,
    concurrency: 2,
    deterministicMode: "enforce" as const,
    ...overrides,
  };
}

function classifiedFor(guid: string) {
  return [{
    guid,
    title: CANDIDATE_TITLE,
    descriptionExcerpt: CANDIDATE_EXCERPT,
    link: `https://example.test/news/${guid}`,
    pubDate: "Tue, 11 Nov 2026 07:30:00 +0700",
  }];
}

const FEED = { url: "https://example.test/feed.xml", sourceId: "source-rate-limit-test" };

test("a rate-limited Stage B call is a distinct rate_limited outcome, not a provider error", async () => {
  const decision = await triageNewsItemSemantic(
    {
      sourceId: "source-rate-limit-test",
      sourceRemit: "general news",
      title: CANDIDATE_TITLE,
      descriptionExcerpt: CANDIDATE_EXCERPT,
      pubDate: null,
      retrievedAt: RETRIEVED_AT,
    },
    async () => {
      throw new RateLimitedError({ retryAfterMs: 7_000, status: 429, bucket: "chat" });
    },
  );
  assert.equal(decision.modelStatus, "rate_limited");
  assert.deepEqual(decision.reasonCodes, ["rate_limited"]);
  assert.equal(decision.disposition, "uncertain");
});

test("ordinary transport failures remain provider_error", async () => {
  const decision = await triageNewsItemSemantic(
    {
      sourceId: "source-rate-limit-test",
      sourceRemit: "general news",
      title: CANDIDATE_TITLE,
      descriptionExcerpt: null,
      pubDate: null,
      retrievedAt: RETRIEVED_AT,
    },
    async () => {
      throw new Error("triage chat HTTP 500");
    },
  );
  assert.equal(decision.modelStatus, "provider_error");
  assert.deepEqual(decision.reasonCodes, ["provider_error"]);
});

test("the live chat transport turns a 429 into one rate_limited error with no in-call retry", async () => {
  const fc = fakeClock();
  setNineRouterRateGate(createNineRouterRateGate({ clock: fc.clock, random: () => 0, log: () => {} }));
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = (async () => {
    fetchCalls += 1;
    return new Response('{"error":"rate limit"}', { status: 429, headers: { "retry-after": "7" } });
  }) as typeof fetch;
  try {
    const gate = buildLiveTriageGate({ NINEROUTER_URL: "http://nr.test:9090", NINEROUTER_KEY: "test-key" }, fakeExecutor);
    let caught: unknown;
    try {
      await gate.callChat!("system", "user");
    } catch (error) {
      caught = error;
    }
    assert.ok(caught instanceof RateLimitedError, "the 429 surfaces as RateLimitedError");
    assert.equal(fetchCalls, 1, "no second attempt inside the call");
    assert.equal(gate.chatCooldownRemainingMs?.(), 7_000, "the shared chat cooldown is active");
  } finally {
    globalThis.fetch = originalFetch;
    setNineRouterRateGate(undefined);
  }
});

test("during a chat cooldown a fresh Stage B item is held without a model call", async () => {
  const calls: unknown[] = [];
  const result = await applyTriageGate(
    [storedRevision("cooldown-1")],
    classifiedFor("cooldown-1"),
    FEED,
    RETRIEVED_AT,
    triageOptions({
      callChat: async () => {
        calls.push(1);
        throw new Error("must not be called during cooldown");
      },
      chatCooldownRemainingMs: () => 5_000,
    }),
  );
  assert.equal(calls.length, 0, "no model call during cooldown");
  assert.equal(result.revisions.length, 0, "nothing is persisted for the held item");
  assert.equal(result.held.length, 0, "no outcome is recorded for it");
  assert.equal(result.triageCounts.rateLimitDeferred, 1);
});

test("with no active cooldown the same item is evaluated once", async () => {
  const calls: unknown[] = [];
  const result = await applyTriageGate(
    [storedRevision("cooldown-0")],
    classifiedFor("cooldown-0"),
    FEED,
    RETRIEVED_AT,
    triageOptions({
      callChat: async () => {
        calls.push(1);
        return {
          disposition: "ingest",
          jakartaScope: "dki_jakarta",
          actionability: "actionable",
          primaryCategory: "fires_infrastructure_hazards",
          incidentType: "kebakaran rumah",
          confidence: "high",
          reasonCodes: ["triage_v1_ingest"],
          evidence: [{ field: "title", exactQuote: "Kebakaran rumah terjadi di Tebet" }],
        };
      },
      chatCooldownRemainingMs: () => 0,
    }),
  );
  assert.equal(calls.length, 1);
  assert.equal(result.revisions.length, 1);
  assert.equal(result.triageCounts.rateLimitDeferred, 0);
});

test("a rate-limited model call is held as rate_limited and never counted as a provider failure", async () => {
  const result = await applyTriageGate(
    [storedRevision("rl-held")],
    classifiedFor("rl-held"),
    FEED,
    RETRIEVED_AT,
    triageOptions({
      callChat: async () => {
        throw new RateLimitedError({ retryAfterMs: 7_000, status: 429, bucket: "chat" });
      },
    }),
  );
  assert.equal(result.revisions.length, 0);
  assert.equal(result.held.length, 1);
  assert.equal(result.held[0]?.decision.modelStatus, "rate_limited");
  assert.deepEqual(result.held[0]?.decision.reasonCodes, ["rate_limited"]);
  assert.equal(result.triageCounts.rateLimited, 1);
  assert.equal(result.triageCounts.providerFailures, 0);
});

test("rate-limited attempts do not consume the provider_error retry budget", async () => {
  const db = await createTestDatabase();
  try {
    const migrations = await readMigrations(new URL("../../db/migrations/", import.meta.url));
    await applyMigrations(db.executor, migrations);

    const itemIdentityHash = createHash("sha256").update("source-rate-limit-test|budget-item").digest("hex");
    const contentHash = "c".repeat(64);
    const reportRevisionId = "rev-rate-budget-1";
    const sourceId = "source-rate-limit-test";
    const traceId = "trace-rate-budget-1";

    await recordTriageDecision(db.executor, {
      datasetKind: "live",
      itemIdentityHash,
      sourceId,
      traceId,
      disposition: "uncertain",
      jakartaScope: "unknown",
      actionability: "unknown",
      primaryCategory: null,
      incidentType: null,
      confidence: "low",
      reasonCodes: ["provider_error"],
      policyVersion: NEWS_TRIAGE_POLICY_VERSION,
      modelStatus: "provider_error",
      reportRevisionId,
      contentHash,
      attemptCount: 1,
    });

    const attempt = (modelStatus: "provider_error" | "rate_limited") =>
      recordTriageAttempt(db.executor, {
        datasetKind: "live",
        itemIdentityHash,
        reportRevisionId,
        sourceId,
        traceId,
        disposition: "uncertain",
        jakartaScope: "unknown",
        actionability: "unknown",
        primaryCategory: null,
        incidentType: null,
        confidence: "low",
        reasonCodes: [modelStatus],
        policyVersion: NEWS_TRIAGE_POLICY_VERSION,
        modelStatus,
        contentHash,
      });

    const gate = buildLiveTriageGate({ NINEROUTER_URL: "http://nr.test:9090", NINEROUTER_KEY: "test-key" }, db.executor);
    const lookup = () => gate.findPriorDecision({
      itemIdentityHash,
      contentHash,
      policyVersion: NEWS_TRIAGE_POLICY_VERSION,
      reportRevisionId,
    });

    // One provider_error, then five rate-limited evaluations, then one more
    // provider_error: two provider errors in total, so the budget is not spent.
    await attempt("provider_error");
    for (let i = 0; i < 5; i++) await attempt("rate_limited");
    await attempt("provider_error");
    assert.equal(await lookup(), null, "fresh evaluation allowed: rate_limits do not count as provider errors");

    // A third provider_error exhausts the budget and returns the cached uncertain outcome.
    await attempt("provider_error");
    const exhausted = await lookup();
    assert.ok(exhausted, "the provider_error budget still exhausts after three provider errors");
    assert.equal(exhausted.modelStatus, "provider_error");
    assert.equal(exhausted.disposition, "uncertain");
  } finally {
    await db.close();
  }
});

test("a latest rate_limited attempt is never replayed as a settled outcome", async () => {
  const db = await createTestDatabase();
  try {
    const migrations = await readMigrations(new URL("../../db/migrations/", import.meta.url));
    await applyMigrations(db.executor, migrations);
    const itemIdentityHash = createHash("sha256").update("source-rate-limit-test|replay-item").digest("hex");
    const contentHash = "d".repeat(64);
    const reportRevisionId = "rev-rate-replay-1";
    const sourceId = "source-rate-limit-test";
    const traceId = "trace-rate-replay-1";
    await recordTriageDecision(db.executor, {
      datasetKind: "live",
      itemIdentityHash,
      sourceId,
      traceId,
      disposition: "uncertain",
      jakartaScope: "unknown",
      actionability: "unknown",
      primaryCategory: null,
      incidentType: null,
      confidence: "low",
      reasonCodes: ["rate_limited"],
      policyVersion: NEWS_TRIAGE_POLICY_VERSION,
      modelStatus: "rate_limited",
      reportRevisionId,
      contentHash,
      attemptCount: 1,
    });
    await recordTriageAttempt(db.executor, {
      datasetKind: "live",
      itemIdentityHash,
      reportRevisionId,
      sourceId,
      traceId,
      disposition: "uncertain",
      jakartaScope: "unknown",
      actionability: "unknown",
      primaryCategory: null,
      incidentType: null,
      confidence: "low",
      reasonCodes: ["rate_limited"],
      policyVersion: NEWS_TRIAGE_POLICY_VERSION,
      modelStatus: "rate_limited",
      contentHash,
    });
    const gate = buildLiveTriageGate({ NINEROUTER_URL: "http://nr.test:9090", NINEROUTER_KEY: "test-key" }, db.executor);
    const prior = await gate.findPriorDecision({
      itemIdentityHash,
      contentHash,
      policyVersion: NEWS_TRIAGE_POLICY_VERSION,
      reportRevisionId,
    });
    assert.equal(prior, null, "a rate-limited uncertain row must not be replayed; the item is re-evaluated");
  } finally {
    await db.close();
  }
});
