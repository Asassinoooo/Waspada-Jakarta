import type {
  ContextSourceError,
  ContextSourceMetadata,
  ContextSourceStatus,
  ContextSourcesPayload,
  EarthquakeContextRecord,
  EarthquakeContextSource,
  WeatherContextSource,
  WeatherForecastHour,
} from "@waspada/worker/context-sources-contracts";
import { CONTEXT_SOURCE_POLICY } from "@waspada/worker/context-sources-contracts";

export type ContextSourcesRequestMode = "local" | "fetch";

export interface ContextSourcesClock {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export class ContextSourcesHttpError extends Error {
  constructor(readonly status: number) {
    super("Context sources request failed");
    this.name = "ContextSourcesHttpError";
  }
}

export class ContextSourcesPayloadError extends Error {
  constructor() {
    super("Context sources response could not be safely read");
    this.name = "ContextSourcesPayloadError";
  }
}

export class ContextSourcesTimeoutError extends Error {
  constructor() {
    super("Context sources request timed out");
    this.name = "ContextSourcesTimeoutError";
  }
}

const ENDPOINT = "/api/v1/demo/context-sources";
const REQUEST_DEADLINE_MS = 35_000;
const MAX_RESPONSE_BYTES = 512 * 1024;
const MAX_REJECTED_COUNT = CONTEXT_SOURCE_POLICY.maxProviderRecords;
const SEVEN_DAYS_MS = CONTEXT_SOURCE_POLICY.earthquakeWindowMs;

const browserClock: ContextSourcesClock = {
  setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>),
};

const timestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u;
const sourceStatuses: readonly ContextSourceStatus[] = ["available", "empty", "unavailable", "not_requested"];
const sourceErrors: readonly Exclude<ContextSourceError, null>[] = ["timeout", "http_error", "invalid_payload"];
const metadataKeys = [
  "status", "data_mode", "fetched_at", "source_updated_at", "attribution", "license_url", "source_url",
  "rejected_count", "limited", "error",
] as const;
const weatherSourceKeys = ["id", ...metadataKeys, "forecast"] as const;
const quakeSourceKeys = ["id", ...metadataKeys, "records", "window_start", "window_end"] as const;
const payloadKeys = ["schema_version", "mode", "generated_at", "cached", "sources"] as const;
const forecastKeys = ["requested_coordinates", "model_coordinates", "hours"] as const;
const hourKeys = ["valid_at", "temperature_c", "precipitation_probability_pct", "precipitation_mm", "weather_code", "wind_speed_kmh"] as const;
const earthquakeKeys = [
  "id", "source", "kind", "title", "coordinates", "coordinate_kind", "event_time", "updated_at",
  "magnitude", "magnitude_type", "depth_km", "source_status", "source_url",
] as const;

function createAbortError(): Error {
  const error = new Error("Context sources request was aborted");
  error.name = "AbortError";
  return error;
}

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
  if (typeof value !== "string" || !timestampPattern.test(value)) return false;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return false;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  const hour = Number(value.slice(11, 13));
  const minute = Number(value.slice(14, 16));
  const second = Number(value.slice(17, 19));
  const calendar = new Date(0);
  calendar.setUTCFullYear(year, month - 1, day);
  calendar.setUTCHours(0, 0, 0, 0);
  return calendar.getUTCFullYear() === year && calendar.getUTCMonth() === month - 1
    && calendar.getUTCDate() === day && hour <= 23 && minute <= 59 && second <= 59;
}

function isUtcInstant(value: unknown): value is string {
  return isInstant(value) && (value.endsWith("Z") || value.endsWith("+00:00"));
}

function isOptionalInstant(value: unknown): value is string | null {
  return value === null || isInstant(value);
}

function isSafeText(value: unknown, maximumLength: number): value is string {
  return typeof value === "string"
    && Array.from(value).length > 0
    && Array.from(value).length <= maximumLength
    && !/[\u0000-\u001f\u007f-\u009f]/u.test(value);
}

function isPlainText(value: unknown, maximumLength: number): value is string {
  return isSafeText(value, maximumLength) && !/<\/?[A-Za-z!][^>]*>/u.test(value);
}

function isFiniteNumber(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= minimum && value <= maximum;
}

function isCoordinatePair(value: unknown): value is [number, number] {
  return Array.isArray(value) && value.length === 2
    && typeof value[0] === "number" && Number.isFinite(value[0])
    && typeof value[1] === "number" && Number.isFinite(value[1]);
}

