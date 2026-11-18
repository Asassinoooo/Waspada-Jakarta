/**
 * HOSTED-10: the one point rule for published events. Pure helpers with no project imports, so the publication, the
 * record builder, the in-memory public read model and the projector can share them without an import cycle.
 *
 * Rule (owner decision, 17 Nov 2026; replaces the Jakarta-centre fallback of 16 Nov):
 * - An event with a usable approximate coordinate gets one Point. The coordinate must be finite and inside the sanity
 *   box. Its source is "source_text" when every claim comes from PetaBencana or BMKG, whose coordinates are parsed
 *   from the source's own text (HOSTED-14). Otherwise it is "model_approximate".
 * - An event with no usable coordinate has NO point and NO geometry row. Its location is the whole map view
 *   (location_display "whole_view"): the map fits the Jakarta extent, shows no pin, and never reuses another event's
 *   point or the Jakarta centre as a pin.
 * - No radius, polygon or line is ever written, and no coordinate is invented.
 * - An event needs a place id or a location label. A group-specific critical notice may have neither.
 * - HOSTED-26 (owner decision, 18 Nov 2026): the publication transaction writes that one Point as one geometry row
 *   (role approximate_place, precision_m null) and links every claim of the version to it, when the version has
 *   support from one report revision. The row is keyed by the event and the exact coordinate, so a later version at
 *   the same place reuses it. Without support, and with no earlier row, the event records geometry_status
 *   "pending_geometry_writer" and stays a whole view.
 * - HOSTED-14: a model coordinate reaches here only when the report text states a place for it (groundModelLocation
 *   in proposal-engine.ts, groundInterpretationLocation in apps/intelligence).
 */

export const GROUP_NOTICE_CATEGORY = "group_specific_critical_notices";

/** Sanity check on a point only. It is not a boundary of any kind. */
export const APPROXIMATE_POINT_SANITY_BOX = Object.freeze({
  latMin: -6.4,
  latMax: -5.0,
  lonMin: 106.6,
  lonMax: 107.1,
});

/**
 * Source ids whose coordinate is parsed from the source's own text: PetaBencana "Koordinat lokasi [lon, lat]" and BMKG
 * "[lon, lat] BMKG: ...". They mirror PETABENCANA_SOURCE_ID and BMKG_GEMPA_SOURCE_ID in
 * apps/intelligence/src/structured-interpretation.ts. The worker cannot import intelligence, so the literals are
 * repeated here, and a test pins them to the intelligence constants.
 */
export const SOURCE_STATED_POINT_SOURCE_IDS: ReadonlySet<string> = new Set(["petabencana", "source-bmkg-gempa"]);

/**
 * Where a point's coordinate came from. "source_text" is stated by the source's own text. "model_approximate" is the
 * agent's proposal. The rule is conservative: "source_text" needs every claim's source id to be a source-stated one.
 */
export type PublicPointSource = "source_text" | "model_approximate";

/** "source_text" only when there is at least one claim and every claim's source id is source-stated. */
export function pointSourceFor(claimSourceIds: readonly (string | null | undefined)[]): PublicPointSource {
  const everyClaimSourceStated = claimSourceIds.length > 0 &&
    claimSourceIds.every((id) => typeof id === "string" && SOURCE_STATED_POINT_SOURCE_IDS.has(id));
  return everyClaimSourceStated ? "source_text" : "model_approximate";
}

/** How an event's location is published. Only "point" carries a coordinate. */
export type PublicPointOutcome =
  | { readonly status: "point"; readonly coordinates: [number, number]; readonly source: PublicPointSource }
  | { readonly status: "whole_view" }
  | { readonly status: "not_required_group_notice" };

/** The approximate point as [longitude, latitude], or null when it is missing, non-finite or outside the box. */
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
 * The location outcome of an event. A usable coordinate gives "point", with its source from the claims' source ids
 * (HOSTED-14). Otherwise the event is "whole_view", except a group-specific critical notice with no label, which is
 * "not_required_group_notice" (it has no location at all).
 */
export function publicPointOutcomeFor(input: {
  readonly category: string;
  readonly locationLabel: unknown;
  readonly coordinates: unknown;
  readonly claimSourceIds?: readonly (string | null | undefined)[];
}): PublicPointOutcome {
  const approximate = approximatePointFor({ coordinates: input.coordinates });
  if (approximate !== null) {
    return { status: "point", coordinates: approximate, source: pointSourceFor(input.claimSourceIds ?? []) };
  }
  if (input.category === GROUP_NOTICE_CATEGORY && !hasLocationLabel(input.locationLabel)) {
    return { status: "not_required_group_notice" };
  }
  return { status: "whole_view" };
}

/** HOSTED-26: labels that name no specific place. "DKI Jakarta" and "Jakarta" are the correlator's area fallbacks. */
const GENERIC_LOCATION_LABELS: ReadonlySet<string> = new Set(["jakarta", "dki jakarta"]);
/** HOSTED-26: the fallback phrases the correlator writes when no place is known (multisource-correlator.ts). */
const GENERIC_LOCATION_PHRASES: readonly string[] = ["belum teridentifikasi", "tidak teridentifikasi", "lokasi spesifik"];
const PUBLIC_LOCATION_LABEL_MAX_CODE_POINTS = 200;

/**
 * HOSTED-26 (owner decision, 18 Nov 2026): the public text of an event's location label, or null. The label is trimmed,
 * its whitespace is collapsed and it is limited to 200 code points. A label that names no specific place is null: an
 * empty label, "Jakarta" or "DKI Jakarta" in any case, or a label containing a fallback phrase. The text is data, shown
 * as text only. It never sets a pin, and it is not a coordinate.
 */
export function publicLocationLabel(label: unknown): string | null {
  if (typeof label !== "string") return null;
  const collapsed = label.replace(/\s+/gu, " ").trim();
  if (collapsed.length === 0) return null;
  const folded = collapsed.toLowerCase();
  if (GENERIC_LOCATION_LABELS.has(folded)) return null;
  if (GENERIC_LOCATION_PHRASES.some((phrase) => folded.includes(phrase))) return null;
  return Array.from(collapsed).slice(0, PUBLIC_LOCATION_LABEL_MAX_CODE_POINTS).join("");
}

/**
 * The public label of a point: the event's own public location label, or a neutral label. A generic label never becomes
 * the point's label, so the point never names a fallback.
 */
export function publicPointLabel(locationLabel: unknown): string {
  return publicLocationLabel(locationLabel) ?? "Lokasi perkiraan dari laporan";
}

/** A non-group event needs a place id or a label. Proposals carry no place id, so the label is the test. */
export function missingPlaceOrLabel(category: string, placeCount: number): boolean {
  return category !== GROUP_NOTICE_CATEGORY && placeCount === 0;
}
