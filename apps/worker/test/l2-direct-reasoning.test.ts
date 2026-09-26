import assert from "node:assert/strict";
import test from "node:test";
import type {
  GroundingContextRecord,
  GroundingContextRepository,
} from "../../db/src/grounding-contexts.js";
import {
  createModelCapabilityAdapter,
} from "../src/layers/l2-model-grounding/adapter.js";
import type {
  CapabilityOutcome,
  ModelCapabilityAdapter,
  ModelIdentity,
  ReasoningRequest,
  ReasoningResult,
  UntrustedModelProvider,
} from "../src/layers/l2-model-grounding/contracts.js";
import {
  createReasoningContextPersister,
  type ReasoningContextPersister,
} from "../src/layers/l2-model-grounding/context-persistence.js";
import { createDirectReasoningService } from "../src/layers/l2-model-grounding/direct-reasoning.js";
import {
  L2_DIRECT_REASONING_EVENT_NAME,
  consoleTelemetry,
  type TelemetryRecord,
} from "../src/layers/l5-evaluation-monitoring/telemetry.js";
import { ContractValidationError } from "../src/layers/l2-model-grounding/validation.js";

const supportingText = "synthetic support";
const testIdentity: ModelIdentity = {
  provider: "scripted-test-provider",
  modelVersion: "synthetic-model-v1",
  promptVersion: "synthetic-prompt-v1",
};

function reasoningRequest(sufficient: boolean) {
  return {
    data: {
      groundingContext: {
        schemaVersion: "2.0",
        recordType: "GroundingContext",
        datasetKind: "synthetic",
        traceId: "trace-synthetic-direct",
        contextId: "context-synthetic-direct",
        candidateId: "candidate-synthetic-direct",
        evidence: [
          {
            reference: {
              reportRevisionId: "revision-synthetic-direct",
              permittedTextHash: "a".repeat(64),
              spanStart: 0,
              spanEnd: Array.from(supportingText).length,
              offsetUnit: "unicode_code_points",
              relation: "supports",
            },
            text: supportingText,
            sourceId: "source-synthetic-direct",
            revisionStatus: "eligible",
            publishedAt: "2026-09-25T10:00:00Z",
            observedAt: null,
            retrievedAt: "2026-09-26T05:00:00Z",
            origins: [{
              originId: "origin-synthetic-direct",
              independenceStatus: "established",
              dependsOnOriginIds: [],
            }],
          },
        ],
        revisionStates: [{
          reportRevisionId: "revision-synthetic-direct",
          revisionStatus: "eligible",
        }],
        candidateEvents: [{ eventId: "event-synthetic-direct", eventVersion: 2 }],
        priorDecisionIds: ["decision-synthetic-direct"],
        missingFields: ["service_resume_confirmation"],
        conflicts: ["synthetic reports disagree on service status"],
        retrievalVersion: "synthetic-retrieval-v1",
        indexVersion: "synthetic-index-v1",
        sufficient,
      },
    },
  };
}

function makeRepository(
  onPersist: (record: GroundingContextRecord) => void = () => undefined,
): GroundingContextRepository {
  return {
    async createOrVerify(record) {
      onPersist(record);
      return record;
    },
  };
}

function successfulOutcome(): CapabilityOutcome<ReasoningResult, "reasoning"> {
  return {
    status: "succeeded",
    capability: "reasoning",
    value: {
      outcome: "abstained",
      claims: [],
      unresolvedFields: ["service_resume_confirmation"],
      conflicts: ["synthetic reports disagree on service status"],
      modelRun: {
        capability: "reasoning",
        modelVersion: "synthetic-model-v1",
        promptVersion: "synthetic-prompt-v1",
        inputTokens: 5,
        outputTokens: 2,
      },
      provider: "scripted-test-provider",
    },
  };
}

