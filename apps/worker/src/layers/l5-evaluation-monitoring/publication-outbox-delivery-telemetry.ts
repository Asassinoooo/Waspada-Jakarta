export const PUBLICATION_OUTBOX_DELIVERY_EVENT_NAME = 'publication_outbox_delivery' as const;
export const PUBLICATION_OUTBOX_DELIVERY_TELEMETRY_MAX_PAGE_SIZE = 20;

export interface PublicationOutboxDeliveryTelemetryCounts {
  readonly reserved: number;
  readonly delivered: number;
  readonly retryableFailures: number;
  readonly permanentFailures: number;
}

export interface PublicationOutboxDeliveryTelemetryRecord {
  readonly eventName: typeof PUBLICATION_OUTBOX_DELIVERY_EVENT_NAME;
  readonly outcome: 'completed' | 'failed';
  readonly durationMs: number;
  readonly counts: PublicationOutboxDeliveryTelemetryCounts;
}

export interface PublicationOutboxDeliveryTelemetrySink {
  record(record: PublicationOutboxDeliveryTelemetryRecord): void;
}

export const noOpPublicationOutboxDeliveryTelemetry: PublicationOutboxDeliveryTelemetrySink = {
  record: () => undefined,
};

/** Emits only the fixed outcome, a finite duration, and counts bounded to one relay page. */
export const consolePublicationOutboxDeliveryTelemetry: PublicationOutboxDeliveryTelemetrySink = {
  record(record) {
    try {
      if (!isValidRecord(record)) return;
      console.log({
        event_name: PUBLICATION_OUTBOX_DELIVERY_EVENT_NAME,
        outcome: record.outcome,
        duration_ms: record.durationMs,
        reserved_count: record.counts.reserved,
        delivered_count: record.counts.delivered,
        retryable_failure_count: record.counts.retryableFailures,
        permanent_failure_count: record.counts.permanentFailures,
      });
    } catch {
      // Telemetry never changes the delivery pass result.
    }
  },
};

export function isValidPublicationOutboxDeliveryTelemetryRecord(value: unknown): value is PublicationOutboxDeliveryTelemetryRecord {
  return isValidRecord(value);
}

function isValidRecord(value: unknown): value is PublicationOutboxDeliveryTelemetryRecord {
  if (!isObject(value) || !hasExactKeys(value, ['eventName', 'outcome', 'durationMs', 'counts'])
    || value.eventName !== PUBLICATION_OUTBOX_DELIVERY_EVENT_NAME
    || (value.outcome !== 'completed' && value.outcome !== 'failed')
    || typeof value.durationMs !== 'number' || !Number.isFinite(value.durationMs) || value.durationMs < 0) {
    return false;
  }
  const counts = value.counts;
  if (!isObject(counts) || !hasExactKeys(counts, ['reserved', 'delivered', 'retryableFailures', 'permanentFailures'])) return false;
  const values = [counts.reserved, counts.delivered, counts.retryableFailures, counts.permanentFailures];
  if (!values.every((count) => typeof count === 'number' && Number.isSafeInteger(count)
    && count >= 0 && count <= PUBLICATION_OUTBOX_DELIVERY_TELEMETRY_MAX_PAGE_SIZE)) return false;
  const [reserved, delivered, retryableFailures, permanentFailures] = values as number[];
  return delivered + retryableFailures + permanentFailures <= reserved
    && reserved <= PUBLICATION_OUTBOX_DELIVERY_TELEMETRY_MAX_PAGE_SIZE;
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => key in value);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
