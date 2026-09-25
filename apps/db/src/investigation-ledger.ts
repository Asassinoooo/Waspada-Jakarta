import { randomUUID } from 'node:crypto';
import type { DatasetKind } from './ports.js';
import type { SqlExecutor, TransactionalSqlExecutor } from './sql.js';

export interface BudgetCounters {
  readonly toolAttempts: number;
  readonly reasoningTurns: number;
  readonly activeSeconds: number;
  readonly modelTokens: number;
}

export interface BudgetLimits extends BudgetCounters {}

export interface BudgetLedger {
  readonly policyVersion: string;
  readonly limits: BudgetLimits;
  readonly consumed: BudgetCounters;
  readonly reserved: BudgetCounters;
}

export type InvestigationStatus = 'open' | 'paused' | 'completed' | 'stopped_for_review';
export type InvestigationStopReason =
  | 'limit_exhausted'
  | 'no_progress'
  | 'material_conflict'
  | 'tool_unavailable'
  | 'awaiting_moderator'
  | 'completed';
export type ActionKind = 'tool' | 'reasoning';
export type ActionOutcome = 'succeeded' | 'failed' | 'timed_out' | 'denied' | 'cancelled';
export type ReservationStatus = 'reserved' | 'started' | 'reconciled' | 'released';

export interface ModelRun {
  readonly capability: 'reasoning';
  readonly model_version: string | null;
  readonly prompt_version: string | null;
  readonly input_tokens: number;
  readonly output_tokens: number;
}

export interface ToolAttempt {
  readonly attempt_id: string;
  readonly tool: string;
  readonly outcome: ActionOutcome;
  readonly started_at: string;
  readonly finished_at: string;
}

export interface InvestigationRequestRecord {
  readonly schema_version: '2.0';
  readonly trace_id: string;
  readonly record_type: 'InvestigationRequest';
  readonly dataset_kind: DatasetKind;
  readonly investigation_id: string;
  readonly candidate_id: string;
  readonly context_id: string;
  readonly event_id: string | null;
  readonly event_version: number | null;
  readonly questions: readonly string[];
  readonly budget: BudgetLedgerRecord;
  readonly requested_at: string;
}

export interface BudgetCountersRecord {
  readonly tool_attempts: number;
  readonly reasoning_turns: number;
  readonly active_seconds: number;
  readonly model_tokens: number;
}

export interface BudgetLimitsRecord extends BudgetCountersRecord {}

export interface BudgetLedgerRecord {
  readonly policy_version: string;
  readonly limits: BudgetLimitsRecord;
  readonly consumed: BudgetCountersRecord;
  readonly reserved: BudgetCountersRecord;
}

export interface InvestigationCheckpointRecord {
  readonly schema_version: '2.0';
  readonly trace_id: string;
  readonly record_type: 'InvestigationCheckpoint';
  readonly dataset_kind: DatasetKind;
  readonly checkpoint_id: string;
  readonly investigation_id: string;
  readonly checkpoint_version: number;
  readonly candidate_id: string;
  readonly context_id: string;
  readonly event_id: string | null;
  readonly event_version: number | null;
  readonly case_status: InvestigationStatus;
  readonly stop_reason: InvestigationStopReason | null;
  readonly budget: BudgetLedgerRecord;
  readonly attempts: readonly ToolAttempt[];
  readonly reasoning_runs: readonly ModelRun[];
  readonly created_at: string;
  readonly updated_at: string;
  readonly completed_at: string | null;
}

export interface CreateInvestigationInput {
  readonly datasetKind: DatasetKind;
  readonly investigationId: string;
  readonly traceId: string;
  readonly candidateId: string;
  readonly contextId: string;
  readonly eventId: string | null;
  readonly eventVersion: number | null;
  readonly questions: readonly string[];
  readonly policyVersion: string;
  readonly limits: BudgetLimits;
  readonly requestedAt: string;
}

export interface ReserveActionInput {
  readonly datasetKind: DatasetKind;
  readonly investigationId: string;
  readonly reservationId: string;
  readonly expectedCheckpointVersion: number;
  readonly actionKind: ActionKind;
  readonly actionName: string;
  readonly reservedActiveSeconds: number;
  readonly reservedModelTokens: number;
  readonly reservedAt: string;
}

export interface ReconcileActionInput {
  readonly datasetKind: DatasetKind;
  readonly investigationId: string;
  readonly reservationId: string;
  readonly expectedCheckpointVersion: number;
  readonly outcome: ActionOutcome;
  readonly actualActiveSeconds: number;
  readonly actualModelTokens: number;
  readonly finishedAt: string;
  readonly modelRun?: ModelRun;
}

export interface ReservationRecord {
  readonly datasetKind: DatasetKind;
  readonly reservationId: string;
  readonly investigationId: string;
  readonly actionKind: ActionKind;
  readonly actionName: string;
  readonly expectedCheckpointVersion: number;
  readonly reserved: BudgetCounters;
  readonly status: ReservationStatus;
  readonly outcome: ActionOutcome | null;
  readonly actual: Pick<BudgetCounters, 'activeSeconds' | 'modelTokens'>;
  readonly createdAt: string;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly reconciledCheckpointVersion: number | null;
}

export interface ReservationOperationResult {
  readonly reservation: ReservationRecord;
  readonly checkpoint: InvestigationCheckpointRecord;
  /** True only for the first successful reserved-to-started transition. */
  readonly mayInvoke: boolean;
  readonly replayed: boolean;
}

export interface LedgerOperationResult {
  readonly checkpoint: InvestigationCheckpointRecord;
  readonly replayed: boolean;
}

export interface InvestigationLedgerRepository {
  create(input: CreateInvestigationInput): Promise<InvestigationCheckpointRecord>;
  getLatest(datasetKind: DatasetKind, investigationId: string): Promise<InvestigationCheckpointRecord | null>;
  getInFlightReservation(datasetKind: DatasetKind, investigationId: string): Promise<ReservationRecord | null>;
  reserveAction(input: ReserveActionInput): Promise<ReservationOperationResult>;
  startAction(input: {
    readonly datasetKind: DatasetKind;
    readonly investigationId: string;
    readonly reservationId: string;
    readonly startedAt: string;
  }): Promise<ReservationOperationResult>;
  reconcileAction(input: ReconcileActionInput): Promise<LedgerOperationResult>;
  reconcileInterrupted(input: {
    readonly datasetKind: DatasetKind;
    readonly investigationId: string;
    readonly reservationId: string;
    readonly expectedCheckpointVersion: number;
    readonly finishedAt: string;
  }): Promise<LedgerOperationResult>;
  releaseUninvoked(input: {
    readonly datasetKind: DatasetKind;
    readonly investigationId: string;
    readonly reservationId: string;
    readonly expectedCheckpointVersion: number;
    readonly releasedAt: string;
  }): Promise<LedgerOperationResult>;
  pause(input: {
    readonly datasetKind: DatasetKind;
    readonly investigationId: string;
    readonly expectedCheckpointVersion: number;
    readonly pausedAt: string;
  }): Promise<LedgerOperationResult>;
  resume(input: {
    readonly datasetKind: DatasetKind;
    readonly investigationId: string;
    readonly expectedCheckpointVersion: number;
    readonly resumedAt: string;
    readonly contextId?: string;
  }): Promise<LedgerOperationResult>;
  terminate(input: {
    readonly datasetKind: DatasetKind;
    readonly investigationId: string;
    readonly expectedCheckpointVersion: number;
    readonly status: 'completed' | 'stopped_for_review';
    readonly stopReason: InvestigationStopReason;
    readonly completedAt: string;
  }): Promise<LedgerOperationResult>;
}

export type InvestigationLedgerErrorCode =
  | 'invalid_input'
  | 'investigation_not_found'
  | 'context_not_found'
  | 'context_mismatch'
  | 'sufficient_context'
  | 'investigation_conflict'
  | 'stale_checkpoint'
  | 'invalid_state'
  | 'reservation_conflict'
  | 'reservation_in_flight'
  | 'budget_exhausted';

export class InvestigationLedgerError extends Error {
  constructor(readonly code: InvestigationLedgerErrorCode) {
    super(code);
    this.name = 'InvestigationLedgerError';
  }
}

