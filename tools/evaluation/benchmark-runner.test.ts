import assert from "node:assert/strict";
import test from "node:test";
import {
  runModelBenchmark,
  JAKARTA_BENCHMARK_SCENARIOS,
  type ModelBenchmarkSummary,
} from "./model-benchmark.js";
import {
  createAiProposalService,
  isCoordinateInJakarta,
} from "../../apps/worker/src/layers/l2-model-grounding/ai-proposal-service.js";
import type { StoredReportRevision } from "../../apps/worker/src/layers/l2-model-grounding/proposal-engine.js";

test("runModelBenchmark executes all 10 Jakarta emergency scenarios with high faithfulness", async () => {
  const summary: ModelBenchmarkSummary = await runModelBenchmark();

  // 1. Scenario volume
  assert.equal(summary.total_scenarios, 10);
  assert.equal(summary.scenarios.length, 10);

  // 2. Latency metrics
  assert.ok(summary.latency_ms.p50 >= 0, `Expected p50 >= 0, got ${summary.latency_ms.p50}`);
  assert.ok(
    summary.latency_ms.p95 >= summary.latency_ms.p50,
    `Expected p95 (${summary.latency_ms.p95}) >= p50 (${summary.latency_ms.p50})`,
  );
  assert.ok(summary.latency_ms.avg >= 0, `Expected avg >= 0, got ${summary.latency_ms.avg}`);

  // 3. Token metrics
  assert.ok(summary.tokens.avg_input > 50, `Expected avg_input > 50, got ${summary.tokens.avg_input}`);
  assert.ok(summary.tokens.avg_output > 50, `Expected avg_output > 50, got ${summary.tokens.avg_output}`);

  // 4. Citation faithfulness rate (target >= 95% = 0.95)
  assert.ok(
    summary.citation_faithfulness_rate >= 0.95,
    `Expected citation faithfulness >= 0.95, got ${summary.citation_faithfulness_rate}`,
  );

  // 5. Toponym accuracy rate within Jakarta envelope (target >= 95% = 0.95)
  assert.ok(
    summary.toponym_accuracy_rate >= 0.95,
    `Expected toponym accuracy >= 0.95, got ${summary.toponym_accuracy_rate}`,
  );

  // 6. Detailed scenario validation
  for (const s of summary.scenarios) {
    assert.ok(s.id.startsWith("scen-"), `Unexpected scenario ID ${s.id}`);
    assert.ok(s.title.length > 5, `Expected descriptive title, got ${s.title}`);
    assert.ok(
      ["flood", "fire", "accident", "tree_fall", "crime", "weather"].includes(s.incident_type),
      `Unexpected incident type ${s.incident_type}`,
    );
    assert.equal(s.citation_match, true, `Scenario ${s.id} should have valid verbatim citations`);
    assert.equal(s.location_valid, true, `Scenario ${s.id} should have coordinates within Jakarta envelope`);
  }
});

test("createAiProposalService connects to remote LLM transport and parses structured response", async () => {
  const mockLlmResponse = {
    choices: [
      {
        message: {
          content: JSON.stringify({
            incident_type: "flood",
            severity: "high",
            title: "Banjir Parah di Kemang, Jakarta Selatan",
            location_label: "Kemang, Jakarta Selatan",
            coordinates: [106.8156, -6.2601],
            event_time: {
              precision: "exact",
              value: "2026-10-27T09:00:00Z",
            },
            claims: [
              {
                claim_id: "claim-1",
                claim_text: "Genangan air setinggi 80 cm merendam Jalan Kemang Raya.",
                quote_text: "banjir setinggi 70 cm di Jalan Kemang Raya",
                chunk_index: 0,
              },
            ],
          }),
        },
      },
    ],
    usage: {
      prompt_tokens: 350,
      completion_tokens: 140,
    },
  };

  const mockFetch = async () =>
    new Response(JSON.stringify(mockLlmResponse), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });

  const service = createAiProposalService({
    baseUrl: "https://api.mockllm.internal/v1",
    apiKey: "test-api-key-12345",
    model: "my-gateway/ag/gemini-3.8-flash-high",
    fetchImpl: mockFetch as typeof fetch,
  });

  const report: StoredReportRevision = {
    report_revision_id: "rev-mock-01",
    source_id: "antara-metro",
    canonical_url: "https://antaranews.com/berita/mock-01",
    permitted_text: "Terjadi banjir setinggi 70 cm di Jalan Kemang Raya akibat hujan lebat.",
    permitted_text_hash: "hash01",
    published_at: "2026-10-27T08:00:00Z",
    retrieved_at: "2026-10-27T08:05:00Z",
    revision_status: "unreviewed",
    chunks: [
      {
        chunk_index: 0,
        text: "Terjadi banjir setinggi 70 cm di Jalan Kemang Raya akibat hujan lebat.",
        span_start: 0,
        span_end: 69,
      },
    ],
  };

  const result = await service.extractProposal(report);

  assert.equal(result.used_fallback, false);
  assert.equal(result.provider, "my-gateway/ag/gemini-3.8-flash-high");
  assert.equal(result.input_tokens, 350);
  assert.equal(result.output_tokens, 140);
  assert.ok(result.proposal !== null);
  assert.equal(result.proposal.incident_type, "flood");
  assert.equal(result.proposal.severity, "high");
  assert.equal(result.proposal.location_label, "Kemang, Jakarta Selatan");
  assert.deepEqual(result.proposal.coordinates, [106.8156, -6.2601]);
  assert.ok(result.proposal.claims.length > 0);
  assert.ok(report.chunks[0]!.text.includes(result.proposal.claims[0]!.quote_text));
});

