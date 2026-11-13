import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { applyMigrations, readMigrations } from '../src/migrations.js';
import {
  createSqlInvestigationLedgerRepository,
  type CreateInvestigationInput,
  type InvestigationLedgerRepository,
} from '../src/investigation-ledger.js';
import {
  createSqlEventProposalReader,
  createSqlEventProposalRepository,
} from '../src/event-proposals.js';
import type { EvidenceRetrievalCandidate } from '../src/evidence-retrieval.js';
import type { GroundingContextRecord } from '../src/grounding-contexts.js';
import { createPublicEventListRepository } from '../src/public-event-list.js';
import { createPublicEventSnapshotRepository } from '../src/public-event-snapshot.js';
import {
  SqlPublicationWriter,
  type PublicationEventVersionDraft,
  type PublicationImpactVersionDraft,
} from '../src/publication-writer.js';
import { createReasoningProposalBridge } from '../../worker/src/layers/l2-model-grounding/reasoning-proposal-bridge.js';
import type {
  CapabilityOutcome,
  EvidenceReference,
  GroundingContext,
  ProposedClaim,
  ReasoningResult,
} from '../../worker/src/layers/l2-model-grounding/contracts.js';
import {
  createManualPublicationService,
  type ManualPublicationServiceInput,
} from '../../worker/src/layers/l4-application-integration/manual-publication-service.js';
import {
  assessPublicationPolicy,
  type CurrentEvidenceState,
  type PublicationPolicyInput,
} from '../../worker/src/layers/l4-application-integration/publication-policy.js';
import { createTestDatabase, type TestDatabase } from './harness.js';

// Authored synthetic fixture only. No real source, reviewer, or incident is asserted.
const NOW = '2026-10-08T03:00:00Z';
const LEDGER_REQUESTED_AT = '2026-10-08T02:00:00Z';
const LEDGER_RESERVED_AT = '2026-10-08T02:01:00Z';
const LEDGER_RELEASED_AT = '2026-10-08T02:01:30Z';
const LEDGER_PAUSED_AT = '2026-10-08T02:02:00Z';
const LEDGER_RESUMED_AT = '2026-10-08T02:03:00Z';
const LEDGER_STOPPED_AT = '2026-10-08T02:04:00Z';
const PROPOSED_AT = '2026-10-08T02:05:00.000000Z';
const REPORT_TEXT = 'Synthetic fixture claim one; Synthetic fixture claim two.';
const REPORT_HASH = sha256(REPORT_TEXT);
const CLAIM_TEXTS = ['Synthetic fixture claim one', 'Synthetic fixture claim two'] as const;
const CONFLICT = 'synthetic reports disagree on current service status';
const MISSING_FIELD = 'service_resume_confirmation';
const RETRIEVAL_VERSION = 'hybrid-evidence-v2' as const;
const INDEX_VERSION = 'synthetic-index-v1';
const FINGERPRINT_KEY_ID = 'fixture-hmac-v1';
const MODERATOR_ROLE = 'waspada_l4_moderator_publication_writer';
const PROPOSAL_ROLE = 'waspada_l2_proposal_writer';
const PUBLIC_ROLE = 'waspada_public_reader';
const MODERATOR_ACTOR = 'synthetic-reviewer-fixture-only';
const MODEL_RUN = {
  capability: 'reasoning' as const,
  modelVersion: 'synthetic-l3-gate-model-v1',
  promptVersion: 'synthetic-l3-gate-prompt-v1',
  inputTokens: 17,
  outputTokens: 8,
};

interface ClaimFixture {
  readonly text: string;
  readonly spanText: string;
  readonly spanStart: number;
  readonly spanEnd: number;
  readonly originId: string;
  readonly reference: EvidenceReference;
}

interface Scenario {
  readonly suffix: string;
  readonly traceId: string;
  readonly candidateId: string;
  readonly sourceId: string;
  readonly revisionId: string;
  readonly investigationId: string;
  readonly reservationId: string;
  readonly initialContextId: string;
  readonly refreshedContextId: string;
  readonly proposalId: string;
  readonly eventId: string;
  readonly impactId: string;
  readonly decisionId: string;
  readonly idempotencyKey: string;
  readonly claims: readonly ClaimFixture[];
  readonly refreshedContext: GroundingContext;
  readonly refreshedRecord: GroundingContextRecord;
}

