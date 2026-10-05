import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { createPublicEventGeometriesRepository } from '../../db/src/public-event-geometries.js';
import { createPublicEventHistoryDisclosureRepository } from '../../db/src/public-event-history-disclosure.js';
import { createPublicEventHistoryRepository } from '../../db/src/public-event-history.js';
import { createPublicEventListRepository } from '../../db/src/public-event-list.js';
import { createPublicEventSnapshotRepository } from '../../db/src/public-event-snapshot.js';
import { createPublicProjectionLookupRepository } from '../../db/src/public-projection-lookups.js';
import { createSqlFreshnessTransitionLedger } from '../../db/src/freshness-transition-ledger.js';
import { createSourceRevisionFreshnessTargetReader } from '../../db/src/source-revision-freshness-target-reader.js';
import { createSourceRevisionReviewCandidateReader } from '../../db/src/source-revision-review-candidate-reader.js';
import { applyMigrations, readMigrations } from '../../db/src/migrations.js';
import { createTestDatabase, type TestDatabase } from '../../db/test/harness.js';
import { createPublicEventDetailProjectionService } from '../src/layers/l4-application-integration/public-event-detail-projection-service.js';
import { createPublicEventHistoryProjectionService } from '../src/layers/l4-application-integration/public-event-history-projection-service.js';
import { createPublicEventListProjectionService } from '../src/layers/l4-application-integration/public-event-list-projection-service.js';
import { createPublicEventProjectionService } from '../src/layers/l4-application-integration/public-event-projection-service.js';
import { createSourceRevisionFreshnessTransitionCoordinator } from '../src/layers/l4-application-integration/source-revision-freshness-transition.js';
import type { EventDetail, EventView } from '../src/contracts/public-api.js';
import type { SqlExecutor } from '../../db/src/sql.js';

const NOW = '2026-10-05T10:00:00.000000Z';
const FUTURE = '2026-10-06T10:00:00.000000Z';
const TRACE_ID = 'trace-source-revision-public-projection';
const EVENT_ID = 'event-source-revision-public-projection';
const EVENT_VERSION = 1;
const CLAIM_ID = 'claim-source-revision-public-projection';
const UNRELATED_CLAIM_ID = 'claim-source-revision-public-unrelated';
const DIRECT_IMPACT_ID = 'impact-source-revision-public-direct';
const UNRELATED_IMPACT_ID = 'impact-source-revision-public-unrelated';
const SOURCE_ID = 'source-source-revision-public-projection';
const TARGET_REVISION_ID = 'revision-source-revision-public-target';
const ASSERTION_REVISION_ID = 'revision-source-revision-public-withdrawn-assertion';
const UNRELATED_REVISION_ID = 'revision-source-revision-public-unrelated';
const OBSERVATION_ID = 'observation-source-revision-public-withdrawn';
const PRIVATE_SOURCE_TEXT = 'AUTHORED_PRIVATE_SOURCE_REPORT_TEXT_ONLY';
const PLACE_ID = 'place-source-revision-public-fixture';
const SUPPORT_SPAN_START = 0;
const SUPPORT_SPAN_END = 12;
const EVENT_VIEW_KEYS = [
  'category', 'claims', 'event_id', 'event_time', 'freshness', 'impacts', 'lifecycle',
  'published_at', 'scope', 'summary', 'tags', 'title', 'validity', 'version',
].sort();
const CLAIM_VIEW_KEYS = [
  'claim_id', 'evidence_label', 'event_time', 'qualifiers', 'scope', 'sources', 'text', 'validity',
].sort();
const IMPACT_VIEW_KEYS = [
  'description', 'event_time', 'freshness', 'impact_id', 'impact_type', 'lifecycle',
  'scope', 'title', 'validity', 'version',
].sort();

type JsonRecord = Record<string, unknown>;

