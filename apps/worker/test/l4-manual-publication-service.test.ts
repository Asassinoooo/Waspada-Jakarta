import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import type { EventProposal, EventProposalReader, ProposalEvidenceReference, ProposalTime } from "../../db/src/event-proposals.js";
import type { EvidenceRetrievalCandidate, EvidenceRetrievalResult } from "../../db/src/evidence-retrieval.js";
import type { PublicationEventVersionDraft, PublicationImpactVersionDraft, PublicationWriteCommand, PublicationWriteResult } from "../../db/src/publication-writer.js";
import type { EvidenceReference, GroundingContext, ProposedClaim, ReasoningResult } from "../src/layers/l2-model-grounding/contracts.js";
import { createManualPublicationService, type ManualPublicationServiceInput } from "../src/layers/l4-application-integration/manual-publication-service.js";
import { type CurrentEvidenceState, type ExplicitModeratorDecision, type PublicationEventTarget, type PublicationPolicyInput } from "../src/layers/l4-application-integration/publication-policy.js";

const SUPPORT: EvidenceReference = { reportRevisionId: "revision-synthetic-support", permittedTextHash: "a".repeat(64), spanStart: 0, spanEnd: 9, offsetUnit: "unicode_code_points", relation: "supports" };
const CONTRADICTION: EvidenceReference = { reportRevisionId: "revision-synthetic-contradiction", permittedTextHash: "b".repeat(64), spanStart: 0, spanEnd: 9, offsetUnit: "unicode_code_points", relation: "contradicts" };
const CONTEXT: EvidenceReference = { reportRevisionId: "revision-synthetic-context", permittedTextHash: "c".repeat(64), spanStart: 0, spanEnd: 9, offsetUnit: "unicode_code_points", relation: "context" };
const DECISION: ExplicitModeratorDecision = { action: "approve", actorId: "moderator-synthetic-1", decidedAt: "2026-09-25T09:00:00+07:00", reason: "Synthetic manual review decision.", trustedCallerAuthorized: true };
const MODEL_RUN: ReasoningResult["modelRun"] = { capability: "reasoning", modelVersion: "synthetic-model-v1", promptVersion: "synthetic-prompt-v1", inputTokens: 17, outputTokens: 9 };

interface Fixture { readonly input: ManualPublicationServiceInput; readonly proposal: EventProposal; }

function makeClaim(overrides: Partial<ProposedClaim> = {}): ProposedClaim {
  return {
    text: "Synthetic road closure for contract testing.",
    eventTime: { start: null, end: null, precision: "unknown" },
    validity: { validFrom: null, validUntil: null },
    scope: { placeIds: [], serviceIds: [], institutionIds: [], audienceIds: [], geometryIds: [] },
    qualifiers: ["synthetic"], support: [SUPPORT], contradictions: [CONTRADICTION], contextEvidence: [CONTEXT],
    supportAssessment: "supported", ...overrides,
  };
}

function makeCandidate(reference: EvidenceReference, evidenceReferenceId: string): EvidenceRetrievalCandidate {
  return {
    datasetKind: "live", candidateId: "candidate-synthetic-001", reportRevisionId: reference.reportRevisionId,
    permittedTextHash: reference.permittedTextHash, evidenceReferenceId, spanStart: reference.spanStart,
    spanEnd: reference.spanEnd, offsetUnit: "unicode_code_points", relation: reference.relation,
    spanText: "synthetic", spanTextStart: 0, spanTextEnd: 9, spanTextTruncated: false, revisionStatus: "eligible",
    source: { sourceId: "source-for-" + reference.reportRevisionId, displayName: "Synthetic fixture source", sourceKind: "other", publisherGroupId: null, registryStatus: "retired", approvalStatus: "approved", healthStatus: "unavailable" },
    publishedAt: null, observedAt: null, retrievedAt: "2026-09-25T08:45:00+07:00", validFrom: null, validUntil: null,
    eventTime: { start: null, end: null, precision: "unknown", status: "unknown" }, origins: [], originLineageStatus: "unknown",
    geometryMatches: [], chunk: null,
    matchFacets: { identifiers: [], exactTerms: [], reportTimeFields: [], eventTime: false, geometry: false, semanticDistance: null },
  };
}

