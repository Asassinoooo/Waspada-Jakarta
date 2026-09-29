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
import {
  INVESTIGATION_PLAN_CAPABILITY,
  type InvestigationPlanRequest,
  type InvestigationPlanner,
  type InvestigationPlannerOutcome,
  type InvestigationPlannerPreflightOutcome,
} from '../../worker/src/layers/l2-model-grounding/investigation-planner.js';
import { validateReasoningRequest } from '../../worker/src/layers/l2-model-grounding/validation.js';
import { createL3FingerprintService } from '../../worker/src/layers/l3-investigation/progress-fingerprint.js';
import {
  createReasoningStepExecutor,
  type ReasoningStepExecutorClock,
  type ReasoningStepExecutorTimer,
} from '../../worker/src/layers/l3-investigation/reasoning-step-executor.js';
import { createTestDatabase, type TestDatabase } from './harness.js';

const TEST_TIME = '2026-09-25T10:00:00Z';
const TEST_FINGERPRINTS = createL3FingerprintService({
  keyId: 'fixture-hmac-v1',
  keyMaterial: new Uint8Array(32).fill(47),
});

describe('L3 durable investigation ledger', () => {
  let testDatabase: TestDatabase;

  before(async () => {
    testDatabase = await createTestDatabase();
    const migrations = await readMigrations(new URL('../migrations/', import.meta.url));
    const result = await applyMigrations(testDatabase.executor, migrations);
    assert.ok(result.applied.includes('010_l2_grounding_context_writer'));
  assert.ok(result.applied.includes('019_l3_progress_fingerprints'));
  });

  after(async () => {
    await testDatabase.close();
  });

  it('persists the initial progress baseline and replays, caps, and resets progress snapshots', async () => {
    const fixture = await seedFixture(testDatabase, 'progress-streak', { sufficient: false });
    const repository = createSqlInvestigationLedgerRepository(testDatabase.executor);
    const replayRepository = createSqlInvestigationLedgerRepository(testDatabase.executor);
    const input = makeCreateInput(fixture);
    await repository.create(input);

    const initialSnapshot = await testDatabase.executor.query<{
      checkpoint_version: number;
      context_id: string;
      fingerprint_key_id: string;
      digest_hex: string;
      consecutive_no_progress: number;
    }>(
      "SELECT checkpoint_version, context_id, fingerprint_key_id, "
        + "encode(grounding_fingerprint, 'hex') AS digest_hex, consecutive_no_progress "
        + "FROM waspada.investigation_progress_snapshots "
        + "WHERE dataset_kind = $1 AND investigation_id = $2",
      [fixture.datasetKind, input.investigationId],
    );
    assert.deepEqual(initialSnapshot.rows, [{
      checkpoint_version: 1,
      context_id: fixture.contextId,
      fingerprint_key_id: TEST_FINGERPRINT_KEY_ID,
      digest_hex: input.initialGroundingDigestHex,
      consecutive_no_progress: 0,
    }]);

    const firstRefresh = {
      datasetKind: fixture.datasetKind,
      investigationId: input.investigationId,
      expectedCheckpointVersion: 1,
      contextId: fixture.contextId,
      fingerprintKeyId: TEST_FINGERPRINT_KEY_ID,
      digestHex: input.initialGroundingDigestHex,
      refreshedAt: '2026-09-25T10:01:00Z',
    };
    const first = await repository.refreshGroundingProgress(firstRefresh);
    assert.equal(first.checkpoint.checkpoint_version, 2);
    assert.equal(first.snapshot.consecutiveNoProgress, 1);
    const replay = await replayRepository.refreshGroundingProgress(firstRefresh);
    assert.equal(replay.replayed, true);
    assert.equal(replay.checkpoint.checkpoint_version, 2);
    assert.equal(replay.snapshot.consecutiveNoProgress, 1);
    await assertLedgerError('progress_conflict', repository.refreshGroundingProgress({
      ...firstRefresh,
      digestHex: testDigest('conflicting-replay'),
    }));

    const stopped = await repository.refreshGroundingProgress({
      ...firstRefresh,
      expectedCheckpointVersion: 2,
      refreshedAt: '2026-09-25T10:02:00Z',
    });
    assert.equal(stopped.snapshot.consecutiveNoProgress, 2);
    assert.equal(stopped.checkpoint.case_status, 'stopped_for_review');
    assert.equal(stopped.checkpoint.stop_reason, 'no_progress');

    const resetFixture = await seedFixture(testDatabase, 'progress-reset', { sufficient: false });
    const refreshedContext = await seedAdditionalContext(testDatabase, 'progress-reset-next', {
      datasetKind: resetFixture.datasetKind,
      candidateId: resetFixture.candidateId,
      sufficient: false,
    });
    const resetInput = makeCreateInput(resetFixture);
    await repository.create(resetInput);
    const changed = await repository.refreshGroundingProgress({
      datasetKind: resetFixture.datasetKind,
      investigationId: resetInput.investigationId,
      expectedCheckpointVersion: 1,
      contextId: refreshedContext.contextId,
      fingerprintKeyId: TEST_FINGERPRINT_KEY_ID,
      digestHex: testDigest('changed-grounding'),
      refreshedAt: '2026-09-25T10:03:00Z',
    });
    assert.equal(changed.snapshot.consecutiveNoProgress, 0);
    const repeated = await repository.refreshGroundingProgress({
      datasetKind: resetFixture.datasetKind,
      investigationId: resetInput.investigationId,
      expectedCheckpointVersion: 2,
      contextId: refreshedContext.contextId,
      fingerprintKeyId: TEST_FINGERPRINT_KEY_ID,
      digestHex: testDigest('changed-grounding'),
      refreshedAt: '2026-09-25T10:04:00Z',
    });
    assert.equal(repeated.snapshot.consecutiveNoProgress, 1);
    const reset = await repository.refreshGroundingProgress({
      datasetKind: resetFixture.datasetKind,
      investigationId: resetInput.investigationId,
      expectedCheckpointVersion: 3,
      contextId: refreshedContext.contextId,
      fingerprintKeyId: TEST_FINGERPRINT_KEY_ID,
      digestHex: testDigest('new-grounding'),
      refreshedAt: '2026-09-25T10:05:00Z',
    });
    assert.equal(reset.snapshot.consecutiveNoProgress, 0);
    assert.equal(reset.checkpoint.case_status, 'open');

    const paused = await repository.pause({
      datasetKind: resetFixture.datasetKind,
      investigationId: resetInput.investigationId,
      expectedCheckpointVersion: reset.checkpoint.checkpoint_version,
      pausedAt: '2026-09-25T10:06:00Z',
    });
    await assertLedgerError('stale_checkpoint', repository.refreshGroundingProgress({
      datasetKind: resetFixture.datasetKind,
      investigationId: resetInput.investigationId,
      expectedCheckpointVersion: reset.checkpoint.checkpoint_version,
      contextId: refreshedContext.contextId,
      fingerprintKeyId: TEST_FINGERPRINT_KEY_ID,
      digestHex: testDigest('stale-grounding'),
      refreshedAt: '2026-09-25T10:07:00Z',
    }));
    await assertLedgerError('invalid_input', repository.refreshGroundingProgress({
      datasetKind: resetFixture.datasetKind,
      investigationId: resetInput.investigationId,
      expectedCheckpointVersion: paused.checkpoint.checkpoint_version,
      contextId: refreshedContext.contextId,
      fingerprintKeyId: TEST_FINGERPRINT_KEY_ID,
      digestHex: testDigest('out-of-order'),
      refreshedAt: '2026-09-25T10:05:30Z',
    }));
    const wrongCandidate = await seedFixture(testDatabase, 'progress-other-candidate', { sufficient: false });
    await assertLedgerError('context_mismatch', repository.refreshGroundingProgress({
      datasetKind: resetFixture.datasetKind,
      investigationId: resetInput.investigationId,
      expectedCheckpointVersion: paused.checkpoint.checkpoint_version,
      contextId: wrongCandidate.contextId,
      fingerprintKeyId: TEST_FINGERPRINT_KEY_ID,
      digestHex: testDigest('wrong-candidate'),
      refreshedAt: '2026-09-25T10:08:00Z',
    }));
  });

  it('rejects an exact registered action after a cold restart without consuming more budget', async () => {
    const fixture = await seedFixture(testDatabase, 'duplicate-action', { sufficient: false });
    const firstRepository = createSqlInvestigationLedgerRepository(testDatabase.executor);
    const restartedRepository = createSqlInvestigationLedgerRepository(testDatabase.executor);
    const input = makeCreateInput(fixture);
    const initial = await firstRepository.create(input);
    const actionFingerprint = testFingerprint('lookup.same-input');
    const reservation = {
      datasetKind: fixture.datasetKind,
      investigationId: input.investigationId,
      reservationId: 'reservation-first-action',
      expectedCheckpointVersion: initial.checkpoint_version,
      actionKind: 'tool' as const,
      actionFingerprint,
      actionName: 'lookup.same-input',
      reservedActiveSeconds: 7,
      reservedModelTokens: 0,
      reservedAt: '2026-09-25T10:01:00Z',
    };
    const first = await firstRepository.reserveAction(reservation);
    assert.equal(first.replayed, false);
    const replay = await restartedRepository.reserveAction(reservation);
    assert.equal(replay.replayed, true);
    assert.equal(replay.mayInvoke, false);
    await assertLedgerError('duplicate_action', restartedRepository.reserveAction({
      ...reservation,
      reservationId: 'reservation-second-action',
      expectedCheckpointVersion: first.checkpoint.checkpoint_version,
      reservedAt: '2026-09-25T10:02:00Z',
    }));

    const state = await testDatabase.executor.query<{
      checkpoint_version: number;
      reserved_tool_attempts: number;
      reserved_active_seconds: number;
    }>(
      "SELECT request.reserved_tool_attempts, request.reserved_active_seconds, "
        + "checkpoint.checkpoint_version "
        + "FROM waspada.investigation_requests AS request "
        + "JOIN waspada.investigation_checkpoints AS checkpoint "
        + "ON checkpoint.dataset_kind = request.dataset_kind "
        + "AND checkpoint.investigation_id = request.investigation_id "
        + "WHERE request.dataset_kind = $1 AND request.investigation_id = $2 "
        + "ORDER BY checkpoint.checkpoint_version DESC LIMIT 1",
      [fixture.datasetKind, input.investigationId],
    );
    assert.deepEqual(state.rows[0], {
      checkpoint_version: 2,
      reserved_tool_attempts: 1,
      reserved_active_seconds: 7,
    });
    const persisted = await testDatabase.executor.query<{
      action_fingerprint_key_id: string;
      digest_hex: string;
    }>(
      "SELECT action_fingerprint_key_id, encode(action_fingerprint, 'hex') AS digest_hex "
        + "FROM waspada.investigation_action_reservations "
        + "WHERE dataset_kind = $1 AND reservation_id = $2",
      [fixture.datasetKind, reservation.reservationId],
    );
    assert.deepEqual(persisted.rows, [{
      action_fingerprint_key_id: TEST_FINGERPRINT_KEY_ID,
      digest_hex: actionFingerprint.digestHex,
    }]);
    const publicRecord = await testDatabase.executor.query<{ record_json: string }>(
      "SELECT record_json::text AS record_json FROM waspada.investigation_requests "
        + "WHERE dataset_kind = $1 AND investigation_id = $2",
      [fixture.datasetKind, input.investigationId],
    );
    assert.equal(publicRecord.rows[0]?.record_json.includes(TEST_FINGERPRINT_KEY_ID), false);
    assert.equal(publicRecord.rows[0]?.record_json.includes(actionFingerprint.digestHex), false);
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
      actionFingerprint: testFingerprint('lookup.synthetic'),
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
      actionFingerprint: testFingerprint('lookup.denied'),
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
      actionFingerprint: testFingerprint('lookup.cancelled'),
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
      actionFingerprint: testFingerprint('lookup.refresh'),
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
      progressFingerprint: testFingerprint('refreshed-grounding'),
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
      actionFingerprint: testFingerprint('lookup.stale'),
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
      progressFingerprint: testFingerprint('other-candidate-grounding'),
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
      actionFingerprint: testFingerprint('lookup.concurrent'),
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

  it('integrates one proposal and a stale retry with the persisted L3 ledger', async () => {
    const fixture = await seedFixture(testDatabase, 'reasoning-step-pglite-success', { sufficient: false });
    const request = makeReasoningStepRequest(fixture);
    const repository = createSqlInvestigationLedgerRepository(testDatabase.executor);
    const initial = await repository.create(makeCreateInput(fixture, {
      questions: [...request.questions],
      limits: { toolAttempts: 2, reasoningTurns: 3, activeSeconds: 30, modelTokens: 500 },
    }));
    const maxActiveSeconds = 11;
    const maxModelTokens = 96;
    let monotonicMilliseconds = 0;
    const startedAt = '2026-09-25T10:10:00.000Z';
    const startedAtMilliseconds = Date.parse(startedAt);
    const clock: ReasoningStepExecutorClock = {
      wallNow: () => new Date(startedAtMilliseconds + monotonicMilliseconds).toISOString(),
      monotonicNow: () => monotonicMilliseconds,
    };
    const usage = {
      inputTokens: 17,
      outputTokens: 8,
      totalTokens: 25,
      modelVersion: '@synthetic/planner-v9',
      promptVersion: 'synthetic/prompts/reasoning-step-v4',
    };
    const proposedValue = {
      schemaVersion: '1.0',
      recordType: 'InvestigationPlanResult',
      outcome: 'proposed',
      actionName: 'synthetic_search',
      input: { query: 'ephemeral synthetic planner output' },
    } as const;
    const plannerDouble = makeReasoningPlannerDouble({
      request,
      maxModelTokens,
      outcome: {
        status: 'succeeded',
        capability: INVESTIGATION_PLAN_CAPABILITY,
        value: proposedValue,
        usage,
      },
      onPropose: async () => {
        await assertPlanningReservationStarted({
          testDatabase,
          repository,
          fixture,
          investigationId: initial.investigation_id,
          reservationId: 'reservation-reasoning-step-pglite-success',
          reservedActiveSeconds: maxActiveSeconds,
          reservedModelTokens: maxModelTokens,
        });
        monotonicMilliseconds += 2_300;
      },
    });
    const timer: ReasoningStepExecutorTimer = {
      setTimeout(_callback, delayMs) {
        assert.equal(delayMs, maxActiveSeconds * 1_000);
        return Symbol('planner-deadline');
      },
      clearTimeout() {},
    };
    const executor = createReasoningStepExecutor({
      ledger: repository,
      fingerprints: TEST_FINGERPRINTS,
      planner: plannerDouble.planner,
      maxActiveSeconds,
      maxModelTokens,
      clock,
      timer,
    });
    const stepProposal = {
      datasetKind: fixture.datasetKind,
      investigationId: initial.investigation_id,
      expectedCheckpointVersion: initial.checkpoint_version,
      reservationId: 'reservation-reasoning-step-pglite-success',
      reservedAt: startedAt,
      request,
    } as const;

    const result = await executor.plan(stepProposal);
    assert.equal(result.status, 'proposed');
    if (result.status !== 'proposed') assert.fail('expected the valid planner proposal');
    assert.deepEqual(result.proposal, proposedValue);
    assert.deepEqual(result.usage, usage);
    assert.equal(plannerDouble.preflightCalls, 1);
    assert.equal(plannerDouble.proposeCalls, 1);

    const checkpoint = await repository.getLatest(fixture.datasetKind, initial.investigation_id);
    assert.ok(checkpoint);
    assert.equal(checkpoint.checkpoint_version, initial.checkpoint_version + 2);
    assert.equal(checkpoint.case_status, 'open');
    assert.deepEqual(checkpoint.budget.consumed, {
      tool_attempts: 0,
      reasoning_turns: 1,
      active_seconds: 3,
      model_tokens: usage.totalTokens,
    });
    assert.deepEqual(checkpoint.budget.reserved, zeroCounters());
    assert.deepEqual(checkpoint.reasoning_runs, [{
      capability: 'reasoning',
      model_version: usage.modelVersion,
      prompt_version: usage.promptVersion,
      input_tokens: usage.inputTokens,
      output_tokens: usage.outputTokens,
    }]);

    const reservation = await readStoredReservation(
      testDatabase,
      fixture.datasetKind,
      initial.investigation_id,
      stepProposal.reservationId,
    );
    assert.equal(reservation.reservation_status, 'reconciled');
    assert.equal(reservation.outcome, 'succeeded');
    assert.equal(reservation.expected_checkpoint_version, initial.checkpoint_version);
    assert.equal(reservation.reserved_reasoning_turns, 1);
    assert.equal(reservation.reserved_active_seconds, maxActiveSeconds);
    assert.equal(reservation.reserved_model_tokens, maxModelTokens);
    assert.equal(reservation.actual_active_seconds, 3);
    assert.equal(reservation.actual_model_tokens, usage.totalTokens);
    assert.ok(reservation.started_at);
    assert.ok(reservation.finished_at);
    assert.equal(reservation.reconciled_checkpoint_version, checkpoint.checkpoint_version);

    const checkpointBeforeRetry = checkpoint;
    const retry = await executor.plan(stepProposal);
    assert.equal(retry.status, 'review_required');
    if (retry.status !== 'review_required') assert.fail('expected the original checkpoint to be stale');
    assert.equal(retry.reason, 'stale_checkpoint');
    assert.equal(retry.checkpoint?.checkpoint_version, checkpointBeforeRetry.checkpoint_version);
    assert.equal(plannerDouble.preflightCalls, 2);
    assert.equal(plannerDouble.proposeCalls, 1, 'a stale retry cannot make a second planner call');
    assert.deepEqual(await repository.getLatest(fixture.datasetKind, initial.investigation_id), checkpointBeforeRetry);
    assert.deepEqual(
      await readStoredReservation(testDatabase, fixture.datasetKind, initial.investigation_id, stepProposal.reservationId),
      reservation,
      'a stale retry cannot change the persisted reservation accounting',
    );

    const persistedJson = await readLedgerJson(testDatabase, fixture.datasetKind, initial.investigation_id);
    assert.equal(persistedJson.includes('ephemeral synthetic planner output'), false);
    assert.equal(persistedJson.includes('Synthetic L3 ledger fixture evidence'), false);
    assert.equal(persistedJson.includes(JSON.stringify(request)), false);
  });

  it('charges one provider error to the full configured reservation and closes it', async () => {
    const fixture = await seedFixture(testDatabase, 'reasoning-step-pglite-failure', { sufficient: false });
    const request = makeReasoningStepRequest(fixture);
    const repository = createSqlInvestigationLedgerRepository(testDatabase.executor);
    const initial = await repository.create(makeCreateInput(fixture, {
      questions: [...request.questions],
      limits: { toolAttempts: 2, reasoningTurns: 3, activeSeconds: 30, modelTokens: 500 },
    }));
    const maxActiveSeconds = 7;
    const maxModelTokens = 83;
    let monotonicMilliseconds = 0;
    const startedAt = '2026-09-25T10:20:00.000Z';
    const startedAtMilliseconds = Date.parse(startedAt);
    const clock: ReasoningStepExecutorClock = {
      wallNow: () => new Date(startedAtMilliseconds + monotonicMilliseconds).toISOString(),
      monotonicNow: () => monotonicMilliseconds,
    };
    const privateProviderFailure = 'synthetic provider exception must not enter the ledger';
    const plannerDouble = makeReasoningPlannerDouble({
      request,
      maxModelTokens,
      error: privateProviderFailure,
      onPropose: () => assertPlanningReservationStarted({
        testDatabase,
        repository,
        fixture,
        investigationId: initial.investigation_id,
        reservationId: 'reservation-reasoning-step-pglite-failure',
        reservedActiveSeconds: maxActiveSeconds,
        reservedModelTokens: maxModelTokens,
      }),
    });
    const timer: ReasoningStepExecutorTimer = {
      setTimeout() { return Symbol('planner-deadline'); },
      clearTimeout() {},
    };
    const executor = createReasoningStepExecutor({
      ledger: repository,
      fingerprints: TEST_FINGERPRINTS,
      planner: plannerDouble.planner,
      maxActiveSeconds,
      maxModelTokens,
      clock,
      timer,
    });
    const stepProposal = {
      datasetKind: fixture.datasetKind,
      investigationId: initial.investigation_id,
      expectedCheckpointVersion: initial.checkpoint_version,
      reservationId: 'reservation-reasoning-step-pglite-failure',
      reservedAt: startedAt,
      request,
    } as const;

    const result = await executor.plan(stepProposal);
    assert.equal(result.status, 'review_required');
    if (result.status !== 'review_required') assert.fail('expected provider failure to require review');
    assert.equal(result.reason, 'planner_failed');
    assert.equal(plannerDouble.preflightCalls, 1);
    assert.equal(plannerDouble.proposeCalls, 1);

    const checkpoint = await repository.getLatest(fixture.datasetKind, initial.investigation_id);
    assert.ok(checkpoint);
    assert.equal(checkpoint.checkpoint_version, initial.checkpoint_version + 2);
    assert.equal(checkpoint.case_status, 'open');
    assert.deepEqual(checkpoint.budget.consumed, {
      tool_attempts: 0,
      reasoning_turns: 1,
      active_seconds: maxActiveSeconds,
      model_tokens: maxModelTokens,
    });
    assert.deepEqual(checkpoint.budget.reserved, zeroCounters());
    assert.deepEqual(checkpoint.reasoning_runs, [], 'provider failures do not create a ModelRun');

    const reservation = await readStoredReservation(
      testDatabase,
      fixture.datasetKind,
      initial.investigation_id,
      stepProposal.reservationId,
    );
    assert.equal(reservation.reservation_status, 'reconciled');
    assert.equal(reservation.outcome, 'failed');
    assert.equal(reservation.expected_checkpoint_version, initial.checkpoint_version);
    assert.equal(reservation.reserved_reasoning_turns, 1);
    assert.equal(reservation.reserved_active_seconds, maxActiveSeconds);
    assert.equal(reservation.reserved_model_tokens, maxModelTokens);
    assert.equal(reservation.actual_active_seconds, maxActiveSeconds);
    assert.equal(reservation.actual_model_tokens, maxModelTokens);
    assert.ok(reservation.started_at);
    assert.ok(reservation.finished_at);
    assert.equal(reservation.reconciled_checkpoint_version, checkpoint.checkpoint_version);

    const persistedJson = await readLedgerJson(testDatabase, fixture.datasetKind, initial.investigation_id);
    assert.equal(persistedJson.includes(privateProviderFailure), false);
    assert.equal(persistedJson.includes('ephemeral synthetic planner output'), false);
    assert.equal(persistedJson.includes('Synthetic L3 ledger fixture evidence'), false);
    assert.equal(persistedJson.includes(JSON.stringify(request)), false);
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
      actionFingerprint: testFingerprint('lookup.interrupted'),
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
      actionFingerprint: testFingerprint('lookup.uninvoked'),
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
      actionFingerprint: testFingerprint('lookup.started'),
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
      actionFingerprint: testFingerprint('lookup.exhausted'),
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
      actionFingerprint: testFingerprint('lookup.too-long'),
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
      const baseline = await testDatabase.executor.query<{ fingerprint_key_id: string; digest_hex: string }>(
        "SELECT fingerprint_key_id, encode(grounding_fingerprint, 'hex') AS digest_hex "
          + "FROM waspada.investigation_progress_snapshots "
          + "WHERE dataset_kind = $1 AND investigation_id = $2",
        [fixture.datasetKind, input.investigationId],
      );
      assert.equal(baseline.rows.length, 1);
      assert.equal(baseline.rows[0]?.fingerprint_key_id, TEST_FINGERPRINT_KEY_ID);
      const reservation = await repository.reserveAction({
        datasetKind: fixture.datasetKind,
        investigationId: input.investigationId,
        reservationId: 'reservation-role-scoped',
        expectedCheckpointVersion: initial.checkpoint_version,
        actionKind: 'tool',
        actionFingerprint: testFingerprint('lookup.role-scoped'),
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
      await assert.rejects(
        testDatabase.executor.query(
          "UPDATE waspada.investigation_progress_snapshots SET consecutive_no_progress = 1 "
            + "WHERE dataset_kind = $1 AND investigation_id = $2",
          [fixture.datasetKind, input.investigationId],
        ),
        /permission denied/,
      );
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
    await assert.rejects(
      testDatabase.executor.query(
        "UPDATE waspada.investigation_progress_snapshots SET consecutive_no_progress = 1 "
          + "WHERE dataset_kind = $1 AND investigation_id = $2",
        [fixture.datasetKind, input.investigationId],
      ),
      /append-only/,
    );
    await testDatabase.executor.execute('SET ROLE waspada_l2_grounding_reader');
    try {
      await assert.rejects(
        testDatabase.executor.query(
          "SELECT fingerprint_key_id FROM waspada.investigation_requests "
            + "WHERE dataset_kind = $1 AND investigation_id = $2",
          [fixture.datasetKind, input.investigationId],
        ),
        /permission denied/,
      );
      await assert.rejects(
        testDatabase.executor.query(
          "SELECT * FROM waspada.investigation_progress_snapshots "
            + "WHERE dataset_kind = $1 AND investigation_id = $2",
          [fixture.datasetKind, input.investigationId],
        ),
        /permission denied/,
      );
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

function makeReasoningStepRequest(fixture: FixtureContext): InvestigationPlanRequest {
  const suffix = fixture.candidateId.slice('candidate-l3-'.length);
  const reportRevisionId = `revision-l3-${suffix}`;
  const permittedText = 'Synthetic L3 ledger fixture evidence';
  const permittedTextHash = sha256(permittedText);
  return {
    schemaVersion: '1.0',
    recordType: 'InvestigationPlanRequest',
    groundingContext: {
      schemaVersion: '2.0',
      recordType: 'GroundingContext',
      datasetKind: fixture.datasetKind,
      traceId: fixture.traceId,
      contextId: fixture.contextId,
      candidateId: fixture.candidateId,
      evidence: [{
        reference: {
          reportRevisionId,
          permittedTextHash,
          spanStart: 0,
          spanEnd: Array.from(permittedText).length,
          offsetUnit: 'unicode_code_points',
          relation: 'context',
        },
        text: permittedText,
        sourceId: `source-l3-${suffix}`,
        revisionStatus: 'unreviewed',
        publishedAt: null,
        observedAt: null,
        retrievedAt: TEST_TIME,
        origins: [],
      }],
      revisionStates: [{ reportRevisionId, revisionStatus: 'unreviewed' }],
      candidateEvents: [],
      priorDecisionIds: [],
      missingFields: ['synthetic_status'],
      conflicts: ['synthetic_sources_disagree'],
      retrievalVersion: 'retrieval-synthetic-l3-pglite-v1',
      indexVersion: 'index-synthetic-l3-pglite-v1',
      sufficient: false,
    },
    questions: ['missing_field_1', 'conflict_1'],
    actionMenu: [
      { name: 'synthetic_search', description: 'Search one synthetic source index.' },
      { name: 'gazetteer_lookup', description: 'Look up one synthetic place.' },
    ],
  };
}

async function assertPlanningReservationStarted(input: {
  readonly testDatabase: TestDatabase;
  readonly repository: ReturnType<typeof createSqlInvestigationLedgerRepository>;
  readonly fixture: FixtureContext;
  readonly investigationId: string;
  readonly reservationId: string;
  readonly reservedActiveSeconds: number;
  readonly reservedModelTokens: number;
}): Promise<void> {
  const reservation = await readStoredReservation(
    input.testDatabase,
    input.fixture.datasetKind,
    input.investigationId,
    input.reservationId,
  );
  assert.equal(reservation.reservation_status, 'started');
  assert.equal(reservation.outcome, null);
  assert.equal(reservation.reserved_reasoning_turns, 1);
  assert.equal(reservation.reserved_active_seconds, input.reservedActiveSeconds);
  assert.equal(reservation.reserved_model_tokens, input.reservedModelTokens);
  assert.equal(reservation.actual_active_seconds, 0);
  assert.equal(reservation.actual_model_tokens, 0);
  assert.ok(reservation.started_at);
  assert.equal(reservation.finished_at, null);
  assert.equal(reservation.reconciled_checkpoint_version, null);

  const checkpoint = await input.repository.getLatest(input.fixture.datasetKind, input.investigationId);
  assert.ok(checkpoint);
  assert.deepEqual(checkpoint.budget.consumed, zeroCounters());
  assert.deepEqual(checkpoint.budget.reserved, {
    tool_attempts: 0,
    reasoning_turns: 1,
    active_seconds: input.reservedActiveSeconds,
    model_tokens: input.reservedModelTokens,
  });
}

function makeReasoningPlannerDouble(input: {
  readonly request: InvestigationPlanRequest;
  readonly maxModelTokens: number;
  readonly outcome?: InvestigationPlannerOutcome;
  readonly error?: string;
  readonly onPropose?: () => void | Promise<void>;
}): {
  readonly planner: InvestigationPlanner;
  readonly preflightCalls: number;
  readonly proposeCalls: number;
} {
  let preflightCalls = 0;
  let proposeCalls = 0;
  const planner: InvestigationPlanner = {
    async preflight(rawRequest): Promise<InvestigationPlannerPreflightOutcome> {
      preflightCalls += 1;
      assert.deepEqual(rawRequest, input.request);
      const validated = await validateReasoningRequest({
        data: { groundingContext: input.request.groundingContext },
      });
      assert.deepEqual(validated.data.groundingContext, input.request.groundingContext);
      return {
        status: 'ready',
        capability: INVESTIGATION_PLAN_CAPABILITY,
        request: input.request,
      };
    },
    async propose(rawRequest, callOptions): Promise<InvestigationPlannerOutcome> {
      proposeCalls += 1;
      assert.deepEqual(rawRequest, input.request);
      assert.equal(callOptions.maxTotalTokens, input.maxModelTokens);
      await input.onPropose?.();
      if (input.error !== undefined) throw new Error(input.error);
      if (!input.outcome) throw new Error('synthetic test planner outcome missing');
      return input.outcome;
    },
  };
  return {
    planner,
    get preflightCalls() { return preflightCalls; },
    get proposeCalls() { return proposeCalls; },
  };
}

interface StoredReservationOutcome {
  readonly reservation_status: string;
  readonly outcome: string | null;
  readonly expected_checkpoint_version: number;
  readonly reserved_reasoning_turns: number;
  readonly reserved_active_seconds: number;
  readonly reserved_model_tokens: number;
  readonly actual_active_seconds: number;
  readonly actual_model_tokens: number;
  readonly started_at: string | null;
  readonly finished_at: string | null;
  readonly reconciled_checkpoint_version: number | null;
}

async function readStoredReservation(
  testDatabase: TestDatabase,
  datasetKind: DatasetKind,
  investigationId: string,
  reservationId: string,
): Promise<StoredReservationOutcome> {
  const result = await testDatabase.executor.query<StoredReservationOutcome>(
    `SELECT reservation_status, outcome, expected_checkpoint_version,
            reserved_reasoning_turns, reserved_active_seconds, reserved_model_tokens,
            actual_active_seconds, actual_model_tokens, started_at, finished_at,
            reconciled_checkpoint_version
     FROM waspada.investigation_action_reservations
     WHERE dataset_kind = $1 AND investigation_id = $2 AND reservation_id = $3`,
    [datasetKind, investigationId, reservationId],
  );
  assert.equal(result.rows.length, 1, 'expected one persisted reservation row');
  return result.rows[0]!;
}

async function readLedgerJson(
  testDatabase: TestDatabase,
  datasetKind: DatasetKind,
  investigationId: string,
): Promise<string> {
  const result = await testDatabase.executor.query<{ readonly ledger_json: string }>(
    `SELECT request.record_json::text || checkpoint.record_json::text AS ledger_json
     FROM waspada.investigation_requests AS request
     INNER JOIN waspada.investigation_checkpoints AS checkpoint
       ON checkpoint.dataset_kind = request.dataset_kind
      AND checkpoint.investigation_id = request.investigation_id
     WHERE request.dataset_kind = $1 AND request.investigation_id = $2
     ORDER BY checkpoint.checkpoint_version DESC
     LIMIT 1`,
    [datasetKind, investigationId],
  );
  assert.equal(result.rows.length, 1, 'expected the persisted request and latest checkpoint');
  return result.rows[0]!.ledger_json;
}

function makeCreateInput(fixture: FixtureContext, overrides: Partial<CreateInvestigationInput> = {}): CreateInvestigationInput {
  return {
    datasetKind: fixture.datasetKind,
    investigationId: `investigation-${fixture.candidateId}`,
    traceId: fixture.traceId,
    candidateId: fixture.candidateId,
    contextId: fixture.contextId,
    fingerprintKeyId: TEST_FINGERPRINT_KEY_ID,
    initialGroundingDigestHex: testDigest('initial-grounding'),
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

const TEST_FINGERPRINT_KEY_ID = 'fixture-hmac-v1';

function testDigest(value: string): string {
  return createHash('sha256').update('fixture-digest:' + value, 'utf8').digest('hex');
}

function testFingerprint(value: string): { readonly keyId: string; readonly digestHex: string } {
  return { keyId: TEST_FINGERPRINT_KEY_ID, digestHex: testDigest(value) };
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

async function assertLedgerError(code: InvestigationLedgerError['code'], work: Promise<unknown>): Promise<void> {
  await assert.rejects(work, (error: unknown) => error instanceof InvestigationLedgerError && error.code === code);
}
