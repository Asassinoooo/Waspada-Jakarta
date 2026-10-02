import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import {
  createFreshnessDueTargetReader,
  FreshnessDueTargetReaderError,
  type FreshnessDueTarget,
  type FreshnessDueTargetIdentity,
} from '../src/freshness-due-target-reader.js';
import { applyMigrations, readMigrations } from '../src/migrations.js';
import { createTestDatabase, type TestDatabase } from './harness.js';

const NOW = '2026-10-02T10:00:00.000000Z';
const EARLIER = '2026-10-02T09:59:59.999999Z';
const LATER = '2026-10-02T10:00:00.000001Z';
const SYNTHETIC = 'synthetic' as const;
const HISTORICAL = 'historical' as const;
const TRANSITION_AT = '2026-10-02T08:30:00Z';

describe('read-only freshness due-target reader', () => {
  let database: TestDatabase;
  let reader: ReturnType<typeof createFreshnessDueTargetReader>;
  let recoveryEvidenceId: string;

  before(async () => {
    database = await createTestDatabase();
    const migrations = await readMigrations(new URL('../migrations/', import.meta.url));
    await applyMigrations(database.executor, migrations);
    reader = createFreshnessDueTargetReader(database.executor);
    await database.executor.query(
      `INSERT INTO waspada.dataset_namespace_config (singleton, dataset_kind, configured_at)
       VALUES (true, 'synthetic', $1)
       ON CONFLICT (singleton) DO UPDATE SET dataset_kind = EXCLUDED.dataset_kind,
         configured_at = EXCLUDED.configured_at`,
      [NOW],
    );
    recoveryEvidenceId = await seedLineage(database, SYNTHETIC);
    await seedLineage(database, HISTORICAL);
    await seedFixtures(database, recoveryEvidenceId);
  });

  after(async () => database?.close());

  it('returns only due candidates at inclusive validity and review boundaries', async () => {
    const page = await reader.read({ datasetKind: SYNTHETIC, now: NOW, limit: 100 });
    const candidates = page.targets;
    assert.equal(page.nextCursor, null);

    assert.ok(findTarget(candidates, 'due-valid-equal', 'event_claim_set'));
    assert.ok(findTarget(candidates, 'due-valid-past', 'event_claim_set'));
    assert.ok(findTarget(candidates, 'due-review-before', 'event_claim_set'));
    assert.ok(findTarget(candidates, 'due-review-equal', 'event_claim_set'));
    assert.ok(findTarget(candidates, 'due-fraction-offset-equal', 'event_claim_set'));
    assert.ok(findTarget(candidates, 'due-fractional-precision', 'event_claim_set'));

    const fractionalBoundary = await reader.read({
      datasetKind: SYNTHETIC,
      now: '2026-10-02T10:00:00.000000900Z',
      limit: 100,
    });
    const exactFractionalCandidate = findTarget(fractionalBoundary.targets, 'due-fraction-after', 'event_claim_set');
    assert.ok(exactFractionalCandidate);
    assert.equal(exactFractionalCandidate.validUntil, '2026-10-02T10:00:00.0000009Z');

    for (const eventId of [
      'a-not-due', 'due-valid-future', 'due-review-after', 'due-fraction-after',
      'stale-review-only', 'already-expired', 'versioned-event', 'withdrawn-event',
    ]) {
      assert.equal(findTarget(candidates, eventId, 'event_claim_set'), undefined, `${eventId} is not a candidate`);
    }

    const bothTimes = findTarget(candidates, 'expiry-precedence', 'event_claim_set');
    assert.ok(bothTimes);
    assert.equal(bothTimes.status, 'current');
    assert.equal(bothTimes.validUntil, NOW);
    assert.equal(bothTimes.reviewDueAt, NOW);
  });

  it('uses exact immutable target status plus the latest exact transition sequence', async () => {
    const page = await reader.read({ datasetKind: SYNTHETIC, now: NOW, limit: 100 });

    const claimSet = findTarget(page.targets, 'aggregate-independent-event', 'event_claim_set');
    assert.ok(claimSet);
    assert.equal(claimSet.status, 'current');
    assert.equal(claimSet.transitionSequence, 0);
    const aggregate = await database.executor.query<{ freshness_status: string }>(
      `SELECT freshness_status FROM waspada.public_event_versions
       WHERE dataset_kind = 'synthetic' AND event_id = 'aggregate-independent-event'`,
    );
    assert.equal(aggregate.rows[0]?.freshness_status, 'needs_update',
      'the public aggregate differs because the referenced impact is expired');

    const needsUpdate = findTarget(page.targets, 'due-transition-needs-update', 'event_claim_set');
    assert.ok(needsUpdate);
    assert.equal(needsUpdate.status, 'needs_update');
    assert.equal(needsUpdate.transitionSequence, 1);

    const latest = findTarget(page.targets, 'due-sequence-event', 'event_claim_set');
    assert.ok(latest);
    assert.equal(latest.status, 'current');
    assert.equal(latest.transitionSequence, 2);
  });

  it('uses only exact current impact references and preserves their own freshness inputs', async () => {
    const page = await reader.read({ datasetKind: SYNTHETIC, now: NOW, limit: 100 });
    const fallback = findTarget(page.targets, 'impact-fallback-event', 'impact', 'impact-fallback');
    assert.ok(fallback);
    assert.ok(fallback.target.kind === 'impact');
    assert.equal(fallback.target.impactVersion, 1);
    assert.equal(fallback.status, 'current');
    assert.equal(fallback.transitionSequence, 0);
    assert.equal(fallback.validUntil, null);
    assert.equal(fallback.reviewDueAt, NOW);

    const transitioned = findTarget(page.targets, 'impact-transition-event', 'impact', 'impact-shared');
    assert.ok(transitioned);
    assert.ok(transitioned.target.kind === 'impact');
    assert.equal(transitioned.target.impactVersion, 1);
    assert.equal(transitioned.status, 'needs_update');
    assert.equal(transitioned.transitionSequence, 1);
    assert.equal(transitioned.validUntil, '2026-10-02T09:00:00Z');
    assert.equal(findTarget(page.targets, 'impact-transition-event', 'impact', 'impact-shared', 2), undefined,
      'an unreferenced impact version is excluded');
    assert.equal(findTarget(page.targets, 'versioned-event', 'impact', 'old-impact'), undefined,
      'a reference attached only to the older event version is excluded');
  });

  it('isolates the requested dataset and never returns a superseded or withdrawn event version', async () => {
    const syntheticPage = await reader.read({ datasetKind: SYNTHETIC, now: NOW, limit: 100 });
    const historicalPage = await reader.read({ datasetKind: HISTORICAL, now: NOW, limit: 100 });
    const syntheticTarget = findTarget(syntheticPage.targets, 'dataset-shared', 'event_claim_set');
    const historicalTarget = findTarget(historicalPage.targets, 'dataset-shared', 'event_claim_set');
    assert.ok(syntheticTarget);
    assert.ok(historicalTarget);
    assert.equal(syntheticTarget.datasetKind, SYNTHETIC);
    assert.equal(historicalTarget.datasetKind, HISTORICAL);
    assert.equal(syntheticPage.targets.some((target) => target.datasetKind === HISTORICAL), false);

    assert.equal(findTarget(syntheticPage.targets, 'versioned-event', 'event_claim_set'), undefined);
    assert.equal(findTarget(syntheticPage.targets, 'withdrawn-event', 'event_claim_set'), undefined);
  });

  it('filters due rows before limit-plus-one and continues in stable target-key order', async () => {
    const filtered = await reader.read({
      datasetKind: SYNTHETIC,
      now: NOW,
      limit: 1,
      cursor: { eventId: 'page-0-start', eventVersion: 1, target: { kind: 'event_claim_set' } },
    });
    assert.deepEqual(filtered.targets.map(({ eventId }) => eventId), ['page-b-due'],
      'non-due rows after the cursor do not consume the page probe');

    const first = await reader.read({
      datasetKind: SYNTHETIC,
      now: NOW,
      limit: 2,
      cursor: cursor('page-b-due', { kind: 'event_claim_set' }),
    });
    assert.deepEqual(first.targets.map(targetKey), [
      'page-c-targets:event_claim_set',
      'page-c-targets:impact:impact-a',
    ]);
    assert.deepEqual(first.nextCursor, cursor('page-c-targets', { kind: 'impact', impactId: 'impact-a', impactVersion: 1 }));

    const second = await reader.read({
      datasetKind: SYNTHETIC,
      now: NOW,
      limit: 2,
      cursor: first.nextCursor,
    });
    assert.deepEqual(second.targets.map(targetKey), [
      'page-c-targets:impact:impact-b',
      'page-d-due:event_claim_set',
    ]);
    assert.equal(second.nextCursor, null);
    assert.equal(new Set([...first.targets, ...second.targets].map(targetKey)).size, 4,
      'keyset continuation has no duplicates');
  });

  it('returns only minimal identity, effective status, sequence, and the two time fields', async () => {
    const page = await reader.read({ datasetKind: SYNTHETIC, now: NOW, limit: 100 });
    const target = findTarget(page.targets, 'due-valid-equal', 'event_claim_set');
    assert.ok(target);
    assert.deepEqual(Object.keys(target), [
      'datasetKind', 'eventId', 'eventVersion', 'target', 'status', 'transitionSequence', 'validUntil', 'reviewDueAt',
    ]);
    assert.equal('recordJson' in target, false);
    assert.equal('claims' in target, false);
    assert.equal(JSON.stringify(page).includes('Authored private fixture text'), false);
  });

  it('runs under the existing L4 capability and denies public, L1, and L2 roles', async () => {
    await database.executor.execute('SET ROLE waspada_l4_freshness_writer');
    try {
      const allowed = await reader.read({ datasetKind: SYNTHETIC, now: NOW, limit: 1 });
      assert.equal(allowed.targets.length, 1);
    } finally {
      await database.executor.execute('RESET ROLE');
    }

    for (const role of [
      'waspada_public_reader', 'waspada_l1_pipeline', 'waspada_l2_grounding_reader',
      'waspada_l2_grounding_writer', 'waspada_l2_proposal_writer',
    ]) {
      await database.executor.execute(`SET ROLE ${role}`);
      try {
        await assert.rejects(reader.read({ datasetKind: SYNTHETIC, now: NOW, limit: 1 }),
          (error: unknown) => error instanceof FreshnessDueTargetReaderError
            && error.code === 'READ_FAILED'
            && error.message === 'The freshness due-target page could not be read.',
          `${role} cannot use the private candidate path`);
        await assert.rejects(
          database.executor.query('SELECT transition_id FROM waspada.freshness_transitions'),
          /permission denied/i,
          `${role} cannot directly read the private ledger`,
        );
      } finally {
        await database.executor.execute('RESET ROLE');
      }
    }
  });

  it('rejects malformed requests and results with stable redacted errors', async () => {
    let calls = 0;
    const unusedReader = createFreshnessDueTargetReader({
      async query<Row extends object>() {
        calls += 1;
        return { rows: [] as Row[] };
      },
      async execute() {},
    });
    const invalidRequests: unknown[] = [
      { now: NOW, limit: 1 },
      { datasetKind: 'all', now: NOW, limit: 1 },
      { datasetKind: SYNTHETIC, now: '2026-02-30T10:00:00Z', limit: 1 },
      { datasetKind: SYNTHETIC, now: 'private-cursor-secret', limit: 1 },
      { datasetKind: SYNTHETIC, now: NOW, limit: 101 },
      { datasetKind: SYNTHETIC, now: NOW, limit: 1, cursor: { eventId: 'x', eventVersion: 1, target: { kind: 'impact' } } },
      { datasetKind: SYNTHETIC, now: NOW, limit: 1, private: 'Authored private fixture text' },
    ];
    for (const request of invalidRequests) {
      await assert.rejects(unusedReader.read(request),
        (error: unknown) => error instanceof FreshnessDueTargetReaderError
          && error.code === 'INVALID_REQUEST'
          && error.message === 'The freshness due-target request is invalid.'
          && !error.message.includes('private-cursor-secret'));
    }
    assert.equal(calls, 0, 'invalid request timestamps and cursors never reach SQL');

    const failingReader = createFreshnessDueTargetReader({
      async query() { throw new Error('database detail includes source content'); },
      async execute() {},
    });
    await assert.rejects(failingReader.read({ datasetKind: SYNTHETIC, now: NOW, limit: 1 }),
      (error: unknown) => error instanceof FreshnessDueTargetReaderError
        && error.code === 'READ_FAILED'
        && !error.message.includes('source content'));

    const malformedResultReader = createFreshnessDueTargetReader({
      async query<Row extends object>() {
        return { rows: [{
          dataset_kind: SYNTHETIC,
          event_id: 'result-secret',
          event_version: 1,
          target_kind: 'event_claim_set',
          impact_id: null,
          impact_version: null,
          status: 'current',
          transition_sequence: 0,
          valid_until: '2026-02-30T10:00:00Z',
          review_due_at: null,
        }] as unknown as Row[] };
      },
      async execute() {},
    });
    await assert.rejects(malformedResultReader.read({ datasetKind: SYNTHETIC, now: NOW, limit: 1 }),
      (error: unknown) => error instanceof FreshnessDueTargetReaderError
        && error.code === 'INVALID_RESULT'
        && error.message === 'The freshness due-target page could not be validated.'
        && !error.message.includes('result-secret'));
  });
});

