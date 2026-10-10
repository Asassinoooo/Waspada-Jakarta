import type {
  PreviewRecord,
  PreviewSource,
  PreviewSourceId,
} from "../../contracts/source-preview.js";

// The Worker bundler includes this committed, ODbL-attributed JSON snapshot.
import osmSnapshot from "../../demo/osm-reference-snapshot.json" with { type: "json" };

export const SOURCE_PREVIEW_LIMITS = {
  requestDeadlineMs: 25_000,
  maxBodyBytes: 1_048_576,
  maxNestingDepth: 32,
  maxProviderRecords: 500,
  maxRecordsPerSource: 100,
  cacheTtlMs: 5 * 60_000,
  recentReportWindowMs: 24 * 60 * 60_000,
  maxProviderTextLength: 128,
} as const;

export const SOURCE_PREVIEW_ATTRIBUTION = {
  osm: "© OpenStreetMap contributors · ODbL 1.0",
  osmLicenseUrl: "https://opendatacommons.org/licenses/odbl/1-0/",
  petabencana: "Data disediakan oleh PetaBencana.id, dilisensikan di bawah CC BY-NC 4.0.",
  petabencanaLicenseUrl: "https://creativecommons.org/licenses/by-nc/4.0/",
} as const;

const osmEndpoint = "https://overpass-api.de/api/interpreter";
const petabencanaEndpoint = "https://api.petabencana.id/reports?admin=ID-JK&geoformat=geojson";
const osmAttribution = SOURCE_PREVIEW_ATTRIBUTION.osm;
const osmLicenseUrl = SOURCE_PREVIEW_ATTRIBUTION.osmLicenseUrl;
const petabencanaAttribution = SOURCE_PREVIEW_ATTRIBUTION.petabencana;
const petabencanaLicenseUrl = SOURCE_PREVIEW_ATTRIBUTION.petabencanaLicenseUrl;
const identifyingUserAgent = "WaspadaJakarta-Team12-Demo/0.1 (+https://github.com/Asassinoooo/Waspada-Jakarta)";
const osmQuery = [
  "[out:json][timeout:20][maxsize:67108864];",
  "(",
  'nwr["amenity"="hospital"](-6.24,106.78,-6.14,106.88);',
  'nwr["amenity"="police"](-6.24,106.78,-6.14,106.88);',
  'nwr["amenity"="fire_station"](-6.24,106.78,-6.14,106.88);',
  ");",
  "out center 100;",
].join("");

/** Application coverage envelope for the PetaBencana report preview (CRS84). */
const petabencanaEnvelope = {
  west: 106.32,
  south: -6.4,
  east: 106.98,
  north: -5.16,
} as const;

/** Narrow Overpass query window for OSM reference facilities (CRS84). */
const osmEnvelope = {
  west: 106.78,
  south: -6.24,
  east: 106.88,
  north: -6.14,
} as const;

export interface SourcePreviewClock {
  now(): number;
  schedule(callback: () => void, delayMs: number): unknown;
  cancel(handle: unknown): void;
}

export interface SourcePreviewAdapterOptions {
  readonly fetch?: typeof fetch;
  readonly clock?: SourcePreviewClock;
}

export interface SourcePreviewSourceRead {
  readonly sources: readonly [PreviewSource, PreviewSource];
  readonly cached: boolean;
}

export interface SourcePreviewAdapters {
  readSnapshot(): readonly [PreviewSource, PreviewSource];
  fetchSources(): Promise<readonly [PreviewSource, PreviewSource]>;
}

export function createSourcePreviewAdapters(
  options: SourcePreviewAdapterOptions = {},
): SourcePreviewAdapters {
  const fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
  const clock = options.clock ?? systemClock;

  return {
    readSnapshot() {
      return [readValidatedOsmSnapshot(), notRequestedPetabencanaSource()];
    },
    fetchSources() {
      return acquireSources(fetcher, clock);
    },
  };
}

