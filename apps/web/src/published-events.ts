/*
 * Published public events for the map home (UI-V2-B). One hook reads the list
 * (/api/v1/events) and the geometry (/api/v1/events.geojson). Everything else
 * here is pure: filters, labels and marker selection. Nothing is invented: a
 * missing event time reads UNKNOWN_EVENT_TIME_TEXT, and a count is a count of distinct
 * named outlets (syndicated copies are labelled, not counted), never a verification.
 */
import { useEffect, useState } from "react";
import type {
  Category,
  EventDetail,
  EventView,
  FreshnessStatus,
  HistoryPage,
  Lifecycle,
  PublicFeatureCollection,
} from "@waspada/worker/public-contracts";
import {
  apiReadFailure,
  getEventDetail,
  getEventGeoJSON,
  getEventHistory,
  listAllEvents,
  PartialEventListError,
  type ApiReadState,
} from "./api-client.js";
import { categoryLabel, formatInstant } from "./display.js";

/** The event time helper lives in display.ts (no import cycle); published pages use it from here. */
export { eventTimeText, UNKNOWN_EVENT_TIME_TEXT } from "./display.js";

export type MapCoordinate = readonly [longitude: number, latitude: number];

/** A point marker the API returned for an event. The role is kept so an approximate place can say so. */
export interface PublishedMarker {
  readonly coordinate: MapCoordinate;
  readonly role: string;
}

export type EventTimeRange = "all" | "24h" | "7d" | "30d";
export type EvidenceKind = "issuer_notice" | "attributed_report" | "independent_corroboration" | "crowdsourced_observation";

/**
 * MAP-RECENT-01: the window on the publication time of the event's current public version. An update publishes a new
 * version, so "24h" keeps events first published or updated in the last 24 hours. It is not the event time.
 */
export type PublicationRecency = "24h" | "all";

export interface PublishedFilters {
  category: Category | "all";
  timeRange: EventTimeRange;
  recency: PublicationRecency;
  source: EvidenceKind | "all";
}

export const DEFAULT_PUBLISHED_FILTERS: PublishedFilters = { category: "all", timeRange: "all", source: "all", recency: "all" };

export const RECENCY_OPTIONS: readonly { value: PublicationRecency; label: string }[] = [
  { value: "24h", label: "24 jam terakhir" },
  { value: "all", label: "Kapan saja" },
];

export const RECENT_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * True when the current public version was published (first publication or an update) within 24 hours of nowMs. A
 * publication time after nowMs (a version that arrived after the page opened, or clock skew) counts as recent. An
 * unreadable time is not recent.
 */
export function publishedRecently(event: Pick<EventView, "published_at">, nowMs: number): boolean {
  const publishedMs = Date.parse(event.published_at ?? "");
  if (Number.isNaN(publishedMs)) return false;
  return nowMs - publishedMs <= RECENT_WINDOW_MS;
}

