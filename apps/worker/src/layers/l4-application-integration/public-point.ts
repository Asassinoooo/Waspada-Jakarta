/**
 * HOSTED-10: the one point rule for published events. Pure helpers with no project imports, so the publication, the
 * record builder, the in-memory public read model and the projector can share them without an import cycle.
 *
 * Rule (owner decision, 17 Nov 2026; replaces the Jakarta-centre fallback of 16 Nov):
 * - An event with a usable approximate coordinate gets one Point, labelled model_approximate. The coordinate must be
 *   finite and inside the sanity box. A source coordinate would come first, but no source gives one today.
 * - An event with no usable coordinate has NO point and NO geometry row. Its location is the whole map view
 *   (location_display "whole_view"): the map fits the Jakarta extent, shows no pin, and never reuses another event's
 *   point or the Jakarta centre as a pin.
 * - No radius, polygon or line is ever written, and no coordinate is invented.
 * - An event needs a place id or a location label. A group-specific critical notice may have neither.
 * - The publication role cannot write geometry rows. A coordinate-bearing event therefore records
 *   geometry_status "pending_geometry_writer" and no geometry row (open decision: a narrow geometry-writer role, or defer).
 */

export const GROUP_NOTICE_CATEGORY = "group_specific_critical_notices";

/** Sanity check on the model's approximate point only. It is not a boundary of any kind. */
export const APPROXIMATE_POINT_SANITY_BOX = Object.freeze({
  latMin: -6.4,
  latMax: -5.0,
  lonMin: 106.6,
  lonMax: 107.1,
});

/** The only point source today. A source coordinate would get its own value when a source supplies one. */
export type PublicPointSource = "model_approximate";

/** How an event's location is published. Only "point" carries a coordinate. */
export type PublicPointOutcome =
  | { readonly status: "point"; readonly coordinates: [number, number] }
  | { readonly status: "whole_view" }
  | { readonly status: "not_required_group_notice" };

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
 * The location outcome of an event. A usable approximate coordinate gives "point". Otherwise the event is "whole_view",
 * except a group-specific critical notice with no label, which is "not_required_group_notice" (it has no location at all).
 */
export function publicPointOutcomeFor(input: {
  readonly category: string;
  readonly locationLabel: unknown;
  readonly coordinates: unknown;
}): PublicPointOutcome {
  const approximate = approximatePointFor({ coordinates: input.coordinates });
  if (approximate !== null) return { status: "point", coordinates: approximate };
  if (input.category === GROUP_NOTICE_CATEGORY && !hasLocationLabel(input.locationLabel)) {
    return { status: "not_required_group_notice" };
  }
  return { status: "whole_view" };
}

/** The public label of a point: the event's own location label, or a neutral label. It never names a fallback. */
export function publicPointLabel(locationLabel: unknown): string {
  return hasLocationLabel(locationLabel) ? String(locationLabel).trim().slice(0, 200) : "Lokasi perkiraan dari laporan";
}

/** A non-group event needs a place id or a label. Proposals carry no place id, so the label is the test. */
export function missingPlaceOrLabel(category: string, placeCount: number): boolean {
  return category !== GROUP_NOTICE_CATEGORY && placeCount === 0;
}