/** Validates and copies the checked-in source snapshot into the closed DTO. */
export function readValidatedOsmSnapshot(): PreviewSource {
  const value: unknown = osmSnapshot;
  if (!isRecord(value) || !hasExactKeys(value, [
    "id", "status", "data_mode", "fetched_at", "source_updated_at", "attribution",
    "license_url", "records", "rejected_count", "limited", "error",
  ])) {
    throw new Error("invalid_snapshot");
  }
  if (value.id !== "osm" || value.status !== "available" || value.data_mode !== "snapshot"
    || !isValidInstant(value.fetched_at) || !isValidInstant(value.source_updated_at)
    || value.attribution !== osmAttribution || value.license_url !== osmLicenseUrl
    || !Array.isArray(value.records) || value.records.length > SOURCE_PREVIEW_LIMITS.maxRecordsPerSource
    || value.rejected_count !== 0 || typeof value.limited !== "boolean" || value.error !== null) {
    throw new Error("invalid_snapshot");
  }

  const records: PreviewRecord[] = [];
  for (const candidate of value.records) {
    const record = validateOsmSnapshotRecord(candidate);
    if (record === null) throw new Error("invalid_snapshot");
    records.push(record);
  }
  if (!areUniqueRecordIds(records)) throw new Error("invalid_snapshot");

  return {
    id: "osm",
    status: "available",
    data_mode: "snapshot",
    fetched_at: value.fetched_at,
    source_updated_at: value.source_updated_at,
    attribution: osmAttribution,
    license_url: osmLicenseUrl,
    records,
    rejected_count: 0,
    limited: value.limited,
    error: null,
  };
}

export function notRequestedPetabencanaSource(): PreviewSource {
  return {
    id: "petabencana",
    status: "not_requested",
    data_mode: "none",
    fetched_at: null,
    source_updated_at: null,
    attribution: petabencanaAttribution,
    license_url: petabencanaLicenseUrl,
    records: [],
    rejected_count: 0,
    limited: false,
    error: null,
  };
}

async function acquireSources(
  fetcher: typeof fetch,
  clock: SourcePreviewClock,
): Promise<readonly [PreviewSource, PreviewSource]> {
  if (toIsoInstant(clock.now()) === null) {
    return [sourceFailure("osm", "invalid_payload", null), sourceFailure("petabencana", "invalid_payload", null)];
  }

  return Promise.all([
    requestOsm(fetcher, clock),
    requestPetabencana(fetcher, clock),
  ]);
}

interface RequestDeadline {
  readonly signal: AbortSignal;
  readonly timeoutPromise: Promise<never>;
  isExpired(): boolean;
  dispose(): void;
}

function createRequestDeadline(clock: SourcePreviewClock): RequestDeadline {
  const controller = new AbortController();
  let expired = false;
  let rejectTimeout!: (error: Error) => void;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    rejectTimeout = reject;
  });
  const timeoutHandle = clock.schedule(() => {
    expired = true;
    controller.abort();
    rejectTimeout(new PreviewDeadlineError());
  }, SOURCE_PREVIEW_LIMITS.requestDeadlineMs);
  return {
    signal: controller.signal,
    timeoutPromise,
    isExpired: () => expired,
    dispose: () => clock.cancel(timeoutHandle),
  };
}

class PreviewDeadlineError extends Error {
  constructor() {
    super("timeout");
  }
}

async function requestOsm(
  fetcher: typeof fetch,
  clock: SourcePreviewClock,
): Promise<PreviewSource> {
  const attemptedAt = toIsoInstant(clock.now());
  const deadline = createRequestDeadline(clock);
  try {
    const response = await withinDeadline(
      fetcher(osmEndpoint, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded; charset=utf-8",
          "user-agent": identifyingUserAgent,
          accept: "application/json",
        },
        body: `data=${encodeURIComponent(osmQuery)}`,
        redirect: "error",
        signal: deadline.signal,
      }),
      deadline,
    );
    if (!response.ok || response.redirected) return sourceFailure("osm", "http_error", attemptedAt);
    const json = await readJsonResponse(response, deadline);
    const fetchedAt = toIsoInstant(clock.now());
    if (fetchedAt === null) return sourceFailure("osm", "invalid_payload", attemptedAt);
    return normalizeOsmPayload(json, fetchedAt);
  } catch (error) {
    return sourceFailure("osm", failureCode(error, deadline), attemptedAt);
  } finally {
    deadline.dispose();
  }
}