function toProposalTime(value: ProposedClaim["eventTime"]): ProposalTime {
  if (value.precision === "unknown") return { precision: "unknown", start: null, end: null };
  if (value.precision === "range") return { precision: "range", start: value.start!, end: value.end! };
  return { precision: value.precision, start: value.start!, end: value.end };
}

function toProposalEvidence(value: EvidenceReference): ProposalEvidenceReference {
  return { report_revision_id: value.reportRevisionId, permitted_text_hash: value.permittedTextHash, span_start: value.spanStart, span_end: value.spanEnd, offset_unit: value.offsetUnit, relation: value.relation };
}

function makeFixture(options: {
  readonly target?: PublicationEventTarget;
  readonly investigationId?: string | null;
  readonly claim?: ProposedClaim;
  readonly decision?: ExplicitModeratorDecision | null;
  readonly datasetKind?: "live" | "historical" | "synthetic";
  readonly contextRelationUpdates?: boolean;
} = {}): Fixture {
  const target = options.target ?? { kind: "new" as const };
  const contextReference = options.contextRelationUpdates ? { ...CONTEXT, relation: "updates" as const } : CONTEXT;
  const references = [SUPPORT, CONTRADICTION, contextReference];
  const claim = makeClaim({ ...(options.claim ?? {}), contextEvidence: [contextReference] });
  const reasoningResult: ReasoningResult = { outcome: "proposed", claims: [claim], unresolvedFields: [], conflicts: [], modelRun: MODEL_RUN, provider: "synthetic-only" };
  const datasetKind = options.datasetKind ?? "live";
  const context: GroundingContext = {
    schemaVersion: "2.0", recordType: "GroundingContext", datasetKind, traceId: "trace-synthetic-001", contextId: "context-synthetic-001", candidateId: "candidate-synthetic-001",
    evidence: references.map((reference) => ({
      reference, text: "synthetic", sourceId: "source-for-" + reference.reportRevisionId, revisionStatus: "eligible",
      publishedAt: null, observedAt: null, retrievedAt: "2026-09-25T08:45:00+07:00",
      origins: reference.reportRevisionId === SUPPORT.reportRevisionId ? [{ originId: "origin-synthetic-support", independenceStatus: "unknown", dependsOnOriginIds: [] }] : [],
    })),
    revisionStates: references.map((reference) => ({ reportRevisionId: reference.reportRevisionId, revisionStatus: "eligible" })),
    candidateEvents: target.kind === "update" ? [{ eventId: target.eventId, eventVersion: target.baseVersion }] : [],
    priorDecisionIds: [], missingFields: [], conflicts: [], retrievalVersion: "hybrid-evidence-v1", indexVersion: "synthetic-index-v1", sufficient: true,
  };
  const candidates = references.map((reference, index) => makeCandidate(reference, "evidence-ref-synthetic-" + String(index + 1)));
  const retrieval: EvidenceRetrievalResult = {
    datasetKind, retrievalVersion: "hybrid-evidence-v1", indexVersion: "synthetic-index-v1",
    candidates: candidates.map((candidate) => ({ ...candidate, datasetKind })), rowsExamined: candidates.length,
    filteredRowsOmitted: 0, invalidSpanRowsOmitted: 0, scanTruncated: false, resultTruncated: false, semanticStatus: "not_requested",
  };
  const currentEvidenceStates: readonly CurrentEvidenceState[] = candidates.map((candidate) => ({
    datasetKind, evidenceReferenceId: candidate.evidenceReferenceId, sourceId: candidate.source.sourceId, remit: "in_scope", freshness: "current",
  }));
  const policyInput: PublicationPolicyInput = {
    groundingContext: context, reasoningResult, retrieval, currentEvidenceStates, target,
    currentEvent: target.kind === "update" ? { eventId: target.eventId, version: target.baseVersion } : null,
    moderatorDecision: options.decision === undefined ? DECISION : options.decision,
  };
  const eventId = target.kind === "update" ? target.eventId : "event-synthetic-new";
  const eventVersion = target.kind === "update" ? target.baseVersion + 1 : 1;
  const event: PublicationEventVersionDraft = {
    event_id: eventId, version: eventVersion, supersedes_version: target.kind === "update" ? target.baseVersion : null,
    title: "Synthetic road closure", summary: "Synthetic summary for local policy composition tests.", category: "transport_road_incidents", tags: [], lifecycle: "ongoing",
    freshness: { status: "current", evaluated_at: "2026-09-25T09:00:00+07:00", review_due_at: null, basis: "manual_review" },
    event_time: { start: null, end: null, precision: "unknown" }, validity: { valid_from: null, valid_until: null },
    scope: { place_ids: [], service_ids: [], institution_ids: [], audience_ids: [], geometry_ids: [] }, published_at: "2026-09-25T09:01:00+07:00",
  };
  const impact: PublicationImpactVersionDraft = {
    impact_id: "impact-synthetic-001", version: 1, event_id: eventId, event_version: eventVersion, impact_type: "road_closure",
    title: "Synthetic road access impact", description: "Synthetic impact description.", lifecycle: "ongoing", freshness: event.freshness,
    event_time: event.event_time, validity: event.validity, scope: event.scope, supporting_claim_ids: ["claim-001"], published_at: event.published_at,
  };
  const proposal: EventProposal = {
    schema_version: "2.0", trace_id: context.traceId, record_type: "EventProposal", dataset_kind: datasetKind,
    proposal_id: "proposal-synthetic-001", candidate_id: context.candidateId, context_id: context.contextId,
    event_id: target.kind === "update" ? target.eventId : null, base_event_version: target.kind === "update" ? target.baseVersion : null,
    investigation_id: options.investigationId ?? null,
    claims: [{
      claim_id: "claim-001", text: claim.text, event_time: toProposalTime(claim.eventTime),
      validity: { valid_from: claim.validity.validFrom, valid_until: claim.validity.validUntil },
      scope: { place_ids: [...claim.scope.placeIds], service_ids: [...claim.scope.serviceIds], institution_ids: [...claim.scope.institutionIds], audience_ids: [...claim.scope.audienceIds], geometry_ids: [...claim.scope.geometryIds] },
      qualifiers: [...claim.qualifiers], support: claim.support.map(toProposalEvidence), contradictions: claim.contradictions.map(toProposalEvidence),
      context_evidence: claim.contextEvidence.map(toProposalEvidence), origin_ids: ["origin-synthetic-support"], support_assessment: claim.supportAssessment, evidence_label: "under_review",
    }],
    unresolved_fields: [...reasoningResult.unresolvedFields],
    model_runs: [{ capability: "reasoning", model_version: MODEL_RUN.modelVersion, prompt_version: MODEL_RUN.promptVersion, input_tokens: MODEL_RUN.inputTokens, output_tokens: MODEL_RUN.outputTokens }],
    proposed_at: "2026-09-25T08:50:00+07:00",
  };
  return {
    input: { proposalId: proposal.proposal_id, policyInput, eventDraft: event, impactDrafts: [impact], writeMetadata: { idempotencyKey: "idempotency-synthetic-001", decisionId: "decision-synthetic-001", policyVersion: "publication-policy-synthetic-v1" } },
    proposal,
  };
}

