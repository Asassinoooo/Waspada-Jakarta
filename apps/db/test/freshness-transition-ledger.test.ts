import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import {
  createSqlFreshnessTransitionLedger,
  FreshnessTransitionLedgerInputError,
  type AppendFreshnessTransitionInput,
} from '../src/freshness-transition-ledger.js';
import { applyMigrations, readMigrations } from '../src/migrations.js';
import { createTestDatabase, type TestDatabase } from './harness.js';

const NOW = '2026-10-01T10:00:00Z';
const DATASET = 'synthetic' as const;
const TRACE = 'trace-freshness-ledger';
const EVIDENCE_REF = '1';

describe('append-only freshness transition ledger', () => {
  let database: TestDatabase;
  let ledger: ReturnType<typeof createSqlFreshnessTransitionLedger>;

  before(async () => {
    database = await createTestDatabase();
    const migrations = await readMigrations(new URL('../migrations/', import.meta.url));
    await applyMigrations(database.executor, migrations);
    ledger = createSqlFreshnessTransitionLedger(database.executor);
    await seedSyntheticFixture(database);
  });

  after(async () => database?.close());

  it('writes initial event and exact referenced impact transitions without changing publication records', async () => {
    const before = await immutableSnapshot(database);
    const eventInput = makeInput({
      eventId: 'event-ledger-main', expectedSequence: 1, previousStatus: 'current',
      resultingStatus: 'needs_update', reason: 'review_deadline_missed', idempotencyKey: 'ledger:main:event:1',
    });
    const eventResult = await ledger.append(eventInput);
    assert.equal(eventResult.outcome, 'written');
    if (eventResult.outcome !== 'written') return;
    assert.equal(eventResult.record.transitionSequence, 1);
    assert.deepEqual(eventResult.record.target, { kind: 'event_claim_set' });
    assert.equal(eventResult.record.resultingStatus, 'needs_update');
    assert.deepEqual(eventResult.record.evidenceReferenceIds, []);

    const impactResult = await ledger.append(makeInput({
      eventId: 'event-ledger-main', target: { kind: 'impact', impactId: 'impact-ledger-main', impactVersion: 7 },
      expectedSequence: 1, previousStatus: 'current', resultingStatus: 'expired',
      reason: 'issuer_validity_ended', idempotencyKey: 'ledger:main:impact:1',
    }));
    assert.equal(impactResult.outcome, 'written');
    if (impactResult.outcome === 'written') {
      assert.deepEqual(impactResult.record.target, {
        kind: 'impact', impactId: 'impact-ledger-main', impactVersion: 7,
      });
      assert.equal(impactResult.record.resultingStatus, 'expired');
    }

    assert.deepEqual(await immutableSnapshot(database), before,
      'event/impact record JSON, event versions, publication decisions, and outbox rows remain unchanged');
    assert.equal((await countRows(database, 'freshness_transitions')), 2);
    assert.equal((await countRows(database, 'freshness_transition_evidence')), 0);
  });

  it('replays the same idempotency payload exactly and rejects changed-payload key reuse', async () => {
    const input = makeInput({
      eventId: 'event-ledger-replay', expectedSequence: 1, previousStatus: 'current',
      resultingStatus: 'needs_update', reason: 'review_deadline_missed', idempotencyKey: 'ledger:replay:1',
    });
    const first = await ledger.append(input);
    assert.equal(first.outcome, 'written');
    const replay = await ledger.append(input);
    assert.equal(replay.outcome, 'replayed');
    if (first.outcome === 'written' && replay.outcome === 'replayed') {
      assert.deepEqual(replay.record, first.record);
    }
    const changed = await ledger.append({ ...input, evaluatedAt: '2026-10-01T10:00:00.000001Z' });
    assert.deepEqual(changed, { outcome: 'conflict', code: 'idempotency_key_reused' });
    assert.equal((await countRows(database, 'freshness_transitions', "idempotency_key = 'ledger:replay:1'")), 1);
  });

  it('requires the expected sequence and effective prior state for the next append', async () => {
    const first = await ledger.append(makeInput({
      eventId: 'event-ledger-sequence', expectedSequence: 1, previousStatus: 'current',
      resultingStatus: 'needs_update', reason: 'review_deadline_missed', idempotencyKey: 'ledger:sequence:1',
    }));
    assert.equal(first.outcome, 'written');

    assert.deepEqual(await ledger.append(makeInput({
      eventId: 'event-ledger-sequence', expectedSequence: 1, previousStatus: 'current',
      resultingStatus: 'expired', reason: 'issuer_validity_ended', idempotencyKey: 'ledger:sequence:stale',
    })), { outcome: 'conflict', code: 'stale_sequence' });
    assert.deepEqual(await ledger.append(makeInput({
      eventId: 'event-ledger-sequence', expectedSequence: 2, previousStatus: 'current',
      resultingStatus: 'expired', reason: 'issuer_validity_ended', idempotencyKey: 'ledger:sequence:prior',
    })), { outcome: 'conflict', code: 'prior_status_mismatch' });
  });

  it('serializes competing appends that expect the same sequence', async () => {
    const left = makeInput({
      eventId: 'event-ledger-concurrent', expectedSequence: 1, previousStatus: 'current',
      resultingStatus: 'needs_update', reason: 'review_deadline_missed', idempotencyKey: 'ledger:concurrent:left',
    });
    const right = { ...left, idempotencyKey: 'ledger:concurrent:right' };
    const results = await Promise.all([ledger.append(left), ledger.append(right)]);
    assert.equal(results.filter(({ outcome }) => outcome === 'written').length, 1);
    assert.equal(results.filter((result) => result.outcome === 'conflict' && result.code === 'stale_sequence').length, 1);
    assert.equal(await countRows(database, 'freshness_transitions', "event_id = 'event-ledger-concurrent'"), 1);
  });

  it('requires exact current published event versions and exact impact references', async () => {
    assert.deepEqual(await ledger.append(makeInput({
      eventId: 'event-ledger-versioned', eventVersion: 1, expectedSequence: 1,
      resultingStatus: 'needs_update', reason: 'review_deadline_missed', idempotencyKey: 'ledger:old-version',
    })), { outcome: 'conflict', code: 'event_version_not_current' });
    assert.deepEqual(await ledger.append(makeInput({
      eventId: 'event-ledger-withdrawn', eventVersion: 1, expectedSequence: 1,
      resultingStatus: 'needs_update', reason: 'review_deadline_missed', idempotencyKey: 'ledger:after-withdrawal',
    })), { outcome: 'conflict', code: 'event_version_not_current' });
    assert.deepEqual(await ledger.append(makeInput({
      eventId: 'event-ledger-withdrawn', eventVersion: 2, expectedSequence: 1,
      resultingStatus: 'needs_update', reason: 'review_deadline_missed', idempotencyKey: 'ledger:withdrawn-target',
    })), { outcome: 'conflict', code: 'event_version_not_current' });
    assert.deepEqual(await ledger.append(makeInput({
      eventId: 'event-ledger-main', target: { kind: 'impact', impactId: 'impact-ledger-main', impactVersion: 8 },
      expectedSequence: 1, resultingStatus: 'needs_update', reason: 'review_deadline_missed',
      idempotencyKey: 'ledger:unreferenced-impact-version',
    })), { outcome: 'conflict', code: 'impact_version_not_referenced' });
    assert.deepEqual(await ledger.append(makeInput({
      datasetKind: 'historical', eventId: 'event-ledger-main', expectedSequence: 1,
      resultingStatus: 'needs_update', reason: 'review_deadline_missed', idempotencyKey: 'ledger:cross-dataset',
    })), { outcome: 'conflict', code: 'event_version_not_current' });
  });

  it('requires evidence references for stale-to-current recovery and returns their exact links on replay', async () => {
    const stale = await ledger.append(makeInput({
      eventId: 'event-ledger-recovery', expectedSequence: 1, previousStatus: 'current',
      resultingStatus: 'needs_update', reason: 'review_deadline_missed', idempotencyKey: 'ledger:recovery:stale',
    }));
    assert.equal(stale.outcome, 'written');

    const recovery = makeInput({
      eventId: 'event-ledger-recovery', expectedSequence: 2, previousStatus: 'needs_update',
      resultingStatus: 'current', reason: 'new_applicable_evidence_evaluated',
      idempotencyKey: 'ledger:recovery:current', evidenceReferenceIds: [EVIDENCE_REF],
      evaluatedAt: '2026-10-01T10:00:00.123456789Z',
    });
    const written = await ledger.append(recovery);
    assert.equal(written.outcome, 'written');
    if (written.outcome !== 'written') return;
    assert.deepEqual(written.record.evidenceReferenceIds, [EVIDENCE_REF]);
    const replayed = await ledger.append(recovery);
    assert.equal(replayed.outcome, 'replayed');
    if (replayed.outcome === 'replayed') assert.deepEqual(replayed.record, written.record);
    assert.equal((await countRows(database, 'freshness_transition_evidence')), 1);

    await assert.rejects(
      ledger.append(makeInput({
        eventId: 'event-ledger-recovery-missing-link', expectedSequence: 1, previousStatus: 'needs_update',
        resultingStatus: 'current', reason: 'new_applicable_evidence_evaluated',
        idempotencyKey: 'ledger:recovery:missing-link', evidenceReferenceIds: [],
      })),
      (error: unknown) => error instanceof FreshnessTransitionLedgerInputError
        && error.code === 'evidence_references_required' && error.message === 'evidence_references_required',
    );
  });

  it('enforces recovery evidence at deferred database commit for direct writer use', async () => {
    await ledger.append(makeInput({
      eventId: 'event-ledger-direct-recovery', expectedSequence: 1, previousStatus: 'current',
      resultingStatus: 'needs_update', reason: 'review_deadline_missed', idempotencyKey: 'ledger:direct:stale',
    }));
    const before = await countRows(database, 'freshness_transitions', "event_id = 'event-ledger-direct-recovery'");
    await database.executor.execute('SET ROLE waspada_l4_freshness_writer');
    try {
      await assert.rejects(
        database.executor.transaction(async (transaction) => {
          await transaction.query(
            `INSERT INTO waspada.freshness_transitions
               (dataset_kind, event_id, event_version, target_kind, impact_id, impact_version,
                transition_sequence, previous_status, resulting_status, reason, evaluated_at,
                trace_id, idempotency_key, request_fingerprint)
             VALUES ('synthetic', 'event-ledger-direct-recovery', 1, 'event_claim_set', NULL, NULL,
                     2, 'needs_update', 'current', 'new_applicable_evidence_evaluated', $1,
                     $2, 'ledger:direct:missing-link', $3)`,
            [NOW, TRACE, hash('direct-recovery')],
          );
        }),
        /freshness recovery requires evidence references/i,
      );
    } finally {
      await database.executor.execute('RESET ROLE');
    }
    assert.equal(await countRows(database, 'freshness_transitions', "event_id = 'event-ledger-direct-recovery'"), before);
  });

  it('lets the isolated writer append but denies public, L1, L2, and base-state mutations', async () => {
    const before = await immutableSnapshot(database);
    await database.executor.execute('SET ROLE waspada_l4_freshness_writer');
    try {
      const written = await ledger.append(makeInput({
        eventId: 'event-ledger-role', expectedSequence: 1, previousStatus: 'current',
        resultingStatus: 'needs_update', reason: 'review_deadline_missed', idempotencyKey: 'ledger:role:append',
      }));
      assert.equal(written.outcome, 'written', 'identity generation works with only intended insert columns');
      await assert.rejects(
        database.executor.query("UPDATE waspada.event_versions SET lifecycle = 'resolved' WHERE event_id = 'event-ledger-role'"),
        /permission denied/i,
      );
      await assert.rejects(
        database.executor.query("DELETE FROM waspada.impact_versions WHERE event_id = 'event-ledger-role'"),
        /permission denied/i,
      );
      await assert.rejects(
        database.executor.query("INSERT INTO waspada.publication_decisions DEFAULT VALUES"),
        /permission denied/i,
      );
      await assert.rejects(
        database.executor.query("INSERT INTO waspada.publication_outbox DEFAULT VALUES"),
        /permission denied/i,
      );
      await assert.rejects(
        database.executor.query("UPDATE waspada.freshness_transitions SET resulting_status = 'expired'"),
        /permission denied/i,
      );
    } finally {
      await database.executor.execute('RESET ROLE');
    }

    for (const role of [
      'waspada_public_reader', 'waspada_l1_pipeline', 'waspada_l2_grounding_reader',
      'waspada_l2_grounding_writer', 'waspada_l2_proposal_writer',
    ]) {
      await database.executor.execute(`SET ROLE ${role}`);
      try {
        await assert.rejects(
          database.executor.query('SELECT transition_id FROM waspada.freshness_transitions'),
          /permission denied/i,
          `${role} cannot directly read the private ledger`,
        );
        await assert.rejects(
          database.executor.query("INSERT INTO waspada.freshness_transition_evidence DEFAULT VALUES"),
          /permission denied/i,
          `${role} cannot directly mutate ledger links`,
        );
      } finally {
        await database.executor.execute('RESET ROLE');
      }
    }
    const after = await immutableSnapshot(database);
    assert.deepEqual(after.events, before.events);
    assert.deepEqual(after.impacts, before.impacts);
    assert.deepEqual(after.decisions, before.decisions);
    assert.deepEqual(after.outbox, before.outbox);
  });

  it('denies update and delete for transition and evidence-link history', async () => {
    const transition = await database.executor.query<{ transition_id: string }>(
      `SELECT transition_id::text AS transition_id FROM waspada.freshness_transitions
       WHERE idempotency_key = 'ledger:role:append'`,
    );
    assert.ok(transition.rows[0]);
    const linkTransition = await database.executor.query<{ transition_id: string }>(
      `SELECT transition_id::text AS transition_id FROM waspada.freshness_transition_evidence LIMIT 1`,
    );
    assert.ok(linkTransition.rows[0]);
    await assert.rejects(
      database.executor.query(
        `UPDATE waspada.freshness_transitions SET resulting_status = 'expired' WHERE transition_id = $1::bigint`,
        [transition.rows[0]!.transition_id],
      ),
      /immutable|append.only/i,
    );
    await assert.rejects(
      database.executor.query(
        `DELETE FROM waspada.freshness_transitions WHERE transition_id = $1::bigint`,
        [transition.rows[0]!.transition_id],
      ),
      /immutable|append.only/i,
    );
    await assert.rejects(
      database.executor.query(
        `UPDATE waspada.freshness_transition_evidence SET evidence_ref_id = $2::bigint
         WHERE transition_id = $1::bigint`,
        [linkTransition.rows[0]!.transition_id, EVIDENCE_REF],
      ),
      /immutable|append.only/i,
    );
    await assert.rejects(
      database.executor.query(
        'DELETE FROM waspada.freshness_transition_evidence WHERE transition_id = $1::bigint',
        [linkTransition.rows[0]!.transition_id],
      ),
      /immutable|append.only/i,
    );
  });

  it('rejects no-op appends before any ledger row is created', async () => {
    await assert.rejects(
      ledger.append(makeInput({
        eventId: 'event-ledger-noop', expectedSequence: 1, previousStatus: 'current',
        resultingStatus: 'current', reason: 'review_deadline_missed', idempotencyKey: 'ledger:noop',
      })),
      (error: unknown) => error instanceof FreshnessTransitionLedgerInputError
        && error.code === 'invalid_input' && error.message === 'invalid_input',
    );
    assert.equal(await countRows(database, 'freshness_transitions', "event_id = 'event-ledger-noop'"), 0);
  });
});

