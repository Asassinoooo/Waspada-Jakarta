import type {
  PreviewKind,
  PreviewRecord,
  PreviewSource,
  PreviewSourceId,
  SourcePreviewPayload,
} from "@waspada/worker/source-preview-contracts";

export type SourcePreviewRequestMode = "snapshot" | "fetch";
export interface SourcePreviewClock {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export class SourcePreviewHttpError extends Error {
  constructor(readonly status: number) {
    super("Source preview request failed");
    this.name = "SourcePreviewHttpError";
  }
}

export class SourcePreviewPayloadError extends Error {
  constructor() {
    super("Source preview response could not be safely read");
    this.name = "SourcePreviewPayloadError";
  }
}

export class SourcePreviewTimeoutError extends Error {
  constructor() {
    super("Source preview request timed out");
    this.name = "SourcePreviewTimeoutError";
  }
}

function createAbortError(): Error {
  const error = new Error("Source preview request was aborted");
  error.name = "AbortError";
  return error;
}

const ENDPOINT = "/api/v1/demo/source-preview";
const REQUEST_DEADLINE_MS = 35_000;
const MAX_RESPONSE_BYTES = 512 * 1024;
const MAX_RECORDS_PER_SOURCE = 100;
const MAX_REJECTED_COUNT = 10_000;
const MAX_ID_LENGTH = 96;
const MAX_TITLE_LENGTH = 128;
const MAX_SOURCE_STATUS_LENGTH = 64;
const MAX_ATTRIBUTION_LENGTH = 200;
const CRS84_ENVELOPES = {
  osm: { west: 106.78, south: -6.24, east: 106.88, north: -6.14 },
  petabencana: { west: 106.32, south: -6.4, east: 106.98, north: -5.16 },
} as const;
const MAX_PETABENCANA_REPORT_AGE_MS = 24 * 60 * 60 * 1000;
const browserClock: SourcePreviewClock = {
  setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>),
};
const timestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/u;
const sourceIds: readonly PreviewSourceId[] = ["osm", "petabencana"];
const allowedKinds: Readonly<Record<PreviewSourceId, readonly PreviewKind[]>> = {
  osm: ["hospital", "police", "fire_station"],
  petabencana: ["flood_report"],
};
const allowedAttribution: Readonly<Record<PreviewSourceId, string>> = {
  osm: "© OpenStreetMap contributors · ODbL 1.0",
  petabencana: "Data disediakan oleh PetaBencana.id, dilisensikan di bawah CC BY-NC 4.0.",
};
const allowedLicense: Readonly<Record<PreviewSourceId, string>> = {
  osm: "https://opendatacommons.org/licenses/odbl/1-0/",
  petabencana: "https://creativecommons.org/licenses/by-nc/4.0/",
};
const sourceErrors = ["timeout", "http_error", "invalid_payload"] as const;
const sourceStatuses = ["available", "empty", "unavailable", "not_requested"] as const;
const dataModes = ["snapshot", "fetched", "none"] as const;
const recordKeys = [
  "id", "source", "kind", "title", "coordinates", "coordinate_kind", "source_created_at", "source_status", "source_url",
] as const;
const sourceKeys = [
  "id", "status", "data_mode", "fetched_at", "source_updated_at", "attribution", "license_url", "records",
  "rejected_count", "limited", "error",
] as const;
const payloadKeys = ["schema_version", "mode", "generated_at", "cached", "sources"] as const;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && keys.every((key) => expected.includes(key));
}

function isMember<T extends string>(value: unknown, values: readonly T[]): value is T {
  return typeof value === "string" && values.includes(value as T);
}

function isInstant(value: unknown): value is string {
  return typeof value === "string"
    && value.length <= 64
    && timestampPattern.test(value)
    && Number.isFinite(Date.parse(value));
}

function isOptionalInstant(value: unknown): value is string | null {
  return value === null || isInstant(value);
}

function isSafeText(value: unknown, maximumLength: number): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= maximumLength
    && value.trim() === value
    && !/[\u0000-\u001f\u007f]/u.test(value);
}

function isSafeOsmId(value: string): boolean {
  return value.length <= MAX_ID_LENGTH && /^osm:(?:node|way|relation)\/[1-9][0-9]{0,19}$/u.test(value);
}

function isSafePetabencanaId(value: string): boolean {
  return value.length <= MAX_ID_LENGTH && /^petabencana:[A-Za-z0-9_-]{1,64}$/u.test(value);
}

