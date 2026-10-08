export const API_REQUEST_EVENT_NAME = "api_request" as const;
export const L2_RETRIEVAL_EVENT_NAME = "l2_retrieval" as const;
export const L2_DIRECT_REASONING_EVENT_NAME = "l2_direct_reasoning" as const;
export const L3_LEDGER_OPERATION_EVENT_NAME = "l3_ledger_operation" as const;
export const L3_COORDINATOR_ADVANCE_EVENT_NAME = "l3_coordinator_advance" as const;
export const L1_SYNTHETIC_FIXTURE_JOB_EVENT_NAME = "l1_synthetic_fixture_job" as const;
export const SYNTHETIC_SOURCE_POLL_PROCESS_EVENT_NAME = "l1_synthetic_source_poll_process" as const;
export const FRESHNESS_DUE_SCHEDULE_EVENT_NAME = "freshness_due_schedule" as const;

export const L1_SYNTHETIC_FIXTURE_TELEMETRY_MAX_COUNT = 1_000_000;

const L1_SYNTHETIC_FIXTURE_MAX_REPORTS = 500;
const L1_SYNTHETIC_FIXTURE_MAX_CHUNKS_PER_REPORT = 1_024;

export type L3LedgerOperation =
  | "create"
  | "reserve_action"
  | "start_action"
  | "reconcile_action"
  | "reconcile_interrupted"
  | "release_uninvoked"
  | "pause"
  | "resume"
  | "terminate";

export type L3LedgerCaseStatus = "open" | "paused" | "completed" | "stopped_for_review";

export type L3CoordinatorAdvanceOutcome =
  | "continue"
  | "sufficient_context"
  | "review_required"
  | "error";

export type L3LedgerStopReason =
  | "limit_exhausted"
  | "no_progress"
  | "material_conflict"
  | "tool_unavailable"
  | "awaiting_moderator"
  | "completed";

export type L1SyntheticFixtureJobOutcome =
  | "idle"
  | "completed"
  | "not_eligible"
  | "lost_lease"
  | "failed";

export type SyntheticSourcePollProcessOutcome =
  | "idle"
  | "completed"
  | "not_eligible"
  | "lost_lease"
  | "failed";

export type FreshnessDueScheduleOutcome = "completed" | "failed" | "terminal_replay";

export interface FreshnessDueScheduleTelemetryCounts {
  written: number;
  replayed: number;
  noChange: number;
  conflicts: number;
  failures: number;
}

export type L2RetrievalSemanticStatus =
  | "not_requested"
  | "query_vector_missing"
  | "matched"
  | "no_compatible_vector";

export type L2DirectReasoningOutcome =
  | "investigation_required"
  | "succeeded"
  | "not_configured"
  | "invalid_request"
  | "invalid_output"
  | "provider_error"
  | "error";

export interface ApiTelemetryRecord {
  eventName: typeof API_REQUEST_EVENT_NAME;
  route: "context" | "events" | "other";
  status: number;
  durationMs: number;
}

export interface L2RetrievalSuccessTelemetryRecord {
  eventName: typeof L2_RETRIEVAL_EVENT_NAME;
  outcome: "success";
  durationMs: number;
  candidateCount: number;
  rowsExamined: number;
  scanTruncated: boolean;
  resultTruncated: boolean;
  semanticStatus: L2RetrievalSemanticStatus;
}

export interface L2RetrievalErrorTelemetryRecord {
  eventName: typeof L2_RETRIEVAL_EVENT_NAME;
  outcome: "error";
  durationMs: number;
}

export type L2RetrievalTelemetryRecord =
  | L2RetrievalSuccessTelemetryRecord
  | L2RetrievalErrorTelemetryRecord;

export interface L2DirectReasoningTelemetryRecord {
  eventName: typeof L2_DIRECT_REASONING_EVENT_NAME;
  outcome: L2DirectReasoningOutcome;
  durationMs: number;
}

