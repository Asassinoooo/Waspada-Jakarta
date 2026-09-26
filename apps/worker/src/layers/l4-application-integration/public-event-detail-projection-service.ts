import type { EventDetail } from "../../contracts/public-api.js";
import {
  preparePublicEventProjectionSnapshot,
  PublicEventProjectionServiceError,
  type PreparedPublicEventProjectionSnapshot,
  type PublicEventProjectionLookupReadPort,

  type PublicEventProjectionSnapshotReadPort,
  type PublicEventProjectionSupportReference,
} from "./public-event-projection-service.js";
import { projectPublicEventDetail } from "./public-geometry-projection.js";
import {
  projectPublicEventForGeometry,
  PublicProjectionError,
  type PublicEventGeometryProjectionContext,
  type PublicProjectionLookups,
} from "./public-projection.js";

export interface PublicEventDetailGeometry {
  readonly datasetKind: "live";
  readonly geometryId: string;
  /** Untrusted schema 2.0 input for the strict Layer 4 geometry projector. */
  readonly recordJson: unknown;
}

export interface PublicEventDetailGeometryReadPort {
  /** Reads only the exact geometry identifiers derived from the current event and claim scopes. */
  read(geometryIds: unknown): Promise<readonly PublicEventDetailGeometry[]>;
}

export interface PublicEventDetailProjectionService {
  read(eventId: unknown): Promise<PublicEventDetailProjectionReadResult>;
}

export type PublicEventDetailProjectionReadResult =
  | { readonly kind: "found"; readonly detail: EventDetail }
  | { readonly kind: "missing" };

export type PublicEventDetailProjectionServiceErrorCode =
  | "INVALID_EVENT_ID"
  | "SNAPSHOT_READ_FAILED"
  | "SNAPSHOT_INVALID"
  | "LOOKUP_LIMIT_EXCEEDED"
  | "LOOKUP_READ_FAILED"
  | "LOOKUP_RESULT_INVALID"
  | "GEOMETRY_LIMIT_EXCEEDED"
  | "GEOMETRY_READ_FAILED"
  | "GEOMETRY_RESULT_INVALID"
  | "PROJECTION_FAILED";

const errorMessages: Record<PublicEventDetailProjectionServiceErrorCode, string> = {
  INVALID_EVENT_ID: "The event identifier is invalid.",
  SNAPSHOT_READ_FAILED: "The current public event snapshot could not be read.",
  SNAPSHOT_INVALID: "The current public event snapshot is invalid.",
  LOOKUP_LIMIT_EXCEEDED: "The public projection exceeds its lookup limit.",
  LOOKUP_READ_FAILED: "The public projection lookups could not be read.",
  LOOKUP_RESULT_INVALID: "The public projection lookup result is invalid.",
  GEOMETRY_LIMIT_EXCEEDED: "The public geometry limit was exceeded.",
  GEOMETRY_READ_FAILED: "The public geometries could not be read.",
  GEOMETRY_RESULT_INVALID: "The public geometry result is invalid.",
  PROJECTION_FAILED: "The event cannot be projected to a public detail.",
};

/** Fixed service errors never include event IDs, lookup keys, excerpts, geometry, or database errors. */
export class PublicEventDetailProjectionServiceError extends Error {
  constructor(readonly code: PublicEventDetailProjectionServiceErrorCode) {
    super(errorMessages[code]);
    this.name = "PublicEventDetailProjectionServiceError";
  }
}

const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u;
const hashPattern = /^[a-f0-9]{64}$/u;
const maxIdentifierLength = 128;
const maxGeometryIds = 500;
const maxEvidenceOffset = 10_000_000;
const scopeEntityTypes = new Set(["place", "service", "institution", "audience"]);
const scopeLookupKeys = ["entity_type", "id", "display_name"] as const;
const attributionLookupKeys = [
  "dataset_kind",
  "report_revision_id",
  "permitted_text_hash",
  "span_start",
  "span_end",
  "offset_unit",
  "relation",
  "public_use_approved",
  "display_name",
  "url",
  "published_at",
  "observed_at",
  "excerpt_public_use_approved",
  "excerpt",
] as const;