function isSourceUrl(value: unknown, source: PreviewSourceId, id: string): value is string {
  if (typeof value !== "string") return false;
  if (source === "petabencana") return value === "https://petabencana.id/";
  const objectId = id.slice("osm:".length);
  return value === "https://www.openstreetmap.org/" + objectId;
}

function parseRecord(value: unknown, source: PreviewSourceId): PreviewRecord {
  if (!isObject(value) || !hasExactKeys(value, recordKeys)) throw new SourcePreviewPayloadError();
  if (
    typeof value.id !== "string" ||
    !(source === "osm" ? isSafeOsmId(value.id) : isSafePetabencanaId(value.id)) ||
    value.source !== source ||
    !isMember(value.kind, allowedKinds[source]) ||
    !isSafeText(value.title, MAX_TITLE_LENGTH) ||
    !Array.isArray(value.coordinates) || value.coordinates.length !== 2 ||
    typeof value.coordinates[0] !== "number" || !Number.isFinite(value.coordinates[0]) ||
    typeof value.coordinates[1] !== "number" || !Number.isFinite(value.coordinates[1]) ||
    value.coordinates[0] < CRS84_ENVELOPES[source].west || value.coordinates[0] > CRS84_ENVELOPES[source].east ||
    value.coordinates[1] < CRS84_ENVELOPES[source].south || value.coordinates[1] > CRS84_ENVELOPES[source].north ||
    !isMember(value.coordinate_kind, ["source_point", "source_extent_center"] as const) ||
    (source === "petabencana" && value.coordinate_kind !== "source_point") ||
    !isOptionalInstant(value.source_created_at) ||
    (source === "osm" && value.source_created_at !== null) ||
    !(value.source_status === null || isSafeText(value.source_status, MAX_SOURCE_STATUS_LENGTH)) ||
    (source === "osm" && value.source_status !== null) ||
    !isSourceUrl(value.source_url, source, value.id)
  ) {
    throw new SourcePreviewPayloadError();
  }
  if (source === "petabencana" && value.title !== "Laporan banjir warga") {
    throw new SourcePreviewPayloadError();
  }

  return {
    id: value.id,
    source,
    kind: value.kind,
    title: value.title,
    coordinates: [value.coordinates[0], value.coordinates[1]],
    coordinate_kind: value.coordinate_kind,
    source_created_at: value.source_created_at,
    source_status: value.source_status,
    source_url: value.source_url,
  };
}

function parseSource(value: unknown, expectedId: PreviewSourceId): PreviewSource {
  if (!isObject(value) || !hasExactKeys(value, sourceKeys) || value.id !== expectedId) {
    throw new SourcePreviewPayloadError();
  }
  if (
    !isMember(value.status, sourceStatuses) ||
    !isMember(value.data_mode, dataModes) ||
    !isOptionalInstant(value.fetched_at) ||
    !isOptionalInstant(value.source_updated_at) ||
    !isSafeText(value.attribution, MAX_ATTRIBUTION_LENGTH) ||
    value.attribution !== allowedAttribution[expectedId] ||
    value.license_url !== allowedLicense[expectedId] ||
    !Array.isArray(value.records) || value.records.length > MAX_RECORDS_PER_SOURCE ||
    typeof value.rejected_count !== "number" || !Number.isSafeInteger(value.rejected_count) || value.rejected_count < 0 || value.rejected_count > MAX_REJECTED_COUNT ||
    typeof value.limited !== "boolean" ||
    !(value.error === null || isMember(value.error, sourceErrors))
  ) {
    throw new SourcePreviewPayloadError();
  }

  const records = value.records.map((record) => parseRecord(record, expectedId));
  const fetchedAtMs = value.fetched_at === null ? null : Date.parse(value.fetched_at);
  const reportTimesAreFresh = expectedId !== "petabencana" || records.every((record) => {
    if (record.source_created_at === null) return true;
    if (fetchedAtMs === null) return false;
    const reportCreatedAtMs = Date.parse(record.source_created_at);
    return reportCreatedAtMs <= fetchedAtMs && fetchedAtMs - reportCreatedAtMs <= MAX_PETABENCANA_REPORT_AGE_MS;
  });
  const statusIsConsistent = (() => {
    switch (value.status) {
      case "available":
        return records.length > 0 && value.data_mode !== "none" && value.error === null;
      case "empty":
        return records.length === 0 && value.data_mode !== "none" && value.error === null;
      case "unavailable":
        return records.length === 0 && value.error !== null;
      case "not_requested":
        return records.length === 0 && value.data_mode === "none" && value.fetched_at === null && value.error === null;
    }
  })();
  if (!statusIsConsistent || !reportTimesAreFresh) throw new SourcePreviewPayloadError();

  return {
    id: expectedId,
    status: value.status,
    data_mode: value.data_mode,
    fetched_at: value.fetched_at,
    source_updated_at: value.source_updated_at,
    attribution: value.attribution,
    license_url: value.license_url,
    records,
    rejected_count: value.rejected_count,
    limited: value.limited,
    error: value.error,
  };
}

