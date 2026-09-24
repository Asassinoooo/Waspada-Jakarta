import assert from "node:assert/strict";
import test from "node:test";
import { createModelCapabilityAdapter } from "../src/layers/l2-model-grounding/adapter.js";
import type {
  ClassificationRequest,
  EmbeddingRequest,
  ExtractionRequest,
  GroundingContext,
  ModelAdapterConfiguration,
  ModelCapability,
  ReasoningRequest,
  UntrustedModelProvider,
} from "../src/layers/l2-model-grounding/contracts.js";
import { sha256Text } from "../src/layers/l2-model-grounding/validation.js";

const reportText = "🚨 Banjir menggenangi Jalan Merdeka.";
const retrievedAt = "2026-09-25T08:00:00+07:00";

async function makeReport(text = reportText) {
  return {
    reportRevisionId: "report-r1",
    permittedTextHash: await sha256Text(text),
    normalizationVersion: "normalize-v1",
    permittedText: text,
  };
}

async function referenceFor(
  reportRevisionId: string,
  text: string,
  relation: "supports" | "contradicts" | "updates" | "context",
) {
  return {
    reportRevisionId,
    permittedTextHash: await sha256Text(text),
    spanStart: 0,
    spanEnd: Array.from(text).length,
    offsetUnit: "unicode_code_points" as const,
    relation,
  };
}

function providerEnvelope(output: unknown) {
  return { output, usage: { inputTokens: 18, outputTokens: 7 } };
}

const baseIdentity = { provider: "scripted", modelVersion: "unit-v1", promptVersion: "prompt-v1" };
const configuration: ModelAdapterConfiguration = {
  classification: baseIdentity,
  extraction: baseIdentity,
  embedding: {
    provider: "scripted",
    modelVersion: "embed-v1",
    dimensions: 3,
    distanceMetric: "cosine",
    vectorIndexVersion: "index-v1",
  },
  reasoning: baseIdentity,
};

/** Test-only scripted double. It is defined in test code and not imported by production. */
class ScriptedModelProviderDoubleForTests implements UntrustedModelProvider {
  readonly calls: Record<ModelCapability, number> = {
    classification: 0,
    extraction: 0,
    embedding: 0,
    reasoning: 0,
  };

  constructor(private readonly replies: Partial<Record<ModelCapability, unknown>>) {}

  private reply(capability: ModelCapability): unknown {
    this.calls[capability] += 1;
    const value = this.replies[capability];
    if (value instanceof Error) throw value;
    return value;
  }

  async classify(_request: ClassificationRequest): Promise<unknown> {
    return this.reply("classification");
  }

  async extract(_request: ExtractionRequest): Promise<unknown> {
    return this.reply("extraction");
  }

  async embed(_request: EmbeddingRequest): Promise<unknown> {
    return this.reply("embedding");
  }

  async reason(_request: ReasoningRequest): Promise<unknown> {
    return this.reply("reasoning");
  }
}

async function makeGroundingContext(): Promise<GroundingContext> {
  const supportingText = "🚧 Jalan ditutup oleh petugas.";
  const contraryText = "Jalan dibuka kembali pukul 08.00.";
  const support = await referenceFor("report-support", supportingText, "supports");
  const contradiction = await referenceFor("report-contrary", contraryText, "contradicts");
  return {
    schemaVersion: "2.0",
    recordType: "GroundingContext",
    datasetKind: "synthetic",
    traceId: "trace-rag-1",
    contextId: "context-v1",
    candidateId: "candidate-1",
    evidence: [
      {
        reference: support,
        text: supportingText,
        sourceId: "source-authority",
        revisionStatus: "eligible",
        publishedAt: "2026-09-25T07:50:00+07:00",
        observedAt: "2026-09-25T07:49:00+07:00",
        retrievedAt,
        origins: [{ originId: "origin-a", independenceStatus: "established", dependsOnOriginIds: [] }],
      },
      {
        reference: contradiction,
        text: contraryText,
        sourceId: "source-operator",
        revisionStatus: "eligible",
        publishedAt: null,
        observedAt: "2026-09-25T07:55:00+07:00",
        retrievedAt,
        origins: [{ originId: "origin-b", independenceStatus: "unknown", dependsOnOriginIds: [] }],
      },
    ],
    revisionStates: [
      { reportRevisionId: "report-support", revisionStatus: "eligible" },
      { reportRevisionId: "report-contrary", revisionStatus: "eligible" },
    ],
    candidateEvents: [{ eventId: "event-1", eventVersion: 4 }],
    priorDecisionIds: ["decision-1"],
    missingFields: ["reopening_confirmation"],
    conflicts: ["road_status"],
    retrievalVersion: "retrieve-v2",
    indexVersion: "index-v1",
    sufficient: false,
  };
}

