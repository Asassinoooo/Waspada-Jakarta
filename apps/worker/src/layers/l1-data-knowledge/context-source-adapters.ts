import type {
  ContextSourceError,
  EarthquakeContextRecord,
  EarthquakeContextSource,
  WeatherContextSource,
  WeatherForecast,
  WeatherForecastHour,
} from "../../contracts/context-sources.js";
import { CONTEXT_SOURCE_POLICY } from "../../contracts/context-sources.js";

export const CONTEXT_SOURCES_LIMITS = {
  requestDeadlineMs: CONTEXT_SOURCE_POLICY.requestDeadlineMs,
  maxBodyBytes: CONTEXT_SOURCE_POLICY.maxBodyBytes,
  maxNestingDepth: CONTEXT_SOURCE_POLICY.maxNestingDepth,
  maxProviderRecords: CONTEXT_SOURCE_POLICY.maxProviderRecords,
  maxForecastHours: CONTEXT_SOURCE_POLICY.maxForecastHours,
  maxEarthquakes: CONTEXT_SOURCE_POLICY.maxEarthquakes,
  cacheTtlMs: CONTEXT_SOURCE_POLICY.cacheTtlMs,
  maxProviderTextLength: 128,
} as const;

const weatherUrl = "https://api.open-meteo.com/v1/forecast?latitude=-6.2&longitude=106.82&hourly=temperature_2m,precipitation_probability,precipitation,weather_code,wind_speed_10m&forecast_hours=12&timezone=GMT&timeformat=unixtime&wind_speed_unit=kmh&temperature_unit=celsius&precipitation_unit=mm";
const usgsEndpoint = "https://earthquake.usgs.gov/fdsnws/event/1/query";
const identifyingUserAgent = "WaspadaJakarta-Team12-Demo/0.1 (+https://github.com/Asassinoooo/Waspada-Jakarta)";
const HOUR_MS = 60 * 60_000;
const HOUR_SECONDS = 3_600;

export interface ContextSourcesClock {
  now(): number;
  schedule(callback: () => void, delayMs: number): unknown;
  cancel(handle: unknown): void;
}

export interface ContextSourcesAdapterOptions {
  readonly fetch?: typeof fetch;
  readonly clock?: ContextSourcesClock;
}

export type ContextSourcesPair = readonly [WeatherContextSource, EarthquakeContextSource];

export interface ContextSourceAdapters {
  notRequested(): ContextSourcesPair;
  fetchSources(): Promise<ContextSourcesPair>;
}

export function createContextSourceAdapters(
  options: ContextSourcesAdapterOptions = {},
): ContextSourceAdapters {
  const fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
  const clock = options.clock ?? systemClock;
  return {
    notRequested() {
      return [notRequestedWeatherSource(), notRequestedEarthquakeSource()];
    },
    fetchSources() {
      return acquireSources(fetcher, clock);
    },
  };
}

export function notRequestedWeatherSource(): WeatherContextSource {
  return {
    id: "openmeteo",
    status: "not_requested",
    data_mode: "none",
    fetched_at: null,
    source_updated_at: null,
    attribution: CONTEXT_SOURCE_POLICY.weatherAttribution,
    license_url: CONTEXT_SOURCE_POLICY.weatherLicenseUrl,
    source_url: CONTEXT_SOURCE_POLICY.weatherSourceUrl,
    rejected_count: 0,
    limited: false,
    error: null,
    forecast: null,
  };
}

export function notRequestedEarthquakeSource(): EarthquakeContextSource {
  return {
    id: "usgs",
    status: "not_requested",
    data_mode: "none",
    fetched_at: null,
    source_updated_at: null,
    attribution: CONTEXT_SOURCE_POLICY.earthquakeAttribution,
    license_url: CONTEXT_SOURCE_POLICY.earthquakeLicenseUrl,
    source_url: CONTEXT_SOURCE_POLICY.earthquakeSourceUrl,
    rejected_count: 0,
    limited: false,
    error: null,
    records: [],
    window_start: null,
    window_end: null,
  };
}

async function acquireSources(
  fetcher: typeof fetch,
  clock: ContextSourcesClock,
): Promise<ContextSourcesPair> {
  const [weather, earthquakes] = await Promise.all([
    requestWeather(fetcher, clock),
    requestEarthquakes(fetcher, clock),
  ]);
  return [weather, earthquakes];
}

interface RequestDeadline {
  readonly signal: AbortSignal;
  readonly timeoutPromise: Promise<never>;
  isExpired(): boolean;
  dispose(): void;
}