function findTarget(
  targets: readonly FreshnessDueTarget[],
  eventId: string,
  kind: FreshnessDueTargetIdentity['kind'],
  impactId?: string,
  impactVersion?: number,
): FreshnessDueTarget | undefined {
  return targets.find((target) => target.eventId === eventId && target.target.kind === kind
    && (kind !== 'impact' || (target.target.kind === 'impact'
      && target.target.impactId === impactId
      && (impactVersion === undefined || target.target.impactVersion === impactVersion))));
}

function cursor(eventId: string, target: FreshnessDueTargetIdentity) {
  return { eventId, eventVersion: 1, target };
}

function targetKey(target: FreshnessDueTarget): string {
  return target.target.kind === 'event_claim_set'
    ? `${target.eventId}:event_claim_set`
    : `${target.eventId}:impact:${target.target.impactId}`;
}

async function seedFixtures(database: TestDatabase, recoveryEvidenceId: string): Promise<void> {
  await seedEvent(database, 'a-not-due', [{ validUntil: LATER, reviewDueAt: LATER }]);
  await seedEvent(database, 'due-valid-equal', [{ validUntil: NOW }]);
  await seedEvent(database, 'due-valid-past', [{ validUntil: EARLIER }]);
  await seedEvent(database, 'due-valid-future', [{ validUntil: LATER }]);
  await seedEvent(database, 'due-review-before', [{ reviewDueAt: EARLIER }]);
  await seedEvent(database, 'due-review-equal', [{ reviewDueAt: NOW }]);
  await seedEvent(database, 'due-review-after', [{ reviewDueAt: LATER }]);
  await seedEvent(database, 'due-fraction-after', [{ validUntil: '2026-10-02T10:00:00.0000009Z' }]);
  await seedEvent(database, 'due-fraction-offset-equal', [{ validUntil: '2026-10-02T12:00:00.000000+02:00' }]);
  await seedEvent(database, 'due-fractional-precision', [{ validUntil: '2026-10-02T10:00:00.000000000Z' }]);
  await seedEvent(database, 'expiry-precedence', [{ validUntil: NOW, reviewDueAt: NOW }]);
  await seedEvent(database, 'stale-review-only', [{ status: 'needs_update', reviewDueAt: EARLIER }]);
  await seedEvent(database, 'already-expired', [{ status: 'expired', validUntil: EARLIER, reviewDueAt: EARLIER }]);

  await seedEvent(database, 'due-transition-needs-update', [{
    validUntil: '2026-10-02T09:00:00Z', reviewDueAt: '2026-10-02T08:00:00Z',
  }]);
  await insertTransition(database, {
    eventId: 'due-transition-needs-update', targetKind: 'event_claim_set', targetVersion: 1,
    sequence: 1, previousStatus: 'current', resultingStatus: 'needs_update',
    reason: 'review_deadline_missed', evaluatedAt: TRANSITION_AT,
  });

  await seedEvent(database, 'due-sequence-event', [{
    validUntil: '2026-10-02T09:00:00Z', reviewDueAt: '2026-10-02T08:00:00Z',
  }]);
  await insertTransitionSequence(database, 'due-sequence-event', recoveryEvidenceId);

  await seedEvent(database, 'aggregate-independent-event', [{
    validUntil: LATER, reviewDueAt: NOW,
  }]);
  await seedImpact(database, {
    eventId: 'aggregate-independent-event', eventVersion: 1, impactId: 'impact-aggregate',
    impactVersion: 1, status: 'expired', validUntil: EARLIER, reviewDueAt: EARLIER, referenced: true,
  });

  await seedEvent(database, 'impact-fallback-event', [{
    validUntil: LATER, reviewDueAt: LATER,
    impactRefs: [{ impactId: 'impact-fallback', impactVersion: 1 }],
  }]);
  await seedImpact(database, {
    eventId: 'impact-fallback-event', eventVersion: 1, impactId: 'impact-fallback',
    impactVersion: 1, status: 'current', reviewDueAt: NOW, referenced: true,
  });

  await seedEvent(database, 'impact-transition-event', [{
    validUntil: LATER, reviewDueAt: LATER,
    impactRefs: [{ impactId: 'impact-shared', impactVersion: 1 }],
  }]);
  await seedImpact(database, {
    eventId: 'impact-transition-event', eventVersion: 1, impactId: 'impact-shared',
    impactVersion: 1, status: 'current', validUntil: '2026-10-02T09:00:00Z',
    reviewDueAt: '2026-10-02T08:00:00Z', referenced: true,
  });
  await seedImpact(database, {
    eventId: 'impact-transition-event', eventVersion: 1, impactId: 'impact-shared',
    impactVersion: 2, status: 'current', validUntil: EARLIER, referenced: false,
  });
  await insertTransition(database, {
    eventId: 'impact-transition-event', targetKind: 'impact', impactId: 'impact-shared',
    targetVersion: 1, sequence: 1, previousStatus: 'current', resultingStatus: 'needs_update',
    reason: 'review_deadline_missed', evaluatedAt: TRANSITION_AT,
  });

  await seedVersionedEvent(database, 'versioned-event', {
    reviewDueAt: EARLIER,
    impactRefs: [{ impactId: 'old-impact', impactVersion: 1 }],
  });
  await seedImpact(database, {
    eventId: 'versioned-event', eventVersion: 1, impactId: 'old-impact', impactVersion: 1,
    status: 'current', validUntil: LATER, reviewDueAt: EARLIER, referenced: true,
  });
  await insertTransition(database, {
    eventId: 'versioned-event', targetKind: 'event_claim_set', targetVersion: 1,
    sequence: 1, previousStatus: 'current', resultingStatus: 'needs_update',
    reason: 'review_deadline_missed', evaluatedAt: TRANSITION_AT,
  });
  await insertTransition(database, {
    eventId: 'versioned-event', targetKind: 'impact', impactId: 'old-impact', targetVersion: 1,
    sequence: 1, previousStatus: 'current', resultingStatus: 'needs_update',
    reason: 'review_deadline_missed', evaluatedAt: TRANSITION_AT,
  });
  await seedEventVersion(database, 'versioned-event', 2, { validUntil: LATER, reviewDueAt: LATER });

  await seedVersionedEvent(database, 'withdrawn-event', {
    validUntil: EARLIER,
    reviewDueAt: EARLIER,
  });
  await insertTransition(database, {
    eventId: 'withdrawn-event', targetKind: 'event_claim_set', targetVersion: 1,
    sequence: 1, previousStatus: 'current', resultingStatus: 'needs_update',
    reason: 'review_deadline_missed', evaluatedAt: TRANSITION_AT,
  });
  await seedEventVersion(database, 'withdrawn-event', 2, { publicationStatus: 'withdrawn' });

  await seedEvent(database, 'dataset-shared', [{ reviewDueAt: NOW }]);
  await seedEvent(database, 'dataset-shared', [{ reviewDueAt: NOW }], HISTORICAL);

  await seedEvent(database, 'page-1-not-due', [{ validUntil: LATER, reviewDueAt: LATER }]);
  await seedEvent(database, 'page-2-not-due', [{ validUntil: LATER, reviewDueAt: LATER }]);
  await seedEvent(database, 'page-b-due', [{ reviewDueAt: NOW }]);
  await seedEvent(database, 'page-c-targets', [{
    reviewDueAt: NOW,
    impactRefs: [
      { impactId: 'impact-a', impactVersion: 1 },
      { impactId: 'impact-b', impactVersion: 1 },
    ],
  }]);
  await seedImpact(database, {
    eventId: 'page-c-targets', eventVersion: 1, impactId: 'impact-a', impactVersion: 1,
    status: 'current', validUntil: NOW, referenced: true,
  });
  await seedImpact(database, {
    eventId: 'page-c-targets', eventVersion: 1, impactId: 'impact-b', impactVersion: 1,
    status: 'current', validUntil: NOW, referenced: true,
  });
  await seedEvent(database, 'page-d-due', [{ reviewDueAt: NOW }]);
}