interface ValidatedLookupResult {
  readonly scopeNames: readonly unknown[];
  readonly publicAttributions: readonly unknown[];
}

/**
 * Composes the existing snapshot and reviewed lookup ports with exact current
 * event/claim geometry reads, then delegates the public allowlist to the strict
 * EventDetail projector. This service performs reads only.
 */
export function createPublicEventDetailProjectionService(ports: {
  readonly snapshots: PublicEventProjectionSnapshotReadPort;
  readonly lookups: PublicEventProjectionLookupReadPort;
  readonly geometries: PublicEventDetailGeometryReadPort;
}): PublicEventDetailProjectionService {
  return {
    async read(eventId: unknown): Promise<PublicEventDetailProjectionReadResult> {
      if (!isIdentifier(eventId)) fail("INVALID_EVENT_ID");

      let snapshotResult: unknown;
      try {
        snapshotResult = await ports.snapshots.read(eventId);
      } catch {
        fail("SNAPSHOT_READ_FAILED");
      }

      const rawSnapshot = readSnapshotResult(snapshotResult);
      if (rawSnapshot === null) return { kind: "missing" };

      let prepared: PreparedPublicEventProjectionSnapshot;
      try {
        prepared = preparePublicEventProjectionSnapshot(rawSnapshot, eventId);
      } catch (error) {
        if (error instanceof PublicEventProjectionServiceError
          && error.code === "LOOKUP_LIMIT_EXCEEDED") {
          fail("LOOKUP_LIMIT_EXCEEDED");
        }
        fail("SNAPSHOT_INVALID");
      }

      let lookupValue: unknown;
      try {
        lookupValue = await ports.lookups.resolve(prepared.query);
      } catch {
        fail("LOOKUP_READ_FAILED");
      }

      let lookupResult: ValidatedLookupResult;
      try {
        lookupResult = validateLookupResult(lookupValue, prepared);
      } catch {
        fail("LOOKUP_RESULT_INVALID");
      }

      const projectionLookups: PublicProjectionLookups = {
        scopeNames: lookupResult.scopeNames,
        publicAttributions: lookupResult.publicAttributions,
        impacts: prepared.impactRecords,
      };
      let context: PublicEventGeometryProjectionContext;
      try {
        context = projectPublicEventForGeometry(prepared.eventRecord, projectionLookups);
      } catch (error) {
        if (error instanceof PublicProjectionError
          && (error.code === "LOOKUPS_INVALID"
            || error.code === "NAME_LOOKUP_FAILED"
            || error.code === "ATTRIBUTION_FAILED")) {
          fail("LOOKUP_RESULT_INVALID");
        }
        fail("SNAPSHOT_INVALID");
      }
      if (context.eventId !== eventId || context.version !== readSnapshotVersion(prepared)) {
        fail("SNAPSHOT_INVALID");
      }

      const geometryIds = collectGeometryIds(context);
      let geometryRows: readonly PublicEventDetailGeometry[] = [];
      if (geometryIds.length > 0) {
        let geometryValue: unknown;
        try {
          geometryValue = await ports.geometries.read(geometryIds);
        } catch {
          fail("GEOMETRY_READ_FAILED");
        }
        try {
          geometryRows = validateGeometryResult(geometryValue, geometryIds);
        } catch {
          fail("GEOMETRY_RESULT_INVALID");
        }
      }

      let detail: EventDetail;
      try {
        detail = projectPublicEventDetail(
          prepared.eventRecord,
          projectionLookups,
          geometryRows.map((geometry) => geometry.recordJson),
        );
      } catch {
        fail("PROJECTION_FAILED");
      }
      return { kind: "found", detail };
    },
  };
}