test('L3 ledger supported context is bridged to a canonical proposal, published by the manual gate, and read publicly', async () => {
  const scenario = makeScenario('supported', { conflicts: [], missingFields: [] });
  const db = await openDatabase();
  try {
    const evidenceRefIds = await seedDatabase(db, scenario);
    const ledger = createSqlInvestigationLedgerRepository(db.executor);
    await driveLedgerToRefreshedContext(ledger, scenario);

    // L3 outcome: the open case points at the refreshed sufficient context with no conflict.
    const latest = await ledger.getLatest('live', scenario.investigationId);
    assert.ok(latest);
    assert.equal(latest.case_status, 'open');
    assert.equal(latest.stop_reason, null);
    assert.equal(latest.context_id, scenario.refreshedContextId);

    const reasoning = buildReasoning(scenario, 'supported', []);
    const proposal = await persistProposal(db, scenario, reasoning, latest.investigation_id);
    assert.equal(proposal.trace_id, scenario.traceId);
    assert.equal(proposal.investigation_id, scenario.investigationId);
    assert.deepEqual(proposal.claims.map((claim) => claim.support_assessment), ['supported', 'supported']);

    const input = buildGateInput(scenario, evidenceRefIds, reasoning);
    const beforeGate = await readPublic(db, scenario.eventId);
    assert.deepEqual(beforeGate, { snapshot: 'missing', eventVersion: null, impactCount: null, listedEventIds: [] });

    const service = createManualPublicationService(
      createSqlEventProposalReader(db.executor),
      new SqlPublicationWriter(db.executor),
    );
    const outcome = await asRole(db, MODERATOR_ROLE, () => service.publish(input));
    assert.deepEqual(outcome, {
      status: 'written',
      receipt: {
        outcome: 'written',
        decisionId: scenario.decisionId,
        eventId: scenario.eventId,
        eventVersion: 1,
      },
    });

    const decisions = await db.executor.query<{ reviewer_id: string; proposal_id: string; event_version: number }>(
      `SELECT reviewer_id, proposal_id, event_version
         FROM waspada.publication_decisions
        WHERE dataset_kind = 'live' AND decision_id = $1`,
      [scenario.decisionId],
    );
    assert.deepEqual(decisions.rows, [{
      reviewer_id: MODERATOR_ACTOR,
      proposal_id: scenario.proposalId,
      event_version: 1,
    }]);

    const afterGate = await readPublic(db, scenario.eventId);
    assert.deepEqual(afterGate, {
      snapshot: 'found',
      eventVersion: 1,
      impactCount: 1,
      listedEventIds: [scenario.eventId],
    });
  } finally {
    await db.close();
  }
});

test('L3 stopped case with a disputed claim is held by the publication gate before any write or public read', async () => {
  const scenario = makeScenario('held', { conflicts: [CONFLICT], missingFields: [MISSING_FIELD] });
  const db = await openDatabase();
  try {
    const evidenceRefIds = await seedDatabase(db, scenario);
    const ledger = createSqlInvestigationLedgerRepository(db.executor);
    await driveLedgerToRefreshedContext(ledger, scenario);

    // L3 outcome: the refreshed context carries a conflict, so the case stops for review.
    const open = await ledger.getLatest('live', scenario.investigationId);
    assert.ok(open);
    const stopped = await ledger.terminate({
      datasetKind: 'live',
      investigationId: scenario.investigationId,
      expectedCheckpointVersion: open.checkpoint_version,
      status: 'stopped_for_review',
      stopReason: 'material_conflict',
      completedAt: LEDGER_STOPPED_AT,
    });
    assert.equal(stopped.checkpoint.case_status, 'stopped_for_review');
    assert.equal(stopped.checkpoint.stop_reason, 'material_conflict');
    assert.equal(stopped.checkpoint.context_id, scenario.refreshedContextId);

    // The proposal keeps the flagged claim and the unresolved field exactly as the L2 output stated them.
    const reasoning = buildReasoning(scenario, 'disputed', [MISSING_FIELD]);
    const proposal = await persistProposal(db, scenario, reasoning, stopped.checkpoint.investigation_id);
    assert.deepEqual(proposal.claims.map((claim) => claim.support_assessment), ['supported', 'disputed']);
    assert.deepEqual(proposal.unresolved_fields, [MISSING_FIELD]);

    const input = buildGateInput(scenario, evidenceRefIds, reasoning);
    const assessment = assessPublicationPolicy(input.policyInput);
    assert.equal(assessment.disposition, 'hold');
    assert.ok(assessment.reasonCodes.includes('unresolved_fields'));
    assert.ok(assessment.claims[1]?.reasonCodes.includes('claim_not_supported'));
    assert.deepEqual(assessment.conflicts, [CONFLICT]);

    const service = createManualPublicationService(
      createSqlEventProposalReader(db.executor),
      new SqlPublicationWriter(db.executor),
    );
    // Even an explicit moderator approval cannot publish a held assessment.
    const outcome = await asRole(db, MODERATOR_ROLE, () => service.publish(input));
    assert.deepEqual(outcome, { status: 'denied', code: 'publication_not_authorized' });

    assert.deepEqual(await publicationFootprint(db), {
      publication_decisions: 0,
      event_versions: 0,
      impact_versions: 0,
      publication_outbox: 0,
      publication_write_receipts: 0,
      audit_records: 0,
    });
    assert.deepEqual(await readPublic(db, scenario.eventId), {
      snapshot: 'missing',
      eventVersion: null,
      impactCount: null,
      listedEventIds: [],
    });
  } finally {
    await db.close();
  }
});