const HARD_LIMITS: BudgetLimits = {
  toolAttempts: 5,
  reasoningTurns: 4,
  activeSeconds: 60,
  modelTokens: 12_000,
};
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const ACTION_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/;
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const ZERO_COUNTERS: BudgetCounters = {
  toolAttempts: 0,
  reasoningTurns: 0,
  activeSeconds: 0,
  modelTokens: 0,
};

interface RequestRow {
  dataset_kind: DatasetKind;
  investigation_id: string;
  trace_id: string;
  candidate_id: string;
  context_id: string;
  event_id: string | null;
  event_version: number | null;
  questions: string[];
  budget_policy_version: string;
  limit_tool_attempts: number;
  limit_reasoning_turns: number;
  limit_active_seconds: number;
  limit_model_tokens: number;
  consumed_tool_attempts: number;
  consumed_reasoning_turns: number;
  consumed_active_seconds: number;
  consumed_model_tokens: number;
  reserved_tool_attempts: number;
  reserved_reasoning_turns: number;
  reserved_active_seconds: number;
  reserved_model_tokens: number;
  requested_at: string;
  record_json: unknown;
}

interface CheckpointRow {
  record_json: unknown;
}

interface ReservationRow {
  dataset_kind: DatasetKind;
  reservation_id: string;
  investigation_id: string;
  action_kind: ActionKind;
  action_name: string;
  expected_checkpoint_version: number;
  reserved_tool_attempts: number;
  reserved_reasoning_turns: number;
  reserved_active_seconds: number;
  reserved_model_tokens: number;
  reservation_status: ReservationStatus;
  outcome: ActionOutcome | null;
  actual_active_seconds: number;
  actual_model_tokens: number;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  reconciled_checkpoint_version: number | null;
}

interface CurrentState {
  readonly request: RequestRow;
  readonly checkpoint: InvestigationCheckpointRecord;
  readonly budget: BudgetLedger;
}

export function createSqlInvestigationLedgerRepository(
  executor: TransactionalSqlExecutor,
): InvestigationLedgerRepository {
  return new SqlInvestigationLedgerRepository(executor);
}

class SqlInvestigationLedgerRepository implements InvestigationLedgerRepository {
  constructor(private readonly executor: TransactionalSqlExecutor) {}

  async create(input: CreateInvestigationInput): Promise<InvestigationCheckpointRecord> {
    validateCreateInput(input);
    const requestRecord = buildRequestRecord(input);

    return this.executor.transaction(async (transaction) => {
      const existing = await transaction.query<{ matches: boolean }>(
        `SELECT
           dataset_kind IS NOT DISTINCT FROM $1::text
           AND investigation_id IS NOT DISTINCT FROM $2::text
           AND trace_id IS NOT DISTINCT FROM $3::text
           AND candidate_id IS NOT DISTINCT FROM $4::text
           AND context_id IS NOT DISTINCT FROM $5::text
           AND event_id IS NOT DISTINCT FROM $6::text
           AND event_version IS NOT DISTINCT FROM $7::integer
           AND questions IS NOT DISTINCT FROM $8::text[]
           AND budget_policy_version IS NOT DISTINCT FROM $9::text
           AND limit_tool_attempts IS NOT DISTINCT FROM $10::smallint
           AND limit_reasoning_turns IS NOT DISTINCT FROM $11::smallint
           AND limit_active_seconds IS NOT DISTINCT FROM $12::integer
           AND limit_model_tokens IS NOT DISTINCT FROM $13::integer
           AND requested_at IS NOT DISTINCT FROM $14::timestamptz
           AND record_json = $15::jsonb AS matches
         FROM waspada.investigation_requests
         WHERE dataset_kind = $1 AND investigation_id = $2`,
        createRequestParameters(input, requestRecord),
      );
      if (existing.rows.length > 0) {
        if (existing.rows[0]?.matches !== true) fail('investigation_conflict');
        const state = await loadState(transaction, input.datasetKind, input.investigationId, false);
        return state.checkpoint;
      }

      const context = await transaction.query<{
        trace_id: string;
        candidate_id: string;
        sufficient: boolean;
      }>(
        `SELECT context.trace_id, context.candidate_id, context.sufficient
         FROM waspada.grounding_contexts AS context
         INNER JOIN waspada.extraction_results AS candidate
           ON candidate.dataset_kind = context.dataset_kind
          AND candidate.candidate_id = context.candidate_id
         WHERE context.dataset_kind = $1 AND context.context_id = $2`,
        [input.datasetKind, input.contextId],
      );
      const contextRow = context.rows[0];
      if (!contextRow) fail('context_not_found');
      if (contextRow.candidate_id !== input.candidateId || contextRow.trace_id !== input.traceId) {
        fail('context_mismatch');
      }
      if (contextRow.sufficient) fail('sufficient_context');

      const inserted = await transaction.query<{ investigation_id: string }>(
        `INSERT INTO waspada.investigation_requests
           (dataset_kind, investigation_id, trace_id, candidate_id, context_id,
            event_id, event_version, questions, budget_policy_version,
            limit_tool_attempts, limit_reasoning_turns, limit_active_seconds,
            limit_model_tokens, requested_at, record_json)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15::jsonb)
         ON CONFLICT (dataset_kind, investigation_id) DO NOTHING
         RETURNING investigation_id`,
        createRequestParameters(input, requestRecord),
      );
      if (inserted.rows.length === 0) {
        const raced = await transaction.query<{ matches: boolean }>(
          `SELECT record_json = $3::jsonb
                    AND trace_id = $4 AND candidate_id = $5 AND context_id = $6
                    AND event_id IS NOT DISTINCT FROM $7::text
                    AND event_version IS NOT DISTINCT FROM $8::integer AS matches
           FROM waspada.investigation_requests
           WHERE dataset_kind = $1 AND investigation_id = $2`,
          [input.datasetKind, input.investigationId, JSON.stringify(requestRecord), input.traceId,
            input.candidateId, input.contextId, input.eventId, input.eventVersion],
        );
        if (raced.rows[0]?.matches !== true) fail('investigation_conflict');
        return (await loadState(transaction, input.datasetKind, input.investigationId, false)).checkpoint;
      }

      const initialBudget: BudgetLedger = {
        policyVersion: input.policyVersion,
        limits: input.limits,
        consumed: ZERO_COUNTERS,
        reserved: ZERO_COUNTERS,
      };
  const checkpoint = buildCheckpoint({
        datasetKind: input.datasetKind,
        checkpointId: randomUUID(),
        investigationId: input.investigationId,
        checkpointVersion: 1,
        candidateId: input.candidateId,
        contextId: input.contextId,
        traceId: input.traceId,
        eventId: input.eventId,
        eventVersion: input.eventVersion,
        caseStatus: 'open',
        stopReason: null,
        budget: initialBudget,
        attempts: [],
        reasoningRuns: [],
        createdAt: input.requestedAt,
        updatedAt: input.requestedAt,
        completedAt: null,
      });
      await insertCheckpoint(transaction, checkpoint);
      return checkpoint;
    });
  }

  async getLatest(datasetKind: DatasetKind, investigationId: string): Promise<InvestigationCheckpointRecord | null> {
    validateDatasetAndId(datasetKind, investigationId, 'investigation ID');
    const result = await this.executor.query<CheckpointRow>(
      `SELECT record_json
       FROM waspada.investigation_checkpoints
       WHERE dataset_kind = $1 AND investigation_id = $2
       ORDER BY checkpoint_version DESC
       LIMIT 1`,
      [datasetKind, investigationId],
    );
    const row = result.rows[0];
    return row ? mapCheckpoint(row.record_json) : null;
  }

  async getInFlightReservation(
    datasetKind: DatasetKind,
    investigationId: string,
  ): Promise<ReservationRecord | null> {
    validateDatasetAndId(datasetKind, investigationId, 'investigation ID');
    const result = await this.executor.query<ReservationRow>(
      `SELECT ${RESERVATION_COLUMNS}
       FROM waspada.investigation_action_reservations
       WHERE dataset_kind = $1 AND investigation_id = $2
         AND reservation_status IN ('reserved', 'started')
       ORDER BY created_at, reservation_id
       LIMIT 1`,
      [datasetKind, investigationId],
    );
    const row = result.rows[0];
    return row ? mapReservation(row) : null;
  }

