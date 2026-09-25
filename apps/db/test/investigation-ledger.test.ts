import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { applyMigrations, readMigrations } from '../src/migrations.js';
import {
  createSqlInvestigationLedgerRepository,
  InvestigationLedgerError,
  type CreateInvestigationInput,
} from '../src/investigation-ledger.js';
import type { DatasetKind } from '../src/ports.js';
import { createTestDatabase, type TestDatabase } from './harness.js';

const TEST_TIME = '2026-09-25T10:00:00Z';

describe('L3 durable investigation ledger', () => {
  let testDatabase: TestDatabase;

  before(async () => {
    testDatabase = await createTestDatabase();
    const migrations = await readMigrations(new URL('../migrations/', import.meta.url));
    const result = await applyMigrations(testDatabase.executor, migrations);
    assert.deepEqual(result.applied.at(-1), '009_evidence_reference_updates_relation');
  });

  after(async () => {
    await testDatabase.close();
  });

  it('creates only from insufficient persisted grounding, then reserves and reconciles failed tool use once', async () => {
    const fixture = await seedFixture(testDatabase, 'vertical', { sufficient: false });
    const repository = createSqlInvestigationLedgerRepository(testDatabase.executor);
    const input = makeCreateInput(fixture);
    const initial = await repository.create(input);

    assert.equal(initial.record_type, 'InvestigationCheckpoint');
    assert.equal(initial.schema_version, '2.0');
    assert.equal(initial.checkpoint_version, 1);
    assert.equal(initial.case_status, 'open');
    assert.equal(initial.context_id, fixture.contextId);
    assert.deepEqual(initial.budget.consumed, zeroCounters());
    assert.deepEqual(initial.budget.reserved, zeroCounters());

    const reserveInput = {
      datasetKind: fixture.datasetKind,
      investigationId: input.investigationId,
      reservationId: 'reservation-vertical',
      expectedCheckpointVersion: 1,
      actionKind: 'tool' as const,
      actionName: 'lookup.synthetic',
      reservedActiveSeconds: 10,
      reservedModelTokens: 0,
      reservedAt: '2026-09-25T10:01:00Z',
    };
    const reserved = await repository.reserveAction(reserveInput);
    assert.equal(reserved.replayed, false);
    assert.equal(reserved.mayInvoke, false);
    assert.equal(reserved.checkpoint.checkpoint_version, 2);
    assert.deepEqual(reserved.checkpoint.budget.reserved, {
      tool_attempts: 1, reasoning_turns: 0, active_seconds: 10, model_tokens: 0,
    });

    const reserveReplay = await repository.reserveAction(reserveInput);
    assert.equal(reserveReplay.replayed, true);
    assert.equal(reserveReplay.mayInvoke, false, 'a reservation replay never authorizes another invocation');
    assert.equal(reserveReplay.checkpoint.checkpoint_version, 2);
    await assertLedgerError('reservation_conflict', repository.reserveAction({
      ...reserveInput,
      reservedActiveSeconds: reserveInput.reservedActiveSeconds - 1,
    }));

    const start = await repository.startAction({
      datasetKind: fixture.datasetKind,
      investigationId: input.investigationId,
      reservationId: reserveInput.reservationId,
      startedAt: '2026-09-25T10:01:01Z',
    });
    assert.equal(start.mayInvoke, true);
    const startReplay = await repository.startAction({
      datasetKind: fixture.datasetKind,
      investigationId: input.investigationId,
      reservationId: reserveInput.reservationId,
      startedAt: '2026-09-25T10:01:01Z',
    });
    assert.equal(startReplay.mayInvoke, false, 'the same reservation cannot start a second invocation');

    const acknowledgement = {
      datasetKind: fixture.datasetKind,
      investigationId: input.investigationId,
      reservationId: reserveInput.reservationId,
      expectedCheckpointVersion: 2,
      outcome: 'failed' as const,
      actualActiveSeconds: 4,
      actualModelTokens: 0,
      finishedAt: '2026-09-25T10:01:05Z',
    };
    const reconciled = await repository.reconcileAction(acknowledgement);
    assert.equal(reconciled.replayed, false);
    assert.equal(reconciled.checkpoint.checkpoint_version, 3);
    assert.deepEqual(reconciled.checkpoint.budget.consumed, {
      tool_attempts: 1, reasoning_turns: 0, active_seconds: 4, model_tokens: 0,
    });
    assert.deepEqual(reconciled.checkpoint.budget.reserved, zeroCounters());
    assert.deepEqual(reconciled.checkpoint.attempts, [{
      attempt_id: reserveInput.reservationId,
      tool: reserveInput.actionName,
      outcome: 'failed',
      started_at: '2026-09-25T10:01:01.000Z',
      finished_at: acknowledgement.finishedAt,
    }]);

    const duplicateAck = await repository.reconcileAction(acknowledgement);
    assert.equal(duplicateAck.replayed, true);
    assert.equal(duplicateAck.checkpoint.checkpoint_version, 3);
    await assertLedgerError('reservation_conflict', repository.reconcileAction({
      ...acknowledgement,
      modelRun: {
        capability: 'reasoning',
        model_version: 'synthetic-model',
        prompt_version: 'synthetic-prompt',
        input_tokens: 0,
        output_tokens: 0,
      },
    }));
    assert.equal((await repository.getLatest(fixture.datasetKind, input.investigationId))?.checkpoint_version, 3);

    const deniedReservation = await repository.reserveAction({
      datasetKind: fixture.datasetKind,
      investigationId: input.investigationId,
      reservationId: 'reservation-denied',
      expectedCheckpointVersion: 3,
      actionKind: 'tool',
      actionName: 'lookup.denied',
      reservedActiveSeconds: 2,
      reservedModelTokens: 0,
      reservedAt: '2026-09-25T10:02:00Z',
    });
    await repository.startAction({
      datasetKind: fixture.datasetKind,
      investigationId: input.investigationId,
      reservationId: 'reservation-denied',
      startedAt: '2026-09-25T10:02:01Z',
    });
    const denied = await repository.reconcileAction({
      datasetKind: fixture.datasetKind,
      investigationId: input.investigationId,
      reservationId: 'reservation-denied',
      expectedCheckpointVersion: deniedReservation.checkpoint.checkpoint_version,
      outcome: 'denied',
      actualActiveSeconds: 1,
      actualModelTokens: 0,
      finishedAt: '2026-09-25T10:02:02Z',
    });
    assert.equal(denied.checkpoint.budget.consumed.tool_attempts, 2);
    assert.equal(denied.checkpoint.budget.consumed.active_seconds, 5);
    assert.equal(denied.checkpoint.attempts.at(-1)?.outcome, 'denied');
    const cancelledReservation = await repository.reserveAction({
      datasetKind: fixture.datasetKind,
      investigationId: input.investigationId,
      reservationId: 'reservation-cancelled',
      expectedCheckpointVersion: denied.checkpoint.checkpoint_version,
      actionKind: 'tool',
      actionName: 'lookup.cancelled',
      reservedActiveSeconds: 1,
      reservedModelTokens: 0,
      reservedAt: '2026-09-25T10:03:00Z',
    });
    await repository.startAction({
      datasetKind: fixture.datasetKind,
      investigationId: input.investigationId,
      reservationId: 'reservation-cancelled',
      startedAt: '2026-09-25T10:03:01Z',
    });
    const cancelled = await repository.reconcileAction({
      datasetKind: fixture.datasetKind,
      investigationId: input.investigationId,
      reservationId: 'reservation-cancelled',
      expectedCheckpointVersion: cancelledReservation.checkpoint.checkpoint_version,
      outcome: 'cancelled',
      actualActiveSeconds: 1,
      actualModelTokens: 0,
      finishedAt: '2026-09-25T10:03:02Z',
    });
    assert.equal(cancelled.checkpoint.budget.consumed.tool_attempts, 3);
    assert.equal(cancelled.checkpoint.attempts.at(-1)?.outcome, 'cancelled');
  });

  it('replays identical requests and rejects sufficient, missing, mismatched, and changed input', async () => {
    const fixture = await seedFixture(testDatabase, 'create-guards', { sufficient: false });
    const repository = createSqlInvestigationLedgerRepository(testDatabase.executor);
    const input = makeCreateInput(fixture);
    const first = await repository.create(input);
    assert.deepEqual(await repository.create(input), first);
    await assertLedgerError('investigation_conflict', repository.create({ ...input, questions: ['Changed question'] }));
    await assertLedgerError('investigation_conflict', repository.create({
      ...input, limits: { ...input.limits, activeSeconds: 59 },
    }));

    const sufficient = await seedFixture(testDatabase, 'sufficient-context', { sufficient: true });
    await assertLedgerError('sufficient_context', repository.create(makeCreateInput(sufficient)));
    await assertLedgerError('context_not_found', repository.create(makeCreateInput(fixture, {
      investigationId: 'investigation-missing-context', contextId: 'context-does-not-exist',
    })));
    await assertLedgerError('context_mismatch', repository.create(makeCreateInput(fixture, {
      investigationId: 'investigation-wrong-trace', traceId: 'trace-does-not-match',
    })));
    await assertLedgerError('context_mismatch', repository.create(makeCreateInput(fixture, {
      investigationId: 'investigation-wrong-candidate', candidateId: 'candidate-does-not-match',
    })));
    await assertLedgerError('context_not_found', repository.create(makeCreateInput(fixture, {
      investigationId: 'investigation-cross-dataset', datasetKind: 'historical',
    })));
    await assertLedgerError('invalid_input', repository.create(makeCreateInput(fixture, {
      investigationId: 'investigation-empty-questions', questions: [],
    })));
    await assertLedgerError('invalid_input', repository.create(makeCreateInput(fixture, {
      investigationId: 'investigation-invalid-event-pair', eventId: 'event-without-version', eventVersion: null,
    })));
    await assertLedgerError('invalid_input', repository.create(makeCreateInput(fixture, {
      investigationId: 'investigation-over-hard-limit',
      limits: { toolAttempts: 5, reasoningTurns: 4, activeSeconds: 60, modelTokens: 12_001 },
    })));
    const overLimits = [
      { toolAttempts: 6, reasoningTurns: 4, activeSeconds: 60, modelTokens: 12_000 },
      { toolAttempts: 5, reasoningTurns: 5, activeSeconds: 60, modelTokens: 12_000 },
      { toolAttempts: 5, reasoningTurns: 4, activeSeconds: 61, modelTokens: 12_000 },
    ] as const;
    for (const [index, limits] of overLimits.entries()) {
      await assertLedgerError('invalid_input', repository.create(makeCreateInput(fixture, {
        investigationId: `investigation-over-limit-${index}`,
        limits,
      })));
    }
  });

  it('resumes with refreshed same-candidate grounding while preserving case identity and reservations', async () => {
    const fixture = await seedFixture(testDatabase, 'refresh-context', { sufficient: false });
    const refreshed = await seedAdditionalContext(testDatabase, 'refresh-context-next', {
      datasetKind: fixture.datasetKind, candidateId: fixture.candidateId, sufficient: true,
    });
    const other = await seedFixture(testDatabase, 'refresh-other-candidate', { sufficient: false });
    const repository = createSqlInvestigationLedgerRepository(testDatabase.executor);
    const input = makeCreateInput(fixture);
    const initial = await repository.create(input);
    const reservation = await repository.reserveAction({
      datasetKind: fixture.datasetKind,
      investigationId: input.investigationId,
      reservationId: 'reservation-refresh-preserved',
      expectedCheckpointVersion: initial.checkpoint_version,
      actionKind: 'tool',
      actionName: 'lookup.refresh',
      reservedActiveSeconds: 8,
      reservedModelTokens: 0,
      reservedAt: '2026-09-25T10:02:00Z',
    });
    const paused = await repository.pause({
      datasetKind: fixture.datasetKind,
      investigationId: input.investigationId,
      expectedCheckpointVersion: reservation.checkpoint.checkpoint_version,
      pausedAt: '2026-09-25T10:02:01Z',
    });
    const resumed = await repository.resume({
      datasetKind: fixture.datasetKind,
      investigationId: input.investigationId,
      expectedCheckpointVersion: paused.checkpoint.checkpoint_version,
      resumedAt: '2026-09-25T10:03:00Z',
      contextId: refreshed.contextId,
    });
    assert.equal(resumed.checkpoint.investigation_id, input.investigationId);
    assert.equal(resumed.checkpoint.candidate_id, fixture.candidateId);
    assert.equal(resumed.checkpoint.context_id, refreshed.contextId);
    assert.equal(resumed.checkpoint.trace_id, refreshed.traceId);
    assert.equal(resumed.checkpoint.case_status, 'open');
    assert.equal(resumed.checkpoint.event_id, null);
    assert.equal(resumed.checkpoint.event_version, null);
    assert.deepEqual(resumed.checkpoint.budget, paused.checkpoint.budget);
    await assertLedgerError('invalid_input', repository.startAction({
      datasetKind: fixture.datasetKind,
      investigationId: input.investigationId,
      reservationId: 'reservation-refresh-preserved',
      startedAt: '2026-09-25T10:02:30Z',
    }));

    const request = await testDatabase.executor.query<{
      context_id: string;
      budget_policy_version: string;
      limit_tool_attempts: number;
      limit_active_seconds: number;
      reserved_tool_attempts: number;
      reserved_active_seconds: number;
    }>(
      `SELECT context_id, budget_policy_version, limit_tool_attempts, limit_active_seconds,
              reserved_tool_attempts, reserved_active_seconds
       FROM waspada.investigation_requests WHERE dataset_kind = $1 AND investigation_id = $2`,
      [fixture.datasetKind, input.investigationId],
    );
    assert.deepEqual(request.rows[0], {
      context_id: fixture.contextId,
      budget_policy_version: input.policyVersion,
      limit_tool_attempts: input.limits.toolAttempts,
      limit_active_seconds: input.limits.activeSeconds,
      reserved_tool_attempts: 1,
      reserved_active_seconds: 8,
    });

    await assertLedgerError('stale_checkpoint', repository.reserveAction({
      datasetKind: fixture.datasetKind,
      investigationId: input.investigationId,
      reservationId: 'reservation-stale-version',
      expectedCheckpointVersion: 1,
      actionKind: 'tool',
      actionName: 'lookup.stale',
      reservedActiveSeconds: 1,
      reservedModelTokens: 0,
      reservedAt: '2026-09-25T10:03:01Z',
    }));

    const pausedAgain = await repository.pause({
      datasetKind: fixture.datasetKind,
      investigationId: input.investigationId,
      expectedCheckpointVersion: resumed.checkpoint.checkpoint_version,
      pausedAt: '2026-09-25T10:04:00Z',
    });
    await assertLedgerError('context_mismatch', repository.resume({
      datasetKind: fixture.datasetKind,
      investigationId: input.investigationId,
      expectedCheckpointVersion: pausedAgain.checkpoint.checkpoint_version,
      resumedAt: '2026-09-25T10:04:01Z',
      contextId: other.contextId,
    }));
    const resumedAgain = await repository.resume({
      datasetKind: fixture.datasetKind,
      investigationId: input.investigationId,
      expectedCheckpointVersion: pausedAgain.checkpoint.checkpoint_version,
      resumedAt: '2026-09-25T10:04:02Z',
    });
    await assertLedgerError('reservation_in_flight', repository.terminate({
      datasetKind: fixture.datasetKind,
      investigationId: input.investigationId,
      expectedCheckpointVersion: resumedAgain.checkpoint.checkpoint_version,
      status: 'completed',
      stopReason: 'completed',
      completedAt: '2026-09-25T10:04:03Z',
    }));
    const released = await repository.releaseUninvoked({
      datasetKind: fixture.datasetKind,
      investigationId: input.investigationId,
      reservationId: 'reservation-refresh-preserved',
      expectedCheckpointVersion: resumedAgain.checkpoint.checkpoint_version,
      releasedAt: '2026-09-25T10:04:04Z',
    });
    const terminal = await repository.terminate({
      datasetKind: fixture.datasetKind,
      investigationId: input.investigationId,
      expectedCheckpointVersion: released.checkpoint.checkpoint_version,
      status: 'stopped_for_review',
      stopReason: 'awaiting_moderator',
      completedAt: '2026-09-25T10:04:05Z',
    });
    assert.equal(terminal.checkpoint.case_status, 'stopped_for_review');
    await assertLedgerError('invalid_state', repository.resume({
      datasetKind: fixture.datasetKind,
      investigationId: input.investigationId,
      expectedCheckpointVersion: terminal.checkpoint.checkpoint_version,
      resumedAt: '2026-09-25T10:04:06Z',
    }));
  });

  it('counts failed reasoning against configured budgets and appends only successful validated model runs', async () => {
    const fixture = await seedFixture(testDatabase, 'reasoning-budget', { sufficient: false });
    const repository = createSqlInvestigationLedgerRepository(testDatabase.executor);
    const input = makeCreateInput(fixture, {
      limits: { toolAttempts: 1, reasoningTurns: 2, activeSeconds: 12, modelTokens: 10 },
    });
    const initial = await repository.create(input);
    const failedReservation = await repository.reserveAction({
      datasetKind: fixture.datasetKind,
      investigationId: input.investigationId,
      reservationId: 'reservation-reasoning-failed',
      expectedCheckpointVersion: initial.checkpoint_version,
      actionKind: 'reasoning',
      actionName: 'reasoner.synthesis',
      reservedActiveSeconds: 3,
      reservedModelTokens: 4,
      reservedAt: '2026-09-25T10:05:00Z',
    });
    await assertLedgerError('reservation_in_flight', repository.reserveAction({
      datasetKind: fixture.datasetKind,
      investigationId: input.investigationId,
      reservationId: 'reservation-reasoning-concurrent',
      expectedCheckpointVersion: failedReservation.checkpoint.checkpoint_version,
      actionKind: 'tool',
      actionName: 'lookup.concurrent',
      reservedActiveSeconds: 1,
      reservedModelTokens: 0,
      reservedAt: '2026-09-25T10:05:01Z',
    }));
    await repository.startAction({
      datasetKind: fixture.datasetKind,
      investigationId: input.investigationId,
      reservationId: 'reservation-reasoning-failed',
      startedAt: '2026-09-25T10:05:02Z',
    });
    await assertLedgerError('budget_exhausted', repository.reconcileAction({
      datasetKind: fixture.datasetKind,
      investigationId: input.investigationId,
      reservationId: 'reservation-reasoning-failed',
      expectedCheckpointVersion: failedReservation.checkpoint.checkpoint_version,
      outcome: 'failed',
      actualActiveSeconds: 4,
      actualModelTokens: 2,
      finishedAt: '2026-09-25T10:05:03Z',
    }));
    const failed = await repository.reconcileAction({
      datasetKind: fixture.datasetKind,
      investigationId: input.investigationId,
      reservationId: 'reservation-reasoning-failed',
      expectedCheckpointVersion: failedReservation.checkpoint.checkpoint_version,
      outcome: 'failed',
      actualActiveSeconds: 2,
      actualModelTokens: 2,
      finishedAt: '2026-09-25T10:05:04Z',
    });
    assert.equal(failed.checkpoint.budget.consumed.reasoning_turns, 1);
    assert.equal(failed.checkpoint.budget.consumed.model_tokens, 2);
    assert.equal(failed.checkpoint.reasoning_runs.length, 0);
    const internalFailure = await repository.getInFlightReservation(fixture.datasetKind, input.investigationId);
    assert.equal(internalFailure, null, 'reconciled failures are not left in-flight');
    const outcome = await testDatabase.executor.query<{ outcome: string; actual_model_tokens: number }>(
      `SELECT outcome, actual_model_tokens FROM waspada.investigation_action_reservations
       WHERE dataset_kind = $1 AND reservation_id = 'reservation-reasoning-failed'`,
      [fixture.datasetKind],
    );
    assert.deepEqual(outcome.rows[0], { outcome: 'failed', actual_model_tokens: 2 });

    const successReservation = await repository.reserveAction({
      datasetKind: fixture.datasetKind,
      investigationId: input.investigationId,
      reservationId: 'reservation-reasoning-success',
      expectedCheckpointVersion: failed.checkpoint.checkpoint_version,
      actionKind: 'reasoning',
      actionName: 'reasoner.synthesis',
      reservedActiveSeconds: 5,
      reservedModelTokens: 8,
      reservedAt: '2026-09-25T10:06:00Z',
    });
    await repository.startAction({
      datasetKind: fixture.datasetKind,
      investigationId: input.investigationId,
      reservationId: 'reservation-reasoning-success',
      startedAt: '2026-09-25T10:06:01Z',
    });
    const modelRun = {
      capability: 'reasoning' as const,
      model_version: 'synthetic-reasoner-v1',
      prompt_version: 'synthetic-prompt-v1',
      input_tokens: 4,
      output_tokens: 3,
    };
    const success = await repository.reconcileAction({
      datasetKind: fixture.datasetKind,
      investigationId: input.investigationId,
      reservationId: 'reservation-reasoning-success',
      expectedCheckpointVersion: successReservation.checkpoint.checkpoint_version,
      outcome: 'succeeded',
      actualActiveSeconds: 3,
      actualModelTokens: 7,
      finishedAt: '2026-09-25T10:06:04Z',
      modelRun,
    });
    assert.deepEqual(success.checkpoint.reasoning_runs, [modelRun]);
    assert.equal(success.checkpoint.budget.consumed.reasoning_turns, 2);
    assert.equal(success.checkpoint.budget.consumed.active_seconds, 5);
    assert.equal(success.checkpoint.budget.consumed.model_tokens, 9);
    await assertLedgerError('reservation_conflict', repository.reconcileAction({
      datasetKind: fixture.datasetKind,
      investigationId: input.investigationId,
      reservationId: 'reservation-reasoning-success',
      expectedCheckpointVersion: successReservation.checkpoint.checkpoint_version,
      outcome: 'succeeded',
      actualActiveSeconds: 3,
      actualModelTokens: 7,
      finishedAt: '2026-09-25T10:06:04Z',
      modelRun: { ...modelRun, model_version: 'changed-replay-version' },
    }));
    await assertLedgerError('budget_exhausted', repository.reserveAction({
      datasetKind: fixture.datasetKind,
      investigationId: input.investigationId,
      reservationId: 'reservation-reasoning-over-limit',
      expectedCheckpointVersion: success.checkpoint.checkpoint_version,
      actionKind: 'reasoning',
      actionName: 'reasoner.synthesis',
      reservedActiveSeconds: 1,
      reservedModelTokens: 1,
      reservedAt: '2026-09-25T10:07:00Z',
    }));
  });

  it('charges interrupted invocations at their reservation and releases only known-uninvoked actions', async () => {
    const fixture = await seedFixture(testDatabase, 'interruption-release', { sufficient: false });
    const repository = createSqlInvestigationLedgerRepository(testDatabase.executor);
    const input = makeCreateInput(fixture, {
      limits: { toolAttempts: 2, reasoningTurns: 1, activeSeconds: 20, modelTokens: 30 },
    });
    const initial = await repository.create(input);
    const interruptedReservation = await repository.reserveAction({
      datasetKind: fixture.datasetKind,
      investigationId: input.investigationId,
      reservationId: 'reservation-interrupted',
      expectedCheckpointVersion: initial.checkpoint_version,
      actionKind: 'tool',
      actionName: 'lookup.interrupted',
      reservedActiveSeconds: 10,
      reservedModelTokens: 0,
      reservedAt: '2026-09-25T10:08:00Z',
    });
    await repository.startAction({
      datasetKind: fixture.datasetKind,
      investigationId: input.investigationId,
      reservationId: 'reservation-interrupted',
      startedAt: '2026-09-25T10:08:01Z',
    });
    const timeout = await repository.reconcileInterrupted({
      datasetKind: fixture.datasetKind,
      investigationId: input.investigationId,
      reservationId: 'reservation-interrupted',
      expectedCheckpointVersion: interruptedReservation.checkpoint.checkpoint_version,
      finishedAt: '2026-09-25T10:08:20Z',
    });
    assert.equal(timeout.checkpoint.budget.consumed.tool_attempts, 1);
    assert.equal(timeout.checkpoint.budget.consumed.active_seconds, 10);
    assert.equal(timeout.checkpoint.attempts[0]?.outcome, 'timed_out');
    const timeoutReplay = await repository.reconcileInterrupted({
      datasetKind: fixture.datasetKind,
      investigationId: input.investigationId,
      reservationId: 'reservation-interrupted',
      expectedCheckpointVersion: interruptedReservation.checkpoint.checkpoint_version,
      finishedAt: '2026-09-25T10:08:20Z',
    });
    assert.equal(timeoutReplay.replayed, true);
    assert.equal(timeoutReplay.checkpoint.checkpoint_version, timeout.checkpoint.checkpoint_version);

    const safeReservation = await repository.reserveAction({
      datasetKind: fixture.datasetKind,
      investigationId: input.investigationId,
      reservationId: 'reservation-safe-release',
      expectedCheckpointVersion: timeout.checkpoint.checkpoint_version,
      actionKind: 'tool',
      actionName: 'lookup.uninvoked',
      reservedActiveSeconds: 10,
      reservedModelTokens: 0,
      reservedAt: '2026-09-25T10:09:00Z',
    });
    const released = await repository.releaseUninvoked({
      datasetKind: fixture.datasetKind,
      investigationId: input.investigationId,
      reservationId: 'reservation-safe-release',
      expectedCheckpointVersion: safeReservation.checkpoint.checkpoint_version,
      releasedAt: '2026-09-25T10:09:01Z',
    });
    assert.deepEqual(released.checkpoint.budget.consumed, timeout.checkpoint.budget.consumed);
    assert.deepEqual(released.checkpoint.budget.reserved, zeroCounters());
    assert.equal(await repository.getInFlightReservation(fixture.datasetKind, input.investigationId), null);
    assert.equal((await repository.releaseUninvoked({
      datasetKind: fixture.datasetKind,
      investigationId: input.investigationId,
      reservationId: 'reservation-safe-release',
      expectedCheckpointVersion: safeReservation.checkpoint.checkpoint_version,
      releasedAt: '2026-09-25T10:09:01Z',
    })).replayed, true);
    await assertLedgerError('reservation_conflict', repository.releaseUninvoked({
      datasetKind: fixture.datasetKind,
      investigationId: input.investigationId,
      reservationId: 'reservation-safe-release',
      expectedCheckpointVersion: safeReservation.checkpoint.checkpoint_version,
      releasedAt: '2026-09-25T10:09:02Z',
    }));
    const releasedStart = await repository.startAction({
      datasetKind: fixture.datasetKind,
      investigationId: input.investigationId,
      reservationId: 'reservation-safe-release',
      startedAt: '2026-09-25T10:09:02Z',
    });
    assert.equal(releasedStart.mayInvoke, false);

    const activeReservation = await repository.reserveAction({
      datasetKind: fixture.datasetKind,
      investigationId: input.investigationId,
      reservationId: 'reservation-started-release',
      expectedCheckpointVersion: released.checkpoint.checkpoint_version,
      actionKind: 'tool',
      actionName: 'lookup.started',
      reservedActiveSeconds: 10,
      reservedModelTokens: 0,
      reservedAt: '2026-09-25T10:10:00Z',
    });
    await repository.startAction({
      datasetKind: fixture.datasetKind,
      investigationId: input.investigationId,
      reservationId: 'reservation-started-release',
      startedAt: '2026-09-25T10:10:01Z',
    });
    await assertLedgerError('invalid_state', repository.releaseUninvoked({
      datasetKind: fixture.datasetKind,
      investigationId: input.investigationId,
      reservationId: 'reservation-started-release',
      expectedCheckpointVersion: activeReservation.checkpoint.checkpoint_version,
      releasedAt: '2026-09-25T10:10:02Z',
    }));
    await assertLedgerError('reservation_in_flight', repository.pause({
      datasetKind: fixture.datasetKind,
      investigationId: input.investigationId,
      expectedCheckpointVersion: activeReservation.checkpoint.checkpoint_version,
      pausedAt: '2026-09-25T10:10:02Z',
    }));
    await assertLedgerError('budget_exhausted', repository.reconcileAction({
      datasetKind: fixture.datasetKind,
      investigationId: input.investigationId,
      reservationId: 'reservation-started-release',
      expectedCheckpointVersion: activeReservation.checkpoint.checkpoint_version,
      outcome: 'succeeded',
      actualActiveSeconds: 11,
      actualModelTokens: 0,
      finishedAt: '2026-09-25T10:10:12Z',
    }));
    const finished = await repository.reconcileAction({
      datasetKind: fixture.datasetKind,
      investigationId: input.investigationId,
      reservationId: 'reservation-started-release',
      expectedCheckpointVersion: activeReservation.checkpoint.checkpoint_version,
      outcome: 'succeeded',
      actualActiveSeconds: 10,
      actualModelTokens: 0,
      finishedAt: '2026-09-25T10:10:12Z',
    });
    assert.equal(finished.checkpoint.budget.consumed.tool_attempts, 2);
    assert.equal(finished.checkpoint.budget.consumed.active_seconds, 20);
    await assertLedgerError('budget_exhausted', repository.reserveAction({
      datasetKind: fixture.datasetKind,
      investigationId: input.investigationId,
      reservationId: 'reservation-over-case-limit',
      expectedCheckpointVersion: finished.checkpoint.checkpoint_version,
      actionKind: 'tool',
      actionName: 'lookup.exhausted',
      reservedActiveSeconds: 1,
      reservedModelTokens: 0,
      reservedAt: '2026-09-25T10:11:00Z',
    }));
    await assertLedgerError('invalid_input', repository.reserveAction({
      datasetKind: fixture.datasetKind,
      investigationId: input.investigationId,
      reservationId: 'reservation-over-hard-limit',
      expectedCheckpointVersion: finished.checkpoint.checkpoint_version,
      actionKind: 'tool',
      actionName: 'lookup.too-long',
      reservedActiveSeconds: 61,
      reservedModelTokens: 0,
      reservedAt: '2026-09-25T10:11:01Z',
    }));
  });

  it('executes ledger operations under the coordinator role and denies publication/history writes', async () => {
    const fixture = await seedFixture(testDatabase, 'role-scoped', { sufficient: false });
    const repository = createSqlInvestigationLedgerRepository(testDatabase.executor);
    const input = makeCreateInput(fixture);
    await testDatabase.executor.execute('SET ROLE waspada_l3_coordinator');
    try {
      const initial = await repository.create(input);
      const reservation = await repository.reserveAction({
        datasetKind: fixture.datasetKind,
        investigationId: input.investigationId,
        reservationId: 'reservation-role-scoped',
        expectedCheckpointVersion: initial.checkpoint_version,
        actionKind: 'tool',
        actionName: 'lookup.role-scoped',
        reservedActiveSeconds: 2,
        reservedModelTokens: 0,
        reservedAt: '2026-09-25T10:12:00Z',
      });
      await repository.startAction({
        datasetKind: fixture.datasetKind,
        investigationId: input.investigationId,
        reservationId: 'reservation-role-scoped',
        startedAt: '2026-09-25T10:12:01Z',
      });
      const reconciled = await repository.reconcileAction({
        datasetKind: fixture.datasetKind,
        investigationId: input.investigationId,
        reservationId: 'reservation-role-scoped',
        expectedCheckpointVersion: reservation.checkpoint.checkpoint_version,
        outcome: 'denied',
        actualActiveSeconds: 1,
        actualModelTokens: 0,
        finishedAt: '2026-09-25T10:12:02Z',
      });
      assert.equal(reconciled.checkpoint.budget.consumed.tool_attempts, 1);
      await assert.rejects(testDatabase.executor.query('SELECT event_id FROM waspada.event_versions'), /permission denied/);
      await assert.rejects(testDatabase.executor.query('SELECT decision_id FROM waspada.publication_decisions'), /permission denied/);
      await assert.rejects(testDatabase.executor.query(
        `UPDATE waspada.investigation_checkpoints SET record_json = '{}'::jsonb
         WHERE dataset_kind = $1 AND investigation_id = $2`,
        [fixture.datasetKind, input.investigationId],
      ), /permission denied/);
      await assert.rejects(testDatabase.executor.query(
        `DELETE FROM waspada.investigation_checkpoints
         WHERE dataset_kind = $1 AND investigation_id = $2`,
        [fixture.datasetKind, input.investigationId],
      ), /permission denied/);
      await assert.rejects(testDatabase.executor.query(
        `UPDATE waspada.investigation_requests SET limit_tool_attempts = 5
         WHERE dataset_kind = $1 AND investigation_id = $2`,
        [fixture.datasetKind, input.investigationId],
      ), /permission denied/);
      await assert.rejects(testDatabase.executor.query(
        `INSERT INTO waspada.event_versions
           (dataset_kind, event_id, version, trace_id, title, summary, category, lifecycle,
            publication_status, publication_decision_id, record_json)
         VALUES ('synthetic', 'event-forbidden', 1, $1, 'Denied fixture event',
           'No publication access', 'transport_road_incidents', 'unknown', 'withdrawn',
           'decision-forbidden', '{"claims":[],"impact_refs":[],"fixture":"synthetic"}'::jsonb)`,
        [fixture.traceId],
      ), /permission denied/);
    } finally {
      await testDatabase.executor.execute('RESET ROLE');
    }
  });
});