/** Validates and copies only the versioned preview fields allowed in the browser. */
export function validateSourcePreviewPayload(value: unknown): SourcePreviewPayload {
  if (!isObject(value) || !hasExactKeys(value, payloadKeys)) throw new SourcePreviewPayloadError();
  if (
    value.schema_version !== "source-preview-v1" ||
    value.mode !== "source_preview" ||
    !isInstant(value.generated_at) ||
    typeof value.cached !== "boolean" ||
    !Array.isArray(value.sources) || value.sources.length !== sourceIds.length
  ) {
    throw new SourcePreviewPayloadError();
  }

  const sources = value.sources.map((source, index) => {
    const sourceId = sourceIds[index];
    if (!sourceId) throw new SourcePreviewPayloadError();
    return parseSource(source, sourceId);
  });
  return {
    schema_version: "source-preview-v1",
    mode: "source_preview",
    generated_at: value.generated_at,
    cached: value.cached,
    sources: [sources[0] as PreviewSource, sources[1] as PreviewSource],
  };
}

async function readBoundedResponseText(response: Response, signal: AbortSignal): Promise<string> {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null && /^\d+$/u.test(contentLength) && Number(contentLength) > MAX_RESPONSE_BYTES) {
    if (response.body) void response.body.cancel().catch(() => {});
    throw new SourcePreviewPayloadError();
  }
  if (!response.body) throw new SourcePreviewPayloadError();

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  const cancelReader = () => { void reader.cancel().catch(() => {}); };
  if (signal.aborted) cancelReader();
  else signal.addEventListener("abort", cancelReader, { once: true });
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      totalBytes += value.byteLength;
      if (totalBytes > MAX_RESPONSE_BYTES) {
        cancelReader();
        throw new SourcePreviewPayloadError();
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof SourcePreviewPayloadError) throw error;
    throw error;
  } finally {
    signal.removeEventListener("abort", cancelReader);
    reader.releaseLock();
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new SourcePreviewPayloadError();
  }
}

export async function getSourcePreview(options: {
  mode?: SourcePreviewRequestMode;
  signal?: AbortSignal;
  fetcher?: typeof fetch;
  clock?: SourcePreviewClock;
} = {}): Promise<SourcePreviewPayload> {
  const mode = options.mode ?? "snapshot";
  const endpoint = mode === "fetch" ? ENDPOINT + "?mode=fetch" : ENDPOINT;
  const fetcher = options.fetcher ?? fetch;
  const clock = options.clock ?? browserClock;
  const requestController = new AbortController();
  let rejectCancellation!: (reason: Error) => void;
  const cancellation = new Promise<never>((_resolve, reject) => { rejectCancellation = reject; });
  const onExternalAbort = () => {
    requestController.abort();
    rejectCancellation(createAbortError());
  };
  const onDeadline = () => {
    requestController.abort();
    rejectCancellation(new SourcePreviewTimeoutError());
  };
  const timer = clock.setTimeout(onDeadline, REQUEST_DEADLINE_MS);
  options.signal?.addEventListener("abort", onExternalAbort, { once: true });
  if (options.signal?.aborted) onExternalAbort();

  const request = (async () => {
    if (requestController.signal.aborted) {
      throw createAbortError();
    }
    const response = await fetcher(endpoint, {
      method: "GET",
      headers: { Accept: "application/json" },
      redirect: "error",
      cache: mode === "fetch" ? "no-store" : "default",
      signal: requestController.signal,
    });
    if (requestController.signal.aborted) {
      throw createAbortError();
    }
    if (!response.ok) throw new SourcePreviewHttpError(response.status);
    const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
    if (contentType !== "application/json") throw new SourcePreviewPayloadError();

    let parsed: unknown;
    try {
      parsed = JSON.parse(await readBoundedResponseText(response, requestController.signal));
    } catch (error) {
      if (error instanceof SourcePreviewPayloadError) throw error;
      throw new SourcePreviewPayloadError();
    }
    return validateSourcePreviewPayload(parsed);
  })();
  try {
    return await Promise.race([request, cancellation]);
  } finally {
    clock.clearTimeout(timer);
    options.signal?.removeEventListener("abort", onExternalAbort);
  }
}