function adapterForOutcome(
  outcome: CapabilityOutcome<ReasoningResult, "reasoning">,
  onReason: (request: ReasoningRequest) => void = () => undefined,
): Pick<ModelCapabilityAdapter, "reason"> {
  return {
    async reason(request) {
      onReason(request);
      return outcome;
    },
  };
}

test("insufficient caller context persists first and returns the validated request without reasoning", async () => {
  const order: string[] = [];
  const persistedRecords: GroundingContextRecord[] = [];
  let reasonCalls = 0;
  const persister = createReasoningContextPersister(makeRepository((record) => {
    order.push("persist");
    persistedRecords.push(record);
  }));
  const records: TelemetryRecord[] = [];
  const service = createDirectReasoningService(
    persister,
    adapterForOutcome(successfulOutcome(), () => {
      reasonCalls += 1;
      order.push("reason");
    }),
    { record: (record) => records.push(record) },
  );

  const result = await service.reason(reasoningRequest(false));

  assert.equal(result.status, "investigation_required");
  if (result.status !== "investigation_required") assert.fail("expected investigation_required");
  assert.deepEqual(order, ["persist"]);
  assert.equal(reasonCalls, 0);
  assert.equal(persistedRecords.length, 1);
  assert.strictEqual(result.persistedRecord, persistedRecords[0]);
  assert.equal(result.persistedRecord.sufficient, false);
  assert.equal(result.reasoningRequest.data.groundingContext.sufficient, false);
  assert.equal(result.reasoningRequest.data.groundingContext.evidence[0]?.text, supportingText);
  assert.equal(result.reasoningRequest.data.groundingContext.evidence[0]?.origins[0]?.originId, "origin-synthetic-direct");
  assert.equal(JSON.stringify(result.persistedRecord).includes(supportingText), false);
  assert.equal(records.length, 1);
  const telemetryRecord = records[0]!;
  assert.deepEqual(Object.keys(telemetryRecord).sort(), ["durationMs", "eventName", "outcome"]);
  assert.equal(telemetryRecord.eventName, L2_DIRECT_REASONING_EVENT_NAME);
  if (telemetryRecord.eventName !== L2_DIRECT_REASONING_EVENT_NAME) assert.fail("expected L2 reasoning telemetry");
  assert.equal(telemetryRecord.outcome, "investigation_required");
  assert.ok(Number.isFinite(telemetryRecord.durationMs));
  assert.ok(telemetryRecord.durationMs >= 0);
});

test("sufficient context persists before one reason call and returns the exact typed outcome", async () => {
  const order: string[] = [];
  let persistedRequest: ReasoningRequest | undefined;
  const basePersister = createReasoningContextPersister(makeRepository(() => order.push("persist")));
  const persister: ReasoningContextPersister = {
    async persist(request) {
      const result = await basePersister.persist(request);
      persistedRequest = result.reasoningRequest;
      return result;
    },
  };
  let reasonCalls = 0;
  let receivedRequest: ReasoningRequest | undefined;
  const outcome = successfulOutcome();
  const service = createDirectReasoningService(
    persister,
    adapterForOutcome(outcome, (request) => {
      order.push("reason");
      reasonCalls += 1;
      receivedRequest = request;
    }),
  );

  const result = await service.reason(reasoningRequest(true));

  assert.deepEqual(order, ["persist", "reason"]);
  assert.equal(reasonCalls, 1);
  assert.strictEqual(receivedRequest, persistedRequest);
  assert.strictEqual(result, outcome);
});

test("explicit capability outcomes pass through without rewriting", async () => {
  const outcomes: CapabilityOutcome<ReasoningResult, "reasoning">[] = [
    { status: "not_configured", capability: "reasoning", reason: "provider_not_configured" },
    { status: "provider_error", capability: "reasoning" },
    { status: "invalid_output", capability: "reasoning", reason: "synthetic_invalid_output" },
    { status: "invalid_request", capability: "reasoning", reason: "synthetic_invalid_request" },
    successfulOutcome(),
  ];

  for (const outcome of outcomes) {
    const order: string[] = [];
    let reasonCalls = 0;
    const service = createDirectReasoningService(
      createReasoningContextPersister(makeRepository(() => order.push("persist"))),
      adapterForOutcome(outcome, () => {
        order.push("reason");
        reasonCalls += 1;
      }),
    );

    const result = await service.reason(reasoningRequest(true));

    assert.strictEqual(result, outcome);
    assert.equal(reasonCalls, 1);
    assert.deepEqual(order, ["persist", "reason"]);
  }
});