function makeScenario(
  suffix: string,
  options: { readonly conflicts: readonly string[]; readonly missingFields: readonly string[] },
): Scenario {
  const traceId = `trace-l3-gate-${suffix}`;
  const candidateId = `candidate-l3-gate-${suffix}`;
  const sourceId = `source-l3-gate-${suffix}`;
  const revisionId = `revision-l3-gate-${suffix}`;
  const refreshedContextId = `context-l3-gate-${suffix}-refreshed`;
  const claims = CLAIM_TEXTS.map((text, index): ClaimFixture => {
    const spanStart = REPORT_TEXT.indexOf(text);
    const spanEnd = spanStart + text.length;
    const spanText = REPORT_TEXT.slice(spanStart, spanEnd);
    return {
      text,
      spanText,
      spanStart,
      spanEnd,
      originId: `origin-l3-gate-${suffix}-${index + 1}`,
      reference: {
        reportRevisionId: revisionId,
        permittedTextHash: REPORT_HASH,
        spanStart,
        spanEnd,
        offsetUnit: 'unicode_code_points',
        relation: 'supports',
      },
    };
  });
  const refreshedContext: GroundingContext = {
    schemaVersion: '2.0',
    recordType: 'GroundingContext',
    datasetKind: 'live',
    traceId,
    contextId: refreshedContextId,
    candidateId,
    evidence: claims.map((claim) => ({
      reference: claim.reference,
      text: claim.spanText,
      sourceId,
      revisionStatus: 'eligible' as const,
      publishedAt: null,
      observedAt: null,
      retrievedAt: NOW,
      origins: [{ originId: claim.originId, independenceStatus: 'unknown' as const, dependsOnOriginIds: [] }],
    })),
    revisionStates: [{ reportRevisionId: revisionId, revisionStatus: 'eligible' as const }],
    candidateEvents: [],
    priorDecisionIds: [],
    missingFields: [...options.missingFields],
    conflicts: [...options.conflicts],
    retrievalVersion: RETRIEVAL_VERSION,
    indexVersion: INDEX_VERSION,
    sufficient: true,
  };
  return {
    suffix,
    traceId,
    candidateId,
    sourceId,
    revisionId,
    investigationId: `investigation-l3-gate-${suffix}`,
    reservationId: `reservation-l3-gate-${suffix}`,
    initialContextId: `context-l3-gate-${suffix}-initial`,
    refreshedContextId,
    proposalId: `proposal-l3-gate-${suffix}`,
    eventId: `event-l3-gate-${suffix}`,
    impactId: `impact-l3-gate-${suffix}`,
    decisionId: `decision-l3-gate-${suffix}`,
    idempotencyKey: `idempotency-l3-gate-${suffix}`,
    claims,
    refreshedContext,
    refreshedRecord: persistedRecordOf(refreshedContext),
  };
}

async function openDatabase(): Promise<TestDatabase> {
  const db = await createTestDatabase();
  const migrations = await readMigrations(new URL('../migrations/', import.meta.url));
  await applyMigrations(db.executor, migrations);
  // The live namespace is only a fixture switch for this isolated test database.
  await db.executor.query(
    `INSERT INTO waspada.dataset_namespace_config (singleton, dataset_kind) VALUES (true, 'live')`,
  );
  return db;
}

