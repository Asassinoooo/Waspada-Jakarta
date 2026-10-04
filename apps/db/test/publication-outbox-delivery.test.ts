import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import {
  createSqlPublicationOutboxDeliveryRepository,
  PUBLICATION_OUTBOX_DELIVERY_PAGE_SIZE,
  type PublicationOutboxDeliveryAttempt,
} from '../src/publication-outbox-delivery.js';
import { applyMigrations, readMigrations } from '../src/migrations.js';
import { createTestDatabase, type TestDatabase } from './harness.js';

const START = Date.parse('2026-10-04T05:00:00.000Z');
const DELIVERY_ROLE = 'waspada_l4_publication_outbox_delivery';

describe('publication outbox delivery ledger', () => {
  let database: TestDatabase;

  before(async () => {
    database = await createTestDatabase();
    const migrations = await readMigrations(new URL('../migrations/', import.meta.url));
    await applyMigrations(database.executor, migrations);
    await seedLiveShapedOutbox(database, 30);
  });

  after(async () => database?.close());

  it('reserves a stable page of at most 20 and emits only the closed notice fields', async () => {
    await withDeliveryRole(database, async () => {
      const repository = createSqlPublicationOutboxDeliveryRepository(database.executor);
      const first = await repository.claimPage({ evaluatedAtMs: START, reservationKey: 'page-cap-1' });
      assert.equal(first.outcome, 'reserved');
      if (first.outcome !== 'reserved') return;
      assert.equal(first.attempts.length, PUBLICATION_OUTBOX_DELIVERY_PAGE_SIZE);
      assert.deepEqual(first.attempts.map(({ outboxId }) => outboxId),
        Array.from({ length: 20 }, (_, index) => outboxId(index)));
      for (const attempt of first.attempts) {
        assert.deepEqual(Object.keys(attempt.notice).sort(), ['eventId', 'eventKind', 'eventVersion', 'occurredAt']);
        assert.equal(attempt.notice.eventKind, 'event_version_published');
        assert.doesNotMatch(JSON.stringify(attempt.notice), /trace|payload|claim|evidence|geometry|content/iu);
      }

      const second = await repository.claimPage({ evaluatedAtMs: START, reservationKey: 'page-cap-2' });
      assert.equal(second.outcome, 'reserved');
      if (second.outcome === 'reserved') {
        assert.equal(second.attempts.length, 10);
        assert.deepEqual(second.attempts.map(({ outboxId }) => outboxId),
          Array.from({ length: 10 }, (_, index) => outboxId(index + 20)));
      }
    });

    assert.equal(await countRows(database, 'publication_outbox_delivery_attempts'), 30);
  });

  it('replays only unresolved latest attempts and rejects a reservation key reused with a different time', async () => {
    const separate = await createTestDatabase();
    try {
      const migrations = await readMigrations(new URL('../migrations/', import.meta.url));
      await applyMigrations(separate.executor, migrations);
      await seedLiveShapedOutbox(separate, 3);
      await withDeliveryRole(separate, async () => {
        const repository = createSqlPublicationOutboxDeliveryRepository(separate.executor);
        const claim = await repository.claimPage({ evaluatedAtMs: START, reservationKey: 'page-resume' });
        assert.equal(claim.outcome, 'reserved');
        if (claim.outcome !== 'reserved') return;

        const firstCompleted = await repository.recordResult({
          attemptId: claim.attempts[0]!.attemptId,
          outcome: 'delivered',
          completedAtMs: START + 20,
        });
        assert.equal(firstCompleted.outcome, 'recorded');
        const partialReplay = await repository.claimPage({ evaluatedAtMs: START, reservationKey: 'page-resume' });
        assert.equal(partialReplay.outcome, 'replayed');
        if (partialReplay.outcome !== 'replayed') return;
        assert.deepEqual(partialReplay.attempts.map(({ outboxId }) => outboxId), [outboxId(1), outboxId(2)]);

        const retryable = await repository.recordResult({
          attemptId: partialReplay.attempts[0]!.attemptId,
          outcome: 'retryable_failure',
          failureClassification: 'transient',
          completedAtMs: START + 50,
        });
        assert.equal(retryable.outcome, 'recorded');
        const finalPartialReplay = await repository.claimPage({ evaluatedAtMs: START, reservationKey: 'page-resume' });
        assert.equal(finalPartialReplay.outcome, 'replayed');
        if (finalPartialReplay.outcome === 'replayed') {
          assert.deepEqual(finalPartialReplay.attempts.map(({ outboxId }) => outboxId), [outboxId(2)]);
        }

        assert.deepEqual(
          await repository.claimPage({ evaluatedAtMs: START + 1, reservationKey: 'page-resume' }),
          { outcome: 'conflict', code: 'reservation_key_reused' },
        );
      });
    } finally {
      await separate.close();
    }
  });

  it('does not claim terminal, leased, or not-yet-due notices and honors the retry boundary', async () => {
    const separate = await createTestDatabase();
    try {
      const migrations = await readMigrations(new URL('../migrations/', import.meta.url));
      await applyMigrations(separate.executor, migrations);
      await seedLiveShapedOutbox(separate, 4);
      await withDeliveryRole(separate, async () => {
        const repository = createSqlPublicationOutboxDeliveryRepository(separate.executor);
        const initial = await repository.claimPage({ evaluatedAtMs: START, reservationKey: 'page-states-1' });
        assert.equal(initial.outcome, 'reserved');
        if (initial.outcome !== 'reserved') return;
        assert.equal(initial.attempts.length, 4);

        await repository.recordResult({
          attemptId: initial.attempts[0]!.attemptId,
          outcome: 'delivered',
          completedAtMs: START,
        });
        await repository.recordResult({
          attemptId: initial.attempts[1]!.attemptId,
          outcome: 'permanent_failure',
          failureClassification: 'permanent_rejection',
          completedAtMs: START,
        });
        await repository.recordResult({
          attemptId: initial.attempts[2]!.attemptId,
          outcome: 'retryable_failure',
          failureClassification: 'transient',
          completedAtMs: START,
        });

        const notDue = await repository.claimPage({ evaluatedAtMs: START + 999, reservationKey: 'page-states-2' });
        assert.deepEqual(notDue, { outcome: 'reserved', attempts: [] });

        const retryBoundary = await repository.claimPage({ evaluatedAtMs: START + 1_000, reservationKey: 'page-states-3' });
        assert.equal(retryBoundary.outcome, 'reserved');
        if (retryBoundary.outcome === 'reserved') {
          assert.deepEqual(retryBoundary.attempts.map(({ outboxId }) => outboxId), [outboxId(2)]);
          assert.equal(retryBoundary.attempts[0]?.attemptNumber, 2);
          await repository.recordResult({
            attemptId: retryBoundary.attempts[0]!.attemptId,
            outcome: 'permanent_failure',
            failureClassification: 'permanent_rejection',
            completedAtMs: START + 1_000,
          });
        }

        const leaseBoundary = await repository.claimPage({ evaluatedAtMs: START + 60_000, reservationKey: 'page-states-4' });
        assert.equal(leaseBoundary.outcome, 'reserved');
        if (leaseBoundary.outcome === 'reserved') {
          assert.deepEqual(leaseBoundary.attempts.map(({ outboxId }) => outboxId), [outboxId(3)]);
          assert.equal(leaseBoundary.attempts[0]?.attemptNumber, 2);
          for (const attempt of leaseBoundary.attempts) {
            await repository.recordResult({
              attemptId: attempt.attemptId,
              outcome: 'permanent_failure',
              failureClassification: 'permanent_rejection',
              completedAtMs: START + 60_000,
            });
          }
        }

        const terminalStillHidden = await repository.claimPage({
          evaluatedAtMs: START + 24 * 60 * 60 * 1_000,
          reservationKey: 'page-states-5',
        });
        assert.deepEqual(terminalStillHidden, { outcome: 'reserved', attempts: [] });
      });
    } finally {
      await separate.close();
    }
  });

  it('recovers expired leases and a late older failure cannot make a newer terminal notice due again', async () => {
    const separate = await createTestDatabase();
    try {
      const migrations = await readMigrations(new URL('../migrations/', import.meta.url));
      await applyMigrations(separate.executor, migrations);
      await seedLiveShapedOutbox(separate, 1);
      await withDeliveryRole(separate, async () => {
        const repository = createSqlPublicationOutboxDeliveryRepository(separate.executor);
        const first = await repository.claimPage({ evaluatedAtMs: START, reservationKey: 'lease-attempt-1' });
        assert.equal(first.outcome, 'reserved');
        if (first.outcome !== 'reserved') return;

        const recoveredAt = START + 60_001;
        const recovered = await repository.claimPage({ evaluatedAtMs: recoveredAt, reservationKey: 'lease-attempt-2' });
        assert.equal(recovered.outcome, 'reserved');
        if (recovered.outcome !== 'reserved') return;
        assert.equal(recovered.attempts.length, 1);
        assert.equal(recovered.attempts[0]?.attemptNumber, 2);
        assert.equal(recovered.attempts[0]?.outboxId, first.attempts[0]?.outboxId);

        const delivered = await repository.recordResult({
          attemptId: recovered.attempts[0]!.attemptId,
          outcome: 'delivered',
          completedAtMs: recoveredAt + 100,
        });
        assert.equal(delivered.outcome, 'recorded');

        const lateFailure = await repository.recordResult({
          attemptId: first.attempts[0]!.attemptId,
          outcome: 'retryable_failure',
          failureClassification: 'unknown',
          completedAtMs: recoveredAt + 101,
        });
        assert.equal(lateFailure.outcome, 'recorded');

        const afterLateResult = await repository.claimPage({
          evaluatedAtMs: recoveredAt + 60 * 60 * 1_000,
          reservationKey: 'lease-attempt-3',
        });
        assert.deepEqual(afterLateResult, { outcome: 'reserved', attempts: [] });
      });
    } finally {
      await separate.close();
    }
  });

  it('keeps a late older delivery terminal after a newer retryable result', async () => {
    const separate = await createTestDatabase();
    try {
      const migrations = await readMigrations(new URL('../migrations/', import.meta.url));
      await applyMigrations(separate.executor, migrations);
      await seedLiveShapedOutbox(separate, 1);
      await withDeliveryRole(separate, async () => {
        const repository = createSqlPublicationOutboxDeliveryRepository(separate.executor);
        const first = await repository.claimPage({ evaluatedAtMs: START, reservationKey: 'late-terminal-attempt-1' });
        assert.equal(first.outcome, 'reserved');
        if (first.outcome !== 'reserved') return;

        const recoveredAt = START + 60_001;
        const recovered = await repository.claimPage({ evaluatedAtMs: recoveredAt, reservationKey: 'late-terminal-attempt-2' });
        assert.equal(recovered.outcome, 'reserved');
        if (recovered.outcome !== 'reserved') return;

        const newerRetry = await repository.recordResult({
          attemptId: recovered.attempts[0]!.attemptId,
          outcome: 'retryable_failure',
          failureClassification: 'transient',
          completedAtMs: recoveredAt + 100,
        });
        assert.equal(newerRetry.outcome, 'recorded');

        const lateDelivered = await repository.recordResult({
          attemptId: first.attempts[0]!.attemptId,
          outcome: 'delivered',
          completedAtMs: recoveredAt + 101,
        });
        assert.equal(lateDelivered.outcome, 'recorded');

        const retryAfterMs = recoveredAt + 100 + 2_000;
        const afterLateDelivery = await repository.claimPage({
          evaluatedAtMs: retryAfterMs,
          reservationKey: 'late-terminal-attempt-3',
        });
        assert.deepEqual(afterLateDelivery, { outcome: 'reserved', attempts: [] });
      });
    } finally {
      await separate.close();
    }
  });

  it('applies deterministic exponential backoff and caps eligibility at one hour', async () => {
    const separate = await createTestDatabase();
    try {
      const migrations = await readMigrations(new URL('../migrations/', import.meta.url));
      await applyMigrations(separate.executor, migrations);
      await seedLiveShapedOutbox(separate, 1);
      await withDeliveryRole(separate, async () => {
        const repository = createSqlPublicationOutboxDeliveryRepository(separate.executor);
        let evaluatedAtMs = START;
        for (let number = 1; number <= 13; number += 1) {
          const claim = await repository.claimPage({
            evaluatedAtMs,
            reservationKey: `backoff-${number}`,
          });
          assert.equal(claim.outcome, 'reserved');
          if (claim.outcome !== 'reserved') return;
          assert.equal(claim.attempts[0]?.attemptNumber, number);
          const written = await repository.recordResult({
            attemptId: claim.attempts[0]!.attemptId,
            outcome: 'retryable_failure',
            failureClassification: 'transient',
            completedAtMs: evaluatedAtMs,
          });
          assert.equal(written.outcome, 'recorded');
          if (written.outcome !== 'recorded') return;
          const expectedDelay = Math.min(3_600_000, 1_000 * (2 ** Math.min(number - 1, 12)));
          assert.equal(Date.parse(written.result.retryAfter!) - evaluatedAtMs, expectedDelay);
          evaluatedAtMs = Date.parse(written.result.retryAfter!);
        }
        assert.equal(evaluatedAtMs - START, 1_000 + 2_000 + 4_000 + 8_000 + 16_000 + 32_000
          + 64_000 + 128_000 + 256_000 + 512_000 + 1_024_000 + 2_048_000 + 3_600_000);
      });
    } finally {
      await separate.close();
    }
  });

  it('replays an exact result, rejects changed outcomes, and isolates privileges and immutable rows', async () => {
    const separate = await createTestDatabase();
    try {
      const migrations = await readMigrations(new URL('../migrations/', import.meta.url));
      await applyMigrations(separate.executor, migrations);
      await seedLiveShapedOutbox(separate, 1);
      let attempt: PublicationOutboxDeliveryAttempt | undefined;
      await withDeliveryRole(separate, async () => {
        const repository = createSqlPublicationOutboxDeliveryRepository(separate.executor);
        const claim = await repository.claimPage({ evaluatedAtMs: START, reservationKey: 'page-result-replay' });
        assert.equal(claim.outcome, 'reserved');
        if (claim.outcome !== 'reserved') return;
        attempt = claim.attempts[0];

        const input = { attemptId: attempt!.attemptId, outcome: 'delivered' as const, completedAtMs: START + 7 };
        const first = await repository.recordResult(input);
        const replay = await repository.recordResult(input);
        assert.equal(first.outcome, 'recorded');
        assert.equal(replay.outcome, 'replayed');
        assert.deepEqual(replay.outcome === 'replayed' ? replay.result : null,
          first.outcome === 'recorded' ? first.result : null);
        assert.deepEqual(await repository.recordResult({
          attemptId: attempt!.attemptId,
          outcome: 'permanent_failure',
          failureClassification: 'permanent_rejection',
          completedAtMs: START + 8,
        }), { outcome: 'conflict', code: 'result_conflict' });

        const activeRole = await separate.executor.query<{ current_user: string }>('SELECT current_user');
        assert.equal(activeRole.rows[0]?.current_user, DELIVERY_ROLE);
        const privilege = await separate.executor.query<{
          outboxRead: boolean;
          traceRead: boolean;
          outboxInsert: boolean;
          resultInsert: boolean;
          resultUpdate: boolean;
          eventRead: boolean;
          sourceRead: boolean;
        }>(
          `SELECT has_column_privilege(current_user, 'waspada.publication_outbox', 'outbox_id', 'SELECT') AS "outboxRead",
                  has_column_privilege(current_user, 'waspada.publication_outbox', 'trace_id', 'SELECT') AS "traceRead",
                  has_table_privilege(current_user, 'waspada.publication_outbox', 'INSERT') AS "outboxInsert",
                  has_column_privilege(current_user, 'waspada.publication_outbox_delivery_results', 'attempt_id', 'INSERT') AS "resultInsert",
                  has_table_privilege(current_user, 'waspada.publication_outbox_delivery_results', 'UPDATE') AS "resultUpdate",
                  has_table_privilege(current_user, 'waspada.event_versions', 'SELECT') AS "eventRead",
                  has_table_privilege(current_user, 'waspada.source_registry', 'SELECT') AS "sourceRead"`,
        );
        assert.deepEqual(privilege.rows[0], {
          outboxRead: true, traceRead: false, outboxInsert: false, resultInsert: true,
          resultUpdate: false, eventRead: false, sourceRead: false,
        });

        await assert.rejects(
          separate.executor.query('SELECT title FROM waspada.event_versions'),
          /permission denied/i,
        );
        await assert.rejects(
          separate.executor.query('SELECT display_name FROM waspada.source_registry'),
          /permission denied/i,
        );
        await assert.rejects(
          separate.executor.query('UPDATE waspada.publication_outbox SET occurred_at = occurred_at'),
          /permission denied/i,
        );
        await assert.rejects(
          separate.executor.query('DELETE FROM waspada.publication_outbox_delivery_attempts'),
          /permission denied/i,
        );
        await assert.rejects(
          separate.executor.query('UPDATE waspada.publication_outbox_delivery_results SET outcome = outcome'),
          /permission denied/i,
        );
      });

      const role = await separate.executor.query<{
        rolcanlogin: boolean;
        rolsuper: boolean;
        rolcreatedb: boolean;
        rolcreaterole: boolean;
        rolinherit: boolean;
        rolreplication: boolean;
        rolbypassrls: boolean;
      }>(
        `SELECT rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolinherit,
                rolreplication, rolbypassrls
         FROM pg_roles WHERE rolname = $1`,
        [DELIVERY_ROLE],
      );
      assert.deepEqual(role.rows[0], {
        rolcanlogin: false, rolsuper: false, rolcreatedb: false, rolcreaterole: false,
        rolinherit: false, rolreplication: false, rolbypassrls: false,
      });
      const membership = await separate.executor.query<{ count: number }>(
        `SELECT count(*)::integer AS count FROM pg_auth_members
         WHERE member = (SELECT oid FROM pg_roles WHERE rolname = $1)
            OR roleid = (SELECT oid FROM pg_roles WHERE rolname = $1)`,
        [DELIVERY_ROLE],
      );
      assert.equal(membership.rows[0]?.count, 0);

      await assert.rejects(
        separate.executor.query('UPDATE waspada.publication_outbox_delivery_attempts SET attempt_number = attempt_number'),
        /immutable|append.only|update/i,
      );
      await assert.rejects(
        separate.executor.query('DELETE FROM waspada.publication_outbox_delivery_results'),
        /immutable|append.only|delete/i,
      );
      assert.equal(await countRows(separate, 'publication_outbox_delivery_results'), 1);
      assert.ok(attempt);
    } finally {
      await separate.close();
    }
  });
});

