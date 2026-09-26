import {
  PUBLIC_EVENT_LIST_PROJECTION_LIMITS,
  type PublicEventListCategory,
  type PublicEventListFilters,
  type PublicEventListFreshness,
  type PublicEventListLifecycle,
} from "./public-event-list-projection-service.js";
import { PUBLIC_EVENT_LIST_CURSOR_TOKEN_MAX_LENGTH } from "./public-event-list-cursor.js";

export interface PublicEventListQueryRequest {
  readonly limit: number;
  readonly cursorToken: string | null;
  readonly filters: PublicEventListFilters;
}

export type PublicEventListQueryErrorCode = "INVALID_QUERY";

/** A fixed, redacted parser error suitable for mapping to the public 400 response. */
export class PublicEventListQueryError extends Error {
  readonly code: PublicEventListQueryErrorCode = "INVALID_QUERY";

  constructor() {
    super("The public event list query is invalid.");
    this.name = "PublicEventListQueryError";
  }
}

const supportedParameters = new Set([
  "cursor",
  "limit",
  "category",
  "lifecycle",
  "freshness",
  "from",
  "to",
  "q",
  "place_id",
]);

const categories: ReadonlySet<PublicEventListCategory> = new Set([
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
]);
const lifecycles: ReadonlySet<PublicEventListLifecycle> = new Set([
  "planned",
  "ongoing",
  "resolved",
  "cancelled",
  "unknown",
]);
const freshnessStatuses: ReadonlySet<PublicEventListFreshness> = new Set([
  "current",
  "needs_update",
  "expired",
]);
const decimalIntegerPattern = /^[0-9]+$/u;
const maxQueryLength = 120;
const maxPlaceIdLength = 128;

/**
 * Parses only the documented public event-list query vocabulary. Date-time
 * syntax/range and cursor authenticity remain owned by the accepted L4 services.
 */
export function parsePublicEventListQuery(search: URLSearchParams): PublicEventListQueryRequest {
  const seen = new Set<string>();
  for (const name of search.keys()) {
    if (!supportedParameters.has(name) || seen.has(name)) fail();
    seen.add(name);
  }

  const cursorToken = search.get("cursor");
  if (cursorToken !== null
    && (cursorToken.trim().length === 0 || cursorToken.length > PUBLIC_EVENT_LIST_CURSOR_TOKEN_MAX_LENGTH)) {
    fail();
  }

  const rawLimit = search.get("limit");
  let limit: number = PUBLIC_EVENT_LIST_PROJECTION_LIMITS.defaultPageSize;
  if (rawLimit !== null) {
    if (!decimalIntegerPattern.test(rawLimit)) fail();
    const parsedLimit = Number(rawLimit);
    if (!Number.isSafeInteger(parsedLimit)
      || parsedLimit < 1
      || parsedLimit > PUBLIC_EVENT_LIST_PROJECTION_LIMITS.maxPageSize) {
      fail();
    }
    limit = parsedLimit;
  }

  const filters: {
    category?: PublicEventListCategory;
    lifecycle?: PublicEventListLifecycle;
    freshness?: PublicEventListFreshness;
    from?: string;
    to?: string;
    q?: string;
    place_id?: string;
  } = {};

  const category = search.get("category");
  if (category !== null) {
    if (!categories.has(category as PublicEventListCategory)) fail();
    filters.category = category as PublicEventListCategory;
  }

  const lifecycle = search.get("lifecycle");
  if (lifecycle !== null) {
    if (!lifecycles.has(lifecycle as PublicEventListLifecycle)) fail();
    filters.lifecycle = lifecycle as PublicEventListLifecycle;
  }

  const freshness = search.get("freshness");
  if (freshness !== null) {
    if (!freshnessStatuses.has(freshness as PublicEventListFreshness)) fail();
    filters.freshness = freshness as PublicEventListFreshness;
  }

  const from = search.get("from");
  if (from !== null) filters.from = from;
  const to = search.get("to");
  if (to !== null) filters.to = to;

  const rawQuery = search.get("q");
  if (rawQuery !== null) {
    const query = rawQuery.trim();
    if (query.length > maxQueryLength) fail();
    if (query.length > 0) filters.q = query;
  }

  const rawPlaceId = search.get("place_id");
  if (rawPlaceId !== null) {
    const placeId = rawPlaceId.trim();
    if (placeId.length > maxPlaceIdLength) fail();
    if (placeId.length > 0) filters.place_id = placeId;
  }

  return { limit, cursorToken, filters };
}

function fail(): never {
  throw new PublicEventListQueryError();
}
