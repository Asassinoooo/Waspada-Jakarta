import type { HistoryChange } from "../../contracts/public-api.js";
import { repairLegacyPublicText, repairLegacyTitle } from "./public-projection.js";

/** HIST-UI-01: at most this many display names in each added or removed list. */
export const HISTORY_CHANGE_NAME_LIMIT = 20;

/** HIST-UI-01: a summary shown before or after a change is at most this many code points, the ellipsis included. */
export const HISTORY_SUMMARY_LIMIT = 600;

export type HistoryScopeEntityType = "place" | "service" | "institution" | "audience";

/** Approved public display names keyed by {@link historyScopeNameKey}. Built once per page. */
export type HistoryScopeNameMap = ReadonlyMap<string, string>;

const lifecycleValues = new Set<string>(["planned", "ongoing", "resolved", "cancelled", "unknown"]);
const freshnessValues = new Set<string>(["current", "needs_update", "expired"]);
const categoryPattern = /^[a-z][a-z_]{0,79}$/u;
const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u;
const timeTextPattern = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2}))?$/u;

/**
 * The public-facing values one published version is compared by. Every field here is text or a count the public
 * projection also shows. No identifier, reviewer, trace or decision value is kept. A scope list is null when it cannot
 * be shown by display name, and only that list is then left out of the comparison.
 */
export interface HistoryChangeSnapshot {
  readonly title: string;
  readonly summary: string;
  readonly category: string;
  readonly lifecycle: string;
  readonly freshness: string;
  readonly eventTime: string | null;
  readonly validity: string | null;
  readonly places: readonly string[] | null;
  readonly services: readonly string[] | null;
  readonly institutions: readonly string[] | null;
  readonly audiences: readonly string[] | null;
  readonly claimCount: number;
  readonly impactCount: number;
}

export function historyScopeNameKey(entityType: HistoryScopeEntityType, id: string): string {
  return entityType + "\u0000" + id;
}

/**
 * Reads the comparable public values of one untrusted schema 2.0 record. Returns null when a text, enum, time, validity
 * or count value cannot be read, so the entry is shown without changes. An unreadable scope, or a scope ID with no
 * approved display name, makes only that scope list null.
 */
export function readHistoryChangeSnapshot(
  recordJson: unknown,
  names: HistoryScopeNameMap,
): HistoryChangeSnapshot | null {
  if (!isRecord(recordJson)) return null;
  const title = readText(recordJson.title, 240);
  const summary = readText(recordJson.summary, 2000);
  const category = typeof recordJson.category === "string" && categoryPattern.test(recordJson.category)
    ? recordJson.category
    : undefined;
  const lifecycle = readEnumText(recordJson.lifecycle, lifecycleValues);
  const freshness = isRecord(recordJson.freshness)
    ? readEnumText(recordJson.freshness.status, freshnessValues)
    : undefined;
  const eventTime = readEventTime(recordJson.event_time);
  const validity = readValidity(recordJson.validity);
  const scope = isRecord(recordJson.scope) ? recordJson.scope : undefined;
  const claimCount = Array.isArray(recordJson.claims) ? recordJson.claims.length : undefined;
  const impactCount = Array.isArray(recordJson.impact_refs) ? recordJson.impact_refs.length : undefined;

  if (title === undefined || summary === undefined || category === undefined || lifecycle === undefined
    || freshness === undefined || eventTime === undefined || validity === undefined
    || claimCount === undefined || impactCount === undefined) {
    return null;
  }
  return {
    // The same repairs the public EventView applies, so a repair-only difference is not reported as a change.
    title: repairLegacyTitle(title),
    summary: repairLegacyPublicText(summary),
    category,
    lifecycle,
    freshness,
    eventTime,
    validity,
    places: readScopeList(scope, "place_ids", "place", names),
    services: readScopeList(scope, "service_ids", "service", names),
    institutions: readScopeList(scope, "institution_ids", "institution", names),
    audiences: readScopeList(scope, "audience_ids", "audience", names),
    claimCount,
    impactCount,
  };
}

/**
 * Lists the fields that differ, in the HistoryChange field order. Text and count fields always compare. A scope list
 * compares by display name, as the public event shows it, and is skipped when either side is null. A summary is
 * compared in full but shown capped. Claims and impacts are compared by count.
 */
