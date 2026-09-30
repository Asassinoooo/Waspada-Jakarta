import type { FreshnessStatus } from "../../contracts/public-api.js";

export interface FreshnessAggregateInput {
  /** Freshness of the event's grouped public claim set. */
  readonly claimSetStatus: FreshnessStatus;
  /** Freshness from each exact impact version referenced by the current event version. */
  readonly impactStatuses: readonly FreshnessStatus[];
}

const freshnessStatuses: ReadonlySet<string> = new Set(["current", "needs_update", "expired"]);
const inputKeys: ReadonlySet<string> = new Set(["claimSetStatus", "impactStatuses"]);

/** Stable input failure that never echoes the supplied value. */
export class FreshnessAggregatePolicyError extends Error {
  readonly code = "INVALID_INPUT" as const;

  constructor() {
    super("Invalid freshness aggregation input.");
    this.name = "FreshnessAggregatePolicyError";
  }
}

/**
 * Derives only the event-level status from its grouped claim set and exact
 * current-public impact versions. It has no clock, I/O, or lifecycle behavior.
 */
export function aggregateEventFreshnessStatus(input: FreshnessAggregateInput): FreshnessStatus {
  const { claimSetStatus, impactStatuses } = validateInput(input);
  const statuses = [claimSetStatus, ...impactStatuses];

  if (statuses.includes("needs_update")) return "needs_update";
  const hasCurrent = statuses.includes("current");
  const hasExpired = statuses.includes("expired");
  if (hasCurrent && hasExpired) return "needs_update";
  return hasExpired ? "expired" : "current";
}

function validateInput(input: unknown): FreshnessAggregateInput {
  if (typeof input !== "object" || input === null || Array.isArray(input)) fail();
  const record = input as Record<string, unknown>;
  let keys: (string | symbol)[];
  try {
    keys = Reflect.ownKeys(record);
  } catch {
    fail();
  }
  if (keys.length !== inputKeys.size || keys.some((key) => typeof key !== "string" || !inputKeys.has(key))) fail();
  if (!isFreshnessStatus(record.claimSetStatus) || !Array.isArray(record.impactStatuses)) fail();

  const impactStatuses: FreshnessStatus[] = [];
  for (const status of record.impactStatuses) {
    if (!isFreshnessStatus(status)) fail();
    impactStatuses.push(status);
  }
  return { claimSetStatus: record.claimSetStatus, impactStatuses };
}

function isFreshnessStatus(value: unknown): value is FreshnessStatus {
  return typeof value === "string" && freshnessStatuses.has(value);
}

function fail(): never {
  throw new FreshnessAggregatePolicyError();
}
