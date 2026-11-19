import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { applyMigrations, readMigrations } from '../src/migrations.js';
import {
  createSqlInvestigationLedgerRepository,
  type BudgetCounters,
  type CreateInvestigationInput,
  type InvestigationCheckpointRecord,
  type InvestigationLedgerRepository,
} from '../src/investigation-ledger.js';
import { createTestDatabase, type TestDatabase } from './harness.js';
import { createL3FingerprintService } from '../../worker/src/layers/l3-investigation/progress-fingerprint.js';
import {
  createReasoningStepExecutor,
  type ReasoningStepExecutor,
  type ReasoningStepExecutorClock,
  type ReasoningStepExecutorResult,
  type ReasoningStepExecutorTimer,
} from '../../worker/src/layers/l3-investigation/reasoning-step-executor.js';
import {
  INVESTIGATION_PLAN_CAPABILITY,
  type InvestigationPlanner,
  type InvestigationPlanRequest,
  type InvestigationPlannerOutcome,
  type InvestigationPlannerPreflightOutcome,
} from '../../worker/src/layers/l2-model-grounding/investigation-planner.js';

/**
 * NFR-02 (reasoning turns, active time, model tokens), database level. The real reasoning step executor and the real
 * SQL investigation ledger run on PGlite. The planner is a fake model with a fake clock, so no provider is called.
 * The ledger's default limits are 5 tool attempts, 4 reasoning turns, 60 active seconds and 12,000 model tokens.
 * Each planning call reserves its full trusted maximum before the model is called. A successful call is charged its
 * measured active seconds and tokens. A failed or timed-out call is charged the full reservation, so a failure counts
 * against the budget. The tool-attempt cap is covered by l3-tool-attempt-budget.test.ts and is not repeated here.
 * Synthetic fixtures only.
 */

const DATASET = 'synthetic' as const;
const KEY_ID = 'fixture-hmac-v1';
const LIMITS = { toolAttempts: 5, reasoningTurns: 4, activeSeconds: 60, modelTokens: 12_000 };
const FINGERPRINTS = createL3FingerprintService({ keyId: KEY_ID, keyMaterial: new Uint8Array(32).fill(47) });
const START_MS = Date.parse('2026-09-25T10:05:00.000Z');

