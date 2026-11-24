// PERF-09: the pure update rules (payload validation, interest matching and the detail hydration) live here, so the
// first screen can load them without the Pembaruan page. UpdatesCenter.tsx re-exports every name for existing callers.
import type {
  BriefingInterests,
  Category,
  FreshnessStatus,
  HistoryEntry,
  Lifecycle,
  PublicScope,
  TimeScope,
} from "@waspada/worker/public-contracts";
import { ApiHttpError, ApiPayloadError } from "./api-client.js";

export const UPDATE_CURSOR_STORAGE_KEY = "waspada-jakarta:updates:cursor:v1";
export const UPDATE_PAGE_SIZE = 20;
export const UPDATE_MAX_PAGES_PER_CYCLE = 5;
export const UPDATE_DETAIL_CONCURRENCY = 4;
export const UPDATE_POLL_INTERVAL_MS = 60_000;

const cursorMaxLength = 2_048;
const instantPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u;
const datePattern = /^\d{4}-\d{2}-\d{2}$/u;
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
  "other",
  "unclassified",
];
const lifecycles: readonly Lifecycle[] = ["planned", "ongoing", "resolved", "cancelled", "unknown"];
const freshnessStatuses: readonly FreshnessStatus[] = ["current", "needs_update", "expired"];

export interface CurrentUpdateEvent {
  event_id: string;
  version: number;
  title: string;
  category: Category;
  lifecycle: Lifecycle;
  freshness: { status: FreshnessStatus };
  event_time: TimeScope;
  published_at: string;
  scopes: PublicScope[];
}

export interface MatchedPublicUpdate {
  change: HistoryEntry;
  event: CurrentUpdateEvent;
  relevance: { category: boolean; scope: boolean };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function isMember<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === "string" && allowed.includes(value as T);
}

function isInstant(value: unknown): value is string {
  return typeof value === "string" && value.length <= 100 && instantPattern.test(value) && !Number.isNaN(Date.parse(value));
}