class RequestDeadlineError extends Error {
  constructor() {
    super("timeout");
  }
}

class InvalidPayloadError extends Error {
  constructor() {
    super("invalid_payload");
  }
}

function createRequestDeadline(clock: ContextSourcesClock): RequestDeadline {
  const controller = new AbortController();
  let expired = false;
  let rejectTimeout!: (error: Error) => void;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    rejectTimeout = reject;
  });
  const timeoutHandle = clock.schedule(() => {
    expired = true;
    controller.abort();
    rejectTimeout(new RequestDeadlineError());
  }, CONTEXT_SOURCES_LIMITS.requestDeadlineMs);
  return {
    signal: controller.signal,
    timeoutPromise,
    isExpired: () => expired,
    dispose() {
      clock.cancel(timeoutHandle);
      controller.abort();
    },
  };
}

function withinDeadline<T>(operation: Promise<T>, deadline: RequestDeadline): Promise<T> {
  return Promise.race([operation, deadline.timeoutPromise]);
}

async function requestWeather(
  fetcher: typeof fetch,
  clock: ContextSourcesClock,
): Promise<WeatherContextSource> {
  const requestStartedAt = clock.now();
  const attemptedAt = toIsoInstant(requestStartedAt);
  if (attemptedAt === null) return weatherFailure("invalid_payload", null);

  let deadline: RequestDeadline | undefined;
  try {
    deadline = createRequestDeadline(clock);
    const response = await withinDeadline(fetcher(weatherUrl, {
      method: "GET",
      headers: {
        "user-agent": identifyingUserAgent,
        accept: "application/json",
      },
      redirect: "manual",
      signal: deadline.signal,
    }), deadline);
    if (!response.ok || response.redirected) return weatherFailure("http_error", attemptedAt);

    const json = await readJsonResponse(response, deadline);
    const fetchedAtMs = clock.now();
    const fetchedAt = toIsoInstant(fetchedAtMs);
    if (fetchedAt === null) return weatherFailure("invalid_payload", attemptedAt);
    const forecast = normalizeWeatherPayload(json, requestStartedAt, fetchedAtMs);
    if (forecast === null) return weatherFailure("invalid_payload", attemptedAt);
    return {
      id: "openmeteo",
      status: "available",
      data_mode: "fetched",
      fetched_at: fetchedAt,
      source_updated_at: null,
      attribution: CONTEXT_SOURCE_POLICY.weatherAttribution,
      license_url: CONTEXT_SOURCE_POLICY.weatherLicenseUrl,
      source_url: CONTEXT_SOURCE_POLICY.weatherSourceUrl,
      rejected_count: 0,
      limited: false,
      error: null,
      forecast,
    };
  } catch (error) {
    return weatherFailure(failureCode(error, deadline), attemptedAt);
  } finally {
    deadline?.dispose();
  }
}

function weatherFailure(error: Exclude<ContextSourceError, null>, attemptedAt: string | null): WeatherContextSource {
  return {
    id: "openmeteo",
    status: "unavailable",
    data_mode: "fetched",
    fetched_at: attemptedAt,
    source_updated_at: null,
    attribution: CONTEXT_SOURCE_POLICY.weatherAttribution,
    license_url: CONTEXT_SOURCE_POLICY.weatherLicenseUrl,
    source_url: CONTEXT_SOURCE_POLICY.weatherSourceUrl,
    rejected_count: 0,
    limited: false,
    error,
    forecast: null,
  };
}