test('withdrawn source freshness reaches the existing public list and detail projections', async () => {
  const database = await createTestDatabase();
  try {
    const migrations = await readMigrations(new URL('../../db/migrations/', import.meta.url));
    await applyMigrations(database.executor, migrations);
    await seedFixture(database);

    const beforeImmutable = await readImmutablePublication(database.executor);
    const projections = createPublicProjectionServices(database.executor);
    const before = await readPublicViews(projections, EVENT_ID);

    assertPublicBaseline(before, EVENT_ID);
    assert.equal(beforeImmutable.events.length, 1);
    assert.equal(beforeImmutable.impacts.length, 2);
    assert.equal(beforeImmutable.decisions.length, 1);

    const coordinator = createSourceRevisionFreshnessTransitionCoordinator({
      candidates: createSourceRevisionReviewCandidateReader(database.executor),
      targets: createSourceRevisionFreshnessTargetReader(database.executor),
      ledger: createSqlFreshnessTransitionLedger(database.executor),
    });
    const transition = await coordinator.processPage({
      datasetKind: 'live', now: NOW, limit: 100, traceId: TRACE_ID,
    });

    assert.deepEqual(transition, {
      outcome: 'completed',
      counts: {
        candidates: 2,
        invalidatingCandidates: 2,
        selectedTargets: 2,
        duplicateCandidates: 0,
        skippedCandidates: 0,
        written: 2,
        replayed: 0,
        noChange: 0,
      },
      nextCursor: null,
    });

    const ledgerRows = await database.executor.query<{
      target_kind: string;
      impact_id: string | null;
      impact_version: number | null;
      reason: string;
      resulting_status: string;
      source_observation_id: string | null;
    }>(
      `SELECT target_kind, impact_id, impact_version, reason, resulting_status, source_observation_id
       FROM waspada.freshness_transitions
       WHERE dataset_kind = 'live' AND event_id = $1 AND event_version = $2
       ORDER BY target_kind, impact_id NULLS FIRST`,
      [EVENT_ID, EVENT_VERSION],
    );
    assert.deepEqual(ledgerRows.rows, [
      {
        target_kind: 'event_claim_set',
        impact_id: null,
        impact_version: null,
        reason: 'source_report_withdrawn',
        resulting_status: 'needs_update',
        source_observation_id: OBSERVATION_ID,
      },
      {
        target_kind: 'impact',
        impact_id: DIRECT_IMPACT_ID,
        impact_version: 1,
        reason: 'source_report_withdrawn',
        resulting_status: 'needs_update',
        source_observation_id: OBSERVATION_ID,
      },
    ], 'the existing transition coordinator writes only the event and directly supported impact targets');

    const after = await readPublicViews(projections, EVENT_ID);
    const afterImmutable = await readImmutablePublication(database.executor);

    assertPublicFreshness(after, EVENT_ID);
    assert.deepEqual(afterImmutable, beforeImmutable,
      'the event, impacts, publication decision, and stored publication content remain immutable');
    assert.deepEqual(after.history, before.history,
      'the same reviewed history entry remains available through the existing history projection');
    assert.equal(after.history.kind, 'found');
    if (after.history.kind === 'found') {
      assert.deepEqual(after.history.page.data.map(({ event_id, version }) => [event_id, version]), [
        [EVENT_ID, EVENT_VERSION],
      ]);
    }

    const beforeEvent = before.list.events[0]!;
    const afterEvent = after.list.events[0]!;
    const beforeDetail = foundDetail(before.detail);
    const afterDetail = foundDetail(after.detail);
    assert.deepEqual(withoutFreshnessStatus(afterEvent), beforeEvent,
      'the list retains the exact public publication content apart from freshness status');
    assert.deepEqual(withoutFreshnessStatus(afterDetail), beforeDetail,
      'the detail retains the exact public publication content apart from freshness status');
    assert.deepEqual(stripDetailGeometry(afterDetail), afterEvent,
      'list and detail expose the same current event and impact projection');

    assert.equal(afterEvent.event_id, EVENT_ID);
    assert.equal(afterEvent.version, EVENT_VERSION);
    assert.equal(afterEvent.title, 'Authored synthetic source-revision fixture');
    assert.equal(afterEvent.lifecycle, 'ongoing');
    assert.equal(afterEvent.freshness.status, 'needs_update');
    assert.deepEqual(
      [afterEvent.freshness.evaluated_at, afterEvent.freshness.review_due_at, afterEvent.freshness.basis],
      [beforeEvent.freshness.evaluated_at, beforeEvent.freshness.review_due_at, beforeEvent.freshness.basis],
      'the public freshness DTO retains its existing evaluation metadata while status changes',
    );
    assert.deepEqual(impactStatuses(afterEvent), [
      [DIRECT_IMPACT_ID, 'needs_update'],
      [UNRELATED_IMPACT_ID, 'current'],
    ]);
    assert.deepEqual(impactStatuses(afterDetail), impactStatuses(afterEvent));
    assert.equal(afterEvent.claims.length, 2);
    for (const claim of afterEvent.claims) {
      assert.equal(Object.hasOwn(claim, 'freshness'), false,
        'freshness stays at event and impact levels; the public claim contract is unchanged');
    }
    assert.equal(afterEvent.claims.find(({ claim_id }) => claim_id === CLAIM_ID)?.text,
      'The authored fixture describes a temporary road closure.');

    assert.deepEqual(Object.keys(afterEvent).sort(), EVENT_VIEW_KEYS);
    assert.deepEqual(Object.keys(afterDetail).sort(), [...EVENT_VIEW_KEYS, 'geometries'].sort());
    for (const claim of afterEvent.claims) assert.deepEqual(Object.keys(claim).sort(), CLAIM_VIEW_KEYS);
    for (const impact of afterEvent.impacts) assert.deepEqual(Object.keys(impact).sort(), IMPACT_VIEW_KEYS);

    const publicJson = JSON.stringify({
      list: after.list,
      detail: after.detail,
      history: after.history,
    });
    for (const privateMarker of [
      OBSERVATION_ID,
      PRIVATE_SOURCE_TEXT,
      TARGET_REVISION_ID,
      ASSERTION_REVISION_ID,
      UNRELATED_REVISION_ID,
      hash(privateSourceText(TARGET_REVISION_ID)),
      hash(privateSourceText(UNRELATED_REVISION_ID)),
      'source_observation_id',
      'source_report_withdrawn',
      'freshness_transitions',
      'transition_sequence',
      'idempotency_key',
      'request_fingerprint',
    ]) {
      assert.equal(publicJson.includes(privateMarker), false, `public projection leaked ${privateMarker}`);
    }
  } finally {
    await database.close();
  }
});

