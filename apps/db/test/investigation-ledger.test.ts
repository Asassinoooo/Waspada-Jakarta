import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { applyMigrations, readMigrations } from '../src/migrations.js';
import {
  createSqlInvestigationLedgerRepository,
  InvestigationLedgerError,
  type CreateInvestigationInput,
} from '../src/investigation-ledger.js';
import {
  createSqlExactEvidenceReferenceReader,
  createSqlExactEvidenceSpanReader,
  type ExactEvidenceReferenceReadRequest,
  type ExactEvidenceSpanRequest,
} from '../src/evidence-retrieval.js';
import {
  createSqlGroundingContextRepository,
  type GroundingContextRecord,
} from '../src/grounding-contexts.js';
import { createSqlGeometryWriter } from '../src/geometry-writer.js';
import { createRepositoryPorts, type DatasetKind } from '../src/ports.js';
import {
  INVESTIGATION_PLAN_CAPABILITY,
  createInvestigationPlanner,
  type InvestigationPlanRequest,
  type InvestigationPlanner,
  type InvestigationPlanProvider,
  type InvestigationPlannerOutcome,
  type InvestigationPlannerPreflightOutcome,
} from '../../worker/src/layers/l2-model-grounding/investigation-planner.js';
import { createDirectReasoningService } from '../../worker/src/layers/l2-model-grounding/direct-reasoning.js';
import { createReasoningContextPersister } from '../../worker/src/layers/l2-model-grounding/context-persistence.js';
import {
  createGroundingContextResumer,
  GroundingContextResumptionError,
} from '../../worker/src/layers/l2-model-grounding/context-resumption.js';
import { createReasoningProposalBridge } from '../../worker/src/layers/l2-model-grounding/reasoning-proposal-bridge.js';
import { assembleGroundingReasoningRequest } from '../../worker/src/layers/l2-model-grounding/grounding-context.js';
import {
  InMemorySyntheticFixtureCatalog,
  type FixturePipelinePorts,
  type SyntheticFixture,
  type SyntheticReportManifest,
} from '../../worker/src/layers/l1-data-knowledge/synthetic-fixture-pipeline.js';
import { runSyntheticFixtureJob } from '../../worker/src/layers/l1-data-knowledge/synthetic-fixture-runner.js';
import { createModelCapabilityAdapter } from '../../worker/src/layers/l2-model-grounding/adapter.js';
import { preparePermittedText } from '../../worker/src/layers/l1-data-knowledge/text-preparation.js';
import type {
  CapabilityOutcome,
  ExtractionRequest,
  GroundingContext,
  ReasoningRequest,
  ReasoningResult,
  UntrustedModelProvider,
} from '../../worker/src/layers/l2-model-grounding/contracts.js';
import { validateReasoningRequest } from '../../worker/src/layers/l2-model-grounding/validation.js';
import { createL3FingerprintService } from '../../worker/src/layers/l3-investigation/progress-fingerprint.js';
import { createInvestigationCoordinator } from '../../worker/src/layers/l3-investigation/coordinator.js';
import { createInsufficientContextEntryService } from '../../worker/src/layers/l3-investigation/entry.js';
import {
  createReasoningStepExecutor,
  type ReasoningStepExecutor,
  type ReasoningStepExecutorClock,
  type ReasoningStepExecutorTimer,
} from '../../worker/src/layers/l3-investigation/reasoning-step-executor.js';
import {
  createSingleStepExecutor,
  type SingleStepExecutor,
} from '../../worker/src/layers/l3-investigation/single-step-executor.js';
import type { InvestigationActionMenuEntry } from '../../worker/src/layers/l2-model-grounding/investigation-planner.js';
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

  it('keeps an append-only review marker outside checkpoints and blocks progress and replayable work', async () => {
    const fixture = await seedFixture(testDatabase, 'advance-review-marker-only', { sufficient: false });
    const repository = createSqlInvestigationLedgerRepository(testDatabase.executor);
    const input = makeCreateInput(fixture);
    const initial = await repository.create(input);
    const markerInput = {
      datasetKind: fixture.datasetKind,
      investigationId: input.investigationId,
      observedCheckpointVersion: initial.checkpoint_version,
      stage: 'planning' as const,
      reason: 'invalid_action_timestamp' as const,
    };

    const marked = await repository.markAdvanceReviewPending(markerInput);
    assert.equal(marked.replayed, false);
    const duplicate = await repository.markAdvanceReviewPending(markerInput);
    assert.equal(duplicate.replayed, true);
    assert.deepEqual(duplicate.marker, marked.marker);
    assert.equal(await repository.getAdvanceReviewPending(fixture.datasetKind, input.investigationId)
      .then((value) => value?.reason), 'invalid_action_timestamp');
    await assert.rejects(testDatabase.executor.query(
      `UPDATE waspada.investigation_advance_review_pending
       SET reason = 'planner_replayed'
       WHERE dataset_kind = $1 AND investigation_id = $2`,
      [fixture.datasetKind, input.investigationId],
    ), /L3 advance review-pending markers are append-only/);
    await assert.rejects(testDatabase.executor.query(
      `DELETE FROM waspada.investigation_advance_review_pending
       WHERE dataset_kind = $1 AND investigation_id = $2`,
      [fixture.datasetKind, input.investigationId],
    ), /L3 advance review-pending markers are append-only/);
    await assertLedgerError('advance_review_pending_conflict', repository.markAdvanceReviewPending({
      ...markerInput,
      reason: 'planner_replayed',
    }));

    const mismatchFixture = await seedFixture(testDatabase, 'advance-review-marker-kind-api', { sufficient: false });
    const mismatchInput = makeCreateInput(mismatchFixture);
    const mismatchInitial = await repository.create(mismatchInput);
    const toolReservation = await repository.reserveAction({
      datasetKind: mismatchFixture.datasetKind,
      investigationId: mismatchInput.investigationId,
      reservationId: 'marker-kind-api-tool',
      expectedCheckpointVersion: mismatchInitial.checkpoint_version,
      actionKind: 'tool',
      actionFingerprint: testFingerprint('marker-kind-api-tool'),
      actionName: 'lookup.synthetic',
      reservedActiveSeconds: 2,
      reservedModelTokens: 0,
      reservedAt: '2026-09-25T10:01:00Z',
    });
    await assertLedgerError('advance_review_pending_conflict', repository.markAdvanceReviewPending({
      datasetKind: mismatchFixture.datasetKind,
      investigationId: mismatchInput.investigationId,
      observedCheckpointVersion: toolReservation.checkpoint.checkpoint_version,
      stage: 'planning',
      reason: 'planner_result_uncertain',
      reservationId: 'marker-kind-api-tool',
    }));
    const releasedTool = await repository.releaseUninvoked({
      datasetKind: mismatchFixture.datasetKind,
      investigationId: mismatchInput.investigationId,
      reservationId: 'marker-kind-api-tool',
      expectedCheckpointVersion: toolReservation.checkpoint.checkpoint_version,
      releasedAt: '2026-09-25T10:01:01Z',
    });
    const reasoningForToolStage = await repository.reserveAction({
      datasetKind: mismatchFixture.datasetKind,
      investigationId: mismatchInput.investigationId,
      reservationId: 'marker-kind-api-reasoning',
      expectedCheckpointVersion: releasedTool.checkpoint.checkpoint_version,
      actionKind: 'reasoning',
      actionName: 'l2_investigation_planning',
      reservedActiveSeconds: 2,
      reservedModelTokens: 5,
      reservedAt: '2026-09-25T10:01:01Z',
    });
    await assertLedgerError('advance_review_pending_conflict', repository.markAdvanceReviewPending({
      datasetKind: mismatchFixture.datasetKind,
      investigationId: mismatchInput.investigationId,
      observedCheckpointVersion: reasoningForToolStage.checkpoint.checkpoint_version,
      stage: 'progress',
      reason: 'progress_uncertain',
      reservationId: 'marker-kind-api-reasoning',
    }));
    assert.equal(await repository.getAdvanceReviewPending(mismatchFixture.datasetKind, mismatchInput.investigationId), null,
      'the repository rejects either stage/reservation kind mismatch');

    const directFixture = await seedFixture(testDatabase, 'advance-review-marker-kind-sql-reasoning', { sufficient: false });
    const directInput = makeCreateInput(directFixture);
    const directInitial = await repository.create(directInput);
    const reasoningReservation = await repository.reserveAction({
      datasetKind: directFixture.datasetKind,
      investigationId: directInput.investigationId,
      reservationId: 'marker-kind-sql-reasoning',
      expectedCheckpointVersion: directInitial.checkpoint_version,
      actionKind: 'reasoning',
      actionName: 'l2_investigation_planning',
      reservedActiveSeconds: 3,
      reservedModelTokens: 10,
      reservedAt: '2026-09-25T10:02:00Z',
    });
    const directToolFixture = await seedFixture(testDatabase, 'advance-review-marker-kind-sql-tool', { sufficient: false });
    const directToolInput = makeCreateInput(directToolFixture);
    const directToolInitial = await repository.create(directToolInput);
    const toolReservationForSql = await repository.reserveAction({
      datasetKind: directToolFixture.datasetKind,
      investigationId: directToolInput.investigationId,
      reservationId: 'marker-kind-sql-tool',
      expectedCheckpointVersion: directToolInitial.checkpoint_version,
      actionKind: 'tool',
      actionFingerprint: testFingerprint('marker-kind-sql-tool'),
      actionName: 'lookup.synthetic',
      reservedActiveSeconds: 2,
      reservedModelTokens: 0,
      reservedAt: '2026-09-25T10:02:01Z',
    });
    const releasedFixture = await seedFixture(testDatabase, 'advance-review-marker-sql-released', { sufficient: false });
    const releasedInput = makeCreateInput(releasedFixture);
    const releasedInitial = await repository.create(releasedInput);
    const releasedReservation = await repository.reserveAction({
      datasetKind: releasedFixture.datasetKind,
      investigationId: releasedInput.investigationId,
      reservationId: 'marker-kind-sql-released',
      expectedCheckpointVersion: releasedInitial.checkpoint_version,
      actionKind: 'tool',
      actionFingerprint: testFingerprint('marker-kind-sql-released'),
      actionName: 'lookup.synthetic',
      reservedActiveSeconds: 2,
      reservedModelTokens: 0,
      reservedAt: '2026-09-25T10:02:02Z',
    });
    const released = await repository.releaseUninvoked({
      datasetKind: releasedFixture.datasetKind,
      investigationId: releasedInput.investigationId,
      reservationId: 'marker-kind-sql-released',
      expectedCheckpointVersion: releasedReservation.checkpoint.checkpoint_version,
      releasedAt: '2026-09-25T10:02:03Z',
    });
    assert.equal((await repository.getActionReservation(
      releasedFixture.datasetKind, releasedInput.investigationId, 'marker-kind-sql-released',
    ))?.status, 'released');
    await testDatabase.executor.execute('SET ROLE waspada_l3_coordinator');
    try {
      await assert.rejects(testDatabase.executor.query(
        `INSERT INTO waspada.investigation_advance_review_pending
           (dataset_kind, investigation_id, observed_checkpoint_version, stage, reason, reservation_id)
         VALUES ($1, $2, $3, 'planning', 'planner_result_uncertain', $4)`,
        [directToolFixture.datasetKind, directToolInput.investigationId,
          toolReservationForSql.checkpoint.checkpoint_version, 'marker-kind-sql-tool'],
      ), /stage does not match reservation kind/i,
      'the trigger rejects a coordinator-role planning marker bound to a tool');
      await assert.rejects(testDatabase.executor.query(
        `INSERT INTO waspada.investigation_advance_review_pending
           (dataset_kind, investigation_id, observed_checkpoint_version, stage, reason, reservation_id)
         VALUES ($1, $2, $3, 'progress', 'progress_uncertain', $4)`,
        [directFixture.datasetKind, directInput.investigationId,
          reasoningReservation.checkpoint.checkpoint_version, 'marker-kind-sql-reasoning'],
      ), /stage does not match reservation kind/i,
      'the trigger rejects a coordinator-role progress marker bound to reasoning');
      await assert.rejects(testDatabase.executor.query(
        `INSERT INTO waspada.investigation_advance_review_pending
           (dataset_kind, investigation_id, observed_checkpoint_version, stage, reason, reservation_id)
         VALUES ($1, $2, $3, 'action', 'action_result_uncertain', $4)`,
        [releasedFixture.datasetKind, releasedInput.investigationId,
          released.checkpoint.checkpoint_version, 'marker-kind-sql-released'],
      ), /reservation is released/i,
      'the coordinator-role trigger rejects a marker bound to a released reservation');
      await testDatabase.executor.query(
        `INSERT INTO waspada.investigation_advance_review_pending
           (dataset_kind, investigation_id, observed_checkpoint_version, stage, reason, reservation_id)
         VALUES ($1, $2, $3, 'planning', 'planner_result_uncertain', $4)`,
        [directFixture.datasetKind, directInput.investigationId,
          reasoningReservation.checkpoint.checkpoint_version, 'marker-kind-sql-reasoning'],
      );
    } finally {
      await testDatabase.executor.execute('RESET ROLE');
    }
    assert.equal((await repository.getAdvanceReviewPending(directFixture.datasetKind,
      directInput.investigationId))?.stage, 'planning',
    'the coordinator-role trigger accepts the exact reasoning/planning pairing');
    assert.equal(await repository.getAdvanceReviewPending(releasedFixture.datasetKind, releasedInput.investigationId), null,
      'the coordinator-role trigger does not create a marker for a released reservation');

    const missingReservationFixture = await seedFixture(
      testDatabase, 'advance-review-marker-missing-reservation', { sufficient: false },
    );
    const missingReservationInput = makeCreateInput(missingReservationFixture);
    await repository.create(missingReservationInput);
    await assert.rejects(testDatabase.executor.query(
      `INSERT INTO waspada.investigation_advance_review_pending
         (dataset_kind, investigation_id, observed_checkpoint_version, stage, reason, reservation_id)
       VALUES ($1, $2, 1, 'action', 'action_result_uncertain', 'marker-does-not-exist')`,
      [missingReservationFixture.datasetKind, missingReservationInput.investigationId],
    ), /reservation does not exist/i,
    'the database enforces reservation lineage when a marker names a reservation');

    await assertLedgerError('advance_review_pending', repository.reserveAction({
      datasetKind: fixture.datasetKind,
      investigationId: input.investigationId,
      reservationId: 'marker-only-reserve',
      expectedCheckpointVersion: initial.checkpoint_version,
      actionKind: 'tool',
      actionFingerprint: testFingerprint('marker-only-action'),
      actionName: 'lookup.synthetic',
      reservedActiveSeconds: 5,
      reservedModelTokens: 0,
      reservedAt: '2026-09-25T10:01:00Z',
    }));
    await assertLedgerError('advance_review_pending', repository.refreshGroundingProgress({
      datasetKind: fixture.datasetKind,
      investigationId: input.investigationId,
      expectedCheckpointVersion: initial.checkpoint_version,
      contextId: fixture.contextId,
      fingerprintKeyId: TEST_FINGERPRINT_KEY_ID,
      digestHex: input.initialGroundingDigestHex,
      refreshedAt: '2026-09-25T10:01:00Z',
    }));
    await assertLedgerError('advance_review_pending', repository.pause({
      datasetKind: fixture.datasetKind,
      investigationId: input.investigationId,
      expectedCheckpointVersion: initial.checkpoint_version,
      pausedAt: '2026-09-25T10:01:00Z',
    }));
    await assertLedgerError('advance_review_pending', repository.resume({
      datasetKind: fixture.datasetKind,
      investigationId: input.investigationId,
      expectedCheckpointVersion: initial.checkpoint_version,
      resumedAt: '2026-09-25T10:01:00Z',
    }));
    await assertLedgerError('advance_review_pending', repository.terminate({
      datasetKind: fixture.datasetKind,
      investigationId: input.investigationId,
      expectedCheckpointVersion: initial.checkpoint_version,
      status: 'stopped_for_review',
      stopReason: 'awaiting_moderator',
      completedAt: '2026-09-25T10:01:00Z',
    }));
    assert.deepEqual(await repository.getLatest(fixture.datasetKind, input.investigationId), initial,
      'marker insertion and blocked operations do not append a checkpoint or change its budget');
  });

  it('rejects an anonymous marker while a started action needs exact reconciliation', async () => {
    const fixture = await seedFixture(testDatabase, 'advance-review-anonymous-started', { sufficient: false });
    const repository = createSqlInvestigationLedgerRepository(testDatabase.executor);
    const input = makeCreateInput(fixture);
    const initial = await repository.create(input);
    const reservation = await repository.reserveAction({
      datasetKind: fixture.datasetKind,
      investigationId: input.investigationId,
      reservationId: 'anonymous-marker-started-tool',
      expectedCheckpointVersion: initial.checkpoint_version,
      actionKind: 'tool',
      actionFingerprint: testFingerprint('anonymous-marker-started-tool'),
      actionName: 'lookup.synthetic',
      reservedActiveSeconds: 5,
      reservedModelTokens: 0,
      reservedAt: '2026-09-25T10:01:00Z',
    });
    const started = await repository.startAction({
      datasetKind: fixture.datasetKind,
      investigationId: input.investigationId,
      reservationId: 'anonymous-marker-started-tool',
      startedAt: '2026-09-25T10:01:01Z',
    });
    assert.equal(started.mayInvoke, true);

    await testDatabase.executor.execute('SET ROLE waspada_l3_coordinator');
    try {
      await assert.rejects(testDatabase.executor.query(
        `INSERT INTO waspada.investigation_advance_review_pending
           (dataset_kind, investigation_id, observed_checkpoint_version, stage, reason, reservation_id)
         VALUES ($1, $2, $3, 'action', 'action_result_uncertain', NULL)`,
        [fixture.datasetKind, input.investigationId, reservation.checkpoint.checkpoint_version],
      ), /must identify the exact started reservation/i,
      'the coordinator-role trigger rejects a reservation-less marker for a started action');
      await assertLedgerError('advance_review_pending_conflict', repository.markAdvanceReviewPending({
        datasetKind: fixture.datasetKind,
        investigationId: input.investigationId,
        observedCheckpointVersion: reservation.checkpoint.checkpoint_version,
        stage: 'action',
        reason: 'action_result_uncertain',
      }), 'the repository returns a stable conflict for the same anonymous marker');
      assert.equal(await repository.getAdvanceReviewPending(fixture.datasetKind, input.investigationId), null);
    } finally {
      await testDatabase.executor.execute('RESET ROLE');
    }

    const reconciled = await repository.reconcileAction({
      datasetKind: fixture.datasetKind,
      investigationId: input.investigationId,
      reservationId: 'anonymous-marker-started-tool',
      expectedCheckpointVersion: reservation.checkpoint.checkpoint_version,
      outcome: 'succeeded',
      actualActiveSeconds: 2,
      actualModelTokens: 0,
      finishedAt: '2026-09-25T10:01:03Z',
    });
    assert.equal(reconciled.replayed, false);
    assert.equal(reconciled.checkpoint.checkpoint_version, reservation.checkpoint.checkpoint_version + 1);
    assert.equal((await repository.getActionReservation(
      fixture.datasetKind, input.investigationId, 'anonymous-marker-started-tool',
    ))?.status, 'reconciled');
    assert.equal(await repository.getAdvanceReviewPending(fixture.datasetKind, input.investigationId), null,
      'a rejected anonymous marker leaves the exact started reservation reconcilable');
  });

  it('requires a marker to name the exact started reservation when an older one is reconciled', async () => {
    const fixture = await seedFixture(testDatabase, 'advance-review-marker-exact-started-id', { sufficient: false });
    const repository = createSqlInvestigationLedgerRepository(testDatabase.executor);
    const input = makeCreateInput(fixture);
    const initial = await repository.create(input);
    const priorReservationId = 'marker-exact-prior-reconciled';
    const priorReservation = await repository.reserveAction({
      datasetKind: fixture.datasetKind,
      investigationId: input.investigationId,
      reservationId: priorReservationId,
      expectedCheckpointVersion: initial.checkpoint_version,
      actionKind: 'tool',
      actionFingerprint: testFingerprint('marker-exact-prior-reconciled'),
      actionName: 'lookup.synthetic',
      reservedActiveSeconds: 5,
      reservedModelTokens: 0,
      reservedAt: '2026-09-25T10:01:00Z',
    });
    await repository.startAction({
      datasetKind: fixture.datasetKind,
      investigationId: input.investigationId,
      reservationId: priorReservationId,
      startedAt: '2026-09-25T10:01:01Z',
    });
    const priorReconciled = await repository.reconcileAction({
      datasetKind: fixture.datasetKind,
      investigationId: input.investigationId,
      reservationId: priorReservationId,
      expectedCheckpointVersion: priorReservation.checkpoint.checkpoint_version,
      outcome: 'succeeded',
      actualActiveSeconds: 1,
      actualModelTokens: 0,
      finishedAt: '2026-09-25T10:01:02Z',
    });
    const activeReservationId = 'marker-exact-active-started';
    const activeReservation = await repository.reserveAction({
      datasetKind: fixture.datasetKind,
      investigationId: input.investigationId,
      reservationId: activeReservationId,
      expectedCheckpointVersion: priorReconciled.checkpoint.checkpoint_version,
      actionKind: 'tool',
      actionFingerprint: testFingerprint('marker-exact-active-started'),
      actionName: 'lookup.synthetic',
      reservedActiveSeconds: 5,
      reservedModelTokens: 0,
      reservedAt: '2026-09-25T10:02:00Z',
    });
    const activeStart = await repository.startAction({
      datasetKind: fixture.datasetKind,
      investigationId: input.investigationId,
      reservationId: activeReservationId,
      startedAt: '2026-09-25T10:02:01Z',
    });
    assert.equal(activeStart.mayInvoke, true);

    await testDatabase.executor.execute('SET ROLE waspada_l3_coordinator');
    try {
      await assert.rejects(testDatabase.executor.query(
        `INSERT INTO waspada.investigation_advance_review_pending
           (dataset_kind, investigation_id, observed_checkpoint_version, stage, reason, reservation_id)
         VALUES ($1, $2, $3, 'action', 'action_result_uncertain', $4)`,
        [fixture.datasetKind, input.investigationId,
          activeReservation.checkpoint.checkpoint_version, priorReservationId],
      ), /must identify the exact started reservation/i,
      'the coordinator-role trigger rejects a marker naming a different reconciled reservation');
      await assertLedgerError('advance_review_pending_conflict', repository.markAdvanceReviewPending({
        datasetKind: fixture.datasetKind,
        investigationId: input.investigationId,
        observedCheckpointVersion: activeReservation.checkpoint.checkpoint_version,
        stage: 'action',
        reason: 'action_result_uncertain',
        reservationId: priorReservationId,
      }), 'the repository rejects a marker that does not identify the started reservation');
      assert.equal(await repository.getAdvanceReviewPending(fixture.datasetKind, input.investigationId), null);
    } finally {
      await testDatabase.executor.execute('RESET ROLE');
    }

    const reconciled = await repository.reconcileAction({
      datasetKind: fixture.datasetKind,
      investigationId: input.investigationId,
      reservationId: activeReservationId,
      expectedCheckpointVersion: activeReservation.checkpoint.checkpoint_version,
      outcome: 'succeeded',
      actualActiveSeconds: 2,
      actualModelTokens: 0,
      finishedAt: '2026-09-25T10:02:03Z',
    });
    assert.equal(reconciled.replayed, false);
    assert.equal(reconciled.checkpoint.checkpoint_version, activeReservation.checkpoint.checkpoint_version + 1);
    assert.equal((await repository.getActionReservation(
      fixture.datasetKind, input.investigationId, activeReservationId,
    ))?.status, 'reconciled');
    assert.equal(await repository.getAdvanceReviewPending(fixture.datasetKind, input.investigationId), null,
      'rejecting the wrong named marker leaves the exact active reservation reconcilable');
  });

  it('verifies local marker/start orderings and exact-started reconciliation', async () => {
    const repository = createSqlInvestigationLedgerRepository(testDatabase.executor);
    const reservedFirstFixture = await seedFixture(testDatabase, 'advance-review-reserve-first', { sufficient: false });
    const reservedFirstInput = makeCreateInput(reservedFirstFixture);
    const reservedFirst = await repository.create(reservedFirstInput);
    const reservedFirstAction = {
      datasetKind: reservedFirstFixture.datasetKind,
      investigationId: reservedFirstInput.investigationId,
      reservationId: 'marker-reserve-first-action',
      expectedCheckpointVersion: reservedFirst.checkpoint_version,
      actionKind: 'tool' as const,
      actionFingerprint: testFingerprint('marker-reserve-first'),
      actionName: 'lookup.synthetic',
      reservedActiveSeconds: 5,
      reservedModelTokens: 0,
      reservedAt: '2026-09-25T10:01:00Z',
    };
    const reserved = await repository.reserveAction(reservedFirstAction);
    await repository.markAdvanceReviewPending({
      datasetKind: reservedFirstFixture.datasetKind,
      investigationId: reservedFirstInput.investigationId,
      observedCheckpointVersion: reserved.checkpoint.checkpoint_version,
      stage: 'action',
      reason: 'action_result_uncertain',
      reservationId: reservedFirstAction.reservationId,
    });
    await assertLedgerError('advance_review_pending', repository.startAction({
      datasetKind: reservedFirstFixture.datasetKind,
      investigationId: reservedFirstInput.investigationId,
      reservationId: reservedFirstAction.reservationId,
      startedAt: '2026-09-25T10:01:01Z',
    }));
    await assertLedgerError('advance_review_pending', repository.reconcileAction({
      datasetKind: reservedFirstFixture.datasetKind,
      investigationId: reservedFirstInput.investigationId,
      reservationId: reservedFirstAction.reservationId,
      expectedCheckpointVersion: reserved.checkpoint.checkpoint_version,
      outcome: 'succeeded',
      actualActiveSeconds: 1,
      actualModelTokens: 0,
      finishedAt: '2026-09-25T10:01:01Z',
    }), 'a matching but still-reserved action cannot be reconciled through a marker');
    assert.equal((await repository.getActionReservation(
      reservedFirstFixture.datasetKind, reservedFirstInput.investigationId, reservedFirstAction.reservationId,
    ))?.status, 'reserved');
    const releasedAfterDeniedStart = await repository.releaseUninvoked({
      datasetKind: reservedFirstFixture.datasetKind,
      investigationId: reservedFirstInput.investigationId,
      reservationId: reservedFirstAction.reservationId,
      expectedCheckpointVersion: reserved.checkpoint.checkpoint_version,
      releasedAt: '2026-09-25T10:01:02Z',
    });
    assert.equal(releasedAfterDeniedStart.checkpoint.checkpoint_version,
      reserved.checkpoint.checkpoint_version + 1);
    assert.deepEqual(releasedAfterDeniedStart.checkpoint.budget.consumed, zeroCounters());
    assert.deepEqual(releasedAfterDeniedStart.checkpoint.budget.reserved, zeroCounters());
    assert.equal((await repository.getActionReservation(
      reservedFirstFixture.datasetKind, reservedFirstInput.investigationId, reservedFirstAction.reservationId,
    ))?.status, 'released');
    assert.ok(await repository.getAdvanceReviewPending(
      reservedFirstFixture.datasetKind, reservedFirstInput.investigationId),
    'refunding a proven uninvoked reservation does not clear the sticky marker');
    await assertLedgerError('advance_review_pending', repository.startAction({
      datasetKind: reservedFirstFixture.datasetKind,
      investigationId: reservedFirstInput.investigationId,
      reservationId: reservedFirstAction.reservationId,
      startedAt: '2026-09-25T10:01:03Z',
    }));
    await assertLedgerError('advance_review_pending', repository.releaseUninvoked({
      datasetKind: reservedFirstFixture.datasetKind,
      investigationId: reservedFirstInput.investigationId,
      reservationId: reservedFirstAction.reservationId,
      expectedCheckpointVersion: releasedAfterDeniedStart.checkpoint.checkpoint_version,
      releasedAt: '2026-09-25T10:01:02Z',
    }));

    const startedFirstFixture = await seedFixture(testDatabase, 'advance-review-start-first', { sufficient: false });
    const startedFirstInput = makeCreateInput(startedFirstFixture);
    const startedInitial = await repository.create(startedFirstInput);
    const startedFirstAction = {
      ...reservedFirstAction,
      datasetKind: startedFirstFixture.datasetKind,
      investigationId: startedFirstInput.investigationId,
      reservationId: 'marker-start-first-action',
      expectedCheckpointVersion: startedInitial.checkpoint_version,
      actionFingerprint: testFingerprint('marker-start-first'),
      reservedAt: '2026-09-25T10:02:00Z',
    };
    const startedReservation = await repository.reserveAction(startedFirstAction);
    const started = await repository.startAction({
      datasetKind: startedFirstFixture.datasetKind,
      investigationId: startedFirstInput.investigationId,
      reservationId: startedFirstAction.reservationId,
      startedAt: '2026-09-25T10:02:01Z',
    });
    assert.equal(started.mayInvoke, true);
    assert.equal(started.replayed, false);

    const marker = await repository.markAdvanceReviewPending({
      datasetKind: startedFirstFixture.datasetKind,
      investigationId: startedFirstInput.investigationId,
      observedCheckpointVersion: startedReservation.checkpoint.checkpoint_version,
      stage: 'action',
      reason: 'action_result_uncertain',
      reservationId: startedFirstAction.reservationId,
    });
    assert.equal(marker.replayed, false);
    assert.equal((await repository.getLatest(startedFirstFixture.datasetKind,
      startedFirstInput.investigationId))?.checkpoint_version, startedReservation.checkpoint.checkpoint_version);
    await assertLedgerError('invalid_state', repository.releaseUninvoked({
      datasetKind: startedFirstFixture.datasetKind,
      investigationId: startedFirstInput.investigationId,
      reservationId: startedFirstAction.reservationId,
      expectedCheckpointVersion: startedReservation.checkpoint.checkpoint_version,
      releasedAt: '2026-09-25T10:02:02Z',
    }));
    assert.equal((await repository.getActionReservation(
      startedFirstFixture.datasetKind, startedFirstInput.investigationId, startedFirstAction.reservationId,
    ))?.status, 'started', 'a pending marker never releases an already-started invocation');

    const reconciled = await repository.reconcileAction({
      datasetKind: startedFirstFixture.datasetKind,
      investigationId: startedFirstInput.investigationId,
      reservationId: startedFirstAction.reservationId,
      expectedCheckpointVersion: startedReservation.checkpoint.checkpoint_version,
      outcome: 'succeeded',
      actualActiveSeconds: 3,
      actualModelTokens: 0,
      finishedAt: '2026-09-25T10:02:02Z',
    });
    assert.equal(reconciled.replayed, false);
    assert.equal(reconciled.checkpoint.checkpoint_version, startedReservation.checkpoint.checkpoint_version + 1);
    assert.equal(reconciled.checkpoint.budget.consumed.tool_attempts, 1);
    assert.equal(reconciled.checkpoint.budget.reserved.tool_attempts, 0);
    assert.equal((await repository.getActionReservation(
      startedFirstFixture.datasetKind, startedFirstInput.investigationId, startedFirstAction.reservationId,
    ))?.status, 'reconciled');
    assert.ok(await repository.getAdvanceReviewPending(startedFirstFixture.datasetKind,
      startedFirstInput.investigationId));
    const reconciledReplay = await repository.reconcileAction({
      datasetKind: startedFirstFixture.datasetKind,
      investigationId: startedFirstInput.investigationId,
      reservationId: startedFirstAction.reservationId,
      expectedCheckpointVersion: startedReservation.checkpoint.checkpoint_version,
      outcome: 'succeeded',
      actualActiveSeconds: 3,
      actualModelTokens: 0,
      finishedAt: '2026-09-25T10:02:02Z',
    });
    assert.equal(reconciledReplay.replayed, true,
      'the marker permits only the same reservation identity to replay its exact reconciliation');
    await assertLedgerError('advance_review_pending', repository.reserveAction({
      ...startedFirstAction,
      reservationId: 'marker-start-first-next-action',
      expectedCheckpointVersion: reconciled.checkpoint.checkpoint_version,
      actionFingerprint: testFingerprint('marker-start-first-next'),
      reservedAt: '2026-09-25T10:02:03Z',
    }));
    await assertLedgerError('advance_review_pending', repository.reconcileInterrupted({
      datasetKind: startedFirstFixture.datasetKind,
      investigationId: startedFirstInput.investigationId,
      reservationId: startedFirstAction.reservationId,
      expectedCheckpointVersion: startedReservation.checkpoint.checkpoint_version,
      finishedAt: '2026-09-25T10:02:03Z',
    }));
  });

  it('limits marker-time reconciliation to its exact stage-matched reservation', async () => {
    const fixture = await seedFixture(testDatabase, 'advance-review-reconcile-identity', { sufficient: false });
    const repository = createSqlInvestigationLedgerRepository(testDatabase.executor);
    const input = makeCreateInput(fixture, {
      limits: { toolAttempts: 4, reasoningTurns: 2, activeSeconds: 40, modelTokens: 100 },
    });
    const initial = await repository.create(input);
    const priorTool = await repository.reserveAction({
      datasetKind: fixture.datasetKind,
      investigationId: input.investigationId,
      reservationId: 'marker-reconcile-prior-tool',
      expectedCheckpointVersion: initial.checkpoint_version,
      actionKind: 'tool',
      actionFingerprint: testFingerprint('marker-prior-tool'),
      actionName: 'lookup.prior',
      reservedActiveSeconds: 5,
      reservedModelTokens: 0,
      reservedAt: '2026-09-25T10:20:00Z',
    });
    await repository.startAction({
      datasetKind: fixture.datasetKind,
      investigationId: input.investigationId,
      reservationId: 'marker-reconcile-prior-tool',
      startedAt: '2026-09-25T10:20:01Z',
    });
    const priorReconciliationInput = {
      datasetKind: fixture.datasetKind,
      investigationId: input.investigationId,
      reservationId: 'marker-reconcile-prior-tool',
      expectedCheckpointVersion: priorTool.checkpoint.checkpoint_version,
      outcome: 'succeeded' as const,
      actualActiveSeconds: 2,
      actualModelTokens: 0,
      finishedAt: '2026-09-25T10:20:02Z',
    };
    const priorReconciliation = await repository.reconcileAction(priorReconciliationInput);
    const targetReasoning = await repository.reserveAction({
      datasetKind: fixture.datasetKind,
      investigationId: input.investigationId,
      reservationId: 'marker-reconcile-planner',
      expectedCheckpointVersion: priorReconciliation.checkpoint.checkpoint_version,
      actionKind: 'reasoning',
      actionName: 'l2_investigation_planning',
      reservedActiveSeconds: 10,
      reservedModelTokens: 20,
      reservedAt: '2026-09-25T10:21:00Z',
    });
    await repository.startAction({
      datasetKind: fixture.datasetKind,
      investigationId: input.investigationId,
      reservationId: 'marker-reconcile-planner',
      startedAt: '2026-09-25T10:21:01Z',
    });
    await repository.markAdvanceReviewPending({
      datasetKind: fixture.datasetKind,
      investigationId: input.investigationId,
      observedCheckpointVersion: targetReasoning.checkpoint.checkpoint_version,
      stage: 'planning',
      reason: 'planner_result_uncertain',
      reservationId: 'marker-reconcile-planner',
    });

    await assertLedgerError('advance_review_pending', repository.reconcileAction(priorReconciliationInput),
      'a prior unrelated reconciled tool cannot replay while the marker names a planner reservation');
    const plannerReconciliationInput = {
      datasetKind: fixture.datasetKind,
      investigationId: input.investigationId,
      reservationId: 'marker-reconcile-planner',
      expectedCheckpointVersion: targetReasoning.checkpoint.checkpoint_version,
      outcome: 'failed' as const,
      actualActiveSeconds: 10,
      actualModelTokens: 0,
      finishedAt: '2026-09-25T10:21:11Z',
    };
    const plannerReconciled = await repository.reconcileAction(plannerReconciliationInput);
    assert.equal(plannerReconciled.replayed, false,
      'a planning marker permits only the exact reasoning reservation that was already started');
    const plannerReplay = await repository.reconcileAction(plannerReconciliationInput);
    assert.equal(plannerReplay.replayed, true);
    assert.ok(await repository.getAdvanceReviewPending(fixture.datasetKind, input.investigationId));
  });

  it('blocks a restarted coordinator on the persisted review marker before ports or state writes', async () => {
    const suffix = 'advance-review-coordinator';
    const fixture = await seedFixture(testDatabase, suffix, { sufficient: false, seedContext: false });
    const contextRepository = createSqlGroundingContextRepository(testDatabase.executor);
    const repository = createSqlInvestigationLedgerRepository(testDatabase.executor);
    const withRole = async <Result>(role: string, work: () => Promise<Result>): Promise<Result> => {
      await testDatabase.executor.execute('SET ROLE ' + role);
      try {
        return await work();
      } finally {
        await testDatabase.executor.execute('RESET ROLE');
      }
    };
    const makeRecord = (contextId: string, sufficient: boolean): GroundingContextRecord => ({
      schema_version: '2.0',
      trace_id: fixture.traceId,
      record_type: 'GroundingContext',
      dataset_kind: fixture.datasetKind,
      context_id: contextId,
      candidate_id: fixture.candidateId,
      evidence: [],
      revision_states: [],
      candidate_events: [],
      prior_decision_ids: [],
      missing_fields: sufficient ? [] : ['synthetic_status'],
      conflicts: [],
      retrieval_version: 'retrieval-synthetic-review-marker-v1',
      index_version: 'index-synthetic-review-marker-v1',
      sufficient,
    });
    const contextFromRecord = (record: GroundingContextRecord): GroundingContext => ({
      schemaVersion: record.schema_version,
      recordType: record.record_type,
      datasetKind: record.dataset_kind,
      traceId: record.trace_id,
      contextId: record.context_id,
      candidateId: record.candidate_id,
      evidence: [],
      revisionStates: [],
      candidateEvents: [],
      priorDecisionIds: [],
      missingFields: [...record.missing_fields],
      conflicts: [...record.conflicts],
      retrievalVersion: record.retrieval_version,
      indexVersion: record.index_version,
      sufficient: record.sufficient,
    });
    const insufficientRecord = makeRecord(fixture.contextId, false);
    const sufficientRecord = makeRecord(fixture.contextId + '-sufficient', true);
    const loadedContexts = await withRole('waspada_l2_grounding_writer', async () => {
      await contextRepository.createOrVerify(insufficientRecord);
      await contextRepository.createOrVerify(sufficientRecord);
      return {
        insufficient: await contextRepository.findById(fixture.datasetKind, fixture.contextId),
        sufficient: await contextRepository.findById(fixture.datasetKind, sufficientRecord.context_id),
      };
    });
    const persistedInsufficient = loadedContexts.insufficient;
    const persistedSufficient = loadedContexts.sufficient;
    assert.deepEqual(persistedInsufficient, insufficientRecord);
    assert.deepEqual(persistedSufficient, sufficientRecord);
    assert.ok(persistedInsufficient);
    assert.ok(persistedSufficient);
    const insufficientContext = contextFromRecord(persistedInsufficient);
    const sufficientContext = contextFromRecord(persistedSufficient);

    const investigationInput = makeCreateInput(fixture);
    const reservationId = 'reservation-' + suffix + '-started';
    const durableSetup = await withRole('waspada_l3_coordinator', async () => {
      await repository.create(investigationInput);
      const reserved = await repository.reserveAction({
        datasetKind: fixture.datasetKind,
        investigationId: investigationInput.investigationId,
        reservationId,
        expectedCheckpointVersion: 1,
        actionKind: 'tool',
        actionFingerprint: testFingerprint('review-pending-coordinator-action'),
        actionName: 'lookup.synthetic',
        reservedActiveSeconds: 5,
        reservedModelTokens: 0,
        reservedAt: '2026-09-25T10:01:00Z',
      });
      const started = await repository.startAction({
        datasetKind: fixture.datasetKind,
        investigationId: investigationInput.investigationId,
        reservationId,
        startedAt: '2026-09-25T10:01:01Z',
      });
      assert.equal(started.mayInvoke, true);
      assert.equal(started.replayed, false);
      const marked = await repository.markAdvanceReviewPending({
        datasetKind: fixture.datasetKind,
        investigationId: investigationInput.investigationId,
        observedCheckpointVersion: reserved.checkpoint.checkpoint_version,
        stage: 'action',
        reason: 'action_result_uncertain',
        reservationId,
      });
      assert.equal(marked.replayed, false);
      const checkpoint = await repository.getLatest(fixture.datasetKind, investigationInput.investigationId);
      const reservation = await repository.getActionReservation(
        fixture.datasetKind,
        investigationInput.investigationId,
        reservationId,
      );
      const marker = await repository.getAdvanceReviewPending(fixture.datasetKind, investigationInput.investigationId);
      assert.ok(checkpoint);
      assert.ok(reservation);
      assert.ok(marker);
      assert.equal(reservation.status, 'started');
      assert.equal(marker.reservationId, reservationId);
      return { checkpoint, reservation, marker };
    });

    const readDurableState = () => withRole('waspada_l3_coordinator', async () => {
      const checkpoint = await repository.getLatest(fixture.datasetKind, investigationInput.investigationId);
      const reservation = await repository.getActionReservation(
        fixture.datasetKind,
        investigationInput.investigationId,
        reservationId,
      );
      const marker = await repository.getAdvanceReviewPending(fixture.datasetKind, investigationInput.investigationId);
      const progress = await testDatabase.executor.query<{
        readonly checkpoint_version: number;
        readonly context_id: string;
        readonly fingerprint_key_id: string;
        readonly digest_hex: string;
        readonly consecutive_no_progress: number;
      }>(
        'SELECT checkpoint_version, context_id, fingerprint_key_id, '
          + "encode(grounding_fingerprint, 'hex') AS digest_hex, consecutive_no_progress "
          + 'FROM waspada.investigation_progress_snapshots '
          + 'WHERE dataset_kind = $1 AND investigation_id = $2',
        [fixture.datasetKind, investigationInput.investigationId],
      );
      return {
        checkpoint,
        reservation,
        marker,
        progress: progress.rows,
        requestAndCheckpoint: await readLedgerJson(
          testDatabase,
          fixture.datasetKind,
          investigationInput.investigationId,
        ),
      };
    });
    const before = await readDurableState();
    assert.deepEqual(before.checkpoint, durableSetup.checkpoint);
    assert.deepEqual(before.reservation, durableSetup.reservation);
    assert.deepEqual(before.marker, durableSetup.marker);
    assert.equal(before.reservation?.status, 'started');

    const calls = { planner: 0, action: 0, refresh: 0 };
    const reasoningStep: ReasoningStepExecutor = {
      async plan() {
        calls.planner += 1;
        throw new Error('unexpected synthetic planner call');
      },
    };
    const singleStep: SingleStepExecutor = {
      async execute() {
        calls.action += 1;
        throw new Error('unexpected synthetic action call');
      },
    };
    const coordinator = createInvestigationCoordinator({
      entry: createInsufficientContextEntryService(repository, TEST_FINGERPRINTS),
      ledger: repository,
      fingerprints: TEST_FINGERPRINTS,
      reasoningStep,
      singleStep,
      refreshPort: {
        async refresh() {
          calls.refresh += 1;
          throw new Error('unexpected synthetic refresh call');
        },
      },
      actionMenu: [{ name: 'lookup.synthetic', description: 'Synthetic fixture action.' }],
      wallNow: () => '2026-09-25T10:02:00Z',
    });
    const resumeAdvance = {
      kind: 'resume',
      checkpoint: durableSetup.checkpoint,
      context: insufficientContext,
      persistedRecord: persistedInsufficient,
      reasoningReservationId: 'reservation-' + suffix + '-planner-replay',
      reasoningReservedAt: '2026-09-25T10:02:00Z',
      actionReservationId: 'reservation-' + suffix + '-action-replay',
    } as const;

    const first = await withRole('waspada_l3_coordinator', () => coordinator.advance(resumeAdvance));
    assert.equal(first.status, 'review_required');
    if (first.status !== 'review_required') assert.fail('expected a durable review-pending hold');
    assert.equal(first.reason, 'advance_review_pending');
    assert.deepEqual(first.checkpoint, durableSetup.checkpoint);
    assert.deepEqual(calls, { planner: 0, action: 0, refresh: 0 });

    const replay = await withRole('waspada_l3_coordinator', () => coordinator.advance(resumeAdvance));
    assert.deepEqual(replay, first, 'replaying the same advance returns the same closed hold');
    assert.deepEqual(calls, { planner: 0, action: 0, refresh: 0 });

    const sufficientOutcome = await withRole('waspada_l3_coordinator', () => coordinator.advance({
      kind: 'sufficient_context',
      investigationId: investigationInput.investigationId,
      context: sufficientContext,
      persistedRecord: persistedSufficient,
    }));
    assert.equal(sufficientOutcome.status, 'review_required');
    if (sufficientOutcome.status !== 'review_required') {
      assert.fail('sufficient context must not bypass a durable review-pending hold');
    }
    assert.equal(sufficientOutcome.reason, 'advance_review_pending');
    assert.deepEqual(sufficientOutcome.checkpoint, durableSetup.checkpoint);
    assert.deepEqual(calls, { planner: 0, action: 0, refresh: 0 });

    const after = await readDurableState();
    assert.deepEqual(after, before,
      'resume, replay, and sufficient-context paths leave checkpoint, budget, marker, reservation, and progress unchanged');
  });

  it('reconciles the exact started action under a marker, then holds before refresh and progress', async () => {
    const suffix = 'advance-review-action-reconcile';
    const fixture = await seedFixture(testDatabase, suffix, { sufficient: false, seedContext: false });
    const contextRepository = createSqlGroundingContextRepository(testDatabase.executor);
    const repository = createSqlInvestigationLedgerRepository(testDatabase.executor);
    const withRole = async <Result>(role: string, work: () => Promise<Result>): Promise<Result> => {
      await testDatabase.executor.execute('SET ROLE ' + role);
      try {
        return await work();
      } finally {
        await testDatabase.executor.execute('RESET ROLE');
      }
    };

    const persistedRecord: GroundingContextRecord = {
      schema_version: '2.0',
      trace_id: fixture.traceId,
      record_type: 'GroundingContext',
      dataset_kind: fixture.datasetKind,
      context_id: fixture.contextId,
      candidate_id: fixture.candidateId,
      evidence: [],
      revision_states: [],
      candidate_events: [],
      prior_decision_ids: [],
      missing_fields: ['synthetic_status'],
      conflicts: [],
      retrieval_version: 'retrieval-synthetic-action-reconcile-v1',
      index_version: 'index-synthetic-action-reconcile-v1',
      sufficient: false,
    };
    await withRole('waspada_l2_grounding_writer', () => contextRepository.createOrVerify(persistedRecord));
    const context: GroundingContext = {
      schemaVersion: persistedRecord.schema_version,
      recordType: persistedRecord.record_type,
      datasetKind: persistedRecord.dataset_kind,
      traceId: persistedRecord.trace_id,
      contextId: persistedRecord.context_id,
      candidateId: persistedRecord.candidate_id,
      evidence: [],
      revisionStates: [],
      candidateEvents: [],
      priorDecisionIds: [],
      missingFields: [...persistedRecord.missing_fields],
      conflicts: [],
      retrievalVersion: persistedRecord.retrieval_version,
      indexVersion: persistedRecord.index_version,
      sufficient: persistedRecord.sufficient,
    };
    const investigationInput = makeCreateInput(fixture);
    const initial = await withRole('waspada_l3_coordinator', () => repository.create(investigationInput));
    const actionReservationId = `reservation-${suffix}-action`;
    const outputReferenceId = `synthetic-output-${suffix}`;
    const actionMenu: readonly InvestigationActionMenuEntry[] = [
      { name: 'lookup.synthetic', description: 'Perform one synthetic lookup.' },
    ];

    let wallMilliseconds = Date.parse('2026-09-25T10:01:00.000Z');
    let monotonicMilliseconds = 0;
    const wallNow = (): string => new Date((wallMilliseconds += 1_000)).toISOString();
    const clock = {
      wallNow,
      monotonicNow: () => {
        const current = monotonicMilliseconds;
        monotonicMilliseconds += 100;
        return current;
      },
    };
    const timer = {
      setTimeout(_callback: () => void, _delayMs: number): unknown {
        return Symbol('synthetic-action-deadline');
      },
      clearTimeout(_handle: unknown): void {},
    };

    let plannerCalls = 0;
    let reasoningStepCalls = 0;
    let singleStepCalls = 0;
    let handlerCalls = 0;
    let refreshCalls = 0;
    let markerCheckpointVersion: number | null = null;
    const planner = createInvestigationPlanner({
      async plan(request) {
        plannerCalls += 1;
        assert.deepEqual(request.questions, ['missing_field_1']);
        return {
          result: {
            schemaVersion: '1.0',
            recordType: 'InvestigationPlanResult',
            outcome: 'proposed',
            actionName: 'lookup.synthetic',
            input: { query: 'synthetic action reconciliation' },
          },
          inputTokens: 2,
          outputTokens: 3,
        };
      },
    }, {
      modelVersion: '@synthetic/action-reconcile-planner-v1',
      promptVersion: 'synthetic/action-reconcile-prompt-v1',
    });
    const realReasoningStep = createReasoningStepExecutor({
      ledger: repository,
      fingerprints: TEST_FINGERPRINTS,
      planner,
      maxActiveSeconds: 10,
      maxModelTokens: 32,
      clock,
      timer,
    });
    const reasoningStep: ReasoningStepExecutor = {
      async plan(proposal) {
        reasoningStepCalls += 1;
        return realReasoningStep.plan(proposal);
      },
    };
    const realSingleStep = createSingleStepExecutor({
      ledger: repository,
      fingerprints: TEST_FINGERPRINTS,
      registry: [{
        name: 'lookup.synthetic',
        enabled: true,
        maxActiveSeconds: 5,
        parseInput: (input) => ({ ok: true, value: input }),
        async handler(input) {
          handlerCalls += 1;
          assert.deepEqual(input, { query: 'synthetic action reconciliation' });

          const startedReservation = await repository.getActionReservation(
            fixture.datasetKind,
            investigationInput.investigationId,
            actionReservationId,
          );
          const checkpointAtStart = await repository.getLatest(
            fixture.datasetKind,
            investigationInput.investigationId,
          );
          assert.ok(startedReservation);
          assert.ok(checkpointAtStart);
          assert.equal(startedReservation.status, 'started',
            'the real executor invokes this handler only after startAction grants it');
          assert.equal(startedReservation.expectedCheckpointVersion + 1, checkpointAtStart.checkpoint_version,
            'the action reservation checkpoint is durable before handler entry');

          markerCheckpointVersion = checkpointAtStart.checkpoint_version;
          const marker = await repository.markAdvanceReviewPending({
            datasetKind: fixture.datasetKind,
            investigationId: investigationInput.investigationId,
            observedCheckpointVersion: markerCheckpointVersion,
            stage: 'action',
            reason: 'action_result_uncertain',
            reservationId: actionReservationId,
          });
          assert.equal(marker.replayed, false);
          assert.equal(marker.marker.reservationId, actionReservationId);
          return { status: 'succeeded', outputReferenceIds: [outputReferenceId] };
        },
      }],
      clock,
      timer,
    });
    const singleStep: SingleStepExecutor = {
      async execute(proposal) {
        singleStepCalls += 1;
        return realSingleStep.execute(proposal);
      },
    };
    const coordinator = createInvestigationCoordinator({
      entry: createInsufficientContextEntryService(repository, TEST_FINGERPRINTS),
      ledger: repository,
      fingerprints: TEST_FINGERPRINTS,
      reasoningStep,
      singleStep,
      refreshPort: {
        async refresh() {
          refreshCalls += 1;
          assert.fail('a persisted marker must stop the advance before refresh');
        },
      },
      actionMenu,
      wallNow,
    });
    const advance = {
      kind: 'resume',
      checkpoint: initial,
      context,
      persistedRecord,
      reasoningReservationId: `reservation-${suffix}-planner`,
      reasoningReservedAt: '2026-09-25T10:00:11Z',
      actionReservationId,
    } as const;

    const readDurableState = () => withRole('waspada_l3_coordinator', async () => {
      const checkpoint = await repository.getLatest(fixture.datasetKind, investigationInput.investigationId);
      const reservation = await repository.getActionReservation(
        fixture.datasetKind,
        investigationInput.investigationId,
        actionReservationId,
      );
      const marker = await repository.getAdvanceReviewPending(fixture.datasetKind, investigationInput.investigationId);
      const progress = await testDatabase.executor.query<{
        readonly checkpoint_version: number;
        readonly context_id: string;
        readonly fingerprint_key_id: string;
        readonly digest_hex: string;
        readonly consecutive_no_progress: number;
      }>(
        'SELECT checkpoint_version, context_id, fingerprint_key_id, '
          + "encode(grounding_fingerprint, 'hex') AS digest_hex, consecutive_no_progress "
          + 'FROM waspada.investigation_progress_snapshots '
          + 'WHERE dataset_kind = $1 AND investigation_id = $2 ORDER BY checkpoint_version',
        [fixture.datasetKind, investigationInput.investigationId],
      );
      return {
        checkpoint,
        reservation,
        marker,
        progress: progress.rows,
        requestAndCheckpoint: await readLedgerJson(
          testDatabase,
          fixture.datasetKind,
          investigationInput.investigationId,
        ),
      };
    });
    const before = await readDurableState();
    assert.deepEqual(before.checkpoint, initial);
    assert.equal(before.reservation, null);
    assert.equal(before.marker, null);

    const first = await withRole('waspada_l3_coordinator', () => coordinator.advance(advance));
    assert.equal(first.status, 'review_required');
    if (first.status !== 'review_required') assert.fail('expected the sticky review-pending hold');
    assert.equal(first.reason, 'advance_review_pending');

    const afterFirst = await readDurableState();
    const reconciledCheckpoint = afterFirst.checkpoint;
    const reconciledReservation = afterFirst.reservation;
    const pendingMarker = afterFirst.marker;
    assert.ok(reconciledCheckpoint);
    assert.ok(reconciledReservation);
    assert.ok(pendingMarker);
    assert.deepEqual(first.checkpoint, reconciledCheckpoint);
    assert.equal(reconciledReservation.status, 'reconciled');
    assert.equal(reconciledReservation.outcome, 'succeeded');
    assert.equal(reconciledReservation.reconciledCheckpointVersion, reconciledCheckpoint.checkpoint_version);
    assert.equal(reconciledCheckpoint.checkpoint_version, reconciledReservation.expectedCheckpointVersion + 2);
    assert.equal(reconciledCheckpoint.budget.consumed.reasoning_turns, 1);
    assert.equal(reconciledCheckpoint.budget.consumed.tool_attempts, 1);
    assert.equal(reconciledCheckpoint.budget.consumed.model_tokens, 5);
    assert.deepEqual(reconciledCheckpoint.budget.reserved, zeroCounters());
    assert.equal(pendingMarker.stage, 'action');
    assert.equal(pendingMarker.reason, 'action_result_uncertain');
    assert.equal(pendingMarker.reservationId, actionReservationId);
    assert.equal(pendingMarker.observedCheckpointVersion, markerCheckpointVersion);
    assert.equal(markerCheckpointVersion, reconciledReservation.expectedCheckpointVersion + 1);
    assert.deepEqual(afterFirst.progress, before.progress,
      'the coordinator stops before persisting a grounding-progress snapshot');
    assert.equal(plannerCalls, 1);
    assert.equal(reasoningStepCalls, 1);
    assert.equal(singleStepCalls, 1);
    assert.equal(handlerCalls, 1);
    assert.equal(refreshCalls, 0);

    const replay = await withRole('waspada_l3_coordinator', () => coordinator.advance(advance));
    assert.deepEqual(replay, first, 'the same advance replays the durable hold and reconciled checkpoint');
    assert.deepEqual(await readDurableState(), afterFirst,
      'replay leaves the checkpoint, budget, reservation, marker, progress, and persisted JSON unchanged');
    assert.equal(plannerCalls, 1);
    assert.equal(reasoningStepCalls, 1);
    assert.equal(singleStepCalls, 1);
    assert.equal(handlerCalls, 1, 'the already-reconciled handler is never invoked a second time');
    assert.equal(refreshCalls, 0);
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

  it('enforces tool fingerprints on insert while allowing reasoning and legacy null fingerprints', async () => {
    const fixture = await seedFixture(testDatabase, 'fingerprint-insert-boundary', { sufficient: false });
    const repository = createSqlInvestigationLedgerRepository(testDatabase.executor);
    const input = makeCreateInput(fixture);
    await repository.create(input);

    const insertReservation = 'INSERT INTO waspada.investigation_action_reservations '
      + '(dataset_kind, reservation_id, investigation_id, action_kind, action_name, '
      + 'expected_checkpoint_version, reserved_tool_attempts, reserved_reasoning_turns, '
      + 'reserved_active_seconds, reserved_model_tokens, reservation_status, created_at) '
      + 'VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)';
    await assert.rejects(
      testDatabase.executor.query(insertReservation, [
        fixture.datasetKind, 'reservation-tool-without-fingerprint', input.investigationId,
        'tool', 'lookup.synthetic', 1, 1, 0, 1, 0, 'reserved', TEST_TIME,
      ]),
      /registered tool reservations require a keyed fingerprint/,
    );

    const reasoning = await testDatabase.executor.query<{
      action_kind: string;
      action_fingerprint_key_id: string | null;
      fingerprint_missing: boolean;
    }>(
      'INSERT INTO waspada.investigation_action_reservations '
        + '(dataset_kind, reservation_id, investigation_id, action_kind, action_name, '
        + 'expected_checkpoint_version, reserved_tool_attempts, reserved_reasoning_turns, '
        + 'reserved_active_seconds, reserved_model_tokens, reservation_status, created_at, '
        + 'action_fingerprint_key_id, action_fingerprint) '
        + 'VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NULL, NULL) '
        + 'RETURNING action_kind, action_fingerprint_key_id, '
        + 'action_fingerprint IS NULL AS fingerprint_missing',
      [
        fixture.datasetKind, 'reservation-reasoning-null-fingerprint', input.investigationId,
        'reasoning', 'reasoning.synthetic', 1, 0, 1, 1, 1, 'reserved', TEST_TIME,
      ],
    );
    assert.deepEqual(reasoning.rows, [{
      action_kind: 'reasoning',
      action_fingerprint_key_id: null,
      fingerprint_missing: true,
    }]);

    const legacyFixture = await seedFixture(testDatabase, 'legacy-null-fingerprint', { sufficient: false });
    const legacyInput = makeCreateInput(legacyFixture);
    await repository.create(legacyInput);
    await testDatabase.executor.query(
      'ALTER TABLE waspada.investigation_action_reservations DISABLE TRIGGER investigation_action_reservations_guard',
    );
    try {
      await testDatabase.executor.query(insertReservation, [
        legacyFixture.datasetKind, 'reservation-legacy-null-fingerprint', legacyInput.investigationId,
        'tool', 'lookup.legacy', 1, 1, 0, 1, 0, 'reserved', TEST_TIME,
      ]);
    } finally {
      await testDatabase.executor.query(
        'ALTER TABLE waspada.investigation_action_reservations ENABLE TRIGGER investigation_action_reservations_guard',
      );
    }

    const releasedLegacy = await testDatabase.executor.query<{
      reservation_status: string;
      fingerprint_missing: boolean;
      reconciled_checkpoint_version: number;
    }>(
      'UPDATE waspada.investigation_action_reservations '
        + "SET reservation_status = 'released', finished_at = $3::timestamptz, "
        + 'reconciled_checkpoint_version = 2 '
        + 'WHERE dataset_kind = $1 AND reservation_id = $2 '
        + 'RETURNING reservation_status, action_fingerprint IS NULL AS fingerprint_missing, '
        + 'reconciled_checkpoint_version',
      [legacyFixture.datasetKind, 'reservation-legacy-null-fingerprint', '2026-09-25T10:00:01Z'],
    );
    assert.deepEqual(releasedLegacy.rows, [{
      reservation_status: 'released',
      fingerprint_missing: true,
      reconciled_checkpoint_version: 2,
    }]);
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
    const refreshedAgain = await seedAdditionalContext(testDatabase, 'refresh-context-next-two', {
      datasetKind: fixture.datasetKind, candidateId: fixture.candidateId, sufficient: true,
    });
    const other = await seedFixture(testDatabase, 'refresh-other-candidate', { sufficient: false });
    const repository = createSqlInvestigationLedgerRepository(testDatabase.executor);
    const input = makeCreateInput(fixture);
    const initial = await repository.create(input);
    await assertLedgerError('invalid_state', repository.resume({
      datasetKind: fixture.datasetKind,
      investigationId: input.investigationId,
      expectedCheckpointVersion: initial.checkpoint_version,
      resumedAt: '2026-09-25T10:01:00Z',
      contextId: refreshed.contextId,
      progressFingerprint: testFingerprint('resume-open-case'),
    }));
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
    const resumeInput = {
      datasetKind: fixture.datasetKind,
      investigationId: input.investigationId,
      expectedCheckpointVersion: paused.checkpoint.checkpoint_version,
      resumedAt: '2026-09-25T10:03:00Z',
      contextId: refreshed.contextId,
      progressFingerprint: testFingerprint('refreshed-grounding'),
    };
    const resumed = await repository.resume(resumeInput);
    const resumeReplay = await repository.resume(resumeInput);
    assert.equal(resumeReplay.replayed, true);
    assert.equal(resumeReplay.checkpoint.checkpoint_version, resumed.checkpoint.checkpoint_version);
    await assertLedgerError('invalid_state', repository.resume({
      datasetKind: fixture.datasetKind,
      investigationId: input.investigationId,
      expectedCheckpointVersion: resumed.checkpoint.checkpoint_version,
      resumedAt: '2026-09-25T10:03:30Z',
      contextId: refreshedAgain.contextId,
      progressFingerprint: testFingerprint('new-context-while-open'),
    }));
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

  it('composes one bounded synthetic investigation through exact-context private proposal persistence and replay', async () => {
    const roundtrip = await seedRoundtripFixture(testDatabase);
    const { fixture, sourceId, reportRevisionId, originId, evidenceReferenceId, selectedStart, selectedEnd, selectedSpan,
      authoredText, eventTime, publishedAt, observedAt, retrievedAt, queued, extractorCalls } = roundtrip;
    const contextPersister = createReasoningContextPersister(
      roundtrip.ports.groundingContexts,
    );
    let reasoningCalls = 0;
    const reasoningRequestAtCall: { value: ReasoningRequest | null } = { value: null };
    const directReasoning = createDirectReasoningService(contextPersister, {
      async reason(request: ReasoningRequest): Promise<CapabilityOutcome<ReasoningResult, 'reasoning'>> {
        reasoningCalls += 1;
        reasoningRequestAtCall.value = request;
        assert.equal(request.data.groundingContext.sufficient, true,
          'only the explicitly controlled refreshed fixture may reach reasoning');
        const persisted = await testDatabase.executor.query<{
          context_id: string;
          sufficient: boolean;
          record_json: string;
        }>(
          'SELECT context_id, sufficient, record_json::text AS record_json '
            + 'FROM waspada.grounding_contexts WHERE dataset_kind = $1 AND context_id = $2',
          [fixture.datasetKind, refreshedContextId],
        );
        assert.equal(persisted.rows.length, 1, 'the refreshed refs-only context is committed before reasoning');
        assert.equal(persisted.rows[0]?.sufficient, true);
        assert.equal(persisted.rows[0]?.record_json.includes(selectedSpan), false);
        assert.equal(Object.hasOwn(JSON.parse(persisted.rows[0]!.record_json).evidence[0], 'text'), false);
        const refreshed = refreshPersistence.value;
        assert.ok(refreshed);
        assert.deepEqual(JSON.parse(persisted.rows[0]!.record_json), refreshed.persistedRecord);
        assert.deepEqual(request, refreshed.reasoningRequest,
          'the reasoner receives the exact request persisted by the L2 refresh');
        const support = request.data.groundingContext.evidence[0];
        assert.ok(support);
        assert.equal(support.text, selectedSpan, 'only the exact persisted source span is rehydrated in memory');
        return {
          status: 'succeeded',
          capability: 'reasoning',
          value: fixedCoordinatorReasoningResult(request.data.groundingContext, eventTime),
        };
      },
    });
    const initialContextId = fixture.contextId;
    const refreshedContextId = 'context-l3-coordinator-roundtrip-refreshed';
    const refreshedMissingFields = [] as const;
    const directOutcome = await directReasoning.reason(makeCoordinatorReasoningRequest(
      fixture,
      initialContextId,
      ['synthetic_status'],
    ));
    assert.equal(directOutcome.status, 'investigation_required');
    if (directOutcome.status !== 'investigation_required') {
      assert.fail('expected the persisted insufficient-context handoff');
    }
    assert.equal(directOutcome.persistedRecord.sufficient, false);
    assert.equal(directOutcome.persistedRecord.context_id, initialContextId);
    assert.equal(reasoningCalls, 0, 'initial insufficiency must stop before the reasoning capability');
    const initialStoredContext = await testDatabase.executor.query<{ context_id: string; record_json: string }>(
      'SELECT context_id, record_json::text AS record_json FROM waspada.grounding_contexts '
        + 'WHERE dataset_kind = $1 AND context_id = $2',
      [fixture.datasetKind, initialContextId],
    );
    assert.equal(initialStoredContext.rows.length, 1, 'the initial insufficient context is persisted before L3');
    assert.deepEqual(JSON.parse(initialStoredContext.rows[0]!.record_json), directOutcome.persistedRecord);
    assert.equal(initialStoredContext.rows[0]!.record_json.includes(selectedSpan), false);
    assert.deepEqual(JSON.parse(initialStoredContext.rows[0]!.record_json).evidence, []);

    const protectedWriteCounts = async () => {
      const result = await testDatabase.executor.query<{
        event_versions: string;
        publication_decisions: string;
        publication_outbox: string;
        audit_records: string;
        moderator_reviews: string;
      }>(
        'SELECT '
          + '(SELECT count(*)::text FROM waspada.event_versions) AS event_versions, '
          + '(SELECT count(*)::text FROM waspada.publication_decisions) AS publication_decisions, '
          + '(SELECT count(*)::text FROM waspada.publication_outbox) AS publication_outbox, '
          + '(SELECT count(*)::text FROM waspada.audit_records) AS audit_records, '
          + '(SELECT count(*)::text FROM waspada.public_event_history_review_decisions) AS moderator_reviews',
      );
      const row = result.rows[0];
      assert.ok(row);
      return row;
    };
    const protectedWritesBefore = await protectedWriteCounts();

    const repository = createSqlInvestigationLedgerRepository(testDatabase.executor);
    const entry = createInsufficientContextEntryService(repository, TEST_FINGERPRINTS);
    const modelTokens = 100;
    let monotonicMilliseconds = 0;
    const plannedActionTime = '2026-09-25T10:04:00Z';
    const wallTimes = [
      '2026-09-25T10:01:00Z',
      '2026-09-25T10:02:00Z',
      plannedActionTime,
      '2026-09-25T10:05:00Z',
      '2026-09-25T10:06:00Z',
    ];
    let wallTimeIndex = 0;
    const wallNow = (): string => wallTimes[wallTimeIndex++] ?? wallTimes.at(-1)!;
    const clock = {
      wallNow,
      monotonicNow: () => monotonicMilliseconds,
    };
    const timer = {
      setTimeout(_callback: () => void, _delayMs: number): unknown {
        return Symbol('synthetic-deadline');
      },
      clearTimeout(_handle: unknown): void {},
    };
    const events: string[] = [];
    const privateActionInput = 'ephemeral planner action input marker';
    const outputReferenceId = [
      'synthetic-report', queued.job.jobId,
    ].join(':');
    let outputReference: {
      readonly id: string;
      readonly datasetKind: DatasetKind;
      readonly traceId: string;
      readonly candidateId: string;
      readonly reportRevisionId: string;
    } | null = null;
    let l1RunnerCalls = 0;
    let l2RetrievalCalls = 0;
    let exactSpanReadCalls = 0;
    let l2PersistenceCalls = 0;
    const refreshPersistence: { value: Awaited<ReturnType<typeof contextPersister.persist>> | null } = { value: null };
    let actionFailure: string | null = null;
    let refreshFailure: string | null = null;
    const actionMenu: readonly InvestigationActionMenuEntry[] = [
      { name: 'synthetic_search', description: 'Search one synthetic test fixture.' },
    ];
    const provider: InvestigationPlanProvider = {
      async plan(request, options) {
        events.push('planner');
        assert.equal(request.questions.length, 1);
        assert.equal(options.maxTotalTokens, modelTokens);
        monotonicMilliseconds += 1_200;
        return {
          result: {
            schemaVersion: '1.0',
            recordType: 'InvestigationPlanResult',
            outcome: 'proposed',
            actionName: 'synthetic_search',
            input: { query: privateActionInput },
          },
          inputTokens: 7,
          outputTokens: 2,
        };
      },
    };
    const planner = createInvestigationPlanner(provider, {
      modelVersion: '@synthetic/coordinator-planner-v1',
      promptVersion: 'synthetic/coordinator-prompt-v1',
    });
    const reasoningStep = createReasoningStepExecutor({
      ledger: repository,
      fingerprints: TEST_FINGERPRINTS,
      planner,
      maxActiveSeconds: 10,
      maxModelTokens: modelTokens,
      clock,
      timer,
    });
    let actionInputSeen: unknown;
    const singleStep = createSingleStepExecutor({
      ledger: repository,
      fingerprints: TEST_FINGERPRINTS,
      registry: [{
        name: 'synthetic_search',
        enabled: true,
        maxActiveSeconds: 5,
        parseInput: (input) => ({ ok: true, value: input }),
        async handler(input) {
          try {
            events.push('action');
            actionInputSeen = input;
            assert.deepEqual(input, { query: privateActionInput });
            monotonicMilliseconds += 600;
            l1RunnerCalls += 1;
            await testDatabase.executor.execute('SET ROLE waspada_l1_pipeline');
            let l1Result;
            try {
              l1Result = await runSyntheticFixtureJob({
                now: '2026-09-26T15:00:00.000Z',
                queue: roundtrip.ports.acquisitionJobs,
                catalog: roundtrip.fixtureCatalog,
                pipelinePorts: roundtrip.fixturePorts,
              });
            } finally {
              await testDatabase.executor.execute('RESET ROLE');
            }
            assert.deepEqual(l1Result, {
              outcome: 'completed', empty: false, reportCount: 1,
              evidenceReferenceCount: 1, chunkCount: 1, geometryCount: 0,
            });
            assert.equal(extractorCalls.count, 1);
            outputReference = {
              id: outputReferenceId,
              datasetKind: fixture.datasetKind,
              traceId: fixture.traceId,
              candidateId: fixture.candidateId,
              reportRevisionId,
            };
            return { status: 'succeeded', outputReferenceIds: [outputReference.id] };
          } catch (error) {
            actionFailure = error instanceof Error ? error.message : String(error);
            throw error;
          }
        },
      }],
      clock,
      timer,
    });
    const refreshPort = {
      async refresh(input: {
        readonly datasetKind: DatasetKind;
        readonly investigationId: string;
        readonly traceId: string;
        readonly candidateId: string;
        readonly previousContextId: string;
        readonly eventId: string | null;
        readonly eventVersion: number | null;
        readonly outputReferenceIds: readonly string[];
      }) {
        events.push('refresh');
        try {
          assert.equal(input.datasetKind, fixture.datasetKind);
          assert.equal(input.traceId, fixture.traceId);
          assert.equal(input.candidateId, fixture.candidateId);
          assert.equal(input.eventId, null);
          assert.equal(input.eventVersion, null);
          assert.equal(input.previousContextId, initialContextId);
          assert.deepEqual(input.outputReferenceIds, [outputReferenceId]);
          const reference = outputReference;
          assert.ok(reference);
          assert.deepEqual(reference, {
            id: outputReferenceId,
            datasetKind: fixture.datasetKind,
            traceId: fixture.traceId,
            candidateId: fixture.candidateId,
            reportRevisionId,
          });
          const beforeProgress = await repository.getLatest(input.datasetKind, input.investigationId);
          assert.ok(beforeProgress);
          assert.equal(beforeProgress.context_id, initialContextId);
          assert.equal(beforeProgress.dataset_kind, fixture.datasetKind);
          assert.equal(beforeProgress.trace_id, fixture.traceId);
          assert.equal(beforeProgress.candidate_id, fixture.candidateId);
          assert.equal(beforeProgress.event_id, null);
          assert.equal(beforeProgress.event_version, null);
          assert.equal(beforeProgress.checkpoint_version, 5);
          const pendingSnapshot = await testDatabase.executor.query<{
            checkpoint_version: number;
            context_id: string;
          }>(
            'SELECT checkpoint_version, context_id FROM waspada.investigation_progress_snapshots '
              + 'WHERE dataset_kind = $1 AND investigation_id = $2',
            [input.datasetKind, input.investigationId],
          );
          assert.deepEqual(pendingSnapshot.rows, [{ checkpoint_version: 1, context_id: initialContextId }]);

          let retrieval: Awaited<ReturnType<typeof roundtrip.ports.evidenceRetrieval.search>>;
          let reasoningRequest: Awaited<ReturnType<typeof assembleGroundingReasoningRequest>>;
          await testDatabase.executor.execute('SET ROLE waspada_l2_grounding_reader');
          try {
            l2RetrievalCalls += 1;
            retrieval = await roundtrip.ports.evidenceRetrieval.search({
              datasetKind: reference.datasetKind,
              identifiers: [{ kind: 'candidate', value: reference.candidateId }],
              maxResults: 10,
              maxRowsExamined: 20,
              maxSpanTextCodePoints: 256,
            });
            assert.equal(retrieval.datasetKind, fixture.datasetKind);
            assert.equal(retrieval.scanTruncated, false);
            assert.equal(retrieval.resultTruncated, false);
            assert.equal(retrieval.invalidSpanRowsOmitted, 0);
            assert.equal(retrieval.candidates.length, 1);
            const retrieved = retrieval.candidates[0]!;
            assert.equal(retrieved.datasetKind, reference.datasetKind);
            assert.equal(retrieved.candidateId, reference.candidateId);
            assert.equal(retrieved.reportRevisionId, reference.reportRevisionId);
            assert.equal(retrieved.permittedTextHash, sha256(authoredText));
            assert.equal(retrieved.spanStart, selectedStart);
            assert.equal(retrieved.spanEnd, selectedEnd);
            assert.ok(retrieved.spanText.startsWith(selectedSpan));
            assert.equal(retrieved.spanTextTruncated, false);
            assert.equal(retrieved.relation, 'supports');
            assert.equal(retrieved.source.sourceId, sourceId);
            assert.equal(retrieved.source.registryStatus, 'active');
            assert.equal(retrieved.source.approvalStatus, 'approved');
            assert.equal(retrieved.revisionStatus, 'unreviewed');
            assert.equal(retrieved.publishedAt, '2026-09-26T07:04:56.123456Z');
            assert.equal(retrieved.observedAt, '2026-09-26T12:09:10.000007Z');
            assert.equal(retrieved.retrievedAt, '2026-09-26T06:14:15.987654Z');
            assert.equal(retrieved.eventTime.status, 'valid');
            assert.equal(Date.parse(retrieved.eventTime.start ?? ''), Date.parse(eventTime));
            assert.equal(retrieved.originLineageStatus, 'recorded');
            assert.deepEqual(retrieved.origins, [{
              originId,
              sourceId,
              originKind: 'unknown',
              lineageRelation: 'unknown',
              independenceStatus: 'unknown',
              dependsOnOriginIds: [],
            }]);
            assert.equal(new Set([
              Date.parse(retrieved.publishedAt),
              Date.parse(retrieved.observedAt),
              Date.parse(retrieved.retrievedAt),
              Date.parse(retrieved.eventTime.start ?? ''),
            ]).size, 4);

            const exactSpanReader = createSqlExactEvidenceSpanReader(testDatabase.executor);
            const countingSpanReader = {
              async readExactSpan(request: Parameters<typeof exactSpanReader.readExactSpan>[0]) {
                exactSpanReadCalls += 1;
                return exactSpanReader.readExactSpan(request);
              },
            };
            reasoningRequest = await assembleGroundingReasoningRequest(countingSpanReader, {
              retrieval,
              datasetKind: reference.datasetKind,
              traceId: reference.traceId,
              contextId: refreshedContextId,
              candidateId: reference.candidateId,
              evidenceReferenceIds: [retrieved.evidenceReferenceId],
              candidateEvents: [],
              priorDecisionIds: [],
              missingFields: refreshedMissingFields,
              conflicts: [],
              sufficient: true,
            });
            assert.equal(reasoningRequest.data.groundingContext.contextId, refreshedContextId);
            assert.equal(reasoningRequest.data.groundingContext.traceId, fixture.traceId);
            assert.equal(reasoningRequest.data.groundingContext.candidateId, fixture.candidateId);
            assert.equal(reasoningRequest.data.groundingContext.datasetKind, fixture.datasetKind);
            assert.equal(reasoningRequest.data.groundingContext.sufficient, true,
              'sufficiency is an explicitly authored fixture input, not an evaluation');
            assert.equal(reasoningRequest.data.groundingContext.evidence[0]?.text, selectedSpan);
            assert.equal(reasoningRequest.data.groundingContext.evidence[0]?.sourceId, sourceId);
            assert.equal(reasoningRequest.data.groundingContext.evidence[0]?.publishedAt,
              '2026-09-26T07:04:56.123456Z');
            assert.equal(reasoningRequest.data.groundingContext.evidence[0]?.observedAt,
              '2026-09-26T12:09:10.000007Z');
            assert.equal(reasoningRequest.data.groundingContext.evidence[0]?.retrievedAt,
              '2026-09-26T06:14:15.987654Z');
            assert.deepEqual(reasoningRequest.data.groundingContext.evidence[0]?.origins, [{
              originId,
              independenceStatus: 'unknown',
              dependsOnOriginIds: [],
            }]);
            assert.deepEqual(reasoningRequest.data.groundingContext.candidateEvents, []);
          } finally {
            await testDatabase.executor.execute('RESET ROLE');
          }
          assert.equal(exactSpanReadCalls, 1);

          let persisted: Awaited<ReturnType<typeof contextPersister.persist>> | null = null;
          await testDatabase.executor.execute('SET ROLE waspada_l2_grounding_writer');
          try {
            l2PersistenceCalls += 1;
            persisted = await contextPersister.persist(reasoningRequest);
            refreshPersistence.value = persisted;
          } finally {
            await testDatabase.executor.execute('RESET ROLE');
          }
          assert.ok(persisted);
          assert.deepEqual(persisted.persistedRecord.evidence, [{
            report_revision_id: reportRevisionId,
            permitted_text_hash: retrieval!.candidates[0]!.permittedTextHash,
            span_start: selectedStart,
            span_end: selectedEnd,
            offset_unit: 'unicode_code_points',
            relation: 'supports',
          }]);
          assert.deepEqual(persisted.persistedRecord.candidate_events, []);
          const contextRow = await testDatabase.executor.query<{ context_id: string; record_json: string }>(
            'SELECT context_id, record_json::text AS record_json FROM waspada.grounding_contexts '
              + 'WHERE dataset_kind = $1 AND context_id = $2',
            [fixture.datasetKind, refreshedContextId],
          );
          assert.equal(contextRow.rows.length, 1);
          assert.equal(contextRow.rows[0]?.context_id, refreshedContextId);
          assert.deepEqual(JSON.parse(contextRow.rows[0]!.record_json), persisted.persistedRecord);
          assert.equal(contextRow.rows[0]!.record_json.includes(selectedSpan), false);
          assert.equal(Object.hasOwn(persisted.persistedRecord.evidence[0]!, 'text'), false);
          return {
            context: persisted.reasoningRequest.data.groundingContext,
            persistedRecord: persisted.persistedRecord,
          };
        } catch (error) {
          refreshFailure = error instanceof Error ? error.message : String(error);
          throw error;
        }
      },
    };
    const coordinator = createInvestigationCoordinator({
      entry,
      ledger: repository,
      fingerprints: TEST_FINGERPRINTS,
      reasoningStep,
      singleStep,
      refreshPort,
      actionMenu,
      wallNow,
    });
    const advanceInput = {
      kind: 'open',
      outcome: directOutcome,
      callerValues: {
        investigationId: 'investigation-l3-coordinator-composition',
        requestedAt: TEST_TIME,
        policyVersion: 'synthetic-coordinator-policy-v1',
        limits: { toolAttempts: 2, reasoningTurns: 2, activeSeconds: 60, modelTokens: 500 },
      },
      reasoningReservationId: 'reservation-coordinator-composition-plan',
      reasoningReservedAt: '2026-09-25T10:00:01Z',
      actionReservationId: 'reservation-coordinator-composition-action',
    } as const;
    const result = await coordinator.advance(advanceInput);

    assert.equal(result.status, 'sufficient_context', JSON.stringify({ result, events, actionFailure, refreshFailure }));
    if (result.status !== 'sufficient_context') assert.fail('expected the authored sufficient-context checkpoint');
    const checkpoint = result.checkpoint;
    assert.ok(checkpoint, 'the sufficient-context result carries its exact investigation checkpoint');
    assert.deepEqual(events, ['planner', 'action', 'refresh']);
    assert.deepEqual(actionInputSeen, { query: privateActionInput });
    const persistedRefresh = refreshPersistence.value;
    assert.ok(persistedRefresh);
    assert.deepEqual(result.context, persistedRefresh.reasoningRequest.data.groundingContext);
    assert.deepEqual(result.persistedRecord, persistedRefresh.persistedRecord);
    assert.equal(result.persistedRecord.sufficient, true);
    assert.equal(result.context.contextId, refreshedContextId);
    assert.equal(result.context.datasetKind, fixture.datasetKind);
    assert.equal(result.context.traceId, fixture.traceId);
    assert.equal(result.context.candidateId, fixture.candidateId);
    assert.deepEqual(result.context.candidateEvents, []);
    assert.deepEqual(result.context.evidence[0]?.reference,
      persistedRefresh.reasoningRequest.data.groundingContext.evidence[0]?.reference);
    assert.deepEqual(result.context.missingFields, refreshedMissingFields);
    assert.equal(checkpoint.dataset_kind, fixture.datasetKind);
    assert.equal(checkpoint.trace_id, fixture.traceId);
    assert.equal(checkpoint.candidate_id, fixture.candidateId);
    assert.equal(checkpoint.investigation_id, advanceInput.callerValues.investigationId);
    assert.equal(checkpoint.event_id, null);
    assert.equal(checkpoint.event_version, null);
    assert.equal(checkpoint.context_id, refreshedContextId);
    assert.equal(checkpoint.checkpoint_version, 6);
    assert.equal(checkpoint.budget.consumed.reasoning_turns, 1);
    assert.equal(checkpoint.budget.consumed.tool_attempts, 1);
    assert.equal(checkpoint.budget.consumed.model_tokens, 9);
    assert.deepEqual(checkpoint.budget.reserved, zeroCounters());

    const refreshedRequest = persistedRefresh.reasoningRequest;
    let reasoningOutcome: Awaited<ReturnType<typeof directReasoning.reason>>;
    await testDatabase.executor.execute('SET ROLE waspada_l2_grounding_writer');
    try {
      reasoningOutcome = await directReasoning.reason(refreshedRequest);
    } finally {
      await testDatabase.executor.execute('RESET ROLE');
    }
    assert.equal(reasoningOutcome.status, 'succeeded');
    if (reasoningOutcome.status !== 'succeeded') assert.fail('expected deterministic synthetic reasoning');
    assert.equal(reasoningOutcome.capability, 'reasoning');
    assert.equal(reasoningCalls, 1);
    const exactReasoningRequest = reasoningRequestAtCall.value;
    assert.ok(exactReasoningRequest);
    assert.deepEqual(exactReasoningRequest, refreshedRequest);

    const proposalBridge = createReasoningProposalBridge(roundtrip.ports.eventProposals);
    const proposalInput = {
      capabilityOutcome: reasoningOutcome,
      groundingContext: exactReasoningRequest.data.groundingContext,
      persistedContextRecord: result.persistedRecord,
      proposalId: 'proposal-l3-coordinator-roundtrip',
      proposedAt: '2026-09-26T15:30:00.000000Z',
      target: { kind: 'new' as const },
      investigationId: checkpoint.investigation_id,
    };
    let firstProposal: Awaited<ReturnType<typeof proposalBridge.persist>>;
    await testDatabase.executor.execute('SET ROLE waspada_l2_proposal_writer');
    try {
      firstProposal = await proposalBridge.persist(proposalInput);
    } finally {
      await testDatabase.executor.execute('RESET ROLE');
    }
    assert.equal(firstProposal.status, 'persisted');
    if (firstProposal.status !== 'persisted') assert.fail('expected the canonical private proposal');
    const proposalRowCounts = async () => {
      const counts = await testDatabase.executor.query<{
        proposals: string;
        claims: string;
        evidence_links: string;
        origin_links: string;
      }>(
        'SELECT '
          + '(SELECT count(*)::text FROM waspada.event_proposals WHERE dataset_kind = $1 AND proposal_id = $2) AS proposals, '
          + '(SELECT count(*)::text FROM waspada.proposal_claims WHERE dataset_kind = $1 AND proposal_id = $2) AS claims, '
          + '(SELECT count(*)::text FROM waspada.proposal_claim_evidence WHERE dataset_kind = $1 AND proposal_id = $2) AS evidence_links, '
          + '(SELECT count(*)::text FROM waspada.proposal_claim_origins WHERE dataset_kind = $1 AND proposal_id = $2) AS origin_links',
        [fixture.datasetKind, proposalInput.proposalId],
      );
      const row = counts.rows[0];
      assert.ok(row);
      return row;
    };
    const countsAfterProposal = await proposalRowCounts();
    assert.deepEqual(countsAfterProposal, {
      proposals: '1', claims: '1', evidence_links: '1', origin_links: '1',
    });
    const proposal = firstProposal.proposal;
    assert.equal(proposal.schema_version, '2.0');
    assert.equal(proposal.dataset_kind, fixture.datasetKind);
    assert.equal(proposal.trace_id, fixture.traceId);
    assert.equal(proposal.candidate_id, fixture.candidateId);
    assert.equal(proposal.context_id, refreshedContextId);
    assert.equal(proposal.proposal_id, proposalInput.proposalId);
    assert.equal(proposal.investigation_id, checkpoint.investigation_id);
    assert.equal(proposal.event_id, null);
    assert.equal(proposal.base_event_version, null);
    assert.deepEqual(proposal.claims[0]?.origin_ids, [originId]);
    assert.equal(proposal.claims[0]?.support_assessment, 'uncertain');
    assert.equal(proposal.claims[0]?.evidence_label, 'under_review');
    assert.deepEqual(proposal.claims[0]?.support, [{
      report_revision_id: reportRevisionId,
      permitted_text_hash: persistedRefresh.persistedRecord.evidence[0]!.permitted_text_hash,
      span_start: selectedStart,
      span_end: selectedEnd,
      offset_unit: 'unicode_code_points',
      relation: 'supports',
    }]);
    assert.deepEqual(proposal.model_runs, [{
      capability: 'reasoning',
      model_version: 'synthetic-l3-composition-reasoner-v1',
      prompt_version: 'synthetic-l3-composition-prompt-v1',
      input_tokens: 17,
      output_tokens: 8,
    }]);
    const storedProposal = await testDatabase.executor.query<{ record_json: string }>(
      'SELECT record_json::text AS record_json FROM waspada.event_proposals '
        + 'WHERE dataset_kind = $1 AND proposal_id = $2',
      [fixture.datasetKind, proposalInput.proposalId],
    );
    assert.equal(storedProposal.rows.length, 1);
    assert.deepEqual(JSON.parse(storedProposal.rows[0]!.record_json), proposal);
    const normalizedEvidence = await testDatabase.executor.query<{
      evidence_kind: string;
      evidence_ref_id: string;
    }>(
      'SELECT evidence_kind, evidence_ref_id::text AS evidence_ref_id FROM waspada.proposal_claim_evidence '
        + 'WHERE dataset_kind = $1 AND proposal_id = $2',
      [fixture.datasetKind, proposalInput.proposalId],
    );
    assert.deepEqual(normalizedEvidence.rows, [{ evidence_kind: 'support', evidence_ref_id: evidenceReferenceId }]);
    const normalizedOrigins = await testDatabase.executor.query<{ origin_id: string }>(
      'SELECT origin_id FROM waspada.proposal_claim_origins WHERE dataset_kind = $1 AND proposal_id = $2',
      [fixture.datasetKind, proposalInput.proposalId],
    );
    assert.deepEqual(normalizedOrigins.rows, [{ origin_id: originId }]);
    let proposalReplay: Awaited<ReturnType<typeof proposalBridge.persist>>;
    await testDatabase.executor.execute('SET ROLE waspada_l2_proposal_writer');
    try {
      proposalReplay = await proposalBridge.persist(proposalInput);
    } finally {
      await testDatabase.executor.execute('RESET ROLE');
    }
    assert.deepEqual(proposalReplay, firstProposal, 'an exact retry returns the same immutable private proposal');
    assert.deepEqual(await proposalRowCounts(), countsAfterProposal,
      'an exact replay adds no proposal, claim, evidence, or origin rows');
    assert.deepEqual(await protectedWriteCounts(), protectedWritesBefore,
      'the investigated private proposal path writes no public, publication, audit, outbox, or moderator rows');

    const stableActionReservation = await testDatabase.executor.query<{
      reserved_tool_attempts: number;
      reserved_at: string;
    }>(
      'SELECT reserved_tool_attempts, created_at::text AS reserved_at '
        + 'FROM waspada.investigation_action_reservations '
        + 'WHERE dataset_kind = $1 AND reservation_id = $2',
      [fixture.datasetKind, 'reservation-coordinator-composition-action'],
    );
    assert.equal(stableActionReservation.rows.length, 1);
    assert.equal(stableActionReservation.rows[0]?.reserved_tool_attempts, 1);
    assert.equal(Date.parse(stableActionReservation.rows[0]!.reserved_at), Date.parse(plannedActionTime));

    const repeatedAction = await singleStep.execute({
      datasetKind: fixture.datasetKind,
      investigationId: checkpoint.investigation_id,
      expectedCheckpointVersion: 3,
      reservationId: advanceInput.actionReservationId,
      reservedAt: plannedActionTime,
      actionName: 'synthetic_search',
      input: { query: privateActionInput },
    });
    assert.equal(repeatedAction.status, 'replayed');
    assert.deepEqual(events, ['planner', 'action', 'refresh']);
    const outerRetry = await coordinator.advance(advanceInput);
    assert.equal(outerRetry.status, 'review_required');
    if (outerRetry.status !== 'review_required') assert.fail('expected stale checkpoint after outer replay');
    assert.equal(outerRetry.reason, 'stale_checkpoint');
    assert.deepEqual(events, ['planner', 'action', 'refresh']);
    assert.equal(l1RunnerCalls, 1);
    assert.equal(extractorCalls.count, 1);
    assert.equal(l2RetrievalCalls, 1);
    assert.equal(exactSpanReadCalls, 1);
    assert.equal(l2PersistenceCalls, 1);

    const finalSnapshot = await testDatabase.executor.query<{
      checkpoint_version: number;
      context_id: string;
      consecutive_no_progress: number;
    }>(
      'SELECT checkpoint_version, context_id, consecutive_no_progress '
        + 'FROM waspada.investigation_progress_snapshots '
        + 'WHERE dataset_kind = $1 AND investigation_id = $2',
      [fixture.datasetKind, checkpoint.investigation_id],
    );
    assert.deepEqual(finalSnapshot.rows, [
      {
        checkpoint_version: 1,
        context_id: initialContextId,
        consecutive_no_progress: 0,
      },
      {
        checkpoint_version: checkpoint.checkpoint_version,
        context_id: refreshedContextId,
        consecutive_no_progress: 0,
      },
    ]);
    const plannerReservation = await readStoredReservation(
      testDatabase,
      fixture.datasetKind,
      checkpoint.investigation_id,
      'reservation-coordinator-composition-plan',
    );
    const actionReservation = await readStoredReservation(
      testDatabase,
      fixture.datasetKind,
      checkpoint.investigation_id,
      'reservation-coordinator-composition-action',
    );
    assert.equal(plannerReservation.reservation_status, 'reconciled');
    assert.equal(plannerReservation.reserved_reasoning_turns, 1);
    assert.equal(plannerReservation.actual_model_tokens, 9);
    assert.equal(actionReservation.reservation_status, 'reconciled');
    const persistedRevision = await roundtrip.ports.reportRevisions.findById(fixture.datasetKind, reportRevisionId);
    assert.ok(persistedRevision);
    assert.equal(persistedRevision.traceId, fixture.traceId);
    assert.equal(persistedRevision.sourceId, sourceId);
    assert.equal(persistedRevision.revisionStatus, 'unreviewed');
    assert.equal(Date.parse(persistedRevision.publishedAt ?? ''), Date.parse(publishedAt));
    assert.equal(Date.parse(persistedRevision.observedAt ?? ''), Date.parse(observedAt));
    assert.equal(Date.parse(persistedRevision.retrievedAt), Date.parse(retrievedAt));
    const persistedCandidate = await roundtrip.ports.extractionResults.findByCandidateId(
      fixture.datasetKind,
      fixture.candidateId,
    );
    assert.equal(persistedCandidate.outcome, 'found');
    if (persistedCandidate.outcome !== 'found') {
      assert.fail('expected the exact L1 extraction to remain persisted after coordinator replay');
    }
    assert.equal(persistedCandidate.record.trace_id, fixture.traceId);
    assert.equal(persistedCandidate.record.candidate_id, fixture.candidateId);
    assert.equal(persistedCandidate.record.report_revision_id, reportRevisionId);
    assert.equal(Date.parse(persistedCandidate.record.event_time.start ?? ''), Date.parse(eventTime));
    const l1Job = await roundtrip.ports.acquisitionJobs.findById(fixture.datasetKind, queued.job.jobId);
    assert.equal(l1Job?.status, 'completed');
    assert.equal(l1Job?.attemptCount, 1);
    const noPublicationWrites = await testDatabase.executor.query<{
      events: string;
      publications: string;
      proposals: string;
    }>(
      'SELECT '
        + '(SELECT count(*)::text FROM waspada.event_versions WHERE dataset_kind = $1 AND trace_id = $2) AS events, '
        + '(SELECT count(*)::text FROM waspada.publication_decisions WHERE dataset_kind = $1 AND trace_id = $2) AS publications, '
        + '(SELECT count(*)::text FROM waspada.event_proposals WHERE dataset_kind = $1 AND trace_id = $2) AS proposals',
      [fixture.datasetKind, fixture.traceId],
    );
    assert.deepEqual(noPublicationWrites.rows[0], { events: '0', publications: '0', proposals: '1' });
    assert.deepEqual(await protectedWriteCounts(), protectedWritesBefore,
      'coordinator retry and proposal replay add no event, publication, audit, outbox, or moderator records');

    const ledgerJson = await readLedgerJson(testDatabase, fixture.datasetKind, checkpoint.investigation_id);
    const storedContexts = await testDatabase.executor.query<{ context_id: string; record_json: string }>(
      'SELECT context_id, record_json::text AS record_json FROM waspada.grounding_contexts '
        + 'WHERE dataset_kind = $1 AND context_id = ANY($2::text[])',
      [fixture.datasetKind, [initialContextId, refreshedContextId]],
    );
    assert.equal(storedContexts.rows.length, 2);
    const refreshedStoredContext = storedContexts.rows.find(({ context_id }) => context_id === refreshedContextId);
    assert.ok(refreshedStoredContext);
    assert.deepEqual(JSON.parse(refreshedStoredContext.record_json), persistedRefresh.persistedRecord);
    const durableContextJson = storedContexts.rows.map(({ record_json }) => record_json).join('\n');
    assert.equal(durableContextJson.includes(selectedSpan), false);
    assert.equal(durableContextJson.includes(authoredText), false);
    const durable = ledgerJson + durableContextJson;
    assert.equal(durable.includes(privateActionInput), false);
    assert.equal(durable.includes(outputReferenceId), false);
    assert.equal(durable.includes(JSON.stringify({ query: privateActionInput })), false);
  });

  it('reloads a refs-only checkpoint context through L2 before one bounded L3 resume', async () => {
    const readProtectedWriteCounts = async () => {
      const result = await testDatabase.executor.query<{
        events: string;
        decisions: string;
        outbox: string;
        historyReviews: string;
      }>(
        'SELECT '
          + '(SELECT count(*)::text FROM waspada.event_versions) AS events, '
          + '(SELECT count(*)::text FROM waspada.publication_decisions) AS decisions, '
          + '(SELECT count(*)::text FROM waspada.publication_outbox) AS outbox, '
          + '(SELECT count(*)::text FROM waspada.public_event_history_review_decisions) AS "historyReviews"',
      );
      const row = result.rows[0];
      assert.ok(row);
      return row;
    };
    const protectedWritesBefore = await readProtectedWriteCounts();
    const suffix = 'context-resume-coordinator';
    const fixture = await seedFixture(testDatabase, suffix, { sufficient: false, seedContext: false });
    const sourceId = `source-l3-${suffix}`;
    const reportRevisionId = `revision-l3-${suffix}`;
    const originId = `origin-l3-${suffix}`;
    const evidenceText = 'Synthetic L3 ledger fixture evidence';
    const ports = createRepositoryPorts(testDatabase.executor);
    const contextRepository = createSqlGroundingContextRepository(testDatabase.executor);
    const withRole = async <Result>(role: string, work: () => Promise<Result>): Promise<Result> => {
      await testDatabase.executor.execute(`SET ROLE ${role}`);
      try {
        return await work();
      } finally {
        await testDatabase.executor.execute('RESET ROLE');
      }
    };

    await testDatabase.executor.query(
      "UPDATE waspada.source_registry SET approval_status = 'approved' WHERE source_id = $1",
      [sourceId],
    );
    const evidenceReferenceId = await ports.reportRevisions.createEvidenceReference({
      datasetKind: fixture.datasetKind,
      traceId: fixture.traceId,
      reportRevisionId,
      permittedTextHash: sha256(evidenceText),
      spanStart: 0,
      spanEnd: Array.from(evidenceText).length,
      relation: 'context',
    });
    await testDatabase.executor.query(
      'INSERT INTO waspada.extraction_evidence (dataset_kind, candidate_id, evidence_ref_id) VALUES ($1, $2, $3)',
      [fixture.datasetKind, fixture.candidateId, evidenceReferenceId],
    );
    await testDatabase.executor.query(
      `INSERT INTO waspada.evidence_origins
         (dataset_kind, origin_id, trace_id, origin_kind, actor_label, source_id,
          lineage_relation, independence_status, record_json)
       VALUES ($1, $2, $3, 'issuer_statement', NULL, $4, 'original', 'established', $5::jsonb)`,
      [fixture.datasetKind, originId, fixture.traceId, sourceId,
        JSON.stringify({ fixture: 'synthetic-test-only' })],
    );
    await testDatabase.executor.query(
      'INSERT INTO waspada.origin_evidence (dataset_kind, origin_id, evidence_ref_id) VALUES ($1, $2, $3)',
      [fixture.datasetKind, originId, evidenceReferenceId],
    );

    const persistedRecord: GroundingContextRecord = {
      schema_version: '2.0',
      trace_id: fixture.traceId,
      record_type: 'GroundingContext',
      dataset_kind: fixture.datasetKind,
      context_id: fixture.contextId,
      candidate_id: fixture.candidateId,
      evidence: [{
        report_revision_id: reportRevisionId,
        permitted_text_hash: sha256(evidenceText),
        span_start: 0,
        span_end: Array.from(evidenceText).length,
        offset_unit: 'unicode_code_points',
        relation: 'context',
      }],
      revision_states: [{ report_revision_id: reportRevisionId, revision_status: 'unreviewed' }],
      candidate_events: [],
      prior_decision_ids: [],
      missing_fields: ['synthetic_status'],
      conflicts: [],
      retrieval_version: 'retrieval-synthetic-resume-v1',
      index_version: 'index-synthetic-resume-v1',
      sufficient: false,
    };
    await withRole('waspada_l2_grounding_writer', () => contextRepository.createOrVerify(persistedRecord));
    const contextJson = JSON.stringify(persistedRecord);
    assert.equal(contextJson.includes(evidenceText), false, 'the saved context contains references, never excerpts');
    assert.equal(Object.hasOwn(persistedRecord.evidence[0]!, 'text'), false);

    const repository = createSqlInvestigationLedgerRepository(testDatabase.executor);
    const initialCheckpoint = await repository.create(makeCreateInput(fixture, {
      limits: { toolAttempts: 2, reasoningTurns: 2, activeSeconds: 60, modelTokens: 100 },
    }));
    const checkpointAfterRestart = await repository.getLatest(fixture.datasetKind, initialCheckpoint.investigation_id);
    assert.deepEqual(checkpointAfterRestart, initialCheckpoint, 'restart reloads the latest durable checkpoint');
    assert.ok(checkpointAfterRestart);
    assert.equal(checkpointAfterRestart.context_id, persistedRecord.context_id);
    const staleRecord: GroundingContextRecord = {
      ...persistedRecord,
      context_id: `${fixture.contextId}-stale-revision`,
      revision_states: [{ report_revision_id: reportRevisionId, revision_status: 'eligible' }],
    };
    await withRole('waspada_l2_grounding_writer', () => contextRepository.createOrVerify(staleRecord));
    const staleCheckpoint = await repository.create(makeCreateInput({
      ...fixture,
      contextId: staleRecord.context_id,
    }, {
      investigationId: `investigation-${fixture.candidateId}-stale-revision`,
    }));

    const exactReferences = createSqlExactEvidenceReferenceReader(testDatabase.executor);
    const exactSpans = createSqlExactEvidenceSpanReader(testDatabase.executor);
    const referenceReadInputs: ExactEvidenceReferenceReadRequest[] = [];
    const spanReadInputs: ExactEvidenceSpanRequest[] = [];
    const makeResumer = (maskedMissingContextId?: string) => createGroundingContextResumer({
      contexts: {
        async findById(datasetKind, contextId) {
          // Grounding contexts are append-only, so model a missing restart read at this boundary.
          if (datasetKind === fixture.datasetKind && contextId === maskedMissingContextId) return null;
          return withRole('waspada_l2_grounding_writer', () =>
            contextRepository.findById(datasetKind, contextId));
        },
      },
      evidenceReferences: {
        async readExactReferences(request) {
          referenceReadInputs.push(structuredClone(request));
          return withRole('waspada_l2_grounding_reader', () => exactReferences.readExactReferences(request));
        },
      },
      exactSpans: {
        async readExactSpan(request) {
          spanReadInputs.push(structuredClone(request));
          return withRole('waspada_l2_grounding_reader', () => exactSpans.readExactSpan(request));
        },
      },
    });

    let monotonicMilliseconds = 0;
    const clockBase = Date.parse('2026-09-25T10:01:00.000Z');
    const clock: ReasoningStepExecutorClock = {
      wallNow: () => new Date(clockBase + monotonicMilliseconds).toISOString(),
      monotonicNow: () => monotonicMilliseconds,
    };
    const timer: ReasoningStepExecutorTimer = {
      setTimeout() { return Symbol('synthetic-resume-deadline'); },
      clearTimeout() {},
    };
    const actionMenu: readonly InvestigationActionMenuEntry[] = [
      { name: 'synthetic_search', description: 'Search one synthetic fixture.' },
    ];
    const privateActionInput = 'synthetic private resume query';
    const outputReferenceId = 'synthetic-resume-output-reference';
    let plannerCalls = 0;
    let actionCalls = 0;
    let refreshCalls = 0;
    let rehydratedContext: GroundingContext | null = null;
    const planner = createInvestigationPlanner({
      async plan(request) {
        plannerCalls += 1;
        assert.deepEqual(request.questions, ['missing_field_1']);
        monotonicMilliseconds += 2_000;
        return {
          result: {
            schemaVersion: '1.0',
            recordType: 'InvestigationPlanResult',
            outcome: 'proposed',
            actionName: 'synthetic_search',
            input: { query: privateActionInput },
          },
          inputTokens: 2,
          outputTokens: 3,
        };
      },
    }, {
      modelVersion: '@synthetic/context-resume-planner-v1',
      promptVersion: 'synthetic/context-resume-prompt-v1',
    });
    const reasoningStep = createReasoningStepExecutor({
      ledger: repository,
      fingerprints: TEST_FINGERPRINTS,
      planner,
      maxActiveSeconds: 10,
      maxModelTokens: 32,
      clock,
      timer,
    });
    const singleStep = createSingleStepExecutor({
      ledger: repository,
      fingerprints: TEST_FINGERPRINTS,
      registry: [{
        name: 'synthetic_search',
        enabled: true,
        maxActiveSeconds: 10,
        parseInput: (input) => ({ ok: true, value: input }),
        async handler(input) {
          actionCalls += 1;
          assert.deepEqual(input, { query: privateActionInput });
          monotonicMilliseconds += 1_000;
          return { status: 'succeeded', outputReferenceIds: [outputReferenceId] };
        },
      }],
      clock,
      timer,
    });
    const refreshedRecord: GroundingContextRecord = {
      ...persistedRecord,
      context_id: `${fixture.contextId}-refreshed`,
      missing_fields: [],
      retrieval_version: 'retrieval-synthetic-resume-v2',
      index_version: 'index-synthetic-resume-v2',
      sufficient: true,
    };
    const refreshPort = {
      async refresh(input: {
        readonly datasetKind: DatasetKind;
        readonly investigationId: string;
        readonly traceId: string;
        readonly candidateId: string;
        readonly previousContextId: string;
        readonly eventId: string | null;
        readonly eventVersion: number | null;
        readonly outputReferenceIds: readonly string[];
      }) {
        refreshCalls += 1;
        assert.equal(input.datasetKind, fixture.datasetKind);
        assert.equal(input.investigationId, initialCheckpoint.investigation_id);
        assert.equal(input.traceId, fixture.traceId);
        assert.equal(input.candidateId, fixture.candidateId);
        assert.equal(input.previousContextId, fixture.contextId);
        assert.equal(input.eventId, null);
        assert.equal(input.eventVersion, null);
        assert.deepEqual(input.outputReferenceIds, [outputReferenceId]);
        assert.ok(rehydratedContext);
        await withRole('waspada_l2_grounding_writer', () => contextRepository.createOrVerify(refreshedRecord));
        return {
          context: {
            ...rehydratedContext,
            contextId: refreshedRecord.context_id,
            missingFields: [],
            retrievalVersion: refreshedRecord.retrieval_version,
            indexVersion: refreshedRecord.index_version,
            sufficient: true,
          },
          persistedRecord: refreshedRecord,
        };
      },
    };
    const coordinator = createInvestigationCoordinator({
      entry: createInsufficientContextEntryService(repository, TEST_FINGERPRINTS),
      ledger: repository,
      fingerprints: TEST_FINGERPRINTS,
      reasoningStep,
      singleStep,
      refreshPort,
      actionMenu,
      wallNow: clock.wallNow,
    });

    const advanceFromCheckpoint = async (
      resumer: ReturnType<typeof createGroundingContextResumer>,
      checkpoint: NonNullable<typeof checkpointAfterRestart>,
    ) => {
      const request = await resumer.resume(checkpoint.dataset_kind, checkpoint.context_id);
      if (!request) return { status: 'context_missing' as const, request };
      const record = await withRole('waspada_l2_grounding_writer', () =>
        contextRepository.findById(checkpoint.dataset_kind, checkpoint.context_id));
      assert.ok(record, 'the exact persisted refs-only record is supplied to the coordinator');
      rehydratedContext = request.data.groundingContext;
      const resumedContext = request.data.groundingContext;
      assert.equal(resumedContext.contextId, checkpoint.context_id);
      assert.equal(resumedContext.datasetKind, checkpoint.dataset_kind);
      assert.equal(resumedContext.traceId, checkpoint.trace_id);
      assert.equal(resumedContext.candidateId, checkpoint.candidate_id);
      assert.equal(resumedContext.sufficient, record.sufficient);
      const evidence = resumedContext.evidence[0];
      assert.ok(evidence, 'the exact checkpoint context resolves its persisted evidence reference');
      const persistedReference = record.evidence[0];
      assert.ok(persistedReference);
      assert.deepEqual(evidence.reference, {
        reportRevisionId: persistedReference.report_revision_id,
        permittedTextHash: persistedReference.permitted_text_hash,
        spanStart: persistedReference.span_start,
        spanEnd: persistedReference.span_end,
        offsetUnit: persistedReference.offset_unit,
        relation: persistedReference.relation,
      });
      assert.equal(evidence.text, evidenceText, 'the exact current span is checked before coordinator work');
      assert.equal(evidence.sourceId, sourceId, 'the source ID comes from current L2 lineage');
      assert.equal(evidence.revisionStatus, 'unreviewed');
      assert.deepEqual(evidence.origins, [{
        originId,
        independenceStatus: 'established',
        dependsOnOriginIds: [],
      }]);
      const advanceInput = {
        kind: 'resume' as const,
        checkpoint,
        context: request.data.groundingContext,
        persistedRecord: record,
        reasoningReservationId: 'reservation-context-resume-plan',
        reasoningReservedAt: '2026-09-25T10:01:00Z',
        actionReservationId: 'reservation-context-resume-action',
      };
      return {
        status: 'advanced' as const,
        request,
        persistedRecord: record,
        advanceInput,
        outcome: await coordinator.advance(advanceInput),
      };
    };
    const portCalls = () => ({ plannerCalls, actionCalls, refreshCalls });

    const missing = await advanceFromCheckpoint(makeResumer(checkpointAfterRestart.context_id), checkpointAfterRestart);
    assert.equal(missing.status, 'context_missing');
    if (missing.status !== 'context_missing') assert.fail('expected the exact context read miss to stop composition');
    assert.equal(missing.request, null, 'the real L2 resumer returns null for a missing exact checkpoint context');
    assert.deepEqual(portCalls(), { plannerCalls: 0, actionCalls: 0, refreshCalls: 0 },
      'a missing exact context stops before every L3 port');
    assert.equal(referenceReadInputs.length, 0, 'a missing context does not trigger evidence lookup');

    await assert.rejects(
      advanceFromCheckpoint(makeResumer(), staleCheckpoint),
      (error: unknown) => {
        assert.ok(error instanceof GroundingContextResumptionError);
        assert.equal(error.code, 'revision_state_mismatch');
        assert.equal(error.message, 'revision_state_mismatch');
        assert.equal(error.message.includes(evidenceText), false);
        return true;
      },
    );
    assert.deepEqual(portCalls(), { plannerCalls: 0, actionCalls: 0, refreshCalls: 0 },
      'a changed pinned revision state stops before every L3 port');
    assert.equal(spanReadInputs.length, 0, 'stale revision state fails before span reads');

    await testDatabase.executor.query(
      "UPDATE waspada.source_registry SET registry_status = 'paused' WHERE source_id = $1",
      [sourceId],
    );
    await assert.rejects(
      advanceFromCheckpoint(makeResumer(), checkpointAfterRestart),
      (error: unknown) => {
        assert.ok(error instanceof GroundingContextResumptionError);
        assert.equal(error.code, 'source_ineligible');
        assert.equal(error.message, 'source_ineligible');
        assert.equal(error.message.includes(evidenceText), false);
        return true;
      },
    );
    assert.deepEqual(portCalls(), { plannerCalls: 0, actionCalls: 0, refreshCalls: 0 },
      'a stale source eligibility check stops before every L3 port');
    assert.equal(spanReadInputs.length, 0, 'ineligible sources fail before span reads');
    await testDatabase.executor.query(
      "UPDATE waspada.source_registry SET registry_status = 'active' WHERE source_id = $1",
      [sourceId],
    );

    const resumed = await advanceFromCheckpoint(makeResumer(), checkpointAfterRestart);
    assert.equal(resumed.status, 'advanced');
    if (resumed.status !== 'advanced') assert.fail('expected the exact checkpoint context to rehydrate');
    assert.deepEqual(resumed.persistedRecord, persistedRecord);
    assert.deepEqual(referenceReadInputs.at(-1), {
      datasetKind: fixture.datasetKind,
      candidateId: fixture.candidateId,
      references: [{
        reportRevisionId,
        permittedTextHash: sha256(evidenceText),
        spanStart: 0,
        spanEnd: Array.from(evidenceText).length,
        offsetUnit: 'unicode_code_points',
        relation: 'context',
      }],
    });
    assert.equal(spanReadInputs.at(-1)?.evidenceReferenceId, evidenceReferenceId);
    assert.equal(spanReadInputs.at(-1)?.spanStart, 0);
    assert.equal(spanReadInputs.at(-1)?.spanEnd, Array.from(evidenceText).length);
    assert.equal(resumed.outcome.status, 'sufficient_context');
    if (resumed.outcome.status !== 'sufficient_context') {
      assert.fail('expected the one authored resume advance to return its refreshed context');
    }
    assert.equal(resumed.outcome.checkpoint?.dataset_kind, fixture.datasetKind);
    assert.equal(resumed.outcome.checkpoint?.investigation_id, initialCheckpoint.investigation_id);
    assert.equal(resumed.outcome.checkpoint?.trace_id, fixture.traceId);
    assert.equal(resumed.outcome.checkpoint?.candidate_id, fixture.candidateId);
    assert.equal(resumed.outcome.checkpoint?.context_id, refreshedRecord.context_id);
    assert.equal(resumed.outcome.checkpoint?.checkpoint_version, initialCheckpoint.checkpoint_version + 5);
    assert.equal(resumed.outcome.context.contextId, refreshedRecord.context_id);
    assert.deepEqual(portCalls(), { plannerCalls: 1, actionCalls: 1, refreshCalls: 1 });

    const stableCheckpoint = await repository.getLatest(fixture.datasetKind, initialCheckpoint.investigation_id);
    assert.deepEqual(stableCheckpoint, resumed.outcome.checkpoint);
    const rowsBeforeReplay = await Promise.all([
      testDatabase.executor.query<Record<string, unknown>>(
        'SELECT * FROM waspada.investigation_requests '
          + 'WHERE dataset_kind = $1 AND investigation_id = $2',
        [fixture.datasetKind, initialCheckpoint.investigation_id],
      ),
      testDatabase.executor.query<Record<string, unknown>>(
        'SELECT * FROM waspada.investigation_checkpoints '
          + 'WHERE dataset_kind = $1 AND investigation_id = $2 ORDER BY checkpoint_version',
        [fixture.datasetKind, initialCheckpoint.investigation_id],
      ),
      testDatabase.executor.query<Record<string, unknown>>(
        'SELECT * FROM waspada.investigation_action_reservations '
          + 'WHERE dataset_kind = $1 AND investigation_id = $2 ORDER BY reservation_id',
        [fixture.datasetKind, initialCheckpoint.investigation_id],
      ),
      testDatabase.executor.query<Record<string, unknown>>(
        'SELECT * FROM waspada.investigation_progress_snapshots '
          + 'WHERE dataset_kind = $1 AND investigation_id = $2 ORDER BY checkpoint_version',
        [fixture.datasetKind, initialCheckpoint.investigation_id],
      ),
    ]);
    const replay = await coordinator.advance(resumed.advanceInput);
    assert.equal(replay.status, 'review_required');
    if (replay.status !== 'review_required') assert.fail('expected the original resume checkpoint to be stale');
    assert.equal(replay.reason, 'stale_checkpoint');
    assert.deepEqual(await repository.getLatest(fixture.datasetKind, initialCheckpoint.investigation_id), stableCheckpoint);
    const rowsAfterReplay = await Promise.all([
      testDatabase.executor.query<Record<string, unknown>>(
        'SELECT * FROM waspada.investigation_requests '
          + 'WHERE dataset_kind = $1 AND investigation_id = $2',
        [fixture.datasetKind, initialCheckpoint.investigation_id],
      ),
      testDatabase.executor.query<Record<string, unknown>>(
        'SELECT * FROM waspada.investigation_checkpoints '
          + 'WHERE dataset_kind = $1 AND investigation_id = $2 ORDER BY checkpoint_version',
        [fixture.datasetKind, initialCheckpoint.investigation_id],
      ),
      testDatabase.executor.query<Record<string, unknown>>(
        'SELECT * FROM waspada.investigation_action_reservations '
          + 'WHERE dataset_kind = $1 AND investigation_id = $2 ORDER BY reservation_id',
        [fixture.datasetKind, initialCheckpoint.investigation_id],
      ),
      testDatabase.executor.query<Record<string, unknown>>(
        'SELECT * FROM waspada.investigation_progress_snapshots '
          + 'WHERE dataset_kind = $1 AND investigation_id = $2 ORDER BY checkpoint_version',
        [fixture.datasetKind, initialCheckpoint.investigation_id],
      ),
    ]);
    assert.deepEqual(rowsAfterReplay.map(({ rows }) => rows), rowsBeforeReplay.map(({ rows }) => rows),
      'stale-checkpoint replay leaves ledger, checkpoint, reservation, and progress-snapshot rows unchanged');
    assert.deepEqual(portCalls(), { plannerCalls: 1, actionCalls: 1, refreshCalls: 1 },
      'the old checkpoint is rejected as stale before reservation-key replay and invokes no additional ports');
    assert.equal((await readStoredReservation(
      testDatabase,
      fixture.datasetKind,
      initialCheckpoint.investigation_id,
      'reservation-context-resume-plan',
    )).reservation_status, 'reconciled');
    assert.equal((await readStoredReservation(
      testDatabase,
      fixture.datasetKind,
      initialCheckpoint.investigation_id,
      'reservation-context-resume-action',
    )).reservation_status, 'reconciled');
    const reservationCount = await testDatabase.executor.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM waspada.investigation_action_reservations '
        + 'WHERE dataset_kind = $1 AND investigation_id = $2',
      [fixture.datasetKind, initialCheckpoint.investigation_id],
    );
    assert.deepEqual(reservationCount.rows, [{ count: '2' }]);

    const assertionRevisionId = `revision-l3-${suffix}-withdrawn-assertion`;
    const assertionText = 'Synthetic test assertion that the report is withdrawn.';
    await ports.reportRevisions.create({
      datasetKind: fixture.datasetKind,
      reportRevisionId: assertionRevisionId,
      traceId: fixture.traceId,
      sourceId,
      canonicalUrl: `https://synthetic.invalid/${assertionRevisionId}`,
      sourceRevisionKey: null,
      contentHash: sha256(`synthetic-raw-${assertionRevisionId}`),
      permittedText: assertionText,
      permittedTextHash: sha256(assertionText),
      normalizationVersion: 'fixture-normalization-v1',
      publishedAt: null,
      observedAt: TEST_TIME,
      retrievedAt: TEST_TIME,
      validFrom: null,
      validUntil: null,
      supersedesId: null,
      revisionStatus: 'unreviewed',
      recordJson: { fixture: 'synthetic-test-only' },
    });
    await ports.reportRevisionSourceObservations.create({
      datasetKind: fixture.datasetKind,
      observationId: `observation-l3-${suffix}-withdrawn`,
      traceId: fixture.traceId,
      targetReportRevisionId: reportRevisionId,
      assertionReportRevisionId: assertionRevisionId,
      assertedState: 'withdrawn',
      retrievedAt: TEST_TIME,
    });
    const latestCheckpoint = await repository.getLatest(fixture.datasetKind, initialCheckpoint.investigation_id);
    assert.ok(latestCheckpoint);
    await assert.rejects(
      advanceFromCheckpoint(makeResumer(), latestCheckpoint),
      (error: unknown) => {
        assert.ok(error instanceof GroundingContextResumptionError);
        assert.equal(error.code, 'source_invalidated');
        assert.equal(error.message, 'source_invalidated');
        assert.equal(error.message.includes(evidenceText), false);
        return true;
      },
    );
    assert.deepEqual(portCalls(), { plannerCalls: 1, actionCalls: 1, refreshCalls: 1 },
      'source-invalidated evidence stops before a second L3 advance');

    const contextRows = await testDatabase.executor.query<{ context_id: string; record_json: string }>(
      'SELECT context_id, record_json::text AS record_json FROM waspada.grounding_contexts '
        + 'WHERE dataset_kind = $1 AND context_id = ANY($2::text[]) ORDER BY context_id',
      [fixture.datasetKind, [fixture.contextId, refreshedRecord.context_id, staleRecord.context_id]],
    );
    assert.deepEqual(contextRows.rows.map(({ context_id }) => context_id), [
      fixture.contextId, refreshedRecord.context_id, staleRecord.context_id,
    ]);
    const checkpointRows = await testDatabase.executor.query<{ record_json: string }>(
      'SELECT record_json::text AS record_json FROM waspada.investigation_checkpoints '
        + 'WHERE dataset_kind = $1 AND investigation_id = ANY($2::text[]) '
        + 'ORDER BY investigation_id, checkpoint_version',
      [fixture.datasetKind, [initialCheckpoint.investigation_id, staleCheckpoint.investigation_id]],
    );
    const ledgerJson = [
      await readLedgerJson(testDatabase, fixture.datasetKind, initialCheckpoint.investigation_id),
      await readLedgerJson(testDatabase, fixture.datasetKind, staleCheckpoint.investigation_id),
    ].join('\n');
    const durableJson = [
      ...contextRows.rows.map(({ record_json }) => record_json),
      ...checkpointRows.rows.map(({ record_json }) => record_json),
      ledgerJson,
    ].join('\n');
    assert.equal(durableJson.includes(evidenceText), false, 'no refs-only context, checkpoint, or ledger row stores excerpts');
    assert.equal(durableJson.includes(privateActionInput), false, 'the private action input is not durable');
    assert.equal(durableJson.includes(outputReferenceId), false, 'the action output reference is not durable');
    assert.equal(contextRows.rows.some(({ record_json }) => record_json.includes('"text"')), false);

    assert.deepEqual(await readProtectedWriteCounts(), protectedWritesBefore,
      'the test leaves publication, decision, outbox, and public-history review counts unchanged');
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

async function seedRoundtripFixture(testDatabase: TestDatabase) {
  const fixture: FixtureContext = {
    datasetKind: 'synthetic',
    candidateId: 'candidate-l3-coordinator-roundtrip',
    contextId: 'context-l3-coordinator-roundtrip-initial',
    traceId: 'trace-l3-coordinator-roundtrip',
  };
  const sourceId = 'source-l3-coordinator-roundtrip';
  const reportRevisionId = 'revision-l3-coordinator-roundtrip';
  const originId = 'origin-l3-coordinator-roundtrip';
  const featureId = 'l3-roundtrip-feature';
  const fixtureUrl = 'https://synthetic.invalid/l3/coordinator-roundtrip';
  const authoredText = 'Synthetic authored report: the bridge remains open at the main crossing.';
  const selectedSpan = 'the bridge remains open';
  const selectedStart = Array.from(authoredText.slice(0, authoredText.indexOf(selectedSpan))).length;
  const selectedEnd = selectedStart + Array.from(selectedSpan).length;
  const publishedAt = '2026-09-26T12:34:56.123456+05:30';
  const observedAt = '2026-09-26T08:09:10.000007-04:00';
  const retrievedAt = '2026-09-26T13:14:15.987654+07:00';
  const eventTime = '2026-09-24T09:01:02.123456+02:00';
  const ports = createRepositoryPorts(testDatabase.executor);
  await ports.tracesAndAudit.createTrace({
    traceId: fixture.traceId,
    datasetKind: fixture.datasetKind,
    startedAt: TEST_TIME,
    endedAt: null,
    outcome: 'open',
    metadata: { fixture: 'synthetic-l1-l2-roundtrip-test' },
  });
  await testDatabase.executor.query(
    'INSERT INTO waspada.source_registry '
      + '(source_id, trace_id, registry_version, display_name, source_kind, remit, '
      + 'access_method, approved_hosts, access_restrictions, reuse_basis, registry_status, '
      + 'approval_status, health_status, auto_acquisition_enabled, auto_publication_policy) '
      + 'VALUES ($1, $2, 1, $3, $4, $5, $6, $7::text[], $8::text[], $9::text[], '
      + '$10, $11, $12, $13, $14)',
    [sourceId, fixture.traceId, 'Synthetic coordinator round-trip source', 'other',
      ['authored synthetic integration fixture'], 'manual_fixture', [],
      ['synthetic-only'], ['authored synthetic report'], 'active', 'approved', 'unknown', false, 'never'],
  );
  const manifest: SyntheticReportManifest = {
    candidateId: fixture.candidateId,
    reportRevisionId,
    sourceId,
    canonicalUrl: fixtureUrl,
    contentHash: sha256('synthetic coordinator round-trip source payload'),
    permittedText: authoredText,
    publishedAt,
    observedAt,
    validFrom: null,
    validUntil: null,
    supersedesId: null,
    supportSpans: [{ spanStart: selectedStart, spanEnd: selectedEnd }],
  };
  const syntheticFixture: SyntheticFixture = {
    url: fixtureUrl,
    geoJson: JSON.stringify({
      type: 'FeatureCollection',
      features: [{
        type: 'Feature',
        id: featureId,
        properties: { status: 'transient-only', report_type: 'transient-only' },
        geometry: null,
      }],
    }),
    retrievedAt,
    sourceId,
    manifests: new Map([[featureId, manifest]]),
  };
  const prepared = await preparePermittedText(authoredText);
  const recordJson = {
    schema_version: '2.0',
    trace_id: fixture.traceId,
    record_type: 'ReportRevision',
    dataset_kind: fixture.datasetKind,
    report_revision_id: reportRevisionId,
    source_id: sourceId,
    canonical_url: fixtureUrl,
    source_revision_key: null,
    content_hash: manifest.contentHash,
    permitted_text: prepared.permittedText,
    permitted_text_hash: prepared.permittedTextHash,
    normalization_version: prepared.normalizationVersion,
    published_at: publishedAt,
    observed_at: observedAt,
    retrieved_at: retrievedAt,
    validity: { valid_from: null, valid_until: null },
    supersedes_id: null,
    revision_status: 'unreviewed',
  };
  await ports.reportRevisions.create({
    datasetKind: fixture.datasetKind,
    reportRevisionId,
    traceId: fixture.traceId,
    sourceId,
    canonicalUrl: fixtureUrl,
    sourceRevisionKey: null,
    contentHash: manifest.contentHash,
    permittedText: prepared.permittedText,
    permittedTextHash: prepared.permittedTextHash,
    normalizationVersion: prepared.normalizationVersion,
    publishedAt,
    observedAt,
    retrievedAt,
    validFrom: null,
    validUntil: null,
    supersedesId: null,
    revisionStatus: 'unreviewed',
    recordJson,
  });
  const extractorCalls = { count: 0 };
  const extractorProvider: UntrustedModelProvider = {
    async classify() { throw new Error('unused synthetic classification'); },
    async extract(request: ExtractionRequest) {
      extractorCalls.count += 1;
      assert.equal(request.data.candidateId, fixture.candidateId);
      assert.equal(request.data.report.reportRevisionId, reportRevisionId);
      return {
        output: {
          category: 'transport_road_incidents',
          tags: [],
          eventTime: { start: eventTime, end: eventTime, precision: 'exact' },
          scope: { placeIds: [], serviceIds: [], institutionIds: [], audienceIds: [], geometryIds: [] },
          evidence: [{
            reportRevisionId,
            permittedTextHash: request.data.report.permittedTextHash,
            spanStart: selectedStart,
            spanEnd: selectedEnd,
            offsetUnit: 'unicode_code_points',
            relation: 'supports',
          }],
          unknownFields: [],
        },
        usage: { inputTokens: 13, outputTokens: 5 },
      };
    },
    async embed() { throw new Error('unused synthetic embedding'); },
    async reason() { throw new Error('unused synthetic reasoning'); },
  };
  const fixturePorts: FixturePipelinePorts = {
    acquisitionJobs: ports.acquisitionJobs,
    sourceRegistry: ports.sourceRegistry,
    modelAdapter: createModelCapabilityAdapter(extractorProvider, {
      extraction: {
        provider: 'synthetic-l3-roundtrip-provider',
        modelVersion: 'synthetic-l3-roundtrip-extractor-v1',
        promptVersion: 'synthetic-l3-roundtrip-prompt-v1',
      },
    }),
    reportRevisions: ports.reportRevisions,
    extractionResults: ports.extractionResults,
    evidenceChunks: ports.evidenceChunks,
    geometryWriter: createSqlGeometryWriter(testDatabase.executor),
  };
  const baselineExtraction = await fixturePorts.modelAdapter.extract({
    data: {
      candidateId: fixture.candidateId,
      report: {
        reportRevisionId,
        permittedTextHash: prepared.permittedTextHash,
        normalizationVersion: prepared.normalizationVersion,
        permittedText: prepared.permittedText,
      },
    },
  });
  assert.equal(baselineExtraction.status, 'succeeded');
  if (baselineExtraction.status !== 'succeeded') {
    assert.fail('expected the deterministic synthetic extraction baseline');
  }
  const evidenceReferenceIds: string[] = [];
  for (const reference of baselineExtraction.value.evidence) {
    evidenceReferenceIds.push(await ports.reportRevisions.createEvidenceReference({
      datasetKind: fixture.datasetKind,
      traceId: fixture.traceId,
      reportRevisionId: reference.reportRevisionId,
      permittedTextHash: reference.permittedTextHash,
      spanStart: reference.spanStart,
      spanEnd: reference.spanEnd,
      relation: reference.relation,
    }));
  }
  assert.equal(evidenceReferenceIds.length, 1, 'the authored synthetic extraction has one exact support reference');
  const evidenceReferenceId = evidenceReferenceIds[0]!;
  await testDatabase.executor.query(
    `INSERT INTO waspada.evidence_origins
       (dataset_kind, origin_id, trace_id, origin_kind, source_id, lineage_relation,
        independence_status, record_json)
     VALUES ($1, $2, $3, 'unknown', $4, 'unknown', 'unknown',
        '{"fixture":"authored-synthetic-only","lineage":"unknown"}'::jsonb)`,
    [fixture.datasetKind, originId, fixture.traceId, sourceId],
  );
  await testDatabase.executor.query(
    'INSERT INTO waspada.origin_report_revisions (dataset_kind, origin_id, report_revision_id) '
      + 'VALUES ($1, $2, $3)',
    [fixture.datasetKind, originId, reportRevisionId],
  );
  await testDatabase.executor.query(
    'INSERT INTO waspada.origin_evidence (dataset_kind, origin_id, evidence_ref_id) VALUES ($1, $2, $3)',
    [fixture.datasetKind, originId, evidenceReferenceId],
  );
  await ports.extractionResults.createOrVerify({
    schema_version: '2.0',
    trace_id: fixture.traceId,
    record_type: 'ExtractionResult',
    dataset_kind: fixture.datasetKind,
    candidate_id: fixture.candidateId,
    report_revision_id: reportRevisionId,
    category: baselineExtraction.value.category,
    tags: baselineExtraction.value.tags.map(({ namespace, value }) => ({ namespace, value })),
    event_time: {
      start: baselineExtraction.value.eventTime.start,
      end: baselineExtraction.value.eventTime.end,
      precision: baselineExtraction.value.eventTime.precision,
    },
    scope: {
      place_ids: [...baselineExtraction.value.scope.placeIds],
      service_ids: [...baselineExtraction.value.scope.serviceIds],
      institution_ids: [...baselineExtraction.value.scope.institutionIds],
      audience_ids: [...baselineExtraction.value.scope.audienceIds],
      geometry_ids: [...baselineExtraction.value.scope.geometryIds],
    },
    evidence: baselineExtraction.value.evidence.map((reference) => ({
      report_revision_id: reference.reportRevisionId,
      permitted_text_hash: reference.permittedTextHash,
      span_start: reference.spanStart,
      span_end: reference.spanEnd,
      offset_unit: reference.offsetUnit,
      relation: reference.relation,
    })),
    unknown_fields: [...baselineExtraction.value.unknownFields],
    model_run: {
      capability: 'extraction',
      model_version: baselineExtraction.value.modelRun.modelVersion,
      prompt_version: baselineExtraction.value.modelRun.promptVersion,
      input_tokens: baselineExtraction.value.modelRun.inputTokens,
      output_tokens: baselineExtraction.value.modelRun.outputTokens,
    },
  });
  const queued = await ports.acquisitionJobs.enqueueModeratorSubmission({
    datasetKind: fixture.datasetKind,
    idempotencyKey: 'synthetic-l3-roundtrip:one',
    traceId: fixture.traceId,
    requestedBy: 'synthetic-l3-roundtrip-test',
    submittedUrl: fixtureUrl,
    requestedAt: '2026-09-25T10:00:00Z',
  });
  assert.equal(queued.outcome, 'enqueued');
  if (queued.outcome !== 'enqueued') assert.fail('expected one synthetic moderator fixture job');
  return {
    fixture,
    sourceId,
    reportRevisionId,
    originId,
    evidenceReferenceId,
    selectedStart,
    selectedEnd,
    selectedSpan,
    authoredText,
    eventTime,
    publishedAt,
    observedAt,
    retrievedAt,
    fixturePorts,
    fixtureCatalog: new InMemorySyntheticFixtureCatalog([syntheticFixture]),
    queued,
    extractorCalls,
    ports,
  };
}

async function seedFixture(
  testDatabase: TestDatabase,
  suffix: string,
  options: { readonly sufficient: boolean; readonly seedContext?: boolean },
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
  if (options.seedContext !== false) {
    await testDatabase.executor.query(
      `INSERT INTO waspada.grounding_contexts
         (dataset_kind, context_id, trace_id, candidate_id, retrieval_version,
          index_version, sufficient, record_json)
       VALUES ($1, $2, $3, $4, 'retrieval-synthetic-test-v1', 'index-synthetic-test-v1', $5, $6::jsonb)`,
      [datasetKind, contextId, traceId, candidateId, options.sufficient,
        JSON.stringify({ record_type: 'GroundingContext', fixture: 'synthetic-test-only' })],
    );
  }
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

function makeCoordinatorReasoningRequest(
  fixture: FixtureContext,
  contextId: string,
  missingFields: readonly string[],
) {
  return {
    data: {
      groundingContext: {
        schemaVersion: '2.0',
        recordType: 'GroundingContext',
        datasetKind: fixture.datasetKind,
        traceId: fixture.traceId,
        contextId,
        candidateId: fixture.candidateId,
        evidence: [],
        revisionStates: [],
        candidateEvents: [],
        priorDecisionIds: [],
        missingFields: [...missingFields],
        conflicts: [],
        retrievalVersion: 'retrieval-synthetic-coordinator-v1',
        indexVersion: 'index-synthetic-coordinator-v1',
        sufficient: false,
      },
    },
  };
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

function fixedCoordinatorReasoningResult(
  context: GroundingContext,
  eventTime: string,
): ReasoningResult {
  const evidence = context.evidence[0];
  assert.ok(evidence);
  return {
    outcome: 'proposed',
    claims: [{
      text: 'The authored synthetic notice states that the bridge remains open.',
      eventTime: { precision: 'exact', start: eventTime, end: null },
      validity: { validFrom: null, validUntil: null },
      scope: { placeIds: [], serviceIds: [], institutionIds: [], audienceIds: [], geometryIds: [] },
      qualifiers: [],
      support: [evidence.reference],
      contradictions: [],
      contextEvidence: [],
      supportAssessment: 'uncertain',
    }],
    unresolvedFields: [...context.missingFields],
    conflicts: [...context.conflicts],
    modelRun: {
      capability: 'reasoning',
      modelVersion: 'synthetic-l3-composition-reasoner-v1',
      promptVersion: 'synthetic-l3-composition-prompt-v1',
      inputTokens: 17,
      outputTokens: 8,
    },
    provider: 'synthetic-test-provider',
  };
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

async function assertLedgerError(
  code: InvestigationLedgerError['code'],
  work: Promise<unknown>,
  message?: string,
): Promise<void> {
  await assert.rejects(work,
    (error: unknown) => error instanceof InvestigationLedgerError && error.code === code,
    message);
}
