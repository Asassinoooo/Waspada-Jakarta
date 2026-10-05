import assert from "node:assert/strict";
import test from "node:test";
import {
  EmbeddingRunRepositoryError,
  type EmbeddingRunRecord,
  type EmbeddingRunRepository,
} from "../../db/src/embedding-runs.js";
import { createModelCapabilityAdapter } from "../src/layers/l2-model-grounding/adapter.js";
import type {
  ClassificationRequest,
  EmbeddingRequest,
  ExtractionRequest,
  ModelCapability,
  ReasoningRequest,
  UntrustedModelProvider,
} from "../src/layers/l2-model-grounding/contracts.js";
import { sha256Text } from "../src/layers/l2-model-grounding/validation.js";
import {
  createEmbeddingGenerationRunner,
  type EmbeddingGenerationRequest,
} from "../src/layers/l1-data-knowledge/embedding-generation.js";

const embeddingConfiguration = {
  embedding: {
    provider: "synthetic-test-only",
    modelVersion: "embedding-fixture-v1",
    dimensions: 2,
    distanceMetric: "cosine" as const,
    vectorIndexVersion: "embedding-index-fixture-v1",
  },
};

class DeterministicEmbeddingProviderDoubleForTests implements UntrustedModelProvider {
  readonly calls: Record<ModelCapability, number> = {
    classification: 0,
    extraction: 0,
    embedding: 0,
    reasoning: 0,
  };
  readonly embeddingRequests: EmbeddingRequest[] = [];

  constructor(private readonly response: unknown) {}

  async classify(_request: ClassificationRequest): Promise<unknown> {
    this.calls.classification += 1;
    return {};
  }

  async extract(_request: ExtractionRequest): Promise<unknown> {
    this.calls.extraction += 1;
    return {};
  }

  async embed(request: EmbeddingRequest): Promise<unknown> {
    this.calls.embedding += 1;
    this.embeddingRequests.push(request);
    if (this.response instanceof Error) throw this.response;
    return this.response;
  }

  async reason(_request: ReasoningRequest): Promise<unknown> {
    this.calls.reasoning += 1;
    return {};
  }
}

async function makeRequest(): Promise<EmbeddingGenerationRequest> {
  const text = "Synthetic closure report near Monas 😀.";
  return {
    datasetKind: "synthetic",
    traceId: "trace-embedding-generation",
    embeddingRunId: "run-embedding-generation",
    createdAt: "2026-10-01T08:00:00.123456+07:00",
    chunk: {
      chunkId: "chunk-embedding-generation",
      reportRevisionId: "revision-embedding-generation",
      permittedTextHash: await sha256Text(text),
      normalizationVersion: "normalization-v1",
      spanStart: 0,
      spanEnd: Array.from(text).length,
      offsetUnit: "unicode_code_points",
      chunkTextHash: await sha256Text(text),
      text,
      chunkerVersion: "chunker-generation-v1",
    },
  };
}

function successfulAdapter(vector: readonly number[], events: string[] = []) {
  const provider = new DeterministicEmbeddingProviderDoubleForTests({ vector: [...vector] });
  const adapter = createModelCapabilityAdapter({
    classify: async () => ({}),
    extract: async () => ({}),
    embed: async (request) => {
      events.push("provider");
      return provider.embed(request);
    },
    reason: async () => ({}),
  }, embeddingConfiguration);
  return { adapter, provider };
}

function repositoryDouble(
  result: "created" | "replayed" | "unavailable" = "created",
  events: string[] = [],
): { readonly repository: EmbeddingRunRepository; readonly writes: Array<{ record: EmbeddingRunRecord; vector: readonly number[] }> } {
  const writes: Array<{ record: EmbeddingRunRecord; vector: readonly number[] }> = [];
  return {
    writes,
    repository: {
      async createOrVerify(record, vector) {
        events.push("persistence");
        writes.push({ record, vector: [...vector] });
        return result;
      },
    },
  };
}

test("projects one exact L2 chunk, calls the adapter before L1 persistence, and writes caller retry identity", async () => {
  const request = await makeRequest();
  const events: string[] = [];
  const { adapter, provider } = successfulAdapter([0.6, 0.8], events);
  const { repository, writes } = repositoryDouble("created", events);
  const run = createEmbeddingGenerationRunner({ modelAdapter: adapter, embeddingRuns: repository });

  assert.deepEqual(await run(request), { status: "created" });
  assert.deepEqual(events, ["provider", "persistence"]);
  assert.equal(provider.calls.embedding, 1);
  assert.deepEqual(provider.embeddingRequests, [{
    data: {
      chunk: {
        chunkId: request.chunk.chunkId,
        reportRevisionId: request.chunk.reportRevisionId,
        permittedTextHash: request.chunk.permittedTextHash,
        normalizationVersion: request.chunk.normalizationVersion,
        spanStart: request.chunk.spanStart,
        spanEnd: request.chunk.spanEnd,
        offsetUnit: request.chunk.offsetUnit,
        chunkTextHash: request.chunk.chunkTextHash,
        text: request.chunk.text,
      },
    },
  }]);
  assert.deepEqual(writes, [{
    record: {
      schema_version: "2.0",
      trace_id: request.traceId,
      record_type: "EmbeddingRun",
      dataset_kind: request.datasetKind,
      embedding_run_id: request.embeddingRunId,
      chunk_id: request.chunk.chunkId,
      capability: "embedding",
      provider: "synthetic-test-only",
      model_version: "embedding-fixture-v1",
      dimensions: 2,
      distance_metric: "cosine",
      vector_index_version: "embedding-index-fixture-v1",
      input_text_hash: request.chunk.chunkTextHash,
      status: "available",
      created_at: request.createdAt,
    },
    vector: [0.6, 0.8],
  }]);
});