function isDateOnly(value: unknown): value is string {
  if (typeof value !== "string" || !datePattern.test(value)) return false;
  const parsed = new Date(value + "T00:00:00.000Z");
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export function isValidStoredCursor(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= cursorMaxLength;
}

function parseScope(value: unknown): PublicScope {
  const fields = ["places", "services", "institutions", "audiences"] as const;
  if (!isRecord(value) || !hasExactKeys(value, fields)) throw new ApiPayloadError();
  const parsed: PublicScope = { places: [], services: [], institutions: [], audiences: [] };
  for (const field of fields) {
    const names = value[field];
    if (!Array.isArray(names) || names.some((name) => typeof name !== "string")) {
      throw new ApiPayloadError();
    }
    parsed[field] = names as string[];
  }
  return parsed;
}

function parseTimeScope(value: unknown): TimeScope {
  if (!isRecord(value) || !hasExactKeys(value, ["start", "end", "precision"])
    || !isMember(value.precision, ["exact", "date", "range", "unknown"] as const)) {
    throw new ApiPayloadError();
  }
  const valid = value.precision === "exact"
    ? isInstant(value.start) && (value.end === null || isInstant(value.end))
    : value.precision === "date"
      ? isDateOnly(value.start) && (value.end === null || isDateOnly(value.end))
      : value.precision === "range"
        ? (isInstant(value.start) || isDateOnly(value.start))
          && (isInstant(value.end) || isDateOnly(value.end))
      : value.start === null && value.end === null;
  if (!valid) throw new ApiPayloadError();
  if (value.end !== null) {
    const start = value.start as string;
    const end = value.end as string;
    if (value.precision === "exact" && Date.parse(end) < Date.parse(start)) throw new ApiPayloadError();
    if (value.precision === "date" && end < start) throw new ApiPayloadError();
    if (value.precision === "range") {
      const startIsDate = isDateOnly(start);
      const endIsDate = isDateOnly(end);
      if (startIsDate && endIsDate && end < start) throw new ApiPayloadError();
      if (!startIsDate && !endIsDate && Date.parse(end) < Date.parse(start)) throw new ApiPayloadError();
    }
  }
  return {
    start: value.start as string | null,
    end: value.end as string | null,
    precision: value.precision,
  };
}

function parseFreshnessStatus(value: unknown): { status: FreshnessStatus } {
  if (!isRecord(value) || !hasExactKeys(value, ["status", "evaluated_at", "review_due_at", "basis"])
    || !isMember(value.status, freshnessStatuses)
    || !isInstant(value.evaluated_at)
    || !(value.review_due_at === null || isInstant(value.review_due_at))
    || !isMember(value.basis, ["source_validity", "fast_observation_review", "undated_advisory_review", "manual_review", "unknown"] as const)) {
    throw new ApiPayloadError();
  }
  return { status: value.status };
}

export function validateCurrentUpdateEvent(value: unknown, expectedEventId: string, updateVersion: number): CurrentUpdateEvent {
  if (!isRecord(value)
    || value.event_id !== expectedEventId
    || !Number.isSafeInteger(value.version) || (value.version as number) < updateVersion
    || typeof value.title !== "string" || value.title.length < 1 || value.title.length > 500
    || !isMember(value.category, categories)
    || !isMember(value.lifecycle, lifecycles)
    || !isInstant(value.published_at)) {
    throw new ApiPayloadError();
  }

  const freshness = parseFreshnessStatus(value.freshness);
  const eventTime = parseTimeScope(value.event_time);
  const scopes: PublicScope[] = [parseScope(value.scope)];
  for (const field of ["claims", "impacts"] as const) {
    const records = value[field];
    if (!Array.isArray(records)) throw new ApiPayloadError();
    for (const record of records) {
      if (!isRecord(record)) throw new ApiPayloadError();
      scopes.push(parseScope(record.scope));
    }
  }

  return {
    event_id: expectedEventId,
    version: value.version as number,
    title: value.title,
    category: value.category,
    lifecycle: value.lifecycle,
    freshness,
    event_time: eventTime,
    published_at: value.published_at,
    scopes,
  };
}

function normalizedIdentity(value: string): string {
  return value.normalize("NFC").trim().toLocaleLowerCase("id-ID");
}

export function matchPublicUpdate(event: CurrentUpdateEvent, interests: BriefingInterests): MatchedPublicUpdate["relevance"] {
  const category = interests.categories.includes(event.category);
  const fieldPairs = [
    ["places", "places"],
    ["services", "services"],
    ["institutions", "institutions"],
    ["audiences", "audiences"],
  ] as const;
  const scope = fieldPairs.some(([interestField, scopeField]) => {
    const selected = new Set(interests[interestField].map(normalizedIdentity));
    return selected.size > 0 && event.scopes.some((eventScope) =>
      eventScope[scopeField].some((name) => selected.has(normalizedIdentity(name))),
    );
  });
  return { category, scope };
}

export async function hydrateAndMatchUpdates(
  changes: readonly HistoryEntry[],
  interests: BriefingInterests,
  getDetail: (eventId: string, signal: AbortSignal) => Promise<unknown>,
  signal: AbortSignal,
): Promise<MatchedPublicUpdate[]> {
  const eventIds = [...new Set(changes.map((change) => change.event_id))];
  const details = new Map<string, CurrentUpdateEvent | null>();
  let nextIndex = 0;
  let failure: unknown;

  const worker = async () => {
    while (failure === undefined && nextIndex < eventIds.length) {
      const eventId = eventIds[nextIndex++];
      if (eventId === undefined) return;
      const relevantChanges = changes.filter((change) => change.event_id === eventId);
      const latestUpdateVersion = Math.max(...relevantChanges.map((change) => change.version));
      try {
        const detail = await getDetail(eventId, signal);
        if (signal.aborted) return;
        details.set(eventId, validateCurrentUpdateEvent(detail, eventId, latestUpdateVersion));
      } catch (error) {
        if (signal.aborted) return;
        if (error instanceof ApiHttpError && error.status === 404) {
          details.set(eventId, null);
        } else {
          failure = error;
        }
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(UPDATE_DETAIL_CONCURRENCY, eventIds.length) }, () => worker()));
  if (signal.aborted) throw new DOMException("The request was aborted", "AbortError");
  if (failure !== undefined) throw failure;

  const matches: MatchedPublicUpdate[] = [];
  for (const change of changes) {
    const event = details.get(change.event_id);
    if (event === null || event === undefined) continue;
    const relevance = matchPublicUpdate(event, interests);
    if (relevance.category || relevance.scope) matches.push({ change, event, relevance });
  }
  return matches;
}