  async reserveAction(input: ReserveActionInput): Promise<ReservationOperationResult> {
    validateReserveInput(input);
    return this.executor.transaction(async (transaction) => {
      const alreadyReserved = await findReservation(transaction, input.datasetKind, input.reservationId, true);
      if (alreadyReserved) {
        if (!matchesReservationInput(alreadyReserved, input)) fail('reservation_conflict');
        const state = await loadState(transaction, input.datasetKind, input.investigationId, true);
        return {
          reservation: mapReservation(alreadyReserved),
          checkpoint: state.checkpoint,
          mayInvoke: false,
          replayed: true,
        };
      }

      const state = await loadState(transaction, input.datasetKind, input.investigationId, true);
      const secondCheck = await findReservation(transaction, input.datasetKind, input.reservationId, true);
      if (secondCheck) {
        if (!matchesReservationInput(secondCheck, input)) fail('reservation_conflict');
        return {
          reservation: mapReservation(secondCheck),
          checkpoint: state.checkpoint,
          mayInvoke: false,
          replayed: true,
        };
      }
      ensureExpectedVersion(state, input.expectedCheckpointVersion);
      if (state.checkpoint.case_status !== 'open') fail('invalid_state');

      const active = await transaction.query<{ reservation_id: string }>(
        `SELECT reservation_id
         FROM waspada.investigation_action_reservations
         WHERE dataset_kind = $1 AND investigation_id = $2
           AND reservation_status IN ('reserved', 'started')
         LIMIT 1`,
        [input.datasetKind, input.investigationId],
      );
      if (active.rows.length > 0) fail('reservation_in_flight');

      const reserved = reservedCounters(input.actionKind, input.reservedActiveSeconds, input.reservedModelTokens);
      const nextBudget = addCounters(state.budget, ZERO_COUNTERS, reserved);
      ensureWithinLimits(nextBudget);

      const inserted = await transaction.query<ReservationRow>(
        `INSERT INTO waspada.investigation_action_reservations
           (dataset_kind, reservation_id, investigation_id, action_kind, action_name,
            expected_checkpoint_version, reserved_tool_attempts, reserved_reasoning_turns,
            reserved_active_seconds, reserved_model_tokens, reservation_status, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'reserved', $11)
         ON CONFLICT (dataset_kind, reservation_id) DO NOTHING
         RETURNING ${RESERVATION_COLUMNS}`,
        reservationInsertParameters(input, reserved),
      );
      if (inserted.rows.length === 0) {
        const raced = await findReservation(transaction, input.datasetKind, input.reservationId, true);
        if (!raced || !matchesReservationInput(raced, input)) fail('reservation_conflict');
        return {
          reservation: mapReservation(raced),
          checkpoint: state.checkpoint,
          mayInvoke: false,
          replayed: true,
        };
      }

      await updateRequestCounters(transaction, state.request, nextBudget);
      const checkpoint = await appendCheckpoint(transaction, state, {
        budget: nextBudget,
        updatedAt: input.reservedAt,
      });
      return {
        reservation: mapReservation(inserted.rows[0]!),
        checkpoint,
        mayInvoke: false,
        replayed: false,
      };
    });
  }

  async startAction(input: {
    readonly datasetKind: DatasetKind;
    readonly investigationId: string;
    readonly reservationId: string;
    readonly startedAt: string;
  }): Promise<ReservationOperationResult> {
    validateDatasetAndId(input.datasetKind, input.investigationId, 'investigation ID');
    validateId(input.reservationId, 'reservation ID');
    validateTimestamp(input.startedAt, 'startedAt');
    return this.executor.transaction(async (transaction) => {
      const state = await loadState(transaction, input.datasetKind, input.investigationId, true);
      const reservation = await findReservation(transaction, input.datasetKind, input.reservationId, true);
      if (!reservation || reservation.investigation_id !== input.investigationId) fail('reservation_conflict');
      if (reservation.reservation_status === 'started') {
        if (Date.parse(input.startedAt) !== Date.parse(reservation.started_at!)) fail('reservation_conflict');
        return { reservation: mapReservation(reservation), checkpoint: state.checkpoint, mayInvoke: false, replayed: true };
      }
      if (reservation.reservation_status !== 'reserved') {
        if (reservation.started_at !== null && Date.parse(input.startedAt) !== Date.parse(reservation.started_at)) {
          fail('reservation_conflict');
        }
        return { reservation: mapReservation(reservation), checkpoint: state.checkpoint, mayInvoke: false, replayed: true };
      }
      if (state.checkpoint.case_status !== 'open') fail('invalid_state');
      if (Date.parse(input.startedAt) < Date.parse(reservation.created_at)
        || Date.parse(input.startedAt) < Date.parse(state.checkpoint.updated_at)) fail('invalid_input');

      const updated = await transaction.query<ReservationRow>(
        `UPDATE waspada.investigation_action_reservations
         SET reservation_status = 'started', started_at = $3::timestamptz
         WHERE dataset_kind = $1 AND reservation_id = $2 AND reservation_status = 'reserved'
         RETURNING ${RESERVATION_COLUMNS}`,
        [input.datasetKind, input.reservationId, input.startedAt],
      );
      const row = updated.rows[0];
      if (!row) {
        const raced = await findReservation(transaction, input.datasetKind, input.reservationId, true);
        if (!raced || raced.investigation_id !== input.investigationId) fail('reservation_conflict');
        return { reservation: mapReservation(raced), checkpoint: state.checkpoint, mayInvoke: false, replayed: true };
      }
      return { reservation: mapReservation(row), checkpoint: state.checkpoint, mayInvoke: true, replayed: false };
    });
  }

  async reconcileAction(input: ReconcileActionInput): Promise<LedgerOperationResult> {
    validateReconcileInput(input);
    return this.executor.transaction(async (transaction) => {
      const state = await loadState(transaction, input.datasetKind, input.investigationId, true);
      const reservation = await findReservation(transaction, input.datasetKind, input.reservationId, true);
      if (!reservation || reservation.investigation_id !== input.investigationId) fail('reservation_conflict');
      if (reservation.reservation_status === 'reconciled') {
        if (!matchesReconciliation(reservation, input)) fail('reservation_conflict');
        try {
          validateReconciliationAgainstReservation(reservation, input);
        } catch {
          fail('reservation_conflict');
        }
        const reconciledCheckpoint = await loadCheckpointVersion(transaction, input.datasetKind,
          input.investigationId, reservation.reconciled_checkpoint_version!);
        const priorCheckpoint = await loadCheckpointVersion(transaction, input.datasetKind,
          input.investigationId, reservation.reconciled_checkpoint_version! - 1);
        if (!matchesReconciliationSnapshot(reservation, input, priorCheckpoint, reconciledCheckpoint)) {
          fail('reservation_conflict');
        }
        return { checkpoint: reconciledCheckpoint, replayed: true };
      }
      if (reservation.reservation_status !== 'started') fail('invalid_state');
      ensureExpectedVersion(state, input.expectedCheckpointVersion);
      if (state.checkpoint.case_status !== 'open') fail('invalid_state');
      validateReconciliationAgainstReservation(reservation, input);
      const nextBudget = reconcileBudget(state.budget, reservation, input.actualActiveSeconds, input.actualModelTokens);
      ensureWithinLimits(nextBudget);
      const nextVersion = state.checkpoint.checkpoint_version + 1;
      const updated = await transaction.query<ReservationRow>(
        `UPDATE waspada.investigation_action_reservations
         SET reservation_status = 'reconciled', outcome = $3,
             actual_active_seconds = $4, actual_model_tokens = $5,
             finished_at = $6::timestamptz, reconciled_checkpoint_version = $7
         WHERE dataset_kind = $1 AND reservation_id = $2 AND reservation_status = 'started'
         RETURNING ${RESERVATION_COLUMNS}`,
        [input.datasetKind, input.reservationId, input.outcome,
          input.actualActiveSeconds, input.actualModelTokens, input.finishedAt, nextVersion],
      );
      if (!updated.rows[0]) fail('reservation_conflict');
      await updateRequestCounters(transaction, state.request, nextBudget);
      const attempts = [...state.checkpoint.attempts];
      const reasoningRuns = [...state.checkpoint.reasoning_runs];
      if (reservation.action_kind === 'tool') {
        attempts.push({
          attempt_id: reservation.reservation_id,
          tool: reservation.action_name,
          outcome: input.outcome,
          started_at: formatTimestamp(reservation.started_at!),
          finished_at: input.finishedAt,
        });
      } else if (input.outcome === 'succeeded' && input.modelRun) {
        reasoningRuns.push(input.modelRun);
      }
      const checkpoint = await appendCheckpoint(transaction, state, {
        budget: nextBudget,
        attempts,
        reasoningRuns,
        updatedAt: input.finishedAt,
      });
      return { checkpoint, replayed: false };
    });
  }