async function requestPetabencana(
  fetcher: typeof fetch,
  clock: SourcePreviewClock,
): Promise<PreviewSource> {
  const attemptedAt = toIsoInstant(clock.now());
  const deadline = createRequestDeadline(clock);
  try {
    const response = await withinDeadline(
      fetcher(petabencanaEndpoint, {
        method: "GET",
        headers: {
          "user-agent": identifyingUserAgent,
          accept: "application/json, application/geo+json",
        },
        redirect: "error",
        signal: deadline.signal,
      }),
      deadline,
    );
    if (!response.ok || response.redirected) return sourceFailure("petabencana", "http_error", attemptedAt);
    const json = await readJsonResponse(response, deadline);
    const fetchedAt = toIsoInstant(clock.now());
    if (fetchedAt === null) return sourceFailure("petabencana", "invalid_payload", attemptedAt);
    return normalizePetabencanaPayload(json, fetchedAt, Date.parse(fetchedAt));
  } catch (error) {
    return sourceFailure("petabencana", failureCode(error, deadline), attemptedAt);
  } finally {
    deadline.dispose();
  }
}

function withinDeadline<T>(operation: Promise<T>, deadline: RequestDeadline): Promise<T> {
  return Promise.race([operation, deadline.timeoutPromise]);
}