function digest(value: string): string {
  return createHash('sha256').update(`fixture-digest:${value}`, 'utf8').digest('hex');
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** A fake clock. Both the wall and the monotonic reading move only when the fake model advances them. */
class FakeClock implements ReasoningStepExecutorClock {
  private wallMs = START_MS;
  private monotonicMs = 0;

  wallNow(): string {
    return new Date(this.wallMs).toISOString();
  }

  monotonicNow(): number {
    return this.monotonicMs;
  }

  advanceSeconds(seconds: number): void {
    this.wallMs += seconds * 1_000;
    this.monotonicMs += seconds * 1_000;
  }
}

/** A timer that never fires, so every call here ends by its planner result or its error. */
const quietTimer: ReasoningStepExecutorTimer = {
  setTimeout: () => ({}),
  clearTimeout: () => undefined,
};

/** The planner request for one case. It is insufficient, has no event, and names the two questions the case records. */
function requestFor(suffix: string): InvestigationPlanRequest {
  return {
    schemaVersion: '1.0',
    recordType: 'InvestigationPlanRequest',
    groundingContext: {
      schemaVersion: '2.0',
      recordType: 'GroundingContext',
      datasetKind: DATASET,
      traceId: `trace-nfr02-${suffix}`,
      contextId: `context-nfr02-${suffix}`,
      candidateId: `candidate-nfr02-${suffix}`,
      evidence: [],
      revisionStates: [],
      candidateEvents: [],
      priorDecisionIds: [],
      missingFields: ['missing_field_1'],
      conflicts: ['conflict_1'],
      retrievalVersion: 'retrieval_synthetic_v1',
      indexVersion: 'index_synthetic_v1',
      sufficient: false,
    },
    questions: ['missing_field_1', 'conflict_1'],
    actionMenu: [
      { name: 'synthetic_search', description: 'Search the synthetic source index.' },
      { name: 'gazetteer_lookup', description: 'Resolve a synthetic place name.' },
    ],
  } as unknown as InvestigationPlanRequest;
}

function proposedPlan() {
  return {
    schemaVersion: '1.0',
    recordType: 'InvestigationPlanResult',
    outcome: 'proposed',
    actionName: 'synthetic_search',
    input: { query: 'synthetic service status' },
  };
}

interface FakeModel {
  readonly planner: InvestigationPlanner;
  readonly calls: { count: number };
}

/**
 * A fake model. Each call advances the clock by `seconds`. A successful call reports `totalTokens` of usage. A failing
 * call throws, which the executor records as a failed attempt.
 */
function fakeModel(clock: FakeClock, config: { readonly seconds: number; readonly totalTokens: number; readonly fail?: boolean }): FakeModel {
  const calls = { count: 0 };
  const planner: InvestigationPlanner = {
    async preflight(request): Promise<InvestigationPlannerPreflightOutcome> {
      return { status: 'ready', capability: INVESTIGATION_PLAN_CAPABILITY, request } as InvestigationPlannerPreflightOutcome;
    },
    async propose(): Promise<InvestigationPlannerOutcome> {
      calls.count += 1;
      clock.advanceSeconds(config.seconds);
      if (config.fail) throw new Error('synthetic provider failure');
      const inputTokens = Math.floor(config.totalTokens / 2);
      return {
        status: 'succeeded',
        capability: INVESTIGATION_PLAN_CAPABILITY,
        value: proposedPlan(),
        usage: {
          inputTokens,
          outputTokens: config.totalTokens - inputTokens,
          totalTokens: config.totalTokens,
          modelVersion: 'synthetic-model-v3',
          promptVersion: 'synthetic-prompt-v2',
        },
      } as unknown as InvestigationPlannerOutcome;
    },
  };
  return { planner, calls };
}

describe('NFR-02 L3 reasoning, active-time and token budget (database)', () => {
  let db: TestDatabase;
  let ledger: InvestigationLedgerRepository;

  before(async () => {
    db = await createTestDatabase();
    const migrations = await readMigrations(new URL('../migrations/', import.meta.url));
    await applyMigrations(db.executor, migrations);
    ledger = createSqlInvestigationLedgerRepository(db.executor);
  });

  after(async () => {
    await db?.close();
  });

  /** One insufficient grounding context per case, so each case has its own investigation. */
  async function seedInsufficientCase(suffix: string): Promise<CreateInvestigationInput> {
    const seedTrace = `trace-nfr02-seed-${suffix}`;
    const traceId = `trace-nfr02-${suffix}`;
    const sourceId = `source-nfr02-${suffix}`;
    const revisionId = `revision-nfr02-${suffix}`;
    const candidateId = `candidate-nfr02-${suffix}`;
    const contextId = `context-nfr02-${suffix}`;
    const permittedText = 'Synthetic NFR-02 reasoning budget fixture evidence';
    const at = '2026-09-25T10:00:00Z';

    await db.executor.query(
      `INSERT INTO waspada.traces (trace_id, dataset_kind, started_at, outcome, metadata)
       VALUES ($1, $3, $4::timestamptz, 'open', '{"fixture":"synthetic-test-only"}'::jsonb),
              ($2, $3, $4::timestamptz, 'open', '{"fixture":"synthetic-test-only"}'::jsonb)`,
      [seedTrace, traceId, DATASET, at],
    );
    await db.executor.query(
      `INSERT INTO waspada.source_registry
         (source_id, trace_id, registry_version, display_name, source_kind, remit,
          access_method, approved_hosts, access_restrictions, reuse_basis, registry_status,
          approval_status, health_status, auto_acquisition_enabled, auto_publication_policy)
       VALUES ($1, $2, 1, 'Synthetic test fixture', 'other', ARRAY['test fixture'],
          'manual_fixture', ARRAY[]::text[], ARRAY['synthetic-only'], ARRAY['test fixture'],
          'active', 'pending', 'unknown', false, 'never')`,
      [sourceId, seedTrace],
    );
    await db.executor.query(
      `INSERT INTO waspada.report_revisions
         (dataset_kind, report_revision_id, trace_id, source_id, canonical_url,
          content_hash, permitted_text, permitted_text_hash, normalization_version,
          retrieved_at, revision_status, record_json)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'fixture-normalization-v1',
          $9::timestamptz, 'unreviewed', $10::jsonb)`,
      [DATASET, revisionId, seedTrace, sourceId, `https://synthetic.invalid/${suffix}`,
        sha256(`synthetic raw fixture ${suffix}`), permittedText, sha256(permittedText), at,
        JSON.stringify({ fixture: 'synthetic-test-only' })],
    );
    await db.executor.query(
      `INSERT INTO waspada.extraction_results
         (dataset_kind, candidate_id, trace_id, report_revision_id, record_json)
       VALUES ($1, $2, $3, $4, $5::jsonb)`,
      [DATASET, candidateId, seedTrace, revisionId,
        JSON.stringify({ record_type: 'ExtractionResult', fixture: 'synthetic-test-only' })],
    );
    await db.executor.query(
      `INSERT INTO waspada.grounding_contexts
         (dataset_kind, context_id, trace_id, candidate_id, retrieval_version,
          index_version, sufficient, record_json)
       VALUES ($1, $2, $3, $4, 'retrieval-synthetic-test-v1', 'index-synthetic-test-v1', false, $5::jsonb)`,
      [DATASET, contextId, traceId, candidateId,
        JSON.stringify({ record_type: 'GroundingContext', fixture: 'synthetic-test-only' })],
    );

    return {
      datasetKind: DATASET,
      investigationId: `investigation-nfr02-reasoning-${suffix}`,
      traceId,
      candidateId,
      contextId,
      fingerprintKeyId: KEY_ID,
      initialGroundingDigestHex: digest(`initial-${suffix}`),
      eventId: null,
      eventVersion: null,
      questions: ['missing_field_1', 'conflict_1'],
      policyVersion: 'budget-policy-v1',
      limits: { ...LIMITS },
      requestedAt: '2026-09-25T10:00:10Z',
    };
  }

  function executorFor(model: FakeModel, clock: FakeClock, maxActiveSeconds: number, maxModelTokens: number, repository = ledger): ReasoningStepExecutor {
    return createReasoningStepExecutor({
      ledger: repository,
      fingerprints: FINGERPRINTS,
      planner: model.planner,
      maxActiveSeconds,
      maxModelTokens,
      clock,
      timer: quietTimer,
    });
  }

  /** One planning call against the case's current checkpoint. Each call uses a new reservation id. */
  async function planOnce(
    executor: ReasoningStepExecutor,
    clock: FakeClock,
    investigationId: string,
    suffix: string,
    index: number,
  ): Promise<ReasoningStepExecutorResult> {
    const latest = await ledger.getLatest(DATASET, investigationId);
    assert.ok(latest, 'the investigation exists');
    return executor.plan({
      datasetKind: DATASET,
      investigationId,
      expectedCheckpointVersion: latest.checkpoint_version,
      reservationId: `reservation-nfr02-${suffix}-${index}`,
      reservedAt: clock.wallNow(),
      request: requestFor(suffix),
    });
  }

  function assertBudgetRefusal(result: ReasoningStepExecutorResult, label: string): void {
    assert.equal(result.status, 'review_required', `${label} is refused`);
    if (result.status !== 'review_required') return;
    assert.equal(result.reason, 'budget_exhausted', `${label} is refused as budget_exhausted`);
  }

  function consumed(checkpoint: InvestigationCheckpointRecord | undefined): BudgetCounters {
    assert.ok(checkpoint, 'the result carries the checkpoint');
    return {
      toolAttempts: checkpoint.budget.consumed.tool_attempts,
      reasoningTurns: checkpoint.budget.consumed.reasoning_turns,
      activeSeconds: checkpoint.budget.consumed.active_seconds,
      modelTokens: checkpoint.budget.consumed.model_tokens,
    };
  }

  it('four planning calls run and the fifth is refused as budget_exhausted before the model is called', async () => {
    const suffix = 'turns';
    const input = await seedInsufficientCase(suffix);
    await ledger.create(input);
    const clock = new FakeClock();
    const model = fakeModel(clock, { seconds: 1, totalTokens: 25 });
    const executor = executorFor(model, clock, 15, 3_000);

    for (let index = 1; index <= 4; index += 1) {
      const result = await planOnce(executor, clock, input.investigationId, suffix, index);
      assert.equal(result.status, 'proposed', `planning call ${index} is within the four-turn budget`);
    }
    assert.equal(model.calls.count, 4);

    const callsBeforeRefusal = model.calls.count;
    const fifthReservation = `reservation-nfr02-${suffix}-5`;
    const refused = await planOnce(executor, clock, input.investigationId, suffix, 5);
    assertBudgetRefusal(refused, 'the fifth planning call');
    assert.equal(model.calls.count, callsBeforeRefusal, 'the fifth model call is never made');
    assert.equal(await ledger.getActionReservation(DATASET, input.investigationId, fifthReservation), null,
      'the refused fifth turn writes no reservation row');

    const latest = await ledger.getLatest(DATASET, input.investigationId);
    assert.deepEqual(consumed(latest ?? undefined), {
      toolAttempts: 0, reasoningTurns: 4, activeSeconds: 4, modelTokens: 100,
    }, 'successful calls are charged their measured seconds and tokens');
    assert.equal(latest?.budget.reserved.reasoning_turns, 0, 'nothing stays reserved after the refusal');
  });

  it('the 60-second active-time budget stops the case before a call that would pass it', async () => {
    const suffix = 'seconds';
    const input = await seedInsufficientCase(suffix);
    await ledger.create(input);
    const clock = new FakeClock();
    // Each call runs for 25 s and reserves 30 s. Two calls use 50 s. A third 30 s reservation would reach 80 s.
    const model = fakeModel(clock, { seconds: 25, totalTokens: 25 });
    const executor = executorFor(model, clock, 30, 1_000);

    for (let index = 1; index <= 2; index += 1) {
      assert.equal((await planOnce(executor, clock, input.investigationId, suffix, index)).status, 'proposed');
    }
    const afterTwo = await ledger.getLatest(DATASET, input.investigationId);
    assert.equal(afterTwo?.budget.consumed.active_seconds, 50, 'two calls used 50 of the 60 seconds');

    const callsBeforeRefusal = model.calls.count;
    assertBudgetRefusal(await planOnce(executor, clock, input.investigationId, suffix, 3), 'the third call');
    assert.equal(model.calls.count, callsBeforeRefusal, 'the third model call is never made');
    const afterRefusal = await ledger.getLatest(DATASET, input.investigationId);
    assert.deepEqual(afterRefusal, afterTwo, 'the refused call writes nothing');
  });

  it('a failed call is charged its full active-time reservation, so two failures use 60 seconds and a third is refused', async () => {
    const suffix = 'failed-time';
    const input = await seedInsufficientCase(suffix);
    await ledger.create(input);
    const clock = new FakeClock();
    const model = fakeModel(clock, { seconds: 1, totalTokens: 25, fail: true });
    const executor = executorFor(model, clock, 30, 1_000);

    for (let index = 1; index <= 2; index += 1) {
      const failed = await planOnce(executor, clock, input.investigationId, suffix, index);
      assert.equal(failed.status, 'review_required');
      if (failed.status === 'review_required') assert.equal(failed.reason, 'planner_failed');
    }
    const afterFailures = await ledger.getLatest(DATASET, input.investigationId);
    assert.deepEqual(consumed(afterFailures ?? undefined), {
      toolAttempts: 0, reasoningTurns: 2, activeSeconds: 60, modelTokens: 2_000,
    }, 'each failure is charged the full 30 s and 1,000-token reservation, not the 1 s it ran');

    const callsBeforeRefusal = model.calls.count;
    assertBudgetRefusal(await planOnce(executor, clock, input.investigationId, suffix, 3), 'the third call');
    assert.equal(model.calls.count, callsBeforeRefusal, 'the third model call is never made');
  });

  it('the 12,000-token budget stops the case: failed calls are charged their token reservation, and a third is refused', async () => {
    const suffix = 'tokens';
    const input = await seedInsufficientCase(suffix);
    await ledger.create(input);
    const clock = new FakeClock();
    const model = fakeModel(clock, { seconds: 1, totalTokens: 25, fail: true });
    // 5 s and 5,000 tokens per call. Time is not the binding limit here: four calls would use 20 s.
    const executor = executorFor(model, clock, 5, 5_000);

    for (let index = 1; index <= 2; index += 1) {
      await planOnce(executor, clock, input.investigationId, suffix, index);
    }
    const afterFailures = await ledger.getLatest(DATASET, input.investigationId);
    assert.equal(afterFailures?.budget.consumed.model_tokens, 10_000, 'two failed calls use 10,000 of the 12,000 tokens');

    const callsBeforeRefusal = model.calls.count;
    assertBudgetRefusal(await planOnce(executor, clock, input.investigationId, suffix, 3),
      'a third 5,000-token call (15,000 in all)');
    assert.equal(model.calls.count, callsBeforeRefusal, 'the third model call is never made');
  });

  it('a restarted executor and repository resume with the prior usage, so the same case stays refused', async () => {
    const suffix = 'resume';
    const input = await seedInsufficientCase(suffix);
    await ledger.create(input);
    const clock = new FakeClock();
    const failing = fakeModel(clock, { seconds: 1, totalTokens: 25, fail: true });
    const before = executorFor(failing, clock, 30, 100);
    for (let index = 1; index <= 2; index += 1) {
      await planOnce(before, clock, input.investigationId, suffix, index);
    }
    const beforeRestart = await ledger.getLatest(DATASET, input.investigationId);
    assert.deepEqual(consumed(beforeRestart ?? undefined), {
      toolAttempts: 0, reasoningTurns: 2, activeSeconds: 60, modelTokens: 200,
    });

    // A new process: a new repository on the same database and a new executor with a fresh model double.
    const resumedLedger = createSqlInvestigationLedgerRepository(db.executor);
    const replayed = await resumedLedger.create(input);
    assert.equal(replayed.checkpoint_version, beforeRestart?.checkpoint_version,
      'the create replay returns the stored latest checkpoint, not a fresh one');
    assert.deepEqual(replayed.budget.consumed, beforeRestart?.budget.consumed,
      'a replayed create does not reset the consumed budget');

    const fresh = fakeModel(clock, { seconds: 1, totalTokens: 25 });
    const resumed = executorFor(fresh, clock, 30, 100, resumedLedger);
    assertBudgetRefusal(await planOnce(resumed, clock, input.investigationId, suffix, 3),
      'the resumed call');
    assert.equal(fresh.calls.count, 0, 'the resumed executor never reaches the model');
    const afterResume = await resumedLedger.getLatest(DATASET, input.investigationId);
    assert.deepEqual(afterResume?.budget.consumed, beforeRestart?.budget.consumed,
      'the refused resumed call keeps the prior usage exactly');
  });
});
