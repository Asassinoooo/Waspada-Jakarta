import osmSnapshot from "../../worker/src/demo/osm-reference-snapshot.json" with { type: "json" };

export type EmergencyFacilityKind = "hospital" | "police" | "fire_station";

export interface EmergencyFacility {
  readonly id: string;
  readonly kind: EmergencyFacilityKind;
  readonly title: string;
  readonly coordinates: readonly [longitude: number, latitude: number];
}

export const EMERGENCY_FACILITIES: readonly EmergencyFacility[] = osmSnapshot.records.map((r) => ({
  id: r.id,
  kind: r.kind as EmergencyFacilityKind,
  title: r.title,
  coordinates: [r.coordinates[0]!, r.coordinates[1]!] as const,
}));

/**
 * Calculate Haversine distance in meters between two [longitude, latitude] coordinates.
 */
export function haversineDistanceMeters(
  coord1: readonly [number, number],
  coord2: readonly [number, number]
): number {
  const [lon1, lat1] = coord1;
  const [lon2, lat2] = coord2;
  const R = 6371e3; // Earth radius in meters
  const phi1 = (lat1 * Math.PI) / 180;
  const phi2 = (lat2 * Math.PI) / 180;
  const deltaPhi = ((lat2 - lat1) * Math.PI) / 180;
  const deltaLambda = ((lon2 - lon1) * Math.PI) / 180;

  const a =
    Math.sin(deltaPhi / 2) * Math.sin(deltaPhi / 2) +
    Math.cos(phi1) * Math.cos(phi2) * Math.sin(deltaLambda / 2) * Math.sin(deltaLambda / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return Math.round(R * c);
}

export interface NearbyFacility extends EmergencyFacility {
  readonly distanceMeters: number;
}

/**
 * Find nearby emergency facilities around a coordinate, sorted by distance.
 */
export function findNearbyFacilities(
  center: readonly [number, number],
  maxDistanceMeters = 5000,
  limit = 25
): NearbyFacility[] {
  const results: NearbyFacility[] = [];
  for (const facility of EMERGENCY_FACILITIES) {
    const distanceMeters = haversineDistanceMeters(center, facility.coordinates);
    if (distanceMeters <= maxDistanceMeters) {
      results.push({ ...facility, distanceMeters });
    }
  }
  results.sort((a, b) => a.distanceMeters - b.distanceMeters);
  return results.slice(0, limit);
}

export function facilityKindLabel(kind: EmergencyFacilityKind): string {
  switch (kind) {
    case "hospital":
      return "Rumah Sakit";
    case "police":
      return "Kepolisian";
    case "fire_station":
      return "Pemadam Kebakaran";
  }
}

export function facilityKindIcon(kind: EmergencyFacilityKind): string {
  switch (kind) {
    case "hospital":
      return "🏥";
    case "police":
      return "👮";
    case "fire_station":
      return "🚒";
  }
}