async function seedDatabase(db: TestDatabase, s: Scenario): Promise<readonly string[]> {
  const executor = db.executor;
  await executor.query(
    `INSERT INTO waspada.traces (trace_id, dataset_kind, started_at, outcome, metadata)
     VALUES ($1, 'live', $2, 'open', $3::jsonb)`,
    [s.traceId, NOW, JSON.stringify({ fixture: 'authored synthetic test only' })],
  );
  await executor.query(
    `INSERT INTO waspada.source_registry
       (source_id, trace_id, registry_version, display_name, source_kind, remit,
        access_method, access_restrictions, reuse_basis, registry_status,
        approval_status, health_status, auto_acquisition_enabled, auto_publication_policy)
     VALUES ($1, $2, 1, 'Authored synthetic fixture only', 'other', ARRAY['test-only'],
        'manual_fixture', ARRAY['no real source rights are asserted'], ARRAY['synthetic fixture'],
        'active', 'approved', 'unknown', false, 'never')`,
    [s.sourceId, s.traceId],
  );
  await executor.query(
    `INSERT INTO waspada.report_revisions
       (dataset_kind, report_revision_id, trace_id, source_id, canonical_url,
        content_hash, permitted_text, permitted_text_hash, normalization_version,
        retrieved_at, revision_status, record_json)
     VALUES ('live', $1, $2, $3, 'https://example.invalid/synthetic-fixture',
        $4, $5, $4, 'synthetic-normalization-v1', $6, 'eligible', $7::jsonb)`,
    [s.revisionId, s.traceId, s.sourceId, REPORT_HASH, REPORT_TEXT, NOW,
      JSON.stringify({ fixture: 'authored synthetic; rights and quality not asserted' })],
  );
  await executor.query(
    `INSERT INTO waspada.extraction_results
       (dataset_kind, candidate_id, trace_id, report_revision_id, category, record_json)
     VALUES ('live', $1, $2, $3, 'transport_road_incidents', $4::jsonb)`,
    [s.candidateId, s.traceId, s.revisionId, JSON.stringify({ fixture: 'authored synthetic candidate' })],
  );
  // The initial context is insufficient, which is the only state the L3 ledger accepts for create.
  await executor.query(
    `INSERT INTO waspada.grounding_contexts
       (dataset_kind, context_id, trace_id, candidate_id, retrieval_version,
        index_version, sufficient, record_json)
     VALUES ('live', $1, $2, $3, $4, $5, false, $6::jsonb)`,
    [s.initialContextId, s.traceId, s.candidateId, RETRIEVAL_VERSION, INDEX_VERSION,
      JSON.stringify({ fixture: 'authored synthetic insufficient context' })],
  );

  const evidenceRefIds: string[] = [];
  for (const claim of s.claims) {
    await executor.query(
      `INSERT INTO waspada.evidence_origins
         (dataset_kind, origin_id, trace_id, origin_kind, actor_label, source_id,
          lineage_relation, independence_status, record_json)
       VALUES ('live', $1, $2, 'original_document', 'Authored synthetic fixture only', $3,
          'original', 'unknown', $4::jsonb)`,
      [claim.originId, s.traceId, s.sourceId, JSON.stringify({ fixture: 'synthetic provenance only' })],
    );
    const evidence = await executor.query<{ evidence_ref_id: string | number | bigint }>(
      `INSERT INTO waspada.evidence_references
         (dataset_kind, trace_id, report_revision_id, permitted_text_hash,
          span_start, span_end, offset_unit, relation)
       VALUES ('live', $1, $2, $3, $4, $5, 'unicode_code_points', 'supports')
       RETURNING evidence_ref_id::text AS evidence_ref_id`,
      [s.traceId, s.revisionId, REPORT_HASH, claim.spanStart, claim.spanEnd],
    );
    const evidenceRefId = String(evidence.rows[0]!.evidence_ref_id);
    await executor.query(
      `INSERT INTO waspada.origin_evidence (dataset_kind, origin_id, evidence_ref_id)
       VALUES ('live', $1, $2)`,
      [claim.originId, evidenceRefId],
    );
    evidenceRefIds.push(evidenceRefId);
  }

  await executor.query(
    `INSERT INTO waspada.grounding_contexts
       (dataset_kind, context_id, trace_id, candidate_id, retrieval_version,
        index_version, sufficient, record_json)
     VALUES ('live', $1, $2, $3, $4, $5, true, $6::jsonb)`,
    [s.refreshedContextId, s.traceId, s.candidateId, RETRIEVAL_VERSION, INDEX_VERSION,
      JSON.stringify(s.refreshedRecord)],
  );
  for (const evidenceRefId of evidenceRefIds) {
    await executor.query(
      `INSERT INTO waspada.grounding_evidence (dataset_kind, context_id, evidence_ref_id)
       VALUES ('live', $1, $2)`,
      [s.refreshedContextId, evidenceRefId],
    );
  }
  return evidenceRefIds;
}