function makeInput(overrides: Partial<AppendFreshnessTransitionInput> = {}): AppendFreshnessTransitionInput {
  return {
    datasetKind: DATASET,
    eventId: 'event-ledger-main',
    eventVersion: 1,
    target: { kind: 'event_claim_set' },
    expectedSequence: 1,
    previousStatus: 'current',
    resultingStatus: 'needs_update',
    reason: 'review_deadline_missed',
    evaluatedAt: NOW,
    traceId: TRACE,
    idempotencyKey: 'ledger:default',
    evidenceReferenceIds: [],
    ...overrides,
  };
}

async function seedSyntheticFixture(database: TestDatabase): Promise<void> {
  await database.executor.query(
    `INSERT INTO waspada.traces (trace_id, dataset_kind, started_at, outcome, metadata)
     VALUES ($1, 'synthetic', $2, 'open', '{"fixture":"synthetic-only"}'::jsonb)`,
    [TRACE, NOW],
  );
  await database.executor.query(
    `INSERT INTO waspada.source_registry
       (source_id, trace_id, registry_version, display_name, source_kind, remit, access_method,
        approved_hosts, access_restrictions, reuse_basis, registry_status, approval_status,
        health_status, auto_acquisition_enabled, auto_publication_policy)
     VALUES ('source-freshness-ledger', $1, 1, 'Authored synthetic source', 'other', ARRAY['test'],
       'manual_fixture', ARRAY[]::text[], ARRAY['synthetic only'], ARRAY['authored fixture'],
       'active', 'approved', 'unknown', false, 'never')`,
    [TRACE],
  );
  const text = 'Authored synthetic evidence reference for ledger tests.';
  const textHash = hash(text);
  await database.executor.query(
    `INSERT INTO waspada.report_revisions
       (dataset_kind, report_revision_id, trace_id, source_id, canonical_url, content_hash,
        permitted_text, permitted_text_hash, normalization_version, retrieved_at, revision_status, record_json)
     VALUES ('synthetic', 'revision-freshness-ledger', $1, 'source-freshness-ledger',
       'https://synthetic.invalid/freshness-ledger', $2, $3, $4, 'normalization-fixture-v1',
       $5, 'eligible', '{"fixture":"synthetic-only"}'::jsonb)`,
    [TRACE, hash('synthetic source content'), text, textHash, NOW],
  );
  await database.executor.query(
    `INSERT INTO waspada.evidence_references
       (dataset_kind, trace_id, report_revision_id, permitted_text_hash, span_start, span_end,
        offset_unit, relation)
     VALUES ('synthetic', $1, 'revision-freshness-ledger', $2, 0, 8, 'unicode_code_points', 'updates')`,
    [TRACE, textHash],
  );
  await database.executor.query(
    `INSERT INTO waspada.extraction_results
       (dataset_kind, candidate_id, trace_id, report_revision_id, category, record_json)
     VALUES ('synthetic', 'candidate-freshness-ledger', $1, 'revision-freshness-ledger', NULL,
       '{"fixture":"synthetic-only"}'::jsonb)`,
    [TRACE],
  );
  await database.executor.query(
    `INSERT INTO waspada.grounding_contexts
       (dataset_kind, context_id, trace_id, candidate_id, retrieval_version, index_version, sufficient, record_json)
     VALUES ('synthetic', 'context-freshness-ledger', $1, 'candidate-freshness-ledger',
       'fixture-retrieval-v1', 'fixture-index-v1', false, '{"fixture":"synthetic-only"}'::jsonb)`,
    [TRACE],
  );
  await database.executor.query(
    `INSERT INTO waspada.event_proposals
       (dataset_kind, proposal_id, trace_id, candidate_id, context_id, proposed_at, record_json)
     VALUES ('synthetic', 'proposal-freshness-ledger', $1, 'candidate-freshness-ledger',
       'context-freshness-ledger', $2, '{"fixture":"synthetic-only"}'::jsonb)`,
    [TRACE, NOW],
  );

  await seedEvent(database, 'event-ledger-main', [{ version: 1, status: 'published' }], true);
  await seedEvent(database, 'event-ledger-replay', [{ version: 1, status: 'published' }]);
  await seedEvent(database, 'event-ledger-sequence', [{ version: 1, status: 'published' }]);
  await seedEvent(database, 'event-ledger-concurrent', [{ version: 1, status: 'published' }]);
  await seedEvent(database, 'event-ledger-versioned', [
    { version: 1, status: 'published' }, { version: 2, status: 'published' },
  ]);
  await seedEvent(database, 'event-ledger-withdrawn', [
    { version: 1, status: 'published' }, { version: 2, status: 'withdrawn' },
  ]);
  await seedEvent(database, 'event-ledger-recovery', [{ version: 1, status: 'published' }]);
  await seedEvent(database, 'event-ledger-recovery-missing-link', [{ version: 1, status: 'published' }]);
  await seedEvent(database, 'event-ledger-direct-recovery', [{ version: 1, status: 'published' }]);
  await seedEvent(database, 'event-ledger-role', [{ version: 1, status: 'published' }]);
  await seedEvent(database, 'event-ledger-noop', [{ version: 1, status: 'published' }]);

  await database.executor.transaction(async (transaction) => {
    for (const [impactVersion, linked] of [[7, true], [8, false]] as const) {
      await transaction.query(
        `INSERT INTO waspada.impact_versions
           (dataset_kind, impact_id, version, trace_id, event_id, event_version, impact_type,
            lifecycle, published_at, record_json)
         VALUES ('synthetic', 'impact-ledger-main', $1, $2, 'event-ledger-main', 1,
           'road_closure', 'ongoing', $3, $4::jsonb)`,
        [impactVersion, TRACE, NOW, JSON.stringify({ freshness: freshnessRecord('current'), fixture: 'synthetic-only' })],
      );
      if (linked) {
        await transaction.query(
          `INSERT INTO waspada.event_impact_refs
             (dataset_kind, event_id, event_version, impact_id, impact_version)
           VALUES ('synthetic', 'event-ledger-main', 1, 'impact-ledger-main', $1)`,
          [impactVersion],
        );
      }
    }
  });
}