export const FILTER_CATEGORIES: readonly Category[] = [
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

export const TIME_RANGE_OPTIONS: readonly { value: EventTimeRange; label: string }[] = [
  { value: "all", label: "Semua waktu" },
  { value: "24h", label: "24 jam terakhir" },
  { value: "7d", label: "7 hari terakhir" },
  { value: "30d", label: "30 hari terakhir" },
];

export const SOURCE_OPTIONS: readonly { value: EvidenceKind; label: string }[] = [
  { value: "issuer_notice", label: "Pemberitahuan penerbit" },
  { value: "attributed_report", label: "Laporan teratribusi" },
  { value: "crowdsourced_observation", label: "Laporan warga" },
  { value: "independent_corroboration", label: "Didukung laporan independen" },
];

const TIME_WINDOW_MS: Record<Exclude<EventTimeRange, "all">, number> = {
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
};

/**
 * Number of filter groups that differ from the default, plus facilities when they are shown. The publication window
 * (recency) is not counted: the map shows it on its own toggle and in the list.
 */
export function countActiveFilters(filters: PublishedFilters, facilitiesOn: boolean): number {
  return (filters.category === "all" ? 0 : 1)
    + (filters.timeRange === "all" ? 0 : 1)
    + (filters.source === "all" ? 0 : 1)
    + (facilitiesOn ? 1 : 0);
}

/** True when the event has a known event time. Unknown times are never guessed. */
export function eventHasTime(event: EventView): boolean {
  return event.event_time.precision !== "unknown" && typeof event.event_time.start === "string" && event.event_time.start.length > 0;
}

function withinTimeRange(event: EventView, range: EventTimeRange, nowMs: number): boolean {
  if (range === "all") return true;
  // A range looks back from now on the event time. Events without a known time only match "all".
  if (!eventHasTime(event)) return false;
  const start = Date.parse(event.event_time.start ?? "");
  if (Number.isNaN(start)) return false;
  return start <= nowMs && nowMs - start <= TIME_WINDOW_MS[range];
}

function searchableText(event: EventView): string {
  const parts = [event.title, event.summary, ...event.scope.places, ...event.claims.map((claim) => claim.text)];
  return parts.join(" ").toLocaleLowerCase("id");
}

/** Filters the loaded list. Search, category, time range, source and publication window all combine with AND. */
export function filterPublishedEvents(
  events: readonly EventView[],
  query: string,
  filters: PublishedFilters,
  nowMs: number,
): EventView[] {
  const search = query.trim().toLocaleLowerCase("id");
  return events.filter((event) =>
    (filters.category === "all" || event.category === filters.category)
    && withinTimeRange(event, filters.timeRange, nowMs)
    && (filters.recency === "all" || publishedRecently(event, nowMs))
    && (filters.source === "all" || event.claims.some((claim) => claim.evidence_label === filters.source))
    && (search.length === 0 || searchableText(event).includes(search))
  );
}

/**
 * Every distinct, named outlet across the event's claims, syndicated copies included, for display. It is not the
 * number shown on a card: countIndependentSources gives that number.
 */
export function sourceNamesOf(event: EventView): string[] {
  const names = new Set<string>();
  for (const claim of event.claims) {
    for (const source of claim.sources) {
      const name = typeof source.display_name === "string" ? source.display_name.trim() : "";
      if (name.length > 0) names.add(name);
    }
  }
  return [...names];
}

/** The claim text the read model uses when a claim has neither claim_text nor quote_text. It is a placeholder, never a title. */
const UNTITLED_CLAIM_TEXT = "Klaim laporan";

/** Normalised title for copy matching: lowercase, punctuation as spaces, whitespace collapsed. Empty when there is no usable title. */
function normalisedTitle(text: unknown): string {
  if (typeof text !== "string" || text.trim() === UNTITLED_CLAIM_TEXT) return "";
  return text.toLocaleLowerCase("id").replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/gu, " ").trim();
}

/**
 * Splits the event's named outlets into outlets and copies, and the two always add up to sourceNamesOf(event).length.
 * Two claims from different outlets carry the same report when their normalised titles are equal. The public DTO has
 * no article title, so the claim text stands in for one. Outlets are visited most-distinct-titles first, then by name,
 * so claims[] order does not change the result. An outlet is a copy when each of its claims repeats a title that an
 * earlier outlet already carried. An outlet with an untitled claim is never a copy. Copies are labelled, never counted.
 */
export function countIndependentSources(event: EventView): { outlets: number; copies: number } {
  const byOutlet = new Map<string, { titles: Set<string>; untitled: boolean }>();
  for (const claim of event.claims) {
    const title = normalisedTitle(claim.text);
    for (const source of claim.sources) {
      const name = typeof source.display_name === "string" ? source.display_name.trim() : "";
      if (name.length === 0) continue;
      const entry = byOutlet.get(name) ?? { titles: new Set<string>(), untitled: false };
      if (title.length === 0) entry.untitled = true;
      else entry.titles.add(title);
      byOutlet.set(name, entry);
    }
  }
  const ordered = [...byOutlet.entries()].sort(([nameA, a], [nameB, b]) => {
    if (a.titles.size !== b.titles.size) return b.titles.size - a.titles.size;
    return nameA < nameB ? -1 : nameA > nameB ? 1 : 0;
  });
  const covered = new Set<string>();
  let outlets = 0;
  for (const [, entry] of ordered) {
    const copy = !entry.untitled && entry.titles.size > 0 && [...entry.titles].every((title) => covered.has(title));
    if (copy) continue;
    outlets += 1;
    for (const title of entry.titles) covered.add(title);
  }
  return { outlets, copies: ordered.length - outlets };
}