async function driveLedgerToRefreshedContext(
  ledger: InvestigationLedgerRepository,
  s: Scenario,
): Promise<void> {
  const createInput: CreateInvestigationInput = {
    datasetKind: 'live',
    investigationId: s.investigationId,
    traceId: s.traceId,
    candidateId: s.candidateId,
    contextId: s.initialContextId,
    fingerprintKeyId: FINGERPRINT_KEY_ID,
    initialGroundingDigestHex: testDigest('initial-grounding'),
    eventId: null,
    eventVersion: null,
    questions: ['Which synthetic detail is still unknown?'],
    policyVersion: 'budget-policy-v1',
    limits: { toolAttempts: 5, reasoningTurns: 4, activeSeconds: 60, modelTokens: 12_000 },
    requestedAt: LEDGER_REQUESTED_AT,
  };
  const created = await ledger.create(createInput);
  assert.equal(created.context_id, s.initialContextId);
  assert.equal(created.case_status, 'open');

  // A reserved refresh action is released as uninvoked so the case can stop cleanly.
  const reserved = await ledger.reserveAction({
    datasetKind: 'live',
    investigationId: s.investigationId,
    reservationId: s.reservationId,
    expectedCheckpointVersion: created.checkpoint_version,
    actionKind: 'tool',
    actionFingerprint: testFingerprint('lookup.refresh'),
    actionName: 'lookup.refresh',
    reservedActiveSeconds: 8,
    reservedModelTokens: 0,
    reservedAt: LEDGER_RESERVED_AT,
  });
  const released = await ledger.releaseUninvoked({
    datasetKind: 'live',
    investigationId: s.investigationId,
    reservationId: s.reservationId,
    expectedCheckpointVersion: reserved.checkpoint.checkpoint_version,
    releasedAt: LEDGER_RELEASED_AT,
  });
  const paused = await ledger.pause({
    datasetKind: 'live',
    investigationId: s.investigationId,
    expectedCheckpointVersion: released.checkpoint.checkpoint_version,
    pausedAt: LEDGER_PAUSED_AT,
  });
  const resumed = await ledger.resume({
    datasetKind: 'live',
    investigationId: s.investigationId,
    expectedCheckpointVersion: paused.checkpoint.checkpoint_version,
    resumedAt: LEDGER_RESUMED_AT,
    contextId: s.refreshedContextId,
    progressFingerprint: testFingerprint('refreshed-grounding'),
  });
  assert.equal(resumed.checkpoint.context_id, s.refreshedContextId);
  assert.equal(resumed.checkpoint.case_status, 'open');
}

async function persistProposal(
  db: TestDatabase,
  s: Scenario,
  reasoning: ReasoningResult,
  investigationId: string,
) {
  const bridge = createReasoningProposalBridge(createSqlEventProposalRepository(db.executor));
  const capabilityOutcome: CapabilityOutcome<ReasoningResult, 'reasoning'> = {
    status: 'succeeded',
    capability: 'reasoning',
    value: reasoning,
  };
  const persisted = await asRole(db, PROPOSAL_ROLE, () => bridge.persist({
    capabilityOutcome,
    groundingContext: s.refreshedContext,
    persistedContextRecord: s.refreshedRecord,
    proposalId: s.proposalId,
    proposedAt: PROPOSED_AT,
    target: { kind: 'new' },
    investigationId,
  }));
  assert.equal(persisted.status, 'persisted');
  if (persisted.status !== 'persisted') assert.fail('the bridge must persist the canonical proposal');
  return persisted.proposal;
}

