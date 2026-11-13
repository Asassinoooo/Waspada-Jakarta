/**
 * DET-FILTER-01 deterministic relevance prefilter for RSS/news triage.
 *
 * Pure module: no I/O beyond the initial versioned JSON imports, no env
 * access, no logging of item content. It maps already-authorized
 * `title + descriptionExcerpt` text to a bounded, serializable verdict
 * (`candidate` | `ambiguous` | `low_signal`) using two checked-in datasets:
 *
 * - `data/jakarta-gazetteer.json` (44 districts, 267 canonical kelurahan,
 *   curated name-only `jakartaPlaces`, single-token alias blocklist)
 * - `data/incident-lexicon.json` (event groups, alert/supporting terms,
 *   3 contextual overrides, location role cues, agency reference cues)
 *
 * DET-FILTER-03 (rule v2) broadens candidacy: a strong event plus ANY Jakarta
 * place (kelurahan/kecamatan, named DKI place, DKI city, or the province) is a
 * candidate unless the location role is non-scene/reference. Stage B remains
 * the precision layer. No match here yields coordinates, a point or a radius.
 *
 * Semantic triage stays authoritative for nuance and L4 human approval stays
 * required; this prefilter only lets the poller skip the model call (and the
 * resulting revision/AI job) for non-candidates under explicit test-only
 * enforce opt-in. Default mode is shadow (zero behavior change).
 *
 * Normalization follows `nfkc-id-lower-space-v1` (NFKC, lowercase,
 * punctuation/separators to spaces, collapse, tokenize once). Matching is
 * exact token-sequence/phrase matching with token boundaries — never raw
 * substring `includes`. The matcher never outputs `primaryCategory` or
 * `incidentType`; `primaryCategoryHint` is display/debug only.
 */
import { isOfficialIncidentCategory } from "../../../../db/src/incident-categories.js";
import gazetteerJson from "./data/jakarta-gazetteer.json" with { type: "json" };
import lexiconJson from "./data/incident-lexicon.json" with { type: "json" };

export const DETERMINISTIC_FILTER_RULE_VERSION = 'det-filter-v2' as const;

export interface DeterministicLocationMatch {
  readonly id: string;
  readonly name: string;
  readonly level:
    | 'village'
    | 'district'
    | 'city'
    | 'regency'
    | 'province'
    | 'jakarta_place'
    | 'locality_or_area_unverified';
  /**
   * `named_place` is a curated jakarta_place (road, landmark, station...). It
   * satisfies the place gate but never the administrative `specific` gate.
   */
  readonly matchStrength: 'specific' | 'broad_only' | 'named_place' | 'context_required';
  readonly matchedAlias: string;
  readonly parentDistrictId?: string;
  readonly parentRegionId?: string;
}

export interface DeterministicEventMatch {
  readonly groupId: string;
  readonly label: string;
  readonly matchedTerm: string;
  readonly strength: 'strong' | 'supporting' | 'alert_only' | 'context_only';
  readonly primaryCategoryHint?: string | null;
}

export interface DeterministicRelevanceResult {
  readonly status: 'candidate' | 'ambiguous' | 'low_signal';
  readonly ruleVersion: string;
  readonly locationMatches: readonly DeterministicLocationMatch[];
  readonly eventMatches: readonly DeterministicEventMatch[];
  readonly locationRole: 'scene' | 'non_scene_or_reference' | 'unknown';
  readonly reasons: readonly string[];
}

/** Versioned inputs, validated once at load. */
export interface GazetteerDataset {
  readonly schemaVersion: string;
  readonly datasetId: string;
  readonly datasetVersion: string;
  readonly hierarchy: {
    readonly province: CanonicalAdminRecord;
    readonly administrativeAreas: readonly AdministrativeArea[];
  };
  readonly unverifiedLocalities: readonly UnverifiedLocality[];
  /** DET-FILTER-03 curated named Jakarta places (name only, never coordinates). */
  readonly jakartaPlaces: readonly JakartaPlaceRecord[];
  /** Single-token aliases that are ordinary words or out-of-DKI homonyms. */
  readonly singleTokenAliasBlocklist: readonly SingleTokenBlocklistEntry[];
  readonly contextualAliasGuards: readonly ContextualAliasGuard[];
  /** Out-of-DKI cities: a road or toll name next to one (and no DKI anchor) is a homonym. */
  readonly outOfDkiHomonymCueTerms: readonly string[];
  readonly jakartaPlaceHomonymGuards: readonly PlaceHomonymGuard[];
  readonly supplementalLegacyLocalities: readonly SupplementalLocality[];
  readonly legacyToponymCoverage: readonly unknown[];
}

export interface PlaceHomonymGuard {
  readonly recordId: string;
  readonly cues: readonly string[];
}

export interface JakartaPlaceRecord {
  readonly id: string;
  readonly name: string;
  readonly placeClass: string | null;
  readonly aliases: readonly string[];
}

export interface SingleTokenBlocklistEntry {
  readonly term: string;
  readonly reason: string;
}

export interface ContextualAliasGuard {
  readonly alias: string;
  readonly recordId: string;
  readonly allowedNextTokens: readonly string[];
  readonly allowAtEnd: boolean;
}

export interface CanonicalAdminRecord {
  readonly id: string;
  readonly name: string;
  readonly level: string;
  readonly aliases: readonly string[];
  readonly matchConfidence?: string | null;
}

export interface AdministrativeArea extends CanonicalAdminRecord {
  readonly districts: readonly AdministrativeDistrict[];
}

export interface AdministrativeDistrict extends CanonicalAdminRecord {
  readonly villages: readonly AdministrativeVillage[];
}

export interface AdministrativeVillage extends CanonicalAdminRecord {
  readonly parentDistrictId?: string;
  readonly parentRegionId?: string;
}

export interface UnverifiedLocality {
  readonly id: string;
  readonly name: string;
  readonly level: string;
  readonly aliases: readonly string[];
  readonly matchConfidence?: string | null;
  readonly parentDistrictId?: string;
  readonly reason?: string;
}

export interface SupplementalLocality {
  readonly term: string;
  readonly locationClass?: string;
  readonly context?: string;
  readonly matchConfidence?: string | null;
  readonly canSatisfySpecificAdministrativeLocationGate?: boolean;
}

export interface LexiconDataset {
  readonly schemaVersion: string;
  readonly datasetId: string;
  readonly datasetVersion: string;
  readonly officialBpbdLabels?: readonly unknown[];
  readonly eventGroups: readonly LexiconEventGroup[];
  readonly alertSignals: readonly LexiconAlertSignal[];
  readonly globalSupportingTerms: readonly LexiconGlobalTerm[];
  readonly legacyKeywordCoverage: readonly LexiconLegacyEntry[];
  readonly contextualOverrides: readonly LexiconOverride[];
  readonly locationRoleCues: {
    readonly sceneExamples: readonly string[];
    readonly nonSceneOrReferenceExamples: readonly string[];
    /** Office/agency names whose place tokens are not a location (DET-FILTER-03). */
    readonly agencyReferenceExamples: readonly LexiconAgencyCue[];
    /** Suffix words that make a strong event term a scene cue, e.g. "di". */
    readonly eventAnchoredSceneSuffix: readonly string[];
  };
}

export interface LexiconAgencyCue {
  readonly phrase: string;
  readonly maxGapTokens: number;
}

export interface LexiconEventGroup {
  readonly id: string;
  readonly label: string;
  readonly primaryCategoryHint: string | null;
  readonly strongTerms: readonly string[];
  readonly supportingTerms: readonly string[];
}

export interface LexiconAlertSignal {
  readonly id: string;
  readonly label: string;
  readonly terms: readonly string[];
  readonly strength: string;
}

export interface LexiconGlobalTerm {
  readonly term: string;
  readonly role?: string;
}

export interface LexiconLegacyEntry {
  readonly term: string;
  readonly mappedTo: string;
  readonly treatment: string;
}

export interface LexiconOverride {
  readonly id: string;
  readonly targetGroupIds: readonly string[];
  readonly patterns: readonly string[];
  readonly observedImpactPhrases?: readonly string[];
}

export interface DeterministicDatasets {
  readonly gazetteer: GazetteerDataset;
  readonly lexicon: LexiconDataset;
}

