import assert from "node:assert/strict";
import test from "node:test";
import type { GroundingContextRecord } from "../../db/src/grounding-contexts.js";
import type { EventProposal, EventProposalRepository } from "../../db/src/event-proposals.js";
import type {
  CapabilityOutcome,
  EvidenceReference,
  GroundingContext,
  ReasoningResult,
} from "../src/layers/l2-model-grounding/contracts.js";
import {
  createReasoningProposalBridge,
  ReasoningProposalBridgeError,
  type ReasoningProposalBridgeInput,
  type ReasoningProposalTarget,
} from "../src/layers/l2-model-grounding/reasoning-proposal-bridge.js";

const TEST_TIME = "2026-10-01T12:34:56.123456+07:00";
const MODEL_PROVIDER = "synthetic-provider-must-not-be-persisted";

function contextFixture(): GroundingContext {
  return {
    schemaVersion: "2.0",
    recordType: "GroundingContext",
    datasetKind: "synthetic",
    traceId: "trace-synthetic-proposal-bridge",
    contextId: "context-synthetic-proposal-bridge",
    candidateId: "candidate-synthetic-proposal-bridge",
    evidence: [
      {
        reference: evidenceReference("revision-support-one", "a", 0, 10, "supports"),
        text: "supporting",
        sourceId: "source-support-one",
        revisionStatus: "eligible",
        publishedAt: "2026-09-30T10:00:00Z",
        observedAt: null,
        retrievedAt: "2026-09-30T10:10:00Z",
        origins: [
          { originId: "origin-zeta", independenceStatus: "dependent", dependsOnOriginIds: ["origin-source"] },
          { originId: "origin-alpha", independenceStatus: "unknown", dependsOnOriginIds: [] },
        ],
      },
      {
        reference: evidenceReference("revision-support-two", "b", 0, 11, "supports"),
        text: "supporting2",
        sourceId: "source-support-two",
        revisionStatus: "unreviewed",
        publishedAt: null,
        observedAt: "2026-09-30T10:02:00Z",
        retrievedAt: "2026-09-30T10:10:00Z",
        origins: [
          { originId: "origin-alpha", independenceStatus: "unknown", dependsOnOriginIds: [] },
          { originId: "origin-beta", independenceStatus: "established", dependsOnOriginIds: [] },
        ],
      },
      {
        reference: evidenceReference("revision-contrary", "c", 0, 8, "contradicts"),
        text: "contrary",
        sourceId: "source-contrary",
        revisionStatus: "eligible",
        publishedAt: null,
        observedAt: null,
        retrievedAt: "2026-09-30T10:10:00Z",
        origins: [{ originId: "origin-contrary-only", independenceStatus: "established", dependsOnOriginIds: [] }],
      },
      {
        reference: evidenceReference("revision-update", "d", 0, 7, "updates"),
        text: "updated",
        sourceId: "source-update",
        revisionStatus: "quarantined",
        publishedAt: null,
        observedAt: "2026-09-30T10:03:00Z",
        retrievedAt: "2026-09-30T10:10:00Z",
        origins: [{ originId: "origin-update-only", independenceStatus: "unknown", dependsOnOriginIds: [] }],
      },
      {
        reference: evidenceReference("revision-context", "e", 0, 10, "context"),
        text: "background",
        sourceId: "source-context",
        revisionStatus: "eligible",
        publishedAt: "2026-09-29T08:00:00Z",
        observedAt: null,
        retrievedAt: "2026-09-30T10:10:00Z",
        origins: [{ originId: "origin-context-only", independenceStatus: "dependent", dependsOnOriginIds: ["origin-source"] }],
      },
    ],
    revisionStates: [
      { reportRevisionId: "revision-support-one", revisionStatus: "eligible" },
      { reportRevisionId: "revision-support-two", revisionStatus: "unreviewed" },
      { reportRevisionId: "revision-contrary", revisionStatus: "eligible" },
      { reportRevisionId: "revision-update", revisionStatus: "quarantined" },
      { reportRevisionId: "revision-context", revisionStatus: "eligible" },
    ],
    candidateEvents: [
      { eventId: "event-synthetic-one", eventVersion: 3 },
      { eventId: "event-synthetic-two", eventVersion: 1 },
    ],
    priorDecisionIds: ["decision-synthetic-one"],
    missingFields: ["service_resume_confirmation"],
    conflicts: ["synthetic reports disagree on current service status"],
    retrievalVersion: "synthetic-retrieval-v5",
    indexVersion: "synthetic-index-v2",
    sufficient: true,
  };
}