function createPublicProjectionServices(executor: Parameters<typeof createPublicEventListRepository>[0]) {
  const snapshots = createPublicEventSnapshotRepository(executor);
  const lookups = createPublicProjectionLookupRepository(executor);
  const eventProjection = createPublicEventProjectionService({ snapshots, lookups });
  const list = createPublicEventListProjectionService({
    candidates: createPublicEventListRepository(executor),
    projections: eventProjection,
  });
  const detail = createPublicEventDetailProjectionService({
    snapshots,
    lookups,
    geometries: createPublicEventGeometriesRepository(executor),
  });
  const historyCandidates = createPublicEventHistoryRepository(executor);
  const historyDisclosures = createPublicEventHistoryDisclosureRepository(executor);
  const history = createPublicEventHistoryProjectionService({
    candidates: { read: (eventId, options) => historyCandidates.read(eventId, options) },
    disclosures: { read: (eventId, options) => historyDisclosures.read(eventId, options) },
  });
  return { list, detail, history };
}

async function readPublicViews(
  services: ReturnType<typeof createPublicProjectionServices>,
  eventId: string,
) {
  const [list, detail, history] = await Promise.all([
    services.list.read({ limit: 10 }),
    services.detail.read(eventId),
    services.history.read(eventId),
  ]);
  return { list, detail, history };
}

