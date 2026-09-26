import type { Category } from "@waspada/worker/public-contracts";

export const PREFERENCES_STORAGE_KEY = "waspada-jakarta:preferences:v1";
export const PREFERENCES_SCHEMA_VERSION = 1;
export const MAX_TEXT_INTERESTS = 30;
export const MAX_INTEREST_CHARACTERS = 128;
export const MAX_CATEGORIES = 10;

export const TEXT_INTEREST_FIELDS = ["places", "services", "institutions", "audiences"] as const;
export type TextInterestField = typeof TEXT_INTEREST_FIELDS[number];

export interface BriefingInterests {
  places: string[];
  services: string[];
  institutions: string[];
  audiences: string[];
  categories: Category[];
}

export const CATEGORY_VALUES: readonly Category[] = [
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
];

export interface PreferencesStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export type LoadPreferencesResult =
  | { status: "empty"; interests: BriefingInterests }
  | { status: "loaded"; interests: BriefingInterests }
  | { status: "malformed"; issue: "invalid-json" | "unsupported-version" | "invalid-shape" }
  | { status: "unavailable"; operation: "read" };

export type SavePreferencesResult =
  | { status: "saved"; interests: BriefingInterests }
  | { status: "invalid"; field: TextInterestField | "categories" | "interests"; issue: "invalid-shape" | "too-many" | "too-long" | "invalid-category" }
  | { status: "unavailable"; operation: "write" };

export type ClearPreferencesResult =
  | { status: "cleared" }
  | { status: "unavailable"; operation: "clear" };

export type AddInterestResult =
  | { status: "added"; values: string[] }
  | { status: "empty" | "duplicate" | "too-long" | "too-many"; values: string[] };

type NormalizedText =
  | { status: "value"; value: string; identity: string }
  | { status: "empty" }
  | { status: "too-long" };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeText(value: string): NormalizedText {
  const normalized = value.normalize("NFC").trim();
  if (normalized.length === 0) return { status: "empty" };
  if ([...normalized].length > MAX_INTEREST_CHARACTERS) return { status: "too-long" };
  return { status: "value", value: normalized, identity: normalized.toLocaleLowerCase("id-ID") };
}

export function emptyInterests(): BriefingInterests {
  return { places: [], services: [], institutions: [], audiences: [], categories: [] };
}

export function addInterestValue(values: readonly string[], rawValue: string): AddInterestResult {
  const normalized = normalizeText(rawValue);
  if (normalized.status !== "value") return { status: normalized.status, values: [...values] };

  const identities = new Set(values.map((value) => normalizeText(value)).filter((value) => value.status === "value").map((value) => value.identity));
  if (identities.has(normalized.identity)) return { status: "duplicate", values: [...values] };
  if (values.length >= MAX_TEXT_INTERESTS) return { status: "too-many", values: [...values] };
  return { status: "added", values: [...values, normalized.value] };
}

export type InterestsValidationResult =
  | { ok: true; interests: BriefingInterests }
  | { ok: false; field: TextInterestField | "categories" | "interests"; issue: "invalid-shape" | "too-many" | "too-long" | "invalid-category" };

export function normalizeInterests(value: unknown): InterestsValidationResult {
  if (!isRecord(value)) return { ok: false, field: "interests", issue: "invalid-shape" };
  const expectedFields = [...TEXT_INTEREST_FIELDS, "categories"];
  if (Object.keys(value).length !== expectedFields.length || expectedFields.some((field) => !(field in value))) {
    return { ok: false, field: "interests", issue: "invalid-shape" };
  }

  const normalized = emptyInterests();
  for (const field of TEXT_INTEREST_FIELDS) {
    const entries = value[field];
    if (!Array.isArray(entries)) return { ok: false, field, issue: "invalid-shape" };
    if (entries.length > MAX_TEXT_INTERESTS) return { ok: false, field, issue: "too-many" };
    const seen = new Set<string>();
    const values: string[] = [];
    for (const entry of entries) {
      if (typeof entry !== "string") return { ok: false, field, issue: "invalid-shape" };
      const item = normalizeText(entry);
      if (item.status === "too-long") return { ok: false, field, issue: "too-long" };
      if (item.status === "empty" || seen.has(item.identity)) continue;
      seen.add(item.identity);
      values.push(item.value);
    }
    normalized[field] = values;
  }

  const categoryEntries = value.categories;
  if (!Array.isArray(categoryEntries)) return { ok: false, field: "categories", issue: "invalid-shape" };
  if (categoryEntries.length > MAX_CATEGORIES) return { ok: false, field: "categories", issue: "too-many" };
  const categories: Category[] = [];
  const seenCategories = new Set<Category>();
  for (const entry of categoryEntries) {
    if (typeof entry !== "string" || !CATEGORY_VALUES.includes(entry as Category)) {
      return { ok: false, field: "categories", issue: "invalid-category" };
    }
    const category = entry as Category;
    if (!seenCategories.has(category)) {
      seenCategories.add(category);
      categories.push(category);
    }
  }
  normalized.categories = categories;
  return { ok: true, interests: normalized };
}

export function loadPreferences(storage: PreferencesStorage | null | undefined): LoadPreferencesResult {
  if (!storage) return { status: "unavailable", operation: "read" };

  let raw: string | null;
  try {
    raw = storage.getItem(PREFERENCES_STORAGE_KEY);
  } catch {
    return { status: "unavailable", operation: "read" };
  }
  if (raw === null) return { status: "empty", interests: emptyInterests() };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { status: "malformed", issue: "invalid-json" };
  }
  if (!isRecord(parsed) || parsed.version !== PREFERENCES_SCHEMA_VERSION) {
    return { status: "malformed", issue: "unsupported-version" };
  }
  if (Object.keys(parsed).length !== 2 || !("interests" in parsed)) {
    return { status: "malformed", issue: "invalid-shape" };
  }
  const validation = normalizeInterests(parsed.interests);
  if (!validation.ok) return { status: "malformed", issue: "invalid-shape" };
  return { status: "loaded", interests: validation.interests };
}

export function savePreferences(
  storage: PreferencesStorage | null | undefined,
  interests: unknown,
): SavePreferencesResult {
  const validation = normalizeInterests(interests);
  if (!validation.ok) return { status: "invalid", ...validation };
  if (!storage) return { status: "unavailable", operation: "write" };

  try {
    storage.setItem(PREFERENCES_STORAGE_KEY, JSON.stringify({
      version: PREFERENCES_SCHEMA_VERSION,
      interests: validation.interests,
    }));
    return { status: "saved", interests: validation.interests };
  } catch {
    return { status: "unavailable", operation: "write" };
  }
}

export function clearPreferences(storage: PreferencesStorage | null | undefined): ClearPreferencesResult {
  if (!storage) return { status: "unavailable", operation: "clear" };
  try {
    storage.removeItem(PREFERENCES_STORAGE_KEY);
    return { status: "cleared" };
  } catch {
    return { status: "unavailable", operation: "clear" };
  }
}

export function browserPreferencesStorage(): PreferencesStorage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}