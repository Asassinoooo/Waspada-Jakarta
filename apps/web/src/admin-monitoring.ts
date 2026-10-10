import type {
  Category, EventView, FreshnessStatus, Lifecycle, PublicClaim, PublicContext,
  PublicFeatureCollection, PublicGeoJSONGeometry, PublicImpact, PublicScope, TimeScope,
} from "@waspada/worker/public-contracts";
import { parsePublicGeoJSON } from "./api-client.js";
import type {
  AdminActivity, AdminItem, AdminLayerSummary, AdminMonitorState, AdminProbe,
  AdminSnapshot, AdminSource, AdminStep,
} from "./admin-types.js";

const POLL_INTERVAL_MS = 30_000;
const MAX_BACKOFF_MS = 5 * 60_000;
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_CONTEXT_BYTES = 64 * 1024;
const MAX_EVENTS_BYTES = 768 * 1024;
const MAX_GEOJSON_BYTES = 2 * 1024 * 1024;
const MAX_EVENTS = 20;
const MAX_SOURCES = 100;
const MAX_TEXT = 4_000;
const MAX_PUBLIC_ID = 256;
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/u;
const INSTANT_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|([+-])(\d{2}):(\d{2}))$/u;

const categories: readonly Category[] = [
  "crime_personal_security", "demonstrations_public_gatherings", "crowds_major_events",
  "violence_immediate_threats", "disasters_weather", "fires_infrastructure_hazards",
  "transport_road_incidents", "utilities_essential_services", "health_environmental_advisories",
  "group_specific_critical_notices",
];
const lifecycles: readonly Lifecycle[] = ["planned", "ongoing", "resolved", "cancelled", "unknown"];
const freshnessStatuses: readonly FreshnessStatus[] = ["current", "needs_update", "expired"];
const precisions = ["exact", "date", "range", "unknown"] as const;
const freshnessBases = ["source_validity", "fast_observation_review", "undated_advisory_review", "manual_review", "unknown"] as const;
const tagNamespaces = ["topic", "service", "audience", "hazard", "transport_mode", "place_type"] as const;
const evidenceLabels = ["issuer_notice", "attributed_report", "independent_corroboration", "crowdsourced_observation"] as const;
const impactTypes = [
  "road_closure", "traffic_diversion", "transport_service_disruption", "facility_closure", "utility_outage",
  "hazard_observation", "public_access_restriction", "event_attendance", "audience_notice", "other",
] as const;
const geometryRoles = [
  "incident_scene", "affected_area", "warning_boundary", "route_segment", "service_stop",
  "facility", "venue", "service_area", "approximate_place",
] as const;

type JsonRecord = Record<string, unknown>;
type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface AdminMonitorScheduler {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}
export interface AdminMonitorOptions {
  onState: (state: AdminMonitorState) => void;
  /** Test seam. Production uses same-origin public GET requests. */
  fetch?: FetchLike;
  /** Test seam. Production uses browser timers. */
  scheduler?: AdminMonitorScheduler;
  /** Test seam in Unix milliseconds. Production uses Date.now(). */
  clock?: () => number;
}