interface FixtureContext {
  readonly datasetKind: DatasetKind;
  readonly candidateId: string;
  readonly contextId: string;
  readonly traceId: string;
}

async function seedFixture(
  testDatabase: TestDatabase,
  suffix: string,
  options: { readonly sufficient: boolean },
): Promise<FixtureContext> {
  const datasetKind: DatasetKind = 'synthetic';
  const seedTrace = `trace-l3-seed-${suffix}`;
  const traceId = `trace-l3-context-${suffix}`;
  const sourceId = `source-l3-${suffix}`;
  const reportRevisionId = `revision-l3-${suffix}`;
  const candidateId = `candidate-l3-${suffix}`;
  const contextId = `context-l3-${suffix}`;
  const permittedText = 'Synthetic L3 ledger fixture evidence';
  const textHash = sha256(permittedText);

  await testDatabase.executor.query(
    `INSERT INTO waspada.traces (trace_id, dataset_kind, started_at, outcome, metadata)
     VALUES ($1, $3, $4::timestamptz, 'open', '{"fixture":"synthetic-test-only"}'::jsonb),
            ($2, $3, $4::timestamptz, 'open', '{"fixture":"synthetic-test-only"}'::jsonb)`,
    [seedTrace, traceId, datasetKind, TEST_TIME],
  );
  await testDatabase.executor.query(
    `INSERT INTO waspada.source_registry
       (source_id, trace_id, registry_version, display_name, source_kind, remit,
        access_method, approved_hosts, access_restrictions, reuse_basis, registry_status,
        approval_status, health_status, auto_acquisition_enabled, auto_publication_policy)
     VALUES ($1, $2, 1, 'Synthetic test fixture', 'other', ARRAY['test fixture'],
        'manual_fixture', ARRAY[]::text[], ARRAY['synthetic-only'], ARRAY['test fixture'],
        'active', 'pending', 'unknown', false, 'never')`,
    [sourceId, seedTrace],
  );
  await testDatabase.executor.query(
    `INSERT INTO waspada.report_revisions
       (dataset_kind, report_revision_id, trace_id, source_id, canonical_url,
        content_hash, permitted_text, permitted_text_hash, normalization_version,
        retrieved_at, revision_status, record_json)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'fixture-normalization-v1',
        $9::timestamptz, 'unreviewed', $10::jsonb)`,
    [datasetKind, reportRevisionId, seedTrace, sourceId, `https://synthetic.invalid/${suffix}`,
      sha256(`synthetic raw fixture ${suffix}`), permittedText, textHash, TEST_TIME,
      JSON.stringify({ fixture: 'synthetic-test-only' })],
  );
  await testDatabase.executor.query(
    `INSERT INTO waspada.extraction_results
       (dataset_kind, candidate_id, trace_id, report_revision_id, record_json)
     VALUES ($1, $2, $3, $4, $5::jsonb)`,
    [datasetKind, candidateId, seedTrace, reportRevisionId,
      JSON.stringify({ record_type: 'ExtractionResult', fixture: 'synthetic-test-only' })],
  );
  await testDatabase.executor.query(
    `INSERT INTO waspada.grounding_contexts
       (dataset_kind, context_id, trace_id, candidate_id, retrieval_version,
        index_version, sufficient, record_json)
     VALUES ($1, $2, $3, $4, 'retrieval-synthetic-test-v1', 'index-synthetic-test-v1', $5, $6::jsonb)`,
    [datasetKind, contextId, traceId, candidateId, options.sufficient,
      JSON.stringify({ record_type: 'GroundingContext', fixture: 'synthetic-test-only' })],
  );
  return { datasetKind, candidateId, contextId, traceId };
}

