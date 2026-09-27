import type {
  Category,
  BriefingInterests,
  BriefingResponse,
  EventDetail,
  EventPage,
  FreshnessStatus,
  HistoryPage,
  Lifecycle,
  PublicContext,
  PublicFeature,
  PublicFeatureCollection,
  PublicGeoJSONGeometry,
  PublicGeoJSONPosition,
  PublicGeometry,
} from "@waspada/worker/public-contracts";

export class ApiHttpError extends Error {
  constructor(readonly status: number) {
    super("Public API request failed with status " + status);
    this.name = "ApiHttpError";
  }
}

export class ApiPayloadError extends Error {
  constructor() {
    super("Public API response could not be safely read");
    this.name = "ApiPayloadError";
  }
}

export type ApiReadState<T> =
  | { eventId: string; status: "loading" | "not-found" | "unavailable" }
  | { eventId: string; status: "loaded"; data: T };

export interface PublicGeoJSONFilters {
  category?: Category;
  lifecycle?: Lifecycle;
  freshness?: FreshnessStatus;
}

const MAX_GEOJSON_BYTES = 2 * 1024 * 1024;
const MAX_GEOJSON_FEATURES = 500;
const MAX_GEOJSON_POSITIONS = 50_000;
const MAX_PUBLIC_ID_LENGTH = 256;
const MAX_PUBLIC_TITLE_LENGTH = 500;
const CRS84_ENVELOPE = {
  west: 106.32,
  south: -6.4,
  east: 106.98,
  north: -5.16,
} as const;

const categories: readonly Category[] = [
  "crime_personal_security",
  "demonstrations_public_gatherings",
  "crowds_major_events",
  "violence_immediate_threats",
  "disasters_weather",
  "fires_infrastructure_hazards",
  "transport_road_incidents",
  "utilities_essential_services",
  "health_environmental_advisories",
  "group_specific_critical_notices",
];
const lifecycles: readonly Lifecycle[] = ["planned", "ongoing", "resolved", "cancelled", "unknown"];
const freshnessStatuses: readonly FreshnessStatus[] = ["current", "needs_update", "expired"];
const MAX_BRIEFING_ITEMS = 100;
const MAX_BRIEFING_REASONS = 10;
const geometryRoles: readonly PublicGeometry["role"][] = [
  "incident_scene",
  "affected_area",
  "warning_boundary",
  "route_segment",
  "service_stop",
  "facility",
  "venue",
  "service_area",
  "approximate_place",
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMember<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === "string" && allowed.includes(value as T);
}

function isInstant(value: unknown): value is string {
  return typeof value === "string" && value.length <= 100 && !Number.isNaN(Date.parse(value));
}

function isSafePublicEventId(value: unknown): value is string {
  if (typeof value !== "string" || value.length < 1 || value.length > MAX_PUBLIC_ID_LENGTH) return false;
  try {
    encodeURIComponent(value);
    return true;
  } catch {
    return false;
  }
}

function parseBriefingResponse(value: unknown): BriefingResponse {
  if (!isRecord(value) || !isInstant(value.generated_at) || !Array.isArray(value.items) || value.items.length > MAX_BRIEFING_ITEMS) {
    throw new ApiPayloadError();
  }

  for (const item of value.items) {
    if (!isRecord(item) || !isRecord(item.event) || !Array.isArray(item.relevance_reasons)) {
      throw new ApiPayloadError();
    }
    const event = item.event;
    const eventTime = event.event_time;
    const freshness = event.freshness;
    if (
      !isSafePublicEventId(event.event_id) ||
      !Number.isSafeInteger(event.version) || (event.version as number) < 1 ||
      typeof event.title !== "string" || event.title.length < 1 || event.title.length > MAX_PUBLIC_TITLE_LENGTH ||
      !isMember(event.category, categories) || !isMember(event.lifecycle, lifecycles) ||
      !isRecord(eventTime) || !isMember(eventTime.precision, ["exact", "date", "range", "unknown"] as const) ||
      !(eventTime.start === null || isInstant(eventTime.start)) ||
      !(eventTime.end === null || isInstant(eventTime.end)) ||
      !isRecord(freshness) || !isMember(freshness.status, freshnessStatuses) ||
      !isInstant(event.published_at) ||
      item.relevance_reasons.length < 1 || item.relevance_reasons.length > MAX_BRIEFING_REASONS ||
      item.relevance_reasons.some((reason) => typeof reason !== "string" || reason.length > 200)
    ) {
      throw new ApiPayloadError();
    }
  }

  return value as unknown as BriefingResponse;
}