class MonitorHttpError extends Error {
  constructor(readonly status: number) {
    super("Public endpoint returned a non-success status.");
  }
}
class MonitorPayloadError extends Error {
  constructor() {
    super("Public endpoint returned an invalid bounded projection.");
  }
}
class MonitorAbortedError extends Error {
  constructor() {
    super("Public endpoint request was aborted.");
  }
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function hasExactKeys(value: JsonRecord, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}
function isString(value: unknown, maximum: number, allowEmpty = true): value is string {
  return typeof value === "string" && value.length <= maximum && (allowEmpty || value.length > 0);
}
function isInstant(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 100) return false;
  const match = INSTANT_PATTERN.exec(value);
  if (!match || !validCalendarDate(Number(match[1]), Number(match[2]), Number(match[3]))) return false;
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  if (hour > 23 || minute > 59 || second > 59) return false;
  if (match[9] !== undefined && (Number(match[10]) > 23 || Number(match[11]) > 59)) return false;
  return Number.isFinite(Date.parse(value));
}
function validCalendarDate(year: number, month: number, day: number): boolean {
  if (year < 1 || month < 1 || month > 12 || day < 1) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const monthDays = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= (monthDays[month - 1] ?? 0);
}
function isDateOnly(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = DATE_PATTERN.exec(value);
  return match !== null && validCalendarDate(Number(match[1]), Number(match[2]), Number(match[3]));
}
function isMember<T extends string>(value: unknown, values: readonly T[]): value is T {
  return typeof value === "string" && values.includes(value as T);
}
function nullableInstant(value: unknown): value is string | null {
  return value === null || isInstant(value);
}
function stringArray(value: unknown, maximumCount: number, maximumLength: number): value is string[] {
  return Array.isArray(value) && value.length <= maximumCount
    && value.every((entry) => isString(entry, maximumLength, false));
}
function parseTimeScope(value: unknown): TimeScope {
  if (!isRecord(value) || !hasExactKeys(value, ["start", "end", "precision"])
    || !isMember(value.precision, precisions)) throw new MonitorPayloadError();
  if (value.precision === "unknown") {
    if (value.start !== null || value.end !== null) throw new MonitorPayloadError();
    return { start: null, end: null, precision: value.precision };
  }
  if (value.precision === "exact") {
    if (!isInstant(value.start) || !(value.end === null || isInstant(value.end))
      || (value.end !== null && Date.parse(value.end) < Date.parse(value.start))) throw new MonitorPayloadError();
    return { start: value.start, end: value.end, precision: value.precision };
  }
  if (value.precision === "date") {
    if (!isDateOnly(value.start) || !(value.end === null || isDateOnly(value.end))
      || (value.end !== null && value.end < value.start)) throw new MonitorPayloadError();
    return { start: value.start, end: value.end, precision: value.precision };
  }
  const start = value.start;
  const end = value.end;
  const startIsDate = isDateOnly(start);
  const endIsDate = isDateOnly(end);
  if (!(startIsDate || isInstant(start)) || !(endIsDate || isInstant(end))) throw new MonitorPayloadError();
  if (startIsDate && endIsDate && (end as string) < (start as string)) throw new MonitorPayloadError();
  if (!startIsDate && !endIsDate && Date.parse(end as string) < Date.parse(start as string)) {
    throw new MonitorPayloadError();
  }
  return { start: start as string, end: end as string, precision: value.precision };
}
function parseScope(value: unknown): PublicScope {
  if (!isRecord(value) || !hasExactKeys(value, ["places", "services", "institutions", "audiences"])
    || !stringArray(value.places, 100, 200) || !stringArray(value.services, 100, 200)
    || !stringArray(value.institutions, 100, 200) || !stringArray(value.audiences, 100, 200)) {
    throw new MonitorPayloadError();
  }
  return {
    places: [...value.places], services: [...value.services],
    institutions: [...value.institutions], audiences: [...value.audiences],
  };
}
function parseFreshness(value: unknown): EventView["freshness"] {
  if (!isRecord(value) || !hasExactKeys(value, ["status", "evaluated_at", "review_due_at", "basis"])
    || !isMember(value.status, freshnessStatuses) || !isInstant(value.evaluated_at)
    || !nullableInstant(value.review_due_at) || !isMember(value.basis, freshnessBases)) {
    throw new MonitorPayloadError();
  }
  return {
    status: value.status, evaluated_at: value.evaluated_at,
    review_due_at: value.review_due_at, basis: value.basis,
  };
}
function parseValidity(value: unknown): EventView["validity"] {
  if (!isRecord(value) || !hasExactKeys(value, ["valid_from", "valid_until"])
    || !nullableInstant(value.valid_from) || !nullableInstant(value.valid_until)
    || (value.valid_from !== null && value.valid_until !== null
      && Date.parse(value.valid_from) >= Date.parse(value.valid_until))) throw new MonitorPayloadError();
  return { valid_from: value.valid_from, valid_until: value.valid_until };
}
function parsePublicClaim(value: unknown): PublicClaim {
  if (!isRecord(value) || !hasExactKeys(value, [
    "claim_id", "text", "event_time", "validity", "scope", "qualifiers", "evidence_label", "sources",
  ])
    || !isString(value.claim_id, MAX_PUBLIC_ID, false) || !isString(value.text, MAX_TEXT, false)
    || !stringArray(value.qualifiers, 50, 500) || !isMember(value.evidence_label, evidenceLabels)
    || !Array.isArray(value.sources) || value.sources.length > MAX_SOURCES) throw new MonitorPayloadError();
  const sources = value.sources.map((source) => {
    if (!isRecord(source) || !hasExactKeys(source, ["display_name", "url", "published_at", "observed_at", "excerpt"])
      || !isString(source.display_name, 200, false) || !isString(source.url, 2_000, false)
      || !/^https?:\/\//iu.test(source.url) || !nullableInstant(source.published_at)
      || !nullableInstant(source.observed_at) || !(source.excerpt === null || isString(source.excerpt, 1_000))) {
      throw new MonitorPayloadError();
    }
    return {
      display_name: source.display_name, url: source.url, published_at: source.published_at,
      observed_at: source.observed_at, excerpt: source.excerpt,
    };
  });
  return {
    claim_id: value.claim_id, text: value.text, event_time: parseTimeScope(value.event_time),
    validity: parseValidity(value.validity), scope: parseScope(value.scope),
    qualifiers: [...value.qualifiers], evidence_label: value.evidence_label, sources,
  };
}
function parsePublicImpact(value: unknown): PublicImpact {
  if (!isRecord(value) || !hasExactKeys(value, [
    "impact_id", "version", "impact_type", "title", "description", "lifecycle", "freshness",
    "event_time", "validity", "scope",
  ])
    || !isString(value.impact_id, MAX_PUBLIC_ID, false)
    || !Number.isSafeInteger(value.version) || (value.version as number) < 1
    || !isMember(value.impact_type, impactTypes) || !isString(value.title, 500, false)
    || !isString(value.description, MAX_TEXT) || !isMember(value.lifecycle, lifecycles)) {
    throw new MonitorPayloadError();
  }
  return {
    impact_id: value.impact_id, version: value.version as number, impact_type: value.impact_type,
    title: value.title, description: value.description, lifecycle: value.lifecycle,
    freshness: parseFreshness(value.freshness), event_time: parseTimeScope(value.event_time),
    validity: parseValidity(value.validity), scope: parseScope(value.scope),
  };
}
function parseEventView(value: unknown): EventView {
  if (!isRecord(value) || !hasExactKeys(value, [
    "event_id", "version", "title", "summary", "category", "tags", "lifecycle", "freshness",
    "event_time", "validity", "scope", "claims", "impacts", "published_at",
  ])
    || !isString(value.event_id, MAX_PUBLIC_ID, false)
    || !Number.isSafeInteger(value.version) || (value.version as number) < 1
    || !isString(value.title, 500, false) || !isString(value.summary, MAX_TEXT)
    || !isMember(value.category, categories) || !Array.isArray(value.tags) || value.tags.length > 100
    || !isMember(value.lifecycle, lifecycles) || !Array.isArray(value.claims) || value.claims.length > 100
    || !Array.isArray(value.impacts) || value.impacts.length > 100 || !isInstant(value.published_at)) {
    throw new MonitorPayloadError();
  }
  const tags = value.tags.map((tag) => {
    if (!isRecord(tag) || !hasExactKeys(tag, ["namespace", "value"])
      || !isMember(tag.namespace, tagNamespaces) || !isString(tag.value, 200, false)) throw new MonitorPayloadError();
    return { namespace: tag.namespace, value: tag.value };
  });
  return {
    event_id: value.event_id, version: value.version as number, title: value.title, summary: value.summary,
    category: value.category, tags, lifecycle: value.lifecycle, freshness: parseFreshness(value.freshness),
    event_time: parseTimeScope(value.event_time), validity: parseValidity(value.validity),
    scope: parseScope(value.scope), claims: value.claims.map(parsePublicClaim),
    impacts: value.impacts.map(parsePublicImpact), published_at: value.published_at,
  };
}
function parseEventPage(value: unknown): { events: EventView[]; nextCursor: string | null } {
  if (!isRecord(value) || !hasExactKeys(value, ["data", "page"])
    || !Array.isArray(value.data) || value.data.length > MAX_EVENTS
    || !isRecord(value.page) || !hasExactKeys(value.page, ["next_cursor", "cursor_expires_at"])
    || !(value.page.next_cursor === null || isString(value.page.next_cursor, 2_048, false))
    || !(value.page.cursor_expires_at === null || isInstant(value.page.cursor_expires_at))) throw new MonitorPayloadError();
  const events = value.data.map(parseEventView);
  if (new Set(events.map((event) => event.event_id)).size !== events.length) throw new MonitorPayloadError();
  return { events, nextCursor: value.page.next_cursor };
}
function parsePublicContext(value: unknown): PublicContext {
  if (!isRecord(value) || !hasExactKeys(value, ["dataset_mode", "dataset_label", "generated_at", "sources"])
    || !isMember(value.dataset_mode, ["live", "demo"] as const)
    || !isMember(value.dataset_label, ["live", "historical", "synthetic"] as const)
    || !isInstant(value.generated_at) || !Array.isArray(value.sources) || value.sources.length > MAX_SOURCES) {
    throw new MonitorPayloadError();
  }
  if ((value.dataset_mode === "live") !== (value.dataset_label === "live")) throw new MonitorPayloadError();
  const sources = value.sources.map((source) => {
    if (!isRecord(source) || !hasExactKeys(source, ["display_name", "health", "last_success_at"])
      || !isString(source.display_name, 200, false)
      || !isMember(source.health, ["unknown", "healthy", "degraded", "unavailable"] as const)
      || !nullableInstant(source.last_success_at)) throw new MonitorPayloadError();
    return { display_name: source.display_name, health: source.health, last_success_at: source.last_success_at };
  });
  return {
    dataset_mode: value.dataset_mode, dataset_label: value.dataset_label,
    generated_at: value.generated_at, sources,
  };
}
function parseStrictGeoJSON(value: unknown): PublicFeatureCollection {
  if (!isRecord(value) || !hasExactKeys(value, ["type", "features"]) || value.type !== "FeatureCollection"
    || !Array.isArray(value.features) || value.features.length > 500) throw new MonitorPayloadError();
  for (const feature of value.features) {
    if (!isRecord(feature) || !hasExactKeys(feature, ["type", "id", "geometry", "properties"])
      || feature.type !== "Feature" || !isString(feature.id, MAX_PUBLIC_ID, false)
      || !isRecord(feature.properties) || !hasExactKeys(feature.properties, [
        "event_id", "version", "title", "category", "lifecycle", "freshness", "geometry_role",
      ])
      || !isString(feature.properties.event_id, MAX_PUBLIC_ID, false)
      || !Number.isSafeInteger(feature.properties.version) || (feature.properties.version as number) < 1
      || !isString(feature.properties.title, 500, false) || !isMember(feature.properties.category, categories)
      || !isMember(feature.properties.lifecycle, lifecycles)
      || !isMember(feature.properties.freshness, freshnessStatuses)
      || !isMember(feature.properties.geometry_role, geometryRoles)
      || !isRecord(feature.geometry)
      || !isMember(feature.geometry.type, ["Point", "MultiPoint", "LineString", "MultiLineString", "Polygon", "MultiPolygon"] as const)
      || !hasExactKeys(feature.geometry, ["type", "coordinates"])) throw new MonitorPayloadError();
  }
  try {
    return parsePublicGeoJSON(value);
  } catch {
    throw new MonitorPayloadError();
  }
}
async function readBoundedText(response: Response, maximumBytes: number): Promise<string> {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null && (!/^\d+$/u.test(contentLength) || Number(contentLength) > maximumBytes)) {
    await response.body?.cancel().catch(() => undefined);
    throw new MonitorPayloadError();
  }
  if (!response.body) throw new MonitorPayloadError();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      if (!result.value) continue;
      byteLength += result.value.byteLength;
      if (byteLength > maximumBytes) {
        await reader.cancel().catch(() => undefined);
        throw new MonitorPayloadError();
      }
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new MonitorPayloadError();
  }
}
async function getBoundedJson(
  fetcher: FetchLike, path: string, accept: string, maximumBytes: number, signal: AbortSignal,
): Promise<unknown> {
  const response = await fetcher(path, {
    method: "GET", headers: { accept }, cache: "no-store",
    credentials: "omit", redirect: "error", signal,
  });
  if (response.status !== 200) throw new MonitorHttpError(response.status);
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  const allowedTypes = accept === "application/geo+json"
    ? ["application/geo+json", "application/json"] : ["application/json"];
  if (!contentType || !allowedTypes.includes(contentType)) throw new MonitorPayloadError();
  try {
    return JSON.parse(await readBoundedText(response, maximumBytes)) as unknown;
  } catch (error) {
    if (error instanceof MonitorPayloadError) throw error;
    throw new MonitorPayloadError();
  }
}
function toIso(clock: () => number): string {
  const now = clock();
  if (!Number.isFinite(now) || Math.abs(now) > 8_640_000_000_000_000) throw new Error("Clock is invalid.");
  return new Date(now).toISOString();
}
function durationBetween(clock: () => number, start: number): number {
  const duration = clock() - start;
  return Number.isFinite(duration) ? Math.max(0, Math.round(duration)) : 0;
}
function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  }
  return value;
}

