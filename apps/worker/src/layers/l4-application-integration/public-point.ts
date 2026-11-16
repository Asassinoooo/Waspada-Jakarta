/**
 * HOSTED-10: the one point rule for published events. Pure helpers with no project imports, so the publication, the record
 * builder, the in-memory public read model and the projector can share them without an import cycle.
 *
 * Rule (owner decision, 16 Nov 2026):
 * - Every published event gets exactly one Point geometry, except a group-specific critical notice with no location.
 * - The point is a source coordinate when a source gives one (none does today). Otherwise it is the agent's
 *   approximateCoordinates, labelled model_approximate. If that is missing, not finite, or outside the sanity box, the
 *   point is the Jakarta centre, labelled fallback_jakarta_centre.
 * - No radius, polygon or line is ever written.
 * - An event needs a place id or a location label. A group-specific critical notice may have neither.
 */
import { createHash } from "node:crypto";

export const GROUP_NOTICE_CATEGORY = "group_specific_critical_notices";

/** Sanity check on the model's approximate point only. It is not a boundary of any kind. */
export const APPROXIMATE_POINT_SANITY_BOX = Object.freeze({
  latMin: -6.4,
  latMax: -5.0,
  lonMin: 106.6,
  lonMax: 107.1,
});

/** The Jakarta centre fallback. Labelled, never presented as a source location. */
export const JAKARTA_CENTRE_FALLBACK = Object.freeze({ lon: 106.82, lat: -6.2 });

export type PublicPointSource = "model_approximate" | "fallback_jakarta_centre";

export interface PublicPoint {
  readonly coordinates: [number, number];
  readonly source: PublicPointSource;
}

/** The model's approximate point as [longitude, latitude], or null when it is missing, non-finite or outside the box. */
export function approximatePointFor(proposal: { readonly coordinates?: unknown }): [number, number] | null {
  const value = proposal.coordinates;
  if (!Array.isArray(value) || value.length !== 2) return null;
  const [lon, lat] = value as unknown[];
  if (typeof lon !== "number" || typeof lat !== "number" || !Number.isFinite(lon) || !Number.isFinite(lat)) return null;
  const box = APPROXIMATE_POINT_SANITY_BOX;
  if (lat < box.latMin || lat > box.latMax || lon < box.lonMin || lon > box.lonMax) return null;
  return [lon, lat];
}

/** True when a free-text location label is present (trimmed, non-empty). */
export function hasLocationLabel(locationLabel: unknown): boolean {
  return typeof locationLabel === "string" && locationLabel.trim().length > 0;
}

/**
 * The one point an event publishes, or null. Null only for a group-specific critical notice with no location, meaning
 * no label and no in-box approximate point. A source coordinate would be used first, but no source gives one today.
 */
export function publicPointFor(input: {
  readonly category: string;
  readonly locationLabel: unknown;
  readonly coordinates: unknown;
}): PublicPoint | null {
  const approximate = approximatePointFor({ coordinates: input.coordinates });
  if (approximate !== null) return { coordinates: approximate, source: "model_approximate" };
  if (input.category === GROUP_NOTICE_CATEGORY && !hasLocationLabel(input.locationLabel)) return null;
  return { coordinates: [JAKARTA_CENTRE_FALLBACK.lon, JAKARTA_CENTRE_FALLBACK.lat], source: "fallback_jakarta_centre" };
}

/** The public label of a point. A fallback is named as one, so the reader is never shown it as a source location. */
export function publicPointLabel(source: PublicPointSource, locationLabel: unknown): string {
  if (source === "fallback_jakarta_centre") return "Perkiraan pusat Jakarta, lokasi belum diketahui";
  return hasLocationLabel(locationLabel) ? String(locationLabel).trim().slice(0, 200) : "Lokasi perkiraan dari laporan";
}

/** A non-group event needs a place id or a label. Proposals carry no place id, so the label is the test. */
export function missingPlaceOrLabel(category: string, placeCount: number): boolean {
  return category !== GROUP_NOTICE_CATEGORY && placeCount === 0;
}

/** One geometry id per public version, so a later version with moved coordinates gets its own append-only row. */
export function pointGeometryIdFor(datasetKind: string, eventId: string, version: number): string {
  const digest = createHash("sha256").update(`${datasetKind}:${eventId}:${version}`).digest("hex");
  return `geo-point-${digest.slice(0, 32)}`;
}
