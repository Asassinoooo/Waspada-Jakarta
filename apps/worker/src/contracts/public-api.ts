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
  | "group_specific_critical_notices";

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