function persistedRecord(context: GroundingContext): GroundingContextRecord {
  return {
    schema_version: context.schemaVersion,
    trace_id: context.traceId,
    record_type: context.recordType,
    dataset_kind: context.datasetKind,
    context_id: context.contextId,
    candidate_id: context.candidateId,
    evidence: context.evidence.map(({ reference }) => ({
      report_revision_id: reference.reportRevisionId,
      permitted_text_hash: reference.permittedTextHash,
      span_start: reference.spanStart,
      span_end: reference.spanEnd,
      offset_unit: reference.offsetUnit,
      relation: reference.relation,
    })),
    revision_states: context.revisionStates.map((state) => ({
      report_revision_id: state.reportRevisionId,
      revision_status: state.revisionStatus,
    })),
    candidate_events: context.candidateEvents.map((event) => ({
      event_id: event.eventId,
      event_version: event.eventVersion,
    })),
    prior_decision_ids: [...context.priorDecisionIds],
    missing_fields: [...context.missingFields],
    conflicts: [...context.conflicts],
    retrieval_version: context.retrievalVersion,
    index_version: context.indexVersion,
    sufficient: context.sufficient,
  };
}

function evidenceReference(
  reportRevisionId: string,
  hashPrefix: string,
  spanStart: number,
  spanEnd: number,
  relation: EvidenceReference["relation"],
): EvidenceReference {
  return {
    reportRevisionId,
    permittedTextHash: hashPrefix.repeat(64),
    spanStart,
    spanEnd,
    offsetUnit: "unicode_code_points",
    relation,
  };
}

function proposalResult(context: GroundingContext): ReasoningResult {
  const [supportOne, supportTwo, contrary, update, background] = context.evidence.map(({ reference }) => reference);
  assert.ok(supportOne && supportTwo && contrary && update && background);
  return {
    outcome: "proposed",
    claims: [
      {
        text: "Synthetic claim with support and preserved contrary evidence",
        eventTime: {
          precision: "range",
          start: "2026-09-30T10:00:00.123456+07:00",
          end: "2026-09-30T11:00:00.654321+07:00",
        },
        validity: {
          validFrom: "2026-09-30T09:59:59.000001+07:00",
          validUntil: "2026-09-30T11:00:01.999999+07:00",
        },
        scope: {
          placeIds: ["place-synthetic-one"],
          serviceIds: ["service-synthetic-one"],
          institutionIds: [],
          audienceIds: ["audience-synthetic-one"],
          geometryIds: [],
        },
        qualifiers: ["temporary", "reported"],
        support: [supportOne, supportTwo],
        contradictions: [contrary],
        contextEvidence: [update, background],
        supportAssessment: "disputed",
      },
      {
        text: "A later claim keeps its date precision",
        eventTime: { precision: "date", start: "2026-09-30", end: "2026-10-01" },
        validity: { validFrom: null, validUntil: null },
        scope: { placeIds: [], serviceIds: [], institutionIds: [], audienceIds: [], geometryIds: [] },
        qualifiers: [],
        support: [supportOne],
        contradictions: [],
        contextEvidence: [],
        supportAssessment: "supported",
      },
      {
        text: "A claim without a known time retains unknown precision",
        eventTime: { precision: "unknown", start: null, end: null },
        validity: { validFrom: null, validUntil: null },
        scope: { placeIds: [], serviceIds: [], institutionIds: [], audienceIds: [], geometryIds: [] },
        qualifiers: [],
        support: [supportTwo],
        contradictions: [],
        contextEvidence: [],
        supportAssessment: "uncertain",
      },
    ],
    unresolvedFields: [...context.missingFields],
    conflicts: [...context.conflicts],
    modelRun: {
      capability: "reasoning",
      modelVersion: "synthetic-reasoning-model-v3",
      promptVersion: "synthetic-reasoning-prompt-v2",
      inputTokens: 63,
      outputTokens: 29,
    },
    provider: MODEL_PROVIDER,
  };
}

function capabilityOutcome(value: ReasoningResult): CapabilityOutcome<ReasoningResult, "reasoning"> {
  return { status: "succeeded", capability: "reasoning", value };
}

