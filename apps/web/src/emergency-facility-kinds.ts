// PERF-09: the kind names, labels and icons used by the first-screen map. The OSM facility records themselves
// (emergency-facilities.ts) load only when the facility layer is switched on.
export type EmergencyFacilityKind = "hospital" | "police" | "fire_station";

export interface EmergencyFacility {
  readonly id: string;
  readonly kind: EmergencyFacilityKind;
  readonly title: string;
  readonly coordinates: readonly [longitude: number, latitude: number];
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