function makePorts(proposal: EventProposal | null, behavior: (command: PublicationWriteCommand) => Promise<PublicationWriteResult> = async (command) => ({
  outcome: "written", decisionId: command.decisionId, eventId: command.event.event_id, eventVersion: command.event.version,
})): { reader: EventProposalReader; reads: string[]; calls: PublicationWriteCommand[]; writer: { publish(command: PublicationWriteCommand): Promise<PublicationWriteResult> } } {
  const reads: string[] = [];
  const calls: PublicationWriteCommand[] = [];
  return {
    reader: { async readLive(id) { reads.push(id); return proposal; } }, reads, calls,
    writer: { async publish(command) { calls.push(command); return behavior(command); } },
  };
}

test("one gate covers direct and investigated proposals for new and update targets", async () => {
  const cases = [
    { target: { kind: "new" as const }, investigationId: null },
    { target: { kind: "update" as const, eventId: "event-synthetic-existing", baseVersion: 4 }, investigationId: null },
    { target: { kind: "new" as const }, investigationId: "investigation-synthetic-001" },
    { target: { kind: "update" as const, eventId: "event-synthetic-existing", baseVersion: 4 }, investigationId: "investigation-synthetic-001" },
  ];
  for (const entry of cases) {
    const fixture = makeFixture(entry);
    const ports = makePorts(fixture.proposal);
    const result = await createManualPublicationService(ports.reader, ports.writer).publish(fixture.input);
    const references = [SUPPORT, CONTRADICTION, fixture.input.policyInput.reasoningResult.claims[0]!.contextEvidence[0]!];
    assert.deepEqual(result, { status: "written", receipt: { outcome: "written", decisionId: "decision-synthetic-001", eventId: fixture.input.eventDraft.event_id, eventVersion: fixture.input.eventDraft.version } });
    assert.deepEqual(ports.reads, [fixture.proposal.proposal_id]);
    assert.equal(ports.calls.length, 1);
    assert.deepEqual(ports.calls[0], {
      datasetKind: "live", idempotencyKey: "idempotency-synthetic-001", traceId: "trace-synthetic-001", proposalId: "proposal-synthetic-001",
      decisionId: "decision-synthetic-001", policyVersion: "publication-policy-synthetic-v1",
      expectedTarget: { event_id: entry.target.kind === "update" ? entry.target.eventId : null, base_event_version: entry.target.kind === "update" ? entry.target.baseVersion : null },
      moderatorApproval: { action: "approve", trusted_caller_authorized: true, actor_id: DECISION.actorId, decided_at: DECISION.decidedAt, reason: DECISION.reason },
      claimDecisions: [{ claim_id: "claim-001", disposition: "publish", reason_codes: ["explicit_moderator_approval"], evidence: references.map((reference) => ({
        report_revision_id: reference.reportRevisionId, permitted_text_hash: reference.permittedTextHash, span_start: reference.spanStart,
        span_end: reference.spanEnd, offset_unit: reference.offsetUnit, relation: reference.relation,
      })) }],
      event: fixture.input.eventDraft, impacts: fixture.input.impactDrafts,
    });
  }
});