async function readBoundedResponseText(response: Response): Promise<string> {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null && /^\d+$/.test(contentLength) && Number(contentLength) > MAX_GEOJSON_BYTES) {
    throw new ApiPayloadError();
  }

  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      totalBytes += value.byteLength;
      if (totalBytes > MAX_GEOJSON_BYTES) {
        await reader.cancel().catch(() => {});
        throw new ApiPayloadError();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    throw new ApiPayloadError();
  }
}

function parsePosition(value: unknown, counter: { positions: number }): PublicGeoJSONPosition {
  if (
    !Array.isArray(value) ||
    value.length !== 2 ||
    typeof value[0] !== "number" ||
    typeof value[1] !== "number" ||
    !Number.isFinite(value[0]) ||
    !Number.isFinite(value[1]) ||
    value[0] < CRS84_ENVELOPE.west ||
    value[0] > CRS84_ENVELOPE.east ||
    value[1] < CRS84_ENVELOPE.south ||
    value[1] > CRS84_ENVELOPE.north
  ) {
    throw new ApiPayloadError();
  }

  counter.positions += 1;
  if (counter.positions > MAX_GEOJSON_POSITIONS) throw new ApiPayloadError();
  return [value[0], value[1]];
}

function parseLine(value: unknown, counter: { positions: number }): PublicGeoJSONPosition[] {
  if (!Array.isArray(value) || value.length < 2 || value.length > MAX_GEOJSON_POSITIONS) {
    throw new ApiPayloadError();
  }
  return value.map((position) => parsePosition(position, counter));
}

function parseRing(value: unknown, counter: { positions: number }): PublicGeoJSONPosition[] {
  if (!Array.isArray(value) || value.length < 4 || value.length > MAX_GEOJSON_POSITIONS) {
    throw new ApiPayloadError();
  }
  const ring = value.map((position) => parsePosition(position, counter));
  const first = ring[0];
  const last = ring[ring.length - 1];
  if (!first || !last || first[0] !== last[0] || first[1] !== last[1]) {
    throw new ApiPayloadError();
  }
  return ring;
}

function parseGeometry(value: unknown, counter: { positions: number }): PublicGeoJSONGeometry {
  if (!isRecord(value) || !("coordinates" in value)) throw new ApiPayloadError();
  const coordinates = value.coordinates;

  if (value.type === "Point") {
    return { type: "Point", coordinates: parsePosition(coordinates, counter) };
  }
  if (value.type === "MultiPoint") {
    if (!Array.isArray(coordinates) || coordinates.length < 1 || coordinates.length > MAX_GEOJSON_POSITIONS) {
      throw new ApiPayloadError();
    }
    return { type: "MultiPoint", coordinates: coordinates.map((position) => parsePosition(position, counter)) };
  }
  if (value.type === "LineString") {
    return { type: "LineString", coordinates: parseLine(coordinates, counter) };
  }
  if (value.type === "MultiLineString") {
    if (!Array.isArray(coordinates) || coordinates.length < 1 || coordinates.length > MAX_GEOJSON_POSITIONS) {
      throw new ApiPayloadError();
    }
    return { type: "MultiLineString", coordinates: coordinates.map((line) => parseLine(line, counter)) };
  }
  if (value.type === "Polygon") {
    if (!Array.isArray(coordinates) || coordinates.length < 1 || coordinates.length > MAX_GEOJSON_POSITIONS) {
      throw new ApiPayloadError();
    }
    return { type: "Polygon", coordinates: coordinates.map((ring) => parseRing(ring, counter)) };
  }
  if (value.type === "MultiPolygon") {
    if (!Array.isArray(coordinates) || coordinates.length < 1 || coordinates.length > MAX_GEOJSON_POSITIONS) {
      throw new ApiPayloadError();
    }
    return {
      type: "MultiPolygon",
      coordinates: coordinates.map((polygon) => {
        if (!Array.isArray(polygon) || polygon.length < 1 || polygon.length > MAX_GEOJSON_POSITIONS) {
          throw new ApiPayloadError();
        }
        return polygon.map((ring) => parseRing(ring, counter));
      }),
    };
  }
  throw new ApiPayloadError();
}

