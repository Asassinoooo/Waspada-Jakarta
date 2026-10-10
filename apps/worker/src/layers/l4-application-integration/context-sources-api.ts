import type {
  ContextSourceError,
  ContextSourceMetadata,
  ContextSourcesPayload,
  EarthquakeContextRecord,
  EarthquakeContextSource,
  WeatherContextSource,
  WeatherForecast,
  WeatherForecastHour,
} from "../../contracts/context-sources.js";
import { CONTEXT_SOURCE_POLICY } from "../../contracts/context-sources.js";
import type { ContextSourcesAdapterOptions } from "../l1-data-knowledge/context-source-adapters.js";
import { createContextSourcesRuntime } from "../../runtime/context-sources-runtime.js";

export const CONTEXT_SOURCES_ROUTE_PATH = "/api/v1/demo/context-sources";
const HOUR_MS = 60 * 60_000;
const HOUR_SECONDS = 3_600;
const jsonHeaders = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
};

export interface ContextSourcesEnvironment {
  readonly DATASET_MODE?: string;
  readonly SOURCE_PREVIEW_ENABLED?: string;
}

/** L4 gate for the isolated context-sources preview. */
export function createContextSourcesHandler(
  options: ContextSourcesAdapterOptions = {},
): (request: Request, env: ContextSourcesEnvironment) => Promise<Response> {
  const runtime = createContextSourcesRuntime(options);
  const now = options.clock?.now ?? Date.now;

  return async (request, env) => {
    const url = new URL(request.url);
    if (url.pathname !== CONTEXT_SOURCES_ROUTE_PATH) {
      return apiError("NOT_FOUND", "The requested route was not found.", 404);
    }
    if (env.DATASET_MODE !== "demo" || env.SOURCE_PREVIEW_ENABLED !== "true") {
      return apiError("NOT_FOUND", "The requested route was not found.", 404);
    }
    if (request.method !== "GET") {
      return new Response(JSON.stringify({
        code: "METHOD_NOT_ALLOWED",
        message: "Only GET requests are available for this route.",
      }), {
        status: 405,
        headers: { ...jsonHeaders, allow: "GET" },
      });
    }

    const mode = readMode(url.search);
    if (mode === null) return apiError("INVALID_REQUEST", "The context-sources query is invalid.", 400);

    try {
      const result = mode === "fetch"
        ? await runtime.readFetched()
        : runtime.readNotRequested();
      const generatedAt = toIsoInstant(now());
      if (generatedAt === null) {
        return apiError("TEMPORARILY_UNAVAILABLE", "The context preview could not be completed.", 503);
      }
      const candidate: ContextSourcesPayload = {
        schema_version: "context-sources-v1",
        mode: "source_context",
        generated_at: generatedAt,
        cached: result.cached,
        sources: [result.sources[0], result.sources[1]],
      };
      const payload = projectContextSources(candidate);
      if (payload === null) {
        return apiError("TEMPORARILY_UNAVAILABLE", "The context preview could not be completed.", 503);
      }
      return new Response(JSON.stringify(payload), { status: 200, headers: jsonHeaders });
    } catch {
      // Provider and internal exception detail must not cross this boundary.
      return apiError("TEMPORARILY_UNAVAILABLE", "The context preview could not be completed.", 503);
    }
  };
}

function readMode(search: string): "not_requested" | "fetch" | null {
  if (search === "") return "not_requested";
  if (search === "?mode=fetch") return "fetch";
  return null;
}

function projectContextSources(value: unknown): ContextSourcesPayload | null {
  if (!isRecord(value) || !hasExactKeys(value, ["schema_version", "mode", "generated_at", "cached", "sources"])
    || value.schema_version !== "context-sources-v1" || value.mode !== "source_context"
    || !isValidInstant(value.generated_at) || typeof value.cached !== "boolean"
    || !Array.isArray(value.sources) || value.sources.length !== 2) {
    return null;
  }
  const generatedAt = value.generated_at;
  const weather = projectWeather(value.sources[0], generatedAt);
  const earthquakes = projectEarthquakes(value.sources[1], generatedAt);
  if (weather === null || earthquakes === null
    || (value.cached && (weather.data_mode !== "fetched" || earthquakes.data_mode !== "fetched"))) {
    return null;
  }
  return {
    schema_version: "context-sources-v1",
    mode: "source_context",
    generated_at: generatedAt,
    cached: value.cached,
    sources: [weather, earthquakes],
  };
}