async function seedLineage(database: TestDatabase, datasetKind: 'synthetic' | 'historical'): Promise<string> {
  const suffix = datasetKind;
  const traceId = traceFor(datasetKind);
  const sourceId = `source-freshness-due-${suffix}`;
  const revisionId = `revision-freshness-due-${suffix}`;
  const candidateId = `candidate-freshness-due-${suffix}`;
  const contextId = `context-freshness-due-${suffix}`;
  const proposalId = `proposal-freshness-due-${suffix}`;
  const reportText = 'Authored private fixture text; no report or public event was observed.';
  const permittedTextHash = hash(reportText);

  await database.executor.query(
    `INSERT INTO waspada.traces (trace_id, dataset_kind, started_at, outcome, metadata)
     VALUES ($1, $2, $3, 'open', '{"fixture":"synthetic-only"}'::jsonb)`,
    [traceId, datasetKind, NOW],
  );
  await database.executor.query(
    `INSERT INTO waspada.source_registry
       (source_id, trace_id, registry_version, display_name, source_kind, remit, access_method,
        approved_hosts, access_restrictions, reuse_basis, registry_status, approval_status,
        health_status, auto_acquisition_enabled, auto_publication_policy)
     VALUES ($1, $2, 1, 'Authored synthetic source', 'other', ARRAY['test'],
       'manual_fixture', ARRAY[]::text[], ARRAY['synthetic only'], ARRAY['authored fixture'],
       'active', 'approved', 'unknown', false, 'never')`,
    [sourceId, traceId],
  );
  await database.executor.query(
    `INSERT INTO waspada.report_revisions
       (dataset_kind, report_revision_id, trace_id, source_id, canonical_url, content_hash,
        permitted_text, permitted_text_hash, normalization_version, retrieved_at, revision_status, record_json)
     VALUES ($1, $2, $3, $4, 'https://synthetic.invalid/freshness-due', $5, $6, $7,
       'normalization-fixture-v1', $8, 'eligible', '{"fixture":"synthetic-only"}'::jsonb)`,
    [datasetKind, revisionId, traceId, sourceId, hash('synthetic report content'), reportText, permittedTextHash, NOW],
  );
  await database.executor.query(
    `INSERT INTO waspada.evidence_references
       (dataset_kind, trace_id, report_revision_id, permitted_text_hash, span_start, span_end,
        offset_unit, relation)
     VALUES ($1, $2, $3, $4, 0, 8, 'unicode_code_points', 'supports')`,
    [datasetKind, traceId, revisionId, permittedTextHash],
  );
  const evidenceResult = await database.executor.query<{ evidence_ref_id: string }>(
    `SELECT evidence_ref_id::text AS evidence_ref_id
     FROM waspada.evidence_references WHERE dataset_kind = $1 AND report_revision_id = $2`,
    [datasetKind, revisionId],
  );
  await database.executor.query(
    `INSERT INTO waspada.extraction_results
       (dataset_kind, candidate_id, trace_id, report_revision_id, category, record_json)
     VALUES ($1, $2, $3, $4, NULL, '{"fixture":"synthetic-only"}'::jsonb)`,
    [datasetKind, candidateId, traceId, revisionId],
  );
  await database.executor.query(
    `INSERT INTO waspada.grounding_contexts
       (dataset_kind, context_id, trace_id, candidate_id, retrieval_version, index_version, sufficient, record_json)
     VALUES ($1, $2, $3, $4, 'fixture-retrieval-v1', 'fixture-index-v1', false,
       '{"fixture":"synthetic-only"}'::jsonb)`,
    [datasetKind, contextId, traceId, candidateId],
  );
  await database.executor.query(
    `INSERT INTO waspada.event_proposals
       (dataset_kind, proposal_id, trace_id, candidate_id, context_id, proposed_at, record_json)
     VALUES ($1, $2, $3, $4, $5, $6, '{"fixture":"synthetic-only"}'::jsonb)`,
    [datasetKind, proposalId, traceId, candidateId, contextId, NOW],
  );
  return evidenceResult.rows[0]!.evidence_ref_id;
}