interface ProbeResult<T> {
  value: T | null;
  probe: AdminProbe;
}
async function observe<T>(
  endpoint: AdminProbe["endpoint"], path: string, accept: string, maximumBytes: number,
  parser: (value: unknown) => T, fetcher: FetchLike, parentSignal: AbortSignal,
  scheduler: AdminMonitorScheduler, clock: () => number,
): Promise<ProbeResult<T>> {
  const startedAt = clock();
  const controller = new AbortController();
  let timeout: unknown = null;
  let abortListener: (() => void) | null = null;
  const aborted = new Promise<never>((_resolve, reject) => {
    abortListener = () => {
      controller.abort();
      reject(new MonitorAbortedError());
    };
    if (parentSignal.aborted) abortListener();
    else parentSignal.addEventListener("abort", abortListener, { once: true });
  });
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeout = scheduler.setTimeout(() => {
      controller.abort();
      reject(new Error("Public endpoint request timed out."));
    }, REQUEST_TIMEOUT_MS);
  });
  const request = (async () => {
    const body = await getBoundedJson(fetcher, path, accept, maximumBytes, controller.signal);
    return parser(body);
  })();
  try {
    const value = await Promise.race([request, timeoutPromise, aborted]);
    return {
      value, probe: {
        endpoint, status: "succeeded", observedAt: toIso(clock),
        durationMs: durationBetween(clock, startedAt), httpStatus: 200,
      },
    };
  } catch (error) {
    return {
      value: null, probe: {
        endpoint, status: "failed", observedAt: toIso(clock),
        durationMs: durationBetween(clock, startedAt),
        httpStatus: error instanceof MonitorHttpError ? error.status : null,
      },
    };
  } finally {
    if (timeout !== null) scheduler.clearTimeout(timeout);
    if (abortListener) parentSignal.removeEventListener("abort", abortListener);
    if (!controller.signal.aborted) controller.abort();
  }
}
function unavailableProbe(endpoint: AdminProbe["endpoint"], at: string): AdminProbe {
  return { endpoint, status: "unavailable", observedAt: at, durationMs: null, httpStatus: null };
}