async function seedLiveShapedOutbox(database: TestDatabase, count: number): Promise<void> {
  const traceId = 'trace-publication-outbox-delivery-fixture';
  const at = new Date(START).toISOString();
  const permittedText = 'Synthetic-only fixture sentence for a live-shaped publication notice test.';
  const textHash = sha256(permittedText);
  await database.executor.query(
    `INSERT INTO waspada.traces (trace_id, dataset_kind, started_at, outcome, metadata)
     VALUES ($1, 'live', $2, 'open', '{"fixture":"authored-synthetic-live-shaped-only"}'::jsonb)`,
    [traceId, at],
  );
  await database.executor.query(
    `INSERT INTO waspada.source_registry
       (source_id, trace_id, registry_version, display_name, source_kind, remit, access_method,
        approved_hosts, access_restrictions, reuse_basis, registry_status, approval_status,
        health_status, auto_acquisition_enabled, auto_publication_policy)
     VALUES ('source-outbox-delivery-fixture', $1, 1, 'Authored fixture source', 'other', ARRAY['test'],
       'manual_fixture', ARRAY[]::text[], ARRAY['fixture only'], ARRAY['synthetic fixture only'],
       'active', 'approved', 'unknown', false, 'never')`,
    [traceId],
  );
  await database.executor.query(
    `INSERT INTO waspada.report_revisions
       (dataset_kind, report_revision_id, trace_id, source_id, canonical_url, content_hash,
        permitted_text, permitted_text_hash, normalization_version, retrieved_at, revision_status, record_json)
     VALUES ('live', 'revision-outbox-delivery-fixture', $1, 'source-outbox-delivery-fixture',
       'https://synthetic.invalid/outbox-delivery-fixture', $2, $3, $4, 'fixture-normalization-v1',
       $5, 'eligible', '{"fixture":"authored-synthetic-live-shaped-only"}'::jsonb)`,
    [traceId, sha256('synthetic fixture bytes'), permittedText, textHash, at],
  );
  await database.executor.query(
    `INSERT INTO waspada.extraction_results
       (dataset_kind, candidate_id, trace_id, report_revision_id, category, record_json)
     VALUES ('live', 'candidate-outbox-delivery-fixture', $1,
       'revision-outbox-delivery-fixture', NULL,
       '{"fixture":"authored-synthetic-live-shaped-only"}'::jsonb)`,
    [traceId],
  );
  await database.executor.query(
    `INSERT INTO waspada.grounding_contexts
       (dataset_kind, context_id, trace_id, candidate_id, retrieval_version, index_version,
        sufficient, record_json)
     VALUES ('live', 'context-outbox-delivery-fixture', $1, 'candidate-outbox-delivery-fixture',
       'fixture-retrieval-v1', 'fixture-index-v1', false,
       '{"fixture":"authored-synthetic-live-shaped-only"}'::jsonb)`,
    [traceId],
  );
  await database.executor.query(
    `INSERT INTO waspada.event_proposals
       (dataset_kind, proposal_id, trace_id, candidate_id, context_id, proposed_at, record_json)
     VALUES ('live', 'proposal-outbox-delivery-fixture', $1, 'candidate-outbox-delivery-fixture',
       'context-outbox-delivery-fixture', $2,
       '{"fixture":"authored-synthetic-live-shaped-only"}'::jsonb)`,
    [traceId, at],
  );

  for (let index = 0; index < count; index += 1) {
    const id = outboxId(index);
    const eventId = `event-outbox-delivery-${String(index).padStart(3, '0')}`;
    const decisionId = `${eventId}-decision`;
    const occurredAt = new Date(START + index * 1_000).toISOString();
    const eventRecord = {
      schema_version: '2.0',
      record_type: 'Event',
      dataset_kind: 'live',
      event_id: eventId,
      version: 1,
      claims: [{ claim_id: 'claim-fixture' }],
      impact_refs: [],
      fixture: 'authored-synthetic-live-shaped-only',
    };
    await database.executor.transaction(async (transaction) => {
      await transaction.query(
        `INSERT INTO waspada.publication_decisions
           (dataset_kind, decision_id, trace_id, proposal_id, policy_version,
            event_id, event_version, decided_at, record_json)
         VALUES ('live', $1, $2, 'proposal-outbox-delivery-fixture', 'fixture-policy-v1',
           $3, 1, $4, '{"fixture":"authored-synthetic-live-shaped-only"}'::jsonb)`,
        [decisionId, traceId, eventId, occurredAt],
      );
      await transaction.query(
        `INSERT INTO waspada.event_versions
           (dataset_kind, event_id, version, trace_id, supersedes_version, title, summary,
            category, lifecycle, publication_status, withdrawal_reason, publication_decision_id,
            published_at, withdrawn_at, record_json)
         VALUES ('live', $1, 1, $2, NULL, 'Authored synthetic fixture event',
           'Fixture only; no incident was observed or evaluated.', 'group_specific_critical_notices',
           'unknown', 'published', NULL, $3, $4, NULL, $5::jsonb)`,
        [eventId, traceId, decisionId, occurredAt, JSON.stringify(eventRecord)],
      );
      await transaction.query(
        `INSERT INTO waspada.publication_outbox
           (outbox_id, dataset_kind, event_id, event_version, event_kind, trace_id, occurred_at)
         VALUES ($1, 'live', $2, 1, 'event_version_published', $3, $4)`,
        [id, eventId, traceId, occurredAt],
      );
    });
  }
}

async function withDeliveryRole<Result>(database: TestDatabase, operation: () => Promise<Result>): Promise<Result> {
  await database.executor.execute(`SET ROLE ${DELIVERY_ROLE}`);
  try {
    const role = await database.executor.query<{ current_user: string }>('SELECT current_user');
    assert.equal(role.rows[0]?.current_user, DELIVERY_ROLE);
    return await operation();
  } finally {
    await database.executor.execute('RESET ROLE');
  }
}

async function countRows(database: TestDatabase, table: string): Promise<number> {
  const allowed = new Set([
    'publication_outbox_delivery_attempts', 'publication_outbox_delivery_results',
  ]);
  if (!allowed.has(table)) throw new Error('fixture table allowlist');
  const result = await database.executor.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM waspada.${table}`,
  );
  return Number(result.rows[0]?.count ?? 0);
}

function outboxId(index: number): string {
  return `outbox-delivery-${String(index).padStart(3, '0')}`;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