export function diffHistoryChangeSnapshots(
  before: HistoryChangeSnapshot,
  after: HistoryChangeSnapshot,
): HistoryChange[] {
  const changes: HistoryChange[] = [];

  const textPairs: ReadonlyArray<readonly [
    "title" | "summary" | "category" | "lifecycle" | "freshness" | "event_time" | "validity",
    string | null,
    string | null,
  ]> = [
    ["title", before.title, after.title],
    ["summary", before.summary, after.summary],
    ["category", before.category, after.category],
    ["lifecycle", before.lifecycle, after.lifecycle],
    ["freshness", before.freshness, after.freshness],
    ["event_time", before.eventTime, after.eventTime],
    ["validity", before.validity, after.validity],
  ];
  for (const [field, previous, current] of textPairs) {
    if (previous === current) continue;
    changes.push(field === "summary"
      ? { field, before: capHistorySummary(previous), after: capHistorySummary(current) }
      : { field, before: previous, after: current });
  }

  const scopePairs: ReadonlyArray<readonly [
    "places" | "services" | "institutions" | "audiences",
    readonly string[] | null,
    readonly string[] | null,
  ]> = [
    ["places", before.places, after.places],
    ["services", before.services, after.services],
    ["institutions", before.institutions, after.institutions],
    ["audiences", before.audiences, after.audiences],
  ];
  for (const [field, previous, current] of scopePairs) {
    // An unresolved list is left out of this comparison only. Every other field still compares.
    if (previous === null || current === null) continue;
    const previousNames = new Set(previous);
    const currentNames = new Set(current);
    const added = sortedCappedNames(current.filter((name) => !previousNames.has(name)));
    const removed = sortedCappedNames(previous.filter((name) => !currentNames.has(name)));
    if (added.length > 0 || removed.length > 0) changes.push({ field, added, removed });
  }

  if (before.claimCount !== after.claimCount) {
    changes.push({ field: "claims", before_count: before.claimCount, after_count: after.claimCount });
  }
  if (before.impactCount !== after.impactCount) {
    changes.push({ field: "impacts", before_count: before.impactCount, after_count: after.impactCount });
  }
  return changes;
}

/**
 * HIST-UI-01: a summary longer than HISTORY_SUMMARY_LIMIT code points is cut at the last whitespace that keeps it within
 * the limit, then ends with "…". A text with no whitespace in reach is cut at the limit. The result never exceeds the limit.
 */
export function capHistorySummaryText(text: string): string {
  const points = Array.from(text);
  if (points.length <= HISTORY_SUMMARY_LIMIT) return text;
  const head = points.slice(0, HISTORY_SUMMARY_LIMIT - 1);
  let cut = head.length;
  for (let index = head.length - 1; index > 0; index -= 1) {
    if (/\s/u.test(head[index]!)) {
      cut = index;
      break;
    }
  }
  return head.slice(0, cut).join("").trimEnd() + "…";
}

function capHistorySummary(value: string | null): string | null {
  return value === null ? null : capHistorySummaryText(value);
}

/** Null when the scope is unreadable, the list is malformed, or one ID has no approved display name. */
function readScopeList(
  scope: Record<string, unknown> | undefined,
  key: string,
  entityType: HistoryScopeEntityType,
  names: HistoryScopeNameMap,
): string[] | null {
  if (scope === undefined) return null;
  return readNamedIds(scope[key], entityType, names) ?? null;
}

function readNamedIds(
  value: unknown,
  entityType: HistoryScopeEntityType,
  names: HistoryScopeNameMap,
): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const result: string[] = [];
  for (const id of value) {
    if (typeof id !== "string" || !identifierPattern.test(id)) return undefined;
    const displayName = names.get(historyScopeNameKey(entityType, id));
    if (displayName === undefined) return undefined;
    result.push(displayName);
  }
  return result;
}

/** Undefined when unreadable. Null when the value is absent, which is a real comparable state. */
function readEventTime(value: unknown): string | null | undefined {
  if (!isRecord(value)) return undefined;
  const precision = value.precision;
  if (precision !== "exact" && precision !== "date" && precision !== "range" && precision !== "unknown") {
    return undefined;
  }
  if (precision === "unknown") return null;
  const start = readOptionalTime(value.start);
  const end = readOptionalTime(value.end);
  if (start === undefined || end === undefined) return undefined;
  return precision + " " + (start ?? "-") + " " + (end ?? "-");
}

/** Null means no validity window at all. Undefined means unreadable. */
function readValidity(value: unknown): string | null | undefined {
  if (!isRecord(value)) return undefined;
  const from = readOptionalTime(value.valid_from);
  const until = readOptionalTime(value.valid_until);
  if (from === undefined || until === undefined) return undefined;
  if (from === null && until === null) return null;
  return (from ?? "-") + " " + (until ?? "-");
}

function readOptionalTime(value: unknown): string | null | undefined {
  if (value === null) return null;
  return typeof value === "string" && value.length <= 64 && timeTextPattern.test(value)
    && Number.isFinite(Date.parse(value))
    ? value
    : undefined;
}

function readText(value: unknown, maxCodePoints: number): string | undefined {
  return typeof value === "string" && value.trim().length > 0 && Array.from(value).length <= maxCodePoints
    ? value
    : undefined;
}

function readEnumText(value: unknown, allowed: ReadonlySet<string>): string | undefined {
  return typeof value === "string" && allowed.has(value) ? value : undefined;
}

function sortedCappedNames(values: readonly string[]): string[] {
  return [...new Set(values)]
    .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
    .slice(0, HISTORY_CHANGE_NAME_LIMIT);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
