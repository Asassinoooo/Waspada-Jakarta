import type {
  Category,
  EventDetail,
  EventPage,
  HistoryEntry,
  HistoryPage,
  PublicClaim,
  PublicContext,
  PublicFeatureCollection,
  PublicGeometry,
  PublicImpact,
  EventView,
  Lifecycle,
  TimeScope,
} from "../../contracts/public-api.js";
import type { SourceStatusProvider } from "../l1-data-knowledge/source-status.js";
import type { EventProposalDto, StoredEvidenceChunk } from "./moderation-api.js";
import { aggregateEventFreshnessStatus } from "./freshness-aggregate-policy.js";
import { projectPublicFeatureCollection } from "./public-geometry-projection.js";
import { syntheticEventFixtures } from "./synthetic-fixtures.js";

const categories: Record<string, true> = {
  crime_personal_security: true,
  demonstrations_public_gatherings: true,
  crowds_major_events: true,
  violence_immediate_threats: true,
  disasters_weather: true,
  fires_infrastructure_hazards: true,
  transport_road_incidents: true,
  utilities_essential_services: true,
  health_environmental_advisories: true,
  group_specific_critical_notices: true,
};

const lifecycles: Record<string, true> = {
  planned: true,
  ongoing: true,
  resolved: true,
  cancelled: true,
  unknown: true,
};

const freshnessStatuses: Record<string, true> = {
  current: true,
  needs_update: true,
  expired: true,
};

const maximumPageSize = 100;
const maximumDateRangeMs = 90 * 24 * 60 * 60 * 1000;

export class QueryValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QueryValidationError";
  }
}

const sharedPublishedEvents: EventDetail[] = [];

export class PublicReadModel {
  private readonly instancePublishedEvents: EventDetail[] = [];

  constructor(
    private readonly sourceStatus: SourceStatusProvider,
    private readonly fixtures: readonly EventView[] = syntheticEventFixtures,
    initialPublishedEvents?: readonly (EventDetail | EventView | EventProposalDto)[],
  ) {
    if (initialPublishedEvents) {
      for (const item of initialPublishedEvents) {
        this.publish(item);
      }
    }
  }

  static getPublishedEvents(): readonly EventDetail[] {
    return sharedPublishedEvents;
  }

  static clearPublishedEvents(): void {
    sharedPublishedEvents.length = 0;
  }

  static publish(
    eventOrProposal: EventDetail | EventView | EventProposalDto | Record<string, unknown>,
    chunks?: readonly StoredEvidenceChunk[],
  ): EventDetail {
    const detail = isEventDetail(eventOrProposal)
      ? eventOrProposal
      : isEventProposalDto(eventOrProposal)
        ? proposalToEventDetail(eventOrProposal, chunks)
        : isEventView(eventOrProposal)
          ? eventViewToDetail(eventOrProposal)
          : rawInputToEventDetail(eventOrProposal, chunks);

    const existingIndex = sharedPublishedEvents.findIndex((e) => e.event_id === detail.event_id);
    if (existingIndex >= 0) {
      sharedPublishedEvents[existingIndex] = detail;
    } else {
      sharedPublishedEvents.push(detail);
    }
    return detail;
  }

  static addPublishedEvent(event: EventDetail | EventView): void {
    PublicReadModel.publish(event);
  }

  publish(
    eventOrProposal: EventDetail | EventView | EventProposalDto | Record<string, unknown>,
    chunks?: readonly StoredEvidenceChunk[],
  ): EventDetail {
    const detail = PublicReadModel.publish(eventOrProposal, chunks);
    const existingIndex = this.instancePublishedEvents.findIndex((e) => e.event_id === detail.event_id);
    if (existingIndex >= 0) {
      this.instancePublishedEvents[existingIndex] = detail;
    } else {
      this.instancePublishedEvents.push(detail);
    }
    return detail;
  }

  addPublishedEvent(event: EventDetail | EventView): void {
    this.publish(event);
  }

  getPublishedEvents(): readonly EventDetail[] {
    return this.instancePublishedEvents.length > 0 ? this.instancePublishedEvents : sharedPublishedEvents;
  }

  clearPublishedEvents(): void {
    this.instancePublishedEvents.length = 0;
    sharedPublishedEvents.length = 0;
  }

  context(datasetMode: "demo" | "live"): PublicContext {
    return {
      dataset_mode: datasetMode,
      dataset_label: datasetMode === "live" ? "live" : "synthetic",
      generated_at: new Date().toISOString(),
      sources: this.sourceStatus.listPublicSourceStatus(),
    };
  }