interface FixtureVersion {
  readonly version: number;
  readonly status: 'published' | 'withdrawn';
}

async function seedEvent(
  database: TestDatabase,
  eventId: string,
  versions: readonly FixtureVersion[],
  withImpactReference = false,
): Promise<void> {
  await database.executor.transaction(async (transaction) => {
    for (const { version, status } of versions) {
      const decisionId = `${eventId}-decision-${version}`;
      const withdrawal = status === 'withdrawn';
      const record = {
        schema_version: '2.0', record_type: 'Event', dataset_kind: 'synthetic',
        event_id: eventId, version,
        claims: withdrawal ? [] : [{ claim_id: 'claim-fixture' }],
        impact_refs: withImpactReference && !withdrawal
          ? [{ impact_id: 'impact-ledger-main', version: 7 }]
          : [],
        freshness: freshnessRecord('current'),
      };
      await transaction.query(
        `INSERT INTO waspada.publication_decisions
           (dataset_kind, decision_id, trace_id, proposal_id, policy_version, event_id,
            event_version, decided_at, record_json)
         VALUES ('synthetic', $1, $2, 'proposal-freshness-ledger', 'fixture-policy-v1', $3, $4,
           $5, '{"fixture":"synthetic-only"}'::jsonb)`,
        [decisionId, TRACE, eventId, version, NOW],
      );
      await transaction.query(
        `INSERT INTO waspada.event_versions
           (dataset_kind, event_id, version, trace_id, supersedes_version, title, summary,
            category, lifecycle, publication_status, withdrawal_reason, publication_decision_id,
            published_at, withdrawn_at, record_json)
         VALUES ('synthetic', $1, $2, $3, $4, 'Authored synthetic event',
           'Fixture only; no event was observed or evaluated.', 'group_specific_critical_notices',
           'unknown', $5, $6, $7, $8, $9, $10::jsonb)`,
        [eventId, version, TRACE, version === 1 ? null : version - 1, status,
          withdrawal ? 'other' : null, decisionId, withdrawal ? null : NOW,
          withdrawal ? NOW : null, JSON.stringify(record)],
      );
    }
  });
}

