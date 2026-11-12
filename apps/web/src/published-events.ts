/*
 * Published public events for the map home (UI-V2-B). One hook reads the list
 * (/api/v1/events) and the geometry (/api/v1/events.geojson). Everything else
 * here is pure: filters, labels and marker selection. Nothing is invented: a
 * missing time reads "Tidak diketahui", and a count is a count of distinct
 * named sources, never a verification.
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
  listEvents,
  type ApiReadState,
} from "./api-client.js";
import { categoryLabel, formatDate, formatInstant } from "./display.js";

export type MapCoordinate = readonly [longitude: number, latitude: number];

/** A point marker the API returned for an event. The role is kept so an approximate place can say so. */
export interface PublishedMarker {
  readonly coordinate: MapCoordinate;
  readonly role: string;
}

export type EventTimeRange = "all" | "24h" | "7d" | "30d";
export type EvidenceKind = "issuer_notice" | "attributed_report" | "independent_corroboration" | "crowdsourced_observation";

export interface PublishedFilters {
  category: Category | "all";
  timeRange: EventTimeRange;
  source: EvidenceKind | "all";
}

export const DEFAULT_PUBLISHED_FILTERS: PublishedFilters = { category: "all", timeRange: "all", source: "all" };

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

/** Number of filter groups that differ from the default, plus facilities when they are shown. */
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

/** Filters the loaded list. Search, category, time range and source all combine with AND. */
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
    && (filters.source === "all" || event.claims.some((claim) => claim.evidence_label === filters.source))
    && (search.length === 0 || searchableText(event).includes(search))
  );
}

/** Distinct, named sources across the event's claims. This is a count of outlets, not corroboration. */
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

export function sourceCountText(count: number): string {
  return count === 0 ? "Sumber tidak tercatat" : `${count} sumber`;
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

function formatTime(value: string, precision: EventView["event_time"]["precision"]): string {
  return precision === "date" ? formatDate(value) : formatInstant(value);
}

/** Event time (waktu kejadian) only. Never the publication time. */
export function eventTimeText(event: EventView): string {
  if (!eventHasTime(event) || event.event_time.start === null) return "Tidak diketahui";
  const start = formatTime(event.event_time.start, event.event_time.precision);
  if (!event.event_time.end) return start;
  return `${start} – ${formatTime(event.event_time.end, event.event_time.precision)}`;
}

/** Publication time (diterbitkan) for this public version. */
export function publishedAtText(event: EventView): string {
  return event.published_at ? formatInstant(event.published_at) : "Tidak diketahui";
}

export function areaText(event: EventView): string {
  const places = event.scope.places.filter((place) => place.trim().length > 0);
  return places.length > 0 ? places.slice(0, 2).join(", ") : "Lokasi tidak tercatat";
}

export function categoryText(category: string): string {
  if (category === "other") return "Lainnya";
  if (category === "unclassified") return "Belum diklasifikasikan";
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

/** How a version was published. Null when the list does not say, so no path is claimed. */
export function publicationPathText(
  publication: { readonly mode: "agent_auto" | "moderator_reviewed"; readonly source_count: number } | undefined,
): string | null {
  if (!publication) return null;
  const reach = ` · dilaporkan oleh ${publication.source_count} media`;
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
    Promise.allSettled([listEvents(), getEventGeoJSON()]).then(([listResult, geoResult]) => {
      if (cancelled) return;
      if (listResult.status === "rejected") {
        setState({
          status: "unavailable",
          events: [],
          markers: NO_MARKERS,
          markersUnavailable: false,
          errorMessage: `Gagal memuat laporan publik: ${errorText(listResult.reason)}`,
        });
        return;
      }
      setState({
        status: "loaded",
        events: listResult.value.data,
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