test("createAiProposalService gracefully falls back to deterministic extraction on remote error", async () => {
  const failingFetch = async () => {
    throw new TypeError("fetch failed: network timeout or ECONNREFUSED");
  };

  const service = createAiProposalService({
    baseUrl: "https://unreachable.gateway.internal/v1",
    apiKey: "dummy-key",
    fetchImpl: failingFetch as typeof fetch,
  });

  const report: StoredReportRevision = {
    report_revision_id: "rev-fallback-01",
    source_id: "antara-metro",
    canonical_url: "https://antaranews.com/berita/fallback-01",
    permitted_text: "Kebakaran melanda pemukiman warga di Senen Jakarta Pusat pada pagi hari.",
    permitted_text_hash: "hash02",
    published_at: "2026-10-27T08:00:00Z",
    retrieved_at: "2026-10-27T08:05:00Z",
    revision_status: "unreviewed",
    chunks: [
      {
        chunk_index: 0,
        text: "Kebakaran melanda pemukiman warga di Senen Jakarta Pusat pada pagi hari.",
        span_start: 0,
        span_end: 72,
      },
    ],
  };

  // Must not throw an unhandled rejection
  const result = await service.extractProposal(report);

  assert.equal(result.used_fallback, true);
  assert.equal(result.provider, "deterministic-fallback");
  assert.ok(result.proposal !== null);
  assert.equal(result.proposal.incident_type, "fire");
  assert.ok(result.proposal.location_label.includes("Senen"));
  assert.ok(result.proposal.coordinates !== null);
  assert.ok(isCoordinateInJakarta(result.proposal.coordinates));
});

test("createAiProposalService returns null proposal for non-incident report", async () => {
  const mockNonIncident = {
    choices: [
      {
        message: {
          content: JSON.stringify({
            incident_type: null,
            severity: "low",
            title: "Berita Politik",
            location_label: "Jakarta",
            coordinates: null,
            event_time: { precision: "unknown", value: "" },
            claims: [],
          }),
        },
      },
    ],
    usage: { prompt_tokens: 100, completion_tokens: 30 },
  };

  const service = createAiProposalService({
    baseUrl: "https://mock.internal/v1",
    apiKey: "key",
    fetchImpl: (async () =>
      new Response(JSON.stringify(mockNonIncident), { status: 200 })) as typeof fetch,
  });

  const report: StoredReportRevision = {
    report_revision_id: "rev-pol-01",
    source_id: "antara-metro",
    canonical_url: "https://antaranews.com/berita/pol-01",
    permitted_text: "Pelantikan pejabat dinas pariwisata DKI Jakarta berlangsung dengan lancar.",
    permitted_text_hash: "hash03",
    published_at: "2026-10-27T08:00:00Z",
    retrieved_at: "2026-10-27T08:05:00Z",
    revision_status: "unreviewed",
    chunks: [
      {
        chunk_index: 0,
        text: "Pelantikan pejabat dinas pariwisata DKI Jakarta berlangsung dengan lancar.",
        span_start: 0,
        span_end: 73,
      },
    ],
  };

  const result = await service.extractProposal(report);
  assert.equal(result.proposal, null);
  assert.equal(result.used_fallback, false);
});

test("runModelBenchmark supports custom scenario subsets and computes metrics accurately", async () => {
  const subset = JAKARTA_BENCHMARK_SCENARIOS.slice(0, 3);
  const summary = await runModelBenchmark({ scenarios: subset });

  assert.equal(summary.total_scenarios, 3);
  assert.equal(summary.scenarios.length, 3);
  assert.ok(summary.latency_ms.avg >= 0);
  assert.ok(summary.citation_faithfulness_rate >= 0.95);
  assert.ok(summary.toponym_accuracy_rate >= 0.95);
});