function normalizeWeatherPayload(
  value: unknown,
  requestedAtMs: number,
  fetchedAtMs: number,
): WeatherForecast | null {
  if (!isRecord(value) || value.timezone !== "GMT" || value.timezone_abbreviation !== "GMT"
    || value.utc_offset_seconds !== 0 || !isFiniteNumber(value.latitude) || !isFiniteNumber(value.longitude)
    || !isWithinEnvelope(value.longitude, value.latitude, CONTEXT_SOURCE_POLICY.weatherGridEnvelope)
    || !isRecord(value.hourly_units) || !isRecord(value.hourly)) {
    return null;
  }

  const units = value.hourly_units;
  if (units.time !== "unixtime" || units.temperature_2m !== "°C"
    || units.precipitation_probability !== "%" || units.precipitation !== "mm"
    || units.weather_code !== "wmo code" || units.wind_speed_10m !== "km/h") {
    return null;
  }

  const hourly = value.hourly;
  const arrays = [hourly.time, hourly.temperature_2m, hourly.precipitation_probability,
    hourly.precipitation, hourly.weather_code, hourly.wind_speed_10m];
  if (!arrays.every(Array.isArray)) return null;
  const times = hourly.time as unknown[];
  const temperatures = hourly.temperature_2m as unknown[];
  const probabilities = hourly.precipitation_probability as unknown[];
  const precipitation = hourly.precipitation as unknown[];
  const codes = hourly.weather_code as unknown[];
  const winds = hourly.wind_speed_10m as unknown[];
  const count = times.length;
  if (count < 1 || count > CONTEXT_SOURCES_LIMITS.maxForecastHours
    || arrays.some((array) => (array as unknown[]).length !== count)) {
    return null;
  }

  const requestHour = Math.floor(requestedAtMs / HOUR_MS) * HOUR_SECONDS;
  const fetchedHour = Math.floor(fetchedAtMs / HOUR_MS) * HOUR_SECONDS;
  const firstEpoch = times[0];
  if (!isSafeInteger(firstEpoch) || (firstEpoch !== requestHour && firstEpoch !== fetchedHour
    && !(fetchedHour > requestHour && firstEpoch === requestHour - HOUR_SECONDS))) {
    return null;
  }

  const forecastHours: WeatherForecastHour[] = [];
  let previousEpoch = -Infinity;
  for (let index = 0; index < count; index += 1) {
    const epoch = times[index];
    if (!isSafeInteger(epoch) || (index > 0 && epoch !== previousEpoch + HOUR_SECONDS)
      || epoch < requestHour - HOUR_SECONDS || epoch > requestHour + 12 * HOUR_SECONDS) {
      return null;
    }
    const validAt = toIsoInstant(epoch * 1_000);
    const temperature = boundedNullableNumber(temperatures[index], -80, 60);
    const probability = boundedNullableNumber(probabilities[index], 0, 100);
    const rain = boundedNullableNumber(precipitation[index], 0, 1_000);
    const code = nullableWeatherCode(codes[index]);
    const wind = boundedNullableNumber(winds[index], 0, 500);
    if (validAt === null || temperature === undefined || probability === undefined
      || rain === undefined || code === undefined || wind === undefined) {
      return null;
    }
    forecastHours.push({
      valid_at: validAt,
      temperature_c: temperature,
      precipitation_probability_pct: probability,
      precipitation_mm: rain,
      weather_code: code,
      wind_speed_kmh: wind,
    });
    previousEpoch = epoch;
  }

  return {
    requested_coordinates: [CONTEXT_SOURCE_POLICY.weatherRequestedCoordinates[0],
      CONTEXT_SOURCE_POLICY.weatherRequestedCoordinates[1]],
    model_coordinates: [value.longitude, value.latitude],
    hours: forecastHours,
  };
}

function boundedNullableNumber(value: unknown, minimum: number, maximum: number): number | null | undefined {
  if (value === null) return null;
  if (!isFiniteNumber(value) || value < minimum || value > maximum) return undefined;
  return value;
}

function nullableWeatherCode(value: unknown): number | null | undefined {
  if (value === null) return null;
  if (!isSafeInteger(value) || !CONTEXT_SOURCE_POLICY.weatherCodes.includes(value)) return undefined;
  return value;
}

