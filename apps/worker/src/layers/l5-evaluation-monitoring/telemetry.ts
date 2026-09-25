export const API_REQUEST_EVENT_NAME = "api_request" as const;
export const L2_RETRIEVAL_EVENT_NAME = "l2_retrieval" as const;

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

export type TelemetryRecord = ApiTelemetryRecord | L2RetrievalTelemetryRecord;

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
    if (record.eventName === API_REQUEST_EVENT_NAME) {
      console.log({
        event_name: API_REQUEST_EVENT_NAME,
        route: record.route,
        http_status: record.status,
        duration_ms: record.durationMs,
      });
      return;
    }

    if (record.eventName !== L2_RETRIEVAL_EVENT_NAME) return;

    if (record.outcome === "success") {
      console.log({
        event_name: L2_RETRIEVAL_EVENT_NAME,
        outcome: "success",
        duration_ms: record.durationMs,
        candidate_count: record.candidateCount,
        rows_examined: record.rowsExamined,
        scan_truncated: record.scanTruncated,
        result_truncated: record.resultTruncated,
        semantic_status: record.semanticStatus,
      });
      return;
    }

    if (record.outcome === "error") {
      console.log({
        event_name: L2_RETRIEVAL_EVENT_NAME,
        outcome: "error",
        duration_ms: record.durationMs,
      });
    }
  },
};