function projectWeather(value: unknown, generatedAt: string): WeatherContextSource | null {
  if (!isRecord(value) || !hasExactKeys(value, [
    "id", "status", "data_mode", "fetched_at", "source_updated_at", "attribution", "license_url",
    "source_url", "rejected_count", "limited", "error", "forecast",
  ]) || value.id !== "openmeteo" || !isValidMetadata(value, generatedAt, "weather")
    || value.attribution !== CONTEXT_SOURCE_POLICY.weatherAttribution
    || value.license_url !== CONTEXT_SOURCE_POLICY.weatherLicenseUrl
    || value.source_url !== CONTEXT_SOURCE_POLICY.weatherSourceUrl
    || value.source_updated_at !== null || value.rejected_count !== 0 || value.limited !== false) {
    return null;
  }

  const metadata = copyMetadata(value);
  if (metadata === null) return null;
  if (value.data_mode === "none") {
    if (value.status !== "not_requested" || value.fetched_at !== null || value.error !== null
      || value.rejected_count !== 0 || value.limited || value.forecast !== null) return null;
    return { ...metadata, id: "openmeteo", forecast: null };
  }
  if (value.status === "unavailable") {
    if (value.error === null || value.forecast !== null) return null;
    return { ...metadata, id: "openmeteo", forecast: null };
  }
  if (value.status !== "available" || value.error !== null || value.fetched_at === null) return null;
  const fetchedAt = value.fetched_at;
  if (typeof fetchedAt !== "string") return null;
  const forecast = projectWeatherForecast(value.forecast, fetchedAt);
  if (forecast === null) return null;
  return { ...metadata, id: "openmeteo", forecast };
}

function projectEarthquakes(value: unknown, generatedAt: string): EarthquakeContextSource | null {
  if (!isRecord(value) || !hasExactKeys(value, [
    "id", "status", "data_mode", "fetched_at", "source_updated_at", "attribution", "license_url",
    "source_url", "rejected_count", "limited", "error", "records", "window_start", "window_end",
  ]) || value.id !== "usgs" || !isValidMetadata(value, generatedAt, "earthquake")
    || value.attribution !== CONTEXT_SOURCE_POLICY.earthquakeAttribution
    || value.license_url !== CONTEXT_SOURCE_POLICY.earthquakeLicenseUrl
    || value.source_url !== CONTEXT_SOURCE_POLICY.earthquakeSourceUrl
    || !Array.isArray(value.records) || value.records.length > CONTEXT_SOURCE_POLICY.maxEarthquakes) {
    return null;
  }

  const metadata = copyMetadata(value);
  if (metadata === null) return null;
  if (value.data_mode === "none") {
    if (value.status !== "not_requested" || value.fetched_at !== null || value.source_updated_at !== null
      || value.error !== null || value.rejected_count !== 0 || value.limited || value.records.length !== 0
      || value.window_start !== null || value.window_end !== null) return null;
    return {
      ...metadata,
      id: "usgs",
      records: [],
      window_start: null,
      window_end: null,
    };
  }

  const windowStart = value.window_start;
  const windowEnd = value.window_end;
  if (!isValidInstant(windowStart) || !isValidInstant(windowEnd)
    || Date.parse(windowEnd) - Date.parse(windowStart) !== CONTEXT_SOURCE_POLICY.earthquakeWindowMs
    || Date.parse(windowEnd) > Date.parse(generatedAt)
    || (typeof value.fetched_at === "string" && Date.parse(windowEnd) > Date.parse(value.fetched_at))) {
    return null;
  }
  if (value.status === "unavailable") {
    const unavailableFetchedAt = value.fetched_at;
    const unavailableSourceUpdatedAt = value.source_updated_at;
    if (value.error === null || value.records.length !== 0 || !isValidInstant(unavailableFetchedAt)
      || (unavailableSourceUpdatedAt !== null && (!isValidInstant(unavailableSourceUpdatedAt)
        || Date.parse(unavailableSourceUpdatedAt) > Date.parse(unavailableFetchedAt)))) return null;
    return {
      ...metadata,
      id: "usgs",
      records: [],
      window_start: windowStart,
      window_end: windowEnd,
    };
  }
  const fetchedAt = value.fetched_at;
  const sourceUpdatedAt = value.source_updated_at;
  if (value.error !== null || !isValidInstant(fetchedAt) || !isValidInstant(sourceUpdatedAt)
    || Date.parse(sourceUpdatedAt) > Date.parse(fetchedAt)) return null;

  const records: EarthquakeContextRecord[] = [];
  const identities = new Set<string>();
  for (const candidate of value.records) {
    const record = projectEarthquakeRecord(candidate, windowStart, windowEnd, fetchedAt);
    if (record === null || identities.has(record.id)) return null;
    identities.add(record.id);
    records.push(record);
  }
  if ((value.status === "available") !== (records.length > 0)
    || (value.status === "empty" && value.rejected_count !== 0)) return null;
  return {
    ...metadata,
    id: "usgs",
    records,
    window_start: windowStart,
    window_end: windowEnd,
  };
}

