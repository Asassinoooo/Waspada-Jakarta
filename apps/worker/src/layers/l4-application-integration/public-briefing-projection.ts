import type {
  BriefingResponse,
  Category,
  EventView,
  PublicClaim,
  PublicImpact,
} from "../../contracts/public-api.js";

export interface PublicBriefingProjectionInput {
  readonly datasetMode: unknown;
  readonly request: unknown;
  readonly events: unknown;
  readonly generatedAt: unknown;
}

export type PublicBriefingProjectionErrorCode =
  | "INVALID_INPUT"
  | "DATASET_MODE_UNSUPPORTED"
  | "REQUEST_INVALID"
  | "EVENT_PAGE_INVALID"
  | "EVENT_PAGE_LIMIT_EXCEEDED"
  | "EVENT_INVALID"
  | "DUPLICATE_EVENT_ID"
  | "GENERATED_AT_INVALID";

const errorMessages: Record<PublicBriefingProjectionErrorCode, string> = {
  INVALID_INPUT: "The briefing projection input is invalid.",
  DATASET_MODE_UNSUPPORTED: "Briefings require the exact live dataset mode.",
  REQUEST_INVALID: "The briefing request is invalid.",
  EVENT_PAGE_INVALID: "The public event page is invalid.",
  EVENT_PAGE_LIMIT_EXCEEDED: "The public event page exceeds its maximum size.",
  EVENT_INVALID: "A projected public event is invalid.",
  DUPLICATE_EVENT_ID: "The public event page contains duplicate event identifiers.",
  GENERATED_AT_INVALID: "The briefing generation timestamp is invalid.",
};

/** Errors are stable and never include interest text or event content. */
export class PublicBriefingProjectionError extends Error {
  constructor(readonly code: PublicBriefingProjectionErrorCode) {
    super(errorMessages[code]);
    this.name = "PublicBriefingProjectionError";
  }
}

const maxTextInterests = 30;
const maxInterestCharacters = 128;
const maxCategories = 10;
const maxEvents = 100;

// These match the bounded L4 event projection inputs: at most 100 claim support
// references, impacts, and resolved scope keys are composed for one event.
const maxClaims = 100;
const maxImpacts = 100;
const maxSourcesPerClaim = 100;
const maxNamesPerScope = 100;

