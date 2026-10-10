/** Isolated educational source preview. Never a published Event or hazard warning. */
export type PreviewSourceId = "osm" | "petabencana";
export type PreviewKind = "hospital" | "police" | "fire_station" | "flood_report";

export interface PreviewRecord {
  id: string;
  source: PreviewSourceId;
  kind: PreviewKind;
  title: string;
  coordinates: [number, number]; // CRS84 longitude, latitude
  coordinate_kind: "source_point" | "source_extent_center";
  observed_at: string | null;
  source_status: string | null; // publisher status, never a Waspada verification
  source_url: string;
}

export interface PreviewSource {
  id: PreviewSourceId;
  status: "available" | "empty" | "unavailable" | "not_requested";
  data_mode: "snapshot" | "fetched" | "none";
  fetched_at: string | null;
  source_updated_at: string | null;
  attribution: string;
  license_url: string;
  records: PreviewRecord[];
  rejected_count: number;
  limited: boolean;
  error: "timeout" | "http_error" | "invalid_payload" | null;
}

export interface SourcePreviewPayload {
  schema_version: "source-preview-v1";
  mode: "source_preview";
  generated_at: string;
  cached: boolean;
  sources: [PreviewSource, PreviewSource]; // osm, petabencana
}