function readSnapshotResult(value: unknown): unknown | null {
  if (!isRecord(value)) fail("SNAPSHOT_INVALID");
  if (value.kind === "missing") {
    if (!hasExactKeys(value, ["kind"])) fail("SNAPSHOT_INVALID");
    return null;
  }
  if (value.kind !== "found" || !hasExactKeys(value, ["kind", "snapshot"])
    || !hasExactKeys(value.snapshot, ["datasetKind", "eventId", "eventVersion", "recordJson", "impacts"])) {
    fail("SNAPSHOT_INVALID");
  }
  return value.snapshot;
}

function validateLookupResult(
  value: unknown,
  prepared: PreparedPublicEventProjectionSnapshot,
): ValidatedLookupResult {
  if (!hasExactKeys(value, ["scopeNames", "publicAttributions"])
    || !Array.isArray(value.scopeNames)
    || !Array.isArray(value.publicAttributions)) {
    fail("LOOKUP_RESULT_INVALID");
  }

  const expectedScopes = new Set(prepared.query.scopeKeys.map((key) => scopeKey(key.entityType, key.entityId)));
  if (value.scopeNames.length !== expectedScopes.size) fail("LOOKUP_RESULT_INVALID");
  const seenScopes = new Set<string>();
  const scopeNames: Record<string, unknown>[] = [];
  for (const candidate of value.scopeNames) {
    if (!hasExactKeys(candidate, scopeLookupKeys)
      || typeof candidate.entity_type !== "string"
      || !scopeEntityTypes.has(candidate.entity_type)
      || !isIdentifier(candidate.id)
      || !isDisplayName(candidate.display_name)) {
      fail("LOOKUP_RESULT_INVALID");
    }
    const key = scopeKey(candidate.entity_type, candidate.id);
    if (!expectedScopes.has(key) || seenScopes.has(key)) fail("LOOKUP_RESULT_INVALID");
    seenScopes.add(key);
    scopeNames.push({
      entity_type: candidate.entity_type,
      id: candidate.id,
      display_name: candidate.display_name,
    });
  }

  const expectedAttributions = new Set(prepared.query.supportReferences.map(supportReferenceKey));
  if (value.publicAttributions.length !== expectedAttributions.size) fail("LOOKUP_RESULT_INVALID");
  const seenAttributions = new Set<string>();
  const publicAttributions: Record<string, unknown>[] = [];
  for (const candidate of value.publicAttributions) {
    if (!hasExactKeys(candidate, attributionLookupKeys)
      || candidate.dataset_kind !== "live"
      || !isIdentifier(candidate.report_revision_id)
      || typeof candidate.permitted_text_hash !== "string"
      || !hashPattern.test(candidate.permitted_text_hash)
      || !isSafeInteger(candidate.span_start, 0, maxEvidenceOffset)
      || !isSafeInteger(candidate.span_end, 1, maxEvidenceOffset)
      || candidate.span_end <= candidate.span_start
      || candidate.offset_unit !== "unicode_code_points"
      || candidate.relation !== "supports"
      || candidate.public_use_approved !== true
      || !isDisplayName(candidate.display_name)
      || !isHttpsUrl(candidate.url)
      || !isOptionalDateTime(candidate.published_at)
      || !isOptionalDateTime(candidate.observed_at)
      || candidate.excerpt_public_use_approved !== false
      || candidate.excerpt !== null) {
      fail("LOOKUP_RESULT_INVALID");
    }
    const key = supportReferenceKey({
      reportRevisionId: candidate.report_revision_id,
      permittedTextHash: candidate.permitted_text_hash,
      spanStart: candidate.span_start,
      spanEnd: candidate.span_end,
      offsetUnit: "unicode_code_points",
      relation: "supports",
    });
    if (!expectedAttributions.has(key) || seenAttributions.has(key)) fail("LOOKUP_RESULT_INVALID");
    seenAttributions.add(key);
    publicAttributions.push({
      dataset_kind: "live",
      report_revision_id: candidate.report_revision_id,
      permitted_text_hash: candidate.permitted_text_hash,
      span_start: candidate.span_start,
      span_end: candidate.span_end,
      offset_unit: "unicode_code_points",
      relation: "supports",
      public_use_approved: true,
      display_name: candidate.display_name,
      url: candidate.url,
      published_at: candidate.published_at,
      observed_at: candidate.observed_at,
      excerpt_public_use_approved: false,
      excerpt: null,
    });
  }

  return { scopeNames, publicAttributions };
}