test("a caller cannot substitute a proposal body for the persisted reader result", async () => {
  const fixture = makeFixture();
  const ports = makePorts(fixture.proposal);
  const forged = { ...fixture.input, proposal: { ...fixture.proposal, claims: [] } } as ManualPublicationServiceInput;
  assert.deepEqual(await createManualPublicationService(ports.reader, ports.writer).publish(forged), { status: "denied", code: "invalid_request" });
  assert.deepEqual(ports.reads, []);
  assert.deepEqual(ports.calls, []);
});

test("missing, unreadable, and non-live proposals fail closed", async () => {
  const fixture = makeFixture();
  const missing = makePorts(null);
  assert.deepEqual(await createManualPublicationService(missing.reader, missing.writer).publish(fixture.input), { status: "denied", code: "proposal_not_found" });
  assert.deepEqual(missing.calls, []);
  const failedReader: EventProposalReader = { async readLive() { throw new Error("private synthetic content"); } };
  const writerCalls: PublicationWriteCommand[] = [];
  const writer = { async publish(command: PublicationWriteCommand) { writerCalls.push(command); return { outcome: "written", decisionId: command.decisionId, eventId: command.event.event_id, eventVersion: command.event.version } as const; } };
  assert.deepEqual(await createManualPublicationService(failedReader, writer).publish(fixture.input), { status: "denied", code: "proposal_unavailable" });
  assert.deepEqual(writerCalls, []);
  const synthetic = makeFixture({ datasetKind: "synthetic" });
  const syntheticPorts = makePorts(synthetic.proposal);
  assert.deepEqual(await createManualPublicationService(syntheticPorts.reader, syntheticPorts.writer).publish(synthetic.input), { status: "denied", code: "proposal_policy_mismatch" });
  assert.deepEqual(syntheticPorts.calls, []);
});