  async reconcileInterrupted(input: {
    readonly datasetKind: DatasetKind;
    readonly investigationId: string;
    readonly reservationId: string;
    readonly expectedCheckpointVersion: number;
    readonly finishedAt: string;
  }): Promise<LedgerOperationResult> {
    const reservation = await this.findReservationForCase(input.datasetKind, input.investigationId, input.reservationId);
    if (!reservation) fail('reservation_conflict');
    return this.reconcileAction({
      datasetKind: input.datasetKind,
      investigationId: input.investigationId,
      reservationId: input.reservationId,
      expectedCheckpointVersion: input.expectedCheckpointVersion,
      outcome: 'timed_out',
      actualActiveSeconds: reservation.reserved.activeSeconds,
      actualModelTokens: reservation.reserved.modelTokens,
      finishedAt: input.finishedAt,
    });
  }

  async releaseUninvoked(input: {
    readonly datasetKind: DatasetKind;
    readonly investigationId: string;
    readonly reservationId: string;
    readonly expectedCheckpointVersion: number;
    readonly releasedAt: string;
  }): Promise<LedgerOperationResult> {
    validateDatasetAndId(input.datasetKind, input.investigationId, 'investigation ID');
    validateId(input.reservationId, 'reservation ID');
    validateVersion(input.expectedCheckpointVersion, 'expectedCheckpointVersion');
    validateTimestamp(input.releasedAt, 'releasedAt');
    return this.executor.transaction(async (transaction) => {
      const state = await loadState(transaction, input.datasetKind, input.investigationId, true);
      const reservation = await findReservation(transaction, input.datasetKind, input.reservationId, true);
      if (!reservation || reservation.investigation_id !== input.investigationId) fail('reservation_conflict');
      if (reservation.reservation_status === 'released') {
        if (!reservation.finished_at || Date.parse(reservation.finished_at) !== Date.parse(input.releasedAt)) {
          fail('reservation_conflict');
        }
        return {
          checkpoint: await loadCheckpointVersion(transaction, input.datasetKind, input.investigationId,
            reservation.reconciled_checkpoint_version!),
          replayed: true,
        };
      }
      if (reservation.reservation_status !== 'reserved') fail('invalid_state');
      ensureExpectedVersion(state, input.expectedCheckpointVersion);
      if (Date.parse(input.releasedAt) < Date.parse(reservation.created_at)) fail('invalid_input');
      const nextBudget = releaseBudget(state.budget, reservation);
      const nextVersion = state.checkpoint.checkpoint_version + 1;
      await updateRequestCounters(transaction, state.request, nextBudget);
      const updated = await transaction.query<{ reservation_id: string }>(
        `UPDATE waspada.investigation_action_reservations
         SET reservation_status = 'released', finished_at = $3::timestamptz,
             reconciled_checkpoint_version = $4
         WHERE dataset_kind = $1 AND reservation_id = $2 AND reservation_status = 'reserved'
         RETURNING reservation_id`,
        [input.datasetKind, input.reservationId, input.releasedAt, nextVersion],
      );
      if (updated.rows.length === 0) fail('reservation_conflict');
      const checkpoint = await appendCheckpoint(transaction, state, {
        budget: nextBudget,
        updatedAt: input.releasedAt,
      });
      return { checkpoint, replayed: false };
    });
  }

  async pause(input: {
    readonly datasetKind: DatasetKind;
    readonly investigationId: string;
    readonly expectedCheckpointVersion: number;
    readonly pausedAt: string;
  }): Promise<LedgerOperationResult> {
    validateTransitionInput(input.datasetKind, input.investigationId, input.expectedCheckpointVersion, input.pausedAt);
    return this.executor.transaction(async (transaction) => {
      const state = await loadState(transaction, input.datasetKind, input.investigationId, true);
      ensureExpectedVersion(state, input.expectedCheckpointVersion);
      if (state.checkpoint.case_status !== 'open') fail('invalid_state');
      const started = await transaction.query<{ reservation_id: string }>(
        `SELECT reservation_id FROM waspada.investigation_action_reservations
         WHERE dataset_kind = $1 AND investigation_id = $2 AND reservation_status = 'started'
         LIMIT 1`,
        [input.datasetKind, input.investigationId],
      );
      if (started.rows.length > 0) fail('reservation_in_flight');
      const checkpoint = await appendCheckpoint(transaction, state, {
        caseStatus: 'paused', stopReason: null, completedAt: null, updatedAt: input.pausedAt,
      });
      return { checkpoint, replayed: false };
    });
  }

  async resume(input: {
    readonly datasetKind: DatasetKind;
    readonly investigationId: string;
    readonly expectedCheckpointVersion: number;
    readonly resumedAt: string;
    readonly contextId?: string;
  }): Promise<LedgerOperationResult> {
    validateTransitionInput(input.datasetKind, input.investigationId, input.expectedCheckpointVersion, input.resumedAt);
    if (input.contextId !== undefined) validateId(input.contextId, 'context ID');
    return this.executor.transaction(async (transaction) => {
      const state = await loadState(transaction, input.datasetKind, input.investigationId, true);
      ensureExpectedVersion(state, input.expectedCheckpointVersion);
      if (state.checkpoint.case_status !== 'paused') fail('invalid_state');
      const contextId = input.contextId ?? state.checkpoint.context_id;
      const context = await findContext(transaction, input.datasetKind, contextId);
      if (!context) fail('context_not_found');
      if (context.candidate_id !== state.request.candidate_id) fail('context_mismatch');
      const checkpoint = await appendCheckpoint(transaction, state, {
        caseStatus: 'open',
        stopReason: null,
        completedAt: null,
        contextId,
        traceId: context.trace_id,
        updatedAt: input.resumedAt,
      });
      return { checkpoint, replayed: false };
    });
  }

  async terminate(input: {
    readonly datasetKind: DatasetKind;
    readonly investigationId: string;
    readonly expectedCheckpointVersion: number;
    readonly status: 'completed' | 'stopped_for_review';
    readonly stopReason: InvestigationStopReason;
    readonly completedAt: string;
  }): Promise<LedgerOperationResult> {
    validateTransitionInput(input.datasetKind, input.investigationId, input.expectedCheckpointVersion, input.completedAt);
    if (input.status !== 'completed' && input.status !== 'stopped_for_review') fail('invalid_input');
    if (input.status === 'completed' && input.stopReason !== 'completed') fail('invalid_input');
    if (input.status === 'stopped_for_review' && input.stopReason === 'completed') fail('invalid_input');
    if (!STOP_REASONS.has(input.stopReason)) fail('invalid_input');
    return this.executor.transaction(async (transaction) => {
      const state = await loadState(transaction, input.datasetKind, input.investigationId, true);
      ensureExpectedVersion(state, input.expectedCheckpointVersion);
      if (state.checkpoint.case_status !== 'open' && state.checkpoint.case_status !== 'paused') fail('invalid_state');
      const active = await transaction.query<{ reservation_id: string }>(
        `SELECT reservation_id FROM waspada.investigation_action_reservations
         WHERE dataset_kind = $1 AND investigation_id = $2
           AND reservation_status IN ('reserved', 'started')
         LIMIT 1`,
        [input.datasetKind, input.investigationId],
      );
      if (active.rows.length > 0) fail('reservation_in_flight');
      const checkpoint = await appendCheckpoint(transaction, state, {
        caseStatus: input.status,
        stopReason: input.stopReason,
        completedAt: input.completedAt,
        updatedAt: input.completedAt,
      });
      return { checkpoint, replayed: false };
    });
  }