  events(search: URLSearchParams): EventPage {
    const limit = this.readInteger(search.get("limit"), 20, 1, maximumPageSize, "limit");
    const offset = this.readCursor(search.get("cursor"));
    const filters = this.readFilters(search);

    const matches = this.getActiveEvents().map(withAggregateFreshness).filter((event) => {
      if (filters.category && event.category !== filters.category) return false;
      if (filters.lifecycle && event.lifecycle !== filters.lifecycle) return false;
      if (filters.freshness && event.freshness.status !== filters.freshness) return false;
      if (filters.query && !this.searchText(event).includes(filters.query)) return false;
      if (filters.placeId && !event.scope.places.some((p) => p.toLocaleLowerCase("id") === filters.placeId.toLocaleLowerCase("id"))) {
        return false;
      }
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

  geoJSON(search?: URLSearchParams): PublicFeatureCollection {
    const activeEvents = this.getActiveEvents();
    let details = activeEvents.map((event) => this.toEventDetail(event));

    if (search) {
      const category = search.get("category");
      const lifecycle = search.get("lifecycle");
      const freshness = search.get("freshness");
      if (category || lifecycle || freshness) {
        details = details.filter((detail) => {
          if (category && detail.category !== category) return false;
          if (lifecycle && detail.lifecycle !== lifecycle) return false;
          if (freshness && detail.freshness.status !== freshness) return false;
          return true;
        });
      }
    }

    return projectPublicFeatureCollection(details);
  }

  detail(eventId: string): EventDetail | null {
    const published = this.findPublishedEvent(eventId);
    if (published) {
      const event = withAggregateFreshness(published);
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
        geometries: [...(event.geometries || [])],
      };
    }
    const fixture = this.findFixture(eventId);
    if (!fixture) return null;
    const event = withAggregateFreshness(fixture);

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

    const published = this.findPublishedEvent(eventId);
    if (published) {
      const versions: HistoryEntry[] = [
        {
          event_id: published.event_id,
          version: published.version,
          change_type: "published",
          changed_at: published.published_at,
          summary: "Laporan insiden dipublikasikan melalui verifikasi moderasi.",
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

  private getActiveEvents(): readonly (EventDetail | EventView)[] {
    if (this.instancePublishedEvents.length > 0) {
      return this.instancePublishedEvents;
    }
    if (this.fixtures === syntheticEventFixtures && sharedPublishedEvents.length > 0) {
      return sharedPublishedEvents;
    }
    return this.fixtures;
  }

  private getPublishedEventsList(): readonly EventDetail[] {
    return this.instancePublishedEvents.length > 0 ? this.instancePublishedEvents : sharedPublishedEvents;
  }

  private toEventDetail(event: EventView | EventDetail): EventDetail {
    const withFreshness = withAggregateFreshness(event);
    const geometries = hasPublicGeometries(event) ? [...event.geometries] : [];
    return {
      event_id: withFreshness.event_id,
      version: withFreshness.version,
      title: withFreshness.title,
      summary: withFreshness.summary,
      category: withFreshness.category,
      tags: withFreshness.tags,
      lifecycle: withFreshness.lifecycle,
      freshness: withFreshness.freshness,
      event_time: withFreshness.event_time,
      validity: withFreshness.validity,
      scope: withFreshness.scope,
      claims: withFreshness.claims,
      impacts: withFreshness.impacts,
      published_at: withFreshness.published_at,
      geometries,
    };
  }

  private findFixture(eventId: string) {
    return this.fixtures.find((event) => event.event_id === eventId) ?? null;
  }

  private findPublishedEvent(eventId: string): EventDetail | null {
    const list = this.getPublishedEventsList();
    return (
      list.find(
        (event) =>
          event.event_id === eventId ||
          event.event_id === `event-${eventId}` ||
          `event-${event.event_id}` === eventId ||
          event.tags.some((tag) => tag.value === eventId),
      ) ?? null
    );
  }

  private readFilters(search: URLSearchParams) {
    const category = search.get("category");
    if (category !== null && !categories[category]) {
      throw new QueryValidationError("category is not supported");
    }

    const lifecycle = search.get("lifecycle");
    if (lifecycle !== null && !lifecycles[lifecycle]) {
      throw new QueryValidationError("lifecycle is not supported");
    }

    const freshness = search.get("freshness");
    if (freshness !== null && !freshnessStatuses[freshness]) {
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

  private searchText(event: EventView) {
    return [
      event.title,
      event.summary,
      event.category,
      ...event.scope.places,
      ...event.scope.services,
      ...event.scope.institutions,
      ...event.scope.audiences,
      ...event.tags.map((t) => t.value),
      ...event.claims.map((c) => c.text),
      ...event.impacts.map((i) => `${i.title} ${i.description}`),
    ]
      .join(" ")
      .toLocaleLowerCase("id");
  }
}

function withAggregateFreshness<T extends EventView>(event: T): T {
  return {
    ...event,
    freshness: {
      ...event.freshness,
      status: aggregateEventFreshnessStatus({
        claimSetStatus: event.freshness.status,
        impactStatuses: event.impacts.map((impact) => impact.freshness.status),
      }),
    },
  };
}

function sanitizeEventId(id: string): string {
  const sanitized = id.replace(/[^A-Za-z0-9._:-]/g, "-").slice(0, 128);
  if (/^[A-Za-z0-9]/.test(sanitized)) return sanitized;
  return `evt-${sanitized}`.slice(0, 128);
}

function mapIncidentTypeToCategory(type: string): Category {
  switch (type) {
    case "flood":
    case "weather":
      return "disasters_weather";
    case "fire":
      return "fires_infrastructure_hazards";
    case "accident":
      return "transport_road_incidents";
    case "tree_fall":
      return "fires_infrastructure_hazards";
    case "crime":
      return "crime_personal_security";
    default:
      if (categories[type]) {
        return type as Category;
      }
      return "disasters_weather";
  }
}

function isEventDetail(value: unknown): value is EventDetail {
  if (typeof value !== "object" || value === null) return false;
  return (
    "event_id" in value &&
    "title" in value &&
    "category" in value &&
    "geometries" in value &&
    Array.isArray(value.geometries)
  );
}

function isEventProposalDto(value: unknown): value is EventProposalDto {
  if (typeof value !== "object" || value === null) return false;
  return (
    "proposal_id" in value &&
    ("incident_type" in value || "claims" in value || ("schema_version" in value && value.schema_version === "2.0"))
  );
}

function isEventView(value: unknown): value is EventView {
  if (typeof value !== "object" || value === null) return false;
  return (
    "event_id" in value &&
    "title" in value &&
    "category" in value &&
    "lifecycle" in value &&
    "freshness" in value
  );
}

function hasPublicGeometries(event: EventView | EventDetail): event is EventDetail {
  return "geometries" in event && Array.isArray(event.geometries);
}

function eventViewToDetail(event: EventView): EventDetail {
  return {
    ...event,
    geometries: hasPublicGeometries(event) ? [...event.geometries] : [],
  };
}

export function proposalToEventDetail(
  proposal: EventProposalDto,
  _chunks?: readonly StoredEvidenceChunk[],
): EventDetail {
  const eventId = sanitizeEventId(proposal.proposal_id);
  const category = mapIncidentTypeToCategory(proposal.incident_type);
  const title = proposal.title ? proposal.title.slice(0, 240) : `Insiden ${category}`;

  const summary = proposal.claims && proposal.claims.length > 0
    ? proposal.claims.map((c) => c.claim_text).join(". ").slice(0, 500)
    : title;

  let eventStart: string | null = null;
  let precision: TimeScope["precision"] = "unknown";
  if (proposal.event_time) {
    precision = proposal.event_time.precision || "exact";
    if (proposal.event_time.value) {
      const parsed = Date.parse(proposal.event_time.value);
      if (!Number.isNaN(parsed)) {
        eventStart = new Date(parsed).toISOString();
      } else {
        eventStart = proposal.event_time.value;
      }
    }
  }
  if (!eventStart && proposal.proposed_at) {
    eventStart = proposal.proposed_at;
    precision = "exact";
  }

  const places: string[] = [];
  if (proposal.location_label && proposal.location_label.trim().length > 0) {
    places.push(proposal.location_label.trim());
  }

  const geometries: PublicGeometry[] = [];
  if (
    proposal.coordinates &&
    Array.isArray(proposal.coordinates) &&
    proposal.coordinates.length === 2
  ) {
    const lng = Number(proposal.coordinates[0]);
    const lat = Number(proposal.coordinates[1]);
    if (
      Number.isFinite(lng) &&
      Number.isFinite(lat) &&
      lng >= -180 &&
      lng <= 180 &&
      lat >= -90 &&
      lat <= 90
    ) {
      geometries.push({
        geometry_id: sanitizeEventId(`${eventId}-geom-1`),
        role: "incident_scene",
        geometry: {
          type: "Point",
          coordinates: [lng, lat],
        },
        precision_m: 50,
        label: proposal.location_label ? proposal.location_label.slice(0, 200) : "Lokasi Kejadian",
      });
    }
  }

  const publishedAt = proposal.proposed_at || new Date().toISOString();

  const claims: PublicClaim[] = (proposal.claims || []).map((claim, index) => ({
    claim_id: sanitizeEventId(claim.claim_id || `${eventId}-claim-${index + 1}`),
    text: claim.claim_text || claim.quote_text || "Klaim laporan terverifikasi",
    event_time: {
      start: eventStart,
      end: null,
      precision: "exact",
    },
    validity: { valid_from: null, valid_until: null },
    scope: { places: [...places], services: [], institutions: [], audiences: [] },
    qualifiers: [],
    evidence_label: "attributed_report",
    sources: [
      {
        display_name: "Laporan Terverifikasi",
        url: "https://waspada.jakarta.go.id",
        published_at: proposal.proposed_at || null,
        observed_at: null,
        excerpt: claim.quote_text || null,
      },
    ],
  }));

  return {
    event_id: eventId,
    version: 1,
    title,
    summary,
    category,
    tags: [
      { namespace: "topic", value: proposal.incident_type || "incident" },
      { namespace: "hazard", value: proposal.severity || "general" },
    ],
    lifecycle: "ongoing",
    freshness: {
      status: "current",
      evaluated_at: publishedAt,
      review_due_at: null,
      basis: "fast_observation_review",
    },
    event_time: {
      start: eventStart,
      end: null,
      precision,
    },
    validity: {
      valid_from: eventStart || publishedAt,
      valid_until: null,
    },
    scope: {
      places,
      services: [],
      institutions: [],
      audiences: [],
    },
    claims,
    impacts: [],
    published_at: publishedAt,
    geometries,
  };
}

function rawInputToEventDetail(
  input: Record<string, unknown>,
  _chunks?: readonly StoredEvidenceChunk[],
): EventDetail {
  const id = String(input.proposal_id ?? input.proposalId ?? input.event_id ?? input.eventId ?? `evt-${Date.now()}`);
  const eventId = sanitizeEventId(id);
  const title = typeof input.title === "string" ? input.title.slice(0, 240) : `Laporan Kejadian ${eventId}`;
  const rawCat = typeof input.category === "string" ? input.category : typeof input.incident_type === "string" ? input.incident_type : "disasters_weather";
  const category = mapIncidentTypeToCategory(rawCat);

  const places: string[] = [];
  if (typeof input.location_label === "string" && input.location_label.trim().length > 0) {
    places.push(input.location_label.trim());
  }

  const geometries: PublicGeometry[] = [];
  if (Array.isArray(input.coordinates) && input.coordinates.length === 2) {
    const lng = Number(input.coordinates[0]);
    const lat = Number(input.coordinates[1]);
    if (Number.isFinite(lng) && Number.isFinite(lat) && lng >= -180 && lng <= 180 && lat >= -90 && lat <= 90) {
      geometries.push({
        geometry_id: sanitizeEventId(`${eventId}-geom-1`),
        role: "incident_scene",
        geometry: {
          type: "Point",
          coordinates: [lng, lat],
        },
        precision_m: 50,
        label: places[0] ? places[0].slice(0, 200) : "Lokasi Kejadian",
      });
    }
  } else if (Array.isArray(input.geometries)) {
    geometries.push(...(input.geometries as PublicGeometry[]));
  }

  const publishedAt = typeof input.published_at === "string"
    ? input.published_at
    : typeof input.proposed_at === "string"
      ? input.proposed_at
      : new Date().toISOString();

  return {
    event_id: eventId,
    version: typeof input.version === "number" ? input.version : 1,
    title,
    summary: typeof input.summary === "string" ? input.summary : title,
    category,
    tags: [
      { namespace: "topic", value: String(input.incident_type || category) },
      { namespace: "hazard", value: String(input.severity || "general") },
    ],
    lifecycle: typeof input.lifecycle === "string" && lifecycles[input.lifecycle]
      ? (input.lifecycle as Lifecycle)
      : "ongoing",
    freshness: {
      status: "current",
      evaluated_at: publishedAt,
      review_due_at: null,
      basis: "fast_observation_review",
    },
    event_time: {
      start: publishedAt,
      end: null,
      precision: "exact",
    },
    validity: {
      valid_from: publishedAt,
      valid_until: null,
    },
    scope: {
      places,
      services: [],
      institutions: [],
      audiences: [],
    },
    claims: Array.isArray(input.claims) ? (input.claims as PublicClaim[]) : [],
    impacts: Array.isArray(input.impacts) ? (input.impacts as PublicImpact[]) : [],
    published_at: publishedAt,
    geometries,
  };
}