interface EventFixture {
  readonly publicationStatus?: 'published' | 'withdrawn';
  readonly status?: 'current' | 'needs_update' | 'expired';
  readonly validUntil?: string | null;
  readonly reviewDueAt?: string | null;
  readonly impactRefs?: readonly { readonly impactId: string; readonly impactVersion: number }[];
}

async function seedEvent(
  database: TestDatabase,
  eventId: string,
  versions: readonly EventFixture[],
  datasetKind: 'synthetic' | 'historical' = SYNTHETIC,
): Promise<void> {
  for (let index = 0; index < versions.length; index += 1) {
    await seedEventVersion(database, eventId, index + 1, versions[index]!, datasetKind);
  }
}

async function seedVersionedEvent(database: TestDatabase, eventId: string, first: EventFixture): Promise<void> {
  await seedEventVersion(database, eventId, 1, first);
}

async function seedEventVersion(
  database: TestDatabase,
  eventId: string,
  version: number,
  fixture: EventFixture,
  datasetKind: 'synthetic' | 'historical' = SYNTHETIC,
): Promise<void> {
  const publicationStatus = fixture.publicationStatus ?? 'published';
  const decisionId = `decision-${datasetKind}-${eventId}-${version}`;
  const proposalId = `proposal-freshness-due-${datasetKind}`;
  const traceId = traceFor(datasetKind);
  const withdrawn = publicationStatus === 'withdrawn';
  const record = {
    schema_version: '2.0',
    trace_id: traceId,
    record_type: 'Event',
    dataset_kind: datasetKind,
    event_id: eventId,
    version,
    supersedes_version: version === 1 ? null : version - 1,
    title: 'Authored synthetic event fixture',
    summary: 'No event was observed or assessed.',
    category: 'group_specific_critical_notices',
    tags: [],
    lifecycle: 'unknown',
    freshness: freshnessRecord(fixture.status ?? 'current', fixture.reviewDueAt ?? null),
    event_time: { start: null, end: null, precision: 'unknown' },
    validity: { valid_from: null, valid_until: fixture.validUntil ?? null },
    scope: { place_ids: [], service_ids: [], institution_ids: [], audience_ids: [], geometry_ids: [] },
    claims: withdrawn ? [] : [{ claim_id: `claim-${eventId}-${version}`, text: 'Authored synthetic claim.' }],
    impact_refs: withdrawn ? [] : (fixture.impactRefs ?? []).map(({ impactId, impactVersion }) => ({
      impact_id: impactId,
      version: impactVersion,
    })),
    publication_status: publicationStatus,
    withdrawal_reason: withdrawn ? 'other' : null,
    publication_decision_id: decisionId,
    published_at: withdrawn ? null : NOW,
    withdrawn_at: withdrawn ? NOW : null,
  };

  await database.executor.transaction(async (transaction) => {
    await transaction.query(
      `INSERT INTO waspada.publication_decisions
         (dataset_kind, decision_id, trace_id, proposal_id, policy_version, event_id,
          event_version, decided_at, record_json)
       VALUES ($1, $2, $3, $4, 'fixture-policy-v1', $5, $6, $7,
         '{"fixture":"synthetic-only"}'::jsonb)`,
      [datasetKind, decisionId, traceId, proposalId, eventId, version, NOW],
    );
    await transaction.query(
      `INSERT INTO waspada.event_versions
         (dataset_kind, event_id, version, trace_id, supersedes_version, title, summary, category,
          lifecycle, publication_status, withdrawal_reason, publication_decision_id,
          published_at, withdrawn_at, record_json)
       VALUES ($1, $2, $3, $4, $5, 'Authored synthetic event fixture', 'No event was observed or assessed.',
         'group_specific_critical_notices', 'unknown', $6, $7, $8, $9, $10, $11::jsonb)`,
      [datasetKind, eventId, version, traceId, version === 1 ? null : version - 1,
        publicationStatus, withdrawn ? 'other' : null, decisionId,
        withdrawn ? null : NOW, withdrawn ? NOW : null, JSON.stringify(record)],
    );
  });
}

