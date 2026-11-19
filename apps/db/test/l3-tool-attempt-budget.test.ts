import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { applyMigrations, readMigrations } from '../src/migrations.js';
import {
  createSqlInvestigationLedgerRepository,
  InvestigationLedgerError,
  type CreateInvestigationInput,
  type InvestigationCheckpointRecord,
  type InvestigationLedgerRepository,
} from '../src/investigation-ledger.js';
import { createTestDatabase, type TestDatabase } from './harness.js';

/**
 * NFR-02 (tool attempts), database level. The default L3 limits are 5 tool attempts, 4 reasoning turns, 60 active
 * seconds and 12,000 model tokens. The ledger refuses any reservation where consumed plus reserved would pass a
 * limit. A tool attempt counts when its reservation is reconciled, whatever the outcome, so a failed or timed-out
 * attempt uses budget. A reservation that was never invoked can be released and gives its attempt back.
 * Synthetic fixtures only.
 */

const DATASET = 'synthetic' as const;
const KEY_ID = 'fixture-hmac-v1';
const LIMITS = { toolAttempts: 5, reasoningTurns: 4, activeSeconds: 60, modelTokens: 12_000 };
const ZERO = { tool_attempts: 0, reasoning_turns: 0, active_seconds: 0, model_tokens: 0 };

function digest(value: string): string {
  return createHash('sha256').update(`fixture-digest:${value}`, 'utf8').digest('hex');
}