  private async findReservationForCase(
    datasetKind: DatasetKind,
    investigationId: string,
    reservationId: string,
  ): Promise<ReservationRecord | null> {
    validateDatasetAndId(datasetKind, investigationId, 'investigation ID');
    validateId(reservationId, 'reservation ID');
    const row = await findReservation(this.executor, datasetKind, reservationId, false);
    return row?.investigation_id === investigationId ? mapReservation(row) : null;
  }
}

const RESERVATION_COLUMNS = `dataset_kind, reservation_id, investigation_id, action_kind, action_name,
  expected_checkpoint_version, reserved_tool_attempts, reserved_reasoning_turns,
  reserved_active_seconds, reserved_model_tokens, reservation_status, outcome,
  actual_active_seconds, actual_model_tokens, created_at::text AS created_at,
  started_at::text AS started_at, finished_at::text AS finished_at, reconciled_checkpoint_version`;

function createRequestParameters(input: CreateInvestigationInput, record: InvestigationRequestRecord): readonly unknown[] {
  return [input.datasetKind, input.investigationId, input.traceId, input.candidateId, input.contextId,
    input.eventId, input.eventVersion, [...input.questions], input.policyVersion,
    input.limits.toolAttempts, input.limits.reasoningTurns, input.limits.activeSeconds,
    input.limits.modelTokens, input.requestedAt, JSON.stringify(record)];
}

function reservationInsertParameters(input: ReserveActionInput, reserved: BudgetCounters): readonly unknown[] {
  return [input.datasetKind, input.reservationId, input.investigationId, input.actionKind, input.actionName,
    input.expectedCheckpointVersion, reserved.toolAttempts, reserved.reasoningTurns,
    reserved.activeSeconds, reserved.modelTokens, input.reservedAt];
}

async function findReservation(
  executor: SqlExecutor,
  datasetKind: DatasetKind,
  reservationId: string,
  lock: boolean,
): Promise<ReservationRow | null> {
  const result = await executor.query<ReservationRow>(
    `SELECT ${RESERVATION_COLUMNS}
     FROM waspada.investigation_action_reservations
     WHERE dataset_kind = $1 AND reservation_id = $2${lock ? ' FOR UPDATE' : ''}`,
    [datasetKind, reservationId],
  );
  return result.rows[0] ?? null;
}

async function loadState(
  executor: SqlExecutor,
  datasetKind: DatasetKind,
  investigationId: string,
  lock: boolean,
): Promise<CurrentState> {
  const requestResult = await executor.query<RequestRow>(
    `SELECT dataset_kind, investigation_id, trace_id, candidate_id, context_id,
            event_id, event_version, questions, budget_policy_version,
            limit_tool_attempts, limit_reasoning_turns, limit_active_seconds, limit_model_tokens,
            consumed_tool_attempts, consumed_reasoning_turns, consumed_active_seconds, consumed_model_tokens,
            reserved_tool_attempts, reserved_reasoning_turns, reserved_active_seconds, reserved_model_tokens,
            requested_at::text AS requested_at, record_json
     FROM waspada.investigation_requests
     WHERE dataset_kind = $1 AND investigation_id = $2${lock ? ' FOR UPDATE' : ''}`,
    [datasetKind, investigationId],
  );
  const request = requestResult.rows[0];
  if (!request) fail('investigation_not_found');
  const checkpointResult = await executor.query<CheckpointRow>(
    `SELECT record_json FROM waspada.investigation_checkpoints
     WHERE dataset_kind = $1 AND investigation_id = $2
     ORDER BY checkpoint_version DESC LIMIT 1`,
    [datasetKind, investigationId],
  );
  const checkpointRow = checkpointResult.rows[0];
  if (!checkpointRow) fail('investigation_not_found');
  const checkpoint = mapCheckpoint(checkpointRow.record_json);
  const budget = budgetFromRequest(request);
  assertCheckpointMatchesCurrent(checkpoint, request, budget);
  return { request, checkpoint, budget };
}

async function loadCheckpointVersion(
  executor: SqlExecutor,
  datasetKind: DatasetKind,
  investigationId: string,
  checkpointVersion: number,
): Promise<InvestigationCheckpointRecord> {
  const result = await executor.query<CheckpointRow>(
    `SELECT record_json FROM waspada.investigation_checkpoints
     WHERE dataset_kind = $1 AND investigation_id = $2 AND checkpoint_version = $3`,
    [datasetKind, investigationId, checkpointVersion],
  );
  if (!result.rows[0]) fail('investigation_not_found');
  return mapCheckpoint(result.rows[0].record_json);
}

async function findContext(
  executor: SqlExecutor,
  datasetKind: DatasetKind,
  contextId: string,
): Promise<{ trace_id: string; candidate_id: string } | null> {
  const result = await executor.query<{ trace_id: string; candidate_id: string }>(
    `SELECT trace_id, candidate_id FROM waspada.grounding_contexts
     WHERE dataset_kind = $1 AND context_id = $2`,
    [datasetKind, contextId],
  );
  return result.rows[0] ?? null;
}

async function updateRequestCounters(
  executor: SqlExecutor,
  request: RequestRow,
  budget: BudgetLedger,
): Promise<void> {
  const result = await executor.query<{ investigation_id: string }>(
    `UPDATE waspada.investigation_requests
     SET consumed_tool_attempts = $3, consumed_reasoning_turns = $4,
         consumed_active_seconds = $5, consumed_model_tokens = $6,
         reserved_tool_attempts = $7, reserved_reasoning_turns = $8,
         reserved_active_seconds = $9, reserved_model_tokens = $10
     WHERE dataset_kind = $1 AND investigation_id = $2
     RETURNING investigation_id`,
    [request.dataset_kind, request.investigation_id,
      budget.consumed.toolAttempts, budget.consumed.reasoningTurns,
      budget.consumed.activeSeconds, budget.consumed.modelTokens,
      budget.reserved.toolAttempts, budget.reserved.reasoningTurns,
      budget.reserved.activeSeconds, budget.reserved.modelTokens],
  );
  if (result.rows.length === 0) fail('investigation_not_found');
}

async function appendCheckpoint(
  executor: SqlExecutor,
  state: CurrentState,
  changes: Partial<{
    readonly caseStatus: InvestigationStatus;
    readonly stopReason: InvestigationStopReason | null;
    readonly completedAt: string | null;
    readonly contextId: string;
    readonly traceId: string;
    readonly budget: BudgetLedger;
    readonly attempts: readonly ToolAttempt[];
    readonly reasoningRuns: readonly ModelRun[];
    readonly updatedAt: string;
  }>,
): Promise<InvestigationCheckpointRecord> {
  const updatedAt = changes.updatedAt ?? state.checkpoint.updated_at;
  validateTimestamp(updatedAt, 'updatedAt');
  if (Date.parse(updatedAt) < Date.parse(state.checkpoint.updated_at)) fail('invalid_input');
  const contextId = changes.contextId ?? state.checkpoint.context_id;
  const context = await findContext(executor, state.request.dataset_kind, contextId);
  if (!context) fail('context_not_found');
  if (context.candidate_id !== state.request.candidate_id) fail('context_mismatch');
  const budget = changes.budget ?? state.budget;
  ensureWithinLimits(budget);
      const checkpoint = buildCheckpoint({
    datasetKind: state.request.dataset_kind,
    checkpointId: randomUUID(),
    investigationId: state.request.investigation_id,
    checkpointVersion: state.checkpoint.checkpoint_version + 1,
    candidateId: state.request.candidate_id,
    contextId,
    traceId: changes.traceId ?? context.trace_id,
    eventId: state.request.event_id,
    eventVersion: state.request.event_version,
    caseStatus: changes.caseStatus ?? state.checkpoint.case_status,
    stopReason: changes.stopReason === undefined ? state.checkpoint.stop_reason : changes.stopReason,
    budget,
    attempts: changes.attempts ?? state.checkpoint.attempts,
    reasoningRuns: changes.reasoningRuns ?? state.checkpoint.reasoning_runs,
    createdAt: state.checkpoint.created_at,
    updatedAt,
    completedAt: changes.completedAt === undefined ? state.checkpoint.completed_at : changes.completedAt,
  });
  await insertCheckpoint(executor, checkpoint);
  return checkpoint;
}

