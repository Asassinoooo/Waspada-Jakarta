import assert from "node:assert/strict";
import { it } from "node:test";
import {
  GroundingContextConflictError,
  GroundingContextReferenceError,
  GroundingContextValidationError,
  type GroundingContextRecord,
  type GroundingContextRepository,
} from "../../db/src/grounding-contexts.js";
import {
  ContractValidationError,
  validateReasoningRequest,
} from "../src/layers/l2-model-grounding/validation.js";
import { createReasoningContextPersister } from "../src/layers/l2-model-grounding/context-persistence.js";

function reasoningRequest(sufficient: boolean) {
  return {
    data: {
      groundingContext: {
        schemaVersion: "2.0",
        recordType: "GroundingContext",
        datasetKind: "synthetic",
        traceId: "trace-synthetic-bridge",
        contextId: "context-synthetic-bridge",
        candidateId: "candidate-synthetic-bridge",
        evidence: [
          {
            reference: {
              reportRevisionId: "revision-synthetic-primary",
              permittedTextHash: "a".repeat(64),
              spanStart: 0,
              spanEnd: 10,
              offsetUnit: "unicode_code_points",
              relation: "supports",
            },
            text: "supporting",
            sourceId: "source-synthetic-primary",
            revisionStatus: "eligible",
            publishedAt: "2026-09-25T10:00:00Z",
            observedAt: null,
            retrievedAt: "2026-09-26T05:00:00Z",
            origins: [{
              originId: "origin-synthetic-primary",
              independenceStatus: "established",
              dependsOnOriginIds: [],
            }],
          },
          {
            reference: {
              reportRevisionId: "revision-synthetic-primary",
              permittedTextHash: "a".repeat(64),
              spanStart: 10,
              spanEnd: 19,
              offsetUnit: "unicode_code_points",
              relation: "contradicts",
            },
            text: "different",
            sourceId: "source-synthetic-contrary",
            revisionStatus: "eligible",
            publishedAt: null,
            observedAt: "2026-09-25T10:02:03Z",
            retrievedAt: "2026-09-26T05:00:00Z",
            origins: [{
              originId: "origin-synthetic-copy",
              independenceStatus: "dependent",
              dependsOnOriginIds: ["origin-synthetic-primary"],
            }],
          },
          {
            reference: {
              reportRevisionId: "revision-synthetic-secondary",
              permittedTextHash: "b".repeat(64),
              spanStart: 0,
              spanEnd: 9,
              offsetUnit: "unicode_code_points",
              relation: "updates",
            },
            text: "refreshed",
            sourceId: "source-synthetic-update",
            revisionStatus: "quarantined",
            publishedAt: null,
            observedAt: null,
            retrievedAt: "2026-09-26T05:00:00Z",
            origins: [{
              originId: "origin-synthetic-update",
              independenceStatus: "unknown",
              dependsOnOriginIds: [],
            }],
          },
          {
            reference: {
              reportRevisionId: "revision-synthetic-secondary",
              permittedTextHash: "b".repeat(64),
              spanStart: 9,
              spanEnd: 19,
              offsetUnit: "unicode_code_points",
              relation: "context",
            },
            text: "background",
            sourceId: "source-synthetic-context",
            revisionStatus: "quarantined",
            publishedAt: "2026-09-24T08:30:00Z",
            observedAt: null,
            retrievedAt: "2026-09-26T05:00:00Z",
            origins: [{
              originId: "origin-synthetic-context",
              independenceStatus: "established",
              dependsOnOriginIds: [],
            }],
          },
        ],
        revisionStates: [
          { reportRevisionId: "revision-synthetic-primary", revisionStatus: "eligible" },
          { reportRevisionId: "revision-synthetic-secondary", revisionStatus: "quarantined" },
        ],
        candidateEvents: [
          { eventId: "event-synthetic-one", eventVersion: 4 },
          { eventId: "event-synthetic-two", eventVersion: 1 },
        ],
        priorDecisionIds: ["decision-synthetic-one", "decision-synthetic-two"],
        missingFields: ["service_resume_confirmation"],
        conflicts: ["synthetic reports disagree on current service status"],
        retrievalVersion: "hybrid-retrieval-v2",
        indexVersion: "synthetic-index-v4",
        sufficient,
      },
    },
  };
}