function assertPublicBaseline(
  result: Awaited<ReturnType<typeof readPublicViews>>,
  eventId: string,
): void {
  assert.equal(result.list.events.length, 1);
  const event = result.list.events[0]!;
  assert.equal(event.event_id, eventId);
  assert.equal(event.version, EVENT_VERSION);
  assert.equal(event.freshness.status, 'current');
  assert.deepEqual(impactStatuses(event), [
    [DIRECT_IMPACT_ID, 'current'],
    [UNRELATED_IMPACT_ID, 'current'],
  ]);
  assert.equal(result.detail.kind, 'found');
  assert.equal(result.history.kind, 'found');
  if (result.history.kind === 'found') {
    assert.deepEqual(result.history.page.data.map(({ event_id, version }) => [event_id, version]), [
      [eventId, EVENT_VERSION],
    ]);
  }
}

function assertPublicFreshness(
  result: Awaited<ReturnType<typeof readPublicViews>>,
  eventId: string,
): void {
  assert.equal(result.list.events.length, 1);
  const event = result.list.events[0]!;
  const detail = foundDetail(result.detail);
  assert.equal(event.event_id, eventId);
  assert.equal(event.version, EVENT_VERSION);
  assert.equal(event.lifecycle, 'ongoing', 'source freshness does not resolve or withdraw the incident');
  assert.equal(event.freshness.status, 'needs_update');
  assert.deepEqual(impactStatuses(event), [
    [DIRECT_IMPACT_ID, 'needs_update'],
    [UNRELATED_IMPACT_ID, 'current'],
  ]);
  assert.deepEqual(impactStatuses(detail), impactStatuses(event));
  assert.equal(detail.lifecycle, 'ongoing');
}

function foundDetail(
  result: Awaited<ReturnType<ReturnType<typeof createPublicProjectionServices>['detail']['read']>>,
): EventDetail {
  assert.equal(result.kind, 'found');
  if (result.kind !== 'found') throw new Error('expected the still-published synthetic event detail');
  return result.detail;
}

function impactStatuses(event: {
  readonly impacts: readonly { readonly impact_id: string; readonly freshness: { readonly status: string } }[];
}): readonly (readonly [string, string])[] {
  return [...event.impacts]
    .sort((left, right) => left.impact_id.localeCompare(right.impact_id))
    .map((impact) => [impact.impact_id, impact.freshness.status] as const);
}

function withoutFreshnessStatus<T extends EventView | EventDetail>(value: T): T {
  const copy = structuredClone(value);
  copy.freshness.status = 'current';
  for (const impact of copy.impacts) impact.freshness.status = 'current';
  return copy;
}

function stripDetailGeometry(detail: EventDetail): EventView {
  const event = { ...detail };
  delete (event as Partial<EventDetail>).geometries;
  return event;
}