export interface L3LedgerOperationSuccessTelemetryRecord {
  eventName: typeof L3_LEDGER_OPERATION_EVENT_NAME;
  operation: L3LedgerOperation;
  outcome: "success";
  durationMs: number;
  caseStatus: L3LedgerCaseStatus;
  stopReason: L3LedgerStopReason | null;
  consumedToolAttempts: number;
  consumedReasoningTurns: number;
  consumedActiveSeconds: number;
  consumedModelTokens: number;
}

export interface L3LedgerOperationErrorTelemetryRecord {
  eventName: typeof L3_LEDGER_OPERATION_EVENT_NAME;
  operation: L3LedgerOperation;
  outcome: "error";
  durationMs: number;
}

export interface L3CoordinatorAdvanceTelemetryRecord {
  eventName: typeof L3_COORDINATOR_ADVANCE_EVENT_NAME;
  outcome: L3CoordinatorAdvanceOutcome;
  durationMs: number;
}

export interface L1SyntheticFixtureJobCompletedTelemetryRecord {
  eventName: typeof L1_SYNTHETIC_FIXTURE_JOB_EVENT_NAME;
  outcome: "completed";
  durationMs: number;
  empty: boolean;
  reportCount: number;
  evidenceReferenceCount: number;
  chunkCount: number;
  geometryCount: number;
}

export interface L1SyntheticFixtureJobOtherTelemetryRecord {
  eventName: typeof L1_SYNTHETIC_FIXTURE_JOB_EVENT_NAME;
  outcome: Exclude<L1SyntheticFixtureJobOutcome, "completed">;
  durationMs: number;
}

export interface SyntheticSourcePollProcessCompletedTelemetryRecord {
  eventName: typeof SYNTHETIC_SOURCE_POLL_PROCESS_EVENT_NAME;
  outcome: "completed";
  durationMs: number;
  empty: boolean;
  reportCount: number;
  evidenceReferenceCount: number;
  chunkCount: number;
  geometryCount: number;
}

export interface SyntheticSourcePollProcessOtherTelemetryRecord {
  eventName: typeof SYNTHETIC_SOURCE_POLL_PROCESS_EVENT_NAME;
  outcome: Exclude<SyntheticSourcePollProcessOutcome, "completed">;
  durationMs: number;
}

export type FreshnessDueScheduleTelemetryRecord =
  | {
    eventName: typeof FRESHNESS_DUE_SCHEDULE_EVENT_NAME;
    outcome: "completed";
    durationMs: number;
    counts: FreshnessDueScheduleTelemetryCounts;
  }
  | {
    eventName: typeof FRESHNESS_DUE_SCHEDULE_EVENT_NAME;
    outcome: "failed";
    durationMs: number;
    counts?: FreshnessDueScheduleTelemetryCounts;
  }
  | {
    eventName: typeof FRESHNESS_DUE_SCHEDULE_EVENT_NAME;
    outcome: "terminal_replay";
    durationMs: number;
  };

export type L1SyntheticFixtureJobTelemetryRecord =
  | L1SyntheticFixtureJobCompletedTelemetryRecord
  | L1SyntheticFixtureJobOtherTelemetryRecord;

export type SyntheticSourcePollProcessTelemetryRecord =
  | SyntheticSourcePollProcessCompletedTelemetryRecord
  | SyntheticSourcePollProcessOtherTelemetryRecord;

export type L3LedgerTelemetryRecord =
  | L3LedgerOperationSuccessTelemetryRecord
  | L3LedgerOperationErrorTelemetryRecord;

export type TelemetryRecord =
  | ApiTelemetryRecord
  | L2RetrievalTelemetryRecord
  | L2DirectReasoningTelemetryRecord
  | L3LedgerTelemetryRecord
  | L3CoordinatorAdvanceTelemetryRecord
  | L1SyntheticFixtureJobTelemetryRecord
  | SyntheticSourcePollProcessTelemetryRecord
  | FreshnessDueScheduleTelemetryRecord;

export interface TelemetrySink {
  record(record: TelemetryRecord): void;
}