function buildReasoning(
  s: Scenario,
  secondAssessment: 'supported' | 'disputed',
  unresolvedFields: readonly string[],
): ReasoningResult {
  const claims: ProposedClaim[] = s.claims.map((claim, index) => ({
    text: claim.text,
    eventTime: { precision: 'unknown', start: null, end: null },
    validity: { validFrom: null, validUntil: null },
    scope: {
      placeIds: [],
      serviceIds: [`service-l3-gate-${s.suffix}`],
      institutionIds: [],
      audienceIds: [`audience-l3-gate-${s.suffix}`],
      geometryIds: [],
    },
    qualifiers: ['Authored synthetic fixture only.'],
    support: [claim.reference],
    contradictions: [],
    contextEvidence: [],
    supportAssessment: index === 0 ? 'supported' : secondAssessment,
  }));
  return {
    outcome: 'proposed',
    claims,
    unresolvedFields: [...unresolvedFields],
    conflicts: [...s.refreshedContext.conflicts],
    modelRun: MODEL_RUN,
    provider: 'synthetic-only',
  };
}

function buildGateInput(
  s: Scenario,
  evidenceRefIds: readonly string[],
  reasoning: ReasoningResult,
): ManualPublicationServiceInput {
  const candidates: EvidenceRetrievalCandidate[] = s.claims.map((claim, index) =>
    buildRetrievalCandidate(s, claim, evidenceRefIds[index]!));
  const currentEvidenceStates: CurrentEvidenceState[] = evidenceRefIds.map((evidenceReferenceId) => ({
    datasetKind: 'live',
    evidenceReferenceId,
    sourceId: s.sourceId,
    remit: 'in_scope',
    freshness: 'current',
  }));
  const policyInput: PublicationPolicyInput = {
    groundingContext: s.refreshedContext,
    reasoningResult: reasoning,
    retrieval: {
      datasetKind: 'live',
      retrievalVersion: RETRIEVAL_VERSION,
      indexVersion: INDEX_VERSION,
      candidates,
      rowsExamined: candidates.length,
      filteredRowsOmitted: 0,
      invalidSpanRowsOmitted: 0,
      scanTruncated: false,
      resultTruncated: false,
      semanticStatus: 'not_requested',
    },
    currentEvidenceStates,
    target: { kind: 'new' },
    currentEvent: null,
    moderatorDecision: {
      action: 'approve',
      actorId: MODERATOR_ACTOR,
      decidedAt: NOW,
      reason: 'Synthetic test approval only; no reviewer identity or authorization is asserted.',
      trustedCallerAuthorized: true,
      claimEvidenceLabels: [
        { claimId: 'claim-002', evidenceLabel: 'attributed_report' },
        { claimId: 'claim-001', evidenceLabel: 'issuer_notice' },
      ],
    },
  };
  const scope = {
    place_ids: [],
    service_ids: [`service-l3-gate-${s.suffix}`],
    institution_ids: [],
    audience_ids: [`audience-l3-gate-${s.suffix}`],
    geometry_ids: [],
  };
  const event: PublicationEventVersionDraft = {
    event_id: s.eventId,
    version: 1,
    supersedes_version: null,
    title: 'Synthetic fixture event title',
    summary: 'Authored synthetic summary; no real incident is asserted.',
    category: 'transport_road_incidents',
    tags: [],
    lifecycle: 'ongoing',
    freshness: { status: 'current', evaluated_at: NOW, review_due_at: null, basis: 'manual_review' },
    event_time: { start: null, end: null, precision: 'unknown' },
    validity: { valid_from: null, valid_until: null },
    scope,
    published_at: NOW,
  };
  const impact: PublicationImpactVersionDraft = {
    impact_id: s.impactId,
    version: 1,
    event_id: s.eventId,
    event_version: 1,
    impact_type: 'facility_closure',
    title: 'Synthetic fixture impact',
    description: 'Authored synthetic impact; no current real-world condition is asserted.',
    lifecycle: 'ongoing',
    freshness: event.freshness,
    event_time: event.event_time,
    validity: event.validity,
    scope,
    supporting_claim_ids: ['claim-001', 'claim-002'],
    published_at: NOW,
  };
  return {
    proposalId: s.proposalId,
    policyInput,
    eventDraft: event,
    impactDrafts: [impact],
    writeMetadata: {
      idempotencyKey: s.idempotencyKey,
      decisionId: s.decisionId,
      policyVersion: 'synthetic-publication-policy-v1',
    },
  };
}