test("the real adapter keeps scripted provider error and invalid-output states typed", async () => {
  const cases: Array<{
    reply: unknown;
    expected: "provider_error" | "invalid_output";
  }> = [
    { reply: new Error("synthetic provider failure"), expected: "provider_error" },
    { reply: { output: { unexpected: "synthetic invalid output" }, usage: { inputTokens: 1, outputTokens: 1 } }, expected: "invalid_output" },
  ];

  for (const { reply, expected } of cases) {
    const order: string[] = [];
    const provider = new ScriptedReasoningProviderDoubleForTests(reply, order);
    const adapter = createModelCapabilityAdapter(provider, { reasoning: testIdentity });
    let adapterCalls = 0;
    const service = createDirectReasoningService(
      createReasoningContextPersister(makeRepository(() => order.push("persist"))),
      {
        async reason(request) {
          adapterCalls += 1;
          order.push("reason");
          return adapter.reason(request);
        },
      },
    );

    const result = await service.reason(reasoningRequest(true));

    assert.equal(result.status, expected);
    assert.equal(adapterCalls, 1);
    assert.equal(provider.reasonCalls, 1);
    assert.deepEqual(order, ["persist", "reason", "provider"]);
  }
});

test("validation and persistence errors prevent reasoning and preserve error identity", async () => {
  let repositoryCalls = 0;
  let reasonCalls = 0;
  let validationError: unknown;
  const validatingPersister = createReasoningContextPersister(makeRepository(() => {
    repositoryCalls += 1;
  }));
  const observedValidatingPersister: ReasoningContextPersister = {
    async persist(request) {
      try {
        return await validatingPersister.persist(request);
      } catch (error) {
        validationError = error;
        throw error;
      }
    },
  };
  const service = createDirectReasoningService(
    observedValidatingPersister,
    adapterForOutcome(successfulOutcome(), () => reasonCalls++),
  );

  await assert.rejects(service.reason({ invalid: "synthetic request" }), (error: unknown) => {
    assert.ok(error instanceof ContractValidationError);
    assert.strictEqual(error, validationError);
    return true;
  });
  assert.equal(repositoryCalls, 0);
  assert.equal(reasonCalls, 0);

  const persistenceError = new Error("synthetic persistence failure");
  const failingPersister = createReasoningContextPersister({
    async createOrVerify() {
      throw persistenceError;
    },
  });
  const persistenceService = createDirectReasoningService(
    failingPersister,
    adapterForOutcome(successfulOutcome(), () => reasonCalls++),
  );

  await assert.rejects(persistenceService.reason(reasoningRequest(true)), (error: unknown) => {
    assert.strictEqual(error, persistenceError);
    return true;
  });
  assert.equal(reasonCalls, 0);
});

test("telemetry sink failures cannot mask results or original errors", async () => {
  const sinkFailure = new Error("synthetic telemetry sink failure");
  const failingSink = { record() { throw sinkFailure; } };
  const outcome: CapabilityOutcome<ReasoningResult, "reasoning"> = {
    status: "not_configured",
    capability: "reasoning",
    reason: "provider_not_configured",
  };
  const service = createDirectReasoningService(
    createReasoningContextPersister(makeRepository()),
    adapterForOutcome(outcome),
    failingSink,
  );

  assert.strictEqual(await service.reason(reasoningRequest(true)), outcome);

  const originalError = new Error("synthetic original failure");
  const errorService = createDirectReasoningService(
    { async persist() { throw originalError; } },
    adapterForOutcome(successfulOutcome()),
    failingSink,
  );
  await assert.rejects(errorService.reason(reasoningRequest(true)), (error: unknown) => {
    assert.strictEqual(error, originalError);
    return true;
  });
});

