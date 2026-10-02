import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';
import { createFreshnessDueTargetReader } from '../src/freshness-due-target-reader.js';
import { createSqlFreshnessTransitionLedger } from '../src/freshness-transition-ledger.js';
import { applyMigrations, readMigrations } from '../src/migrations.js';
import type {
  FreshnessTransitionRecorderInput,
  FreshnessTransitionRecorderResult,
} from '../../worker/src/layers/l4-application-integration/freshness-transition-recorder.js';
import { createFreshnessDueEvaluator } from '../../worker/src/layers/l4-application-integration/freshness-due-evaluator.js';
import { createFreshnessTransitionRecorder } from '../../worker/src/layers/l4-application-integration/freshness-transition-recorder.js';
import { createTestDatabase, type TestDatabase } from './harness.js';

const DATASET_KIND = 'synthetic' as const;
const EVENT_ID = 'event-freshness-due-composition-fixture';
const EVENT_VERSION = 1;
const IMPACT_ID = 'impact-freshness-due-composition-fixture';
const IMPACT_VERSION = 1;
const PUBLICATION_TRACE_ID = 'trace-freshness-due-composition-publication';
const EVALUATION_TRACE_ID = 'trace-freshness-due-composition-evaluation';
const EVALUATION_RUN_ID = 'run-freshness-due-composition-fixture';
const PUBLISHED_AT = '2026-10-01T09:00:00.000000Z';
const EXPLICIT_NOW = '2026-10-02T10:00:00.000000Z';
const NOT_DUE_AT = '2026-10-03T00:00:00.000000Z';

interface PublicationSnapshot {
  readonly event_versions: readonly Record<string, unknown>[] | null;
  readonly impact_versions: readonly Record<string, unknown>[] | null;
  readonly publication_decisions: readonly Record<string, unknown>[] | null;
  readonly publication_outbox: readonly Record<string, unknown>[] | null;
}

interface FreshnessTransitionRow {
  readonly transition_id: string;
  readonly dataset_kind: string;
  readonly event_id: string;
  readonly event_version: number;
  readonly target_kind: string;
  readonly impact_id: string | null;
  readonly impact_version: number | null;
  readonly transition_sequence: number;
  readonly previous_status: string;
  readonly resulting_status: string;
  readonly reason: string;
  readonly evaluated_at: string;
  readonly trace_id: string;
  readonly idempotency_key: string;
  readonly request_fingerprint: string;
}

interface CurrentEventRow {
  readonly freshness_status: string;
  readonly record_json: Record<string, unknown>;
}

interface CurrentImpactRow {
  readonly impact_id: string;
  readonly impact_version: number;
  readonly record_json: Record<string, unknown>;
}