async function seedFixture(database: TestDatabase): Promise<void> {
  await database.executor.query(
    `INSERT INTO waspada.dataset_namespace_config (singleton, dataset_kind)
     VALUES (true, 'live') ON CONFLICT (singleton) DO UPDATE SET dataset_kind = EXCLUDED.dataset_kind`,
  );
  await database.executor.query(
    `INSERT INTO waspada.traces (trace_id, dataset_kind, started_at, outcome, metadata)
     VALUES ($1, 'live', $2, 'open', '{"fixture":"authored-only"}'::jsonb)`,
    [TRACE_ID, NOW],
  );
  await database.executor.query(
    `INSERT INTO waspada.source_registry
       (source_id, trace_id, registry_version, display_name, source_kind, remit, access_method,
        approved_hosts, access_restrictions, reuse_basis, registry_status, approval_status,
        health_status, auto_acquisition_enabled, auto_publication_policy)
     VALUES ($1, $2, 1, 'Authored synthetic source fixture', 'other', ARRAY['test'], 'manual_fixture',
       ARRAY[]::text[], ARRAY['authored fixture only'], ARRAY['authored test content'], 'active', 'approved',
       'unknown', false, 'never')`,
    [SOURCE_ID, TRACE_ID],
  );

  const revisions = [TARGET_REVISION_ID, ASSERTION_REVISION_ID, UNRELATED_REVISION_ID];
  for (const revisionId of revisions) {
    const permittedText = privateSourceText(revisionId);
    await database.executor.query(
      `INSERT INTO waspada.report_revisions
         (dataset_kind, report_revision_id, trace_id, source_id, canonical_url, content_hash,
          permitted_text, permitted_text_hash, normalization_version, retrieved_at,
          supersedes_id, revision_status, record_json)
       VALUES ('live', $1, $2, $3, 'https://fixture.invalid/authored-only', $4, $5, $6,
         'authored-fixture-v1', $7, NULL, 'eligible', '{"fixture":"authored-only"}'::jsonb)`,
      [revisionId, TRACE_ID, SOURCE_ID, hash(`bytes:${revisionId}`), permittedText, hash(permittedText), NOW],
    );
  }

  const evidenceRefIds = new Map<string, string>();
  for (const revisionId of [TARGET_REVISION_ID, UNRELATED_REVISION_ID]) {
    const evidence = await database.executor.query<{ evidence_ref_id: string }>(
      `INSERT INTO waspada.evidence_references
         (dataset_kind, trace_id, report_revision_id, permitted_text_hash, span_start, span_end,
          offset_unit, relation)
       VALUES ('live', $1, $2, $3, $4, $5, 'unicode_code_points', 'supports')
       RETURNING evidence_ref_id::text AS evidence_ref_id`,
      [TRACE_ID, revisionId, hash(privateSourceText(revisionId)), SUPPORT_SPAN_START, SUPPORT_SPAN_END],
    );
    const evidenceRefId = evidence.rows[0]?.evidence_ref_id;
    assert.ok(evidenceRefId);
    evidenceRefIds.set(revisionId, evidenceRefId);
  }
  const targetEvidenceRefId = evidenceRefIds.get(TARGET_REVISION_ID)!;
  const unrelatedEvidenceRefId = evidenceRefIds.get(UNRELATED_REVISION_ID)!;

  await database.executor.query(
    `INSERT INTO waspada.report_revision_source_observations
       (dataset_kind, observation_id, trace_id, source_id, target_report_revision_id,
        assertion_report_revision_id, asserted_state, replacement_report_revision_id,
        publisher_observed_at, retrieved_at)
     VALUES ('live', $1, $2, $3, $4, $5, 'withdrawn', NULL, $6, $6)`,
    [OBSERVATION_ID, TRACE_ID, SOURCE_ID, TARGET_REVISION_ID, ASSERTION_REVISION_ID, NOW],
  );

  const candidateId = 'candidate-source-revision-public-fixture';
  const contextId = 'context-source-revision-public-fixture';
  const proposalId = 'proposal-source-revision-public-fixture';
  await database.executor.query(
    `INSERT INTO waspada.extraction_results
       (dataset_kind, candidate_id, trace_id, report_revision_id, category, record_json)
     VALUES ('live', $1, $2, $3, NULL, '{"fixture":"authored-only"}'::jsonb)`,
    [candidateId, TRACE_ID, TARGET_REVISION_ID],
  );
  await database.executor.query(
    `INSERT INTO waspada.grounding_contexts
       (dataset_kind, context_id, trace_id, candidate_id, retrieval_version, index_version,
        sufficient, record_json)
     VALUES ('live', $1, $2, $3, 'fixture-retrieval-v1', 'fixture-index-v1', false,
       '{"fixture":"authored-only"}'::jsonb)`,
    [contextId, TRACE_ID, candidateId],
  );
  await database.executor.query(
    `INSERT INTO waspada.event_proposals
       (dataset_kind, proposal_id, trace_id, candidate_id, context_id, proposed_at, record_json)
     VALUES ('live', $1, $2, $3, $4, $5, '{"fixture":"authored-only"}'::jsonb)`,
    [proposalId, TRACE_ID, candidateId, contextId, NOW],
  );
  await database.executor.query(
    `INSERT INTO waspada.scope_name_review_decisions
       (review_decision_id, entity_type, entity_id, locale, review_version, decision_status,
        display_name, provenance_ref, reviewer_id, decision_reason, reviewed_at)
     VALUES ('scope-review-source-revision-public', 'place', $1, 'id-ID', 1, 'approved',
       'Synthetic fixture location', 'authored fixture', 'reviewer-synthetic',
       'Authored test display name', $2)`,
    [PLACE_ID, NOW],
  );
  for (const [index, revisionId, evidenceRefId] of [
    [1, TARGET_REVISION_ID, targetEvidenceRefId],
    [2, UNRELATED_REVISION_ID, unrelatedEvidenceRefId],
  ] as const) {
    await database.executor.query(
      `INSERT INTO waspada.public_attribution_review_decisions
         (review_decision_id, dataset_kind, evidence_ref_id, report_revision_id,
          permitted_text_hash, span_start, span_end, offset_unit, relation, review_version,
          decision_status, rights_basis_ref, public_display_name, source_url, source_published_at,
          source_observed_at, reviewer_id, decision_reason, reviewed_at)
       VALUES ($1, 'live', $2, $3, $4, $5, $6, 'unicode_code_points', 'supports', 1,
         'approved', 'authored fixture rights basis', 'Synthetic source fixture',
         'https://source.example.invalid/authored-only', $7, $7, 'reviewer-synthetic',
         'Authored fixture attribution', $7)`,
      [`attribution-review-source-revision-public-${index}`, evidenceRefId, revisionId,
        hash(privateSourceText(revisionId)), SUPPORT_SPAN_START, SUPPORT_SPAN_END, NOW],
    );
  }

  const eventRecord = makeEventRecord();
  await database.executor.transaction(async (transaction) => {
    await transaction.execute('SET CONSTRAINTS ALL DEFERRED');
    await transaction.query(
      `INSERT INTO waspada.publication_decisions
         (dataset_kind, decision_id, trace_id, proposal_id, policy_version, event_id, event_version,
          decided_at, record_json)
       VALUES ('live', 'decision-source-revision-public-fixture', $1, $2, 'fixture-policy-v1', $3, $4,
         $5, '{"fixture":"authored-only"}'::jsonb)`,
      [TRACE_ID, proposalId, EVENT_ID, EVENT_VERSION, NOW],
    );
    await transaction.query(
      `INSERT INTO waspada.event_versions
         (dataset_kind, event_id, version, trace_id, supersedes_version, title, summary, category,
          lifecycle, publication_status, withdrawal_reason, publication_decision_id, published_at,
          withdrawn_at, record_json)
       VALUES ('live', $1, $2, $3, NULL, 'Authored synthetic source-revision fixture',
         'Authored test content only.', 'transport_road_incidents', 'ongoing', 'published', NULL,
         'decision-source-revision-public-fixture', $4, NULL, $5::jsonb)`,
      [EVENT_ID, EVENT_VERSION, TRACE_ID, NOW, JSON.stringify(eventRecord)],
    );
    for (const claim of eventRecord.claims as JsonRecord[]) {
      const claimId = claim.claim_id as string;
      const revisionId = claimId === CLAIM_ID ? TARGET_REVISION_ID : UNRELATED_REVISION_ID;
      const evidenceRefId = evidenceRefIds.get(revisionId);
      assert.ok(evidenceRefId);
      await transaction.query(
        `INSERT INTO waspada.event_claims
           (dataset_kind, event_id, event_version, claim_id, claim_text, evidence_label, record_json)
         VALUES ('live', $1, $2, $3, $4, 'attributed_report', $5::jsonb)`,
        [EVENT_ID, EVENT_VERSION, claimId, claim.text, JSON.stringify(claim)],
      );
      await transaction.query(
        `INSERT INTO waspada.event_claim_evidence
           (dataset_kind, event_id, event_version, claim_id, evidence_kind, evidence_ref_id)
         VALUES ('live', $1, $2, $3, 'support', $4::bigint)`,
        [EVENT_ID, EVENT_VERSION, claimId, evidenceRefId],
      );
    }

    for (const impact of [makeImpactRecord(DIRECT_IMPACT_ID, true), makeImpactRecord(UNRELATED_IMPACT_ID, false)]) {
      await transaction.query(
        `INSERT INTO waspada.impact_versions
           (dataset_kind, impact_id, version, trace_id, event_id, event_version, impact_type,
            lifecycle, published_at, record_json)
         VALUES ('live', $1, 1, $2, $3, $4, 'road_closure', 'ongoing', $5, $6::jsonb)`,
        [impact.impact_id, TRACE_ID, EVENT_ID, EVENT_VERSION, NOW, JSON.stringify(impact)],
      );
      await transaction.query(
        `INSERT INTO waspada.event_impact_refs
           (dataset_kind, event_id, event_version, impact_id, impact_version)
         VALUES ('live', $1, $2, $3, 1)`,
        [EVENT_ID, EVENT_VERSION, impact.impact_id],
      );
      if (impact.supporting_claim_ids.length > 0) {
        await transaction.query(
          `INSERT INTO waspada.impact_claim_support
             (dataset_kind, impact_id, impact_version, event_id, event_version, claim_id)
           VALUES ('live', $1, 1, $2, $3, $4)`,
          [impact.impact_id, EVENT_ID, EVENT_VERSION, impact.supporting_claim_ids[0]],
        );
      }
    }
    await transaction.query(
      `INSERT INTO waspada.public_event_history_review_decisions
         (dataset_kind, event_id, event_version, review_status, change_type, summary,
          reviewer_id, reviewed_at)
       VALUES ('live', $1, $2, 'approved', 'published',
         'Authored synthetic publication remains visible in reviewed history.', 'reviewer-synthetic', $3)`,
      [EVENT_ID, EVENT_VERSION, NOW],
    );
  });
}