test("the default telemetry sink is silent", async () => {
  const writes: unknown[] = [];
  const originalLog = console.log;
  console.log = (...messages: unknown[]) => writes.push(...messages);
  try {
    const service = createDirectReasoningService(
      createReasoningContextPersister(makeRepository()),
      adapterForOutcome(successfulOutcome()),
    );
    await service.reason(reasoningRequest(false));
  } finally {
    console.log = originalLog;
  }

  assert.deepEqual(writes, []);
});

test("console telemetry accepts only the closed direct-reasoning allowlist", () => {
  const writes: unknown[] = [];
  const originalLog = console.log;
  console.log = (...messages: unknown[]) => writes.push(...messages);
  try {
    consoleTelemetry.record({
      eventName: L2_DIRECT_REASONING_EVENT_NAME,
      outcome: "provider_error",
      durationMs: 12.5,
      traceId: "trace-secret-marker",
      prompt: "prompt-secret-marker",
      provider: "provider-secret-marker",
      evidenceText: "evidence-secret-marker",
    } as TelemetryRecord);
    consoleTelemetry.record({
      eventName: L2_DIRECT_REASONING_EVENT_NAME,
      outcome: "private-outcome",
      durationMs: 1,
    } as unknown as TelemetryRecord);
    consoleTelemetry.record({
      eventName: L2_DIRECT_REASONING_EVENT_NAME,
      outcome: "succeeded",
      durationMs: Number.POSITIVE_INFINITY,
    } as TelemetryRecord);
  } finally {
    console.log = originalLog;
  }

  assert.deepEqual(writes, [{
    event_name: L2_DIRECT_REASONING_EVENT_NAME,
    outcome: "provider_error",
    duration_ms: 12.5,
  }]);
  assert.ok(!JSON.stringify(writes).includes("secret-marker"));
});

test("the scripted provider double is test-only and returns an abstention envelope", async () => {
  const order: string[] = [];
  const provider = new ScriptedReasoningProviderDoubleForTests({
    output: { outcome: "abstained", claims: [], unresolvedFields: [] },
    usage: { inputTokens: 5, outputTokens: 2 },
  }, order);
  const adapter = createModelCapabilityAdapter(provider, { reasoning: testIdentity });
  const service = createDirectReasoningService(
    createReasoningContextPersister(makeRepository(() => order.push("persist"))),
    { reason: (request) => adapter.reason(request) },
  );

  const result = await service.reason(reasoningRequest(true));

  assert.equal(result.status, "succeeded");
  assert.equal(provider.reasonCalls, 1);
  assert.deepEqual(order, ["persist", "provider"]);
  if (result.status !== "succeeded") assert.fail("expected typed success");
  assert.equal(result.value.outcome, "abstained");
  assert.deepEqual(result.value.unresolvedFields, ["service_resume_confirmation"]);
});

class ScriptedReasoningProviderDoubleForTests implements UntrustedModelProvider {
  reasonCalls = 0;

  constructor(private readonly reply: unknown, private readonly order: string[] = []) {}

  async classify(_request: Parameters<UntrustedModelProvider["classify"]>[0]): Promise<unknown> {
    throw new Error("unexpected synthetic classification call");
  }

  async extract(_request: Parameters<UntrustedModelProvider["extract"]>[0]): Promise<unknown> {
    throw new Error("unexpected synthetic extraction call");
  }

  async embed(_request: Parameters<UntrustedModelProvider["embed"]>[0]): Promise<unknown> {
    throw new Error("unexpected synthetic embedding call");
  }

  async reason(_request: ReasoningRequest): Promise<unknown> {
    this.reasonCalls += 1;
    this.order.push("provider");
    if (this.reply instanceof Error) throw this.reply;
    return this.reply;
  }
}
