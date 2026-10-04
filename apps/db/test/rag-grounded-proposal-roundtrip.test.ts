import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import {
  createSqlExactEvidenceSpanReader,
  type EvidenceRetrievalCandidate,
} from '../src/evidence-retrieval.js';
import { applyMigrations, readMigrations } from '../src/migrations.js';
import {
  createRepositoryPorts,
  type NewReportRevision,
} from '../src/ports.js';
import type { GroundingContextRecord } from '../src/grounding-contexts.js';
import {
  createDirectReasoningService,
} from '../../worker/src/layers/l2-model-grounding/direct-reasoning.js';
import {
  assembleGroundingReasoningRequest,
  GroundingContextAssemblyError,
} from '../../worker/src/layers/l2-model-grounding/grounding-context.js';
import {
  createReasoningContextPersister,
} from '../../worker/src/layers/l2-model-grounding/context-persistence.js';
import {
  createReasoningProposalBridge,
} from '../../worker/src/layers/l2-model-grounding/reasoning-proposal-bridge.js';
import type {
  CapabilityOutcome,
  GroundingContext,
  ReasoningRequest,
  ReasoningResult,
} from '../../worker/src/layers/l2-model-grounding/contracts.js';
import { createTestDatabase, type TestDatabase } from './harness.js';

const DATASET = 'synthetic' as const;
const TRACE_ID = 'trace-rag-proposal-roundtrip';
const SOURCE_ID = 'source-rag-proposal-roundtrip';
const CANDIDATE_ID = 'candidate-rag-proposal-roundtrip';
const REVISION_ID = 'revision-rag-proposal-roundtrip';
const ORIGIN_ID = 'origin-rag-proposal-roundtrip';
const CONTEXT_ID = 'context-rag-proposal-roundtrip';
const INSUFFICIENT_CONTEXT_ID = 'context-rag-proposal-insufficient';
const PROPOSAL_ID = 'proposal-rag-proposal-roundtrip';
const BLOCKED_CONTEXT_ID = 'context-rag-source-invalidated';
const BLOCKED_PROPOSAL_ID = 'proposal-rag-source-invalidated';
const BASELINE_PUBLIC_EVENT_ID = 'event-rag-source-gate-baseline';
const BASELINE_PUBLIC_PROPOSAL_ID = 'proposal-rag-source-gate-baseline';
const BASELINE_PUBLIC_CONTEXT_ID = 'context-rag-source-gate-baseline';
const BASELINE_PUBLIC_DECISION_ID = 'decision-rag-source-gate-baseline';
const BASELINE_PUBLIC_CLAIM_ID = 'claim-rag-source-gate-baseline';
const PROPOSED_AT = '2026-09-26T14:30:00.123456+07:00';
const EVENT_TIME = '2026-09-26T09:01:02.123456+02:00';
const SYNTHETIC_CONFLICT = 'An authored fixture note records an unresolved status discrepancy.';
const RETRIEVAL_INDEX_VERSION = 'roundtrip-index-v1';
const EMBEDDING_IDENTITY = {
  provider: 'synthetic-test-only',
  modelVersion: 'roundtrip-embedding-v1',
  dimensions: 2,
  distanceMetric: 'cosine' as const,
  vectorIndexVersion: RETRIEVAL_INDEX_VERSION,
};
const AUTHORED_TEXT = 'Authored synthetic notice: the fictional crossing near the civic hall is closed 😀.';
const SELECTED_SPAN = 'fictional crossing near the civic hall is closed 😀';
const SELECTED_SPAN_START = Array.from(
  AUTHORED_TEXT.slice(0, AUTHORED_TEXT.indexOf(SELECTED_SPAN)),
).length;
const SELECTED_SPAN_END = SELECTED_SPAN_START + Array.from(SELECTED_SPAN).length;
const PUBLISHED_AT = '2026-09-26T12:34:56.123456+05:30';
const OBSERVED_AT = '2026-09-26T08:09:10.000007-04:00';
const RETRIEVED_AT = '2026-09-26T13:14:15.987654+07:00';