function sourceProjection(context: PublicContext): AdminSource[] {
  return context.sources.map((source, index) => ({
    id: "public-context-source-" + String(index + 1),
    name: source.display_name,
    health: source.health,
    lastSuccessAt: source.last_success_at,
    note: "Health persis berasal dari /api/v1/context; ini bukan bukti isi sumber lengkap atau akurat.",
  }));
}
function layerSummaries(
  context: PublicContext,
  eventResult: ProbeResult<{ events: EventView[]; nextCursor: string | null }>,
  allSucceeded: boolean,
): AdminLayerSummary[] {
  const sourceStates = context.sources.map((source) => source.health);
  const hasSources = sourceStates.length > 0;
  const sourcesHealthy = hasSources && sourceStates.every((health) => health === "healthy");
  const sourcesUnavailable = hasSources && sourceStates.every((health) => health === "unavailable");
  return [
    {
      layer: "L1", name: "L1 · Penerimaan dan persiapan",
      description: "Status sumber yang dilaporkan oleh konteks publik saja.",
      availability: hasSources ? "observed" : "unavailable", count: null,
      state: !hasSources || sourcesUnavailable ? "unavailable" : sourcesHealthy ? "ready" : "attention",
      note: hasSources
        ? "Jumlah antrean atau rincian sumber internal tidak tersedia melalui API publik."
        : "Konteks publik tidak mencantumkan sumber; itu bukan pernyataan bahwa semua sumber sehat.",
    },
    {
      layer: "L2", name: "L2 · Pengaitan dan grounding",
      description: "Pengukuran internal tidak ditampilkan oleh endpoint publik.",
      availability: "unavailable", count: null, state: "unavailable",
      note: "Jumlah konteks, model, token, dan hasil retrieval internal tidak tersedia.",
    },
    {
      layer: "L3", name: "L3 · Investigasi terbatas",
      description: "Pengukuran internal tidak ditampilkan oleh endpoint publik.",
      availability: "unavailable", count: null, state: "unavailable",
      note: "Kasus, anggaran, giliran, alat, dan alasan penghentian internal tidak tersedia.",
    },
    {
      layer: "L4", name: "L4 · Proyeksi publik",
      description: "Record terbit yang dikembalikan dalam halaman pertama.",
      availability: eventResult.value ? "observed" : "unavailable",
      count: eventResult.value?.events.length ?? null,
      state: eventResult.value ? "ready" : "unavailable",
      note: eventResult.value
        ? "Jumlah ini hanya record pada halaman pertama; cursor lanjutan tidak dimuat."
        : "Jumlah record tidak tersedia karena halaman publik gagal dibaca.",
    },
    {
      layer: "L5", name: "L5 · Pengamatan API",
      description: "Pengukuran browser atas tiga endpoint publik yang dibaca.",
      availability: allSucceeded ? "observed" : "unavailable",
      count: null, state: allSucceeded ? "ready" : "attention",
      note: "Durasi adalah waktu request browser; antrean dan telemetry internal tetap tidak tersedia.",
    },
  ];
}
function uniqueSourceNames(event: EventView): string[] {
  const names = new Set<string>();
  for (const claim of event.claims) for (const source of claim.sources) names.add(source.display_name);
  return [...names].slice(0, 20);
}
function sourceObservationTime(event: EventView): string | null {
  for (const claim of event.claims) {
    for (const source of claim.sources) if (source.observed_at) return source.observed_at;
  }
  return null;
}
function makePublicItems(
  events: readonly EventView[], features: PublicFeatureCollection | null,
  geometrySucceeded: boolean, capturedAt: string, datasetKind: AdminItem["datasetKind"],
): AdminItem[] {
  const byEventVersion = new Map<string, PublicGeoJSONGeometry[]>();
  if (features) {
    for (const feature of features.features) {
      const { event_id, version } = feature.properties;
      if (!events.some((event) => event.event_id === event_id && event.version === version)) continue;
      const key = event_id + "\u0000" + String(version);
      const geometries = byEventVersion.get(key) ?? [];
      geometries.push(feature.geometry);
      byEventVersion.set(key, geometries);
    }
  }
  return events.map((event) => {
    const geometries = byEventVersion.get(event.event_id + "\u0000" + String(event.version)) ?? [];
    const geometry = geometries[0] ?? null;
    const evidenceSources = uniqueSourceNames(event);
    const steps: AdminStep[] = [{
      layer: "L4", state: "done", label: "Diterima dari daftar publik",
      detail: "Record sudah menjadi proyeksi publik pada versi " + String(event.version) + ".",
      at: event.published_at,
    }];
    return {
      id: "public:" + event.event_id + ":" + String(event.version),
      title: event.title, summary: event.summary, category: event.category, layer: "L4",
      state: "done", operationalPriority: "normal",
      placeLabel: event.scope.places.slice(0, 4).join(", ") || "Lokasi tidak dirinci dalam record publik.",
      geometry,
      ...(geometries.length > 1 ? { additionalGeometries: geometries.slice(1) } : {}),
      geometryBasis: geometry ? "source_supported" : "none",
      geometryNote: geometry
        ? "Geometri berasal dari GeoJSON publik dan cocok persis dengan event serta versi ini."
        : geometrySucceeded
          ? "Tidak ada geometri yang cocok dengan event dan versi ini; hasil kosong bukan pernyataan bahwa lokasi aman."
          : "Endpoint GeoJSON gagal pada observasi ini; tidak ada geometri yang ditampilkan.",
      sourceNames: evidenceSources, eventVersion: event.version, publicEventId: event.event_id,
      datasetKind, observedAt: sourceObservationTime(event), fetchedAt: capturedAt,
      publishedAt: event.published_at,
      evidenceSummary: event.claims.length === 0
        ? "Record publik tidak memuat klaim sumber dalam respons ini."
        : String(event.claims.length) + " klaim publik" + (evidenceSources.length ? "; sumber: " + evidenceSources.join(", ") : "."),
      publicStatus: {
        lifecycle: event.lifecycle, freshness: event.freshness,
        eventTime: event.event_time, validity: event.validity,
      },
      stopReason: null, nextStep: "Periksa detail publik dan atribusi pada produk publik jika diperlukan.",
      budget: null, steps,
    };
  });
}
function createPublicSnapshot(input: {
  context: PublicContext;
  eventResult: ProbeResult<{ events: EventView[]; nextCursor: string | null }>;
  geoResult: ProbeResult<PublicFeatureCollection>;
  probes: AdminProbe[];
  capturedAt: string;
}): AdminSnapshot {
  const eventsPage = input.eventResult.value;
  const items = makePublicItems(eventsPage?.events ?? [], input.geoResult.value,
    input.geoResult.value !== null, input.capturedAt, input.context.dataset_label);
  const activities: AdminActivity[] = input.probes.map((probe) => ({
    id: "probe-" + probe.endpoint + "-" + probe.observedAt, itemId: null,
    layer: "L5", at: probe.observedAt,
    state: probe.status === "succeeded" ? "done" : probe.status === "failed" ? "failed" : "held",
    label: probe.endpoint === "context" ? "Periksa konteks publik"
      : probe.endpoint === "events" ? "Baca halaman event publik" : "Baca geometri publik",
    detail: probe.status === "succeeded"
      ? "HTTP " + String(probe.httpStatus) + " · " + String(probe.durationMs) + " ms pada browser."
      : probe.status === "failed"
        ? "Request publik gagal" + (probe.httpStatus === null ? "." : " dengan HTTP " + String(probe.httpStatus) + ".")
        : "Request dilewati karena konteks tidak dapat memverifikasi dataset.",
  }));
  const allSucceeded = input.probes.length === 3 && input.probes.every((probe) => probe.status === "succeeded");
  return deepFreeze({
    mode: "public_api", capturedAt: input.capturedAt, context: input.context,
    datasetMode: input.context.dataset_mode, items,
    layers: layerSummaries(input.context, input.eventResult, allSucceeded),
    sources: sourceProjection(input.context), activities, probes: input.probes,
    limitations: [
      "Pantauan API hanya membaca konteks, halaman pertama event (maksimum 20), dan GeoJSON publik.",
      "Mode dataset server dan label dataset ditampilkan dari /api/v1/context; keduanya terpisah dari status koneksi.",
      "Jumlah antrean, aktivitas internal, model/token, investigasi, moderator, dan telemetry server tidak tersedia melalui endpoint ini.",
      "Durasi request adalah pengukuran browser hingga respons tervalidasi, bukan latency server atau performa model.",
      "Geometry hanya ditampilkan jika event_id dan version persis cocok dengan record pada halaman yang dimuat.",
      "Hasil kosong, geometri kosong, atau sumber yang tidak tercantum bukan bukti bahwa suatu lokasi aman atau layanan lengkap.",
      "Halaman pertama saja dimuat; cursor lanjutan tidak diikuti dan tidak ada request detail per event.",
    ],
    hasMoreEvents: eventsPage ? eventsPage.nextCursor !== null : false,
  });
}