function isInEnvelope(longitude: number, latitude: number, envelope: { west: number; south: number; east: number; north: number }): boolean {
  return longitude >= envelope.west && longitude <= envelope.east
    && latitude >= envelope.south && latitude <= envelope.north;
}

function parseMetadata(
  value: Record<string, unknown>,
  expected: { attribution: string; licenseUrl: string; sourceUrl: string },
  generatedAtMs: number,
): ContextSourceMetadata {
  if (
    !isMember(value.status, sourceStatuses) ||
    !isMember(value.data_mode, ["fetched", "none"] as const) ||
    !isOptionalInstant(value.fetched_at) ||
    !isOptionalInstant(value.source_updated_at) ||
    !isSafeText(value.attribution, 200) || value.attribution !== expected.attribution ||
    value.license_url !== expected.licenseUrl || value.source_url !== expected.sourceUrl ||
    typeof value.rejected_count !== "number" || !Number.isSafeInteger(value.rejected_count) ||
    value.rejected_count < 0 || value.rejected_count > MAX_REJECTED_COUNT ||
    typeof value.limited !== "boolean" ||
    !(value.error === null || isMember(value.error, sourceErrors))
  ) {
    throw new ContextSourcesPayloadError();
  }

  const fetchedAtMs = value.fetched_at === null ? null : Date.parse(value.fetched_at);
  const sourceUpdatedAtMs = value.source_updated_at === null ? null : Date.parse(value.source_updated_at);
  if (
    (fetchedAtMs !== null && fetchedAtMs > generatedAtMs) ||
    (sourceUpdatedAtMs !== null && sourceUpdatedAtMs > generatedAtMs) ||
    (sourceUpdatedAtMs !== null && fetchedAtMs !== null && sourceUpdatedAtMs > fetchedAtMs)
  ) {
    throw new ContextSourcesPayloadError();
  }

  return {
    status: value.status,
    data_mode: value.data_mode,
    fetched_at: value.fetched_at,
    source_updated_at: value.source_updated_at,
    attribution: value.attribution,
    license_url: value.license_url,
    source_url: value.source_url,
    rejected_count: value.rejected_count,
    limited: value.limited,
    error: value.error,
  };
}

function statusMatchesData(metadata: ContextSourceMetadata, hasData: boolean): boolean {
  switch (metadata.status) {
    case "available":
      return metadata.data_mode === "fetched" && metadata.fetched_at !== null && metadata.error === null && hasData;
    case "empty":
      return metadata.data_mode === "fetched" && metadata.fetched_at !== null && metadata.error === null && !hasData;
    case "unavailable":
      return metadata.data_mode === "fetched" && metadata.fetched_at !== null && metadata.error !== null && !hasData;
    case "not_requested":
      return metadata.data_mode === "none" && metadata.fetched_at === null && metadata.source_updated_at === null
        && metadata.error === null && metadata.rejected_count === 0 && !metadata.limited && !hasData;
  }
}

function parseWeatherHour(value: unknown): WeatherForecastHour {
  if (!isObject(value) || !hasExactKeys(value, hourKeys) || !isUtcInstant(value.valid_at)) {
    throw new ContextSourcesPayloadError();
  }
  const validAtMs = Date.parse(value.valid_at);
  if (
    validAtMs % 3_600_000 !== 0 ||
    !(value.temperature_c === null || isFiniteNumber(value.temperature_c, -80, 60)) ||
    !(value.precipitation_probability_pct === null || isFiniteNumber(value.precipitation_probability_pct, 0, 100)) ||
    !(value.precipitation_mm === null || isFiniteNumber(value.precipitation_mm, 0, 1000)) ||
    !(value.weather_code === null || (typeof value.weather_code === "number" && Number.isSafeInteger(value.weather_code) && CONTEXT_SOURCE_POLICY.weatherCodes.includes(value.weather_code))) ||
    !(value.wind_speed_kmh === null || isFiniteNumber(value.wind_speed_kmh, 0, 500))
  ) {
    throw new ContextSourcesPayloadError();
  }
  return {
    valid_at: value.valid_at,
    temperature_c: value.temperature_c,
    precipitation_probability_pct: value.precipitation_probability_pct,
    precipitation_mm: value.precipitation_mm,
    weather_code: value.weather_code,
    wind_speed_kmh: value.wind_speed_kmh,
  };
}