async function requestEarthquakes(
  fetcher: typeof fetch,
  clock: ContextSourcesClock,
): Promise<EarthquakeContextSource> {
  const requestStartedAt = clock.now();
  const attemptedAt = toIsoInstant(requestStartedAt);
  if (attemptedAt === null) return earthquakeFailure("invalid_payload", null, null, null);
  const windowEndMs = requestStartedAt;
  const windowStartMs = windowEndMs - CONTEXT_SOURCE_POLICY.earthquakeWindowMs;
  const windowEnd = toIsoInstant(windowEndMs);
  const windowStart = toIsoInstant(windowStartMs);
  if (windowStart === null || windowEnd === null) {
    return earthquakeFailure("invalid_payload", attemptedAt, null, null);
  }

  let deadline: RequestDeadline | undefined;
  try {
    deadline = createRequestDeadline(clock);
    const response = await withinDeadline(fetcher(buildUsgsUrl(windowStart, windowEnd), {
      method: "GET",
      headers: {
        "user-agent": identifyingUserAgent,
        accept: "application/geo+json, application/json",
      },
      redirect: "manual",
      signal: deadline.signal,
    }), deadline);
    if (!response.ok || response.redirected) {
      return earthquakeFailure("http_error", attemptedAt, windowStart, windowEnd);
    }

    const json = await readJsonResponse(response, deadline);
    const fetchedAtMs = clock.now();
    const fetchedAt = toIsoInstant(fetchedAtMs);
    if (fetchedAt === null) {
      return earthquakeFailure("invalid_payload", attemptedAt, windowStart, windowEnd);
    }
    const normalized = normalizeEarthquakePayload(json, fetchedAt, fetchedAtMs, windowStartMs, windowEndMs);
    if (normalized === null) {
      return earthquakeFailure("invalid_payload", attemptedAt, windowStart, windowEnd);
    }
    const status = normalized.records.length > 0
      ? "available"
      : normalized.rejectedCount > 0
        ? "unavailable"
        : "empty";
    return {
      id: "usgs",
      status,
      data_mode: "fetched",
      fetched_at: fetchedAt,
      source_updated_at: normalized.sourceUpdatedAt,
      attribution: CONTEXT_SOURCE_POLICY.earthquakeAttribution,
      license_url: CONTEXT_SOURCE_POLICY.earthquakeLicenseUrl,
      source_url: CONTEXT_SOURCE_POLICY.earthquakeSourceUrl,
      rejected_count: normalized.rejectedCount,
      limited: normalized.limited,
      error: status === "unavailable" ? "invalid_payload" : null,
      records: normalized.records,
      window_start: windowStart,
      window_end: windowEnd,
    };
  } catch (error) {
    return earthquakeFailure(failureCode(error, deadline), attemptedAt, windowStart, windowEnd);
  } finally {
    deadline?.dispose();
  }
}

function buildUsgsUrl(windowStart: string, windowEnd: string): string {
  const query = new URLSearchParams({
    format: "geojson",
    starttime: windowStart,
    endtime: windowEnd,
    minmagnitude: "2.5",
    minlatitude: String(CONTEXT_SOURCE_POLICY.earthquakeEnvelope.south),
    maxlatitude: String(CONTEXT_SOURCE_POLICY.earthquakeEnvelope.north),
    minlongitude: String(CONTEXT_SOURCE_POLICY.earthquakeEnvelope.west),
    maxlongitude: String(CONTEXT_SOURCE_POLICY.earthquakeEnvelope.east),
    orderby: "time",
    limit: String(CONTEXT_SOURCE_POLICY.maxEarthquakes),
  });
  return `${usgsEndpoint}?${query.toString()}`;
}

function earthquakeFailure(
  error: Exclude<ContextSourceError, null>,
  attemptedAt: string | null,
  windowStart: string | null,
  windowEnd: string | null,
): EarthquakeContextSource {
  return {
    id: "usgs",
    status: "unavailable",
    data_mode: "fetched",
    fetched_at: attemptedAt,
    source_updated_at: null,
    attribution: CONTEXT_SOURCE_POLICY.earthquakeAttribution,
    license_url: CONTEXT_SOURCE_POLICY.earthquakeLicenseUrl,
    source_url: CONTEXT_SOURCE_POLICY.earthquakeSourceUrl,
    rejected_count: 0,
    limited: false,
    error,
    records: [],
    window_start: windowStart,
    window_end: windowEnd,
  };
}

interface NormalizedEarthquakePayload {
  readonly sourceUpdatedAt: string;
  readonly records: EarthquakeContextRecord[];
  readonly rejectedCount: number;
  readonly limited: boolean;
}

type EarthquakeNormalization =
  | { readonly kind: "accepted"; readonly record: EarthquakeContextRecord }
  | { readonly kind: "ignored" }
  | { readonly kind: "rejected" };