function isValidMetadata(
  value: Record<string, unknown>,
  generatedAt: string,
  kind: "weather" | "earthquake",
): boolean {
  if (!(["available", "empty", "unavailable", "not_requested"] as unknown[]).includes(value.status)
    || !(["fetched", "none"] as unknown[]).includes(value.data_mode)
    || !isNullableInstant(value.fetched_at) || !isNullableInstant(value.source_updated_at)
    || !Number.isSafeInteger(value.rejected_count) || (value.rejected_count as number) < 0
    || (value.rejected_count as number) > CONTEXT_SOURCE_POLICY.maxProviderRecords
    || typeof value.limited !== "boolean"
    || !([null, "timeout", "http_error", "invalid_payload"] as unknown[]).includes(value.error)) {
    return false;
  }
  if (value.fetched_at !== null && Date.parse(value.fetched_at) > Date.parse(generatedAt)) return false;
  if (value.source_updated_at !== null && Date.parse(value.source_updated_at) > Date.parse(generatedAt)) return false;
  if (value.data_mode === "none") {
    return value.status === "not_requested" && value.fetched_at === null
      && value.source_updated_at === null && value.error === null;
  }
  if (value.status === "not_requested" || value.fetched_at === null) return false;
  if (value.status === "unavailable") return value.error !== null;
  if (value.error !== null) return false;
  if (kind === "weather" && value.status !== "available") return false;
  return true;
}

function copyMetadata(value: Record<string, unknown>): ContextSourceMetadata | null {
  if ((value.status !== "available" && value.status !== "empty" && value.status !== "unavailable"
      && value.status !== "not_requested")
    || (value.data_mode !== "fetched" && value.data_mode !== "none")
    || !isNullableInstant(value.fetched_at) || !isNullableInstant(value.source_updated_at)
    || typeof value.attribution !== "string" || typeof value.license_url !== "string"
    || typeof value.source_url !== "string" || !Number.isSafeInteger(value.rejected_count)
    || typeof value.limited !== "boolean"
    || (value.error !== null && value.error !== "timeout" && value.error !== "http_error"
      && value.error !== "invalid_payload")) return null;
  return {
    status: value.status,
    data_mode: value.data_mode,
    fetched_at: value.fetched_at,
    source_updated_at: value.source_updated_at,
    attribution: value.attribution,
    license_url: value.license_url,
    source_url: value.source_url,
    rejected_count: value.rejected_count as number,
    limited: value.limited,
    error: value.error as ContextSourceError,
  };
}