async function insertCheckpoint(executor: SqlExecutor, checkpoint: InvestigationCheckpointRecord): Promise<void> {
  await executor.query(
    `INSERT INTO waspada.investigation_checkpoints
       (dataset_kind, checkpoint_id, investigation_id, checkpoint_version, trace_id, candidate_id,
        context_id, event_id, event_version, case_status, stop_reason, budget_policy_version,
        limit_tool_attempts, limit_reasoning_turns, limit_active_seconds, limit_model_tokens,
        consumed_tool_attempts, consumed_reasoning_turns, consumed_active_seconds, consumed_model_tokens,
        reserved_tool_attempts, reserved_reasoning_turns, reserved_active_seconds, reserved_model_tokens,
        attempts, reasoning_runs, created_at, updated_at, completed_at, record_json)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16,
        $17, $18, $19, $20, $21, $22, $23, $24, $25::jsonb, $26::jsonb,
        $27::timestamptz, $28::timestamptz, $29::timestamptz, $30::jsonb)`,
    [checkpoint.dataset_kind, checkpoint.checkpoint_id, checkpoint.investigation_id,
      checkpoint.checkpoint_version, checkpoint.trace_id, checkpoint.candidate_id,
      checkpoint.context_id, checkpoint.event_id, checkpoint.event_version,
      checkpoint.case_status, checkpoint.stop_reason, checkpoint.budget.policy_version,
      checkpoint.budget.limits.tool_attempts, checkpoint.budget.limits.reasoning_turns,
      checkpoint.budget.limits.active_seconds, checkpoint.budget.limits.model_tokens,
      checkpoint.budget.consumed.tool_attempts, checkpoint.budget.consumed.reasoning_turns,
      checkpoint.budget.consumed.active_seconds, checkpoint.budget.consumed.model_tokens,
      checkpoint.budget.reserved.tool_attempts, checkpoint.budget.reserved.reasoning_turns,
      checkpoint.budget.reserved.active_seconds, checkpoint.budget.reserved.model_tokens,
      JSON.stringify(checkpoint.attempts), JSON.stringify(checkpoint.reasoning_runs),
      checkpoint.created_at, checkpoint.updated_at, checkpoint.completed_at,
      JSON.stringify(checkpoint)],
  );
}

function buildRequestRecord(input: CreateInvestigationInput): InvestigationRequestRecord {
  return {
    schema_version: '2.0',
    trace_id: input.traceId,
    record_type: 'InvestigationRequest',
    dataset_kind: input.datasetKind,
    investigation_id: input.investigationId,
    candidate_id: input.candidateId,
    context_id: input.contextId,
    event_id: input.eventId,
    event_version: input.eventVersion,
    questions: [...input.questions],
    budget: budgetToRecord({ policyVersion: input.policyVersion, limits: input.limits,
      consumed: ZERO_COUNTERS, reserved: ZERO_COUNTERS }),
    requested_at: input.requestedAt,
  };
}

function buildCheckpoint(input: {
  readonly datasetKind: DatasetKind;
  readonly checkpointId: string;
  readonly investigationId: string;
  readonly checkpointVersion: number;
  readonly candidateId: string;
  readonly contextId: string;
  readonly traceId: string;
  readonly eventId: string | null;
  readonly eventVersion: number | null;
  readonly caseStatus: InvestigationStatus;
  readonly stopReason: InvestigationStopReason | null;
  readonly budget: BudgetLedger;
  readonly attempts: readonly ToolAttempt[];
  readonly reasoningRuns: readonly ModelRun[];
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly completedAt: string | null;
}): InvestigationCheckpointRecord {
  if (input.checkpointVersion > 2_147_483_647) fail('budget_exhausted');
  validateTimestamp(input.createdAt, 'createdAt');
  validateTimestamp(input.updatedAt, 'updatedAt');
  if (input.completedAt !== null) validateTimestamp(input.completedAt, 'completedAt');
  validateEventPair(input.eventId, input.eventVersion);
  if (input.caseStatus === 'completed') {
    if (input.stopReason !== 'completed' || input.completedAt === null) fail('invalid_input');
  } else if (input.caseStatus === 'stopped_for_review') {
    if (input.stopReason === null || input.stopReason === 'completed' || input.completedAt === null) fail('invalid_input');
  } else if (input.completedAt !== null) {
    fail('invalid_input');
  }
  if (input.reasoningRuns.length > 4) fail('budget_exhausted');
  const record: InvestigationCheckpointRecord = {
    schema_version: '2.0',
    trace_id: input.traceId,
    record_type: 'InvestigationCheckpoint',
    dataset_kind: input.datasetKind,
    checkpoint_id: input.checkpointId,
    investigation_id: input.investigationId,
    checkpoint_version: input.checkpointVersion,
    candidate_id: input.candidateId,
    context_id: input.contextId,
    event_id: input.eventId,
    event_version: input.eventVersion,
    case_status: input.caseStatus,
    stop_reason: input.stopReason,
    budget: budgetToRecord(input.budget),
    attempts: [...input.attempts],
    reasoning_runs: [...input.reasoningRuns],
    created_at: input.createdAt,
    updated_at: input.updatedAt,
    completed_at: input.completedAt,
  };
  return record;
}

function budgetFromRequest(request: RequestRow): BudgetLedger {
  return {
    policyVersion: request.budget_policy_version,
    limits: {
      toolAttempts: Number(request.limit_tool_attempts),
      reasoningTurns: Number(request.limit_reasoning_turns),
      activeSeconds: Number(request.limit_active_seconds),
      modelTokens: Number(request.limit_model_tokens),
    },
    consumed: {
      toolAttempts: Number(request.consumed_tool_attempts),
      reasoningTurns: Number(request.consumed_reasoning_turns),
      activeSeconds: Number(request.consumed_active_seconds),
      modelTokens: Number(request.consumed_model_tokens),
    },
    reserved: {
      toolAttempts: Number(request.reserved_tool_attempts),
      reasoningTurns: Number(request.reserved_reasoning_turns),
      activeSeconds: Number(request.reserved_active_seconds),
      modelTokens: Number(request.reserved_model_tokens),
    },
  };
}

function budgetToRecord(budget: BudgetLedger): BudgetLedgerRecord {
  return {
    policy_version: budget.policyVersion,
    limits: countersToRecord(budget.limits),
    consumed: countersToRecord(budget.consumed),
    reserved: countersToRecord(budget.reserved),
  };
}

function countersToRecord(counters: BudgetCounters): BudgetCountersRecord {
  return {
    tool_attempts: counters.toolAttempts,
    reasoning_turns: counters.reasoningTurns,
    active_seconds: counters.activeSeconds,
    model_tokens: counters.modelTokens,
  };
}

function countersFromRecord(counters: BudgetCountersRecord): BudgetCounters {
  return {
    toolAttempts: Number(counters.tool_attempts),
    reasoningTurns: Number(counters.reasoning_turns),
    activeSeconds: Number(counters.active_seconds),
    modelTokens: Number(counters.model_tokens),
  };
}

function mapCheckpoint(value: unknown): InvestigationCheckpointRecord {
  const record = parseObject(value);
  if (record.record_type !== 'InvestigationCheckpoint' || record.schema_version !== '2.0'
    || typeof record.checkpoint_version !== 'number' || !Number.isInteger(record.checkpoint_version)
    || typeof record.investigation_id !== 'string' || typeof record.context_id !== 'string'
    || typeof record.candidate_id !== 'string' || !Array.isArray(record.attempts)
    || !Array.isArray(record.reasoning_runs) || !record.budget || typeof record.budget !== 'object') {
    fail('investigation_conflict');
  }
  return record as unknown as InvestigationCheckpointRecord;
}

