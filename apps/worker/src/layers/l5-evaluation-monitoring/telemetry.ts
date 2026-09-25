export const API_REQUEST_EVENT_NAME = "api_request" as const;

export interface ApiTelemetryRecord {
  eventName: typeof API_REQUEST_EVENT_NAME;
  route: "context" | "events" | "other";
  status: number;
  durationMs: number;
}

export interface TelemetrySink {
  record(record: ApiTelemetryRecord): void;
}

// The demo keeps the telemetry boundary available without storing or logging
// request data. A measured sink is a separate, reviewed implementation task.
export const noOpTelemetry: TelemetrySink = {
  record: () => undefined,
};

// Keep the persisted JSON shape stable and limited to the safe request metrics.
export const consoleTelemetry: TelemetrySink = {
  record({ eventName, route, status, durationMs }) {
    console.log({
      event_name: eventName,
      route,
      http_status: status,
      duration_ms: durationMs,
    });
  },
};
