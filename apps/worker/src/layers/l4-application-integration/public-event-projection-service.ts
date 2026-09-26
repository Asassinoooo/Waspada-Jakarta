import type { EventView } from "../../contracts/public-api.js";
import { projectPublicEvent } from "./public-projection.js";

export type PublicEventProjectionScopeEntityType = "place" | "service" | "institution" | "audience";

export interface PublicEventProjectionSnapshotImpact {
  readonly eventId: string;
  readonly eventVersion: number;
  readonly impactId: string;
  readonly impactVersion: number;
  readonly recordJson: unknown;
}

export interface PublicEventProjectionSnapshot {
  readonly datasetKind: "live";
  readonly eventId: string;
  readonly eventVersion: number;
  readonly recordJson: unknown;
  readonly impacts: readonly PublicEventProjectionSnapshotImpact[];
}

export type PublicEventProjectionSnapshotReadResult =
  | { readonly kind: "found"; readonly snapshot: PublicEventProjectionSnapshot }
  | { readonly kind: "missing" };

export interface PublicEventProjectionSnapshotReadPort {
  read(eventId: unknown): Promise<PublicEventProjectionSnapshotReadResult>;
}

export interface PublicEventProjectionScopeKey {
  readonly entityType: PublicEventProjectionScopeEntityType;
  readonly entityId: string;
}

export interface PublicEventProjectionSupportReference {
  readonly reportRevisionId: string;
  readonly permittedTextHash: string;
  readonly spanStart: number;
  readonly spanEnd: number;
  readonly offsetUnit: "unicode_code_points";
  readonly relation: "supports";
}

export interface PublicEventProjectionLookupQuery {
  readonly scopeKeys: readonly PublicEventProjectionScopeKey[];
  readonly supportReferences: readonly PublicEventProjectionSupportReference[];
}

export interface PublicEventProjectionLookupResult {
  readonly scopeNames: readonly unknown[];
  readonly publicAttributions: readonly unknown[];
}

export interface PublicEventProjectionLookupReadPort {
  resolve(input: PublicEventProjectionLookupQuery): Promise<PublicEventProjectionLookupResult>;
}

export interface PublicEventProjectionService {
  read(eventId: unknown): Promise<PublicEventProjectionReadResult>;
}

export type PublicEventProjectionReadResult =
  | { readonly kind: "found"; readonly event: EventView }
  | { readonly kind: "missing" };

export type PublicEventProjectionServiceErrorCode =
  | "INVALID_EVENT_ID"
  | "SNAPSHOT_READ_FAILED"
  | "SNAPSHOT_INVALID"
  | "LOOKUP_LIMIT_EXCEEDED"
  | "LOOKUP_READ_FAILED"
  | "LOOKUP_RESULT_INVALID"
  | "PROJECTION_FAILED";

const errorMessages: Record<PublicEventProjectionServiceErrorCode, string> = {
  INVALID_EVENT_ID: "The event identifier is invalid.",
  SNAPSHOT_READ_FAILED: "The current public event snapshot could not be read.",
  SNAPSHOT_INVALID: "The current public event snapshot is invalid.",
  LOOKUP_LIMIT_EXCEEDED: "The public projection exceeds its lookup limit.",
  LOOKUP_READ_FAILED: "The public projection lookups could not be read.",
  LOOKUP_RESULT_INVALID: "The public projection lookup result is invalid.",
  PROJECTION_FAILED: "The event cannot be projected to a public view.",
};

/** Bounded service errors never include event IDs, lookup keys, or record content. */
export class PublicEventProjectionServiceError extends Error {
  constructor(readonly code: PublicEventProjectionServiceErrorCode) {
    super(errorMessages[code]);
    this.name = "PublicEventProjectionServiceError";
  }
}

const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u;
const hashPattern = /^[a-f0-9]{64}$/u;
const maxIdentifierLength = 128;
const maxVersion = 2_147_483_647;
const maxEvidenceOffset = 10_000_000;
const maxImpacts = 100;
const maxScopeKeys = 100;
const maxSupportReferences = 100;

const scopeFields = [
  { field: "place_ids", entityType: "place" },
  { field: "service_ids", entityType: "service" },
  { field: "institution_ids", entityType: "institution" },
  { field: "audience_ids", entityType: "audience" },
] as const;

interface PreparedSnapshot {
  readonly eventRecord: Record<string, unknown>;
  readonly impactRecords: readonly unknown[];
  readonly query: PublicEventProjectionLookupQuery;
}

/**
 * Composes one current published-event snapshot with exact reviewed lookup rows,
 * then delegates the public allowlist and record validation to projectPublicEvent.
 */