function makeScope(): JsonRecord {
  return {
    place_ids: [PLACE_ID],
    service_ids: [],
    institution_ids: [],
    audience_ids: [],
    geometry_ids: [],
  };
}

function makeSupportReference(revisionId: string): JsonRecord {
  const permittedText = privateSourceText(revisionId);
  return {
    report_revision_id: revisionId,
    permitted_text_hash: hash(permittedText),
    span_start: SUPPORT_SPAN_START,
    span_end: SUPPORT_SPAN_END,
    offset_unit: 'unicode_code_points',
    relation: 'supports',
  };
}

function makeEventRecord(): JsonRecord {
  return {
    schema_version: '2.0',
    trace_id: TRACE_ID,
    record_type: 'Event',
    dataset_kind: 'live',
    event_id: EVENT_ID,
    version: EVENT_VERSION,
    supersedes_version: null,
    title: 'Authored synthetic source-revision fixture',
    summary: 'Authored test content only.',
    category: 'transport_road_incidents',
    tags: [],
    lifecycle: 'ongoing',
    freshness: { status: 'current', evaluated_at: NOW, review_due_at: FUTURE, basis: 'manual_review' },
    event_time: { start: null, end: null, precision: 'unknown' },
    validity: { valid_from: null, valid_until: FUTURE },
    scope: makeScope(),
    claims: [
      {
        claim_id: CLAIM_ID,
        text: 'The authored fixture describes a temporary road closure.',
        event_time: { start: null, end: null, precision: 'unknown' },
        validity: { valid_from: null, valid_until: FUTURE },
        scope: makeScope(),
        qualifiers: [],
        support: [makeSupportReference(TARGET_REVISION_ID)],
        contradictions: [],
        context_evidence: [],
        origin_ids: ['origin-source-revision-public-fixture'],
        evidence_label: 'attributed_report',
      },
      {
        claim_id: UNRELATED_CLAIM_ID,
        text: 'A separate authored fixture claim remains supported by another report.',
        event_time: { start: null, end: null, precision: 'unknown' },
        validity: { valid_from: null, valid_until: FUTURE },
        scope: makeScope(),
        qualifiers: [],
        support: [makeSupportReference(UNRELATED_REVISION_ID)],
        contradictions: [],
        context_evidence: [],
        origin_ids: ['origin-source-revision-public-unrelated'],
        evidence_label: 'attributed_report',
      },
    ],
    impact_refs: [
      { impact_id: DIRECT_IMPACT_ID, version: 1 },
      { impact_id: UNRELATED_IMPACT_ID, version: 1 },
    ],
    publication_status: 'published',
    withdrawal_reason: null,
    publication_decision_id: 'decision-source-revision-public-fixture',
    published_at: NOW,
    withdrawn_at: null,
  };
}

