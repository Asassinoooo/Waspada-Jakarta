import type {
  PreviewRecord,
  PreviewSource,
  SourcePreviewPayload,
} from "../../contracts/source-preview.js";
import {
  SOURCE_PREVIEW_ATTRIBUTION,
  type SourcePreviewAdapterOptions,
} from "../l1-data-knowledge/source-preview-adapters.js";
import { createSourcePreviewRuntime } from "../../runtime/source-preview-runtime.js";

const routePath = "/api/v1/demo/source-preview";
const jsonHeaders = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
};

export interface SourcePreviewEnvironment {
  readonly DATASET_MODE?: string;
  readonly SOURCE_PREVIEW_ENABLED?: string;
}

/**
 * Creates the isolated source-preview route handler. The returned handler
 * owns one normalized fetch cache and is intended to be retained by the
 * Worker isolate for coalescing and the five-minute source budget.
 */
export function createSourcePreviewHandler(
  options: SourcePreviewAdapterOptions = {},
): (request: Request, env: SourcePreviewEnvironment) => Promise<Response> {
  const runtime = createSourcePreviewRuntime(options);
  const now = options.clock?.now ?? Date.now;

  return async (request, env) => {
    const url = new URL(request.url);
    if (url.pathname !== routePath) {
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

    const sourceMode = readSourceMode(url.search);
    if (sourceMode === null) {
      return apiError("INVALID_REQUEST", "The source-preview query is invalid.", 400);
    }

    try {
      const result = sourceMode === "fetch"
        ? await runtime.readFetched()
        : runtime.readSnapshot();
      const generatedAt = toIsoInstant(now());
      if (generatedAt === null) {
        return apiError("TEMPORARILY_UNAVAILABLE", "The source preview could not be completed.", 503);
      }
      const payload: SourcePreviewPayload = {
        schema_version: "source-preview-v1",
        mode: "source_preview",
        generated_at: generatedAt,
        cached: result.cached,
        sources: [result.sources[0], result.sources[1]],
      };
      if (!isValidSourcePreviewPayload(payload)) {
        return apiError("TEMPORARILY_UNAVAILABLE", "The source preview could not be completed.", 503);
      }
      return new Response(JSON.stringify(payload), { status: 200, headers: jsonHeaders });
    } catch {
      // Keep provider, parsing, and internal exception detail out of this public response.
      return apiError("TEMPORARILY_UNAVAILABLE", "The source preview could not be completed.", 503);
    }
  };
}

function readSourceMode(search: string): "snapshot" | "fetch" | null {
  if (search === "") return "snapshot";
  if (search === "?mode=fetch") return "fetch";
  return null;
}

function apiError(code: string, message: string, status: number): Response {
  return new Response(JSON.stringify({ code, message }), { status, headers: jsonHeaders });
}

function isValidSourcePreviewPayload(value: unknown): value is SourcePreviewPayload {
  if (!isRecord(value) || !hasExactKeys(value, [
    "schema_version", "mode", "generated_at", "cached", "sources",
  ]) || value.schema_version !== "source-preview-v1" || value.mode !== "source_preview"
    || !isValidInstant(value.generated_at) || typeof value.cached !== "boolean"
    || !Array.isArray(value.sources) || value.sources.length !== 2) {
    return false;
  }
  const osm = value.sources[0];
  const petabencana = value.sources[1];
  if (!isValidSource(osm, "osm", value.generated_at)
    || !isValidSource(petabencana, "petabencana", value.generated_at)) {
    return false;
  }
  return !(value.cached && (osm.data_mode !== "fetched" || petabencana.data_mode !== "fetched"));
}

function isValidSource(value: unknown, id: "osm" | "petabencana", generatedAt: string): value is PreviewSource {
  if (!isRecord(value) || !hasExactKeys(value, [
    "id", "status", "data_mode", "fetched_at", "source_updated_at", "attribution", "license_url",
    "records", "rejected_count", "limited", "error",
  ]) || value.id !== id || !["available", "empty", "unavailable", "not_requested"].includes(String(value.status))
    || !["snapshot", "fetched", "none"].includes(String(value.data_mode))
    || !isNullableInstant(value.fetched_at) || !isNullableInstant(value.source_updated_at)
    || !Array.isArray(value.records) || value.records.length > 100
    || !Number.isSafeInteger(value.rejected_count) || (value.rejected_count as number) < 0
    || (value.rejected_count as number) > 500 || typeof value.limited !== "boolean"
    || ![null, "timeout", "http_error", "invalid_payload"].includes(value.error as string | null)) {
    return false;
  }

  const isOsm = id === "osm";
  if (value.attribution !== (isOsm ? SOURCE_PREVIEW_ATTRIBUTION.osm : SOURCE_PREVIEW_ATTRIBUTION.petabencana)
    || value.license_url !== (isOsm
      ? SOURCE_PREVIEW_ATTRIBUTION.osmLicenseUrl
      : SOURCE_PREVIEW_ATTRIBUTION.petabencanaLicenseUrl)) {
    return false;
  }

  if (value.data_mode === "none") {
    if (id !== "petabencana" || value.status !== "not_requested" || value.fetched_at !== null
      || value.source_updated_at !== null || value.records.length !== 0 || value.error !== null
      || value.rejected_count !== 0 || value.limited) return false;
  } else if (value.data_mode === "snapshot") {
    if (id !== "osm" || value.status !== "available" || value.fetched_at === null
      || value.source_updated_at === null || value.error !== null || value.rejected_count !== 0) return false;
  } else {
    if (value.fetched_at === null || value.status === "not_requested") return false;
    if (value.status === "unavailable" && value.error === null) return false;
    if (value.status !== "unavailable" && value.error !== null) return false;
    if ((value.status === "available") !== (value.records.length > 0)) return false;
    if (id === "petabencana" && value.source_updated_at !== null) return false;
    if (value.source_updated_at !== null && Date.parse(value.source_updated_at) > Date.parse(value.fetched_at)) {
      return false;
    }
  }

  if (value.fetched_at !== null && Date.parse(value.fetched_at) > Date.parse(generatedAt)) return false;
  if (value.source_updated_at !== null && Date.parse(value.source_updated_at) > Date.parse(generatedAt)) return false;
  const ids = new Set<string>();
  for (const record of value.records) {
    const sourceFetchTime = value.fetched_at ?? generatedAt;
    if (!isValidRecord(record, id, sourceFetchTime) || ids.has(record.id)) return false;
    ids.add(record.id);
  }
  return true;
}

function isValidRecord(value: unknown, source: "osm" | "petabencana", sourceFetchTime: string): value is PreviewRecord {
  if (!isRecord(value) || !hasExactKeys(value, [
    "id", "source", "kind", "title", "coordinates", "coordinate_kind", "source_created_at",
    "source_status", "source_url",
  ]) || value.source !== source || typeof value.id !== "string"
    || typeof value.kind !== "string" || typeof value.title !== "string"
    || Array.from(value.title).length < 1 || Array.from(value.title).length > 128
    || containsControlCharacters(value.title) || !Array.isArray(value.coordinates)
    || value.coordinates.length !== 2 || !isFiniteNumber(value.coordinates[0])
    || !isFiniteNumber(value.coordinates[1]) || !isNullableInstant(value.source_created_at)
    || value.source_status !== null && !isSafeProviderStatus(value.source_status)
    || typeof value.source_url !== "string") {
    return false;
  }
  const longitude = value.coordinates[0];
  const latitude = value.coordinates[1];

  if (source === "osm") {
    const match = /^osm:(node|way|relation)\/([1-9][0-9]*)$/u.exec(value.id);
    if (match === null || !isSafeOsmId(match[2]) || value.source_url !== `https://www.openstreetmap.org/${match[1]}/${match[2]}`
      || (value.kind !== "hospital" && value.kind !== "police" && value.kind !== "fire_station")
      || value.source_created_at !== null || value.source_status !== null
      || value.coordinate_kind !== (match[1] === "node" ? "source_point" : "source_extent_center")
      || !isWithinEnvelope(longitude, latitude, { west: 106.78, south: -6.24, east: 106.88, north: -6.14 })) {
      return false;
    }
    return true;
  }

  if (!/^petabencana:[A-Za-z0-9_-]{1,64}$/u.test(value.id)
    || value.kind !== "flood_report" || value.title !== "Laporan banjir warga"
    || value.coordinate_kind !== "source_point" || value.source_url !== "https://petabencana.id/"
    || value.source_created_at === null || !isWithinEnvelope(longitude, latitude,
      { west: 106.32, south: -6.4, east: 106.98, north: -5.16 })) {
    return false;
  }
  const sourceCreatedAt = Date.parse(value.source_created_at);
  const sourceFetchTimeMs = Date.parse(sourceFetchTime);
  return sourceCreatedAt <= sourceFetchTimeMs && sourceCreatedAt >= sourceFetchTimeMs - 24 * 60 * 60_000;
}

function isSafeProviderStatus(value: unknown): value is string {
  return typeof value === "string" && Array.from(value).length <= 64
    && !containsControlCharacters(value);
}

function isSafeOsmId(value: string): boolean {
  return Number.isSafeInteger(Number(value)) && Number(value) > 0;
}

function isValidInstant(value: unknown): value is string {
  if (typeof value !== "string"
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(value)) {
    return false;
  }
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

function isNullableInstant(value: unknown): value is string | null {
  return value === null || isValidInstant(value);
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

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => hasOwn(value, key));
}