export function createPublicEventProjectionService(ports: {
  readonly snapshots: PublicEventProjectionSnapshotReadPort;
  readonly lookups: PublicEventProjectionLookupReadPort;
}): PublicEventProjectionService {
  return {
    async read(eventId: unknown): Promise<PublicEventProjectionReadResult> {
      if (!isIdentifier(eventId)) fail("INVALID_EVENT_ID");

      let readResult: PublicEventProjectionSnapshotReadResult;
      try {
        readResult = await ports.snapshots.read(eventId);
      } catch {
        fail("SNAPSHOT_READ_FAILED");
      }

      let prepared: PreparedSnapshot;
      try {
        if (!isRecord(readResult)) fail("SNAPSHOT_INVALID");
        if (readResult.kind === "missing") return { kind: "missing" };
        if (readResult.kind !== "found") fail("SNAPSHOT_INVALID");
        prepared = prepareSnapshot(readResult.snapshot, eventId);
      } catch (error) {
        if (error instanceof PublicEventProjectionServiceError) throw error;
        fail("SNAPSHOT_INVALID");
      }

      let lookupResult: PublicEventProjectionLookupResult;
      try {
        lookupResult = await ports.lookups.resolve(prepared.query);
      } catch {
        fail("LOOKUP_READ_FAILED");
      }

      let validatedLookupResult: PublicEventProjectionLookupResult;
      try {
        validatedLookupResult = validateLookupResult(lookupResult);
      } catch {
        fail("LOOKUP_RESULT_INVALID");
      }

      let event: EventView;
      try {
        event = projectPublicEvent(prepared.eventRecord, {
          scopeNames: validatedLookupResult.scopeNames,
          publicAttributions: validatedLookupResult.publicAttributions,
          impacts: prepared.impactRecords,
        });
      } catch {
        fail("PROJECTION_FAILED");
      }

      return { kind: "found", event };
    },
  };
}

function validateLookupResult(value: unknown): PublicEventProjectionLookupResult {
  if (!isRecord(value) || !Array.isArray(value.scopeNames) || !Array.isArray(value.publicAttributions)) {
    fail("LOOKUP_RESULT_INVALID");
  }
  for (const attribution of value.publicAttributions) {
    if (!isRecord(attribution)
      || attribution.excerpt_public_use_approved !== false
      || attribution.excerpt !== null) {
      fail("LOOKUP_RESULT_INVALID");
    }
  }
  return {
    scopeNames: value.scopeNames,
    publicAttributions: value.publicAttributions,
  };
}

function prepareSnapshot(value: unknown, requestedEventId: string): PreparedSnapshot {
  if (!isRecord(value)
    || value.datasetKind !== "live"
    || !isIdentifier(value.eventId)
    || value.eventId !== requestedEventId
    || !isVersion(value.eventVersion)
    || !isRecord(value.recordJson)
    || !Array.isArray(value.impacts)
    || value.impacts.length > maxImpacts) {
    fail("SNAPSHOT_INVALID");
  }

  const eventRecord = value.recordJson;
  if (eventRecord.schema_version !== "2.0"
    || eventRecord.record_type !== "Event"
    || eventRecord.dataset_kind !== value.datasetKind
    || eventRecord.event_id !== value.eventId
    || eventRecord.version !== value.eventVersion) {
    fail("SNAPSHOT_INVALID");
  }

  const scopeKeys = new Map<string, PublicEventProjectionScopeKey>();
  collectScopeKeys(eventRecord.scope, scopeKeys);

  if (!Array.isArray(eventRecord.claims) || eventRecord.claims.length === 0) fail("SNAPSHOT_INVALID");
  const supportReferences = new Map<string, PublicEventProjectionSupportReference>();
  for (const claimValue of eventRecord.claims) {
    if (!isRecord(claimValue)) fail("SNAPSHOT_INVALID");
    collectScopeKeys(claimValue.scope, scopeKeys);
    if (!Array.isArray(claimValue.support) || claimValue.support.length === 0) fail("SNAPSHOT_INVALID");

    const claimReferenceKeys = new Set<string>();
    for (const supportValue of claimValue.support) {
      const reference = readSupportReference(supportValue);
      const key = supportReferenceKey(reference);
      if (claimReferenceKeys.has(key)) fail("SNAPSHOT_INVALID");
      claimReferenceKeys.add(key);
      if (!supportReferences.has(key)) {
        supportReferences.set(key, reference);
        if (supportReferences.size > maxSupportReferences) fail("LOOKUP_LIMIT_EXCEEDED");
      }
    }
  }

  const expectedImpactKeys = readImpactReferences(eventRecord.impact_refs);
  if (expectedImpactKeys.size !== value.impacts.length) fail("SNAPSHOT_INVALID");

  const impactKeys = new Set<string>();
  const impactRecords: unknown[] = [];
  for (const impactValue of value.impacts) {
    if (!isRecord(impactValue)
      || impactValue.eventId !== value.eventId
      || impactValue.eventVersion !== value.eventVersion
      || !isIdentifier(impactValue.impactId)
      || !isVersion(impactValue.impactVersion)
      || !isRecord(impactValue.recordJson)) {
      fail("SNAPSHOT_INVALID");
    }

    const impactRecord = impactValue.recordJson;
    if (impactRecord.schema_version !== "2.0"
      || impactRecord.record_type !== "Impact"
      || impactRecord.dataset_kind !== value.datasetKind
      || impactRecord.event_id !== value.eventId
      || impactRecord.event_version !== value.eventVersion
      || impactRecord.impact_id !== impactValue.impactId
      || impactRecord.version !== impactValue.impactVersion) {
      fail("SNAPSHOT_INVALID");
    }

    const impactKey = impactReferenceKey(impactValue.impactId, impactValue.impactVersion);
    if (impactKeys.has(impactKey) || !expectedImpactKeys.has(impactKey)) fail("SNAPSHOT_INVALID");
    impactKeys.add(impactKey);
    collectScopeKeys(impactRecord.scope, scopeKeys);
    impactRecords.push(impactRecord);
  }
  if (impactKeys.size !== expectedImpactKeys.size) fail("SNAPSHOT_INVALID");

  if (scopeKeys.size > maxScopeKeys || supportReferences.size > maxSupportReferences) {
    fail("LOOKUP_LIMIT_EXCEEDED");
  }

  return {
    eventRecord,
    impactRecords,
    query: {
      scopeKeys: [...scopeKeys.values()].sort(compareScopeKeys),
      supportReferences: [...supportReferences.values()].sort(compareSupportReferences),
    },
  };
}