test("persisted identity, claim, reference, origin, model, and context mismatches fail closed", async () => {
  const base = makeFixture();
  const cases: Array<{ name: string; proposal?: EventProposal; input?: ManualPublicationServiceInput }> = [
    { name: "trace", proposal: { ...base.proposal, trace_id: "trace-synthetic-other" } },
    { name: "claim", proposal: { ...base.proposal, claims: [{ ...base.proposal.claims[0]!, text: "forged text" }] } },
    { name: "evidence", proposal: { ...base.proposal, claims: [{ ...base.proposal.claims[0]!, support: [{ ...base.proposal.claims[0]!.support[0]!, permitted_text_hash: "d".repeat(64) }] }] } },
    { name: "origin", proposal: { ...base.proposal, claims: [{ ...base.proposal.claims[0]!, origin_ids: [] }] } },
    { name: "model run", proposal: { ...base.proposal, model_runs: [{ ...base.proposal.model_runs[0]!, model_version: "other-synthetic-model" }] } },
    { name: "conflict", input: { ...base.input, policyInput: { ...base.input.policyInput, groundingContext: { ...base.input.policyInput.groundingContext, conflicts: ["synthetic conflict"] } } } },
    { name: "retrieval candidate", input: { ...base.input, policyInput: { ...base.input.policyInput, retrieval: { ...base.input.policyInput.retrieval, candidates: base.input.policyInput.retrieval.candidates.map((candidate, index) => index === 0 ? { ...candidate, candidateId: "candidate-other" } : candidate) } } } },
    { name: "reasoning evidence", input: { ...base.input, policyInput: { ...base.input.policyInput, reasoningResult: { ...base.input.policyInput.reasoningResult, claims: [{ ...base.input.policyInput.reasoningResult.claims[0]!, support: [{ ...SUPPORT, spanEnd: 8 }] }] } } } },
  ];
  for (const entry of cases) {
    const ports = makePorts(entry.proposal ?? base.proposal);
    assert.deepEqual(await createManualPublicationService(ports.reader, ports.writer).publish(entry.input ?? base.input), { status: "denied", code: "proposal_policy_mismatch" }, entry.name);
    assert.deepEqual(ports.calls, [], entry.name);
  }
});

test("unresolved, disputed, stale, held, and unauthorized inputs never reach the writer", async () => {
  const cases: Fixture[] = [
    makeFixture({ claim: { ...makeClaim(), supportAssessment: "disputed" } }),
    makeFixture({ claim: { ...makeClaim(), supportAssessment: "uncertain" } }),
    makeFixture({ decision: { ...DECISION, action: "hold" } }),
    makeFixture({ decision: { ...DECISION, trustedCallerAuthorized: false } }),
    makeFixture({ decision: null }),
  ];
  const unresolved = makeFixture();
  cases.push({ ...unresolved,
    input: { ...unresolved.input, policyInput: { ...unresolved.input.policyInput, reasoningResult: { ...unresolved.input.policyInput.reasoningResult, unresolvedFields: ["synthetic-gap"] } } },
    proposal: { ...unresolved.proposal, unresolved_fields: ["synthetic-gap"] },
  });
  const stale = makeFixture();
  cases.push({ ...stale,
    input: { ...stale.input, policyInput: { ...stale.input.policyInput, currentEvidenceStates: stale.input.policyInput.currentEvidenceStates.map((state) => ({ ...state, freshness: "needs_update" as const })) } },
  });
  for (const fixture of cases) {
    const ports = makePorts(fixture.proposal);
    assert.deepEqual(await createManualPublicationService(ports.reader, ports.writer).publish(fixture.input), { status: "denied", code: "publication_not_authorized" });
    assert.deepEqual(ports.calls, []);
  }
});