describe('RAG grounded proposal roundtrip', () => {
  let testDatabase: TestDatabase;
  let ports: ReturnType<typeof createRepositoryPorts>;
  let permittedTextHash: string;
  let evidenceReferenceId: string;

  before(async () => {
    testDatabase = await createTestDatabase();
    const migrations = await readMigrations(new URL('../migrations/', import.meta.url));
    await applyMigrations(testDatabase.executor, migrations);
    ports = createRepositoryPorts(testDatabase.executor);
    await seedPersistedEvidence();
  });

  after(async () => testDatabase?.close());

  it('grounds persisted evidence before reasoning, then writes and exactly replays one private draft', async () => {
    const protectedBefore = await protectedWriteCounts();
    const assembled = await assembleContext(CONTEXT_ID, true, [], [SYNTHETIC_CONFLICT]);
    assert.deepEqual(await contextRows(CONTEXT_ID), [], 'reasoning context is not pre-created');

    let reasoningCalls = 0;
    let reasoningRequestAtCall: ReasoningRequest | undefined;
    const contextPersister = createReasoningContextPersister(ports.groundingContexts);
    const directReasoning = createDirectReasoningService(contextPersister, {
      async reason(request: ReasoningRequest): Promise<CapabilityOutcome<ReasoningResult, 'reasoning'>> {
        reasoningCalls += 1;
        reasoningRequestAtCall = request;

        const role = await testDatabase.executor.query<{ current_user: string }>(
          'SELECT current_user::text AS current_user',
        );
        assert.equal(role.rows[0]?.current_user, 'waspada_l2_grounding_writer');
        const rows = await testDatabase.executor.query<{
          context_id: string;
          sufficient: boolean;
          record_json: string;
        }>(
          'SELECT context_id, sufficient, record_json::text AS record_json '
            + 'FROM waspada.grounding_contexts WHERE dataset_kind = $1 AND context_id = $2',
          [DATASET, CONTEXT_ID],
        );
        assert.equal(rows.rows.length, 1, 'the refs-only context is committed before reasoning begins');
        assert.equal(rows.rows[0]?.sufficient, true);
        const stored = rows.rows[0]!.record_json;
        assert.equal(stored.includes(SELECTED_SPAN), false, 'stored context contains references, not excerpts');
        assert.equal(Object.hasOwn(JSON.parse(stored).evidence[0], 'text'), false);
        assert.deepEqual(request.data.groundingContext, assembled.reasoningRequest.data.groundingContext);
        assert.equal(request.data.groundingContext.evidence[0]?.text, SELECTED_SPAN);

        return {
          status: 'succeeded',
          capability: 'reasoning',
          value: fixedReasoningResult(request.data.groundingContext),
        };
      },
    });

    const directOutcome = await withRole('waspada_l2_grounding_writer', () =>
      directReasoning.reason(assembled.reasoningRequest));
    assert.equal(directOutcome.status, 'succeeded');
    if (directOutcome.status !== 'succeeded') assert.fail('expected the fixed reasoning result');
    assert.equal(directOutcome.capability, 'reasoning');
    assert.equal(reasoningCalls, 1);
    assert.ok(reasoningRequestAtCall);

    const persistedRows = await contextRows(CONTEXT_ID);
    assert.equal(persistedRows.length, 1);
    const persistedRecord = JSON.parse(persistedRows[0]!.record_json) as GroundingContextRecord;
    assert.deepEqual(persistedRecord, {
      schema_version: '2.0',
      trace_id: TRACE_ID,
      record_type: 'GroundingContext',
      dataset_kind: DATASET,
      context_id: CONTEXT_ID,
      candidate_id: CANDIDATE_ID,
      evidence: [{
        report_revision_id: REVISION_ID,
        permitted_text_hash: permittedTextHash,
        span_start: SELECTED_SPAN_START,
        span_end: SELECTED_SPAN_END,
        offset_unit: 'unicode_code_points',
        relation: 'supports',
      }],
      revision_states: [{ report_revision_id: REVISION_ID, revision_status: 'eligible' }],
      candidate_events: [],
      prior_decision_ids: [],
      missing_fields: [],
      conflicts: [SYNTHETIC_CONFLICT],
      retrieval_version: 'hybrid-evidence-v1',
      index_version: RETRIEVAL_INDEX_VERSION,
      sufficient: true,
    });
    assert.equal(persistedRows[0]!.record_json.includes(SELECTED_SPAN), false);

    const bridgeInput = {
      capabilityOutcome: directOutcome,
      groundingContext: reasoningRequestAtCall.data.groundingContext,
      persistedContextRecord: persistedRecord,
      proposalId: PROPOSAL_ID,
      proposedAt: PROPOSED_AT,
      target: { kind: 'new' as const },
      investigationId: null,
    };
    const bridge = createReasoningProposalBridge(ports.eventProposals);
    const first = await withRole('waspada_l2_proposal_writer', () => bridge.persist(bridgeInput));
    assert.equal(first.status, 'persisted');
    if (first.status !== 'persisted') assert.fail('expected the canonical private proposal');
    const countsAfterFirst = await privateProposalCounts(PROPOSAL_ID);
    assert.deepEqual(countsAfterFirst, {
      proposals: '1',
      claims: '1',
      evidenceLinks: '1',
      originLinks: '1',
    });

    const replay = await withRole('waspada_l2_proposal_writer', () => bridge.persist(bridgeInput));
    assert.deepEqual(replay, first, 'an exact retry returns the same immutable draft');
    assert.deepEqual(await privateProposalCounts(PROPOSAL_ID), countsAfterFirst,
      'an exact retry adds no proposal, claim, evidence, or origin rows');

    const proposal = first.proposal;
    assert.equal(proposal.schema_version, '2.0');
    assert.equal(proposal.dataset_kind, DATASET);
    assert.equal(proposal.trace_id, TRACE_ID);
    assert.equal(proposal.candidate_id, CANDIDATE_ID);
    assert.equal(proposal.context_id, CONTEXT_ID);
    assert.equal(proposal.proposal_id, PROPOSAL_ID);
    assert.equal(proposal.event_id, null);
    assert.equal(proposal.base_event_version, null);
    assert.equal(proposal.investigation_id, null);
    assert.equal(proposal.proposed_at, PROPOSED_AT);
    assert.deepEqual(proposal.claims[0]?.support, [{
      report_revision_id: REVISION_ID,
      permitted_text_hash: permittedTextHash,
      span_start: SELECTED_SPAN_START,
      span_end: SELECTED_SPAN_END,
      offset_unit: 'unicode_code_points',
      relation: 'supports',
    }]);
    assert.deepEqual(proposal.claims[0]?.origin_ids, [ORIGIN_ID]);
    assert.equal(proposal.claims[0]?.support_assessment, 'uncertain');
    assert.equal(proposal.claims[0]?.evidence_label, 'under_review');
    assert.deepEqual(proposal.claims[0]?.event_time, {
      precision: 'exact',
      start: EVENT_TIME,
      end: null,
    });
    assert.deepEqual(proposal.model_runs, [{
      capability: 'reasoning',
      model_version: 'synthetic-reasoner-v1',
      prompt_version: 'synthetic-reasoning-prompt-v2',
      input_tokens: 17,
      output_tokens: 8,
    }]);
    assert.equal(JSON.stringify(proposal).includes('synthetic-test-provider'), false,
      'the schema 2.0 ModelRun preserves its declared identity fields without adding a provider field');

    const normalizedEvidence = await testDatabase.executor.query<{
      evidence_kind: string;
      evidence_ref_id: string;
    }>(
      'SELECT evidence_kind, evidence_ref_id::text AS evidence_ref_id '
        + 'FROM waspada.proposal_claim_evidence WHERE dataset_kind = $1 AND proposal_id = $2',
      [DATASET, PROPOSAL_ID],
    );
    assert.deepEqual(normalizedEvidence.rows, [{ evidence_kind: 'support', evidence_ref_id: evidenceReferenceId }]);
    const normalizedOrigins = await testDatabase.executor.query<{ origin_id: string }>(
      'SELECT origin_id FROM waspada.proposal_claim_origins '
        + 'WHERE dataset_kind = $1 AND proposal_id = $2',
      [DATASET, PROPOSAL_ID],
    );
    assert.deepEqual(normalizedOrigins.rows, [{ origin_id: ORIGIN_ID }]);
    const storedProposal = await testDatabase.executor.query<{ record_json: string }>(
      'SELECT record_json::text AS record_json FROM waspada.event_proposals '
        + 'WHERE dataset_kind = $1 AND proposal_id = $2',
      [DATASET, PROPOSAL_ID],
    );
    assert.equal(storedProposal.rows.length, 1);
    assert.deepEqual(JSON.parse(storedProposal.rows[0]!.record_json), proposal);
    assert.deepEqual(await protectedWriteCounts(), protectedBefore,
      'proposal generation and replay do not write events, decisions, audit, outbox, or moderator reviews');
  });

  it('persists an insufficient refs-only context and stops before reasoning or proposal creation', async () => {
    const protectedBefore = await protectedWriteCounts();
    const proposalCountsBefore = await privateProposalCounts(PROPOSAL_ID);
    const assembled = await assembleContext(INSUFFICIENT_CONTEXT_ID, false, ['fictional_current_status']);
    let reasoningCalls = 0;
    const contextPersister = createReasoningContextPersister(ports.groundingContexts);
    const directReasoning = createDirectReasoningService(contextPersister, {
      async reason(): Promise<CapabilityOutcome<ReasoningResult, 'reasoning'>> {
        reasoningCalls += 1;
        assert.fail('insufficient context must stop before reasoning');
      },
    });

    const outcome = await withRole('waspada_l2_grounding_writer', () =>
      directReasoning.reason(assembled.reasoningRequest));
    assert.equal(outcome.status, 'investigation_required');
    if (outcome.status !== 'investigation_required') assert.fail('expected insufficient-context stop');
    assert.equal(outcome.persistedRecord.sufficient, false);
    assert.deepEqual(outcome.persistedRecord.missing_fields, ['fictional_current_status']);
    assert.equal(reasoningCalls, 0);

    const rows = await contextRows(INSUFFICIENT_CONTEXT_ID);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.record_json.includes(SELECTED_SPAN), false);
    assert.equal(JSON.parse(rows[0]!.record_json).sufficient, false);
    assert.deepEqual(await privateProposalCounts(PROPOSAL_ID), proposalCountsBefore,
      'the insufficient-context path creates no private proposal');
    assert.deepEqual(await protectedWriteCounts(), protectedBefore,
      'the insufficient-context path creates no public, audit, outbox, or moderator record');
  });

  it('blocks the reasoning and proposal path after source invalidation without changing public state', async () => {
    await seedPublicBaselineWithFreshness();
    const publicBeforeAssertion = await publicAndFreshnessSnapshot();
    const sideEffectsBeforeAssertion = await sourceGateSideEffectCounts();
    assert.equal(publicBeforeAssertion.publicEvents.length, 1);
    assert.equal(publicBeforeAssertion.publicEvents[0]?.event_id, BASELINE_PUBLIC_EVENT_ID);
    assert.equal(publicBeforeAssertion.publicEvents[0]?.freshness_status, 'needs_update');
    assert.equal(publicBeforeAssertion.freshnessTransitions.length, 1);

    await testDatabase.executor.query(
      `INSERT INTO waspada.report_revision_source_observations
         (dataset_kind, observation_id, trace_id, source_id, target_report_revision_id,
          assertion_report_revision_id, asserted_state, publisher_observed_at, retrieved_at)
       VALUES ($1, 'observation-rag-source-invalidated', $2, $3, $4, $4, 'retracted', $5, $6)`,
      [DATASET, TRACE_ID, SOURCE_ID, REVISION_ID, '2026-09-27T04:00:00Z', '2026-09-27T04:01:00Z'],
    );
    const publicAfterAssertion = await publicAndFreshnessSnapshot();
    assert.deepEqual(publicAfterAssertion, publicBeforeAssertion,
      'the source assertion leaves the existing public version and projected freshness unchanged');
    assert.deepEqual(await sourceGateSideEffectCounts(), sideEffectsBeforeAssertion,
      'recording a source assertion creates no publication, freshness, audit, outbox, or review writes');

    let reasoningCalls = 0;
    let proposalBridgeCalls = 0;
    let reasoningRequestAtCall: ReasoningRequest | undefined;
    const contextPersister = createReasoningContextPersister(ports.groundingContexts);
    const directReasoning = createDirectReasoningService(contextPersister, {
      async reason(request: ReasoningRequest): Promise<CapabilityOutcome<ReasoningResult, 'reasoning'>> {
        reasoningCalls += 1;
        reasoningRequestAtCall = request;
        return {
          status: 'succeeded',
          capability: 'reasoning',
          value: fixedReasoningResult(request.data.groundingContext),
        };
      },
    });
    const bridge = createReasoningProposalBridge(ports.eventProposals);

    const blockedPipeline = async () => {
      const assembled = await assembleContext(BLOCKED_CONTEXT_ID, true, [], [SYNTHETIC_CONFLICT]);
      const outcome = await withRole('waspada_l2_grounding_writer', () =>
        directReasoning.reason(assembled.reasoningRequest));
      if (outcome.status !== 'succeeded') assert.fail('a sufficient synthetic request should reach reasoning');
      proposalBridgeCalls += 1;
      const contextRow = (await contextRows(BLOCKED_CONTEXT_ID))[0];
      assert.ok(contextRow);
      const persistedRecord = JSON.parse(contextRow.record_json) as GroundingContextRecord;
      const request = reasoningRequestAtCall;
      assert.ok(request);
      return withRole('waspada_l2_proposal_writer', () => bridge.persist({
        capabilityOutcome: outcome,
        groundingContext: request.data.groundingContext,
        persistedContextRecord: persistedRecord,
        proposalId: BLOCKED_PROPOSAL_ID,
        proposedAt: PROPOSED_AT,
        target: { kind: 'new' },
        investigationId: null,
      }));
    };

    const sideEffectsBeforeBlockedPath = await sourceGateSideEffectCounts();
    await assert.rejects(
      blockedPipeline(),
      (error: unknown) => error instanceof GroundingContextAssemblyError
        && error.code === 'source_invalidated'
        && error.message === 'source_invalidated'
        && !error.message.includes(REVISION_ID)
        && !error.message.includes(SELECTED_SPAN),
    );
    assert.equal(reasoningCalls, 0, 'no reasoning request reaches the injected capability');
    assert.equal(proposalBridgeCalls, 0, 'the private proposal bridge is not invoked');
    assert.deepEqual(await contextRows(BLOCKED_CONTEXT_ID), [],
      'the denied request is not persisted as a grounding context');
    assert.deepEqual(await privateProposalCounts(BLOCKED_PROPOSAL_ID), {
      proposals: '0', claims: '0', evidenceLinks: '0', originLinks: '0',
    });
    assert.deepEqual(await sourceGateSideEffectCounts(), sideEffectsBeforeBlockedPath,
      'the blocked path writes no private proposal, publication, freshness, audit, outbox, or moderator data');
    assert.deepEqual(await publicAndFreshnessSnapshot(), publicAfterAssertion,
      'the current public event and its freshness projection remain unchanged after the L2 denial');
  });

  async function seedPersistedEvidence(): Promise<void> {
    await ports.tracesAndAudit.createTrace({
      traceId: TRACE_ID,
      datasetKind: DATASET,
      startedAt: '2026-09-26T06:00:00Z',
      endedAt: null,
      outcome: 'open',
      metadata: { fixture: 'authored-synthetic-only' },
    });
    await testDatabase.executor.query(
      `INSERT INTO waspada.source_registry
         (source_id, trace_id, registry_version, display_name, source_kind, remit,
          access_method, approved_hosts, access_restrictions, reuse_basis, registry_status,
          approval_status, health_status, auto_acquisition_enabled, auto_publication_policy)
       VALUES ($1, $2, 1, 'Authored synthetic fixture source', 'other',
          ARRAY['fictional test notice'], 'manual_fixture', ARRAY[]::text[],
          ARRAY['synthetic fixtures only'], ARRAY['authored for a local test'],
          'active', 'approved', 'healthy', false, 'never')`,
      [SOURCE_ID, TRACE_ID],
    );

    permittedTextHash = sha256(AUTHORED_TEXT);
    const revision: NewReportRevision = {
      datasetKind: DATASET,
      reportRevisionId: REVISION_ID,
      traceId: TRACE_ID,
      sourceId: SOURCE_ID,
      canonicalUrl: 'https://synthetic.invalid/rag-proposal-roundtrip',
      sourceRevisionKey: null,
      contentHash: sha256('authored synthetic roundtrip payload'),
      permittedText: AUTHORED_TEXT,
      permittedTextHash,
      normalizationVersion: 'roundtrip-normalization-v1',
      publishedAt: PUBLISHED_AT,
      observedAt: OBSERVED_AT,
      retrievedAt: RETRIEVED_AT,
      validFrom: null,
      validUntil: null,
      supersedesId: null,
      revisionStatus: 'eligible',
      recordJson: { fixture: 'authored-synthetic-only' },
    };
    await ports.reportRevisions.create(revision);
    evidenceReferenceId = await ports.reportRevisions.createEvidenceReference({
      datasetKind: DATASET,
      traceId: TRACE_ID,
      reportRevisionId: REVISION_ID,
      permittedTextHash,
      spanStart: SELECTED_SPAN_START,
      spanEnd: SELECTED_SPAN_END,
      relation: 'supports',
    });
    await testDatabase.executor.query(
      `INSERT INTO waspada.extraction_results
         (dataset_kind, candidate_id, trace_id, report_revision_id, category, record_json)
       VALUES ($1, $2, $3, $4, 'transport_road_incidents', $5::jsonb)`,
      [DATASET, CANDIDATE_ID, TRACE_ID, REVISION_ID,
        JSON.stringify({
          fixture: 'authored-synthetic-only',
          event_time: { start: EVENT_TIME, end: EVENT_TIME, precision: 'exact' },
          contractVersion: '2.0',
        })],
    );
    await testDatabase.executor.query(
      'INSERT INTO waspada.extraction_evidence (dataset_kind, candidate_id, evidence_ref_id) '
        + 'VALUES ($1, $2, $3)',
      [DATASET, CANDIDATE_ID, evidenceReferenceId],
    );
    await testDatabase.executor.query(
      `INSERT INTO waspada.evidence_origins
         (dataset_kind, origin_id, trace_id, origin_kind, source_id, lineage_relation,
          independence_status, record_json)
       VALUES ($1, $2, $3, 'issuer_statement', $4, 'original', 'established',
          '{"fixture":"authored-synthetic-only"}'::jsonb)`,
      [DATASET, ORIGIN_ID, TRACE_ID, SOURCE_ID],
    );
    await testDatabase.executor.query(
      'INSERT INTO waspada.origin_report_revisions (dataset_kind, origin_id, report_revision_id) '
        + 'VALUES ($1, $2, $3)',
      [DATASET, ORIGIN_ID, REVISION_ID],
    );
    await testDatabase.executor.query(
      'INSERT INTO waspada.origin_evidence (dataset_kind, origin_id, evidence_ref_id) VALUES ($1, $2, $3)',
      [DATASET, ORIGIN_ID, evidenceReferenceId],
    );

    const fullTextLength = Array.from(AUTHORED_TEXT).length;
    const chunkTextHash = sha256(AUTHORED_TEXT);
    const chunkId = 'chunk-rag-proposal-roundtrip';
    const embeddingRunId = 'embedding-rag-proposal-roundtrip';
    await testDatabase.executor.query(
      `INSERT INTO waspada.evidence_chunks
         (dataset_kind, chunk_id, trace_id, report_revision_id, permitted_text_hash,
          span_start, span_end, offset_unit, chunker_version, chunk_text_hash, status)
       VALUES ($1, $2, $3, $4, $5, 0, $6, 'unicode_code_points',
          'roundtrip-chunker-v1', $7, 'active')`,
      [DATASET, chunkId, TRACE_ID, REVISION_ID, permittedTextHash, fullTextLength, chunkTextHash],
    );
    await testDatabase.executor.query(
      `INSERT INTO waspada.embedding_runs
         (dataset_kind, embedding_run_id, trace_id, chunk_id, capability, provider,
          model_version, dimensions, distance_metric, vector_index_version,
          input_text_hash, status, created_at)
       VALUES ($1, $2, $3, $4, 'embedding', $5, $6, 2, 'cosine', $7, $8, 'available', $9)`,
      [DATASET, embeddingRunId, TRACE_ID, chunkId, EMBEDDING_IDENTITY.provider,
        EMBEDDING_IDENTITY.modelVersion, RETRIEVAL_INDEX_VERSION, chunkTextHash, RETRIEVED_AT],
    );
    await testDatabase.executor.query(
      `INSERT INTO waspada.embedding_vectors (dataset_kind, embedding_run_id, dimensions, embedding)
       VALUES ($1, $2, 2, '[1,0]'::vector)`,
      [DATASET, embeddingRunId],
    );
  }

  async function seedPublicBaselineWithFreshness(): Promise<void> {
    await testDatabase.executor.query(
      "INSERT INTO waspada.dataset_namespace_config (singleton, dataset_kind) VALUES (true, 'synthetic')",
    );
    await testDatabase.executor.query(
      `INSERT INTO waspada.grounding_contexts
         (dataset_kind, context_id, trace_id, candidate_id, retrieval_version,
          index_version, sufficient, record_json)
       VALUES ($1, $2, $3, $4, 'synthetic-fixture-v1', 'not_applicable', true,
         '{"fixture":"authored-synthetic-public-baseline"}'::jsonb)`,
      [DATASET, BASELINE_PUBLIC_CONTEXT_ID, TRACE_ID, CANDIDATE_ID],
    );
    await testDatabase.executor.query(
      `INSERT INTO waspada.event_proposals
         (dataset_kind, proposal_id, trace_id, candidate_id, context_id, proposed_at, record_json)
       VALUES ($1, $2, $3, $4, $5, $6, '{"fixture":"authored-synthetic-public-baseline"}'::jsonb)`,
      [DATASET, BASELINE_PUBLIC_PROPOSAL_ID, TRACE_ID, CANDIDATE_ID,
        BASELINE_PUBLIC_CONTEXT_ID, PROPOSED_AT],
    );
    const freshness = {
      status: 'current',
      evaluated_at: '2026-09-26T12:00:00Z',
      review_due_at: '2026-09-28T12:00:00Z',
      basis: 'issuer_notice',
    };
    const eventRecord = {
      schema_version: '2.0',
      record_type: 'Event',
      dataset_kind: DATASET,
      event_id: BASELINE_PUBLIC_EVENT_ID,
      version: 1,
      title: 'Authored synthetic public baseline',
      summary: 'A pre-existing synthetic public version for the source-revision gate test.',
      category: 'transport_road_incidents',
      lifecycle: 'ongoing',
      claims: [{
        claim_id: BASELINE_PUBLIC_CLAIM_ID,
        text: 'The fictional crossing is closed.',
        evidence_label: 'attributed_report',
        support: [{
          report_revision_id: REVISION_ID,
          permitted_text_hash: permittedTextHash,
          span_start: SELECTED_SPAN_START,
          span_end: SELECTED_SPAN_END,
          offset_unit: 'unicode_code_points',
          relation: 'supports',
        }],
        origin_ids: [ORIGIN_ID],
      }],
      impact_refs: [],
      publication_status: 'published',
      publication_decision_id: BASELINE_PUBLIC_DECISION_ID,
      published_at: RETRIEVED_AT,
      withdrawn_at: null,
      freshness,
    };
    await testDatabase.executor.transaction(async (transaction) => {
      await transaction.execute('SET CONSTRAINTS ALL DEFERRED');
      await transaction.query(
        `INSERT INTO waspada.publication_decisions
           (dataset_kind, decision_id, trace_id, proposal_id, policy_version,
            event_id, event_version, decided_at, record_json)
         VALUES ($1, $2, $3, $4, 'synthetic-baseline-policy-v1', $5, 1, $6,
           '{"fixture":"authored-synthetic-public-baseline"}'::jsonb)`,
        [DATASET, BASELINE_PUBLIC_DECISION_ID, TRACE_ID, BASELINE_PUBLIC_PROPOSAL_ID,
          BASELINE_PUBLIC_EVENT_ID, RETRIEVED_AT],
      );
      await transaction.query(
        `INSERT INTO waspada.event_versions
           (dataset_kind, event_id, version, trace_id, supersedes_version, title, summary,
            category, lifecycle, publication_status, withdrawal_reason, publication_decision_id,
            published_at, withdrawn_at, record_json)
         VALUES ($1, $2, 1, $3, NULL, $4, $5, 'transport_road_incidents', 'ongoing',
           'published', NULL, $6, $7, NULL, $8::jsonb)`,
        [DATASET, BASELINE_PUBLIC_EVENT_ID, TRACE_ID, eventRecord.title, eventRecord.summary,
          BASELINE_PUBLIC_DECISION_ID, RETRIEVED_AT, JSON.stringify(eventRecord)],
      );
      await transaction.query(
        `INSERT INTO waspada.event_claims
           (dataset_kind, event_id, event_version, claim_id, claim_text, evidence_label, record_json)
         VALUES ($1, $2, 1, $3, 'The fictional crossing is closed.', 'attributed_report', $4::jsonb)`,
        [DATASET, BASELINE_PUBLIC_EVENT_ID, BASELINE_PUBLIC_CLAIM_ID,
          JSON.stringify(eventRecord.claims[0])],
      );
      await transaction.query(
        `INSERT INTO waspada.event_claim_evidence
           (dataset_kind, event_id, event_version, claim_id, evidence_kind, evidence_ref_id)
         VALUES ($1, $2, 1, $3, 'support', $4)`,
        [DATASET, BASELINE_PUBLIC_EVENT_ID, BASELINE_PUBLIC_CLAIM_ID, evidenceReferenceId],
      );
      await transaction.query(
        `INSERT INTO waspada.event_claim_origins
           (dataset_kind, event_id, event_version, claim_id, origin_id)
         VALUES ($1, $2, 1, $3, $4)`,
        [DATASET, BASELINE_PUBLIC_EVENT_ID, BASELINE_PUBLIC_CLAIM_ID, ORIGIN_ID],
      );
    });
    await testDatabase.executor.query(
      `INSERT INTO waspada.freshness_transitions
         (dataset_kind, event_id, event_version, target_kind, transition_sequence,
          previous_status, resulting_status, reason, evaluated_at, trace_id,
          idempotency_key, request_fingerprint)
       VALUES ($1, $2, 1, 'event_claim_set', 1, 'current', 'needs_update',
         'review_deadline_missed', '2026-09-27T12:00:00Z', $3,
         'source-gate-baseline-freshness', $4)`,
      [DATASET, BASELINE_PUBLIC_EVENT_ID, TRACE_ID, sha256('source-gate-baseline-freshness')],
    );
  }

  async function assembleContext(
    contextId: string,
    sufficient: boolean,
    missingFields: readonly string[],
    conflicts: readonly string[] = [],
  ) {
    return withRole('waspada_l2_grounding_reader', async () => {
      const retrieval = await ports.evidenceRetrieval.search({
        datasetKind: DATASET,
        identifiers: [{ kind: 'candidate', value: CANDIDATE_ID }],
        exactTerms: ['fictional crossing'],
        filters: {
          revisionStatuses: ['eligible'],
          registryStatuses: ['active'],
          approvalStatuses: ['approved'],
        },
        semantic: { identity: EMBEDDING_IDENTITY, queryVector: [1, 0] },
        maxResults: 8,
        maxRowsExamined: 16,
        maxSpanTextCodePoints: 256,
      });
      assert.equal(retrieval.datasetKind, DATASET);
      assert.equal(retrieval.scanTruncated, false);
      assert.equal(retrieval.resultTruncated, false);
      assert.equal(retrieval.invalidSpanRowsOmitted, 0);
      assert.equal(retrieval.semanticStatus, 'matched');
      assert.equal(retrieval.indexVersion, RETRIEVAL_INDEX_VERSION);
      assert.equal(retrieval.candidates.length, 1);
      const candidate = retrieval.candidates[0]!;
      assertPersistedCandidate(candidate);

      const exactSpanReader = createSqlExactEvidenceSpanReader(testDatabase.executor);
      let exactSpanReadCount = 0;
      const request = await assembleGroundingReasoningRequest({
        async readExactSpan(identity) {
          exactSpanReadCount += 1;
          return exactSpanReader.readExactSpan(identity);
        },
      }, {
        retrieval,
        datasetKind: DATASET,
        traceId: TRACE_ID,
        contextId,
        candidateId: CANDIDATE_ID,
        evidenceReferenceIds: [candidate.evidenceReferenceId],
        candidateEvents: [],
        priorDecisionIds: [],
        missingFields,
        conflicts,
        sufficient,
      });
      assert.equal(exactSpanReadCount, 1);
      const selected = request.data.groundingContext.evidence[0];
      assert.ok(selected);
      assert.equal(selected.text, SELECTED_SPAN, 'the exact persisted code-point span is rehydrated');
      assert.deepEqual(selected.reference, {
        reportRevisionId: REVISION_ID,
        permittedTextHash,
        spanStart: SELECTED_SPAN_START,
        spanEnd: SELECTED_SPAN_END,
        offsetUnit: 'unicode_code_points',
        relation: 'supports',
      });
      assert.deepEqual(selected.origins, [{
        originId: ORIGIN_ID,
        independenceStatus: 'established',
        dependsOnOriginIds: [],
      }]);
      return { retrieval, candidate, reasoningRequest: request };
    });
  }

  function assertPersistedCandidate(candidate: EvidenceRetrievalCandidate): void {
    assert.equal(candidate.datasetKind, DATASET);
    assert.equal(candidate.candidateId, CANDIDATE_ID);
    assert.equal(candidate.reportRevisionId, REVISION_ID);
    assert.equal(candidate.permittedTextHash, permittedTextHash);
    assert.equal(candidate.evidenceReferenceId, evidenceReferenceId);
    assert.equal(candidate.spanStart, SELECTED_SPAN_START);
    assert.equal(candidate.spanEnd, SELECTED_SPAN_END);
    assert.equal(candidate.offsetUnit, 'unicode_code_points');
    assert.equal(candidate.relation, 'supports');
    assert.equal(candidate.revisionStatus, 'eligible');
    assert.equal(candidate.source.registryStatus, 'active');
    assert.equal(candidate.source.approvalStatus, 'approved');
    assert.equal(candidate.source.sourceId, SOURCE_ID);
    assert.equal(candidate.publishedAt, '2026-09-26T07:04:56.123456Z');
    assert.equal(candidate.observedAt, '2026-09-26T12:09:10.000007Z');
    assert.equal(candidate.retrievedAt, '2026-09-26T06:14:15.987654Z');
    assert.equal(candidate.eventTime.status, 'valid');
    assert.equal(candidate.eventTime.start, EVENT_TIME,
      'the typed event time keeps its source offset and original spelling');
    assert.equal(candidate.originLineageStatus, 'recorded');
    assert.deepEqual(candidate.origins.map(({ originId }) => originId), [ORIGIN_ID]);
    assert.equal(candidate.chunk?.embeddingStatus, 'matched');
    assert.equal(candidate.chunk?.embeddingProvider, EMBEDDING_IDENTITY.provider);
    assert.equal(candidate.chunk?.embeddingModelVersion, EMBEDDING_IDENTITY.modelVersion);
    assert.equal(candidate.chunk?.embeddingIndexVersion, RETRIEVAL_INDEX_VERSION);
    assert.equal(candidate.matchFacets.semanticDistance, 0);
  }

  async function contextRows(contextId: string): Promise<readonly {
    readonly context_id: string;
    readonly sufficient: boolean;
    readonly record_json: string;
  }[]> {
    const result = await testDatabase.executor.query<{
      context_id: string;
      sufficient: boolean;
      record_json: string;
    }>(
      'SELECT context_id, sufficient, record_json::text AS record_json '
        + 'FROM waspada.grounding_contexts WHERE dataset_kind = $1 AND context_id = $2',
      [DATASET, contextId],
    );
    return result.rows;
  }

  async function privateProposalCounts(proposalId: string): Promise<{
    readonly proposals: string;
    readonly claims: string;
    readonly evidenceLinks: string;
    readonly originLinks: string;
  }> {
    const result = await testDatabase.executor.query<{
      proposals: string;
      claims: string;
      evidence_links: string;
      origin_links: string;
    }>(
      'SELECT (SELECT count(*)::text FROM waspada.event_proposals WHERE dataset_kind = $1 AND proposal_id = $2) AS proposals, '
        + '(SELECT count(*)::text FROM waspada.proposal_claims WHERE dataset_kind = $1 AND proposal_id = $2) AS claims, '
        + '(SELECT count(*)::text FROM waspada.proposal_claim_evidence WHERE dataset_kind = $1 AND proposal_id = $2) AS evidence_links, '
        + '(SELECT count(*)::text FROM waspada.proposal_claim_origins WHERE dataset_kind = $1 AND proposal_id = $2) AS origin_links',
      [DATASET, proposalId],
    );
    const row = result.rows[0];
    assert.ok(row);
    return {
      proposals: row.proposals,
      claims: row.claims,
      evidenceLinks: row.evidence_links,
      originLinks: row.origin_links,
    };
  }

  async function protectedWriteCounts(): Promise<{
    readonly eventVersions: string;
    readonly decisions: string;
    readonly outbox: string;
    readonly audits: string;
    readonly moderatorReviews: string;
  }> {
    const result = await testDatabase.executor.query<{
      event_versions: string;
      decisions: string;
      outbox: string;
      audits: string;
      moderator_reviews: string;
    }>(
      'SELECT (SELECT count(*)::text FROM waspada.event_versions) AS event_versions, '
        + '(SELECT count(*)::text FROM waspada.publication_decisions) AS decisions, '
        + '(SELECT count(*)::text FROM waspada.publication_outbox) AS outbox, '
        + '(SELECT count(*)::text FROM waspada.audit_records) AS audits, '
        + '(SELECT count(*)::text FROM waspada.public_event_history_review_decisions) AS moderator_reviews',
    );
    const row = result.rows[0];
    assert.ok(row);
    return {
      eventVersions: row.event_versions,
      decisions: row.decisions,
      outbox: row.outbox,
      audits: row.audits,
      moderatorReviews: row.moderator_reviews,
    };
  }

  async function publicAndFreshnessSnapshot(): Promise<{
    readonly publicEvents: readonly Record<string, unknown>[];
    readonly freshnessTransitions: readonly Record<string, unknown>[];
  }> {
    const [publicEvents, freshnessTransitions] = await Promise.all([
      testDatabase.executor.query<Record<string, unknown>>(
        `SELECT dataset_kind, event_id, version, title, summary, category, lifecycle,
                record_json::text AS record_json, freshness_status
         FROM waspada.public_event_versions WHERE event_id = $1 ORDER BY version`,
        [BASELINE_PUBLIC_EVENT_ID],
      ),
      testDatabase.executor.query<Record<string, unknown>>(
        `SELECT dataset_kind, event_id, event_version, target_kind, transition_sequence,
                previous_status, resulting_status, reason, evaluated_at, trace_id, idempotency_key
         FROM waspada.freshness_transitions WHERE event_id = $1 ORDER BY transition_sequence`,
        [BASELINE_PUBLIC_EVENT_ID],
      ),
    ]);
    return { publicEvents: publicEvents.rows, freshnessTransitions: freshnessTransitions.rows };
  }

  async function sourceGateSideEffectCounts(): Promise<{
    readonly proposals: string;
    readonly eventVersions: string;
    readonly decisions: string;
    readonly outbox: string;
    readonly freshnessTransitions: string;
    readonly audits: string;
    readonly moderatorReviews: string;
  }> {
    const result = await testDatabase.executor.query<{
      proposals: string;
      event_versions: string;
      decisions: string;
      outbox: string;
      freshness_transitions: string;
      audits: string;
      moderator_reviews: string;
    }>(
      `SELECT (SELECT count(*)::text FROM waspada.event_proposals) AS proposals,
              (SELECT count(*)::text FROM waspada.event_versions) AS event_versions,
              (SELECT count(*)::text FROM waspada.publication_decisions) AS decisions,
              (SELECT count(*)::text FROM waspada.publication_outbox) AS outbox,
              (SELECT count(*)::text FROM waspada.freshness_transitions) AS freshness_transitions,
              (SELECT count(*)::text FROM waspada.audit_records) AS audits,
              (SELECT count(*)::text FROM waspada.public_event_history_review_decisions) AS moderator_reviews`,
    );
    const row = result.rows[0];
    assert.ok(row);
    return {
      proposals: row.proposals,
      eventVersions: row.event_versions,
      decisions: row.decisions,
      outbox: row.outbox,
      freshnessTransitions: row.freshness_transitions,
      audits: row.audits,
      moderatorReviews: row.moderator_reviews,
    };
  }

  async function withRole<Result>(role: 'waspada_l2_grounding_reader' | 'waspada_l2_grounding_writer' | 'waspada_l2_proposal_writer', work: () => Promise<Result>): Promise<Result> {
    await testDatabase.executor.execute(`SET ROLE ${role}`);
    try {
      return await work();
    } finally {
      await testDatabase.executor.execute('RESET ROLE');
    }
  }

  function fixedReasoningResult(context: GroundingContext): ReasoningResult {
    const support = context.evidence[0];
    assert.ok(support);
    return {
      outcome: 'proposed',
      claims: [{
        text: 'The authored synthetic notice describes a fictional crossing closure.',
        eventTime: { precision: 'exact', start: EVENT_TIME, end: null },
        validity: { validFrom: null, validUntil: null },
        scope: { placeIds: [], serviceIds: [], institutionIds: [], audienceIds: [], geometryIds: [] },
        qualifiers: [],
        support: [support.reference],
        contradictions: [],
        contextEvidence: [],
        supportAssessment: 'uncertain',
      }],
      unresolvedFields: [...context.missingFields],
      conflicts: [...context.conflicts],
      modelRun: {
        capability: 'reasoning',
        modelVersion: 'synthetic-reasoner-v1',
        promptVersion: 'synthetic-reasoning-prompt-v2',
        inputTokens: 17,
        outputTokens: 8,
      },
      provider: 'synthetic-test-provider',
    };
  }

});

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