function buildRetrievalCandidate(
  s: Scenario,
  claim: ClaimFixture,
  evidenceReferenceId: string,
): EvidenceRetrievalCandidate {
  return {
    datasetKind: 'live',
    candidateId: s.candidateId,
    reportRevisionId: s.revisionId,
    permittedTextHash: REPORT_HASH,
    evidenceReferenceId,
    spanStart: claim.spanStart,
    spanEnd: claim.spanEnd,
    offsetUnit: 'unicode_code_points',
    relation: 'supports',
    spanText: claim.spanText,
    spanTextStart: claim.spanStart,
    spanTextEnd: claim.spanEnd,
    spanTextTruncated: false,
    revisionStatus: 'eligible',
    source: {
      sourceId: s.sourceId,
      displayName: 'Authored synthetic fixture only',
      sourceKind: 'other',
      publisherGroupId: null,
      registryStatus: 'active',
      approvalStatus: 'approved',
      healthStatus: 'unknown',
    },
    publishedAt: null,
    observedAt: null,
    retrievedAt: NOW,
    validFrom: null,
    validUntil: null,
    eventTime: { start: null, end: null, precision: 'unknown', status: 'unknown' },
    origins: [{
      originId: claim.originId,
      originKind: 'original_document',
      sourceId: s.sourceId,
      lineageRelation: 'original',
      independenceStatus: 'unknown',
      dependsOnOriginIds: [],
    }],
    originLineageStatus: 'recorded',
    geometryMatches: [],
    chunk: null,
    matchFacets: {
      identifiers: [],
      audienceIds: [],
      exactTerms: [],
      reportTimeFields: [],
      eventTime: false,
      geometry: false,
      semanticDistance: null,
    },
  };
}

async function readPublic(db: TestDatabase, eventId: string): Promise<{
  readonly snapshot: 'found' | 'missing';
  readonly eventVersion: number | null;
  readonly impactCount: number | null;
  readonly listedEventIds: readonly string[];
}> {
  return asRole(db, PUBLIC_ROLE, async () => {
    const snapshot = await createPublicEventSnapshotRepository(db.executor).read(eventId);
    const page = await createPublicEventListRepository(db.executor).read();
    return {
      snapshot: snapshot.kind,
      eventVersion: snapshot.kind === 'found' ? snapshot.snapshot.eventVersion : null,
      impactCount: snapshot.kind === 'found' ? snapshot.snapshot.impacts.length : null,
      listedEventIds: page.candidates.map((candidate) => candidate.eventId),
    };
  });
}

async function publicationFootprint(db: TestDatabase): Promise<Record<string, number>> {
  const result = await db.executor.query<Record<string, string>>(
    `SELECT
       (SELECT count(*)::text FROM waspada.publication_decisions) AS publication_decisions,
       (SELECT count(*)::text FROM waspada.event_versions) AS event_versions,
       (SELECT count(*)::text FROM waspada.impact_versions) AS impact_versions,
       (SELECT count(*)::text FROM waspada.publication_outbox) AS publication_outbox,
       (SELECT count(*)::text FROM waspada.publication_write_receipts) AS publication_write_receipts,
       (SELECT count(*)::text FROM waspada.audit_records) AS audit_records`,
  );
  const row = result.rows[0];
  assert.ok(row);
  return Object.fromEntries(Object.entries(row).map(([name, value]) => [name, Number(value)]));
}

async function asRole<Result>(
  db: TestDatabase,
  role: string,
  operation: () => Promise<Result>,
): Promise<Result> {
  await db.executor.execute(`SET ROLE ${role}`);
  try {
    const current = await db.executor.query<{ current_user: string }>('SELECT current_user');
    assert.equal(current.rows[0]?.current_user, role);
    return await operation();
  } finally {
    await db.executor.execute('RESET ROLE');
  }
}

function persistedRecordOf(context: GroundingContext): GroundingContextRecord {
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

function testDigest(value: string): string {
  return sha256('fixture-digest:' + value);
}

function testFingerprint(value: string): { readonly keyId: string; readonly digestHex: string } {
  return { keyId: FINGERPRINT_KEY_ID, digestHex: testDigest(value) };
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