function mapReservation(row: ReservationRow): ReservationRecord {
  return {
    datasetKind: row.dataset_kind,
    reservationId: row.reservation_id,
    investigationId: row.investigation_id,
    actionKind: row.action_kind,
    actionName: row.action_name,
    expectedCheckpointVersion: Number(row.expected_checkpoint_version),
    reserved: {
      toolAttempts: Number(row.reserved_tool_attempts),
      reasoningTurns: Number(row.reserved_reasoning_turns),
      activeSeconds: Number(row.reserved_active_seconds),
      modelTokens: Number(row.reserved_model_tokens),
    },
    status: row.reservation_status,
    outcome: row.outcome,
    actual: {
      activeSeconds: Number(row.actual_active_seconds),
      modelTokens: Number(row.actual_model_tokens),
    },
    createdAt: formatTimestamp(row.created_at),
    startedAt: row.started_at ? formatTimestamp(row.started_at) : null,
    finishedAt: row.finished_at ? formatTimestamp(row.finished_at) : null,
    reconciledCheckpointVersion: row.reconciled_checkpoint_version === null
      ? null : Number(row.reconciled_checkpoint_version),
  };
}

function assertCheckpointMatchesCurrent(
  checkpoint: InvestigationCheckpointRecord,
  request: RequestRow,
  currentBudget: BudgetLedger,
): void {
  const checkpointBudget = checkpoint.budget;
  if (checkpoint.dataset_kind !== request.dataset_kind
    || checkpoint.investigation_id !== request.investigation_id
    || checkpoint.candidate_id !== request.candidate_id
    || checkpoint.event_id !== request.event_id
    || checkpoint.event_version !== request.event_version
    || checkpoint.budget.policy_version !== currentBudget.policyVersion
    || !sameCounters(countersFromRecord(checkpointBudget.limits), currentBudget.limits)
    || !sameCounters(countersFromRecord(checkpointBudget.consumed), currentBudget.consumed)
    || !sameCounters(countersFromRecord(checkpointBudget.reserved), currentBudget.reserved)) {
    fail('investigation_conflict');
  }
}

function ensureExpectedVersion(state: CurrentState, expectedVersion: number): void {
  validateVersion(expectedVersion, 'expectedCheckpointVersion');
  if (state.checkpoint.checkpoint_version !== expectedVersion) fail('stale_checkpoint');
}

function addCounters(current: BudgetLedger, consumed: BudgetCounters, reserved: BudgetCounters): BudgetLedger {
  return {
    ...current,
    consumed: add(current.consumed, consumed),
    reserved: add(current.reserved, reserved),
  };
}

function reconcileBudget(
  current: BudgetLedger,
  reservation: ReservationRow,
  actualActiveSeconds: number,
  actualModelTokens: number,
): BudgetLedger {
  const reserved = reservationCounters(reservation);
  const actual: BudgetCounters = {
    toolAttempts: reserved.toolAttempts,
    reasoningTurns: reserved.reasoningTurns,
    activeSeconds: actualActiveSeconds,
    modelTokens: actualModelTokens,
  };
  const nextReserved: BudgetCounters = {
    toolAttempts: current.reserved.toolAttempts - reserved.toolAttempts,
    reasoningTurns: current.reserved.reasoningTurns - reserved.reasoningTurns,
    activeSeconds: current.reserved.activeSeconds - reserved.activeSeconds,
    modelTokens: current.reserved.modelTokens - reserved.modelTokens,
  };
  if (Object.values(nextReserved).some((value) => value < 0)) fail('investigation_conflict');
  return { ...current, consumed: add(current.consumed, actual), reserved: nextReserved };
}

function releaseBudget(current: BudgetLedger, reservation: ReservationRow): BudgetLedger {
  const reserved = reservationCounters(reservation);
  const nextReserved: BudgetCounters = {
    toolAttempts: current.reserved.toolAttempts - reserved.toolAttempts,
    reasoningTurns: current.reserved.reasoningTurns - reserved.reasoningTurns,
    activeSeconds: current.reserved.activeSeconds - reserved.activeSeconds,
    modelTokens: current.reserved.modelTokens - reserved.modelTokens,
  };
  if (Object.values(nextReserved).some((value) => value < 0)) fail('investigation_conflict');
  return { ...current, reserved: nextReserved };
}

function reservedCounters(kind: ActionKind, activeSeconds: number, modelTokens: number): BudgetCounters {
  return {
    toolAttempts: kind === 'tool' ? 1 : 0,
    reasoningTurns: kind === 'reasoning' ? 1 : 0,
    activeSeconds,
    modelTokens,
  };
}

function reservationCounters(reservation: ReservationRow): BudgetCounters {
  return {
    toolAttempts: Number(reservation.reserved_tool_attempts),
    reasoningTurns: Number(reservation.reserved_reasoning_turns),
    activeSeconds: Number(reservation.reserved_active_seconds),
    modelTokens: Number(reservation.reserved_model_tokens),
  };
}

function add(left: BudgetCounters, right: BudgetCounters): BudgetCounters {
  return {
    toolAttempts: left.toolAttempts + right.toolAttempts,
    reasoningTurns: left.reasoningTurns + right.reasoningTurns,
    activeSeconds: left.activeSeconds + right.activeSeconds,
    modelTokens: left.modelTokens + right.modelTokens,
  };
}

function ensureWithinLimits(budget: BudgetLedger): void {
  for (const key of Object.keys(HARD_LIMITS) as Array<keyof BudgetCounters>) {
    if (budget.limits[key] > HARD_LIMITS[key]
      || budget.consumed[key] < 0 || budget.reserved[key] < 0
      || budget.consumed[key] + budget.reserved[key] > budget.limits[key]) {
      fail('budget_exhausted');
    }
  }
}

function sameCounters(left: BudgetCounters, right: BudgetCounters): boolean {
  return left.toolAttempts === right.toolAttempts
    && left.reasoningTurns === right.reasoningTurns
    && left.activeSeconds === right.activeSeconds
    && left.modelTokens === right.modelTokens;
}

function matchesReservationInput(row: ReservationRow, input: ReserveActionInput): boolean {
  return row.investigation_id === input.investigationId
    && row.action_kind === input.actionKind
    && row.action_name === input.actionName
    && Number(row.expected_checkpoint_version) === input.expectedCheckpointVersion
    && Number(row.reserved_active_seconds) === input.reservedActiveSeconds
    && Number(row.reserved_model_tokens) === input.reservedModelTokens
    && Date.parse(row.created_at) === Date.parse(input.reservedAt);
}

function matchesReconciliation(row: ReservationRow, input: ReconcileActionInput): boolean {
  return row.outcome === input.outcome
    && Number(row.actual_active_seconds) === input.actualActiveSeconds
    && Number(row.actual_model_tokens) === input.actualModelTokens
    && row.finished_at !== null
    && Date.parse(row.finished_at) === Date.parse(input.finishedAt);
}

function matchesReconciliationSnapshot(
  reservation: ReservationRow,
  input: ReconcileActionInput,
  prior: InvestigationCheckpointRecord,
  reconciled: InvestigationCheckpointRecord,
): boolean {
  if (reservation.action_kind === 'tool') {
    const attempt = reconciled.attempts.find(({ attempt_id }) => attempt_id === reservation.reservation_id);
    return attempt !== undefined
      && attempt.tool === reservation.action_name
      && attempt.outcome === input.outcome
      && Date.parse(attempt.started_at) === Date.parse(reservation.started_at!)
      && Date.parse(attempt.finished_at) === Date.parse(input.finishedAt)
      && reconciled.attempts.length === prior.attempts.length + 1
      && prior.attempts.every((previous, index) => sameToolAttempt(previous, reconciled.attempts[index]!))
      && reconciled.reasoning_runs.length === prior.reasoning_runs.length;
  }
  const samePriorRuns = reconciled.reasoning_runs.length === prior.reasoning_runs.length
    + (input.outcome === 'succeeded' ? 1 : 0)
    && reconciled.attempts.length === prior.attempts.length
    && prior.reasoning_runs.every((previous, index) => modelRunsEqual(previous, reconciled.reasoning_runs[index]!))
    && prior.attempts.every((previous, index) => sameToolAttempt(previous, reconciled.attempts[index]!));
  if (!samePriorRuns) return false;
  if (input.outcome !== 'succeeded') return true;
  const lastRun = reconciled.reasoning_runs.at(-1);
  return lastRun !== undefined && input.modelRun !== undefined && modelRunsEqual(lastRun, input.modelRun);
}

