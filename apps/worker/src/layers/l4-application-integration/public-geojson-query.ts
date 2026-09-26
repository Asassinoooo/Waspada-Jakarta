import type { Category, FreshnessStatus, Lifecycle } from "../../contracts/public-api.js";
import { QueryValidationError } from "./public-read-model.js";

export type PublicGeoJSONBBox = readonly [
  west: number,
  south: number,
  east: number,
  north: number,
];

export interface PublicGeoJSONQuery {
  bbox: PublicGeoJSONBBox;
  category: Category | null;
  lifecycle: Lifecycle | null;
  freshness: FreshnessStatus | null;
}

export const JAKARTA_GEOJSON_QUERY_ENVELOPE: PublicGeoJSONBBox = [
  106.32,
  -6.4,
  106.98,
  -5.16,
];

const categoryValues: ReadonlySet<Category> = new Set([
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

const lifecycleValues: ReadonlySet<Lifecycle> = new Set([
  "planned",
  "ongoing",
  "resolved",
  "cancelled",
  "unknown",
]);

const freshnessValues: ReadonlySet<FreshnessStatus> = new Set([
  "current",
  "needs_update",
  "expired",
]);

const supportedParameters = new Set(["bbox", "category", "lifecycle", "freshness"]);
const decimalPattern = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/u;

/** Validate the documented GeoJSON query parameters without retaining raw inputs. */
export function readPublicGeoJSONQuery(search: URLSearchParams): PublicGeoJSONQuery {
  for (const name of search.keys()) {
    if (!supportedParameters.has(name)) {
      throw new QueryValidationError("query parameter is not supported");
    }
  }

  return {
    bbox: readBBox(readSingleValue(search, "bbox")),
    category: readEnum(search, "category", categoryValues),
    lifecycle: readEnum(search, "lifecycle", lifecycleValues),
    freshness: readEnum(search, "freshness", freshnessValues),
  };
}

function readBBox(value: string | null): PublicGeoJSONBBox {
  if (value === null) return [...JAKARTA_GEOJSON_QUERY_ENVELOPE];
  if (value.length > 100) throw new QueryValidationError("bbox is invalid");

  const parts = value.split(",");
  if (parts.length !== 4 || parts.some((part) => !decimalPattern.test(part))) {
    throw new QueryValidationError("bbox is invalid");
  }

  const bounds = parts.map(Number);
  if (bounds.some((bound) => !Number.isFinite(bound))) {
    throw new QueryValidationError("bbox is invalid");
  }

  const [west, south, east, north] = bounds;
  if (
    west === undefined || south === undefined || east === undefined || north === undefined
    || west > east || south > north
    || west < JAKARTA_GEOJSON_QUERY_ENVELOPE[0]
    || south < JAKARTA_GEOJSON_QUERY_ENVELOPE[1]
    || east > JAKARTA_GEOJSON_QUERY_ENVELOPE[2]
    || north > JAKARTA_GEOJSON_QUERY_ENVELOPE[3]
  ) {
    throw new QueryValidationError("bbox is invalid");
  }

  return [west, south, east, north];
}

function readEnum<T extends string>(
  search: URLSearchParams,
  name: string,
  allowed: ReadonlySet<T>,
): T | null {
  const value = readSingleValue(search, name);
  if (value === null) return null;
  if (!allowed.has(value as T)) throw new QueryValidationError(`${name} is not supported`);
  return value as T;
}

function readSingleValue(search: URLSearchParams, name: string): string | null {
  const values = search.getAll(name);
  if (values.length > 1) throw new QueryValidationError(`${name} is invalid`);
  return values[0] ?? null;
}