function bridgeInput(
  options: {
    readonly context?: GroundingContext;
    readonly record?: GroundingContextRecord;
    readonly result?: ReasoningResult;
    readonly target?: ReasoningProposalTarget;
    readonly investigationId?: string | null;
  } = {},
): ReasoningProposalBridgeInput {
  const context = options.context ?? contextFixture();
  return {
    capabilityOutcome: capabilityOutcome(options.result ?? proposalResult(context)),
    groundingContext: context,
    persistedContextRecord: options.record ?? persistedRecord(context),
    proposalId: "proposal-synthetic-stable-123",
    proposedAt: TEST_TIME,
    target: options.target ?? { kind: "new" },
    investigationId: options.investigationId === undefined ? "investigation-synthetic-9" : options.investigationId,
  };
}

function recordingRepository() {
  const received: EventProposal[] = [];
  const repository: EventProposalRepository = {
    async createOrVerify(proposal) {
      received.push(structuredClone(proposal));
      return proposal;
    },
  };
  return { repository, received };
}

test("maps proposed claims to the closed draft shape with exact references, times, origins, and caller metadata", async () => {
  const { repository, received } = recordingRepository();
  const result = await createReasoningProposalBridge(repository).persist(bridgeInput());

  assert.equal(result.status, "persisted");
  if (result.status !== "persisted") assert.fail("expected a persisted proposal");
  assert.equal(received.length, 1);
  const proposal = received[0]!;
  assert.deepEqual(result.proposal, proposal);
  assert.equal(proposal.proposal_id, "proposal-synthetic-stable-123");
  assert.equal(proposal.proposed_at, TEST_TIME);
  assert.equal(proposal.trace_id, "trace-synthetic-proposal-bridge");
  assert.equal(proposal.context_id, "context-synthetic-proposal-bridge");
  assert.equal(proposal.candidate_id, "candidate-synthetic-proposal-bridge");
  assert.equal(proposal.investigation_id, "investigation-synthetic-9");
  assert.equal(proposal.event_id, null);
  assert.equal(proposal.base_event_version, null);
  assert.deepEqual(proposal.claims.map((claim) => claim.claim_id), ["claim-001", "claim-002", "claim-003"]);
  assert.deepEqual(proposal.claims.map((claim) => claim.evidence_label), ["under_review", "under_review", "under_review"]);
  assert.deepEqual(proposal.claims.map((claim) => claim.support_assessment), ["disputed", "supported", "uncertain"]);
  assert.deepEqual(proposal.claims[0]?.origin_ids, ["origin-alpha", "origin-beta", "origin-zeta"]);
  assert.deepEqual(proposal.claims[1]?.origin_ids, ["origin-alpha", "origin-zeta"]);
  assert.deepEqual(proposal.claims[0]?.support, [
    {
      report_revision_id: "revision-support-one",
      permitted_text_hash: "a".repeat(64),
      span_start: 0,
      span_end: 10,
      offset_unit: "unicode_code_points",
      relation: "supports",
    },
    {
      report_revision_id: "revision-support-two",
      permitted_text_hash: "b".repeat(64),
      span_start: 0,
      span_end: 11,
      offset_unit: "unicode_code_points",
      relation: "supports",
    },
  ]);
  assert.deepEqual(proposal.claims[0]?.contradictions.map((reference) => reference.relation), ["contradicts"]);
  assert.deepEqual(proposal.claims[0]?.context_evidence.map((reference) => reference.relation), ["updates", "context"]);
  assert.deepEqual(proposal.claims[0]?.event_time, {
    precision: "range",
    start: "2026-09-30T10:00:00.123456+07:00",
    end: "2026-09-30T11:00:00.654321+07:00",
  });
  assert.deepEqual(proposal.claims[0]?.validity, {
    valid_from: "2026-09-30T09:59:59.000001+07:00",
    valid_until: "2026-09-30T11:00:01.999999+07:00",
  });
  assert.deepEqual(proposal.claims[1]?.event_time, { precision: "date", start: "2026-09-30", end: "2026-10-01" });
  assert.deepEqual(proposal.claims[2]?.event_time, { precision: "unknown", start: null, end: null });
  assert.deepEqual(proposal.unresolved_fields, ["service_resume_confirmation"]);
  assert.deepEqual(proposal.model_runs, [{
    capability: "reasoning",
    model_version: "synthetic-reasoning-model-v3",
    prompt_version: "synthetic-reasoning-prompt-v2",
    input_tokens: 63,
    output_tokens: 29,
  }]);
  assert.equal(JSON.stringify(proposal).includes(MODEL_PROVIDER), false);
  assert.deepEqual(Object.keys(proposal).sort(), [
    "base_event_version", "candidate_id", "claims", "context_id", "dataset_kind", "event_id", "investigation_id",
    "model_runs", "proposal_id", "proposed_at", "record_type", "schema_version", "trace_id", "unresolved_fields",
  ].sort());
});