function collectGeometryIds(context: PublicEventGeometryProjectionContext): string[] {
  const ids = new Set<string>();
  for (const geometryId of context.geometryIds) addGeometryId(geometryId, ids);
  for (const claim of context.claims) {
    for (const geometryId of claim.geometryIds) addGeometryId(geometryId, ids);
  }
  return [...ids].sort(compareStrings);
}

function addGeometryId(value: unknown, ids: Set<string>): void {
  if (!isIdentifier(value)) fail("SNAPSHOT_INVALID");
  ids.add(value);
  if (ids.size > maxGeometryIds) fail("GEOMETRY_LIMIT_EXCEEDED");
}

function validateGeometryResult(value: unknown, requestedIds: readonly string[]): readonly PublicEventDetailGeometry[] {
  if (!Array.isArray(value) || value.length !== requestedIds.length) fail("GEOMETRY_RESULT_INVALID");

  const requested = new Set(requestedIds);
  const seen = new Set<string>();
  const rows: PublicEventDetailGeometry[] = [];
  for (const candidate of value) {
    if (!hasExactKeys(candidate, ["datasetKind", "geometryId", "recordJson"])
      || candidate.datasetKind !== "live"
      || !isIdentifier(candidate.geometryId)
      || !requested.has(candidate.geometryId)
      || seen.has(candidate.geometryId)
      || !isRecord(candidate.recordJson)
      || candidate.recordJson.schema_version !== "2.0"
      || candidate.recordJson.record_type !== "Geometry"
      || candidate.recordJson.dataset_kind !== "live"
      || candidate.recordJson.geometry_id !== candidate.geometryId) {
      fail("GEOMETRY_RESULT_INVALID");
    }
    seen.add(candidate.geometryId);
    rows.push({
      datasetKind: "live",
      geometryId: candidate.geometryId,
      recordJson: candidate.recordJson,
    });
  }
  if (seen.size !== requested.size) fail("GEOMETRY_RESULT_INVALID");
  rows.sort((left, right) => compareStrings(left.geometryId, right.geometryId));
  return rows;
}

function readSnapshotVersion(prepared: PreparedPublicEventProjectionSnapshot): number {
  return prepared.eventRecord.version as number;
}

function scopeKey(entityType: string, entityId: string): string {
  return JSON.stringify([entityType, entityId]);
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

function isIdentifier(value: unknown): value is string {
  return typeof value === "string"
    && value.length <= maxIdentifierLength
    && identifierPattern.test(value);
}

function isDisplayName(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && Array.from(value).length <= 200
    && value.trim() === value;
}

function isSafeInteger(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === "number"
    && Number.isSafeInteger(value)
    && value >= minimum
    && value <= maximum;
}

function isOptionalDateTime(value: unknown): boolean {
  return value === null || isDateTime(value);
}

function isDateTime(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|([+-])(\d{2}):(\d{2}))$/u.exec(value);
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

function daysInMonth(year: number, month: number): number {
  if (month === 2) return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function isHttpsUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 2048 || value.trim() !== value) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:"
      && parsed.hostname.length > 0
      && parsed.username.length === 0
      && parsed.password.length === 0;
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function fail(code: PublicEventDetailProjectionServiceErrorCode): never {
  throw new PublicEventDetailProjectionServiceError(code);
}