async function readJsonResponse(response: Response, deadline: RequestDeadline): Promise<unknown> {
  if (!isJsonContentType(response.headers.get("content-type"))) throw new InvalidPayloadError();

  const contentLength = response.headers.get("content-length");
  if (contentLength !== null) {
    if (!/^(0|[1-9][0-9]*)$/u.test(contentLength)) throw new InvalidPayloadError();
    const length = Number(contentLength);
    if (!Number.isSafeInteger(length) || length > SOURCE_PREVIEW_LIMITS.maxBodyBytes) {
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
      if (byteLength > SOURCE_PREVIEW_LIMITS.maxBodyBytes) {
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
      // A timed out or cancelled stream can already have released its reader.
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
  if (mediaType?.trim().toLowerCase() !== "application/json"
    && mediaType?.trim().toLowerCase() !== "application/geo+json") {
    return false;
  }
  for (const parameter of parameters) {
    const match = /^\s*charset\s*=\s*"?([^";]+)"?\s*$/iu.exec(parameter);
    if (match && match[1]?.trim().toLowerCase() !== "utf-8"
      && match[1]?.trim().toLowerCase() !== "utf8") {
      return false;
    }
  }
  return true;
}

class InvalidPayloadError extends Error {
  constructor() {
    super("invalid_payload");
  }
}

function failureCode(error: unknown, deadline: RequestDeadline): "timeout" | "http_error" | "invalid_payload" {
  if (deadline.isExpired() || error instanceof PreviewDeadlineError) return "timeout";
  if (error instanceof InvalidPayloadError) return "invalid_payload";
  return "http_error";
}

function normalizeOsmPayload(value: unknown, fetchedAt: string): PreviewSource {
  if (!isRecord(value) || hasOwn(value, "remark") || hasOwn(value, "error")
    || !Array.isArray(value.elements) || value.elements.length > SOURCE_PREVIEW_LIMITS.maxProviderRecords) {
    return sourceFailure("osm", "invalid_payload", fetchedAt);
  }

  let sourceUpdatedAt: string | null = null;
  if (hasOwn(value, "osm3s")) {
    if (!isRecord(value.osm3s)) return sourceFailure("osm", "invalid_payload", fetchedAt);
    if (hasOwn(value.osm3s, "timestamp_osm_base")) {
      const timestamp = value.osm3s.timestamp_osm_base;
      if (!isValidInstant(timestamp) || Date.parse(timestamp) > Date.parse(fetchedAt)) {
        return sourceFailure("osm", "invalid_payload", fetchedAt);
      }
      sourceUpdatedAt = timestamp;
    }
  }

  const rejected = { count: 0 };
  const groups = new Map<string, PreviewRecord[]>();
  for (const candidate of value.elements) {
    const record = normalizeOsmElement(candidate);
    if (record === null) {
      rejected.count += 1;
      continue;
    }
    const group = groups.get(record.id) ?? [];
    group.push(record);
    groups.set(record.id, group);
  }

  const records: PreviewRecord[] = [];
  for (const id of [...groups.keys()].sort(compareText)) {
    const group = groups.get(id)!;
    const variants = new Map(group.map((record) => [JSON.stringify(record), record]));
    if (variants.size > 1) {
      rejected.count += group.length;
      continue;
    }
    records.push(variants.values().next().value as PreviewRecord);
    rejected.count += group.length - 1;
  }

  const limited = value.elements.length >= SOURCE_PREVIEW_LIMITS.maxRecordsPerSource
    || records.length > SOURCE_PREVIEW_LIMITS.maxRecordsPerSource;
  const cappedRecords = records.slice(0, SOURCE_PREVIEW_LIMITS.maxRecordsPerSource);
  const removedByCap = Math.max(0, records.length - cappedRecords.length);
  rejected.count += removedByCap;
  const status = cappedRecords.length > 0
    ? "available"
    : rejected.count > 0
      ? "unavailable"
      : "empty";

  return {
    id: "osm",
    status,
    data_mode: "fetched",
    fetched_at: fetchedAt,
    source_updated_at: sourceUpdatedAt,
    attribution: osmAttribution,
    license_url: osmLicenseUrl,
    records: cappedRecords,
    rejected_count: rejected.count,
    limited,
    error: status === "unavailable" ? "invalid_payload" : null,
  };
}

function normalizeOsmElement(value: unknown): PreviewRecord | null {
  if (!isRecord(value)
    || (value.type !== "node" && value.type !== "way" && value.type !== "relation")
    || !isSafePositiveInteger(value.id)
    || !isRecord(value.tags)) {
    return null;
  }

  const kind = osmKind(value.tags.amenity);
  if (kind === null) return null;

  const point = value.type === "node" ? value : value.center;
  if (!isRecord(point) || !isFiniteNumber(point.lon) || !isFiniteNumber(point.lat)
    || !isWithinEnvelope(point.lon, point.lat, osmEnvelope)) {
    return null;
  }

  const name = normalizeOsmName(value.tags.name, kind);
  if (name === null) return null;
  const id = `osm:${value.type}/${value.id}`;
  return {
    id,
    source: "osm",
    kind,
    title: name,
    coordinates: [point.lon, point.lat],
    coordinate_kind: value.type === "node" ? "source_point" : "source_extent_center",
    source_created_at: null,
    source_status: null,
    source_url: `https://www.openstreetmap.org/${value.type}/${value.id}`,
  };
}

function osmKind(value: unknown): "hospital" | "police" | "fire_station" | null {
  if (value === "hospital") return "hospital";
  if (value === "police") return "police";
  if (value === "fire_station") return "fire_station";
  return null;
}

function normalizeOsmName(value: unknown, kind: "hospital" | "police" | "fire_station"): string | null {
  const fallback = kind === "hospital" ? "Hospital"
    : kind === "police" ? "Police station" : "Fire station";
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "string" || containsControlCharacters(value)) return null;
  const normalized = value.normalize("NFC").replace(/\s+/gu, " ").trim();
  if (normalized.length === 0) return fallback;
  if (Array.from(normalized).length > SOURCE_PREVIEW_LIMITS.maxProviderTextLength) return null;
  return normalized;
}