async function seedAdditionalContext(
  testDatabase: TestDatabase,
  suffix: string,
  input: { readonly datasetKind: DatasetKind; readonly candidateId: string; readonly sufficient: boolean },
): Promise<FixtureContext> {
  const contextId = `context-l3-${suffix}`;
  const traceId = `trace-l3-context-${suffix}`;
  await testDatabase.executor.query(
    `INSERT INTO waspada.traces (trace_id, dataset_kind, started_at, outcome, metadata)
     VALUES ($1, $2, $3::timestamptz, 'open', '{"fixture":"synthetic-test-only"}'::jsonb)`,
    [traceId, input.datasetKind, TEST_TIME],
  );
  await testDatabase.executor.query(
    `INSERT INTO waspada.grounding_contexts
       (dataset_kind, context_id, trace_id, candidate_id, retrieval_version,
        index_version, sufficient, record_json)
     VALUES ($1, $2, $3, $4, 'retrieval-synthetic-refresh-v1', 'index-synthetic-refresh-v1', $5, $6::jsonb)`,
    [input.datasetKind, contextId, traceId, input.candidateId, input.sufficient,
      JSON.stringify({ record_type: 'GroundingContext', fixture: 'synthetic-test-only' })],
  );
  return { datasetKind: input.datasetKind, candidateId: input.candidateId, contextId, traceId };
}

function makeCreateInput(fixture: FixtureContext, overrides: Partial<CreateInvestigationInput> = {}): CreateInvestigationInput {
  return {
    datasetKind: fixture.datasetKind,
    investigationId: `investigation-${fixture.candidateId}`,
    traceId: fixture.traceId,
    candidateId: fixture.candidateId,
    contextId: fixture.contextId,
    eventId: null,
    eventVersion: null,
    questions: ['Which synthetic detail is still unknown?'],
    policyVersion: 'budget-policy-v1',
    limits: { toolAttempts: 5, reasoningTurns: 4, activeSeconds: 60, modelTokens: 12_000 },
    requestedAt: '2026-09-25T10:00:10Z',
    ...overrides,
  };
}

function zeroCounters(): {
  readonly tool_attempts: 0;
  readonly reasoning_turns: 0;
  readonly active_seconds: 0;
  readonly model_tokens: 0;
} {
  return { tool_attempts: 0, reasoning_turns: 0, active_seconds: 0, model_tokens: 0 };
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

async function assertLedgerError(code: InvestigationLedgerError['code'], work: Promise<unknown>): Promise<void> {
  await assert.rejects(work, (error: unknown) => error instanceof InvestigationLedgerError && error.code === code);
}