describe('PGlite freshness due-evaluator composition', () => {
  it('persists an exact impact expiry and projects conservative current-public status without rewriting publication data', async () => {
    const database = await createTestDatabase();
    try {
      const migrations = await readMigrations(new URL('../migrations/', import.meta.url));
      await applyMigrations(database.executor, migrations);
      await seedSyntheticPublicationFixture(database);

      const publicationBefore = await readImmutablePublicationSnapshot(database);
      assert.equal(publicationBefore.event_versions?.length, 1);
      assert.equal(publicationBefore.impact_versions?.length, 1);
      assert.equal(publicationBefore.publication_decisions?.length, 1);
      assert.equal(publicationBefore.publication_outbox, null,
        'the live-only publication outbox has no synthetic fixture rows');

      const reader = createFreshnessDueTargetReader(database.executor);
      const dueBefore = await reader.read({
        datasetKind: DATASET_KIND,
        now: EXPLICIT_NOW,
        limit: 10,
      });
      assert.deepEqual(dueBefore.targets, [{
        datasetKind: DATASET_KIND,
        eventId: EVENT_ID,
        eventVersion: EVENT_VERSION,
        target: { kind: 'impact', impactId: IMPACT_ID, impactVersion: IMPACT_VERSION },
        status: 'current',
        transitionSequence: 0,
        validUntil: EXPLICIT_NOW,
        reviewDueAt: NOT_DUE_AT,
      }]);
      assert.equal(dueBefore.nextCursor, null);

      const ledger = createSqlFreshnessTransitionLedger(database.executor);
      const actualRecorder = createFreshnessTransitionRecorder(ledger);
      const recorderInputs: FreshnessTransitionRecorderInput[] = [];
      const recorderResults: FreshnessTransitionRecorderResult[] = [];
      const evaluator = createFreshnessDueEvaluator({
        reader,
        recorder: {
          async evaluateAndRecord(input) {
            recorderInputs.push(input);
            const result = await actualRecorder.evaluateAndRecord(input);
            recorderResults.push(result);
            return result;
          },
        },
      });

      const evaluation = await evaluator.evaluate({
        datasetKind: DATASET_KIND,
        now: EXPLICIT_NOW,
        limit: 10,
        cursor: null,
        traceId: EVALUATION_TRACE_ID,
        evaluationRunId: EVALUATION_RUN_ID,
      });

      assert.deepEqual(evaluation, {
        outcome: 'completed',
        counts: { written: 1, replayed: 0, noChange: 0, conflicts: 0, failures: 0 },
        nextCursor: null,
      });
      assert.equal(recorderInputs.length, 1);
      assert.deepEqual(recorderInputs[0], {
        datasetKind: DATASET_KIND,
        eventId: EVENT_ID,
        eventVersion: EVENT_VERSION,
        target: { kind: 'impact', impactId: IMPACT_ID, impactVersion: IMPACT_VERSION },
        expectedSequence: 1,
        previousStatus: 'current',
        validUntil: EXPLICIT_NOW,
        reviewDueAt: NOT_DUE_AT,
        now: EXPLICIT_NOW,
        newApplicableEvidenceEvaluated: false,
        evidenceReferenceIds: [],
        traceId: EVALUATION_TRACE_ID,
        idempotencyKey: recorderInputs[0]?.idempotencyKey,
      });
      assert.equal(recorderInputs[0]?.newApplicableEvidenceEvaluated, false);
      assert.deepEqual(recorderInputs[0]?.evidenceReferenceIds, [],
        'expiry evaluation does not claim evidence recovery');

      const idempotencyIdentity = JSON.stringify([
        'waspada:freshness-due-evaluator:idempotency:v1',
        EVALUATION_RUN_ID,
        DATASET_KIND,
        EVENT_ID,
        EVENT_VERSION,
        'impact',
        IMPACT_ID,
        IMPACT_VERSION,
        0,
      ]);
      const expectedIdempotencyKey = 'freshness-due:' + createHash('sha256')
        .update(idempotencyIdentity, 'utf8')
        .digest('hex');
      assert.equal(recorderInputs[0]?.idempotencyKey, expectedIdempotencyKey);

      const recorded = recorderResults[0];
      assert.ok(recorded);
      if (recorded.outcome !== 'written') {
        assert.fail('Expected one persisted transition; received ' + recorded.outcome + '.');
      }
      assert.deepEqual(recorded.record.target, {
        kind: 'impact',
        impactId: IMPACT_ID,
        impactVersion: IMPACT_VERSION,
      });
      assert.deepEqual(recorded.record.evidenceReferenceIds, []);

      const transitions = await database.executor.query<FreshnessTransitionRow>(
        `SELECT transition_id::text AS transition_id, dataset_kind, event_id, event_version,
                target_kind, impact_id, impact_version, transition_sequence, previous_status,
                resulting_status, reason, evaluated_at,
                trace_id, idempotency_key, request_fingerprint
         FROM waspada.freshness_transitions
         WHERE dataset_kind = $1 AND event_id = $2 AND event_version = $3
           AND target_kind = 'impact' AND impact_id = $4 AND impact_version = $5
         ORDER BY transition_sequence`,
        [DATASET_KIND, EVENT_ID, EVENT_VERSION, IMPACT_ID, IMPACT_VERSION],
      );
      assert.equal(transitions.rows.length, 1);
      const transition = transitions.rows[0];
      assert.ok(transition);
      assert.deepEqual(transition, {
        transition_id: recorded.record.transitionId,
        dataset_kind: DATASET_KIND,
        event_id: EVENT_ID,
        event_version: EVENT_VERSION,
        target_kind: 'impact',
        impact_id: IMPACT_ID,
        impact_version: IMPACT_VERSION,
        transition_sequence: 1,
        previous_status: 'current',
        resulting_status: 'expired',
        reason: 'issuer_validity_ended',
        evaluated_at: EXPLICIT_NOW,
        trace_id: EVALUATION_TRACE_ID,
        idempotency_key: expectedIdempotencyKey,
        request_fingerprint: recorded.record.requestFingerprint,
      });
      assert.match(transition.request_fingerprint, /^[a-f0-9]{64}$/u);
      assert.equal(recorded.record.datasetKind, transition.dataset_kind);
      assert.equal(recorded.record.eventId, transition.event_id);
      assert.equal(recorded.record.eventVersion, transition.event_version);
      assert.equal(recorded.record.transitionSequence, transition.transition_sequence);
      assert.equal(recorded.record.previousStatus, transition.previous_status);
      assert.equal(recorded.record.resultingStatus, transition.resulting_status);
      assert.equal(recorded.record.reason, transition.reason);
      assert.equal(recorded.record.traceId, transition.trace_id);
      assert.equal(recorded.record.idempotencyKey, transition.idempotency_key);
      assert.equal(recorded.record.requestFingerprint, transition.request_fingerprint);

      const transitionEvidence = await database.executor.query<{ evidence_ref_id: string }>(
        `SELECT evidence_ref_id::text AS evidence_ref_id
         FROM waspada.freshness_transition_evidence
         WHERE transition_id = $1::bigint AND dataset_kind = $2
         ORDER BY evidence_ref_id`,
        [transition.transition_id, DATASET_KIND],
      );
      assert.deepEqual(transitionEvidence.rows, []);

      const currentPublic = await readCurrentPublicProjection(database);
      assert.equal(currentPublic.eventRows.length, 1);
      assert.equal(currentPublic.impactRows.length, 1);
      const currentEvent = currentPublic.eventRows[0]!;
      const projectedEventFreshness = currentEvent.record_json.freshness as Record<string, unknown>;
      assert.equal(currentEvent.freshness_status, 'needs_update',
        'a current claim set mixed with an issuer-expired impact aggregates conservatively');
      assert.deepEqual(projectedEventFreshness, {
        status: 'needs_update',
        evaluated_at: '2026-10-01T08:00:00.000000Z',
        review_due_at: NOT_DUE_AT,
        basis: 'issuer_notice',
      });

      const currentImpact = currentPublic.impactRows[0]!;
      assert.equal(currentImpact.impact_id, IMPACT_ID);
      assert.equal(currentImpact.impact_version, IMPACT_VERSION);
      assert.deepEqual(currentImpact.record_json.freshness, {
        status: 'expired',
        evaluated_at: '2026-10-01T08:00:00.000000Z',
        review_due_at: NOT_DUE_AT,
        basis: 'issuer_notice',
      });

      const dueAfter = await reader.read({
        datasetKind: DATASET_KIND,
        now: EXPLICIT_NOW,
        limit: 10,
      });
      assert.deepEqual(dueAfter.targets, [],
        'the exact impact target no longer appears after its effective status becomes expired');
      assert.equal(dueAfter.nextCursor, null);

      const publicationAfter = await readImmutablePublicationSnapshot(database);
      assert.deepEqual(publicationAfter, publicationBefore,
        'event/impact versions, decisions, and outbox rows are unchanged by freshness evaluation');
    } finally {
      await database.close();
    }
  });
});