// Recording stays opt-in, with no retention or logging by default.
export const noOpTelemetry: TelemetrySink = {
  record: () => undefined,
};

// Keep each structured JSON shape stable and limited to its safe allowlist.
export const consoleTelemetry: TelemetrySink = {
  record(record) {
    try {
      recordConsoleTelemetry(record);
    } catch {
      // Console telemetry must not throw for forged or malformed runtime values.
    }
  },
};

function recordConsoleTelemetry(record: TelemetryRecord): void {
  const input: unknown = record;
  if (!isRecord(input)) return;

  if (input.eventName === API_REQUEST_EVENT_NAME) {
    if (!isApiTelemetryRecord(input)) return;
    console.log({
      event_name: API_REQUEST_EVENT_NAME,
      route: input.route,
      http_status: input.status,
      duration_ms: input.durationMs,
    });
    return;
  }

  if (input.eventName === L2_RETRIEVAL_EVENT_NAME) {
    if (input.outcome === "success") {
      if (!isL2RetrievalSuccessRecord(input)) return;
      console.log({
        event_name: L2_RETRIEVAL_EVENT_NAME,
        outcome: "success",
        duration_ms: input.durationMs,
        candidate_count: input.candidateCount,
        rows_examined: input.rowsExamined,
        scan_truncated: input.scanTruncated,
        result_truncated: input.resultTruncated,
        semantic_status: input.semanticStatus,
      });
      return;
    }

    if (input.outcome === "error" && isL2RetrievalErrorRecord(input)) {
      console.log({
        event_name: L2_RETRIEVAL_EVENT_NAME,
        outcome: "error",
        duration_ms: input.durationMs,
      });
    }
    return;
  }

  if (input.eventName === L2_DIRECT_REASONING_EVENT_NAME) {
    if (!isL2DirectReasoningRecord(input)) return;
    console.log({
      event_name: L2_DIRECT_REASONING_EVENT_NAME,
      outcome: input.outcome,
      duration_ms: input.durationMs,
    });
    return;
  }

  if (input.eventName === L1_SYNTHETIC_FIXTURE_JOB_EVENT_NAME) {
    if (!isL1SyntheticFixtureJobRecord(input)) return;
    if (input.outcome === "completed") {
      console.log({
        event_name: L1_SYNTHETIC_FIXTURE_JOB_EVENT_NAME,
        outcome: "completed",
        duration_ms: input.durationMs,
        empty: input.empty,
        report_count: input.reportCount,
        evidence_reference_count: input.evidenceReferenceCount,
        chunk_count: input.chunkCount,
        geometry_count: input.geometryCount,
      });
      return;
    }
    console.log({
      event_name: L1_SYNTHETIC_FIXTURE_JOB_EVENT_NAME,
      outcome: input.outcome,
      duration_ms: input.durationMs,
    });
    return;
  }

  if (input.eventName === SYNTHETIC_SOURCE_POLL_PROCESS_EVENT_NAME) {
    if (!isSyntheticSourcePollProcessTelemetryRecord(input)) return;
    if (input.outcome === "completed") {
      console.log({
        event_name: SYNTHETIC_SOURCE_POLL_PROCESS_EVENT_NAME,
        outcome: "completed",
        duration_ms: input.durationMs,
        empty: input.empty,
        report_count: input.reportCount,
        evidence_reference_count: input.evidenceReferenceCount,
        chunk_count: input.chunkCount,
        geometry_count: input.geometryCount,
      });
      return;
    }
    console.log({
      event_name: SYNTHETIC_SOURCE_POLL_PROCESS_EVENT_NAME,
      outcome: input.outcome,
      duration_ms: input.durationMs,
    });
    return;
  }

  if (input.eventName === FRESHNESS_DUE_SCHEDULE_EVENT_NAME) {
    if (!isFreshnessDueScheduleRecord(input)) return;
    console.log({
      event_name: FRESHNESS_DUE_SCHEDULE_EVENT_NAME,
      outcome: input.outcome,
      duration_ms: input.durationMs,
      ...(input.counts === undefined ? {} : {
        counts: {
          written: input.counts.written,
          replayed: input.counts.replayed,
          no_change: input.counts.noChange,
          conflicts: input.counts.conflicts,
          failures: input.counts.failures,
        },
      }),
    });
    return;
  }

  if (input.eventName === L3_COORDINATOR_ADVANCE_EVENT_NAME) {
    if (!isL3CoordinatorAdvanceRecord(input)) return;
    console.log({
      event_name: L3_COORDINATOR_ADVANCE_EVENT_NAME,
      outcome: input.outcome,
      duration_ms: input.durationMs,
    });
    return;
  }

  if (input.eventName !== L3_LEDGER_OPERATION_EVENT_NAME) return;

  if (input.outcome === "success") {
    if (!isL3LedgerOperationSuccessRecord(input)) return;
    console.log({
      event_name: L3_LEDGER_OPERATION_EVENT_NAME,
      operation: input.operation,
      outcome: "success",
      duration_ms: input.durationMs,
      case_status: input.caseStatus,
      stop_reason: input.stopReason,
      consumed_tool_attempts: input.consumedToolAttempts,
      consumed_reasoning_turns: input.consumedReasoningTurns,
      consumed_active_seconds: input.consumedActiveSeconds,
      consumed_model_tokens: input.consumedModelTokens,
    });
    return;
  }

  if (input.outcome === "error" && isL3LedgerOperationErrorRecord(input)) {
    console.log({
      event_name: L3_LEDGER_OPERATION_EVENT_NAME,
      operation: input.operation,
      outcome: "error",
      duration_ms: input.durationMs,
    });
  }
}