test("persists abstention as an empty private draft with unresolved fields", async () => {
  const context = contextFixture();
  const resultValue: ReasoningResult = {
    outcome: "abstained",
    claims: [],
    unresolvedFields: ["service_resume_confirmation", "current_operator_status"],
    conflicts: [...context.conflicts],
    modelRun: {
      capability: "reasoning",
      modelVersion: "synthetic-reasoning-model-v3",
      promptVersion: "synthetic-reasoning-prompt-v2",
      inputTokens: 12,
      outputTokens: 4,
    },
    provider: MODEL_PROVIDER,
  };
  const { repository, received } = recordingRepository();

  const result = await createReasoningProposalBridge(repository).persist(bridgeInput({ context, result: resultValue }));

  assert.equal(result.status, "persisted");
  assert.equal(received.length, 1);
  assert.deepEqual(received[0]?.claims, []);
  assert.deepEqual(received[0]?.unresolved_fields, ["service_resume_confirmation", "current_operator_status"]);
  assert.equal(received[0]?.event_id, null);
  assert.equal(received[0]?.base_event_version, null);
  assert.equal(received[0]?.record_type, "EventProposal");
});

test("all non-success reasoning capability statuses return without a repository write", async () => {
  const outcomes: CapabilityOutcome<ReasoningResult, "reasoning">[] = [
    { status: "not_configured", capability: "reasoning", reason: "provider_not_configured" },
    { status: "invalid_request", capability: "reasoning", reason: "synthetic invalid request detail" },
    { status: "invalid_output", capability: "reasoning", reason: "synthetic invalid output detail" },
    { status: "provider_error", capability: "reasoning" },
  ];

  for (const outcome of outcomes) {
    const { repository, received } = recordingRepository();
    const input = { ...bridgeInput(), capabilityOutcome: outcome } as ReasoningProposalBridgeInput;
    const result = await createReasoningProposalBridge(repository).persist(input);
    assert.deepEqual(result, { status: "no_write", capabilityStatus: outcome.status });
    assert.deepEqual(received, []);
  }
});

test("persisted context must match each exact identity, evidence, event, gap, version, and sufficiency field", async () => {
  const cases: Array<{ name: string; mutate: (record: any) => void }> = [
    { name: "schema version", mutate: (record) => { record.schema_version = "1.0"; } },
    { name: "record type", mutate: (record) => { record.record_type = "OtherRecord"; } },
    { name: "dataset identity", mutate: (record) => { record.dataset_kind = "historical"; } },
    { name: "trace identity", mutate: (record) => { record.trace_id = "trace-other"; } },
    { name: "context identity", mutate: (record) => { record.context_id = "context-other"; } },
    { name: "candidate identity", mutate: (record) => { record.candidate_id = "candidate-other"; } },
    { name: "evidence", mutate: (record) => { record.evidence[0]!.span_end += 1; } },
    { name: "revision state", mutate: (record) => { record.revision_states[0]!.revision_status = "retracted"; } },
    { name: "event candidate", mutate: (record) => { record.candidate_events[0]!.event_version += 1; } },
    { name: "prior decisions", mutate: (record) => { record.prior_decision_ids.push("decision-other"); } },
    { name: "missing fields", mutate: (record) => { record.missing_fields[0] = "another_field"; } },
    { name: "conflicts", mutate: (record) => { record.conflicts[0] = "another conflict"; } },
    { name: "retrieval version", mutate: (record) => { record.retrieval_version = "retrieval-other"; } },
    { name: "index version", mutate: (record) => { record.index_version = "index-other"; } },
    { name: "sufficiency", mutate: (record) => { record.sufficient = false; } },
  ];

  for (const mismatch of cases) {
    const context = contextFixture();
    const record = structuredClone(persistedRecord(context)) as any;
    mismatch.mutate(record);
    const { repository, received } = recordingRepository();
    await assert.rejects(
      createReasoningProposalBridge(repository).persist(bridgeInput({ context, record })),
      (error: unknown) => error instanceof ReasoningProposalBridgeError
        && error.code === "grounding_context_mismatch"
        && error.message === "grounding_context_mismatch",
      mismatch.name,
    );
    assert.deepEqual(received, [], mismatch.name);
  }
});