function parseWeatherSource(value: unknown, generatedAtMs: number): WeatherContextSource {
  if (!isObject(value) || !hasExactKeys(value, weatherSourceKeys) || value.id !== "openmeteo") {
    throw new ContextSourcesPayloadError();
  }
  const metadata = parseMetadata(value, {
    attribution: CONTEXT_SOURCE_POLICY.weatherAttribution,
    licenseUrl: CONTEXT_SOURCE_POLICY.weatherLicenseUrl,
    sourceUrl: CONTEXT_SOURCE_POLICY.weatherSourceUrl,
  }, generatedAtMs);
  if (metadata.source_updated_at !== null || metadata.rejected_count !== 0 || metadata.limited) {
    throw new ContextSourcesPayloadError();
  }
  let forecast: WeatherContextSource["forecast"] = null;

  if (metadata.data_mode === "none") {
    if (value.forecast !== null || !statusMatchesData(metadata, false)) throw new ContextSourcesPayloadError();
  } else if (metadata.status === "unavailable") {
    if (value.forecast !== null || metadata.error === null || metadata.fetched_at === null) throw new ContextSourcesPayloadError();
  } else if (metadata.status === "available" && metadata.error === null && metadata.fetched_at !== null) {
    if (!isObject(value.forecast) || !hasExactKeys(value.forecast, forecastKeys)) {
      throw new ContextSourcesPayloadError();
    }
    const { requested_coordinates: requested, model_coordinates: model, hours } = value.forecast;
    if (
      !isCoordinatePair(requested) || requested[0] !== CONTEXT_SOURCE_POLICY.weatherRequestedCoordinates[0] || requested[1] !== CONTEXT_SOURCE_POLICY.weatherRequestedCoordinates[1] ||
      !isCoordinatePair(model) || !isInEnvelope(model[0], model[1], CONTEXT_SOURCE_POLICY.weatherGridEnvelope) ||
      !Array.isArray(hours) || hours.length < 1 || hours.length > CONTEXT_SOURCE_POLICY.maxForecastHours
    ) {
      throw new ContextSourcesPayloadError();
    }
    const parsedHours = hours.map(parseWeatherHour);
    if (parsedHours.some((hour, index) => index > 0 && Date.parse(hour.valid_at) - Date.parse(parsedHours[index - 1]!.valid_at) !== 3_600_000)) {
      throw new ContextSourcesPayloadError();
    }
    const fetchedAtMs = Date.parse(metadata.fetched_at);
    const requestHour = Math.floor(fetchedAtMs / 3_600_000) * 3_600_000;
    const firstHour = Date.parse(parsedHours[0]!.valid_at);
    const lastHour = Date.parse(parsedHours[parsedHours.length - 1]!.valid_at);
    if ((firstHour !== requestHour && firstHour !== requestHour - 3_600_000) || lastHour > requestHour + 12 * 3_600_000) {
      throw new ContextSourcesPayloadError();
    }
    forecast = {
      requested_coordinates: [requested[0], requested[1]],
      model_coordinates: [model[0], model[1]],
      hours: parsedHours,
    };
  } else {
    throw new ContextSourcesPayloadError();
  }

  if (metadata.status === "available" && !statusMatchesData(metadata, forecast !== null)) throw new ContextSourcesPayloadError();
  return { id: "openmeteo", ...metadata, forecast };
}