async function seedSyntheticPublicationFixture(database: TestDatabase): Promise<void> {
  const sourceId = 'source-freshness-due-composition-fixture';
  const revisionId = 'revision-freshness-due-composition-fixture';
  const candidateId = 'candidate-freshness-due-composition-fixture';
  const contextId = 'context-freshness-due-composition-fixture';
  const proposalId = 'proposal-freshness-due-composition-fixture';
  const decisionId = 'decision-freshness-due-composition-fixture';
  const reportText = 'Authored synthetic fixture text; no live report or event is represented.';
  const reportHash = hash(reportText);
  const sourceContentHash = hash('Authored synthetic source content for the composition fixture.');

  await database.executor.query(
    `INSERT INTO waspada.dataset_namespace_config (singleton, dataset_kind, configured_at)
     VALUES (true, $1, $2)
     ON CONFLICT (singleton) DO UPDATE SET dataset_kind = EXCLUDED.dataset_kind,
       configured_at = EXCLUDED.configured_at`,
    [DATASET_KIND, PUBLISHED_AT],
  );
  await database.executor.query(
    `INSERT INTO waspada.traces (trace_id, dataset_kind, started_at, outcome, metadata)
     VALUES ($1, $2, $3, 'open', '{"fixture":"authored-synthetic-only"}'::jsonb),
            ($4, $2, $5, 'open', '{"fixture":"authored-synthetic-only"}'::jsonb)`,
    [PUBLICATION_TRACE_ID, DATASET_KIND, PUBLISHED_AT, EVALUATION_TRACE_ID, EXPLICIT_NOW],
  );
  await database.executor.query(
    `INSERT INTO waspada.source_registry
       (source_id, trace_id, registry_version, display_name, source_kind, remit,
        access_method, approved_hosts, access_restrictions, reuse_basis, registry_status,
        approval_status, health_status, auto_acquisition_enabled, auto_publication_policy)
     VALUES ($1, $2, 1, 'Authored synthetic test source', 'other', ARRAY['synthetic fixture'],
       'manual_fixture', ARRAY[]::text[], ARRAY['synthetic-only test content'],
       ARRAY['authored fixture'], 'active', 'approved', 'unknown', false, 'never')`,
    [sourceId, PUBLICATION_TRACE_ID],
  );
  await database.executor.query(
    `INSERT INTO waspada.report_revisions
       (dataset_kind, report_revision_id, trace_id, source_id, canonical_url, content_hash,
        permitted_text, permitted_text_hash, normalization_version, retrieved_at,
        revision_status, record_json)
     VALUES ($1, $2, $3, $4, 'https://synthetic.invalid/freshness-due-composition',
       $5, $6, $7, 'composition-fixture-v1', $8, 'eligible',
       '{"fixture":"authored-synthetic-only"}'::jsonb)`,
    [
      DATASET_KIND,
      revisionId,
      PUBLICATION_TRACE_ID,
      sourceId,
      sourceContentHash,
      reportText,
      reportHash,
      PUBLISHED_AT,
    ],
  );
  await database.executor.query(
    `INSERT INTO waspada.extraction_results
       (dataset_kind, candidate_id, trace_id, report_revision_id, category, record_json)
     VALUES ($1, $2, $3, $4, 'group_specific_critical_notices',
       '{"fixture":"authored-synthetic-only"}'::jsonb)`,
    [DATASET_KIND, candidateId, PUBLICATION_TRACE_ID, revisionId],
  );
  await database.executor.query(
    `INSERT INTO waspada.grounding_contexts
       (dataset_kind, context_id, trace_id, candidate_id, retrieval_version,
        index_version, sufficient, record_json)
     VALUES ($1, $2, $3, $4, 'composition-fixture-v1', 'composition-index-v1',
       true, '{"fixture":"authored-synthetic-only"}'::jsonb)`,
    [DATASET_KIND, contextId, PUBLICATION_TRACE_ID, candidateId],
  );
  await database.executor.query(
    `INSERT INTO waspada.event_proposals
       (dataset_kind, proposal_id, trace_id, candidate_id, context_id,
        proposed_at, record_json)
     VALUES ($1, $2, $3, $4, $5, $6, '{"fixture":"authored-synthetic-only"}'::jsonb)`,
    [DATASET_KIND, proposalId, PUBLICATION_TRACE_ID, candidateId, contextId, PUBLISHED_AT],
  );

  const eventRecord = {
    schema_version: '2.0',
    trace_id: PUBLICATION_TRACE_ID,
    record_type: 'Event',
    dataset_kind: DATASET_KIND,
    event_id: EVENT_ID,
    version: EVENT_VERSION,
    supersedes_version: null,
    title: 'Authored synthetic current event fixture',
    summary: 'No real event, hazard, or safety condition is represented.',
    category: 'group_specific_critical_notices',
    tags: [],
    lifecycle: 'unknown',
    freshness: {
      status: 'current',
      evaluated_at: '2026-10-01T08:00:00.000000Z',
      review_due_at: NOT_DUE_AT,
      basis: 'issuer_notice',
    },
    event_time: { start: null, end: null, precision: 'unknown' },
    validity: { valid_from: null, valid_until: null },
    scope: { place_ids: [], service_ids: [], institution_ids: [], audience_ids: [], geometry_ids: [] },
    claims: [{ claim_id: 'claim-freshness-due-composition-fixture', text: 'Authored synthetic claim.' }],
    impact_refs: [{ impact_id: IMPACT_ID, version: IMPACT_VERSION }],
    publication_status: 'published',
    withdrawal_reason: null,
    publication_decision_id: decisionId,
    published_at: PUBLISHED_AT,
    withdrawn_at: null,
  };
  const impactRecord = {
    schema_version: '2.0',
    trace_id: PUBLICATION_TRACE_ID,
    record_type: 'Impact',
    dataset_kind: DATASET_KIND,
    impact_id: IMPACT_ID,
    version: IMPACT_VERSION,
    event_id: EVENT_ID,
    event_version: EVENT_VERSION,
    impact_type: 'road_closure',
    title: 'Authored synthetic impact fixture',
    description: 'Fixture content only; no real impact is represented.',
    lifecycle: 'unknown',
    freshness: {
      status: 'current',
      evaluated_at: '2026-10-01T08:00:00.000000Z',
      review_due_at: NOT_DUE_AT,
      basis: 'issuer_notice',
    },
    event_time: { start: null, end: null, precision: 'unknown' },
    validity: { valid_from: null, valid_until: EXPLICIT_NOW },
    scope: { place_ids: [], service_ids: [], institution_ids: [], audience_ids: [], geometry_ids: [] },
    supporting_claim_ids: [],
    published_at: PUBLISHED_AT,
  };

  await database.executor.transaction(async (transaction) => {
    await transaction.query(
      `INSERT INTO waspada.publication_decisions
         (dataset_kind, decision_id, trace_id, proposal_id, policy_version,
          event_id, event_version, decided_at, record_json)
       VALUES ($1, $2, $3, $4, 'composition-fixture-policy-v1',
         $5, $6, $7, '{"fixture":"authored-synthetic-only"}'::jsonb)`,
      [DATASET_KIND, decisionId, PUBLICATION_TRACE_ID, proposalId, EVENT_ID, EVENT_VERSION, PUBLISHED_AT],
    );
    await transaction.query(
      `INSERT INTO waspada.event_versions
         (dataset_kind, event_id, version, trace_id, supersedes_version, title, summary,
          category, lifecycle, publication_status, withdrawal_reason, publication_decision_id,
          published_at, withdrawn_at, record_json)
       VALUES ($1, $2, $3, $4, NULL, $5, $6, $7, 'unknown', 'published', NULL, $8, $9, NULL, $10::jsonb)`,
      [
        DATASET_KIND,
        EVENT_ID,
        EVENT_VERSION,
        PUBLICATION_TRACE_ID,
        eventRecord.title,
        eventRecord.summary,
        eventRecord.category,
        decisionId,
        PUBLISHED_AT,
        JSON.stringify(eventRecord),
      ],
    );
    await transaction.query(
      `INSERT INTO waspada.impact_versions
         (dataset_kind, impact_id, version, trace_id, event_id, event_version,
          impact_type, lifecycle, published_at, record_json)
       VALUES ($1, $2, $3, $4, $5, $6, 'road_closure', 'unknown', $7, $8::jsonb)`,
      [
        DATASET_KIND,
        IMPACT_ID,
        IMPACT_VERSION,
        PUBLICATION_TRACE_ID,
        EVENT_ID,
        EVENT_VERSION,
        PUBLISHED_AT,
        JSON.stringify(impactRecord),
      ],
    );
    await transaction.query(
      `INSERT INTO waspada.event_impact_refs
         (dataset_kind, event_id, event_version, impact_id, impact_version)
       VALUES ($1, $2, $3, $4, $5)`,
      [DATASET_KIND, EVENT_ID, EVENT_VERSION, IMPACT_ID, IMPACT_VERSION],
    );
  });
}