interface ImpactFixture {
  readonly eventId: string;
  readonly eventVersion: number;
  readonly impactId: string;
  readonly impactVersion: number;
  readonly status: 'current' | 'needs_update' | 'expired';
  readonly validUntil?: string | null;
  readonly reviewDueAt?: string | null;
  readonly referenced: boolean;
}

async function seedImpact(database: TestDatabase, fixture: ImpactFixture): Promise<void> {
  const impactRecord = {
    schema_version: '2.0',
    trace_id: traceFor(SYNTHETIC),
    record_type: 'Impact',
    dataset_kind: SYNTHETIC,
    impact_id: fixture.impactId,
    version: fixture.impactVersion,
    event_id: fixture.eventId,
    event_version: fixture.eventVersion,
    impact_type: 'road_closure',
    title: 'Authored synthetic impact fixture',
    description: 'Private fixture content; never projected by the reader.',
    lifecycle: 'unknown',
    freshness: freshnessRecord(fixture.status, fixture.reviewDueAt ?? null),
    event_time: { start: null, end: null, precision: 'unknown' },
    validity: { valid_from: null, valid_until: fixture.validUntil ?? null },
    scope: { place_ids: [], service_ids: [], institution_ids: [], audience_ids: [], geometry_ids: [] },
    supporting_claim_ids: [],
    published_at: NOW,
  };
  await database.executor.query(
    `INSERT INTO waspada.impact_versions
       (dataset_kind, impact_id, version, trace_id, event_id, event_version, impact_type,
        lifecycle, published_at, record_json)
     VALUES ('synthetic', $1, $2, $3, $4, $5, 'road_closure', 'unknown', $6, $7::jsonb)`,
    [fixture.impactId, fixture.impactVersion, traceFor(SYNTHETIC), fixture.eventId,
      fixture.eventVersion, NOW, JSON.stringify(impactRecord)],
  );
  if (fixture.referenced) {
    await database.executor.query(
      `INSERT INTO waspada.event_impact_refs
         (dataset_kind, event_id, event_version, impact_id, impact_version)
       VALUES ('synthetic', $1, $2, $3, $4)`,
      [fixture.eventId, fixture.eventVersion, fixture.impactId, fixture.impactVersion],
    );
  }
}