function normalizeEarthquakePayload(
  value: unknown,
  fetchedAt: string,
  fetchedAtMs: number,
  windowStartMs: number,
  windowEndMs: number,
): NormalizedEarthquakePayload | null {
  if (!isRecord(value) || !isRecord(value.metadata) || value.type !== "FeatureCollection"
    || !Array.isArray(value.features) || value.features.length > CONTEXT_SOURCES_LIMITS.maxProviderRecords) {
    return null;
  }
  const metadata = value.metadata;
  if (metadata.status !== 200 || !isSafeInteger(metadata.generated) || metadata.generated <= 0
    || metadata.generated > fetchedAtMs) {
    return null;
  }
  if (hasOwn(metadata, "count") && (!isSafeInteger(metadata.count)
    || metadata.count < 0 || metadata.count !== value.features.length)) {
    return null;
  }
  const sourceUpdatedAt = toIsoInstant(metadata.generated);
  if (sourceUpdatedAt === null || Date.parse(sourceUpdatedAt) > Date.parse(fetchedAt)) return null;

  let rejectedCount = 0;
  const groups = new Map<string, EarthquakeNormalization[]>();
  for (const candidate of value.features) {
    const rawId = isRecord(candidate) && typeof candidate.id === "string"
      && /^[A-Za-z0-9_-]{1,64}$/u.test(candidate.id)
      ? candidate.id
      : null;
    const result = normalizeEarthquakeFeature(candidate, fetchedAtMs, windowStartMs, windowEndMs);
    if (result.kind === "ignored") continue;
    if (rawId === null) {
      rejectedCount += 1;
      continue;
    }
    const variants = groups.get(rawId) ?? [];
    variants.push(result);
    groups.set(rawId, variants);
  }

  const records: EarthquakeContextRecord[] = [];
  for (const id of [...groups.keys()].sort(compareText)) {
    const variants = groups.get(id)!;
    const acceptedRecords: EarthquakeContextRecord[] = [];
    let containsRejectedVariant = false;
    for (const variant of variants) {
      if (variant.kind === "accepted") acceptedRecords.push(variant.record);
      else containsRejectedVariant = true;
    }
    if (containsRejectedVariant) {
      // A malformed version with a known identity invalidates every repeated version.
      rejectedCount += variants.length;
      continue;
    }
    const uniqueRecords = new Map(acceptedRecords.map((record) => [JSON.stringify(record), record]));
    if (uniqueRecords.size > 1) {
      rejectedCount += variants.length;
      continue;
    }
    records.push(uniqueRecords.values().next().value as EarthquakeContextRecord);
    rejectedCount += variants.length - 1;
  }
  records.sort((left, right) => Date.parse(right.event_time) - Date.parse(left.event_time)
    || compareText(left.id, right.id));

  const limited = value.features.length >= CONTEXT_SOURCES_LIMITS.maxEarthquakes
    || records.length > CONTEXT_SOURCES_LIMITS.maxEarthquakes;
  if (records.length > CONTEXT_SOURCES_LIMITS.maxEarthquakes) {
    rejectedCount += records.length - CONTEXT_SOURCES_LIMITS.maxEarthquakes;
    records.length = CONTEXT_SOURCES_LIMITS.maxEarthquakes;
  }
  return { sourceUpdatedAt, records, rejectedCount, limited };
}

function normalizeEarthquakeFeature(
  value: unknown,
  fetchedAtMs: number,
  windowStartMs: number,
  windowEndMs: number,
): EarthquakeNormalization {
  if (!isRecord(value) || value.type !== "Feature" || !isRecord(value.properties)) {
    return { kind: "rejected" };
  }
  const properties = value.properties;
  if (properties.type !== "earthquake") {
    return typeof properties.type === "string" ? { kind: "ignored" } : { kind: "rejected" };
  }
  if (value.geometry === undefined || !isRecord(value.geometry) || value.geometry.type !== "Point"
    || !Array.isArray(value.geometry.coordinates) || value.geometry.coordinates.length !== 3) {
    return { kind: "rejected" };
  }
  const coordinates = value.geometry.coordinates;
  const longitude = coordinates[0];
  const latitude = coordinates[1];
  const depth = coordinates[2];
  if (!isFiniteNumber(longitude) || !isFiniteNumber(latitude) || !isFiniteNumber(depth)
    || !isWithinEnvelope(longitude, latitude, CONTEXT_SOURCE_POLICY.earthquakeEnvelope)
    || depth < -20 || depth > 800) {
    return { kind: "rejected" };
  }

  if (typeof value.id !== "string" || !/^[A-Za-z0-9_-]{1,64}$/u.test(value.id)) {
    return { kind: "rejected" };
  }
  const sourceUrl = `https://earthquake.usgs.gov/earthquakes/eventpage/${value.id}`;
  if (properties.url !== sourceUrl) return { kind: "rejected" };

  const originMs = properties.time;
  const updatedMs = properties.updated;
  if (!isSafeInteger(originMs) || !isSafeInteger(updatedMs)
    || originMs < windowStartMs || originMs > windowEndMs
    || updatedMs < originMs || updatedMs > fetchedAtMs) {
    return { kind: "rejected" };
  }
  const magnitude = nullableBoundedNumber(properties.mag, 2.5, 10);
  const magnitudeType = nullablePlainText(properties.magType, CONTEXT_SOURCES_LIMITS.maxProviderTextLength);
  const place = nullablePlainText(properties.place, CONTEXT_SOURCES_LIMITS.maxProviderTextLength);
  const sourceStatus = nullableSourceStatus(properties.status);
  if (magnitude === undefined || magnitudeType === undefined || place === undefined || sourceStatus === undefined) {
    return { kind: "rejected" };
  }

  const eventTime = toIsoInstant(originMs);
  const updatedAt = toIsoInstant(updatedMs);
  if (eventTime === null || updatedAt === null) return { kind: "rejected" };
  const title = place === null ? "Gempa bumi regional" : `Gempa bumi · ${place}`;
  return {
    kind: "accepted",
    record: {
      id: `usgs:${value.id}`,
      source: "usgs",
      kind: "earthquake",
      title,
      coordinates: [longitude, latitude],
      coordinate_kind: "source_point",
      event_time: eventTime,
      updated_at: updatedAt,
      magnitude,
      magnitude_type: magnitudeType,
      depth_km: depth,
      source_status: sourceStatus,
      source_url: sourceUrl,
    },
  };
}