test("reasoning conflicts must exactly preserve context conflicts", async () => {
  const context = contextFixture();
  const resultValue = proposalResult(context) as any;
  resultValue.conflicts = ["different synthetic conflict"];
  const { repository, received } = recordingRepository();

  await assert.rejects(
    createReasoningProposalBridge(repository).persist(bridgeInput({ context, result: resultValue })),
    (error: unknown) => error instanceof ReasoningProposalBridgeError && error.code === "conflict_mismatch",
  );
  assert.deepEqual(received, []);
});

test("only the exact context candidate event pair is accepted for an update target", async () => {
  const context = contextFixture();
  const target: ReasoningProposalTarget = { kind: "update", eventId: "event-synthetic-one", baseEventVersion: 3 };
  const { repository, received } = recordingRepository();
  const result = await createReasoningProposalBridge(repository).persist(bridgeInput({ context, target }));

  assert.equal(result.status, "persisted");
  assert.equal(received[0]?.event_id, "event-synthetic-one");
  assert.equal(received[0]?.base_event_version, 3);

  const { repository: rejectingRepository, received: rejected } = recordingRepository();
  await assert.rejects(
    createReasoningProposalBridge(rejectingRepository).persist(bridgeInput({
      context,
      target: { kind: "update", eventId: "event-synthetic-one", baseEventVersion: 4 },
    })),
    (error: unknown) => error instanceof ReasoningProposalBridgeError && error.code === "invalid_event_target",
  );
  assert.deepEqual(rejected, []);
});

test("missing, inconsistent, or non-context support origin lineage fails before persistence", async (t) => {
  await t.test("missing origins", async () => {
    const context = contextFixture() as any;
    context.evidence[0]!.origins = [];
    const { repository, received } = recordingRepository();
    await assert.rejects(
      createReasoningProposalBridge(repository).persist(bridgeInput({ context })),
      (error: unknown) => error instanceof ReasoningProposalBridgeError && error.code === "origin_lineage_missing",
    );
    assert.deepEqual(received, []);
  });

  await t.test("ambiguous metadata for the same exact origin", async () => {
    const context = contextFixture() as any;
    context.evidence[1]!.origins[0] = {
      originId: "origin-alpha",
      independenceStatus: "established",
      dependsOnOriginIds: [],
    };
    const { repository, received } = recordingRepository();
    await assert.rejects(
      createReasoningProposalBridge(repository).persist(bridgeInput({ context })),
      (error: unknown) => error instanceof ReasoningProposalBridgeError && error.code === "origin_lineage_ambiguous",
    );
    assert.deepEqual(received, []);
  });

  await t.test("support reference absent from exact grounding context", async () => {
    const context = contextFixture();
    const resultValue = proposalResult(context) as any;
    (resultValue.claims[0]!.support as any)[0] = evidenceReference("revision-unseen", "f", 0, 6, "supports");
    const { repository, received } = recordingRepository();
    await assert.rejects(
      createReasoningProposalBridge(repository).persist(bridgeInput({ context, result: resultValue })),
      (error: unknown) => error instanceof ReasoningProposalBridgeError && error.code === "invalid_reasoning_outcome",
    );
    assert.deepEqual(received, []);
  });
});

test("malformed runtime outcomes fail with content-free errors before repository calls", async () => {
  const context = contextFixture();
  const valid = proposalResult(context);
  const secret = "PRIVATE_SOURCE_EXCERPT_SHOULD_NOT_APPEAR";
  const malformed = {
    ...valid,
    unexpectedProviderData: secret,
  };
  const input = {
    ...bridgeInput({ context }),
    capabilityOutcome: { status: "succeeded", capability: "reasoning", value: malformed },
  } as unknown as ReasoningProposalBridgeInput;
  const { repository, received } = recordingRepository();

  await assert.rejects(
    createReasoningProposalBridge(repository).persist(input),
    (error: unknown) => error instanceof ReasoningProposalBridgeError
      && error.code === "invalid_reasoning_outcome"
      && !error.message.includes(secret),
  );
  assert.deepEqual(received, []);
});

