export type Category =
  | "crime_personal_security"
  | "demonstrations_public_gatherings"
  | "crowds_major_events"
  | "violence_immediate_threats"
  | "disasters_weather"
  | "fires_infrastructure_hazards"
  | "transport_road_incidents"
  | "utilities_essential_services"
  | "health_environmental_advisories"
  | "group_specific_critical_notices"
  | "other"
  | "unclassified";
export type Lifecycle = "planned" | "ongoing" | "resolved" | "cancelled" | "unknown";
export type FreshnessStatus = "current" | "needs_update" | "expired";

export interface TimeScope {
  start: string | null;
  end: string | null;
  precision: "exact" | "date" | "range" | "unknown";
}

export interface Validity {
  valid_from: string | null;
  valid_until: string | null;
}

export interface Freshness {
  status: FreshnessStatus;
  evaluated_at: string;
  review_due_at: string | null;
  basis:
    | "source_validity"
    | "fast_observation_review"
    | "undated_advisory_review"
    | "manual_review"
    | "unknown";
}

export interface PublicScope {
  places: string[];
  services: string[];
  institutions: string[];
  audiences: string[];
}

export interface PublicClaim {
  claim_id: string;
  text: string;
  event_time: TimeScope;
  validity: Validity;
  scope: PublicScope;
  qualifiers: string[];
  evidence_label:
    | "issuer_notice"
    | "attributed_report"
    | "independent_corroboration"
    | "crowdsourced_observation";
  sources: Array<{
    display_name: string;
    url: string;
    published_at: string | null;
    observed_at: string | null;
    /**
     * POLISH-02 (additive, optional): the source collection time (waktu pengambilan sumber), RFC 3339. Null when the
     * revision has no collection time. Never invented and never the publication or processing time.
     */
    retrieved_at?: string | null;
    excerpt: string | null;
  }>;
}

export interface PublicImpact {
  impact_id: string;
  version: number;
  impact_type:
    | "road_closure"
    | "traffic_diversion"
    | "transport_service_disruption"
    | "facility_closure"
    | "utility_outage"
    | "hazard_observation"
    | "public_access_restriction"
    | "event_attendance"
    | "audience_notice"
    | "other";
  title: string;
  description: string;
  lifecycle: Lifecycle;
  freshness: Freshness;
  event_time: TimeScope;
  validity: Validity;
  scope: PublicScope;
}

export interface EventView {
  event_id: string;
  version: number;
  title: string;
  summary: string;
  category: Category;
  incident_type?: string;
  /**
   * HOSTED-10 (additive, optional): "point" when the event has one approximate Point; "whole_view" when it has no usable
   * coordinate. A whole_view event is shown as the whole map view (the Jakarta extent) with no pin. Never reuse another
   * event's point or the Jakarta centre for it. Absent on fixtures and DB-projected versions.
   */
  location_display?: "point" | "whole_view";
  /**
   * HOSTED-26 (additive, optional): the public text of the event's location label, when it names a specific place. Absent
   * for a generic label (for example "DKI Jakarta") and for an event with no label. It is text only: it is not a coordinate
   * and never sets a pin.
   */
  readonly location_label?: string;
  tags: Array<{
    namespace: "topic" | "service" | "audience" | "hazard" | "transport_mode" | "place_type";
    value: string;
  }>;
  lifecycle: Lifecycle;
  freshness: Freshness;
  event_time: TimeScope;
  validity: Validity;
  scope: PublicScope;
  claims: PublicClaim[];
  impacts: PublicImpact[];
  published_at: string;
  /** Model-assessed estimate of impact (SEV-01). Omitted when not assessed. Never a safety claim and never a radius. */
  severity?: "low" | "medium" | "high";
}

export type PublicGeoJSONPosition = [longitude: number, latitude: number];

export type PublicGeoJSONGeometry =
  | { type: "Point"; coordinates: PublicGeoJSONPosition }
  | { type: "MultiPoint"; coordinates: PublicGeoJSONPosition[] }
  | { type: "LineString"; coordinates: PublicGeoJSONPosition[] }
  | { type: "MultiLineString"; coordinates: PublicGeoJSONPosition[][] }
  | { type: "Polygon"; coordinates: PublicGeoJSONPosition[][] }
  | { type: "MultiPolygon"; coordinates: PublicGeoJSONPosition[][][] };