test("an absent provider returns a not-configured result instead of mock success", async () => {
  const adapter = createModelCapabilityAdapter();
  const outcome = await adapter.classify({ data: { report: await makeReport() } });
  assert.deepEqual(outcome, {
    status: "not_configured",
    capability: "classification",
    reason: "provider_not_configured",
  });
});

test("classification validates report hash and Unicode code-point evidence", async () => {
  const report = await makeReport();
  const reference = await referenceFor(report.reportRevisionId, report.permittedText, "supports");
  const provider = new ScriptedModelProviderDoubleForTests({
    classification: providerEnvelope({
      category: "disasters_weather",
      evidence: [reference],
      unknownFields: [],
    }),
  });
  const adapter = createModelCapabilityAdapter(provider, configuration);
  const good = await adapter.classify({ data: { report } });
  assert.equal(good.status, "succeeded");
  if (good.status !== "succeeded") return;
  assert.equal(good.value.evidence[0]?.spanEnd, Array.from(report.permittedText).length);
  assert.equal(good.value.invocation.inputTokens, 18);

  const tooLongReference = { ...reference, spanEnd: reference.spanEnd + 1 };
  const invalidProvider = new ScriptedModelProviderDoubleForTests({
    classification: providerEnvelope({ category: "disasters_weather", evidence: [tooLongReference], unknownFields: [] }),
  });
  const invalid = await createModelCapabilityAdapter(invalidProvider, configuration).classify({ data: { report } });
  assert.equal(invalid.status, "invalid_output");

  const badHash = { ...report, permittedTextHash: "0".repeat(64) };
  const requestProvider = new ScriptedModelProviderDoubleForTests({ classification: providerEnvelope({}) });
  const badRequest = await createModelCapabilityAdapter(requestProvider, configuration).classify({ data: { report: badHash } });
  assert.equal(badRequest.status, "invalid_request");
  assert.equal(requestProvider.calls.classification, 0);

  const throwingProvider = new ScriptedModelProviderDoubleForTests({ classification: new Error("provider unavailable") });
  const failed = await createModelCapabilityAdapter(throwingProvider, configuration).classify({ data: { report } });
  assert.deepEqual(failed, { status: "provider_error", capability: "classification" });
});

test("extractor rejects extra fields and invalid time precision", async () => {
  const report = await makeReport();
  const support = await referenceFor(report.reportRevisionId, report.permittedText, "supports");
  const request: ExtractionRequest = { data: { candidateId: "candidate-1", report } };
  const baseOutput = {
    category: "disasters_weather",
    tags: [{ namespace: "hazard", value: "flood" }],
    eventTime: { start: "2026-09-25", end: null, precision: "date" },
    scope: { placeIds: ["place-merdeka"], serviceIds: [], institutionIds: [], audienceIds: [], geometryIds: [] },
    evidence: [support],
    unknownFields: [],
  };
  const validProvider = new ScriptedModelProviderDoubleForTests({ extraction: providerEnvelope(baseOutput) });
  const valid = await createModelCapabilityAdapter(validProvider, configuration).extract(request);
  assert.equal(valid.status, "succeeded");
  if (valid.status === "succeeded") assert.equal(valid.value.modelRun.capability, "extraction");

  const extraProvider = new ScriptedModelProviderDoubleForTests({
    extraction: providerEnvelope({ ...baseOutput, publish: true }),
  });
  const extra = await createModelCapabilityAdapter(extraProvider, configuration).extract(request);
  assert.equal(extra.status, "invalid_output");

  const { unknownFields: _unknownFields, ...missingFieldOutput } = baseOutput;
  const missingProvider = new ScriptedModelProviderDoubleForTests({ extraction: providerEnvelope(missingFieldOutput) });
  const missing = await createModelCapabilityAdapter(missingProvider, configuration).extract(request);
  assert.equal(missing.status, "invalid_output");

  const badTimeProvider = new ScriptedModelProviderDoubleForTests({
    extraction: providerEnvelope({ ...baseOutput, eventTime: { start: "2026-09-25T08:00:00+07:00", end: null, precision: "date" } }),
  });
  const badTime = await createModelCapabilityAdapter(badTimeProvider, configuration).extract(request);
  assert.equal(badTime.status, "invalid_output");
});