test("rejects invalid run identity before the adapter and preserves adapter failures without writes", async () => {
  const request = await makeRequest();
  const invalidIdentityProvider = new DeterministicEmbeddingProviderDoubleForTests({ vector: [0.6, 0.8] });
  const invalidIdentityRun = createEmbeddingGenerationRunner({
    modelAdapter: createModelCapabilityAdapter(invalidIdentityProvider, embeddingConfiguration),
    embeddingRuns: repositoryDouble().repository,
  });
  assert.deepEqual(await invalidIdentityRun({ ...request, createdAt: "2026-02-30T08:00:00Z" }), {
    status: "invalid_request",
  });
  assert.equal(invalidIdentityProvider.calls.embedding, 0);

  const invalidChunkProvider = new DeterministicEmbeddingProviderDoubleForTests({ vector: [0.6, 0.8] });
  const invalidChunkRepository = repositoryDouble();
  const invalidChunkRun = createEmbeddingGenerationRunner({
    modelAdapter: createModelCapabilityAdapter(invalidChunkProvider, embeddingConfiguration),
    embeddingRuns: invalidChunkRepository.repository,
  });
  assert.deepEqual(await invalidChunkRun({
    ...request,
    chunk: { ...request.chunk, chunkTextHash: "0".repeat(64) },
  }), { status: "invalid_request" });
  assert.equal(invalidChunkProvider.calls.embedding, 0);
  assert.equal(invalidChunkRepository.writes.length, 0);

  const absentProviderRepository = repositoryDouble();
  const absentProviderRun = createEmbeddingGenerationRunner({
    modelAdapter: createModelCapabilityAdapter(),
    embeddingRuns: absentProviderRepository.repository,
  });
  assert.deepEqual(await absentProviderRun(request), {
    status: "not_configured",
    reason: "provider_not_configured",
  });
  assert.equal(absentProviderRepository.writes.length, 0);

  const providerError = new DeterministicEmbeddingProviderDoubleForTests(new Error("private provider details"));
  const providerErrorRepository = repositoryDouble();
  const providerErrorRun = createEmbeddingGenerationRunner({
    modelAdapter: createModelCapabilityAdapter(providerError, embeddingConfiguration),
    embeddingRuns: providerErrorRepository.repository,
  });
  assert.deepEqual(await providerErrorRun(request), { status: "provider_error" });
  assert.equal(providerErrorRepository.writes.length, 0);

  const invalidOutput = new DeterministicEmbeddingProviderDoubleForTests({ vector: [0.6] });
  const invalidOutputRepository = repositoryDouble();
  const invalidOutputRun = createEmbeddingGenerationRunner({
    modelAdapter: createModelCapabilityAdapter(invalidOutput, embeddingConfiguration),
    embeddingRuns: invalidOutputRepository.repository,
  });
  assert.deepEqual(await invalidOutputRun(request), { status: "invalid_output" });
  assert.equal(invalidOutputRepository.writes.length, 0);
});

test("maps repository replay, unavailable, conflict, and fixed errors to closed results", async () => {
  const request = await makeRequest();
  const { adapter } = successfulAdapter([0.6, 0.8]);
  for (const [repoOutcome, expected] of [
    ["replayed", { status: "replayed" }],
    ["unavailable", { status: "unavailable" }],
  ] as const) {
    const run = createEmbeddingGenerationRunner({
      modelAdapter: adapter,
      embeddingRuns: repositoryDouble(repoOutcome).repository,
    });
    assert.deepEqual(await run(request), expected);
  }

  const failures = [
    ["embedding_run_conflict", { status: "conflict" }],
    ["embedding_run_integrity_error", { status: "persistence_error", reason: "integrity_error" }],
    ["embedding_run_persistence_failed", { status: "persistence_error", reason: "persistence_failed" }],
  ] as const;
  for (const [code, expected] of failures) {
    const repository: EmbeddingRunRepository = {
      async createOrVerify() {
        throw new EmbeddingRunRepositoryError(code);
      },
    };
    const run = createEmbeddingGenerationRunner({ modelAdapter: adapter, embeddingRuns: repository });
    assert.deepEqual(await run(request), expected);
  }
});