function makeImpactRecord(impactId: string, directlySupported: boolean): JsonRecord & {
  readonly impact_id: string;
  readonly supporting_claim_ids: string[];
} {
  return {
    schema_version: '2.0',
    trace_id: TRACE_ID,
    record_type: 'Impact',
    dataset_kind: 'live',
    impact_id: impactId,
    version: 1,
    event_id: EVENT_ID,
    event_version: EVENT_VERSION,
    impact_type: 'road_closure',
    title: directlySupported ? 'Synthetic directly affected impact' : 'Synthetic unrelated impact',
    description: 'Authored synthetic impact content only.',
    lifecycle: 'ongoing',
    freshness: { status: 'current', evaluated_at: NOW, review_due_at: FUTURE, basis: 'manual_review' },
    event_time: { start: null, end: null, precision: 'unknown' },
    validity: { valid_from: null, valid_until: FUTURE },
    scope: makeScope(),
    supporting_claim_ids: [directlySupported ? CLAIM_ID : UNRELATED_CLAIM_ID],
    published_at: NOW,
  };
}

async function readImmutablePublication(executor: SqlExecutor) {
  const [events, impacts, decisions] = await Promise.all([
    executor.query<{
      event_id: string;
      version: number;
      publication_status: string;
      lifecycle: string;
      publication_decision_id: string;
      record_json: string;
    }>(
      `SELECT event_id, version, publication_status, lifecycle, publication_decision_id,
              record_json::text AS record_json
       FROM waspada.event_versions WHERE dataset_kind = 'live' AND event_id = $1 ORDER BY version`,
      [EVENT_ID],
    ),
    executor.query<{ impact_id: string; version: number; record_json: string }>(
      `SELECT impact_id, version, record_json::text AS record_json
       FROM waspada.impact_versions WHERE dataset_kind = 'live' AND event_id = $1 ORDER BY impact_id, version`,
      [EVENT_ID],
    ),
    executor.query<{ decision_id: string; event_id: string; event_version: number }>(
      `SELECT decision_id, event_id, event_version FROM waspada.publication_decisions
       WHERE dataset_kind = 'live' AND event_id = $1 ORDER BY decision_id`,
      [EVENT_ID],
    ),
  ]);
  return { events: events.rows, impacts: impacts.rows, decisions: decisions.rows };
}

function privateSourceText(revisionId: string): string {
  return `${PRIVATE_SOURCE_TEXT} ${revisionId}`;
}

function hash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