const API_ROUTES = new Set<ApiTelemetryRecord["route"]>(["context", "events", "other"]);
const L2_SEMANTIC_STATUSES = new Set<L2RetrievalSemanticStatus>([
  "not_requested",
  "query_vector_missing",
  "matched",
  "no_compatible_vector",
]);
const L2_DIRECT_REASONING_OUTCOMES = new Set<L2DirectReasoningOutcome>([
  "investigation_required",
  "succeeded",
  "not_configured",
  "invalid_request",
  "invalid_output",
  "provider_error",
  "error",
]);
const L3_OPERATIONS = new Set<L3LedgerOperation>([
  "create",
  "reserve_action",
  "start_action",
  "reconcile_action",
  "reconcile_interrupted",
  "release_uninvoked",
  "pause",
  "resume",
  "terminate",
]);
const L3_CASE_STATUSES = new Set<L3LedgerCaseStatus>([
  "open",
  "paused",
  "completed",
  "stopped_for_review",
]);
const L3_STOP_REASONS = new Set<L3LedgerStopReason>([
  "limit_exhausted",
  "no_progress",
  "material_conflict",
  "tool_unavailable",
  "awaiting_moderator",
  "completed",
]);
const L3_COORDINATOR_ADVANCE_OUTCOMES = new Set<L3CoordinatorAdvanceOutcome>([
  "continue",
  "sufficient_context",
  "review_required",
  "error",
]);
const FRESHNESS_DUE_SCHEDULE_OUTCOMES = new Set<FreshnessDueScheduleOutcome>([
  "completed",
  "failed",
  "terminal_replay",
]);
const SYNTHETIC_SOURCE_POLL_PROCESS_OUTCOMES = new Set<SyntheticSourcePollProcessOutcome>([
  "idle",
  "completed",
  "not_eligible",
  "lost_lease",
  "failed",
]);
const FRESHNESS_DUE_SCHEDULE_COUNT_KEYS = ["written", "replayed", "noChange", "conflicts", "failures"] as const;
const FRESHNESS_DUE_SCHEDULE_MAX_COUNT = 100;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isCounter(value: unknown): value is number {
  return Number.isSafeInteger(value) && isFiniteNonNegative(value);
}