function modelRunsEqual(left: ModelRun, right: ModelRun): boolean {
  return left.capability === right.capability
    && left.model_version === right.model_version
    && left.prompt_version === right.prompt_version
    && left.input_tokens === right.input_tokens
    && left.output_tokens === right.output_tokens;
}

function sameToolAttempt(left: ToolAttempt, right: ToolAttempt): boolean {
  return left.attempt_id === right.attempt_id
    && left.tool === right.tool
    && left.outcome === right.outcome
    && Date.parse(left.started_at) === Date.parse(right.started_at)
    && Date.parse(left.finished_at) === Date.parse(right.finished_at);
}

function validateReconciliationAgainstReservation(row: ReservationRow, input: ReconcileActionInput): void {
  if (!row.started_at || Date.parse(input.finishedAt) < Date.parse(row.started_at)) fail('invalid_input');
  const reserved = reservationCounters(row);
  if (input.actualActiveSeconds > reserved.activeSeconds || input.actualModelTokens > reserved.modelTokens) {
    fail('budget_exhausted');
  }
  if (row.action_kind === 'tool') {
    if (input.actualModelTokens !== 0 || input.modelRun !== undefined) fail('invalid_input');
    return;
  }
  if (input.outcome === 'succeeded') {
    if (!input.modelRun) fail('invalid_input');
    validateModelRun(input.modelRun);
    if (input.modelRun.input_tokens + input.modelRun.output_tokens !== input.actualModelTokens) fail('invalid_input');
  } else if (input.modelRun !== undefined) {
    fail('invalid_input');
  }
}

function validateModelRun(run: ModelRun): void {
  const keys = Object.keys(run).sort();
  if (keys.join(',') !== ['capability', 'input_tokens', 'model_version', 'output_tokens', 'prompt_version'].join(',')) {
    fail('invalid_input');
  }
  if (run.capability !== 'reasoning'
    || !nullableNonEmptyString(run.model_version)
    || !nullableNonEmptyString(run.prompt_version)
    || !isNonNegativeInteger(run.input_tokens)
    || !isNonNegativeInteger(run.output_tokens)) {
    fail('invalid_input');
  }
}

function validateCreateInput(input: CreateInvestigationInput): void {
  validateDatasetAndId(input.datasetKind, input.investigationId, 'investigation ID');
  validateId(input.traceId, 'trace ID');
  validateId(input.candidateId, 'candidate ID');
  validateId(input.contextId, 'context ID');
  validateEventPair(input.eventId, input.eventVersion);
  if (!Array.isArray(input.questions) || input.questions.length < 1 || input.questions.length > 20
    || input.questions.some((question) => typeof question !== 'string' || codePointLength(question) < 1 || codePointLength(question) > 1000)) {
    fail('invalid_input');
  }
  validateId(input.policyVersion, 'policy version');
  validateLimits(input.limits);
  validateTimestamp(input.requestedAt, 'requestedAt');
}

function validateReserveInput(input: ReserveActionInput): void {
  validateDatasetAndId(input.datasetKind, input.investigationId, 'investigation ID');
  validateId(input.reservationId, 'reservation ID');
  validateVersion(input.expectedCheckpointVersion, 'expectedCheckpointVersion');
  if (input.actionKind !== 'tool' && input.actionKind !== 'reasoning') fail('invalid_input');
  if (!ACTION_NAME_PATTERN.test(input.actionName)) fail('invalid_input');
  if (!isIntegerIn(input.reservedActiveSeconds, 1, HARD_LIMITS.activeSeconds)
    || !isIntegerIn(input.reservedModelTokens, 0, HARD_LIMITS.modelTokens)) fail('invalid_input');
  if (input.actionKind === 'tool' && input.reservedModelTokens !== 0) fail('invalid_input');
  if (input.actionKind === 'reasoning' && input.reservedModelTokens < 1) fail('invalid_input');
  validateTimestamp(input.reservedAt, 'reservedAt');
}

function validateReconcileInput(input: ReconcileActionInput): void {
  validateDatasetAndId(input.datasetKind, input.investigationId, 'investigation ID');
  validateId(input.reservationId, 'reservation ID');
  validateVersion(input.expectedCheckpointVersion, 'expectedCheckpointVersion');
  if (!OUTCOMES.has(input.outcome)) fail('invalid_input');
  if (!isIntegerIn(input.actualActiveSeconds, 0, HARD_LIMITS.activeSeconds)
    || !isIntegerIn(input.actualModelTokens, 0, HARD_LIMITS.modelTokens)) fail('invalid_input');
  validateTimestamp(input.finishedAt, 'finishedAt');
}

function validateTransitionInput(
  datasetKind: DatasetKind,
  investigationId: string,
  expectedVersion: number,
  at: string,
): void {
  validateDatasetAndId(datasetKind, investigationId, 'investigation ID');
  validateVersion(expectedVersion, 'expectedCheckpointVersion');
  validateTimestamp(at, 'transition time');
}

function validateLimits(limits: BudgetLimits): void {
  const entries: Array<[keyof BudgetLimits, number, number]> = [
    ['toolAttempts', HARD_LIMITS.toolAttempts, 5],
    ['reasoningTurns', HARD_LIMITS.reasoningTurns, 4],
    ['activeSeconds', HARD_LIMITS.activeSeconds, 60],
    ['modelTokens', HARD_LIMITS.modelTokens, 12_000],
  ];
  for (const [key, hardMax, schemaMax] of entries) {
    if (!isIntegerIn(limits[key], 1, Math.min(hardMax, schemaMax))) fail('invalid_input');
  }
}

function validateEventPair(eventId: string | null, eventVersion: number | null): void {
  if ((eventId === null) !== (eventVersion === null)) fail('invalid_input');
  if (eventId !== null) validateId(eventId, 'event ID');
  if (eventVersion !== null && !isIntegerIn(eventVersion, 1, 2_147_483_647)) fail('invalid_input');
}

function validateDatasetAndId(datasetKind: DatasetKind, value: string, label: string): void {
  if (datasetKind !== 'live' && datasetKind !== 'historical' && datasetKind !== 'synthetic') fail('invalid_input');
  validateId(value, label);
}

function validateId(value: string, _label: string): void {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) fail('invalid_input');
}

function validateVersion(value: number, _label: string): void {
  if (!isIntegerIn(value, 1, 2_147_483_647)) fail('invalid_input');
}

function validateTimestamp(value: string, _label: string): void {
  if (typeof value !== 'string' || !TIMESTAMP_PATTERN.test(value) || !Number.isFinite(Date.parse(value))) fail('invalid_input');
}

function formatTimestamp(value: string): string {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) fail('investigation_conflict');
  return parsed.toISOString();
}

function codePointLength(value: string): number {
  return Array.from(value).length;
}

function nullableNonEmptyString(value: string | null): boolean {
  return value === null || (typeof value === 'string' && value.length > 0);
}

function isIntegerIn(value: number, minimum: number, maximum: number): boolean {
  return Number.isInteger(value) && value >= minimum && value <= maximum;
}

function isNonNegativeInteger(value: number): boolean {
  return Number.isInteger(value) && value >= 0;
}

const OUTCOMES = new Set<ActionOutcome>(['succeeded', 'failed', 'timed_out', 'denied', 'cancelled']);
const STOP_REASONS = new Set<InvestigationStopReason>([
  'limit_exhausted', 'no_progress', 'material_conflict', 'tool_unavailable', 'awaiting_moderator', 'completed',
]);

function parseObject(value: unknown): Record<string, unknown> {
  const parsed: unknown = typeof value === 'string' ? JSON.parse(value) : value;
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) fail('investigation_conflict');
  return parsed as Record<string, unknown>;
}

function fail(code: InvestigationLedgerErrorCode): never {
  throw new InvestigationLedgerError(code);
}