async function immutableSnapshot(database: TestDatabase) {
  const [events, impacts, decisions, outbox] = await Promise.all([
    database.executor.query<{ dataset_kind: string; event_id: string; version: number; record_json: string }>(
      'SELECT dataset_kind, event_id, version, record_json::text AS record_json FROM waspada.event_versions ORDER BY dataset_kind, event_id, version',
    ),
    database.executor.query<{ dataset_kind: string; impact_id: string; version: number; record_json: string }>(
      'SELECT dataset_kind, impact_id, version, record_json::text AS record_json FROM waspada.impact_versions ORDER BY dataset_kind, impact_id, version',
    ),
    database.executor.query<{ decision_id: string; event_id: string; event_version: number; record_json: string }>(
      'SELECT decision_id, event_id, event_version, record_json::text AS record_json FROM waspada.publication_decisions ORDER BY decision_id',
    ),
    database.executor.query<{ outbox_id: string; event_id: string; event_version: number }>(
      'SELECT outbox_id, event_id, event_version FROM waspada.publication_outbox ORDER BY outbox_id',
    ),
  ]);
  return {
    events: events.rows,
    impacts: impacts.rows,
    decisions: decisions.rows,
    outbox: outbox.rows,
  };
}

async function countRows(database: TestDatabase, table: string, where = 'true'): Promise<number> {
  if (!['freshness_transitions', 'freshness_transition_evidence'].includes(table)) throw new Error('fixture table allowlist');
  const result = await database.executor.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM waspada.${table} WHERE ${where}`,
  );
  return Number(result.rows[0]?.count ?? 0);
}

function freshnessRecord(status: 'current' | 'needs_update' | 'expired') {
  return {
    status,
    evaluated_at: NOW,
    review_due_at: '2026-10-01T11:00:00Z',
    basis: 'manual_review',
  };
}

function hash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