function isApiTelemetryRecord(value: Record<string, unknown>): boolean {
  return API_ROUTES.has(value.route as ApiTelemetryRecord["route"])
    && Number.isInteger(value.status)
    && (value.status as number) >= 100
    && (value.status as number) <= 599
    && isFiniteNonNegative(value.durationMs);
}

function isL2RetrievalSuccessRecord(value: Record<string, unknown>): boolean {
  return isFiniteNonNegative(value.durationMs)
    && isCounter(value.candidateCount)
    && isCounter(value.rowsExamined)
    && typeof value.scanTruncated === "boolean"
    && typeof value.resultTruncated === "boolean"
    && L2_SEMANTIC_STATUSES.has(value.semanticStatus as L2RetrievalSemanticStatus);
}

function isL2RetrievalErrorRecord(value: Record<string, unknown>): boolean {
  return isFiniteNonNegative(value.durationMs);
}

function isL2DirectReasoningRecord(value: Record<string, unknown>): boolean {
  return L2_DIRECT_REASONING_OUTCOMES.has(value.outcome as L2DirectReasoningOutcome)
    && isFiniteNonNegative(value.durationMs);
}

function isL3LedgerOperationSuccessRecord(value: Record<string, unknown>): boolean {
  return L3_OPERATIONS.has(value.operation as L3LedgerOperation)
    && isFiniteNonNegative(value.durationMs)
    && L3_CASE_STATUSES.has(value.caseStatus as L3LedgerCaseStatus)
    && (value.stopReason === null || L3_STOP_REASONS.has(value.stopReason as L3LedgerStopReason))
    && isCounter(value.consumedToolAttempts)
    && isCounter(value.consumedReasoningTurns)
    && isFiniteNonNegative(value.consumedActiveSeconds)
    && isCounter(value.consumedModelTokens);
}

function isL3LedgerOperationErrorRecord(value: Record<string, unknown>): boolean {
  return L3_OPERATIONS.has(value.operation as L3LedgerOperation)
    && isFiniteNonNegative(value.durationMs);
}

function isL3CoordinatorAdvanceRecord(value: Record<string, unknown>): boolean {
  return hasExactPlainDataKeys(value, ["eventName", "outcome", "durationMs"])
    && L3_COORDINATOR_ADVANCE_OUTCOMES.has(value.outcome as L3CoordinatorAdvanceOutcome)
    && isFiniteNonNegative(value.durationMs);
}

function isL1SyntheticFixtureJobRecord(value: Record<string, unknown>): boolean {
  if (!isFiniteNonNegative(value.durationMs)
    || !["idle", "completed", "not_eligible", "lost_lease", "failed"]
      .includes(value.outcome as L1SyntheticFixtureJobOutcome)) {
    return false;
  }

  if (value.outcome !== "completed") {
    return !hasOwn(value, "empty")
      && !hasOwn(value, "reportCount")
      && !hasOwn(value, "evidenceReferenceCount")
      && !hasOwn(value, "chunkCount")
      && !hasOwn(value, "geometryCount");
  }

  return typeof value.empty === "boolean"
    && isBoundedCount(value.reportCount)
    && value.reportCount <= L1_SYNTHETIC_FIXTURE_MAX_REPORTS
    && isBoundedCount(value.evidenceReferenceCount)
    && isBoundedCount(value.chunkCount)
    && value.chunkCount <= value.reportCount * L1_SYNTHETIC_FIXTURE_MAX_CHUNKS_PER_REPORT
    && isBoundedCount(value.geometryCount)
    && value.geometryCount <= value.reportCount
    && (value.empty
      ? value.reportCount === 0
        && value.evidenceReferenceCount === 0
        && value.chunkCount === 0
        && value.geometryCount === 0
      : value.reportCount > 0);
}