function nullableBoundedNumber(value: unknown, minimum: number, maximum: number): number | null | undefined {
  if (value === null) return null;
  if (!isFiniteNumber(value) || value < minimum || value > maximum) return undefined;
  return value;
}

function nullablePlainText(value: unknown, maxLength: number): string | null | undefined {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || containsControlCharacters(value)) return undefined;
  const normalized = value.normalize("NFC").replace(/\s+/gu, " ").trim();
  if (normalized.length === 0) return null;
  if (Array.from(normalized).length > maxLength || /<\/?[A-Za-z!][^>]*>/u.test(normalized)) return undefined;
  return normalized;
}

function nullableSourceStatus(value: unknown): "automatic" | "reviewed" | null | undefined {
  if (value === undefined || value === null) return null;
  if (value === "automatic" || value === "reviewed") return value;
  return undefined;
}

async function readJsonResponse(response: Response, deadline: RequestDeadline): Promise<unknown> {
  if (!isJsonContentType(response.headers.get("content-type"))) throw new InvalidPayloadError();
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null) {
    if (!/^(0|[1-9][0-9]*)$/u.test(contentLength)) throw new InvalidPayloadError();
    const length = Number(contentLength);
    if (!Number.isSafeInteger(length) || length > CONTEXT_SOURCES_LIMITS.maxBodyBytes) {
      throw new InvalidPayloadError();
    }
  }

  const reader = response.body?.getReader();
  if (reader === undefined) throw new InvalidPayloadError();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    while (true) {
      const result = await withinDeadline(reader.read(), deadline);
      if (result.done) break;
      if (!(result.value instanceof Uint8Array)) throw new InvalidPayloadError();
      byteLength += result.value.byteLength;
      if (byteLength > CONTEXT_SOURCES_LIMITS.maxBodyBytes) {
        void reader.cancel().catch(() => undefined);
        throw new InvalidPayloadError();
      }
      chunks.push(result.value);
    }
  } catch (error) {
    void reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // A cancelled or timed-out stream can already have released its reader.
    }
  }

  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new InvalidPayloadError();
  }
  if (hasExcessiveNesting(text)) throw new InvalidPayloadError();
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new InvalidPayloadError();
  }
}

function isJsonContentType(value: string | null): boolean {
  if (value === null) return false;
  const [mediaType, ...parameters] = value.split(";");
  const normalized = mediaType?.trim().toLowerCase();
  if (normalized !== "application/json" && normalized !== "application/geo+json") return false;
  for (const parameter of parameters) {
    const match = /^\s*charset\s*=\s*"?([^";]+)"?\s*$/iu.exec(parameter);
    if (match !== null && match[1]?.trim().toLowerCase() !== "utf-8"
      && match[1]?.trim().toLowerCase() !== "utf8") return false;
  }
  return true;
}

function failureCode(error: unknown, deadline: RequestDeadline | undefined): Exclude<ContextSourceError, null> {
  if (deadline?.isExpired() === true || error instanceof RequestDeadlineError) return "timeout";
  if (error instanceof InvalidPayloadError) return "invalid_payload";
  return "http_error";
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
      if (depth > CONTEXT_SOURCES_LIMITS.maxNestingDepth) return true;
    } else if (character === "}" || character === "]") {
      depth -= 1;
    }
  }
  return false;
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

function isSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
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

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

const systemClock: ContextSourcesClock = {
  now: () => Date.now(),
  schedule: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
  cancel: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
};
