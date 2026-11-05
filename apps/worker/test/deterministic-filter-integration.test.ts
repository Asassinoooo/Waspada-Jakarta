/**
 * DET-FILTER-01 gate wiring tests (synthetic fixtures + mock adapters only;
 * no NineRouter, no live sources, no credentials, no database).
 *
 * - candidate still calls chat exactly once and keeps its revision;
 * - enforce ambiguous/low_signal skip chat (0 calls), create no revision/job,
 *   and persist an auditable held decision;
 * - shadow mode preserves chat-call behavior exactly while exposing counters;
 * - auth-denied items never reach the matcher path (no deterministic counters).
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  applyTriageGate,
  type StoredReportRevision,
} from "../src/runtime/news-poll-runtime.js";
import {
  matchDeterministicRelevance,
} from "../src/layers/l1-data-knowledge/deterministic-relevance.js";

const RETRIEVED_AT = "2026-10-26T08:00:00Z";

function storedRevision(
  guid: string,
  title: string,
  excerpt: string | null,
): StoredReportRevision {
  const permittedText = excerpt !== null ? `${title}\n\n${excerpt}` : title;
  return {
    report_revision_id: `rep-test-${guid}`,
    source_id: "source-synthetic-test",
    canonical_url: `https://example.test/news/${guid}`,
    permitted_text: permittedText,
    permitted_text_hash: "0".repeat(64),
    published_at: "2026-10-26T07:30:00.000Z",
    retrieved_at: RETRIEVED_AT,
    revision_status: "unreviewed",
    chunks: [{ chunk_index: 0, text: permittedText, span_start: 0, span_end: permittedText.length }],
    content_hash: "1".repeat(64),
    source_revision_key: guid,
  };
}

const CANDIDATE_TITLE = "Kebakaran rumah terjadi di Tebet Jakarta Selatan";
const CANDIDATE_EXCERPT = "Petugas damkar memadamkan kebakaran rumah yang terjadi di Tebet";
// Title-only: no scene cue -> ambiguous, never silently promoted.
const AMBIGUOUS_TITLE = "Kebakaran hanguskan puluhan kios di kawasan Pasar Senen Jakarta Pusat";
const LOW_SIGNAL_TITLE = "Pemerintah luncurkan program beasiswa pelajar berprestasi";
const LOW_SIGNAL_EXCERPT = "Program beasiswa tahap dua untuk pelajar berprestasi diumumkan hari ini";

function clearedTriage(overrides: Record<string, unknown> = {}) {
  return {
    sourceRemit: "synthetic test",
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
    policyVersion: "wj-int-02-v2",
    concurrency: 4,
    deterministicMode: "shadow" as const,
    ...overrides,
  };
}

function ingestChatMock(calls: unknown[]) {
  return async () => {
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
  };
}

test("candidate still calls chat exactly once and keeps its revision", async () => {
  const calls: unknown[] = [];
  const guid = "candidate-1";
  const result = await applyTriageGate(
    [storedRevision(guid, CANDIDATE_TITLE, CANDIDATE_EXCERPT)],
    [{ guid, title: CANDIDATE_TITLE, descriptionExcerpt: CANDIDATE_EXCERPT, link: `https://example.test/news/${guid}`, pubDate: "Mon, 26 Oct 2026 07:30:00 +0700" }],
    { url: "https://example.test/feed.xml", sourceId: "source-synthetic-test" },
    RETRIEVED_AT,
    clearedTriage({ callChat: ingestChatMock(calls), deterministicMode: "enforce" }),
  );
  assert.equal(calls.length, 1);
  assert.equal(result.revisions.length, 1);
  assert.equal(result.held.length, 0);
  assert.equal(result.triageCounts.detConsidered, 1);
  assert.equal(result.triageCounts.detCandidate, 1);
  assert.equal(result.triageCounts.detModelCallsSkipped, 0);
});

test("enforce ambiguous skips chat, creates no revision, and holds an auditable decision", async () => {
  const calls: unknown[] = [];
  assert.equal(matchDeterministicRelevance(AMBIGUOUS_TITLE, null).status, "ambiguous");
  const guid = "ambiguous-1";
  const result = await applyTriageGate(
    [storedRevision(guid, AMBIGUOUS_TITLE, null)],
    [{ guid, title: AMBIGUOUS_TITLE, descriptionExcerpt: null, link: `https://example.test/news/${guid}`, pubDate: "Mon, 26 Oct 2026 07:30:00 +0700" }],
    { url: "https://example.test/feed.xml", sourceId: "source-synthetic-test" },
    RETRIEVED_AT,
    clearedTriage({ callChat: ingestChatMock(calls), deterministicMode: "enforce" }),
  );
  assert.equal(calls.length, 0);
  assert.equal(result.revisions.length, 0);
  assert.equal(result.held.length, 1);
  assert.equal(result.held[0]!.decision.disposition, "uncertain");
  assert.equal(result.held[0]!.decision.modelStatus, "skipped_stage_a");
  assert.equal(result.triageCounts.detAmbiguous, 1);
  assert.equal(result.triageCounts.detModelCallsSkipped, 1);
});

test("enforce low_signal skips chat and holds a drop decision", async () => {
  const calls: unknown[] = [];
  assert.equal(matchDeterministicRelevance(LOW_SIGNAL_TITLE, LOW_SIGNAL_EXCERPT).status, "low_signal");
  const guid = "lowsignal-1";
  const result = await applyTriageGate(
    [storedRevision(guid, LOW_SIGNAL_TITLE, LOW_SIGNAL_EXCERPT)],
    [{ guid, title: LOW_SIGNAL_TITLE, descriptionExcerpt: LOW_SIGNAL_EXCERPT, link: `https://example.test/news/${guid}`, pubDate: "Mon, 26 Oct 2026 07:30:00 +0700" }],
    { url: "https://example.test/feed.xml", sourceId: "source-synthetic-test" },
    RETRIEVED_AT,
    clearedTriage({ callChat: ingestChatMock(calls), deterministicMode: "enforce" }),
  );
  assert.equal(calls.length, 0);
  assert.equal(result.revisions.length, 0);
  assert.equal(result.held.length, 1);
  assert.equal(result.held[0]!.decision.disposition, "drop");
  assert.deepEqual(result.held[0]!.decision.reasonCodes, ["vague_report"]);
  assert.equal(result.triageCounts.detLowSignal, 1);
  assert.equal(result.triageCounts.detModelCallsSkipped, 1);
});

test("shadow mode preserves chat-call behavior exactly while exposing counters", async () => {
  for (const [guid, title, excerpt] of [
    ["shadow-cand", CANDIDATE_TITLE, CANDIDATE_EXCERPT],
    ["shadow-amb", AMBIGUOUS_TITLE, null],
    ["shadow-low", LOW_SIGNAL_TITLE, LOW_SIGNAL_EXCERPT],
  ] as const) {
    const calls: unknown[] = [];
    const result = await applyTriageGate(
      [storedRevision(guid, title, excerpt)],
      [{ guid, title, descriptionExcerpt: excerpt, link: `https://example.test/news/${guid}`, pubDate: "Mon, 26 Oct 2026 07:30:00 +0700" }],
      { url: "https://example.test/feed.xml", sourceId: "source-synthetic-test" },
      RETRIEVED_AT,
      clearedTriage({ callChat: ingestChatMock(calls), deterministicMode: "shadow" }),
    );
    // Shadow never skips: every fresh cleared item reaches Stage B.
    assert.equal(calls.length, 1, guid);
    assert.equal(result.triageCounts.detModelCallsSkipped, 0, guid);
    assert.equal(result.triageCounts.detConsidered, 1, guid);
  }
});

test("auth-denied items never reach the matcher path", async () => {
  const calls: unknown[] = [];
  const guid = "denied-1";
  const result = await applyTriageGate(
    [storedRevision(guid, CANDIDATE_TITLE, CANDIDATE_EXCERPT)],
    [{ guid, title: CANDIDATE_TITLE, descriptionExcerpt: CANDIDATE_EXCERPT, link: `https://example.test/news/${guid}`, pubDate: "Mon, 26 Oct 2026 07:30:00 +0700" }],
    { url: "https://example.test/feed.xml", sourceId: "source-synthetic-test" },
    RETRIEVED_AT,
    clearedTriage({
      callChat: ingestChatMock(calls),
      checkAuthorization: async () => ({ cleared: false, reason: "source_not_cleared" }),
      deterministicMode: "enforce",
    }),
  );
  assert.equal(calls.length, 0);
  assert.equal(result.held.length, 1);
  assert.equal(result.held[0]!.decision.reasonCodes.includes("source_not_cleared"), true);
  assert.equal(result.triageCounts.detConsidered, 0);
  assert.equal(result.triageCounts.authzRejected, 1);
});