function parseEarthquakeRecord(value: unknown, fetchedAtMs: number, windowStartMs: number | null, windowEndMs: number | null): EarthquakeContextRecord {
  if (!isObject(value) || !hasExactKeys(value, earthquakeKeys)) throw new ContextSourcesPayloadError();
  const id = value.id;
  const providerId = typeof id === "string" && id.startsWith("usgs:") ? id.slice("usgs:".length) : "";
  if (
    typeof id !== "string" || id.length > 72 || !/^usgs:[A-Za-z0-9_-]{1,64}$/u.test(id) ||
    value.source !== "usgs" || value.kind !== "earthquake" ||
    !isPlainText(value.title, 160) ||
    (value.title !== "Gempa bumi regional" && !value.title.startsWith("Gempa bumi · ")) ||
    !isCoordinatePair(value.coordinates) || !isInEnvelope(value.coordinates[0], value.coordinates[1], CONTEXT_SOURCE_POLICY.earthquakeEnvelope) ||
    value.coordinate_kind !== "source_point" ||
    !isInstant(value.event_time) || !isInstant(value.updated_at) ||
    !(value.magnitude === null || isFiniteNumber(value.magnitude, 2.5, 10)) ||
    !(value.magnitude_type === null || isPlainText(value.magnitude_type, 128)) ||
    !isFiniteNumber(value.depth_km, -20, 800) ||
    !(value.source_status === null || isMember(value.source_status, ["automatic", "reviewed"] as const)) ||
    value.source_url !== "https://earthquake.usgs.gov/earthquakes/eventpage/" + providerId
  ) {
    throw new ContextSourcesPayloadError();
  }
  const eventTimeMs = Date.parse(value.event_time);
  const updatedAtMs = Date.parse(value.updated_at);
  if (
    updatedAtMs < eventTimeMs || updatedAtMs > fetchedAtMs ||
    (windowStartMs !== null && eventTimeMs < windowStartMs) ||
    (windowEndMs !== null && eventTimeMs > windowEndMs)
  ) {
    throw new ContextSourcesPayloadError();
  }
  return {
    id,
    source: "usgs",
    kind: "earthquake",
    title: value.title,
    coordinates: [value.coordinates[0], value.coordinates[1]],
    coordinate_kind: "source_point",
    event_time: value.event_time,
    updated_at: value.updated_at,
    magnitude: value.magnitude,
    magnitude_type: value.magnitude_type,
    depth_km: value.depth_km,
    source_status: value.source_status,
    source_url: value.source_url,
  };
}

function parseEarthquakeSource(value: unknown, generatedAtMs: number): EarthquakeContextSource {
  if (!isObject(value) || !hasExactKeys(value, quakeSourceKeys) || value.id !== "usgs" || !Array.isArray(value.records) || value.records.length > CONTEXT_SOURCE_POLICY.maxEarthquakes) {
    throw new ContextSourcesPayloadError();
  }
  const metadata = parseMetadata(value, {
    attribution: CONTEXT_SOURCE_POLICY.earthquakeAttribution,
    licenseUrl: CONTEXT_SOURCE_POLICY.earthquakeLicenseUrl,
    sourceUrl: CONTEXT_SOURCE_POLICY.earthquakeSourceUrl,
  }, generatedAtMs);
  if (!isOptionalInstant(value.window_start) || !isOptionalInstant(value.window_end)) {
    throw new ContextSourcesPayloadError();
  }

  const fetchedAtMs = metadata.fetched_at === null ? null : Date.parse(metadata.fetched_at);
  const windowStartMs = value.window_start === null ? null : Date.parse(value.window_start);
  const windowEndMs = value.window_end === null ? null : Date.parse(value.window_end);
  if (
    (value.window_start === null) !== (value.window_end === null) ||
    (metadata.status === "not_requested" && (windowStartMs !== null || windowEndMs !== null)) ||
    (metadata.data_mode === "fetched" && (windowStartMs === null || windowEndMs === null || fetchedAtMs === null)) ||
    (windowStartMs !== null && windowEndMs !== null && (
      windowEndMs - windowStartMs !== SEVEN_DAYS_MS || windowEndMs > generatedAtMs
    )) ||
    (windowEndMs !== null && fetchedAtMs !== null && windowEndMs > fetchedAtMs) ||
    (metadata.status !== "not_requested" && fetchedAtMs === null)
  ) {
    throw new ContextSourcesPayloadError();
  }

  if (metadata.status === "available" || metadata.status === "empty") {
    if (metadata.source_updated_at === null || fetchedAtMs === null || Date.parse(metadata.source_updated_at) > fetchedAtMs) {
      throw new ContextSourcesPayloadError();
    }
    if (metadata.status === "empty" && metadata.rejected_count !== 0) throw new ContextSourcesPayloadError();
  } else if (metadata.status === "unavailable" && metadata.source_updated_at !== null
    && (fetchedAtMs === null || Date.parse(metadata.source_updated_at) > fetchedAtMs)) {
    throw new ContextSourcesPayloadError();
  }

  const parsedRecords = value.records.map((record) => {
    if (fetchedAtMs === null) throw new ContextSourcesPayloadError();
    return parseEarthquakeRecord(record, fetchedAtMs, windowStartMs, windowEndMs);
  });
  if (new Set(parsedRecords.map((record) => record.id)).size !== parsedRecords.length) {
    throw new ContextSourcesPayloadError();
  }
  if (!statusMatchesData(metadata, parsedRecords.length > 0)) throw new ContextSourcesPayloadError();

  return {
    id: "usgs",
    ...metadata,
    records: parsedRecords,
    window_start: value.window_start,
    window_end: value.window_end,
  };
}

