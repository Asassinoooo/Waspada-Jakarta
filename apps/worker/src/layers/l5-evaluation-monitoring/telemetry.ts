export interface ApiTelemetryRecord {
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