function defaultScheduler(): AdminMonitorScheduler {
  return {
    setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
    clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
  };
}
function browserVisibility(): boolean {
  return typeof document === "undefined" || document.visibilityState === "visible";
}
function browserOnline(): boolean {
  return typeof navigator === "undefined" || typeof navigator.onLine !== "boolean" || navigator.onLine;
}
function browserVisibilityTarget(): Document | null {
  return typeof document === "undefined" ? null : document;
}
function browserEventTarget(): Window | null {
  return typeof window === "undefined" ? null : window;
}

/** Poll only existing public read endpoints; this monitor performs no writes or internal telemetry reads. */
export function createAdminMonitor(options: AdminMonitorOptions): {
  start: () => Promise<void>;
  pause: () => void;
  refresh: () => Promise<void>;
  stop: () => void;
  setVisible: (visible: boolean) => void;
  setOnline: (online: boolean) => void;
} {
  const fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
  const scheduler = options.scheduler ?? defaultScheduler();
  const clock = options.clock ?? Date.now;
  const visibilityTarget = browserVisibilityTarget();
  const eventTarget = browserEventTarget();
  let state: AdminMonitorState = {
    status: "idle", snapshot: null, attemptedAt: null, lastSuccessAt: null,
    nextPollAt: null, consecutiveFailures: 0, currentAttempt: null,
  };
  let enabled = false;
  let stopped = false;
  let visible = browserVisibility();
  let online = browserOnline();
  let generation = 0;
  let activeController: AbortController | null = null;
  let inFlight: Promise<void> | null = null;
  let timer: unknown = null;
  let restartWhenIdle = false;
  let visibilityListener: (() => void) | null = null;
  let onlineListener: (() => void) | null = null;
  let offlineListener: (() => void) | null = null;

  function emit(next: AdminMonitorState): void {
    state = next;
    options.onState(state);
  }
  function publishStatus(status: AdminMonitorState["status"]): void {
    emit({ ...state, status });
  }
  function canPoll(): boolean {
    return enabled && !stopped && visible && online;
  }
  function clearTimer(): void {
    if (timer !== null) {
      scheduler.clearTimeout(timer);
      timer = null;
    }
  }
  function abortActive(): void {
    generation += 1;
    restartWhenIdle = false;
    activeController?.abort();
    activeController = null;
  }
  function markInactive(): void {
    clearTimer();
    abortActive();
    publishStatus(online ? "paused" : "offline");
  }
  function schedule(delayMs: number): void {
    clearTimer();
    if (!canPoll()) return;
    const nextPollAt = new Date(clock() + delayMs).toISOString();
    emit({ ...state, nextPollAt });
    timer = scheduler.setTimeout(() => {
      timer = null;
      void refresh();
    }, delayMs);
  }
  function failureDelay(failures: number): number {
    return Math.min(POLL_INTERVAL_MS * (2 ** Math.min(failures, 10)), MAX_BACKOFF_MS);
  }
  function installBrowserListeners(): void {
    if (visibilityTarget && visibilityListener === null) {
      visibilityListener = () => setVisible(visibilityTarget.visibilityState === "visible");
      visibilityTarget.addEventListener("visibilitychange", visibilityListener);
    }
    if (eventTarget && onlineListener === null && offlineListener === null) {
      onlineListener = () => setOnline(true);
      offlineListener = () => setOnline(false);
      eventTarget.addEventListener("online", onlineListener);
      eventTarget.addEventListener("offline", offlineListener);
    }
  }
  function removeBrowserListeners(): void {
    if (visibilityTarget && visibilityListener) visibilityTarget.removeEventListener("visibilitychange", visibilityListener);
    if (eventTarget && onlineListener) eventTarget.removeEventListener("online", onlineListener);
    if (eventTarget && offlineListener) eventTarget.removeEventListener("offline", offlineListener);
    visibilityListener = null;
    onlineListener = null;
    offlineListener = null;
  }
  function emitLoading(at: string, probes: AdminProbe[], context: PublicContext | null): void {
    emit({
      ...state, status: "loading", attemptedAt: at, nextPollAt: null,
      currentAttempt: { at, probes: [...probes], context },
    });
  }
  async function runAttempt(myGeneration: number, controller: AbortController): Promise<void> {
    if (myGeneration !== generation || stopped || controller.signal.aborted) return;
    const attemptAt = toIso(clock);
    const probes: AdminProbe[] = [];
    emitLoading(attemptAt, probes, null);
    const contextResult = await observe(
      "context", "/api/v1/context", "application/json", MAX_CONTEXT_BYTES,
      parsePublicContext, fetcher, controller.signal, scheduler, clock,
    );
    if (myGeneration !== generation || stopped || controller.signal.aborted) return;
    probes.push(contextResult.probe);
    const context = contextResult.value;
    emitLoading(attemptAt, probes, context);

    let eventResult: ProbeResult<{ events: EventView[]; nextCursor: string | null }>;
    let geoResult: ProbeResult<PublicFeatureCollection>;
    if (!context) {
      const skippedAt = toIso(clock);
      eventResult = { value: null, probe: unavailableProbe("events", skippedAt) };
      geoResult = { value: null, probe: unavailableProbe("geometry", skippedAt) };
      probes.push(eventResult.probe, geoResult.probe);
    } else {
      const [events, geometry] = await Promise.all([
        observe(
          "events", "/api/v1/events?limit=20", "application/json", MAX_EVENTS_BYTES,
          parseEventPage, fetcher, controller.signal, scheduler, clock,
        ),
        observe(
          "geometry", "/api/v1/events.geojson", "application/geo+json", MAX_GEOJSON_BYTES,
          parseStrictGeoJSON, fetcher, controller.signal, scheduler, clock,
        ),
      ]);
      if (myGeneration !== generation || stopped || controller.signal.aborted) return;
      eventResult = events;
      geoResult = geometry;
      probes.push(events.probe, geometry.probe);
    }
    if (myGeneration !== generation || stopped || controller.signal.aborted) return;

    const allSucceeded = probes.length === 3 && probes.every((probe) => probe.status === "succeeded");
    const capturedAt = toIso(clock);
    const failures = allSucceeded ? 0 : state.consecutiveFailures + 1;
    const snapshot = context
      ? createPublicSnapshot({ context, eventResult, geoResult, probes, capturedAt })
      : null;
    emit({
      ...state,
      status: allSucceeded ? "connected" : context ? "partial" : "error",
      snapshot,
      attemptedAt: attemptAt,
      lastSuccessAt: allSucceeded ? capturedAt : state.lastSuccessAt,
      currentAttempt: { at: attemptAt, probes: [...probes], context },
      consecutiveFailures: failures,
      nextPollAt: null,
    });
    if (canPoll()) schedule(allSucceeded ? POLL_INTERVAL_MS : failureDelay(failures));
  }
  function refresh(): Promise<void> {
    if (!enabled || stopped) return Promise.resolve();
    if (!online) {
      clearTimer();
      publishStatus("offline");
      return Promise.resolve();
    }
    if (!visible) {
      clearTimer();
      publishStatus("paused");
      return Promise.resolve();
    }
    if (inFlight) return inFlight;
    clearTimer();
    const controller = new AbortController();
    activeController = controller;
    const myGeneration = generation;
    let run: Promise<void>;
    run = Promise.resolve()
      .then(() => runAttempt(myGeneration, controller))
      .catch(() => {
        if (myGeneration !== generation || stopped || controller.signal.aborted) return;
        const attemptAt = state.attemptedAt ?? toIso(clock);
        const failedAt = toIso(clock);
        const failureCount = state.consecutiveFailures + 1;
        const failedProbe: AdminProbe = {
          endpoint: "context", status: "failed", observedAt: failedAt, durationMs: null, httpStatus: null,
        };
        emit({
          ...state, status: "error", snapshot: null, attemptedAt: attemptAt,
          currentAttempt: { at: attemptAt, probes: [failedProbe], context: null },
          consecutiveFailures: failureCount, nextPollAt: null,
        });
        if (canPoll()) schedule(failureDelay(failureCount));
      })
      .finally(() => {
        if (inFlight === run) inFlight = null;
        if (activeController === controller) activeController = null;
        if (restartWhenIdle && canPoll()) {
          restartWhenIdle = false;
          void refresh();
        }
      });
    inFlight = run;
    return run;
  }
  function start(): Promise<void> {
    if (stopped) return Promise.resolve();
    if (enabled) return inFlight ?? Promise.resolve();
    enabled = true;
    installBrowserListeners();
    if (!online) {
      publishStatus("offline");
      return Promise.resolve();
    }
    if (!visible) {
      publishStatus("paused");
      return Promise.resolve();
    }
    if (inFlight) {
      restartWhenIdle = true;
      return inFlight;
    }
    return refresh();
  }
  function pause(): void {
    if (stopped) return;
    enabled = false;
    restartWhenIdle = false;
    clearTimer();
    abortActive();
    publishStatus("paused");
  }
  function stop(): void {
    if (stopped) return;
    enabled = false;
    stopped = true;
    restartWhenIdle = false;
    clearTimer();
    abortActive();
    removeBrowserListeners();
    publishStatus("paused");
  }
  function setVisible(nextVisible: boolean): void {
    if (visible === nextVisible) return;
    visible = nextVisible;
    if (!enabled || stopped) return;
    if (!visible) {
      markInactive();
      return;
    }
    if (!online) {
      publishStatus("offline");
      return;
    }
    clearTimer();
    if (inFlight) restartWhenIdle = true;
    else void refresh();
  }
  function setOnline(nextOnline: boolean): void {
    if (online === nextOnline) return;
    online = nextOnline;
    if (!enabled || stopped) return;
    if (!online) {
      markInactive();
      return;
    }
    if (!visible) {
      publishStatus("paused");
      return;
    }
    clearTimer();
    if (inFlight) restartWhenIdle = true;
    else void refresh();
  }

  return { start, pause, refresh, stop, setVisible, setOnline };
}