test("reasoning can cite only exact retrieved context and retains contrary evidence", async () => {
  const groundingContext = await makeGroundingContext();
  const support = groundingContext.evidence[0]!.reference;
  const contradiction = groundingContext.evidence[1]!.reference;
  const claim = {
    text: "Akses jalan terganggu, tetapi status pembukaan masih diperselisihkan.",
    eventTime: { start: null, end: null, precision: "unknown" },
    validity: { validFrom: null, validUntil: null },
    scope: { placeIds: ["place-merdeka"], serviceIds: [], institutionIds: [], audienceIds: [], geometryIds: [] },
    qualifiers: ["status disputed"],
    support: [support],
    contradictions: [contradiction],
    contextEvidence: [],
    supportAssessment: "disputed",
  };
  const provider = new ScriptedModelProviderDoubleForTests({
    reasoning: providerEnvelope({ outcome: "proposed", claims: [claim], unresolvedFields: ["reopening_confirmation"] }),
  });
  const result = await createModelCapabilityAdapter(provider, configuration).reason({ data: { groundingContext } });
  assert.equal(result.status, "succeeded");
  if (result.status === "succeeded") {
    assert.equal(result.value.claims[0]?.contradictions.length, 1);
    assert.equal(result.value.claims[0]?.supportAssessment, "disputed");
    assert.equal(result.value.provider, "scripted");
    assert.deepEqual(result.value.unresolvedFields, ["reopening_confirmation"]);
    assert.deepEqual(result.value.conflicts, groundingContext.conflicts);
  }

  const invented = { ...support, spanStart: support.spanStart + 1, spanEnd: support.spanEnd };
  const inventedProvider = new ScriptedModelProviderDoubleForTests({
    reasoning: providerEnvelope({ outcome: "proposed", claims: [{ ...claim, support: [invented] }], unresolvedFields: [] }),
  });
  const invalid = await createModelCapabilityAdapter(inventedProvider, configuration).reason({ data: { groundingContext } });
  assert.equal(invalid.status, "invalid_output");

  const overconfidentProvider = new ScriptedModelProviderDoubleForTests({
    reasoning: providerEnvelope({ outcome: "proposed", claims: [{ ...claim, supportAssessment: "supported" }], unresolvedFields: [] }),
  });
  const overconfident = await createModelCapabilityAdapter(overconfidentProvider, configuration).reason({ data: { groundingContext } });
  assert.equal(overconfident.status, "invalid_output");

  const oversizedProvider = new ScriptedModelProviderDoubleForTests({
    reasoning: providerEnvelope({ outcome: "proposed", claims: [{ ...claim, text: "x".repeat(4_001) }], unresolvedFields: [] }),
  });
  const oversized = await createModelCapabilityAdapter(oversizedProvider, configuration).reason({ data: { groundingContext } });
  assert.equal(oversized.status, "invalid_output");
});

test("embedding validates finite vector dimensions and binds result to chunk lineage", async () => {
  const text = "🚨 Road closure";
  const request: EmbeddingRequest = {
    data: {
      chunk: {
        chunkId: "chunk-1",
        reportRevisionId: "report-r1",
        permittedTextHash: "a".repeat(64),
        normalizationVersion: "normalize-v1",
        spanStart: 10,
        spanEnd: 10 + Array.from(text).length,
        offsetUnit: "unicode_code_points",
        chunkTextHash: await sha256Text(text),
        text,
      },
    },
  };
  const successProvider = new ScriptedModelProviderDoubleForTests({ embedding: { vector: [0.1, -0.2, 0.3] } });
  const success = await createModelCapabilityAdapter(successProvider, configuration).embed(request);
  assert.equal(success.status, "succeeded");
  if (success.status === "succeeded") {
    assert.equal(success.value.chunkId, "chunk-1");
    assert.equal(success.value.inputTextHash, request.data.chunk.chunkTextHash);
    assert.equal(success.value.dimensions, success.value.vector.length);
    assert.equal("modelRun" in success.value, false);
  }

  const badProvider = new ScriptedModelProviderDoubleForTests({ embedding: { vector: [0.1, Number.NaN, 0.3] } });
  const bad = await createModelCapabilityAdapter(badProvider, configuration).embed(request);
  assert.equal(bad.status, "invalid_output");

  const wrongDimensionProvider = new ScriptedModelProviderDoubleForTests({ embedding: { vector: [0.1, 0.2] } });
  const wrongDimension = await createModelCapabilityAdapter(wrongDimensionProvider, configuration).embed(request);
  assert.equal(wrongDimension.status, "invalid_output");
});
