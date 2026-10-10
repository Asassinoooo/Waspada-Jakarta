/** Educational context, isolated from published incidents and source-preview-v1. */
export type ContextSourceStatus = "available" | "empty" | "unavailable" | "not_requested";
export type ContextSourceError = "timeout" | "http_error" | "invalid_payload" | null;
export interface ContextSourceMetadata {
  status: ContextSourceStatus;
  data_mode: "fetched" | "none";
  fetched_at: string | null; // on failure: request attempt time
  source_updated_at: string | null; // never substitute fetch time or CPU generationtime_ms
  attribution: string;
  license_url: string;
  source_url: string;
  rejected_count: number;
  limited: boolean;
  error: ContextSourceError;
}
export interface WeatherForecastHour {
  valid_at: string; // UTC forecast validity; not observation/issuance time
  temperature_c: number | null;
  precipitation_probability_pct: number | null;
  precipitation_mm: number | null; // model accumulation during preceding hour
  weather_code: number | null;
  wind_speed_kmh: number | null;
}
export interface WeatherForecast {
  requested_coordinates: [number, number]; // fixed sample: 106.82, -6.2
  model_coordinates: [number, number]; // provider grid point, never a hazard marker
  hours: WeatherForecastHour[]; // 1..12 sequential hourly model values
}
export interface WeatherContextSource extends ContextSourceMetadata {
  id: "openmeteo";
  forecast: WeatherForecast | null;
}
export interface EarthquakeContextRecord {
  id: string; // usgs:<provider id>
  source: "usgs";
  kind: "earthquake";
  title: string; // fixed Bahasa label plus bounded provider place metadata
  coordinates: [number, number]; // epicentre longitude, latitude; not impact area
  coordinate_kind: "source_point";
  event_time: string; // earthquake origin time
  updated_at: string; // provider revision time, separate from acquisition
  magnitude: number | null;
  magnitude_type: string | null;
  depth_km: number;
  source_status: "automatic" | "reviewed" | null; // provider only
  source_url: string; // exact https USGS event page matching provider id
}
export interface EarthquakeContextSource extends ContextSourceMetadata {
  id: "usgs";
  records: EarthquakeContextRecord[]; // at most 30
  window_start: string | null;
  window_end: string | null;
}
export interface ContextSourcesPayload {
  schema_version: "context-sources-v1";
  mode: "source_context";
  generated_at: string;
  cached: boolean;
  sources: [WeatherContextSource, EarthquakeContextSource];
}
export const CONTEXT_SOURCE_POLICY = {
  weatherRequestedCoordinates: [106.82, -6.2] as const,
  weatherGridEnvelope: { west: 106.32, south: -6.7, east: 107.32, north: -5.7 },
  earthquakeEnvelope: { west: 104, south: -9.5, east: 110, north: -4 },
  earthquakeWindowMs: 7 * 24 * 60 * 60_000,
  maxEarthquakes: 30,
  maxForecastHours: 12,
  cacheTtlMs: 5 * 60_000,
  requestDeadlineMs: 25_000,
  maxBodyBytes: 1_048_576,
  maxNestingDepth: 32,
  maxProviderRecords: 500,
  weatherCodes: [0, 1, 2, 3, 45, 48, 51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 71, 73, 75, 77, 80, 81, 82, 85, 86, 95, 96, 99] as readonly number[],
  weatherAttribution: "Weather data by Open-Meteo.com · CC BY 4.0; data dinormalisasi Waspada Jakarta.",
  weatherLicenseUrl: "https://creativecommons.org/licenses/by/4.0/",
  weatherSourceUrl: "https://open-meteo.com/en/docs",
  earthquakeAttribution: "Sumber: U.S. Geological Survey (USGS); metadata katalog dinormalisasi Waspada Jakarta.",
  earthquakeLicenseUrl: "https://www.usgs.gov/information-policies-and-instructions/copyrights-and-credits",
  earthquakeSourceUrl: "https://earthquake.usgs.gov/earthquakes/map/",
} as const;
