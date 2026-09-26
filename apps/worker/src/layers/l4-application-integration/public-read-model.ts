import type {
  EventDetail,
  EventPage,
  HistoryEntry,
  HistoryPage,
  PublicContext,
  PublicFeatureCollection,
} from "../../contracts/public-api.js";
import type { SourceStatusProvider } from "../l1-data-knowledge/source-status.js";
import { projectPublicFeatureCollection } from "./public-geometry-projection.js";
import { syntheticEventFixtures } from "./synthetic-fixtures.js";

const categories = new Set([
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

const lifecycles = new Set(["planned", "ongoing", "resolved", "cancelled", "unknown"]);
const freshnessStatuses = new Set(["current", "needs_update", "expired"]);
const maximumPageSize = 100;
const maximumDateRangeMs = 90 * 24 * 60 * 60 * 1000;

export class QueryValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QueryValidationError";
  }
}

export class PublicReadModel {
  constructor(
    private readonly sourceStatus: SourceStatusProvider,
    private readonly fixtures = syntheticEventFixtures,
  ) {}

  context(datasetMode: "demo"): PublicContext {
    return {
      dataset_mode: datasetMode,
      dataset_label: "synthetic",
      generated_at: new Date().toISOString(),
      sources: this.sourceStatus.listPublicSourceStatus(),
    };
  }

  events(search: URLSearchParams): EventPage {
    const limit = this.readInteger(search.get("limit"), 20, 1, maximumPageSize, "limit");
    const offset = this.readCursor(search.get("cursor"));
    const filters = this.readFilters(search);

    const matches = this.fixtures.filter((event) => {
      if (filters.category && event.category !== filters.category) return false;
      if (filters.lifecycle && event.lifecycle !== filters.lifecycle) return false;
      if (filters.freshness && event.freshness.status !== filters.freshness) return false;
      if (filters.query && !this.searchText(event).includes(filters.query)) return false;
      if (filters.placeId) return false;
      if (filters.from !== null || filters.to !== null) {
        const eventStart = event.event_time.start ? Date.parse(event.event_time.start) : Number.NaN;
        if (!Number.isFinite(eventStart)) return false;
        if (filters.from !== null && eventStart < filters.from) return false;
        if (filters.to !== null && eventStart > filters.to) return false;
      }
      return true;
    });

    const data = matches.slice(offset, offset + limit);
    const nextOffset = offset + data.length;
    const hasMore = nextOffset < matches.length;
    const cursorExpiry = hasMore ? new Date(Date.now() + 15 * 60 * 1000).toISOString() : null;

    return {
      data,
      page: {
        next_cursor: hasMore ? String(nextOffset) : null,
        cursor_expires_at: cursorExpiry,
      },
    };
  }

  geoJSON(): PublicFeatureCollection {
    // The current synthetic fixtures contain no source-supported geometry.
    return projectPublicFeatureCollection([]);
  }

  detail(eventId: string): EventDetail | null {
    const event = this.findFixture(eventId);
    if (!event) return null;

    return {
      event_id: event.event_id,
      version: event.version,
      title: event.title,
      summary: event.summary,
      category: event.category,
      tags: event.tags,
      lifecycle: event.lifecycle,
      freshness: event.freshness,
      event_time: event.event_time,
      validity: event.validity,
      scope: event.scope,
      claims: event.claims,
      impacts: event.impacts,
      published_at: event.published_at,
      geometries: [],
    };
  }

  history(eventId: string, search: URLSearchParams): HistoryPage | null {
    const limit = this.readInteger(search.get("limit"), 20, 1, maximumPageSize, "limit");
    const offset = this.readCursor(search.get("cursor"));
    const event = this.findFixture(eventId);
    if (!event) return null;

    const versions: HistoryEntry[] = [
      {
        event_id: event.event_id,
        version: event.version,
        change_type: "published",
        changed_at: event.published_at,
        summary: "Versi contoh sintetis dimuat untuk demonstrasi antarmuka.",
      },
    ];
    const data = versions.slice(offset, offset + limit);
    const nextOffset = offset + data.length;
    const hasMore = nextOffset < versions.length;

    return {
      data,
      page: {
        next_cursor: hasMore ? String(nextOffset) : null,
        cursor_expires_at: hasMore ? new Date(Date.now() + 15 * 60 * 1000).toISOString() : null,
      },
    };
  }

  private findFixture(eventId: string) {
    return this.fixtures.find((event) => event.event_id === eventId) ?? null;
  }

  private readFilters(search: URLSearchParams) {
    const category = search.get("category");
    if (category !== null && !categories.has(category)) {
      throw new QueryValidationError("category is not supported");
    }

    const lifecycle = search.get("lifecycle");
    if (lifecycle !== null && !lifecycles.has(lifecycle)) {
      throw new QueryValidationError("lifecycle is not supported");
    }

    const freshness = search.get("freshness");
    if (freshness !== null && !freshnessStatuses.has(freshness)) {
      throw new QueryValidationError("freshness is not supported");
    }

    const query = search.get("q")?.trim() ?? "";
    if (query.length > 120) throw new QueryValidationError("q must be at most 120 characters");

    const placeId = search.get("place_id")?.trim() ?? "";
    if (placeId.length > 128) {
      throw new QueryValidationError("place_id must be at most 128 characters");
    }

    const from = this.readDate(search.get("from"), "from");
    const to = this.readDate(search.get("to"), "to");
    if (from !== null && to !== null && to < from) {
      throw new QueryValidationError("to must not precede from");
    }
    if (from !== null && to !== null && to - from > maximumDateRangeMs) {
      throw new QueryValidationError("date ranges must not exceed 90 days");
    }

    return {
      category,
      lifecycle,
      freshness,
      query: query.toLocaleLowerCase("id"),
      placeId,
      from,
      to,
    } as const;
  }

  private readInteger(value: string | null, fallback: number, min: number, max: number, name: string) {
    if (value === null) return fallback;
    if (!/^(0|[1-9]\d*)$/.test(value)) throw new QueryValidationError(`${name} must be an integer`);
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
      throw new QueryValidationError(`${name} must be between ${min} and ${max}`);
    }
    return parsed;
  }

  private readCursor(value: string | null) {
    if (value === null) return 0;
    if (value.length > 2048 || !/^(0|[1-9]\d*)$/.test(value)) {
      throw new QueryValidationError("cursor is invalid");
    }
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed)) throw new QueryValidationError("cursor is invalid");
    return parsed;
  }

  private readDate(value: string | null, name: string) {
    if (value === null) return null;
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
      throw new QueryValidationError(`${name} must be an RFC 3339 date-time`);
    }
    const parsed = Date.parse(value);
    if (!Number.isFinite(parsed)) throw new QueryValidationError(`${name} must be a date-time`);
    return parsed;
  }

  private searchText(event: (typeof syntheticEventFixtures)[number]) {
    return [
      event.title,
      event.summary,
      event.category,
      ...event.scope.places,
      ...event.scope.services,
      ...event.scope.institutions,
      ...event.scope.audiences,
    ]
      .join(" ")
      .toLocaleLowerCase("id");
  }
}