function hasExcessiveNesting(value: string): boolean {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (const character of value) {
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === "{" || character === "[") {
      depth += 1;
      if (depth > CONTEXT_SOURCE_POLICY.maxNestingDepth) return true;
    } else if (character === "}" || character === "]") depth -= 1;
  }
  return false;
}

/** Validates the closed context-sources-v1 response and copies only its allowed fields. */
export function validateContextSourcesPayload(value: unknown): ContextSourcesPayload {
  if (!isObject(value) || !hasExactKeys(value, payloadKeys)) throw new ContextSourcesPayloadError();
  if (
    value.schema_version !== "context-sources-v1" || value.mode !== "source_context" ||
    !isInstant(value.generated_at) || typeof value.cached !== "boolean" ||
    !Array.isArray(value.sources) || value.sources.length !== 2
  ) {
    throw new ContextSourcesPayloadError();
  }
  const generatedAtMs = Date.parse(value.generated_at);
  const weather = parseWeatherSource(value.sources[0], generatedAtMs);
  const earthquakes = parseEarthquakeSource(value.sources[1], generatedAtMs);
  if (value.cached && (weather.data_mode !== "fetched" || earthquakes.data_mode !== "fetched")) {
    throw new ContextSourcesPayloadError();
  }
  return {
    schema_version: "context-sources-v1",
    mode: "source_context",
    generated_at: value.generated_at,
    cached: value.cached,
    sources: [weather, earthquakes],
  };
}

async function readBoundedResponseText(response: Response, signal: AbortSignal): Promise<string> {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null && (!/^(0|[1-9]\d*)$/u.test(contentLength)
    || !Number.isSafeInteger(Number(contentLength)) || Number(contentLength) > MAX_RESPONSE_BYTES)) {
    if (response.body) void response.body.cancel().catch(() => {});
    throw new ContextSourcesPayloadError();
  }
  if (!response.body) throw new ContextSourcesPayloadError();

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
        throw new ContextSourcesPayloadError();
      }
      chunks.push(value);
    }
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
    throw new ContextSourcesPayloadError();
  }
}

/** Gets local not_requested status by default; provider contact requires mode="fetch". */
export async function getContextSources(options: {
  mode?: ContextSourcesRequestMode;
  signal?: AbortSignal;
  fetcher?: typeof fetch;
  clock?: ContextSourcesClock;
} = {}): Promise<ContextSourcesPayload> {
  const mode = options.mode ?? "local";
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
    rejectCancellation(new ContextSourcesTimeoutError());
  };
  const timer = clock.setTimeout(onDeadline, REQUEST_DEADLINE_MS);
  options.signal?.addEventListener("abort", onExternalAbort, { once: true });
  if (options.signal?.aborted) onExternalAbort();

  const request = (async () => {
    if (requestController.signal.aborted) throw createAbortError();
    const response = await fetcher(endpoint, {
      method: "GET",
      headers: { Accept: "application/json" },
      redirect: "error",
      cache: mode === "fetch" ? "no-store" : "default",
      signal: requestController.signal,
    });
    if (requestController.signal.aborted) throw createAbortError();
    if (!response.ok) throw new ContextSourcesHttpError(response.status);
    const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
    if (contentType !== "application/json") throw new ContextSourcesPayloadError();

    let parsed: unknown;
    try {
      const text = await readBoundedResponseText(response, requestController.signal);
      if (hasExcessiveNesting(text)) throw new ContextSourcesPayloadError();
      parsed = JSON.parse(text);
    } catch (error) {
      if (error instanceof ContextSourcesPayloadError) throw error;
      throw new ContextSourcesPayloadError();
    }
    return validateContextSourcesPayload(parsed);
  })();

  try {
    return await Promise.race([request, cancellation]);
  } finally {
    clock.clearTimeout(timer);
    options.signal?.removeEventListener("abort", onExternalAbort);
  }
}
