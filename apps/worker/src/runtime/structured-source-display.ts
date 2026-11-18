/**
 * HOSTED-36 (owner decision, 18 Nov 2026): the outlet name of the structured sources. The registry display_name is the
 * name the claim outlet and the public attribution read, so a raw id such as "source-bmkg-gempa" must not be stored as a
 * name. The seeds and lazy inserts use this map. Migration 058_source_display_names.sql writes the same two names into
 * existing rows, so keep its SQL in step with this map.
 */
import { BMKG_GEMPA_SOURCE_ID } from "./bmkg-poll-runtime.js";
import { PETABENCANA_SOURCE_ID } from "../layers/l1-data-knowledge/petabencana-ingest.js";

const STRUCTURED_SOURCE_DISPLAY_NAMES: ReadonlyMap<string, string> = new Map([
  [BMKG_GEMPA_SOURCE_ID, "BMKG"],
  [PETABENCANA_SOURCE_ID, "PetaBencana.id"],
]);

/** The display name for a structured source. Any other id is returned unchanged, so the caller's behaviour for it does not change. */
export function structuredSourceDisplayName(sourceId: string): string {
  return STRUCTURED_SOURCE_DISPLAY_NAMES.get(sourceId) ?? sourceId;
}