export function isSyntheticSourcePollProcessTelemetryRecord(
  value: unknown,
): value is SyntheticSourcePollProcessTelemetryRecord {
  if (!isRecord(value)
    || value.eventName !== SYNTHETIC_SOURCE_POLL_PROCESS_EVENT_NAME
    || !isFiniteNonNegative(value.durationMs)
    || !SYNTHETIC_SOURCE_POLL_PROCESS_OUTCOMES.has(value.outcome as SyntheticSourcePollProcessOutcome)) {
    return false;
  }

  if (value.outcome !== "completed") {
    return hasExactPlainDataKeys(value, ["eventName", "outcome", "durationMs"]);
  }

  return hasExactPlainDataKeys(value, [
    "eventName",
    "outcome",
    "durationMs",
    "empty",
    "reportCount",
    "evidenceReferenceCount",
    "chunkCount",
    "geometryCount",
  ])
    && typeof value.empty === "boolean"
    && isBoundedCount(value.reportCount)
    && value.reportCount <= L1_SYNTHETIC_FIXTURE_MAX_REPORTS
    && isBoundedCount(value.evidenceReferenceCount)
    && isBoundedCount(value.chunkCount)
    && value.chunkCount <= value.reportCount * L1_SYNTHETIC_FIXTURE_MAX_CHUNKS_PER_REPORT
    && isBoundedCount(value.geometryCount)
    && value.geometryCount <= value.reportCount
    && (value.empty
      ? value.reportCount === 0
        && value.evidenceReferenceCount === 0
        && value.chunkCount === 0
        && value.geometryCount === 0
      : value.reportCount > 0);
}

function isFreshnessDueScheduleRecord(
  value: Record<string, unknown>,
): value is Record<string, unknown> & {
  outcome: FreshnessDueScheduleOutcome;
  durationMs: number;
  counts?: FreshnessDueScheduleTelemetryCounts;
} {
  if (!FRESHNESS_DUE_SCHEDULE_OUTCOMES.has(value.outcome as FreshnessDueScheduleOutcome)
    || !isFiniteNonNegative(value.durationMs)) {
    return false;
  }

  if (value.outcome === "terminal_replay") {
    return hasExactKeys(value, ["eventName", "outcome", "durationMs"]);
  }

  if (value.outcome === "completed") {
    return hasExactKeys(value, ["eventName", "outcome", "durationMs", "counts"])
      && isFreshnessDueScheduleCounts(value.counts);
  }

  return hasExactKeys(value, ["eventName", "outcome", "durationMs"])
    || (hasExactKeys(value, ["eventName", "outcome", "durationMs", "counts"])
      && isFreshnessDueScheduleCounts(value.counts));
}

function isFreshnessDueScheduleCounts(value: unknown): value is FreshnessDueScheduleTelemetryCounts {
  if (!isRecord(value) || !hasExactKeys(value, FRESHNESS_DUE_SCHEDULE_COUNT_KEYS)) return false;

  let total = 0;
  for (const key of FRESHNESS_DUE_SCHEDULE_COUNT_KEYS) {
    const count = value[key];
    if (!isCounter(count) || count > FRESHNESS_DUE_SCHEDULE_MAX_COUNT) return false;
    total += count;
  }
  return total <= FRESHNESS_DUE_SCHEDULE_MAX_COUNT;
}

function isBoundedCount(value: unknown): value is number {
  return isCounter(value) && value <= L1_SYNTHETIC_FIXTURE_TELEMETRY_MAX_COUNT;
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function hasExactKeys(value: object, expectedKeys: readonly string[]): boolean {
  const expected = new Set(expectedKeys);
  const keys = Object.keys(value);
  return keys.length === expected.size && keys.every((key) => expected.has(key));
}

function hasExactPlainDataKeys(value: object, expectedKeys: readonly string[]): boolean {
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;

  const expected = new Set(expectedKeys);
  const keys = Reflect.ownKeys(value);
  if (keys.length !== expected.size) return false;

  return keys.every((key) => {
    if (typeof key !== "string" || !expected.has(key)) return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor?.enumerable === true
      && Object.prototype.hasOwnProperty.call(descriptor, "value");
  });
}