function projectWeatherForecast(value: unknown, fetchedAt: string): WeatherForecast | null {
  if (!isRecord(value) || !hasExactKeys(value, ["requested_coordinates", "model_coordinates", "hours"])
    || !Array.isArray(value.requested_coordinates) || value.requested_coordinates.length !== 2
    || value.requested_coordinates[0] !== CONTEXT_SOURCE_POLICY.weatherRequestedCoordinates[0]
    || value.requested_coordinates[1] !== CONTEXT_SOURCE_POLICY.weatherRequestedCoordinates[1]
    || !Array.isArray(value.model_coordinates) || value.model_coordinates.length !== 2
    || !isFiniteNumber(value.model_coordinates[0]) || !isFiniteNumber(value.model_coordinates[1])
    || !isWithinEnvelope(value.model_coordinates[0], value.model_coordinates[1], CONTEXT_SOURCE_POLICY.weatherGridEnvelope)
    || !Array.isArray(value.hours) || value.hours.length < 1
    || value.hours.length > CONTEXT_SOURCE_POLICY.maxForecastHours) {
    return null;
  }
  const currentHour = Math.floor(Date.parse(fetchedAt) / HOUR_MS) * HOUR_SECONDS;
  const hours: WeatherForecastHour[] = [];
  let previousEpoch = -Infinity;
  for (let index = 0; index < value.hours.length; index += 1) {
    const candidate = value.hours[index];
    if (!isRecord(candidate) || !hasExactKeys(candidate, [
      "valid_at", "temperature_c", "precipitation_probability_pct", "precipitation_mm", "weather_code", "wind_speed_kmh",
    ]) || !isValidInstant(candidate.valid_at)) return null;
    const epoch = Date.parse(candidate.valid_at) / 1_000;
    if (!Number.isSafeInteger(epoch) || (index === 0 && epoch !== currentHour && epoch !== currentHour - HOUR_SECONDS)
      || (index > 0 && epoch !== previousEpoch + HOUR_SECONDS)
      || epoch > currentHour + 12 * HOUR_SECONDS) return null;
    const temperature = boundedNullableNumber(candidate.temperature_c, -80, 60);
    const probability = boundedNullableNumber(candidate.precipitation_probability_pct, 0, 100);
    const precipitation = boundedNullableNumber(candidate.precipitation_mm, 0, 1_000);
    const weatherCode = nullableWeatherCode(candidate.weather_code);
    const wind = boundedNullableNumber(candidate.wind_speed_kmh, 0, 500);
    if (temperature === undefined || probability === undefined || precipitation === undefined
      || weatherCode === undefined || wind === undefined) return null;
    hours.push({
      valid_at: candidate.valid_at,
      temperature_c: temperature,
      precipitation_probability_pct: probability,
      precipitation_mm: precipitation,
      weather_code: weatherCode,
      wind_speed_kmh: wind,
    });
    previousEpoch = epoch;
  }
  return {
    requested_coordinates: [CONTEXT_SOURCE_POLICY.weatherRequestedCoordinates[0],
      CONTEXT_SOURCE_POLICY.weatherRequestedCoordinates[1]],
    model_coordinates: [value.model_coordinates[0], value.model_coordinates[1]],
    hours,
  };
}