function parseFeature(value: unknown, counter: { positions: number }): PublicFeature {
  if (!isRecord(value) || value.type !== "Feature" || typeof value.id !== "string") {
    throw new ApiPayloadError();
  }
  if (value.id.length < 1 || value.id.length > MAX_PUBLIC_ID_LENGTH || !isRecord(value.properties)) {
    throw new ApiPayloadError();
  }

  const properties = value.properties;
  if (
    typeof properties.event_id !== "string" ||
    properties.event_id.length < 1 ||
    properties.event_id.length > MAX_PUBLIC_ID_LENGTH ||
    !Number.isSafeInteger(properties.version) ||
    (properties.version as number) < 1 ||
    typeof properties.title !== "string" ||
    properties.title.length < 1 ||
    properties.title.length > MAX_PUBLIC_TITLE_LENGTH ||
    !isMember(properties.category, categories) ||
    !isMember(properties.lifecycle, lifecycles) ||
    !isMember(properties.freshness, freshnessStatuses) ||
    !isMember(properties.geometry_role, geometryRoles)
  ) {
    throw new ApiPayloadError();
  }

  return {
    type: "Feature",
    id: value.id,
    geometry: parseGeometry(value.geometry, counter),
    properties: {
      event_id: properties.event_id,
      version: properties.version as number,
      title: properties.title,
      category: properties.category,
      lifecycle: properties.lifecycle,
      freshness: properties.freshness,
      geometry_role: properties.geometry_role,
    },
  };
}

export function parsePublicGeoJSON(value: unknown): PublicFeatureCollection {
  if (!isRecord(value) || value.type !== "FeatureCollection" || !Array.isArray(value.features)) {
    throw new ApiPayloadError();
  }
  if (value.features.length > MAX_GEOJSON_FEATURES) throw new ApiPayloadError();

  const counter = { positions: 0 };
  return {
    type: "FeatureCollection",
    features: value.features.map((feature) => parseFeature(feature, counter)),
  };
}

async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(path, { headers: { accept: "application/json" } });
  if (!response.ok) throw new ApiHttpError(response.status);
  return (await response.json()) as T;
}

export function getPublicContext() {
  return getJson<PublicContext>("/api/v1/context");
}

export async function requestBriefing(interests: BriefingInterests): Promise<BriefingResponse> {
  const response = await fetch("/api/v1/briefings", {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
    },
    cache: "no-store",
    body: JSON.stringify({ interests }),
  });
  if (!response.ok) throw new ApiHttpError(response.status);

  const contentType = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
  if (contentType !== "application/json") throw new ApiPayloadError();

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new ApiPayloadError();
  }
  return parseBriefingResponse(body);
}

export function listEvents() {
  return getJson<EventPage>("/api/v1/events");
}

export function getEventDetail(eventId: string) {
  return getJson<EventDetail>("/api/v1/events/" + encodeURIComponent(eventId));
}

export function getEventHistory(eventId: string) {
  return getJson<HistoryPage>("/api/v1/events/" + encodeURIComponent(eventId) + "/history");
}

export async function getEventGeoJSON(filters: PublicGeoJSONFilters = {}): Promise<PublicFeatureCollection> {
  const query = new URLSearchParams();
  if (filters.category) query.set("category", filters.category);
  if (filters.lifecycle) query.set("lifecycle", filters.lifecycle);
  if (filters.freshness) query.set("freshness", filters.freshness);
  const search = query.toString();
  const path = "/api/v1/events.geojson" + (search ? "?" + search : "");
  const response = await fetch(path, { headers: { accept: "application/geo+json" } });
  if (!response.ok) throw new ApiHttpError(response.status);

  const contentType = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
  if (contentType !== "application/geo+json") throw new ApiPayloadError();

  let body: unknown;
  try {
    body = JSON.parse(await readBoundedResponseText(response));
  } catch (error) {
    if (error instanceof ApiPayloadError) throw error;
    throw new ApiPayloadError();
  }
  return parsePublicGeoJSON(body);
}