test("malformed policy input and target drafts are denied before the writer", async () => {
  const fixture = makeFixture();
  const ports = makePorts(fixture.proposal);
  const service = createManualPublicationService(ports.reader, ports.writer);
  const malformed = { ...fixture.input, policyInput: { ...fixture.input.policyInput, groundingContext: null } } as unknown as ManualPublicationServiceInput;
  assert.deepEqual(await service.publish(malformed), { status: "denied", code: "proposal_policy_mismatch" });
  const badDraft = { ...fixture.input, eventDraft: { ...fixture.input.eventDraft, version: 7 } };
  assert.deepEqual(await service.publish(badDraft), { status: "denied", code: "invalid_write_draft" });
  assert.deepEqual(ports.calls, []);
});

test("writer-inexpressible updates relations fail closed instead of changing lineage", async () => {
  const fixture = makeFixture({ contextRelationUpdates: true });
  const ports = makePorts(fixture.proposal);
  assert.deepEqual(await createManualPublicationService(ports.reader, ports.writer).publish(fixture.input), { status: "denied", code: "invalid_write_draft" });
  assert.deepEqual(ports.calls, []);
});

test("normalizes success, replay, conflicts, exceptions, and malformed writer receipts", async () => {
  const fixture = makeFixture();
  for (const outcome of ["written", "replayed"] as const) {
    const ports = makePorts(fixture.proposal, async (command) => ({ outcome, decisionId: command.decisionId, eventId: command.event.event_id, eventVersion: command.event.version }));
    assert.deepEqual(await createManualPublicationService(ports.reader, ports.writer).publish(fixture.input), {
      status: outcome, receipt: { outcome, decisionId: "decision-synthetic-001", eventId: "event-synthetic-new", eventVersion: 1 },
    });
  }
  for (const code of ["idempotency_key_reused", "stale_event_version", "event_version_exists"] as const) {
    const ports = makePorts(fixture.proposal, async () => ({ outcome: "conflict", code }));
    assert.deepEqual(await createManualPublicationService(ports.reader, ports.writer).publish(fixture.input), { status: "conflict", code });
  }
  const failed = makePorts(fixture.proposal, async () => { throw new Error("private content"); });
  assert.deepEqual(await createManualPublicationService(failed.reader, failed.writer).publish(fixture.input), { status: "denied", code: "writer_failed" });
  const malformed = makePorts(fixture.proposal, async () => ({ outcome: "written", decisionId: "wrong", eventId: "private detail", eventVersion: 1 } as unknown as PublicationWriteResult));
  assert.deepEqual(await createManualPublicationService(malformed.reader, malformed.writer).publish(fixture.input), { status: "denied", code: "writer_failed" });
});

test("uses only the reader/writer ports and does not register a route or runtime operation", () => {
  const testDirectory = fileURLToPath(new URL(".", import.meta.url));
  const workerRoot = join(testDirectory, "..", "src");
  const serviceFile = join(workerRoot, "layers", "l4-application-integration", "manual-publication-service.ts");
  const source = readFileSync(serviceFile, "utf8");
  assert.deepEqual([...source.matchAll(/from ["']([^"']+)["']/gu)].map((match) => match[1]), [
    "../../../../db/src/event-proposals.js", "../../../../db/src/publication-writer.js", "../l2-model-grounding/contracts.js", "./publication-policy.js",
  ]);
  assert.doesNotMatch(source, /\bfetch\s*\(|\bnew\s+(?:Pool|Client)\b|\bprovider\b|\bsourceAccess\b/iu);
  const matches: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (/\.tsx?$/u.test(entry.name) && path !== serviceFile && readFileSync(path, "utf8").includes("manual-publication-service")) matches.push(path);
    }
  };
  visit(workerRoot);
  assert.deepEqual(matches, []);
});