interface TransitionFixture {
  readonly eventId: string;
  readonly datasetKind?: 'synthetic' | 'historical';
  readonly targetKind: 'event_claim_set' | 'impact';
  readonly impactId?: string;
  readonly targetVersion: number;
  readonly sequence: number;
  readonly previousStatus: 'current' | 'needs_update' | 'expired';
  readonly resultingStatus: 'current' | 'needs_update' | 'expired';
  readonly reason: 'issuer_validity_ended' | 'new_applicable_evidence_evaluated' | 'review_deadline_missed';
  readonly evaluatedAt?: string;
  readonly evidenceReferenceId?: string;
}

async function insertTransition(database: TestDatabase, fixture: TransitionFixture): Promise<void> {
  await insertTransitionRows(database, [fixture]);
}

async function insertTransitionSequence(
  database: TestDatabase,
  eventId: string,
  evidenceReferenceId: string,
): Promise<void> {
  await insertTransitionRows(database, [
    {
      eventId, targetKind: 'event_claim_set', targetVersion: 1, sequence: 1,
      previousStatus: 'current', resultingStatus: 'needs_update',
      reason: 'review_deadline_missed', evaluatedAt: '2026-10-02T08:15:00Z',
    },
    {
      eventId, targetKind: 'event_claim_set', targetVersion: 1, sequence: 2,
      previousStatus: 'needs_update', resultingStatus: 'current',
      reason: 'new_applicable_evidence_evaluated', evaluatedAt: TRANSITION_AT, evidenceReferenceId,
    },
  ]);
}