const categories = new Set<Category>([
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
const lifecycles = new Set(["planned", "ongoing", "resolved", "cancelled", "unknown"]);
const freshnessStatuses = new Set(["current", "needs_update", "expired"]);
const freshnessBases = new Set([
  "source_validity",
  "fast_observation_review",
  "undated_advisory_review",
  "manual_review",
  "unknown",
]);
const tagNamespaces = new Set(["topic", "service", "audience", "hazard", "transport_mode", "place_type"]);
const evidenceLabels = new Set([
  "issuer_notice",
  "attributed_report",
  "independent_corroboration",
  "crowdsourced_observation",
]);
const impactTypes = new Set([
  "road_closure",
  "traffic_diversion",
  "transport_service_disruption",
  "facility_closure",
  "utility_outage",
  "hazard_observation",
  "public_access_restriction",
  "event_attendance",
  "audience_notice",
  "other",
]);
const idPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u;
const tagValuePattern = /^[a-z][a-z0-9_]*$/u;
const dateTimePattern = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|([+-])(\d{2}):(\d{2}))$/u;
const datePattern = /^(\d{4})-(\d{2})-(\d{2})$/u;

const interestFields = ["places", "services", "institutions", "audiences"] as const;
type ScopeInterestField = typeof interestFields[number];

const scopeReasons: Record<ScopeInterestField, string> = {
  places: "Mencakup tempat yang Anda ikuti",
  services: "Mencakup layanan yang Anda ikuti",
  institutions: "Mencakup instansi yang Anda ikuti",
  audiences: "Mencakup kelompok yang Anda ikuti",
};

interface NormalizedInterests {
  readonly places: ReadonlySet<string>;
  readonly services: ReadonlySet<string>;
  readonly institutions: ReadonlySet<string>;
  readonly audiences: ReadonlySet<string>;
  readonly categories: ReadonlySet<Category>;
}

/**
 * Deterministically matches local interests against already projected public
 * events. This function performs no reads, writes, ranking, or model work.
 */
export function projectPublicBriefing(input: unknown): BriefingResponse {
  try {
    if (!hasExactKeys(input, ["datasetMode", "request", "events", "generatedAt"])) fail("INVALID_INPUT");
    if (input.datasetMode !== "live") fail("DATASET_MODE_UNSUPPORTED");

    const interests = validateRequest(input.request);
    if (!Array.isArray(input.events)) fail("EVENT_PAGE_INVALID");
    if (input.events.length > maxEvents) fail("EVENT_PAGE_LIMIT_EXCEEDED");
    if (!isDateTime(input.generatedAt)) fail("GENERATED_AT_INVALID");

    const seenEventIds = new Set<string>();
    const items: BriefingResponse["items"] = [];
    for (const value of input.events) {
      if (!isEventView(value)) fail("EVENT_INVALID");
      if (seenEventIds.has(value.event_id)) fail("DUPLICATE_EVENT_ID");
      seenEventIds.add(value.event_id);

      const reasons = matchReasons(value, interests);
      if (reasons.length > 0) items.push({ event: value, relevance_reasons: reasons });
    }

    return { items, generated_at: input.generatedAt };
  } catch (error) {
    if (error instanceof PublicBriefingProjectionError) throw error;
    fail("INVALID_INPUT");
  }
}

function validateRequest(value: unknown): NormalizedInterests {
  if (!hasExactKeys(value, ["interests"])) fail("REQUEST_INVALID");
  const interests = value.interests;
  const fields = [...interestFields, "categories"] as const;
  if (!hasExactKeys(interests, fields)) fail("REQUEST_INVALID");

  const normalized = {
    places: new Set<string>(),
    services: new Set<string>(),
    institutions: new Set<string>(),
    audiences: new Set<string>(),
    categories: new Set<Category>(),
  };

  for (const field of interestFields) {
    const entries = interests[field];
    if (!Array.isArray(entries) || entries.length > maxTextInterests) fail("REQUEST_INVALID");
    for (const entry of entries) {
      if (typeof entry !== "string" || codePointLength(entry) > maxInterestCharacters) fail("REQUEST_INVALID");
      const key = normalizeMatchText(entry);
      if (key.length > 0) normalized[field].add(key);
    }
  }

  const categoryEntries = interests.categories;
  if (!Array.isArray(categoryEntries) || categoryEntries.length > maxCategories) fail("REQUEST_INVALID");
  for (const entry of categoryEntries) {
    if (typeof entry !== "string" || !categories.has(entry as Category) || normalized.categories.has(entry as Category)) {
      fail("REQUEST_INVALID");
    }
    normalized.categories.add(entry as Category);
  }

  return normalized;
}

function matchReasons(event: EventView, interests: NormalizedInterests): string[] {
  const reasons: string[] = [];
  if (interests.categories.has(event.category)) reasons.push("Sesuai kategori yang Anda ikuti");

  for (const field of interestFields) {
    if (scopeMatches(field, event, interests[field])) reasons.push(scopeReasons[field]);
  }
  return reasons;
}

function scopeMatches(field: ScopeInterestField, event: EventView, interests: ReadonlySet<string>): boolean {
  if (interests.size === 0) return false;
  if (matchesAnyName(event.scope[field], interests)) return true;
  for (const claim of event.claims) {
    if (matchesAnyName(claim.scope[field], interests)) return true;
  }
  for (const impact of event.impacts) {
    if (matchesAnyName(impact.scope[field], interests)) return true;
  }
  return false;
}

function matchesAnyName(names: readonly string[], interests: ReadonlySet<string>): boolean {
  return names.some((name) => interests.has(normalizeMatchText(name)));
}

function normalizeMatchText(value: string): string {
  return value.normalize("NFC").trim().toLocaleLowerCase("id");
}

function isEventView(value: unknown): value is EventView {
  if (!hasExactKeys(value, [
    "event_id", "version", "title", "summary", "category", "tags", "lifecycle", "freshness",
    "event_time", "validity", "scope", "claims", "impacts", "published_at",
  ])) return false;
  if (!isIdentifier(value.event_id) || !isVersion(value.version)
    || !isBoundedText(value.title, 240) || !isBoundedText(value.summary, 2000)
    || !isCategory(value.category) || !isArrayOf(value.tags, isTag)
    || !lifecycles.has(String(value.lifecycle)) || !isFreshness(value.freshness)
    || !isTimeScope(value.event_time) || !isValidity(value.validity)
    || !isPublicScope(value.scope) || !isArrayOf(value.claims, isPublicClaim, maxClaims)
    || !isArrayOf(value.impacts, isPublicImpact, maxImpacts) || !isDateTime(value.published_at)) return false;
  return true;
}

function isPublicClaim(value: unknown): value is PublicClaim {
  if (!hasExactKeys(value, [
    "claim_id", "text", "event_time", "validity", "scope", "qualifiers", "evidence_label", "sources",
  ])) return false;
  return isIdentifier(value.claim_id)
    && isBoundedText(value.text, 4000)
    && isTimeScope(value.event_time)
    && isValidity(value.validity)
    && isPublicScope(value.scope)
    && isArrayOf(value.qualifiers, (item) => isBoundedText(item, 500))
    && evidenceLabels.has(String(value.evidence_label))
    && isArrayOf(value.sources, isPublicSource, maxSourcesPerClaim)
    && value.sources.length > 0;
}

function isPublicImpact(value: unknown): value is PublicImpact {
  if (!hasExactKeys(value, [
    "impact_id", "version", "impact_type", "title", "description", "lifecycle", "freshness",
    "event_time", "validity", "scope",
  ])) return false;
  return isIdentifier(value.impact_id)
    && isVersion(value.version)
    && impactTypes.has(String(value.impact_type))
    && isBoundedText(value.title, 240)
    && isBoundedText(value.description, 2000)
    && lifecycles.has(String(value.lifecycle))
    && isFreshness(value.freshness)
    && isTimeScope(value.event_time)
    && isValidity(value.validity)
    && isPublicScope(value.scope);
}

function isPublicSource(value: unknown): value is PublicClaim["sources"][number] {
  if (!hasExactKeys(value, ["display_name", "url", "published_at", "observed_at", "excerpt"])) return false;
  return isDisplayName(value.display_name)
    && isHttpsUrl(value.url)
    && isNullableDateTime(value.published_at)
    && isNullableDateTime(value.observed_at)
    && (value.excerpt === null || isBoundedText(value.excerpt, 300));
}

function isTag(value: unknown): value is EventView["tags"][number] {
  if (!hasExactKeys(value, ["namespace", "value"])) return false;
  return tagNamespaces.has(String(value.namespace))
    && typeof value.value === "string"
    && tagValuePattern.test(value.value)
    && codePointLength(value.value) <= 64;
}

function isFreshness(value: unknown): boolean {
  if (!hasExactKeys(value, ["status", "evaluated_at", "review_due_at", "basis"])) return false;
  return freshnessStatuses.has(String(value.status))
    && isDateTime(value.evaluated_at)
    && isNullableDateTime(value.review_due_at)
    && freshnessBases.has(String(value.basis));
}

function isTimeScope(value: unknown): boolean {
  if (!hasExactKeys(value, ["start", "end", "precision"])) return false;
  const { start, end, precision } = value;
  if (precision === "unknown") return start === null && end === null;
  if (precision === "exact") {
    return isDateTime(start) && (end === null || (isDateTime(end) && Date.parse(end) >= Date.parse(start)));
  }
  if (precision === "date") {
    return isDateOnly(start) && (end === null || (isDateOnly(end) && end >= start));
  }
  if (precision !== "range") return false;

  const startIsDate = isDateOnly(start);
  const endIsDate = isDateOnly(end);
  if ((!startIsDate && !isDateTime(start)) || (!endIsDate && !isDateTime(end))) return false;
  if (startIsDate && endIsDate) return end >= start;
  if (!startIsDate && !endIsDate) return Date.parse(end as string) >= Date.parse(start as string);
  return true;
}

function isValidity(value: unknown): boolean {
  if (!hasExactKeys(value, ["valid_from", "valid_until"])) return false;
  const { valid_from: start, valid_until: end } = value;
  return isNullableDateTime(start)
    && isNullableDateTime(end)
    && (start === null || end === null || Date.parse(start) < Date.parse(end));
}

function isPublicScope(value: unknown): boolean {
  if (!hasExactKeys(value, ["places", "services", "institutions", "audiences"])) return false;
  return interestFields.every((field) => isArrayOf(value[field], isDisplayName, maxNamesPerScope));
}

function isArrayOf<T>(value: unknown, validate: (item: unknown) => item is T, maximum = Number.MAX_SAFE_INTEGER): value is T[] {
  if (!Array.isArray(value) || value.length > maximum) return false;
  for (const item of value) if (!validate(item)) return false;
  return true;
}

function isDisplayName(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.trim() === value
    && codePointLength(value) <= 200;
}

function isBoundedText(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length > 0 && codePointLength(value) <= maximum;
}

function isHttpsUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 2048 || value.trim() !== value) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname.length > 0 && url.username.length === 0 && url.password.length === 0;
  } catch {
    return false;
  }
}

function isCategory(value: unknown): value is Category {
  return typeof value === "string" && categories.has(value as Category);
}

function isIdentifier(value: unknown): value is string {
  return typeof value === "string" && value.length <= 128 && idPattern.test(value);
}

function isVersion(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 && value <= 2_147_483_647;
}

function isNullableDateTime(value: unknown): value is string | null {
  return value === null || isDateTime(value);
}

function isDateTime(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = dateTimePattern.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)
    || hour > 23 || minute > 59 || second > 59) return false;
  if (match[7] !== undefined && (Number(match[8]) > 23 || Number(match[9]) > 59)) return false;
  return Number.isFinite(Date.parse(value));
}

function isDateOnly(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = datePattern.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  return year >= 1 && month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth(year, month);
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function codePointLength(value: string): number {
  return Array.from(value).length;
}

function hasExactKeys(value: unknown, expected: readonly string[]): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const ownKeys = Reflect.ownKeys(value);
  return ownKeys.length === expected.length
    && ownKeys.every((key) => typeof key === "string" && expected.includes(key))
    && expected.every((key) => Object.hasOwn(value, key));
}

function fail(code: PublicBriefingProjectionErrorCode): never {
  throw new PublicBriefingProjectionError(code);
}