/** "N sumber" counts outlets only. Copies add a short note and are never added to the number. */
export function sourceCountText(outlets: number, copies = 0): string {
  if (outlets === 0) return "Sumber tidak tercatat";
  return copies > 0 ? `${outlets} sumber (${copies} salinan)` : `${outlets} sumber`;
}

/** Markers come only from API geometry. A Point feature wins over other roles, and the first one per event is kept. */
export function markersFromGeoJSON(collection: PublicFeatureCollection): Map<string, PublishedMarker> {
  const best = new Map<string, { rank: number; marker: PublishedMarker }>();
  for (const feature of collection.features) {
    if (feature.geometry.type !== "Point") continue;
    const [longitude, latitude] = feature.geometry.coordinates;
    if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) continue;
    const role = feature.properties.geometry_role;
    const rank = role === "incident_scene" ? 0 : 1;
    const current = best.get(feature.properties.event_id);
    if (current === undefined || rank < current.rank) {
      best.set(feature.properties.event_id, { rank, marker: { coordinate: [longitude, latitude], role } });
    }
  }
  return new Map([...best].map(([eventId, entry]) => [eventId, entry.marker]));
}

/** Event for a deep link, with its marker when the API returned one. Null when the event is not published. */
export function deepLinkTarget(
  events: readonly EventView[],
  markers: ReadonlyMap<string, PublishedMarker>,
  eventId: string,
): { event: EventView; marker: PublishedMarker | null } | null {
  const event = events.find((candidate) => candidate.event_id === eventId);
  if (!event) return null;
  return { event, marker: markers.get(eventId) ?? null };
}

/**
 * HOSTED-21: the source's own publish time, shown separately when the event has no event time. It is the earliest
 * publish time the claim sources give. It is never the event's publication time or a processing time. Null when no
 * source gives one.
 */
export function sourcePublishedAtText(event: EventView): string | null {
  return earliestSourceTimeText(event, "published_at");
}

/**
 * POLISH-02: the source collection time (waktu pengambilan sumber), the earliest one the claim sources give. It is never
 * the event time, the publication time or a processing time. Null when no source gives one, so the detail keeps its
 * "Tidak disebutkan" wording.
 */
export function sourceRetrievedAtText(event: EventView): string | null {
  return earliestSourceTimeText(event, "retrieved_at");
}

function earliestSourceTimeText(event: EventView, field: "published_at" | "retrieved_at"): string | null {
  let earliestMs: number | null = null;
  let earliest: string | null = null;
  for (const claim of event.claims) {
    for (const source of claim.sources) {
      const value = source[field];
      if (typeof value !== "string" || value.length === 0) continue;
      const ms = Date.parse(value);
      if (Number.isNaN(ms)) continue;
      if (earliestMs === null || ms < earliestMs) {
        earliestMs = ms;
        earliest = value;
      }
    }
  }
  return earliest === null ? null : formatInstant(earliest);
}

/** The fields that make two attribution entries one source. */
export interface ClaimSourceEntry {
  readonly display_name: string;
  readonly url: string;
  readonly published_at: string | null;
  readonly excerpt: string | null;
}

/** One source line for a claim, after repeated attributions of the same source are merged. */
export interface ClaimSourceLine<T extends ClaimSourceEntry> {
  /** The first occurrence. Its name, URL, times and position give the line. */
  readonly source: T;
  /** Every distinct excerpt of this source, in order. Empty when no occurrence carries one. */
  readonly excerpts: readonly string[];
}

/**
 * HOSTED-24A: the API writes one attribution per evidence item, so two quotes from the same article repeat the same
 * source line. Entries with the same display name, URL and source publish time are one source. The first occurrence
 * keeps its place in the order. Its different excerpts are kept, so no quoted text is dropped. Display only: the API
 * data is not changed.
 */
export function collapseClaimSources<T extends ClaimSourceEntry>(sources: readonly T[]): ClaimSourceLine<T>[] {
  const lines: { source: T; excerpts: string[] }[] = [];
  const indexByKey = new Map<string, number>();
  for (const source of sources) {
    const key = JSON.stringify([source.display_name, source.url, source.published_at ?? null]);
    const index = indexByKey.get(key);
    if (index === undefined) {
      indexByKey.set(key, lines.length);
      lines.push({ source, excerpts: source.excerpt ? [source.excerpt] : [] });
      continue;
    }
    const line = lines[index]!;
    if (source.excerpt && !line.excerpts.includes(source.excerpt)) line.excerpts.push(source.excerpt);
  }
  return lines;
}