async function insertTransitionRows(database: TestDatabase, fixtures: readonly TransitionFixture[]): Promise<void> {
  const datasetKind = fixtures[0]!.datasetKind ?? SYNTHETIC;
  await database.executor.transaction(async (transaction) => {
    for (const fixture of fixtures) {
      const impact = fixture.targetKind === 'impact';
      const inserted = await transaction.query<{ transition_id: string }>(
        `INSERT INTO waspada.freshness_transitions
           (dataset_kind, event_id, event_version, target_kind, impact_id, impact_version,
            transition_sequence, previous_status, resulting_status, reason, evaluated_at,
            trace_id, idempotency_key, request_fingerprint)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
         RETURNING transition_id::text AS transition_id`,
        [fixture.datasetKind ?? datasetKind, fixture.eventId, 1, fixture.targetKind,
          impact ? fixture.impactId : null, impact ? fixture.targetVersion : null,
          fixture.sequence, fixture.previousStatus, fixture.resultingStatus, fixture.reason,
          fixture.evaluatedAt ?? TRANSITION_AT, traceFor(fixture.datasetKind ?? datasetKind),
          `due-reader:${fixture.eventId}:${fixture.targetKind}:${fixture.sequence}`,
          hash(`transition:${fixture.eventId}:${fixture.targetKind}:${fixture.sequence}`)],
      );
      if (fixture.evidenceReferenceId) {
        await transaction.query(
          `INSERT INTO waspada.freshness_transition_evidence (transition_id, dataset_kind, evidence_ref_id)
           VALUES ($1::bigint, $2, $3::bigint)`,
          [inserted.rows[0]!.transition_id, fixture.datasetKind ?? datasetKind, fixture.evidenceReferenceId],
        );
      }
    }
  });
}

function freshnessRecord(status: 'current' | 'needs_update' | 'expired', reviewDueAt: string | null) {
  return { status, evaluated_at: NOW, review_due_at: reviewDueAt, basis: 'manual_review' };
}

function traceFor(datasetKind: 'synthetic' | 'historical'): string {
  return `trace-freshness-due-${datasetKind}`;
}

function hash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