export interface PublicGeometry {
  geometry_id: string;
  role:
    | "incident_scene"
    | "affected_area"
    | "warning_boundary"
    | "route_segment"
    | "service_stop"
    | "facility"
    | "venue"
    | "service_area"
    | "approximate_place";
  geometry: PublicGeoJSONGeometry;
  precision_m: number | null;
  label: string | null;
}

export interface EventDetail extends EventView {
  geometries: PublicGeometry[];
  /**
   * MERGE-REVIEW-01 (additive): how this public version was published. Present only for
   * published versions from the proposal pipeline. Clients label agent-only versions as
   * automatic and count sources as distinct publishers.
   */
  publication?: {
    readonly mode: "agent_auto" | "moderator_reviewed";
    readonly source_count: number;
    /**
     * ADR-061 amendment: checks waived for this version. `source_permission_waived_local` is local live mode only.
     * HOSTED-21: `event_time_unknown` means the version was published with no event time (kept unknown). Absent otherwise.
     */
    readonly waivers?: readonly string[];
  };
}

export interface PublicFeature {
  type: "Feature";
  id: string;
  geometry: PublicGeoJSONGeometry;
  properties: {
    event_id: string;
    version: number;
    title: string;
    category: Category;
    lifecycle: Lifecycle;
    freshness: FreshnessStatus;
    geometry_role: PublicGeometry["role"];
  };
}

export interface PublicFeatureCollection {
  type: "FeatureCollection";
  features: PublicFeature[];
}

export interface EventPage {
  data: EventView[];
  page: {
    next_cursor: string | null;
    cursor_expires_at: string | null;
  };
}

/**
 * HIST-UI-01 (additive, optional): one difference from the previous PUBLISHED version. Text fields carry the public
 * projection's text (repaired title and summary, the event time and validity written as "precision start end" with
 * "-" for an open bound, or null when absent). A summary before or after is at most 600 characters, cut at a word
 * boundary and ending in "…" when longer. Scope fields carry public display names, sorted, at most 20 per list. A scope
 * field is left out when one of its IDs has no approved display name, and the other fields still appear. Claims and
 * impacts are counts only.
 */
export type HistoryChange =
  | {
    field: "title" | "summary" | "category" | "lifecycle" | "freshness" | "event_time" | "validity";
    before: string | null;
    after: string | null;
  }
  | {
    field: "places" | "services" | "institutions" | "audiences";
    added: string[];
    removed: string[];
  }
  | {
    field: "claims" | "impacts";
    before_count: number;
    after_count: number;
  };

export interface HistoryEntry {
  event_id: string;
  version: number;
  change_type: "published" | "corrected" | "impact_changed" | "retracted";
  changed_at: string;
  summary: string;
  /**
   * POLISH-02 (additive, optional): true only for an automatic refresh by agent:auto-publisher (written as "corrected").
   * Omitted otherwise. The reviewer identifier is never exposed.
   */
  automatic?: boolean;
  /**
   * HIST-UI-01 (additive, optional): the differences from the previous published version, in the field order of
   * HistoryChange. Omitted for version 1, when no previous published version is present, for a retracted entry, and
   * when nothing differs. Never contains reviewer, trace, decision or source identifiers.
   */
  changes?: HistoryChange[];
}

export interface HistoryPage {
  data: HistoryEntry[];
  page: {
    next_cursor: string | null;
    cursor_expires_at: string | null;
  };
}

export interface PublicContext {
  dataset_mode: "live" | "demo";
  dataset_label: "live" | "historical" | "synthetic";
  generated_at: string;
  sources: Array<{
    display_name: string;
    health: "unknown" | "healthy" | "degraded" | "unavailable";
    last_success_at: string | null;
  }>;
}

export interface BriefingInterests {
  places: string[];
  services: string[];
  institutions: string[];
  audiences: string[];
  categories: Category[];
}

/** Mirrors the closed BriefingRequest object in the public OpenAPI contract. */
export interface BriefingRequest {
  interests: BriefingInterests;
}

export interface BriefingItem {
  event: EventView;
  relevance_reasons: string[];
}

/** Mirrors the closed BriefingResponse object in the public OpenAPI contract. */
export interface BriefingResponse {
  items: BriefingItem[];
  generated_at: string;
}