/** Publication time (diterbitkan) for this public version. */
export function publishedAtText(event: EventView): string {
  return event.published_at ? formatInstant(event.published_at) : "Tidak diketahui";
}

/** HOSTED-26: the location named in the report itself, marked as approximate. It is not a verified place. */
export const LOCATION_LABEL_NOTE = " (perkiraan dari laporan)";

export function areaText(event: EventView): string {
  const places = event.scope.places.filter((place) => place.trim().length > 0);
  if (places.length > 0) return places.slice(0, 2).join(", ");
  const label = typeof event.location_label === "string" ? event.location_label.trim() : "";
  return label.length > 0 ? label + LOCATION_LABEL_NOTE : "Lokasi tidak tercatat";
}

export function categoryText(category: string): string {
  return categoryLabel(category);
}

export function categoryMarkerIcon(category: string): string {
  switch (category) {
    case "crime_personal_security": return "🚨";
    case "demonstrations_public_gatherings": return "📣";
    case "crowds_major_events": return "👥";
    case "violence_immediate_threats": return "⚠️";
    case "disasters_weather": return "🌊";
    case "fires_infrastructure_hazards": return "🔥";
    case "transport_road_incidents": return "🚗";
    case "utilities_essential_services": return "⚡";
    case "health_environmental_advisories": return "🩺";
    case "group_specific_critical_notices": return "📢";
    default: return "📍";
  }
}

/** SEV-01: the public estimate of impact. Only the three API values count; anything else is not assessed. */
export type PublicSeverity = "low" | "medium" | "high";
export const SEVERITY_LEVELS: readonly PublicSeverity[] = ["low", "medium", "high"];
/** Shown with every severity, so the estimate is never read as a safety claim. */
export const SEVERITY_NOTE = "Perkiraan otomatis dari laporan; bukan jaminan keamanan.";

export function severityOf(event: Pick<EventView, "severity">): PublicSeverity | null {
  const value: unknown = event.severity;
  return value === "low" || value === "medium" || value === "high" ? value : null;
}

export function severityLabel(level: PublicSeverity): string {
  switch (level) {
    case "low": return "Rendah";
    case "medium": return "Sedang";
    case "high": return "Tinggi";
  }
}

/** Screen-reader suffix for a marker, so the size is also said in words. Empty when not assessed. */
export function severityAriaSuffix(level: PublicSeverity | null): string {
  return level === null ? "" : `, tingkat dampak ${severityLabel(level)}`;
}

/** Freshness chip text. "Lewat masa berlaku" is set only by the issuer's validity window. */
export function freshnessText(status: FreshnessStatus): string {
  switch (status) {
    case "current": return "Dalam batas tinjau";
    case "needs_update": return "Perlu diperbarui";
    case "expired": return "Lewat masa berlaku sumber";
  }
}

export function lifecycleText(lifecycle: Lifecycle): string {
  switch (lifecycle) {
    case "planned": return "Direncanakan";
    case "ongoing": return "Berlangsung";
    case "resolved": return "Selesai";
    case "cancelled": return "Dibatalkan";
    case "unknown": return "Status belum diketahui";
  }
}

/**
 * How a version was published. Null when the list does not say, so no path is claimed. Pass the outlet count from
 * countIndependentSources as source_count and its copies as `copies`, so the detail page counts like the card does (F-09).
 */