async function readImmutablePublicationSnapshot(database: TestDatabase): Promise<PublicationSnapshot> {
  const result = await database.executor.query<PublicationSnapshot>(
    `SELECT
       (SELECT jsonb_agg(to_jsonb(event) ORDER BY event.version)
        FROM waspada.event_versions AS event
        WHERE event.dataset_kind = $1 AND event.event_id = $2) AS event_versions,
       (SELECT jsonb_agg(to_jsonb(impact) ORDER BY impact.impact_id, impact.version)
        FROM waspada.impact_versions AS impact
        WHERE impact.dataset_kind = $1 AND impact.event_id = $2) AS impact_versions,
       (SELECT jsonb_agg(to_jsonb(decision) ORDER BY decision.decision_id)
        FROM waspada.publication_decisions AS decision
        WHERE decision.dataset_kind = $1 AND decision.event_id = $2) AS publication_decisions,
       (SELECT jsonb_agg(to_jsonb(outbox) ORDER BY outbox.outbox_id)
        FROM waspada.publication_outbox AS outbox
        WHERE outbox.event_id = $2) AS publication_outbox`,
    [DATASET_KIND, EVENT_ID],
  );
  const snapshot = result.rows[0];
  assert.ok(snapshot);
  return snapshot;
}

async function readCurrentPublicProjection(database: TestDatabase): Promise<{
  readonly eventRows: readonly CurrentEventRow[];
  readonly impactRows: readonly CurrentImpactRow[];
}> {
  await database.executor.execute('SET ROLE waspada_public_reader');
  try {
    const events = await database.executor.query<CurrentEventRow>(
      `SELECT freshness_status, record_json
       FROM waspada.public_event_versions
       WHERE dataset_kind = $1 AND event_id = $2`,
      [DATASET_KIND, EVENT_ID],
    );
    const impacts = await database.executor.query<CurrentImpactRow>(
      `SELECT impact_id, impact_version, record_json
       FROM waspada.public_event_impacts
       WHERE dataset_kind = $1 AND event_id = $2`,
      [DATASET_KIND, EVENT_ID],
    );
    return { eventRows: events.rows, impactRows: impacts.rows };
  } finally {
    await database.executor.execute('RESET ROLE');
  }
}

function hash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