function expectedRecord(sufficient: boolean): GroundingContextRecord {
  return {
    schema_version: "2.0",
    trace_id: "trace-synthetic-bridge",
    record_type: "GroundingContext",
    dataset_kind: "synthetic",
    context_id: "context-synthetic-bridge",
    candidate_id: "candidate-synthetic-bridge",
    evidence: [
      {
        report_revision_id: "revision-synthetic-primary",
        permitted_text_hash: "a".repeat(64),
        span_start: 0,
        span_end: 10,
        offset_unit: "unicode_code_points",
        relation: "supports",
      },
      {
        report_revision_id: "revision-synthetic-primary",
        permitted_text_hash: "a".repeat(64),
        span_start: 10,
        span_end: 19,
        offset_unit: "unicode_code_points",
        relation: "contradicts",
      },
      {
        report_revision_id: "revision-synthetic-secondary",
        permitted_text_hash: "b".repeat(64),
        span_start: 0,
        span_end: 9,
        offset_unit: "unicode_code_points",
        relation: "updates",
      },
      {
        report_revision_id: "revision-synthetic-secondary",
        permitted_text_hash: "b".repeat(64),
        span_start: 9,
        span_end: 19,
        offset_unit: "unicode_code_points",
        relation: "context",
      },
    ],
    revision_states: [
      { report_revision_id: "revision-synthetic-primary", revision_status: "eligible" },
      { report_revision_id: "revision-synthetic-secondary", revision_status: "quarantined" },
    ],
    candidate_events: [
      { event_id: "event-synthetic-one", event_version: 4 },
      { event_id: "event-synthetic-two", event_version: 1 },
    ],
    prior_decision_ids: ["decision-synthetic-one", "decision-synthetic-two"],
    missing_fields: ["service_resume_confirmation"],
    conflicts: ["synthetic reports disagree on current service status"],
    retrieval_version: "hybrid-retrieval-v2",
    index_version: "synthetic-index-v4",
    sufficient,
  };
}

it("persists the exact refs-only schema 2.0 projection and returns the full validated request", async () => {
  const request = reasoningRequest(false);
  const original = structuredClone(request);
  const expected = expectedRecord(false);
  const repositoryResult = { ...expected };
  let calls = 0;
  let receivedRecord: GroundingContextRecord | undefined;
  const repository: GroundingContextRepository = {
    async createOrVerify(record) {
      calls += 1;
      receivedRecord = record;
      return repositoryResult;
    },
  };

  const result = await createReasoningContextPersister(repository).persist(request);

  assert.equal(calls, 1);
  assert.deepStrictEqual(receivedRecord, expected);
  assert.deepStrictEqual(result.persistedRecord, repositoryResult);
  assert.strictEqual(result.persistedRecord, repositoryResult);
  assert.deepStrictEqual(result.reasoningRequest, await validateReasoningRequest(request));
  assert.deepStrictEqual(result.reasoningRequest.data.groundingContext.evidence[0], {
    reference: {
      reportRevisionId: "revision-synthetic-primary",
      permittedTextHash: "a".repeat(64),
      spanStart: 0,
      spanEnd: 10,
      offsetUnit: "unicode_code_points",
      relation: "supports",
    },
    text: "supporting",
    sourceId: "source-synthetic-primary",
    revisionStatus: "eligible",
    publishedAt: "2026-09-25T10:00:00Z",
    observedAt: null,
    retrievedAt: "2026-09-26T05:00:00Z",
    origins: [{
      originId: "origin-synthetic-primary",
      independenceStatus: "established",
      dependsOnOriginIds: [],
    }],
  });
  assert.equal(JSON.stringify(receivedRecord).includes("supporting"), false);
  assert.equal(JSON.stringify(receivedRecord).includes("source-synthetic"), false);
  assert.deepStrictEqual(request, original);
});

it("preserves caller-supplied sufficient even when gaps and conflicts remain", async () => {
  const request = reasoningRequest(true);
  let receivedRecord: GroundingContextRecord | undefined;
  const repository: GroundingContextRepository = {
    async createOrVerify(record) {
      receivedRecord = record;
      return record;
    },
  };

  const result = await createReasoningContextPersister(repository).persist(request);

  assert.equal(receivedRecord?.sufficient, true);
  assert.equal(result.reasoningRequest.data.groundingContext.sufficient, true);
  assert.deepStrictEqual(receivedRecord?.missing_fields, ["service_resume_confirmation"]);
  assert.deepStrictEqual(receivedRecord?.conflicts, ["synthetic reports disagree on current service status"]);
});

it("validates an unknown request before making a repository call", async () => {
  const request = reasoningRequest(false);
  const invalidRequest = {
    ...request,
    data: {
      ...request.data,
      groundingContext: {
        ...request.data.groundingContext,
        sufficient: "unknown",
      },
    },
  };
  let calls = 0;
  const repository: GroundingContextRepository = {
    async createOrVerify(record) {
      calls += 1;
      return record;
    },
  };

  await assert.rejects(
    createReasoningContextPersister(repository).persist(invalidRequest),
    (error: unknown) => error instanceof ContractValidationError
      && error.code === "request.data.groundingContext.sufficient:expected_boolean",
  );
  assert.equal(calls, 0);
});

it("propagates repository conflict, reference, and validation errors unchanged", async () => {
  const errors = [
    new GroundingContextConflictError(),
    new GroundingContextReferenceError("evidence"),
    new GroundingContextValidationError("context.sufficient", "invalid_boolean"),
  ];
  for (const repositoryError of errors) {
    let calls = 0;
    const repository: GroundingContextRepository = {
      async createOrVerify() {
        calls += 1;
        throw repositoryError;
      },
    };

    await assert.rejects(
      createReasoningContextPersister(repository).persist(reasoningRequest(false)),
      (error: unknown) => error === repositoryError,
    );
    assert.equal(calls, 1);
  }
});