export function publicationPathText(
  publication: { readonly mode: "agent_auto" | "moderator_reviewed"; readonly source_count: number } | undefined,
  copies = 0,
): string | null {
  if (!publication) return null;
  const copyNote = copies > 0 ? ` (${copies} salinan)` : "";
  const reach = ` · dilaporkan oleh ${publication.source_count} media${copyNote}`;
  return publication.mode === "moderator_reviewed"
    ? `Ditinjau moderator${reach}`
    : `Diringkas otomatis oleh agen AI${reach}`;
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export type PublishedEventsStatus = "loading" | "loaded" | "unavailable";

export interface PublishedEventsSnapshot {
  status: PublishedEventsStatus;
  events: EventView[];
  markers: ReadonlyMap<string, PublishedMarker>;
  /** The list loaded, but the geometry did not. The list stays usable without markers. */
  markersUnavailable: boolean;
  errorMessage: string | null;
  reload: () => void;
}

interface SeedState {
  events: readonly EventView[];
  markers: ReadonlyMap<string, PublishedMarker>;
}

const NO_MARKERS: ReadonlyMap<string, PublishedMarker> = new Map();

/**
 * Reads published events once, and again on reload. The public API only: never the moderation queue.
 * A seed skips the network (used by tests and fixtures).
 */
export function usePublishedEvents(seed?: SeedState): PublishedEventsSnapshot {
  const [reloadKey, setReloadKey] = useState(0);
  const [state, setState] = useState<Omit<PublishedEventsSnapshot, "reload">>({
    status: "loading",
    events: [],
    markers: NO_MARKERS,
    markersUnavailable: false,
    errorMessage: null,
  });

  useEffect(() => {
    if (seed) return;
    let cancelled = false;
    setState((previous) => ({ ...previous, status: "loading", errorMessage: null }));
    Promise.allSettled([listAllEvents(), getEventGeoJSON()]).then(([listResult, geoResult]) => {
      if (cancelled) return;
      if (listResult.status === "rejected") {
        // A later page that failed keeps the events of the pages that loaded, under the same error status as a failed load.
        setState({
          status: "unavailable",
          events: listResult.reason instanceof PartialEventListError ? [...listResult.reason.events] : [],
          markers: geoResult.status === "fulfilled" ? markersFromGeoJSON(geoResult.value) : NO_MARKERS,
          markersUnavailable: false,
          errorMessage: `Gagal memuat laporan publik: ${errorText(listResult.reason)}`,
        });
        return;
      }
      setState({
        status: "loaded",
        events: listResult.value,
        markers: geoResult.status === "fulfilled" ? markersFromGeoJSON(geoResult.value) : NO_MARKERS,
        markersUnavailable: geoResult.status === "rejected",
        errorMessage: null,
      });
    });
    return () => {
      cancelled = true;
    };
  }, [seed, reloadKey]);

  const reload = () => setReloadKey((current) => current + 1);
  if (seed) {
    return {
      status: "loaded",
      events: [...seed.events],
      markers: seed.markers,
      markersUnavailable: false,
      errorMessage: null,
      reload,
    };
  }
  return { ...state, reload };
}

export interface PublicEventDetailReads {
  detail: ApiReadState<EventDetail> | null;
  history: ApiReadState<HistoryPage> | null;
  retryDetail: () => void;
  retryHistory: () => void;
}

/** Detail and history for the detail sheet. Reads only the public event endpoints. */
export function usePublicEventDetail(eventId: string | null): PublicEventDetailReads {
  const [detailRetry, setDetailRetry] = useState(0);
  const [historyRetry, setHistoryRetry] = useState(0);
  const [detailState, setDetailState] = useState<ApiReadState<EventDetail> | null>(null);
  const [historyState, setHistoryState] = useState<ApiReadState<HistoryPage> | null>(null);

  useEffect(() => {
    if (eventId === null) return;
    let cancelled = false;
    setDetailState({ eventId, status: "loading" });
    getEventDetail(eventId)
      .then((data) => {
        if (!cancelled) setDetailState({ eventId, status: "loaded", data });
      })
      .catch((error: unknown) => {
        if (!cancelled) setDetailState(apiReadFailure<EventDetail>(eventId, error));
      });
    return () => {
      cancelled = true;
    };
  }, [eventId, detailRetry]);

  useEffect(() => {
    if (eventId === null) return;
    let cancelled = false;
    setHistoryState({ eventId, status: "loading" });
    getEventHistory(eventId)
      .then((data) => {
        if (!cancelled) setHistoryState({ eventId, status: "loaded", data });
      })
      .catch((error: unknown) => {
        if (!cancelled) setHistoryState(apiReadFailure<HistoryPage>(eventId, error));
      });
    return () => {
      cancelled = true;
    };
  }, [eventId, historyRetry]);

  const loadingDetail: ApiReadState<EventDetail> | null = eventId === null ? null : { eventId, status: "loading" };
  const loadingHistory: ApiReadState<HistoryPage> | null = eventId === null ? null : { eventId, status: "loading" };
  return {
    detail: eventId !== null && detailState?.eventId === eventId ? detailState : loadingDetail,
    history: eventId !== null && historyState?.eventId === eventId ? historyState : loadingHistory,
    retryDetail: () => setDetailRetry((current) => current + 1),
    retryHistory: () => setHistoryRetry((current) => current + 1),
  };
}
