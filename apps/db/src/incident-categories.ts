/**
 * Single canonical incident-category vocabulary for Waspada Jakarta.
 *
 * This module is the ONLY authoritative source of the ten official primary
 * incident categories (WJ-INT-02). Every other layer — extraction results,
 * event proposals, publication writer, public projections, worker contracts,
 * moderation API, and the web UI — must import these symbols instead of
 * redeclaring the ten slugs inline.
 *
 * The legacy compatibility categories (`flood`, `fire`, `accident`,
 * `tree_fall`, `crime`, `weather`, `other`, `unclassified`) remain as
 * explicitly derived, non-authoritative metadata only. They MUST NOT be
 * written to `category` columns or used to replace the official primary
 * category.
 */

export const OFFICIAL_INCIDENT_CATEGORIES = [
  'crime_personal_security',
  'demonstrations_public_gatherings',
  'crowds_major_events',
  'violence_immediate_threats',
  'disasters_weather',
  'fires_infrastructure_hazards',
  'transport_road_incidents',
  'utilities_essential_services',
  'health_environmental_advisories',
  'group_specific_critical_notices',
] as const;

export type OfficialIncidentCategory = (typeof OFFICIAL_INCIDENT_CATEGORIES)[number];

const OFFICIAL_INCIDENT_CATEGORY_SET: ReadonlySet<string> = new Set(OFFICIAL_INCIDENT_CATEGORIES);

export function isOfficialIncidentCategory(value: unknown): value is OfficialIncidentCategory {
  return typeof value === 'string' && OFFICIAL_INCIDENT_CATEGORY_SET.has(value);
}

export class InvalidOfficialIncidentCategoryError extends Error {
  constructor(readonly value: unknown) {
    super(
      `invalid primary category: expected exactly one of ${OFFICIAL_INCIDENT_CATEGORIES.join(', ')}`,
    );
    this.name = 'InvalidOfficialIncidentCategoryError';
  }
}

/** Throws InvalidOfficialIncidentCategoryError for invented, multiple, or null categories. */
export function assertOfficialIncidentCategory(value: unknown): OfficialIncidentCategory {
  if (!isOfficialIncidentCategory(value)) {
    throw new InvalidOfficialIncidentCategoryError(value);
  }
  return value;
}