function normalizePetabencanaPayload(
  value: unknown,
  fetchedAt: string,
  nowMs: number,
): PreviewSource {
  if (!isRecord(value) || value.statusCode !== 200
    || hasOwn(value, "error") || hasOwn(value, "errors") || hasOwn(value, "remark")
    || !isRecord(value.result) || value.result.type !== "FeatureCollection"
    || hasOwn(value.result, "error") || hasOwn(value.result, "errors") || hasOwn(value.result, "remark")
    || !Array.isArray(value.result.features)
    || value.result.features.length > SOURCE_PREVIEW_LIMITS.maxProviderRecords) {
    return sourceFailure("petabencana", "invalid_payload", fetchedAt);
  }

  const rejected = { count: 0 };
  const groups = new Map<string, PreviewRecord[]>();
  for (const feature of value.result.features) {
    const normalized = normalizePetabencanaFeature(feature, nowMs);
    if (normalized.kind === "ignored") continue;
    if (normalized.kind === "rejected") {
      rejected.count += 1;
      continue;
    }
    const group = groups.get(normalized.record.id) ?? [];
    group.push(normalized.record);
    groups.set(normalized.record.id, group);
  }

  const records: PreviewRecord[] = [];
  for (const id of [...groups.keys()].sort(compareText)) {
    const group = groups.get(id)!;
    const variants = new Map(group.map((record) => [JSON.stringify(record), record]));
    if (variants.size > 1) {
      rejected.count += group.length;
      continue;
    }
    records.push(variants.values().next().value as PreviewRecord);
    rejected.count += group.length - 1;
  }

  const limited = value.result.features.length >= SOURCE_PREVIEW_LIMITS.maxRecordsPerSource
    || records.length > SOURCE_PREVIEW_LIMITS.maxRecordsPerSource;
  const cappedRecords = records.slice(0, SOURCE_PREVIEW_LIMITS.maxRecordsPerSource);
  rejected.count += Math.max(0, records.length - cappedRecords.length);
  const status = cappedRecords.length > 0
    ? "available"
    : rejected.count > 0
      ? "unavailable"
      : "empty";

  return {
    id: "petabencana",
    status,
    data_mode: "fetched",
    fetched_at: fetchedAt,
    source_updated_at: null,
    attribution: petabencanaAttribution,
    license_url: petabencanaLicenseUrl,
    records: cappedRecords,
    rejected_count: rejected.count,
    limited,
    error: status === "unavailable" ? "invalid_payload" : null,
  };
}

type FeatureNormalization =
  | { readonly kind: "accepted"; readonly record: PreviewRecord }
  | { readonly kind: "ignored" }
  | { readonly kind: "rejected" };

function normalizePetabencanaFeature(value: unknown, nowMs: number): FeatureNormalization {
  if (!isRecord(value) || value.type !== "Feature" || !isRecord(value.properties)
    || !isRecord(value.geometry) || value.geometry.type !== "Point"
    || !Array.isArray(value.geometry.coordinates)) {
    return { kind: "rejected" };
  }

  const properties = value.properties;
  const disasterType = properties.disaster_type;
  if (typeof disasterType !== "string" || containsControlCharacters(disasterType)
    || disasterType.length > SOURCE_PREVIEW_LIMITS.maxProviderTextLength) {
    return { kind: "rejected" };
  }
  if (disasterType.trim().toLowerCase() !== "flood") return { kind: "ignored" };

  const providerId = normalizeProviderId(properties.pkey);
  if (providerId === null) return { kind: "rejected" };

  const coordinates = value.geometry.coordinates;
  if ((coordinates.length !== 2 && coordinates.length !== 3)
    || !isFiniteNumber(coordinates[0]) || !isFiniteNumber(coordinates[1])
    || (coordinates.length === 3 && !isFiniteNumber(coordinates[2]))) {
    return { kind: "rejected" };
  }
  const longitude = coordinates[0];
  const latitude = coordinates[1];
  if (!isWithinEnvelope(longitude, latitude, petabencanaEnvelope)) return { kind: "rejected" };

  const createdAt = properties.created_at;
  if (!isValidInstant(createdAt)) return { kind: "rejected" };
  const createdAtMs = Date.parse(createdAt);
  if (createdAtMs > nowMs
    || createdAtMs < nowMs - SOURCE_PREVIEW_LIMITS.recentReportWindowMs) {
    return { kind: "rejected" };
  }

  const sourceStatus = normalizePublisherStatus(properties.status);
  if (sourceStatus.kind === "rejected") return { kind: "rejected" };

  return {
    kind: "accepted",
    record: {
      id: `petabencana:${providerId}`,
      source: "petabencana",
      kind: "flood_report",
      title: "Laporan banjir warga",
      coordinates: [longitude, latitude],
      coordinate_kind: "source_point",
      source_created_at: createdAt,
      source_status: sourceStatus.value,
      source_url: "https://petabencana.id/",
    },
  };
}

function normalizeProviderId(value: unknown): string | null {
  let normalized: string;
  if (typeof value === "number" && Number.isSafeInteger(value)) {
    normalized = String(value);
  } else if (typeof value === "string") {
    normalized = value;
  } else {
    return null;
  }
  return /^[A-Za-z0-9_-]{1,64}$/u.test(normalized) ? normalized : null;
}