function collectScopeKeys(
  value: unknown,
  scopeKeys: Map<string, PublicEventProjectionScopeKey>,
): void {
  if (!isRecord(value)) fail("SNAPSHOT_INVALID");
  for (const { field, entityType } of scopeFields) {
    const values = value[field];
    if (!Array.isArray(values)) fail("SNAPSHOT_INVALID");
    const localIds = new Set<string>();
    for (const candidate of values) {
      if (!isIdentifier(candidate) || localIds.has(candidate)) fail("SNAPSHOT_INVALID");
      localIds.add(candidate);
      const key = { entityType, entityId: candidate } satisfies PublicEventProjectionScopeKey;
      const identity = JSON.stringify([key.entityType, key.entityId]);
      if (!scopeKeys.has(identity)) {
        scopeKeys.set(identity, key);
        if (scopeKeys.size > maxScopeKeys) fail("LOOKUP_LIMIT_EXCEEDED");
      }
    }
  }
}

function readSupportReference(value: unknown): PublicEventProjectionSupportReference {
  if (!isRecord(value)
    || !isIdentifier(value.report_revision_id)
    || typeof value.permitted_text_hash !== "string"
    || !hashPattern.test(value.permitted_text_hash)
    || !isSafeInteger(value.span_start, 0, maxEvidenceOffset)
    || !isSafeInteger(value.span_end, 1, maxEvidenceOffset)
    || value.span_end <= value.span_start
    || value.offset_unit !== "unicode_code_points"
    || value.relation !== "supports") {
    fail("SNAPSHOT_INVALID");
  }
  return {
    reportRevisionId: value.report_revision_id,
    permittedTextHash: value.permitted_text_hash,
    spanStart: value.span_start,
    spanEnd: value.span_end,
    offsetUnit: "unicode_code_points",
    relation: "supports",
  };
}

function readImpactReferences(value: unknown): Set<string> {
  if (!Array.isArray(value) || value.length > maxImpacts) fail("SNAPSHOT_INVALID");
  const keys = new Set<string>();
  for (const reference of value) {
    if (!isRecord(reference) || !isIdentifier(reference.impact_id) || !isVersion(reference.version)) {
      fail("SNAPSHOT_INVALID");
    }
    const key = impactReferenceKey(reference.impact_id, reference.version);
    if (keys.has(key)) fail("SNAPSHOT_INVALID");
    keys.add(key);
  }
  return keys;
}

function isIdentifier(value: unknown): value is string {
  return typeof value === "string"
    && value.length <= maxIdentifierLength
    && identifierPattern.test(value);
}

function isVersion(value: unknown): value is number {
  return isSafeInteger(value, 1, maxVersion);
}

function isSafeInteger(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === "number"
    && Number.isSafeInteger(value)
    && value >= minimum
    && value <= maximum;
}

function supportReferenceKey(value: PublicEventProjectionSupportReference): string {
  return JSON.stringify([
    value.reportRevisionId,
    value.permittedTextHash,
    value.spanStart,
    value.spanEnd,
    value.offsetUnit,
    value.relation,
  ]);
}

function impactReferenceKey(impactId: string, impactVersion: number): string {
  return JSON.stringify([impactId, impactVersion]);
}

function compareScopeKeys(left: PublicEventProjectionScopeKey, right: PublicEventProjectionScopeKey): number {
  return compareStrings(left.entityType, right.entityType) || compareStrings(left.entityId, right.entityId);
}

function compareSupportReferences(
  left: PublicEventProjectionSupportReference,
  right: PublicEventProjectionSupportReference,
): number {
  return compareStrings(left.reportRevisionId, right.reportRevisionId)
    || compareStrings(left.permittedTextHash, right.permittedTextHash)
    || left.spanStart - right.spanStart
    || left.spanEnd - right.spanEnd
    || compareStrings(left.offsetUnit, right.offsetUnit)
    || compareStrings(left.relation, right.relation);
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function fail(code: PublicEventProjectionServiceErrorCode): never {
  throw new PublicEventProjectionServiceError(code);
}