function fingerprint(value: string) {
  return { keyId: KEY_ID, digestHex: digest(value) };
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

describe('NFR-02 L3 tool-attempt budget (database)', () => {
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
    const permittedText = 'Synthetic NFR-02 budget fixture evidence';
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
      investigationId: `investigation-nfr02-${suffix}`,
      traceId,
      candidateId,
      contextId,
      fingerprintKeyId: KEY_ID,
      initialGroundingDigestHex: digest(`initial-${suffix}`),
      eventId: null,
      eventVersion: null,
      questions: ['Which synthetic detail is still unknown?'],
      policyVersion: 'budget-policy-v1',
      limits: { ...LIMITS },
      requestedAt: '2026-09-25T10:00:10Z',
    };
  }

  /** Reserves, starts and reconciles one tool attempt. Returns the checkpoint after reconciliation. */
  async function runToolAttempt(
    investigationId: string,
    version: number,
    index: number,
    outcome: 'succeeded' | 'failed' | 'timed_out',
    minute: number = index,
  ): Promise<InvestigationCheckpointRecord> {
    const clock = `2026-09-25T10:0${minute}`;
    const reservationId = `reservation-${investigationId}-${index}`;
    const reserved = await ledger.reserveAction({
      datasetKind: DATASET,
      investigationId,
      reservationId,
      expectedCheckpointVersion: version,
      actionKind: 'tool',
      actionFingerprint: fingerprint(`lookup.${index}`),
      actionName: `lookup.${index}`,
      reservedActiveSeconds: 10,
      reservedModelTokens: 0,
      reservedAt: `${clock}:00Z`,
    });
    assert.equal(reserved.mayInvoke, false, 'a reservation alone never authorizes the call');
    const started = await ledger.startAction({
      datasetKind: DATASET,
      investigationId,
      reservationId,
      startedAt: `${clock}:01Z`,
    });
    assert.equal(started.mayInvoke, true, 'the reservation starts exactly one invocation');
    const reconciled = await ledger.reconcileAction({
      datasetKind: DATASET,
      investigationId,
      reservationId,
      expectedCheckpointVersion: reserved.checkpoint.checkpoint_version,
      outcome,
      actualActiveSeconds: 4,
      actualModelTokens: 0,
      finishedAt: `${clock}:05Z`,
    });
    return reconciled.checkpoint;
  }

  async function assertBudgetExhausted(work: Promise<unknown>, message?: string): Promise<void> {
    await assert.rejects(work, (error: unknown) => {
      assert.ok(error instanceof InvestigationLedgerError, 'the refusal is a typed ledger error');
      assert.equal(error.code, 'budget_exhausted');
      return true;
    }, message);
  }

  it('five tool attempts exhaust the default budget, failed and timed-out attempts included, and a sixth is refused', async () => {
    const input = await seedInsufficientCase('five');
    const created = await ledger.create(input);
    assert.equal(created.budget.limits.tool_attempts, 5, 'the default tool-attempt limit is 5');

    const outcomes = ['failed', 'succeeded', 'timed_out', 'failed', 'failed'] as const;
    let version = created.checkpoint_version;
    for (const [index, outcome] of outcomes.entries()) {
      const checkpoint = await runToolAttempt(input.investigationId, version, index + 1, outcome);
      assert.equal(checkpoint.budget.consumed.tool_attempts, index + 1, `attempt ${index + 1} is charged once`);
      assert.equal(checkpoint.budget.reserved.tool_attempts, 0, 'no attempt stays reserved after reconciliation');
      version = checkpoint.checkpoint_version;
    }

    const exhausted = await ledger.getLatest(DATASET, input.investigationId);
    assert.ok(exhausted);
    assert.deepEqual(exhausted.budget.consumed, { ...ZERO, tool_attempts: 5, active_seconds: 20 });
    assert.deepEqual(exhausted.attempts.map((attempt) => attempt.outcome), [...outcomes],
      'every failed or timed-out attempt is kept in the ledger, not dropped');

    await assertBudgetExhausted(ledger.reserveAction({
      datasetKind: DATASET,
      investigationId: input.investigationId,
      reservationId: 'reservation-sixth-attempt',
      expectedCheckpointVersion: version,
      actionKind: 'tool',
      actionFingerprint: fingerprint('lookup.sixth'),
      actionName: 'lookup.sixth',
      reservedActiveSeconds: 1,
      reservedModelTokens: 0,
      reservedAt: '2026-09-25T10:09:00Z',
    }));
    const afterRefusal = await ledger.getLatest(DATASET, input.investigationId);
    assert.deepEqual(afterRefusal, exhausted, 'the refused sixth attempt writes nothing');
    assert.equal(await ledger.getActionReservation(DATASET, input.investigationId, 'reservation-sixth-attempt'), null,
      'no reservation row exists for the refused attempt');
  });

  it('the stopped case records limit_exhausted and no later attempt is reserved', async () => {
    const input = await seedInsufficientCase('stop');
    const created = await ledger.create(input);
    let version = created.checkpoint_version;
    for (let index = 1; index <= 5; index += 1) {
      const checkpoint = await runToolAttempt(input.investigationId, version, index, 'failed');
      version = checkpoint.checkpoint_version;
    }

    const stopped = await ledger.terminate({
      datasetKind: DATASET,
      investigationId: input.investigationId,
      expectedCheckpointVersion: version,
      status: 'stopped_for_review',
      stopReason: 'limit_exhausted',
      completedAt: '2026-09-25T10:10:00Z',
    });
    assert.equal(stopped.checkpoint.case_status, 'stopped_for_review');
    assert.equal(stopped.checkpoint.stop_reason, 'limit_exhausted');
    assert.equal(stopped.checkpoint.budget.consumed.tool_attempts, 5);
  });

  it('a reserved attempt that was never invoked is released and gives its place back, so only invoked attempts use the budget', async () => {
    const input = await seedInsufficientCase('release');
    const created = await ledger.create(input);
    let version = created.checkpoint_version;
    for (let index = 1; index <= 4; index += 1) {
      version = (await runToolAttempt(input.investigationId, version, index, 'failed')).checkpoint_version;
    }

    const pending = await ledger.reserveAction({
      datasetKind: DATASET,
      investigationId: input.investigationId,
      reservationId: 'reservation-release-fifth',
      expectedCheckpointVersion: version,
      actionKind: 'tool',
      actionFingerprint: fingerprint('lookup.release'),
      actionName: 'lookup.release',
      reservedActiveSeconds: 10,
      reservedModelTokens: 0,
      reservedAt: '2026-09-25T10:05:00Z',
    });
    assert.equal(pending.checkpoint.budget.consumed.tool_attempts, 4);
    assert.equal(pending.checkpoint.budget.reserved.tool_attempts, 1);
    await assert.rejects(ledger.reserveAction({
      datasetKind: DATASET,
      investigationId: input.investigationId,
      reservationId: 'reservation-while-in-flight',
      expectedCheckpointVersion: pending.checkpoint.checkpoint_version,
      actionKind: 'tool',
      actionFingerprint: fingerprint('lookup.while-in-flight'),
      actionName: 'lookup.while-in-flight',
      reservedActiveSeconds: 1,
      reservedModelTokens: 0,
      reservedAt: '2026-09-25T10:05:01Z',
    }), (error: unknown) => error instanceof InvestigationLedgerError && error.code === 'reservation_in_flight',
    'a second reservation waits while the fifth is in flight');

    const released = await ledger.releaseUninvoked({
      datasetKind: DATASET,
      investigationId: input.investigationId,
      reservationId: 'reservation-release-fifth',
      expectedCheckpointVersion: pending.checkpoint.checkpoint_version,
      releasedAt: '2026-09-25T10:05:02Z',
    });
    assert.equal(released.checkpoint.budget.consumed.tool_attempts, 4, 'the released attempt was never charged');
    assert.equal(released.checkpoint.budget.reserved.tool_attempts, 0, 'its place is given back');

    const fifth = await runToolAttempt(input.investigationId, released.checkpoint.checkpoint_version, 5, 'succeeded', 7);
    assert.equal(fifth.budget.consumed.tool_attempts, 5, 'the fifth attempt fits once the released place is free');
    assert.equal(fifth.budget.reserved.tool_attempts, 0);

    await assertBudgetExhausted(ledger.reserveAction({
      datasetKind: DATASET,
      investigationId: input.investigationId,
      reservationId: 'reservation-after-fifth',
      expectedCheckpointVersion: fifth.checkpoint_version,
      actionKind: 'tool',
      actionFingerprint: fingerprint('lookup.after'),
      actionName: 'lookup.after',
      reservedActiveSeconds: 1,
      reservedModelTokens: 0,
      reservedAt: '2026-09-25T10:08:00Z',
    }), 'after five invoked attempts a sixth is refused');
  });
});