function normalizePublisherStatus(value: unknown): { readonly kind: "accepted"; readonly value: string | null }
  | { readonly kind: "rejected" } {
  if (value === undefined || value === null) return { kind: "accepted", value: null };
  if (typeof value !== "string" || Array.from(value).length > 64 || containsControlCharacters(value)) {
    return { kind: "rejected" };
  }
  const normalized = value.trim();
  return { kind: "accepted", value: normalized.length === 0 ? null : normalized };
}

function sourceFailure(
  id: PreviewSourceId,
  error: "timeout" | "http_error" | "invalid_payload",
  fetchedAt: string | null,
): PreviewSource {
  const isOsm = id === "osm";
  return {
    id,
    status: "unavailable",
    data_mode: "fetched",
    fetched_at: fetchedAt,
    source_updated_at: null,
    attribution: isOsm ? osmAttribution : petabencanaAttribution,
    license_url: isOsm ? osmLicenseUrl : petabencanaLicenseUrl,
    records: [],
    rejected_count: 0,
    limited: false,
    error,
  };
}

function validateOsmSnapshotRecord(value: unknown): PreviewRecord | null {
  if (!isRecord(value) || !hasExactKeys(value, [
    "id", "source", "kind", "title", "coordinates", "coordinate_kind", "source_created_at",
    "source_status", "source_url",
  ])) return null;
  if (value.source !== "osm" || value.kind !== "hospital" && value.kind !== "police"
    && value.kind !== "fire_station" || typeof value.id !== "string"
    || !/^osm:(?:node|way|relation)\/[1-9][0-9]*$/u.test(value.id)
    || typeof value.title !== "string" || Array.from(value.title).length < 1
    || Array.from(value.title).length > SOURCE_PREVIEW_LIMITS.maxProviderTextLength
    || containsControlCharacters(value.title)
    || !Array.isArray(value.coordinates) || value.coordinates.length !== 2
    || !isFiniteNumber(value.coordinates[0]) || !isFiniteNumber(value.coordinates[1])
    || !isWithinEnvelope(value.coordinates[0], value.coordinates[1], osmEnvelope)
    || value.coordinate_kind !== (value.id.startsWith("osm:node/") ? "source_point" : "source_extent_center")
    || value.source_created_at !== null || value.source_status !== null) {
    return null;
  }
  const url = osmRecordUrl(value.id);
  if (value.source_url !== url) return null;
  return {
    id: value.id,
    source: "osm",
    kind: value.kind,
    title: value.title,
    coordinates: [value.coordinates[0], value.coordinates[1]],
    coordinate_kind: value.id.startsWith("osm:node/") ? "source_point" : "source_extent_center",
    source_created_at: null,
    source_status: null,
    source_url: url,
  };
}

function osmRecordUrl(id: string): string {
  const match = /^osm:(node|way|relation)\/([1-9][0-9]*)$/u.exec(id);
  return match === null ? "" : `https://www.openstreetmap.org/${match[1]}/${match[2]}`;
}

function isValidInstant(value: unknown): value is string {
  if (typeof value !== "string"
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(value)) {
    return false;
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return false;
  const datePart = value.slice(0, 10);
  const year = Number(datePart.slice(0, 4));
  const month = Number(datePart.slice(5, 7));
  const day = Number(datePart.slice(8, 10));
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
      if (depth > SOURCE_PREVIEW_LIMITS.maxNestingDepth) return true;
    } else if (character === "}" || character === "]") {
      depth -= 1;
    }
  }
  return false;
}

function isWithinEnvelope(
  longitude: number,
  latitude: number,
  envelope: { readonly west: number; readonly south: number; readonly east: number; readonly north: number },
): boolean {
  return longitude >= envelope.west && longitude <= envelope.east
    && latitude >= envelope.south && latitude <= envelope.north;
}

function isSafePositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
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

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => hasOwn(value, key));
}

function areUniqueRecordIds(records: readonly PreviewRecord[]): boolean {
  return new Set(records.map((record) => record.id)).size === records.length;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

const systemClock: SourcePreviewClock = {
  now: () => Date.now(),
  schedule: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
  cancel: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
};