function projectEarthquakeRecord(
  value: unknown,
  windowStart: string,
  windowEnd: string,
  fetchedAt: string,
): EarthquakeContextRecord | null {
  if (!isRecord(value) || !hasExactKeys(value, [
    "id", "source", "kind", "title", "coordinates", "coordinate_kind", "event_time", "updated_at",
    "magnitude", "magnitude_type", "depth_km", "source_status", "source_url",
  ]) || typeof value.id !== "string") return null;
  const match = /^usgs:([A-Za-z0-9_-]{1,64})$/u.exec(value.id);
  if (match === null || value.source !== "usgs" || value.kind !== "earthquake"
    || value.coordinate_kind !== "source_point" || value.source_url !== `https://earthquake.usgs.gov/earthquakes/eventpage/${match[1]}`
    || typeof value.title !== "string" || Array.from(value.title).length < 1
    || Array.from(value.title).length > 160 || containsControlCharacters(value.title)
    || (value.title !== "Gempa bumi regional" && !value.title.startsWith("Gempa bumi · "))
    || /<\/?[A-Za-z!][^>]*>/u.test(value.title)
    || !Array.isArray(value.coordinates) || value.coordinates.length !== 2
    || !isFiniteNumber(value.coordinates[0]) || !isFiniteNumber(value.coordinates[1])
    || !isWithinEnvelope(value.coordinates[0], value.coordinates[1], CONTEXT_SOURCE_POLICY.earthquakeEnvelope)
    || !isValidInstant(value.event_time) || !isValidInstant(value.updated_at)
    || Date.parse(value.event_time) < Date.parse(windowStart) || Date.parse(value.event_time) > Date.parse(windowEnd)
    || Date.parse(value.updated_at) < Date.parse(value.event_time) || Date.parse(value.updated_at) > Date.parse(fetchedAt)) {
    return null;
  }
  const magnitude = boundedNullableNumber(value.magnitude, 2.5, 10);
  const magnitudeType = nullablePlainText(value.magnitude_type, 128);
  if (magnitude === undefined || magnitudeType === undefined
    || !isFiniteNumber(value.depth_km) || value.depth_km < -20 || value.depth_km > 800
    || (value.source_status !== null && value.source_status !== "automatic" && value.source_status !== "reviewed")) {
    return null;
  }
  return {
    id: value.id,
    source: "usgs",
    kind: "earthquake",
    title: value.title,
    coordinates: [value.coordinates[0], value.coordinates[1]],
    coordinate_kind: "source_point",
    event_time: value.event_time,
    updated_at: value.updated_at,
    magnitude,
    magnitude_type: magnitudeType,
    depth_km: value.depth_km,
    source_status: value.source_status,
    source_url: value.source_url,
  };
}

function boundedNullableNumber(value: unknown, minimum: number, maximum: number): number | null | undefined {
  if (value === null) return null;
  if (!isFiniteNumber(value) || value < minimum || value > maximum) return undefined;
  return value;
}

function nullableWeatherCode(value: unknown): number | null | undefined {
  if (value === null) return null;
  if (!Number.isSafeInteger(value) || !CONTEXT_SOURCE_POLICY.weatherCodes.includes(value as number)) return undefined;
  return value as number;
}

function nullablePlainText(value: unknown, maxLength: number): string | null | undefined {
  if (value === null) return null;
  if (typeof value !== "string" || containsControlCharacters(value)) return undefined;
  const normalized = value.normalize("NFC").replace(/\s+/gu, " ").trim();
  if (normalized.length === 0) return null;
  if (Array.from(normalized).length > maxLength || /<\/?[A-Za-z!][^>]*>/u.test(normalized)) return undefined;
  return normalized;
}

function isNullableInstant(value: unknown): value is string | null {
  return value === null || isValidInstant(value);
}

function isValidInstant(value: unknown): value is string {
  if (typeof value !== "string"
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(value)) return false;
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

function toIsoInstant(timestamp: number): string | null {
  if (!Number.isFinite(timestamp) || Math.abs(timestamp) > 8_640_000_000_000_000) return null;
  try {
    return new Date(timestamp).toISOString();
  } catch {
    return null;
  }
}

function isWithinEnvelope(
  longitude: number,
  latitude: number,
  envelope: { readonly west: number; readonly south: number; readonly east: number; readonly north: number },
): boolean {
  return longitude >= envelope.west && longitude <= envelope.east
    && latitude >= envelope.south && latitude <= envelope.north;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function containsControlCharacters(value: string): boolean {
  return /[\u0000-\u001f\u007f-\u009f]/u.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function apiError(code: string, message: string, status: number): Response {
  return new Response(JSON.stringify({ code, message }), { status, headers: jsonHeaders });
}