// ---------------------------------------------------------------------------
// Normalization (`nfkc-id-lower-space-v1`): NFKC, lowercase, punctuation and
// separators to spaces, collapse, tokenize once. Applied identically to
// dataset phrases and item text so phrase matching is symmetric.
// ---------------------------------------------------------------------------

function normalizeText(input: string): string {
  return input
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenize(normalized: string): readonly string[] {
  return normalized.length === 0 ? [] : normalized.split(" ");
}

/** Leading administrative prefixes carry no identity; strip before indexing. */
const SINGLE_LOCATION_PREFIXES: ReadonlySet<string> = new Set([
  "kecamatan",
  "kec",
  "kelurahan",
  "kel",
]);

function stripLocationPrefix(tokens: readonly string[]): readonly string[] {
  let rest = tokens;
  for (;;) {
    if (
      rest.length >= 3 &&
      (rest[0] === "kota" || rest[0] === "kabupaten") &&
      rest[1] === "administrasi"
    ) {
      rest = rest.slice(2);
      continue;
    }
    if (rest.length >= 2 && SINGLE_LOCATION_PREFIXES.has(rest[0]!)) {
      rest = rest.slice(1);
      continue;
    }
    return rest.length === 0 ? tokens : rest;
  }
}

// ---------------------------------------------------------------------------
// Loader + validation (run once; module-level lazy singleton keyed by the
// dataset versions; never re-parsed per item).
// ---------------------------------------------------------------------------

function fail(what: string): never {
  throw new Error(`[det-filter] invalid dataset: ${what}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(record: Record<string, unknown>, key: string, what: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) fail(`${what}.${key} must be a non-empty string`);
  return value as string;
}

function optionalString(record: Record<string, unknown>, key: string, what: string): string | null {
  const value = record[key];
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") fail(`${what}.${key} must be a string`);
  return value;
}

function requiredStringArray(
  record: Record<string, unknown>,
  key: string,
  what: string,
): readonly string[] {
  const value = record[key];
  if (!Array.isArray(value)) fail(`${what}.${key} must be an array`);
  for (const entry of value as readonly unknown[]) {
    if (typeof entry !== "string" || entry.trim().length === 0) {
      fail(`${what}.${key} must contain only non-empty strings`);
    }
  }
  return value as readonly string[];
}

function optionalStringArray(
  record: Record<string, unknown>,
  key: string,
  what: string,
): readonly string[] | null {
  const value = record[key];
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value)) fail(`${what}.${key} must be an array`);
  return requiredStringArray(record, key, what);
}



function parseAdminRecord(value: unknown, what: string): CanonicalAdminRecord {
  if (!isRecord(value)) fail(`${what} must be an object`);
  return {
    id: requiredString(value, "id", what),
    name: requiredString(value, "name", what),
    level: requiredString(value, "level", what),
    aliases: requiredStringArray(value, "aliases", what),
    matchConfidence: optionalString(value, "matchConfidence", what),
  };
}

function parseGazetteer(value: unknown): GazetteerDataset {
  if (!isRecord(value)) fail("gazetteer root must be an object");
  const schemaVersion = requiredString(value, "schemaVersion", "gazetteer");
  const datasetId = requiredString(value, "datasetId", "gazetteer");
  const datasetVersion = requiredString(value, "datasetVersion", "gazetteer");

  if (!isRecord(value["hierarchy"])) fail("gazetteer.hierarchy must be an object");
  const hierarchy = value["hierarchy"] as Record<string, unknown>;
  const province = parseAdminRecord(hierarchy["province"], "gazetteer.hierarchy.province");
  const rawAreas = hierarchy["administrativeAreas"];
  if (!Array.isArray(rawAreas)) fail("gazetteer.hierarchy.administrativeAreas must be an array");

  const seenIds = new Set<string>();
  const claimId = (id: string, what: string): void => {
    if (seenIds.has(id)) fail(`duplicate id ${id} (${what})`);
    seenIds.add(id);
  };

  let districtCount = 0;
  let villageCount = 0;
  const areas: AdministrativeArea[] = [];
  for (const rawArea of rawAreas as readonly unknown[]) {
    if (!isRecord(rawArea)) fail("gazetteer area must be an object");
    const base = parseAdminRecord(rawArea, "gazetteer.area");
    claimId(base.id, "area");
    const rawDistricts = rawArea["districts"];
    if (!Array.isArray(rawDistricts)) fail(`gazetteer area ${base.id} districts must be an array`);
    const districts: AdministrativeDistrict[] = [];
    for (const rawDistrict of rawDistricts as readonly unknown[]) {
      if (!isRecord(rawDistrict)) fail("gazetteer district must be an object");
      const districtBase = parseAdminRecord(rawDistrict, "gazetteer.district");
      claimId(districtBase.id, "district");
      const rawVillages = rawDistrict["villages"];
      if (!Array.isArray(rawVillages)) {
        fail(`gazetteer district ${districtBase.id} villages must be an array`);
      }
      const villages: AdministrativeVillage[] = [];
      for (const rawVillage of rawVillages as readonly unknown[]) {
        if (!isRecord(rawVillage)) fail("gazetteer village must be an object");
        const villageBase = parseAdminRecord(rawVillage, "gazetteer.village");
        claimId(villageBase.id, "village");
        villageCount += 1;
        villages.push({
          ...villageBase,
          parentDistrictId: optionalString(rawVillage, "parentDistrictId", "gazetteer.village") ?? undefined,
          parentRegionId: optionalString(rawVillage, "parentRegionId", "gazetteer.village") ?? undefined,
        });
      }
      districtCount += 1;
      districts.push({ ...districtBase, villages });
    }
    areas.push({ ...base, districts });
  }
  claimId(province.id, "province");

  if (!isRecord(value["dataQuality"])) fail("gazetteer.dataQuality must be an object");
  const quality = value["dataQuality"] as Record<string, unknown>;
  if (quality["uniqueDistricts"] !== districtCount) {
    fail(`district count ${districtCount} disagrees with dataQuality.uniqueDistricts`);
  }
  if (quality["uniqueDistricts"] !== 44) fail("gazetteer must yield exactly 44 districts");
  if (quality["canonicalAdministrativeVillages"] !== villageCount) {
    fail(`village count ${villageCount} disagrees with dataQuality.canonicalAdministrativeVillages`);
  }
  if (villageCount !== 267) fail("gazetteer must yield exactly 267 canonical kelurahan");

  const rawUnverified = value["unverifiedLocalities"];
  if (!Array.isArray(rawUnverified)) fail("gazetteer.unverifiedLocalities must be an array");
  const unverified: UnverifiedLocality[] = [];
  for (const raw of rawUnverified as readonly unknown[]) {
    if (!isRecord(raw)) fail("gazetteer unverified locality must be an object");
    const base = parseAdminRecord(raw, "gazetteer.unverifiedLocality");
    claimId(base.id, "unverified");
    unverified.push({
      ...base,
      parentDistrictId: optionalString(raw, "parentDistrictId", "gazetteer.unverifiedLocality") ?? undefined,
      reason: optionalString(raw, "reason", "gazetteer.unverifiedLocality") ?? undefined,
    });
  }
  if (!unverified.some((entry) => entry.id === "locality-koja-rawa-badak")) {
    fail("gazetteer must isolate Rawa Badak under unverifiedLocalities");
  }

  // Rawa Badak must never appear as a canonical record (exact normalized
  // alias equality; "Rawa Badak Utara/Selatan" are distinct longer phrases).
  const rawaBadakNorm = normalizeText("Rawa Badak");
  const canonicalHasRawaBadak = (record: CanonicalAdminRecord): boolean =>
    normalizeText(record.name) === rawaBadakNorm ||
    record.aliases.some((alias) => normalizeText(alias) === rawaBadakNorm);
  const queue: CanonicalAdminRecord[] = [province];
  for (const area of areas) {
    for (const district of area.districts) {
      queue.push(district, ...district.villages);
    }
  }
  if (queue.some(canonicalHasRawaBadak)) {
    fail("Rawa Badak must not appear as a canonical gazetteer record");
  }

  // DET-FILTER-03: curated named Jakarta places. Name only: they can satisfy the
  // place gate, never the administrative gate, and never carry coordinates.
  const rawPlaces = value["jakartaPlaces"];
  if (!Array.isArray(rawPlaces)) fail("gazetteer.jakartaPlaces must be an array");
  const places: JakartaPlaceRecord[] = [];
  for (const raw of rawPlaces as readonly unknown[]) {
    if (!isRecord(raw)) fail("gazetteer jakarta place must be an object");
    const id = requiredString(raw, "id", "gazetteer.jakartaPlace");
    claimId(id, "jakarta place");
    if (raw["canSatisfyPlaceGate"] !== true) fail(`gazetteer.jakartaPlace ${id} must satisfy the place gate`);
    if (raw["canSatisfySpecificAdministrativeLocationGate"] !== false) {
      fail(`gazetteer.jakartaPlace ${id} must not satisfy the administrative gate`);
    }
    if (raw["coordinates"] !== undefined && raw["coordinates"] !== null) {
      fail(`gazetteer.jakartaPlace ${id} must not carry coordinates`);
    }
    places.push({
      id,
      name: requiredString(raw, "name", "gazetteer.jakartaPlace"),
      placeClass: optionalString(raw, "placeClass", "gazetteer.jakartaPlace"),
      aliases: requiredStringArray(raw, "aliases", `gazetteer.jakartaPlace ${id}`),
    });
  }

  const rawBlocklist = value["singleTokenAliasBlocklist"];
  if (!Array.isArray(rawBlocklist)) fail("gazetteer.singleTokenAliasBlocklist must be an array");
  const blocklist: SingleTokenBlocklistEntry[] = [];
  for (const raw of rawBlocklist as readonly unknown[]) {
    if (!isRecord(raw)) fail("gazetteer blocklist entry must be an object");
    blocklist.push({
      term: requiredString(raw, "term", "gazetteer.blocklist"),
      reason: requiredString(raw, "reason", "gazetteer.blocklist"),
    });
  }

  const rawGuards = value["contextualAliasGuards"];
  if (!Array.isArray(rawGuards)) fail("gazetteer.contextualAliasGuards must be an array");
  const guards: ContextualAliasGuard[] = [];
  for (const raw of rawGuards as readonly unknown[]) {
    if (!isRecord(raw)) fail("gazetteer alias guard must be an object");
    const recordId = requiredString(raw, "recordId", "gazetteer.aliasGuard");
    if (!seenIds.has(recordId)) fail(`gazetteer.aliasGuard references unknown record ${recordId}`);
    guards.push({
      alias: requiredString(raw, "alias", "gazetteer.aliasGuard"),
      recordId,
      allowedNextTokens: requiredStringArray(raw, "allowedNextTokens", "gazetteer.aliasGuard"),
      allowAtEnd: raw["allowAtEnd"] === true,
    });
  }

  const outOfDkiCues = requiredStringArray(value, "outOfDkiHomonymCueTerms", "gazetteer");
  const rawHomonymGuards = value["jakartaPlaceHomonymGuards"];
  if (!Array.isArray(rawHomonymGuards)) fail("gazetteer.jakartaPlaceHomonymGuards must be an array");
  const homonymGuards: PlaceHomonymGuard[] = [];
  for (const raw of rawHomonymGuards as readonly unknown[]) {
    if (!isRecord(raw)) fail("gazetteer homonym guard must be an object");
    const recordId = requiredString(raw, "recordId", "gazetteer.homonymGuard");
    if (!seenIds.has(recordId)) fail(`gazetteer.homonymGuard references unknown record ${recordId}`);
    homonymGuards.push({
      recordId,
      cues: requiredStringArray(raw, "cues", "gazetteer.homonymGuard"),
    });
  }

  const rawSupplemental = value["supplementalLegacyLocalities"];
  if (!Array.isArray(rawSupplemental)) fail("gazetteer.supplementalLegacyLocalities must be an array");
  const seenTerms = new Set<string>();
  const supplemental: SupplementalLocality[] = [];
  for (const raw of rawSupplemental as readonly unknown[]) {
    if (!isRecord(raw)) fail("gazetteer supplemental locality must be an object");
    const term = requiredString(raw, "term", "gazetteer.supplemental");
    if (seenTerms.has(normalizeText(term))) fail(`duplicate supplemental term ${term}`);
    seenTerms.add(normalizeText(term));
    supplemental.push({
      term,
      locationClass: optionalString(raw, "locationClass", "gazetteer.supplemental") ?? undefined,
      context: optionalString(raw, "context", "gazetteer.supplemental") ?? undefined,
      matchConfidence: optionalString(raw, "matchConfidence", "gazetteer.supplemental") ?? undefined,
      canSatisfySpecificAdministrativeLocationGate:
        typeof raw["canSatisfySpecificAdministrativeLocationGate"] === "boolean"
          ? (raw["canSatisfySpecificAdministrativeLocationGate"] as boolean)
          : undefined,
    });
  }

  const rawCoverage = value["legacyToponymCoverage"];
  if (!Array.isArray(rawCoverage)) fail("gazetteer.legacyToponymCoverage must be an array");

  return {
    schemaVersion,
    datasetId,
    datasetVersion,
    hierarchy: { province, administrativeAreas: areas },
    unverifiedLocalities: unverified,
    jakartaPlaces: places,
    singleTokenAliasBlocklist: blocklist,
    contextualAliasGuards: guards,
    outOfDkiHomonymCueTerms: outOfDkiCues,
    jakartaPlaceHomonymGuards: homonymGuards,
    supplementalLegacyLocalities: supplemental,
    legacyToponymCoverage: rawCoverage as readonly unknown[],
  };
}

const LEGACY_TREATMENTS: ReadonlySet<string> = new Set([
  "strong",
  "supporting",
  "alert_only",
  "context_only",
]);

function parseLexicon(value: unknown): LexiconDataset {
  if (!isRecord(value)) fail("lexicon root must be an object");
  const schemaVersion = requiredString(value, "schemaVersion", "lexicon");
  const datasetId = requiredString(value, "datasetId", "lexicon");
  const datasetVersion = requiredString(value, "datasetVersion", "lexicon");

  const rawGroups = value["eventGroups"];
  if (!Array.isArray(rawGroups)) fail("lexicon.eventGroups must be an array");
  const groups: LexiconEventGroup[] = [];
  for (const raw of rawGroups as readonly unknown[]) {
    if (!isRecord(raw)) fail("lexicon event group must be an object");
    const id = requiredString(raw, "id", "lexicon.group");
    const strongTerms = requiredStringArray(raw, "strongTerms", `lexicon.group ${id}`);
    // `other_incident` intentionally has no triggers (BPBD reporting bucket);
    // every other group must carry at least one strong term.
    if (id === "other_incident") {
      if (strongTerms.length !== 0) fail("lexicon.group other_incident must have no strongTerms");
    } else if (strongTerms.length === 0) {
      fail(`lexicon.group ${id} must have non-empty strongTerms`);
    }
    const hintRaw = raw["primaryCategoryHint"];
    const hint = hintRaw === null || hintRaw === undefined ? null : String(hintRaw);
    if (hint !== null && !isOfficialIncidentCategory(hint)) {
      fail(`lexicon.group ${id} has non-official primaryCategoryHint ${hint}`);
    }
    groups.push({
      id,
      label: requiredString(raw, "label", `lexicon.group ${id}`),
      primaryCategoryHint: hint,
      strongTerms,
      supportingTerms: requiredStringArray(raw, "supportingTerms", `lexicon.group ${id}`),
    });
  }

  const rawAlerts = value["alertSignals"];
  if (!Array.isArray(rawAlerts)) fail("lexicon.alertSignals must be an array");
  const alerts: LexiconAlertSignal[] = [];
  for (const raw of rawAlerts as readonly unknown[]) {
    if (!isRecord(raw)) fail("lexicon alert signal must be an object");
    const id = requiredString(raw, "id", "lexicon.alert");
    const strength = requiredString(raw, "strength", `lexicon.alert ${id}`);
    if (strength !== "alert_only" && strength !== "context_only") {
      fail(`lexicon.alert ${id} has invalid strength ${strength}`);
    }
    alerts.push({
      id,
      label: requiredString(raw, "label", `lexicon.alert ${id}`),
      terms: requiredStringArray(raw, "terms", `lexicon.alert ${id}`),
      strength,
    });
  }

  const rawGlobal = value["globalSupportingTerms"];
  if (!Array.isArray(rawGlobal)) fail("lexicon.globalSupportingTerms must be an array");
  const globalTerms: LexiconGlobalTerm[] = [];
  for (const raw of rawGlobal as readonly unknown[]) {
    if (!isRecord(raw)) fail("lexicon global term must be an object");
    globalTerms.push({
      term: requiredString(raw, "term", "lexicon.global"),
      role: optionalString(raw, "role", "lexicon.global") ?? undefined,
    });
  }

  const rawLegacy = value["legacyKeywordCoverage"];
  if (!Array.isArray(rawLegacy)) fail("lexicon.legacyKeywordCoverage must be an array");
  const legacy: LexiconLegacyEntry[] = [];
  for (const raw of rawLegacy as readonly unknown[]) {
    if (!isRecord(raw)) fail("lexicon legacy entry must be an object");
    const treatment = requiredString(raw, "treatment", "lexicon.legacy");
    if (!LEGACY_TREATMENTS.has(treatment)) fail(`lexicon.legacy has invalid treatment ${treatment}`);
    legacy.push({
      term: requiredString(raw, "term", "lexicon.legacy"),
      mappedTo: requiredString(raw, "mappedTo", "lexicon.legacy"),
      treatment,
    });
  }

  const rawOverrides = value["contextualOverrides"];
  if (!Array.isArray(rawOverrides)) fail("lexicon.contextualOverrides must be an array");
  const overrides: LexiconOverride[] = [];
  for (const raw of rawOverrides as readonly unknown[]) {
    if (!isRecord(raw)) fail("lexicon override must be an object");
    const id = requiredString(raw, "id", "lexicon.override");
    const targetRaw = raw["targetGroupIds"];
    if (!Array.isArray(targetRaw)) fail(`lexicon.override ${id} targetGroupIds must be an array`);
    for (const target of targetRaw as readonly unknown[]) {
      if (typeof target !== "string" || target.length === 0) {
        fail(`lexicon.override ${id} has invalid target group`);
      }
    }
    overrides.push({
      id,
      targetGroupIds: targetRaw as readonly string[],
      patterns: requiredStringArray(raw, "patterns", `lexicon.override ${id}`),
      observedImpactPhrases:
        optionalStringArray(raw, "observedImpactPhrases", `lexicon.override ${id}`) ?? undefined,
    });
  }

  if (!isRecord(value["locationRoleCues"])) fail("lexicon.locationRoleCues must be an object");
  const cues = value["locationRoleCues"] as Record<string, unknown>;
  const sceneExamples = requiredStringArray(cues, "sceneExamples", "lexicon.roleCues");
  const nonSceneExamples = requiredStringArray(
    cues,
    "nonSceneOrReferenceExamples",
    "lexicon.roleCues",
  );
  if (sceneExamples.length === 0 || nonSceneExamples.length === 0) {
    fail("lexicon.locationRoleCues must carry both cue lists");
  }
  const rawAgency = cues["agencyReferenceExamples"];
  if (!Array.isArray(rawAgency)) fail("lexicon.locationRoleCues.agencyReferenceExamples must be an array");
  const agencyCues: LexiconAgencyCue[] = [];
  for (const raw of rawAgency as readonly unknown[]) {
    if (!isRecord(raw)) fail("lexicon agency cue must be an object");
    const gap = raw["maxGapTokens"];
    if (typeof gap !== "number" || !Number.isInteger(gap) || gap < 0 || gap > 3) {
      fail("lexicon agency cue maxGapTokens must be an integer from 0 to 3");
    }
    agencyCues.push({ phrase: requiredString(raw, "phrase", "lexicon.agencyCue"), maxGapTokens: gap });
  }
  const sceneSuffixes = requiredStringArray(cues, "eventAnchoredSceneSuffix", "lexicon.roleCues");

  return {
    schemaVersion,
    datasetId,
    datasetVersion,
    officialBpbdLabels: Array.isArray(value["officialBpbdLabels"])
      ? (value["officialBpbdLabels"] as readonly unknown[])
      : undefined,
    eventGroups: groups,
    alertSignals: alerts,
    globalSupportingTerms: globalTerms,
    legacyKeywordCoverage: legacy,
    contextualOverrides: overrides,
    locationRoleCues: {
      sceneExamples,
      nonSceneOrReferenceExamples: nonSceneExamples,
      agencyReferenceExamples: agencyCues,
      eventAnchoredSceneSuffix: sceneSuffixes,
    },
  };
}

// ---------------------------------------------------------------------------
// Built phrase index. Map<firstToken, entries>; longest-match-first scan with
// token boundaries at match time.
// ---------------------------------------------------------------------------

type AdminMatchLevel = DeterministicLocationMatch["level"];
type LocationStrength = DeterministicLocationMatch["matchStrength"];
type EventStrength = DeterministicEventMatch["strength"];

interface LocationIndexEntry {
  readonly kind: "location";
  readonly recordId: string;
  readonly name: string;
  readonly level: AdminMatchLevel;
  /** False for supplemental/unverified entries (never candidate-satisfying). */
  readonly canonical: boolean;
  /** True for canonical village/district records with normal confidence. */
  readonly normalConfidence: boolean;
  readonly parentDistrictId?: string;
  readonly parentRegionId?: string;
  readonly aliasText: string;
  readonly tokens: readonly string[];
}

interface EventIndexEntry {
  readonly kind: "event";
  readonly groupId: string;
  readonly label: string;
  readonly hint: string | null;
  readonly baseStrength: EventStrength;
  readonly termText: string;
  readonly tokens: readonly string[];
}

interface AliasGuardIndex {
  readonly allowedNext: ReadonlySet<string>;
  readonly allowAtEnd: boolean;
}

interface AgencyCueIndex {
  readonly tokens: readonly string[];
  readonly maxGapTokens: number;
}

interface BuiltIndex {
  readonly gazetteer: GazetteerDataset;
  readonly lexicon: LexiconDataset;
  readonly gazetteerVersion: string;
  readonly lexiconVersion: string;
  readonly locationFirst: ReadonlyMap<string, readonly LocationIndexEntry[]>;
  readonly eventFirst: ReadonlyMap<string, readonly EventIndexEntry[]>;
  /** Exact legacy term treatment override (normalized term -> treatment). */
  readonly legacyTreatment: ReadonlyMap<string, EventStrength>;
  /** Scene cues (phrases, incl. event-anchored "<strong term> di") by first token. */
  readonly sceneBuckets: ReadonlyMap<string, readonly (readonly string[])[]>;
  /** Non-scene/reference cues by first token. */
  readonly referenceBuckets: ReadonlyMap<string, readonly (readonly string[])[]>;
  readonly agencyCues: readonly AgencyCueIndex[];
  /** Homonym cues per jakarta_place record id (token phrases). */
  readonly placeHomonymCues: ReadonlyMap<string, readonly (readonly string[])[]>;
  /** Key: `${recordId}|${alias tokens}`. */
  readonly aliasGuards: ReadonlyMap<string, AliasGuardIndex>;
  readonly negationCues: ReadonlySet<string>;
  readonly floodOverride: { readonly triggers: readonly (readonly string[])[]; readonly impacts: readonly (readonly string[])[]; readonly groups: ReadonlySet<string> };
  readonly plannedTrafficPatterns: ReadonlySet<string>;
  readonly weatherOverride: { readonly triggers: readonly (readonly string[])[]; readonly impacts: readonly (readonly string[])[]; readonly groups: ReadonlySet<string> };
}

function phraseTokens(phrase: string): readonly string[] {
  return tokenize(normalizeText(phrase));
}

function buildIndex(gazetteer: GazetteerDataset, lexicon: LexiconDataset): BuiltIndex {
  const locationBuckets = new Map<string, LocationIndexEntry[]>();
  const eventBuckets = new Map<string, EventIndexEntry[]>();

  const addLocation = (entry: LocationIndexEntry): void => {
    const first = entry.tokens[0];
    if (first === undefined) return;
    const bucket = locationBuckets.get(first);
    if (bucket === undefined) {
      locationBuckets.set(first, [entry]);
      return;
    }
    // One entry per unique (record, token sequence); keep the first alias form.
    if (!bucket.some((e) => e.recordId === entry.recordId && e.tokens.join(" ") === entry.tokens.join(" "))) {
      bucket.push(entry);
    }
  };

  const addEvent = (entry: EventIndexEntry): void => {
    const first = entry.tokens[0];
    if (first === undefined) return;
    const bucket = eventBuckets.get(first);
    if (bucket === undefined) {
      eventBuckets.set(first, [entry]);
      return;
    }
    if (!bucket.some((e) => e.groupId === entry.groupId && e.tokens.join(" ") === entry.tokens.join(" "))) {
      bucket.push(entry);
    }
  };

  // DET-FILTER-03 alias policy. A single-token alias on the blocklist (an
  // ordinary word or an out-of-DKI homonym) is indexed only in its prefixed
  // multi-token form (for example "Kelurahan Baru"); the bare word never matches.
  const blocklist = new Map<string, string>(
    gazetteer.singleTokenAliasBlocklist.map((entry) => [normalizeText(entry.term), entry.reason]),
  );
  const aliasTokens = (alias: string): { readonly tokens: readonly string[]; readonly explicitMulti: boolean } | null => {
    const raw = phraseTokens(alias);
    const stripped = stripLocationPrefix(raw);
    if (stripped.length === 0) return null;
    if (stripped.length === 1 && blocklist.has(stripped[0]!)) {
      if (raw.length <= 1) return null;
      return { tokens: raw, explicitMulti: true };
    }
    return { tokens: stripped, explicitMulti: false };
  };

  const indexCanonical = (
    record: CanonicalAdminRecord,
    level: AdminMatchLevel,
    parentDistrictId?: string,
    parentRegionId?: string,
  ): void => {
    const normalConfidence = record.matchConfidence === "normal";
    for (const alias of record.aliases) {
      const resolved = aliasTokens(alias);
      if (resolved === null) continue;
      addLocation({
        kind: "location",
        recordId: record.id,
        name: record.name,
        level,
        canonical: true,
        normalConfidence: normalConfidence || resolved.explicitMulti,
        parentDistrictId,
        parentRegionId,
        aliasText: alias,
        tokens: resolved.tokens,
      });
    }
  };

  indexCanonical(gazetteer.hierarchy.province, "province");
  for (const area of gazetteer.hierarchy.administrativeAreas) {
    const areaLevel: AdminMatchLevel = area.level === "regency" ? "regency" : "city";
    indexCanonical(area, areaLevel);
    for (const district of area.districts) {
      indexCanonical(district, "district", district.id, area.id);
      for (const village of district.villages) {
        indexCanonical(
          village,
          "village",
          village.parentDistrictId ?? district.id,
          village.parentRegionId ?? area.id,
        );
      }
    }
  }

  for (const unverified of gazetteer.unverifiedLocalities) {
    for (const alias of unverified.aliases) {
      const resolved = aliasTokens(alias);
      if (resolved === null) continue;
      addLocation({
        kind: "location",
        recordId: unverified.id,
        name: unverified.name,
        level: "locality_or_area_unverified",
        canonical: false,
        normalConfidence: false,
        parentDistrictId: unverified.parentDistrictId,
        parentRegionId: undefined,
        aliasText: alias,
        tokens: resolved.tokens,
      });
    }
  }

  for (const place of gazetteer.jakartaPlaces) {
    for (const alias of place.aliases) {
      const resolved = aliasTokens(alias);
      if (resolved === null) continue;
      addLocation({
        kind: "location",
        recordId: place.id,
        name: place.name,
        level: "jakarta_place",
        canonical: false,
        normalConfidence: false,
        parentDistrictId: undefined,
        parentRegionId: undefined,
        aliasText: alias,
        tokens: resolved.tokens,
      });
    }
  }

  for (const supplemental of gazetteer.supplementalLegacyLocalities) {
    const resolved = aliasTokens(supplemental.term);
    if (resolved === null) continue;
    addLocation({
      kind: "location",
      recordId: `supplemental:${normalizeText(supplemental.term)}`,
      name: supplemental.term,
      level: "locality_or_area_unverified",
      canonical: false,
      normalConfidence: false,
      parentDistrictId: undefined,
      parentRegionId: undefined,
      aliasText: supplemental.term,
      tokens: resolved.tokens,
    });
  }

  const groupById = new Map(lexicon.eventGroups.map((group) => [group.id, group]));
  for (const group of lexicon.eventGroups) {
    for (const term of group.strongTerms) {
      const tokens = phraseTokens(term);
      if (tokens.length === 0) continue;
      addEvent({
        kind: "event", groupId: group.id, label: group.label, hint: group.primaryCategoryHint,
        baseStrength: "strong", termText: term, tokens,
      });
    }
    for (const term of group.supportingTerms) {
      const tokens = phraseTokens(term);
      if (tokens.length === 0) continue;
      addEvent({
        kind: "event", groupId: group.id, label: group.label, hint: group.primaryCategoryHint,
        baseStrength: "supporting", termText: term, tokens,
      });
    }
  }
  for (const signal of lexicon.alertSignals) {
    const strength = signal.strength === "context_only" ? "context_only" : "alert_only";
    for (const term of signal.terms) {
      const tokens = phraseTokens(term);
      if (tokens.length === 0) continue;
      addEvent({
        kind: "event", groupId: signal.id, label: signal.label, hint: null,
        baseStrength: strength, termText: term, tokens,
      });
    }
  }
  for (const entry of lexicon.globalSupportingTerms) {
    const tokens = phraseTokens(entry.term);
    if (tokens.length === 0) continue;
    addEvent({
      kind: "event", groupId: "global_supporting", label: "Global supporting terms", hint: null,
      baseStrength: "supporting", termText: entry.term, tokens,
    });
  }

  const legacyTreatment = new Map<string, EventStrength>();
  for (const entry of lexicon.legacyKeywordCoverage) {
    legacyTreatment.set(normalizeText(entry.term), entry.treatment as EventStrength);
  }
  // Ensure every legacy-mapped group target exists (or is a known pseudo
  // target: alert-signals / global-context); fail closed on typos.
  for (const entry of lexicon.legacyKeywordCoverage) {
    if (
      entry.mappedTo !== "alert-signals" &&
      entry.mappedTo !== "global-context" &&
      !groupById.has(entry.mappedTo)
    ) {
      fail(`lexicon.legacy entry ${entry.term} maps to unknown group ${entry.mappedTo}`);
    }
  }

  const overrideById = new Map(lexicon.contextualOverrides.map((o) => [o.id, o]));
  const flood = overrideById.get("forecast-only-flood-language");
  const traffic = overrideById.get("planned-traffic-management-is-not-automatically-an-incident");
  const weather = overrideById.get("weather-forecast-is-not-an-observed-damage-event");
  if (!flood || !traffic || !weather) fail("lexicon must carry all three contextual overrides");

  const bucketPhrases = (phrases: readonly (readonly string[])[]): Map<string, (readonly string[])[]> => {
    const map = new Map<string, (readonly string[])[]>();
    for (const phrase of phrases) {
      const first = phrase[0];
      if (first === undefined) continue;
      const bucket = map.get(first);
      if (bucket === undefined) map.set(first, [phrase]);
      else bucket.push(phrase);
    }
    return map;
  };

  // Scene cues: explicit scene phrases plus event-anchored "<strong term> <suffix>".
  const sceneTokenPhrases: (readonly string[])[] = lexicon.locationRoleCues.sceneExamples.map(phraseTokens);
  for (const suffix of lexicon.locationRoleCues.eventAnchoredSceneSuffix) {
    const suffixTokens = phraseTokens(suffix);
    if (suffixTokens.length === 0) continue;
    for (const group of lexicon.eventGroups) {
      for (const term of group.strongTerms) {
        const termTokens = phraseTokens(term);
        if (termTokens.length > 0) sceneTokenPhrases.push([...termTokens, ...suffixTokens]);
      }
    }
  }
  const referenceTokenPhrases: (readonly string[])[] = lexicon.locationRoleCues.nonSceneOrReferenceExamples.map(phraseTokens);

  const agencyCues: AgencyCueIndex[] = lexicon.locationRoleCues.agencyReferenceExamples
    .map((cue) => ({ tokens: phraseTokens(cue.phrase), maxGapTokens: cue.maxGapTokens }))
    .filter((cue) => cue.tokens.length > 0);

  // Homonym cues: road and toll names get the out-of-DKI city list; named
  // records add their own explicit cues (Kota Tua/Manila, Casablanca/Morocco...).
  const roadClasses: ReadonlySet<string> = new Set(["road_corridor", "elevated_road", "toll_road"]);
  const outOfDkiPhrases = gazetteer.outOfDkiHomonymCueTerms.map(phraseTokens);
  const placeHomonymCues = new Map<string, (readonly string[])[]>();
  for (const place of gazetteer.jakartaPlaces) {
    if (place.placeClass !== null && roadClasses.has(place.placeClass)) {
      placeHomonymCues.set(place.id, [...outOfDkiPhrases]);
    }
  }
  for (const guard of gazetteer.jakartaPlaceHomonymGuards) {
    const existing = placeHomonymCues.get(guard.recordId) ?? [];
    placeHomonymCues.set(guard.recordId, [...existing, ...guard.cues.map(phraseTokens)]);
  }

  const aliasGuards = new Map<string, AliasGuardIndex>();
  for (const guard of gazetteer.contextualAliasGuards) {
    aliasGuards.set(`${guard.recordId}|${phraseTokens(guard.alias).join(" ")}`, {
      allowedNext: new Set(guard.allowedNextTokens.map((token) => normalizeText(token))),
      allowAtEnd: guard.allowAtEnd,
    });
  }

  return {
    gazetteer,
    lexicon,
    gazetteerVersion: gazetteer.datasetVersion,
    lexiconVersion: lexicon.datasetVersion,
    locationFirst: locationBuckets,
    eventFirst: eventBuckets,
    legacyTreatment,
    sceneBuckets: bucketPhrases(sceneTokenPhrases),
    referenceBuckets: bucketPhrases(referenceTokenPhrases),
    agencyCues,
    placeHomonymCues,
    aliasGuards,
    negationCues: new Set(
      ["tidak", "bukan", "tanpa", "hoaks", "hoax", "simulasi", "latihan", "direncanakan", "rencana"].map(
        (cue) => normalizeText(cue),
      ),
    ),
    floodOverride: {
      triggers: flood.patterns.map(phraseTokens),
      impacts: (flood.observedImpactPhrases ?? []).map(phraseTokens),
      groups: new Set(flood.targetGroupIds),
    },
    plannedTrafficPatterns: new Set(traffic.patterns.map((pattern) => normalizeText(pattern))),
    weatherOverride: {
      triggers: weather.patterns.map(phraseTokens),
      impacts: (weather.observedImpactPhrases ?? []).map(phraseTokens),
      groups: new Set(weather.targetGroupIds),
    },
  };
}

let cachedIndex: BuiltIndex | null = null;

function built(): BuiltIndex {
  if (cachedIndex === null) {
    const gazetteer = parseGazetteer(gazetteerJson as unknown);
    const lexicon = parseLexicon(lexiconJson as unknown);
    cachedIndex = buildIndex(gazetteer, lexicon);
  }
  return cachedIndex;
}

/** Validated datasets with their versions (shares the matcher singleton). */
export function loadDeterministicDatasets(): DeterministicDatasets {
  const index = built();
  return { gazetteer: index.gazetteer, lexicon: index.lexicon };
}

export function getDeterministicDatasetVersions(): {
  readonly gazetteer: string;
  readonly lexicon: string;
  readonly rule: string;
} {
  const index = built();
  return {
    gazetteer: index.gazetteerVersion,
    lexicon: index.lexiconVersion,
    rule: DETERMINISTIC_FILTER_RULE_VERSION,
  };
}

// ---------------------------------------------------------------------------
// Matching.
// ---------------------------------------------------------------------------

interface ScanHit<E> {
  readonly entry: E;
  readonly start: number;
  readonly end: number;
}

function tokensEqualAt(tokens: readonly string[], start: number, phrase: readonly string[]): boolean {
  if (start + phrase.length > tokens.length) return false;
  for (let i = 0; i < phrase.length; i++) {
    if (tokens[start + i] !== phrase[i]) return false;
  }
  return true;
}

function anyPhraseMatches(tokens: readonly string[], phrases: readonly (readonly string[])[]): boolean {
  for (let start = 0; start < tokens.length; start++) {
    for (const phrase of phrases) {
      if (phrase.length > 0 && tokensEqualAt(tokens, start, phrase)) return true;
    }
  }
  return false;
}

/** Longest-match-first scan per start position, with token boundaries. */
function scanLongest<E extends { readonly tokens: readonly string[] }>(
  tokens: readonly string[],
  buckets: ReadonlyMap<string, readonly E[]>,
): ScanHit<E>[] {
  const hits: ScanHit<E>[] = [];
  for (let start = 0; start < tokens.length; start++) {
    const bucket = buckets.get(tokens[start]!);
    if (bucket === undefined) continue;
    let longest = 0;
    for (const entry of bucket) {
      if (entry.tokens.length > longest && tokensEqualAt(tokens, start, entry.tokens)) {
        longest = entry.tokens.length;
      }
    }
    if (longest === 0) continue;
    for (const entry of bucket) {
      if (entry.tokens.length === longest && tokensEqualAt(tokens, start, entry.tokens)) {
        hits.push({ entry, start, end: start + longest });
      }
    }
  }
  return hits;
}

/** Every occurrence of a cue phrase as a [start, end) token span. */
function findCueSpans(
  tokens: readonly string[],
  buckets: ReadonlyMap<string, readonly (readonly string[])[]>,
): Array<readonly [number, number]> {
  const spans: Array<readonly [number, number]> = [];
  for (let start = 0; start < tokens.length; start++) {
    const bucket = buckets.get(tokens[start]!);
    if (bucket === undefined) continue;
    for (const phrase of bucket) {
      if (tokensEqualAt(tokens, start, phrase)) spans.push([start, start + phrase.length] as const);
    }
  }
  return spans;
}

function spansOverlap(a: readonly [number, number], b: readonly [number, number]): boolean {
  return a[0] < b[1] && b[0] < a[1];
}

const LOCATION_SPECIFICITY: Record<AdminMatchLevel, number> = {
  // A named place is preferred over an admin record that shares its exact span
  // (for example "Cawang" the place versus "Cawang" the village), so the place
  // gate is not lost to a context-required single-token admin match.
  jakarta_place: -1,
  village: 0,
  district: 1,
  city: 2,
  regency: 2,
  province: 3,
  locality_or_area_unverified: 4,
};

function initialLocationStrength(entry: LocationIndexEntry): LocationStrength {
  if (entry.level === "jakarta_place") return "named_place";
  if (entry.level === "province" || entry.level === "city" || entry.level === "regency") return "broad_only";
  if (entry.canonical && entry.normalConfidence && entry.tokens.length > 1) return "specific";
  return "context_required";
}

/**
 * DET-FILTER-03 corroboration for a single-token canonical name.
 * - A kecamatan name in the text is itself its matching kecamatan, so a
 *   single-token kecamatan (for example Cakung) corroborates itself.
 * - A kelurahan needs its own parent kecamatan (a same-name kecamatan mention
 *   counts) or its own kota in the text.
 * A province or other-city hit never corroborates.
 */
function isCorroborated(entry: LocationIndexEntry, present: ReadonlySet<string>): boolean {
  if (entry.level === "district") return true;
  if (
    entry.parentDistrictId !== undefined &&
    entry.parentDistrictId !== entry.recordId &&
    present.has(entry.parentDistrictId)
  ) {
    return true;
  }
  return entry.parentRegionId !== undefined && present.has(entry.parentRegionId);
}

// DET-FILTER-03 dateline. A leading "<place>[, <outlet>][ (<agency>)] -" within
// the first 60 characters. Stripped only when the place is a province or
// non-DKI name; a DKI city, kecamatan, kelurahan or named place is kept.
const DATELINE_HEAD = /^\s*([^\n]{1,60}?)\s*[-–—]{1,2}\s+/u;
const DATELINE_PARTS = /^([^,(]+?)\s*(?:,\s*([^(]+?))?\s*(?:\(([^)]*)\))?$/u;
const DATELINE_MAX_PREFIX = 60;

function stripLeadingDateline(
  raw: string,
  strict: boolean,
  index: BuiltIndex,
): { readonly text: string; readonly stripped: boolean } {
  const keep = { text: raw, stripped: false } as const;
  const head = DATELINE_HEAD.exec(raw);
  if (head === null) return keep;
  const prefix = (head[1] ?? "").trim();
  if (prefix.length === 0 || prefix.length > DATELINE_MAX_PREFIX) return keep;
  const parts = DATELINE_PARTS.exec(prefix);
  if (parts === null) return keep;
  const place = (parts[1] ?? "").trim();
  const hasOutlet = (parts[2] ?? "").trim().length > 0;
  const hasAgency = (parts[3] ?? "").trim().length > 0;
  const letters = place.replace(/[^\p{L}]/gu, "");
  const allCaps = letters.length >= 2 && /\p{Lu}/u.test(letters) && !/\p{Ll}/u.test(letters);
  const words = place.split(/\s+/u).filter((word) => word.length > 0);
  const titleCase = words.length >= 1 && words.length <= 3 && words.every((word) => /^\p{Lu}/u.test(word));
  const accepted = strict
    ? allCaps || hasOutlet || hasAgency
    : allCaps || (words.length === 1 && titleCase) || ((hasOutlet || hasAgency) && titleCase);
  if (!accepted) return keep;
  const placeTokens = tokenize(normalizeText(place));
  if (placeTokens.length === 0) return keep;
  // An event term inside the lead is headline text, never a dateline.
  if (scanLongest(placeTokens, index.eventFirst).length > 0) return keep;
  // A DKI city, kecamatan, kelurahan or named place may be the incident location.
  const namesDkiPlace = scanLongest(placeTokens, index.locationFirst).some(
    (hit) => hit.entry.level !== "province" && hit.entry.level !== "locality_or_area_unverified",
  );
  if (namesDkiPlace) return keep;
  return { text: raw.slice(head[0].length), stripped: true };
}

export function matchDeterministicRelevance(
  title: string,
  descriptionExcerpt: string | null,
): DeterministicRelevanceResult {
  const index = built();
  const modifiers: string[] = [];

  // DET-FILTER-03: a leading agency dateline is removed on the raw text, before
  // normalization, when it names only the province or a non-DKI place.
  const titleLead = stripLeadingDateline(title, true, index);
  const excerptLead = descriptionExcerpt === null
    ? { text: "", stripped: false }
    : stripLeadingDateline(descriptionExcerpt, false, index);
  if (titleLead.stripped || excerptLead.stripped) modifiers.push("dateline_stripped");

  const combined = `${titleLead.text}\n${excerptLead.text}`;
  const tokens = tokenize(normalizeText(combined));

  if (tokens.length === 0) {
    return {
      status: "low_signal",
      ruleVersion: DETERMINISTIC_FILTER_RULE_VERSION,
      locationMatches: [],
      eventMatches: [],
      locationRole: "unknown",
      reasons: ["no_location_no_event"],
    };
  }

  // --- location scan: longest-match-first per start position ----------------
  const scanned = scanLongest(tokens, index.locationFirst).filter((hit) => {
    // "Ibu Kota" is Jakarta only when the following token keeps that reading.
    const guard = index.aliasGuards.get(`${hit.entry.recordId}|${hit.entry.tokens.join(" ")}`);
    if (guard === undefined) return true;
    const next = tokens[hit.end];
    return next === undefined ? guard.allowAtEnd : guard.allowedNext.has(next);
  });

  // --- agency reference cues consume the place tokens of office names -------
  // "Polda Metro Jaya", "Kapolres Jakarta Barat", "Pemprov DKI Jakarta",
  // "Sudin ... Jakarta Timur": the place that follows the agency is not a location.
  const consumed: Array<readonly [number, number]> = [];
  for (const cue of index.agencyCues) {
    for (let s = 0; s < tokens.length; s++) {
      if (!tokensEqualAt(tokens, s, cue.tokens)) continue;
      const phraseEnd = s + cue.tokens.length;
      let chosen: ScanHit<LocationIndexEntry> | undefined;
      for (const hit of scanned) {
        if (hit.start < phraseEnd || hit.start > phraseEnd + cue.maxGapTokens) continue;
        if (chosen === undefined || hit.start < chosen.start || (hit.start === chosen.start && hit.end > chosen.end)) {
          chosen = hit;
        }
      }
      consumed.push([s, chosen === undefined ? phraseEnd : chosen.end] as const);
    }
  }
  let agencyConsumed = false;
  const afterAgency = scanned.filter((hit) => {
    const inside = consumed.some(([from, to]) => from <= hit.start && hit.end <= to);
    if (inside) agencyConsumed = true;
    return !inside;
  });

  // --- homonym guard: a named place next to an out-of-DKI or foreign cue is ---
  // dropped unless the text also names a DKI anchor (kelurahan, kecamatan, city, province).
  const dkiAnchor = afterAgency.some(
    (hit) => hit.entry.level !== "jakarta_place" && hit.entry.level !== "locality_or_area_unverified",
  );
  let homonymDropped = false;
  const afterHomonym = dkiAnchor
    ? afterAgency
    : afterAgency.filter((hit) => {
      if (hit.entry.level !== "jakarta_place") return true;
      const cues = index.placeHomonymCues.get(hit.entry.recordId);
      if (cues === undefined || cues.length === 0 || !anyPhraseMatches(tokens, cues)) return true;
      homonymDropped = true;
      return false;
    });

  // --- containment: a span strictly inside a longer location span is dropped ---
  // ("Gunung" inside "Jalan Gunung Sahari", "Baru" inside "Kebayoran Baru").
  const afterContainment = afterHomonym.filter(
    (hit) =>
      !afterHomonym.some(
        (other) =>
          other !== hit &&
          other.start <= hit.start &&
          hit.end <= other.end &&
          other.end - other.start > hit.end - hit.start,
      ),
  );
  const presentRecordIds: ReadonlySet<string> = new Set(afterContainment.map((hit) => hit.entry.recordId));

  // Overlap: same token span keeps the most specific record only (a matched
  // kelurahan carries its district/city parents as hierarchy context via the
  // parent id fields, never as independent additional hits).
  const spanGroups = new Map<string, ScanHit<LocationIndexEntry>[]>();
  for (const hit of afterContainment) {
    const key = `${hit.start}:${hit.end}`;
    const group = spanGroups.get(key);
    if (group === undefined) spanGroups.set(key, [hit]);
    else group.push(hit);
  }
  const locationHits: ScanHit<LocationIndexEntry>[] = [];
  for (const group of spanGroups.values()) {
    let best = Number.POSITIVE_INFINITY;
    for (const hit of group) best = Math.min(best, LOCATION_SPECIFICITY[hit.entry.level]);
    for (const hit of group) {
      if (LOCATION_SPECIFICITY[hit.entry.level] === best) locationHits.push(hit);
    }
  }

  // --- event scan: longest-match-first per start position -------------------
  const rawEventHits = scanLongest(tokens, index.eventFirst);

  // --- strength resolution --------------------------------------------------
  // Base strength, then exact legacy-term treatment override, then
  // phrase-level contextual overrides (never whole-document deletes), then
  // windowed negation (strong within ±4 tokens of a negation cue).
  const floodTrigger = anyPhraseMatches(tokens, index.floodOverride.triggers);
  const floodImpact = anyPhraseMatches(tokens, index.floodOverride.impacts);
  const weatherTrigger = anyPhraseMatches(tokens, index.weatherOverride.triggers);
  const weatherImpact = anyPhraseMatches(tokens, index.weatherOverride.impacts);

  if (floodTrigger && !floodImpact) modifiers.push("forecast_override_applied");
  if (weatherTrigger && !weatherImpact) modifiers.push("weather_forecast_override_applied");

  interface ScoredEvent {
    readonly groupId: string;
    readonly label: string;
    readonly termText: string;
    readonly hint: string | null;
    readonly strength: EventStrength;
  }

  const scoredEvents: ScoredEvent[] = [];
  for (const hit of rawEventHits) {
    const termNorm = normalizeText(hit.entry.termText);
    let strength: EventStrength =
      index.legacyTreatment.get(termNorm) ?? hit.entry.baseStrength;
    if (
      strength === "strong" &&
      index.floodOverride.groups.has(hit.entry.groupId) &&
      floodTrigger &&
      !floodImpact
    ) {
      strength = "alert_only";
    }
    if (
      strength === "strong" &&
      index.weatherOverride.groups.has(hit.entry.groupId) &&
      weatherTrigger &&
      !weatherImpact
    ) {
      strength = "alert_only";
    }
    if (
      strength === "strong" &&
      hit.entry.groupId === "transport_disruption" &&
      index.plannedTrafficPatterns.has(termNorm)
    ) {
      // Planned-traffic patterns stay supporting; belt-and-suspenders guard
      // (the lexicon already lists them as supporting only).
      strength = "supporting";
      modifiers.push("planned_traffic_override_applied");
    }
    if (strength === "strong") {
      const windowStart = Math.max(0, hit.start - 4);
      const windowEnd = Math.min(tokens.length, hit.end + 4);
      for (let i = windowStart; i < windowEnd; i++) {
        if (i >= hit.start && i < hit.end) continue;
        if (index.negationCues.has(tokens[i]!)) {
          strength = "supporting";
          modifiers.push("negation_downgrade_applied");
          break;
        }
      }
    }
    scoredEvents.push({
      groupId: hit.entry.groupId,
      label: hit.entry.label,
      termText: hit.entry.termText,
      hint: hit.entry.hint,
      strength,
    });
  }

  // Dedupe after strength adjustments: the same (group, term, strength) from
  // two positions is one signal; a negated and an observed occurrence of the
  // same term correctly survive as separate strengths.
  const seenEvents = new Set<string>();
  const eventMatches: DeterministicEventMatch[] = [];
  for (const scored of scoredEvents) {
    const key = `${scored.groupId} ${normalizeText(scored.termText)} ${scored.strength}`;
    if (seenEvents.has(key)) continue;
    seenEvents.add(key);
    eventMatches.push({
      groupId: scored.groupId,
      label: scored.label,
      matchedTerm: scored.termText,
      strength: scored.strength,
      primaryCategoryHint: scored.hint,
    });
  }
  eventMatches.sort((a, b) =>
    a.groupId < b.groupId ? -1 : a.groupId > b.groupId ? 1 : a.matchedTerm < b.matchedTerm ? -1 : a.matchedTerm > b.matchedTerm ? 1 : 0,
  );

  // --- location strengths ---------------------------------------------------
  // Canonical village/district records with normal confidence match as
  // `specific`. Single-token canonical names start `context_required` and become
  // `specific` only with incident co-context AND a corroborating kecamatan/kota
  // of the same record (isCorroborated). Named places stay `named_place`.
  const hasIncidentCoContext = scoredEvents.some(
    (event) => event.strength === "strong" || event.strength === "supporting",
  );

  interface ScoredLocation {
    readonly entry: LocationIndexEntry;
    strength: LocationStrength;
  }

  const scoredLocations: ScoredLocation[] = locationHits.map((hit) => ({
    entry: hit.entry,
    strength: initialLocationStrength(hit.entry),
  }));

  for (const loc of scoredLocations) {
    if (loc.strength !== "context_required" || !loc.entry.canonical) continue;
    if (loc.entry.level !== "village" && loc.entry.level !== "district") continue;
    if (!hasIncidentCoContext) continue;
    if (isCorroborated(loc.entry, presentRecordIds)) loc.strength = "specific";
  }

  const seenLocations = new Set<string>();
  const locationMatches: DeterministicLocationMatch[] = [];
  for (const loc of scoredLocations) {
    const key = `${loc.entry.recordId} ${normalizeText(loc.entry.aliasText)} ${loc.strength}`;
    if (seenLocations.has(key)) continue;
    seenLocations.add(key);
    locationMatches.push({
      id: loc.entry.recordId,
      name: loc.entry.name,
      level: loc.entry.level,
      matchStrength: loc.strength,
      matchedAlias: loc.entry.aliasText,
      parentDistrictId: loc.entry.parentDistrictId,
      parentRegionId: loc.entry.parentRegionId,
    });
  }
  locationMatches.sort((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : a.matchedAlias < b.matchedAlias ? -1 : a.matchedAlias > b.matchedAlias ? 1 : 0,
  );

  // --- location role --------------------------------------------------------
  // Scene wins over reference, but only for a scene span that does not overlap
  // a reference span: "ditangkap di jalan" stays a reference, not a scene.
  // Unknown role no longer blocks candidacy (DET-FILTER-03); non-scene does.
  const sceneSpans = findCueSpans(tokens, index.sceneBuckets);
  const referenceSpans = findCueSpans(tokens, index.referenceBuckets);
  const clearScene = sceneSpans.some((span) => !referenceSpans.some((ref) => spansOverlap(span, ref)));
  const locationRole: DeterministicRelevanceResult["locationRole"] = clearScene
    ? "scene"
    : referenceSpans.length > 0
      ? "non_scene_or_reference"
      : "unknown";

  // --- status decision (conservative) ---------------------------------------
  if (agencyConsumed) modifiers.push("agency_reference_consumed");
  if (homonymDropped) modifiers.push("homonym_guard_applied");
  const hasSpecific = locationMatches.some((match) => match.matchStrength === "specific");
  const hasNamed = locationMatches.some((match) => match.matchStrength === "named_place");
  const hasBroad = locationMatches.some((match) => match.matchStrength === "broad_only");
  const hasDkiCity = locationMatches.some((match) => match.level === "city" || match.level === "regency");
  const hasPlaceGate = hasSpecific || hasNamed || hasBroad;
  const hasWeakLocation = locationMatches.some(
    (match) => match.matchStrength === "context_required",
  );
  const hasCanonicalWeak = scoredLocations.some(
    (loc) => loc.strength === "context_required" && loc.entry.canonical,
  );
  const hasStrong = eventMatches.some((match) => match.strength === "strong");
  const hasSupport = eventMatches.some((match) => match.strength === "supporting");
  const hasAlert = eventMatches.some((match) => match.strength === "alert_only");

  const modifierList = [...new Set(modifiers)].sort();

  if (hasStrong && hasPlaceGate && locationRole !== "non_scene_or_reference") {
    const placeKind = hasSpecific
      ? "specific_location"
      : hasNamed
        ? "named_place"
        : hasDkiCity
          ? "city_location"
          : "province_location";
    return {
      status: "candidate",
      ruleVersion: DETERMINISTIC_FILTER_RULE_VERSION,
      locationMatches,
      eventMatches,
      locationRole,
      reasons: [
        `${placeKind}+strong_event+${locationRole === "scene" ? "scene" : "role_unknown"}`,
        ...modifierList,
      ],
    };
  }

  if (
    !hasSpecific &&
    !hasNamed &&
    !hasBroad &&
    !hasWeakLocation &&
    !hasStrong &&
    !hasSupport &&
    !hasAlert
  ) {
    return {
      status: "low_signal",
      ruleVersion: DETERMINISTIC_FILTER_RULE_VERSION,
      locationMatches,
      eventMatches,
      locationRole,
      reasons: ["no_location_no_event", ...modifierList],
    };
  }

  const reasons: string[] = [];
  if (hasStrong && !hasPlaceGate) reasons.push("strong_event_only");
  if (hasSpecific && !hasStrong) reasons.push("specific_location_only");
  if (hasNamed && !hasSpecific && !hasStrong) reasons.push("named_place_only");
  if (hasBroad && !hasSpecific && !hasNamed && !hasStrong) reasons.push("broad_location_only");
  if (!hasSpecific && !hasNamed && !hasBroad && hasWeakLocation) {
    reasons.push(hasCanonicalWeak ? "context_required_location" : "unverified_location_only");
  }
  if (!hasStrong && (hasSupport || hasAlert)) reasons.push("supporting_or_alert_only");
  if (locationRole === "unknown") reasons.push("role_unknown");
  else if (locationRole === "non_scene_or_reference") reasons.push("role_non_scene");
  reasons.push(...modifierList);

  return {
    status: "ambiguous",
    ruleVersion: DETERMINISTIC_FILTER_RULE_VERSION,
    locationMatches,
    eventMatches,
    locationRole,
    reasons,
  };
}
