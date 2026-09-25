export const API_REQUEST_EVENT_NAME = "api_request" as const;
export const L2_RETRIEVAL_EVENT_NAME = "l2_retrieval" as const;
export const L3_LEDGER_OPERATION_EVENT_NAME = "l3_ledger_operation" as const;

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

export type L3LedgerStopReason =
  | "limit_exhausted"
  | "no_progress"
  | "material_conflict"
  | "tool_unavailable"
  | "awaiting_moderator"
  | "completed";

export type L2RetrievalSemanticStatus =
  | "not_requested"
  | "query_vector_missing"
  | "matched"
  | "no_compatible_vector";

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

export type L3LedgerTelemetryRecord =
  | L3LedgerOperationSuccessTelemetryRecord
  | L3LedgerOperationErrorTelemetryRecord;

export type TelemetryRecord =
  | ApiTelemetryRecord
  | L2RetrievalTelemetryRecord
  | L3LedgerTelemetryRecord;

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
  },
};

const API_ROUTES = new Set<ApiTelemetryRecord["route"]>(["context", "events", "other"]);
const L2_SEMANTIC_STATUSES = new Set<L2RetrievalSemanticStatus>([
  "not_requested",
  "query_vector_missing",
  "matched",
  "no_compatible_vector",
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