test("invalid calendar dates, time precision, validity intervals, and proposed-at values fail before persistence", async (t) => {
  const context = contextFixture();
  const cases: Array<{
    readonly name: string;
    readonly makeInput: () => ReasoningProposalBridgeInput;
    readonly expectedCode: string;
  }> = [
    {
      name: "impossible date in exact event time",
      makeInput: () => {
        const value = structuredClone(proposalResult(context)) as any;
        (value.claims[0]!.eventTime as { start: string | null; end: string | null; precision: string }).start = "2026-02-30T10:00:00Z";
        return { ...bridgeInput({ context }), capabilityOutcome: capabilityOutcome(value) };
      },
      expectedCode: "invalid_reasoning_outcome",
    },
    {
      name: "unknown precision with a timestamp",
      makeInput: () => {
        const value = structuredClone(proposalResult(context)) as any;
        (value.claims[2]!.eventTime as { start: string | null; end: string | null; precision: string }).start = "2026-09-30T10:00:00Z";
        return { ...bridgeInput({ context }), capabilityOutcome: capabilityOutcome(value) };
      },
      expectedCode: "invalid_reasoning_outcome",
    },
    {
      name: "reversed validity interval",
      makeInput: () => {
        const value = structuredClone(proposalResult(context)) as any;
        value.claims[0]!.validity = {
          validFrom: "2026-09-30T11:00:00Z",
          validUntil: "2026-09-30T10:00:00Z",
        };
        return { ...bridgeInput({ context }), capabilityOutcome: capabilityOutcome(value) };
      },
      expectedCode: "invalid_reasoning_outcome",
    },
    {
      name: "impossible proposed-at date",
      makeInput: () => ({ ...bridgeInput({ context }), proposedAt: "2026-02-30T10:00:00Z" }),
      expectedCode: "invalid_bridge_input",
    },
  ];

  for (const entry of cases) {
    await t.test(entry.name, async () => {
      const { repository, received } = recordingRepository();
      await assert.rejects(
        createReasoningProposalBridge(repository).persist(entry.makeInput()),
        (error: unknown) => error instanceof ReasoningProposalBridgeError
          && error.code === entry.expectedCode
          && !error.message.includes("2026-02-30"),
      );
      assert.deepEqual(received, []);
    });
  }
});

test("capability status and target discriminants are inspected without invoking getters", async () => {
  const context = contextFixture();
  const successful = capabilityOutcome(proposalResult(context));
  if (successful.status !== "succeeded") assert.fail("expected successful fixture outcome");
  let statusReads = 0;
  const maliciousOutcome = { capability: "reasoning", value: successful.value } as Record<string, unknown>;
  Object.defineProperty(maliciousOutcome, "status", {
    enumerable: true,
    get() {
      statusReads += 1;
      return "succeeded";
    },
  });
  const { repository, received } = recordingRepository();
  await assert.rejects(
    createReasoningProposalBridge(repository).persist({
      ...bridgeInput({ context }),
      capabilityOutcome: maliciousOutcome as unknown as CapabilityOutcome<ReasoningResult, "reasoning">,
    }),
    (error: unknown) => error instanceof ReasoningProposalBridgeError && error.code === "invalid_reasoning_outcome",
  );
  assert.equal(statusReads, 0);
  assert.deepEqual(received, []);

  let kindReads = 0;
  const maliciousTarget = {} as Record<string, unknown>;
  Object.defineProperty(maliciousTarget, "kind", {
    enumerable: true,
    get() {
      kindReads += 1;
      return "new";
    },
  });
  await assert.rejects(
    createReasoningProposalBridge(repository).persist({
      ...bridgeInput({ context }),
      target: maliciousTarget as unknown as ReasoningProposalTarget,
    }),
    (error: unknown) => error instanceof ReasoningProposalBridgeError && error.code === "invalid_event_target",
  );
  assert.equal(kindReads, 0);
  assert.deepEqual(received, []);
});

test("provider and publication services are outside the bridge and draft writes stay canonical", async () => {
  const { repository, received } = recordingRepository();
  const bridge = createReasoningProposalBridge(repository);
  const result = await bridge.persist(bridgeInput());
  assert.equal(result.status, "persisted");
  assert.equal(received.length, 1);
  assert.deepEqual(Object.keys(received[0]!).sort(), [
    "base_event_version", "candidate_id", "claims", "context_id", "dataset_kind", "event_id", "investigation_id",
    "model_runs", "proposal_id", "proposed_at", "record_type", "schema_version", "trace_id", "unresolved_fields",
  ].sort());
  assert.equal(received[0]?.record_type, "EventProposal");
  assert.equal(received[0]?.claims.some((claim) => claim.evidence_label !== "under_review"), false);
  assert.equal(JSON.stringify(received[0]).includes(MODEL_PROVIDER), false);
});
