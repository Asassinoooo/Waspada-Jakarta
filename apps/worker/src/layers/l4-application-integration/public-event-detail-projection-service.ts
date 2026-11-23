import type { EventDetail } from "../../contracts/public-api.js";
import {
  preparePublicEventProjectionSnapshot,
  PublicEventProjectionServiceError,
  type PreparedPublicEventProjectionSnapshot,
  type PublicEventProjectionLookupBatchReadPort,
  type PublicEventProjectionLookupReadPort,
  type PublicEventProjectionSnapshotBatchReadPort,
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

/**
 * PERF-03: the factory's service also reads several events with a constant number of statements per call (see
 * readDetailBatch). Entry i is the outcome for eventIds[i]. A failed read rejects the whole call; an event's own failure
 * is that event's error. It extends the read-only interface, so the existing read-only stubs still type-check.
 */
export interface PublicEventDetailBatchProjectionService extends PublicEventDetailProjectionService {
  readMany(eventIds: readonly unknown[]): Promise<readonly PublicEventDetailBatchOutcome[]>;
}

/** One event of readMany: its result (missing is a result, not an error), or its own projection error. */
export type PublicEventDetailBatchOutcome =
  | { readonly value: PublicEventDetailProjectionReadResult }
  | { readonly error: PublicEventDetailProjectionServiceError };

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
  "retrieved_at",
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
  readonly snapshots: PublicEventProjectionSnapshotReadPort & Partial<PublicEventProjectionSnapshotBatchReadPort>;
  readonly lookups: PublicEventProjectionLookupReadPort & Partial<PublicEventProjectionLookupBatchReadPort>;
  readonly geometries: PublicEventDetailGeometryReadPort;
}): PublicEventDetailBatchProjectionService {
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

      let lookupResult: ValidatedLookupResult | null;
      try {
        lookupResult = validateLookupResult(lookupValue, prepared);
      } catch {
        fail("LOOKUP_RESULT_INVALID");
      }
      // A supporting reference with no approved attribution: the event is not publicly projectable (the list skips it too).
      if (lookupResult === null) return { kind: "missing" };

      const geometry = geometryContextFor(eventId, prepared, lookupResult);
      if (geometry === null) return { kind: "missing" };
      const { context, projectionLookups } = geometry;

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
          { locationLabelPresent: prepared.locationLabelPresent, locationLabel: prepared.locationLabel },
        );
      } catch {
        fail("PROJECTION_FAILED");
      }
      return { kind: "found", detail };
    },
    async readMany(eventIds: readonly unknown[]): Promise<readonly PublicEventDetailBatchOutcome[]> {
      return readDetailBatch(ports, eventIds);
    },
  };
}

/**
 * The geometry context of one event, or null when the event is missing from the public view (no approved attribution
 * for a supporting reference or claim). read() and readMany() share it, so both project an event the same way.
 */
function geometryContextFor(
  eventId: string,
  prepared: PreparedPublicEventProjectionSnapshot,
  lookupResult: ValidatedLookupResult,
): { readonly context: PublicEventGeometryProjectionContext; readonly projectionLookups: PublicProjectionLookups } | null {
  const projectionLookups: PublicProjectionLookups = {
    scopeNames: lookupResult.scopeNames,
    publicAttributions: lookupResult.publicAttributions,
    impacts: prepared.impactRecords,
  };
  let context: PublicEventGeometryProjectionContext;
  try {
    context = projectPublicEventForGeometry(prepared.eventRecord, projectionLookups, {
      locationLabelPresent: prepared.locationLabelPresent,
      locationLabel: prepared.locationLabel,
    });
  } catch (error) {
    // ATTRIBUTION_FAILED means no approved attribution for a supporting reference or claim: missing, as in the list.
    if (error instanceof PublicProjectionError && error.code === "ATTRIBUTION_FAILED") return null;
    if (error instanceof PublicProjectionError
      && (error.code === "LOOKUPS_INVALID"
        || error.code === "NAME_LOOKUP_FAILED")) {
      fail("LOOKUP_RESULT_INVALID");
    }
    fail("SNAPSHOT_INVALID");
  }
  if (context.eventId !== eventId || context.version !== readSnapshotVersion(prepared)) {
    fail("SNAPSHOT_INVALID");
  }
  return { context, projectionLookups };
}

interface PendingDetail {
  readonly eventId: string;
  readonly prepared: PreparedPublicEventProjectionSnapshot;
  readonly projectionLookups: PublicProjectionLookups;
  readonly geometryIds: readonly string[];
}

/** An event's own failure, as the service error the single read gives for it. Unexpected errors use the fallback code. */
function batchEventError(
  error: unknown,
  fallback: PublicEventDetailProjectionServiceErrorCode,
): PublicEventDetailProjectionServiceError {
  if (error instanceof PublicEventDetailProjectionServiceError) return error;
  if (error instanceof PublicEventProjectionServiceError && error.code === "LOOKUP_LIMIT_EXCEEDED") {
    return new PublicEventDetailProjectionServiceError("LOOKUP_LIMIT_EXCEEDED");
  }
  return new PublicEventDetailProjectionServiceError(fallback);
}

/**
 * PERF-03: the details of several events with a constant number of statements. One batch snapshot read, one batch
 * lookup read and one geometry read per 500 distinct ids serve the whole call. Each event then goes through the same
 * validators and projectors as read(), so an event gets the result that read() gives it alone. A failed read rejects
 * the whole call. An event's own validation or projection failure is that event's error.
 */
async function readDetailBatch(
  ports: {
    readonly snapshots: PublicEventProjectionSnapshotReadPort & Partial<PublicEventProjectionSnapshotBatchReadPort>;
    readonly lookups: PublicEventProjectionLookupReadPort & Partial<PublicEventProjectionLookupBatchReadPort>;
    readonly geometries: PublicEventDetailGeometryReadPort;
  },
  eventIds: readonly unknown[],
): Promise<readonly PublicEventDetailBatchOutcome[]> {
  if (!Array.isArray(eventIds)) fail("INVALID_EVENT_ID");
  const requested = eventIds.map((eventId) => {
    if (!isIdentifier(eventId)) fail("INVALID_EVENT_ID");
    return eventId;
  });
  if (requested.length === 0) return [];
  const distinct = [...new Set(requested)];
  const distinctSet = new Set(distinct);
  const snapshotPort = ports.snapshots;
  const lookupPort = ports.lookups;
  if (snapshotPort.readMany === undefined || lookupPort.resolveMany === undefined) fail("SNAPSHOT_READ_FAILED");

  let snapshotRows: unknown;
  try {
    snapshotRows = await snapshotPort.readMany(distinct);
  } catch {
    fail("SNAPSHOT_READ_FAILED");
  }
  if (!Array.isArray(snapshotRows) || snapshotRows.length > distinct.length) fail("SNAPSHOT_INVALID");

  const outcomes = new Map<string, PublicEventDetailBatchOutcome>();
  const preparedById = new Map<string, PreparedPublicEventProjectionSnapshot>();
  for (const row of snapshotRows) {
    const eventId: unknown = typeof row === "object" && row !== null
      ? (row as { readonly eventId?: unknown }).eventId
      : undefined;
    if (typeof eventId !== "string" || !distinctSet.has(eventId) || preparedById.has(eventId) || outcomes.has(eventId)) {
      fail("SNAPSHOT_INVALID");
    }
    try {
      preparedById.set(eventId, preparePublicEventProjectionSnapshot(row, eventId));
    } catch (error) {
      outcomes.set(eventId, { error: batchEventError(error, "SNAPSHOT_INVALID") });
    }
  }

  // An event with no current snapshot is missing, so it has no lookup request.
  const foundIds = distinct.filter((eventId) => preparedById.has(eventId));
  const requests = foundIds.map((eventId) => preparedById.get(eventId)!.query);
  let lookupRows: unknown = [];
  if (requests.length > 0) {
    try {
      lookupRows = await lookupPort.resolveMany(requests);
    } catch {
      fail("LOOKUP_READ_FAILED");
    }
  }
  if (!Array.isArray(lookupRows) || lookupRows.length !== requests.length) fail("LOOKUP_RESULT_INVALID");
  const lookupList: readonly unknown[] = lookupRows;

  const pending: PendingDetail[] = [];
  foundIds.forEach((eventId, index) => {
    const prepared = preparedById.get(eventId)!;
    try {
      const lookupResult = validateLookupResult(lookupList[index], prepared);
      const geometry = lookupResult === null ? null : geometryContextFor(eventId, prepared, lookupResult);
      if (geometry === null) {
        outcomes.set(eventId, { value: { kind: "missing" } });
        return;
      }
      pending.push({
        eventId,
        prepared,
        projectionLookups: geometry.projectionLookups,
        geometryIds: collectGeometryIds(geometry.context),
      });
    } catch (error) {
      outcomes.set(eventId, { error: batchEventError(error, "LOOKUP_RESULT_INVALID") });
    }
  });

  const geometryIds = [...new Set(pending.flatMap((event) => event.geometryIds))].sort(compareStrings);
  const rowsById = new Map<string, unknown[]>();
  for (let start = 0; start < geometryIds.length; start += maxGeometryIds) {
    let geometryValue: unknown;
    try {
      geometryValue = await ports.geometries.read(geometryIds.slice(start, start + maxGeometryIds));
    } catch {
      fail("GEOMETRY_READ_FAILED");
    }
    if (!Array.isArray(geometryValue)) fail("GEOMETRY_RESULT_INVALID");
    for (const row of geometryValue) {
      const geometryId: unknown = typeof row === "object" && row !== null
        ? (row as { readonly geometryId?: unknown }).geometryId
        : undefined;
      if (typeof geometryId === "string") rowsById.set(geometryId, [...(rowsById.get(geometryId) ?? []), row]);
    }
  }

  for (const event of pending) {
    let geometryRows: readonly PublicEventDetailGeometry[];
    try {
      // Each event validates only its own ids, with the same exact-set check read() applies to a single event.
      geometryRows = validateGeometryResult(
        event.geometryIds.flatMap((geometryId) => rowsById.get(geometryId) ?? []),
        event.geometryIds,
      );
    } catch (error) {
      outcomes.set(event.eventId, { error: batchEventError(error, "GEOMETRY_RESULT_INVALID") });
      continue;
    }
    try {
      const detail = projectPublicEventDetail(
        event.prepared.eventRecord,
        event.projectionLookups,
        geometryRows.map((geometry) => geometry.recordJson),
        { locationLabelPresent: event.prepared.locationLabelPresent, locationLabel: event.prepared.locationLabel },
      );
      outcomes.set(event.eventId, { value: { kind: "found", detail } });
    } catch {
      outcomes.set(event.eventId, { error: new PublicEventDetailProjectionServiceError("PROJECTION_FAILED") });
    }
  }

  const missing: PublicEventDetailBatchOutcome = { value: { kind: "missing" } };
  return requested.map((eventId) => outcomes.get(eventId) ?? missing);
}

function readSnapshotResult(value: unknown): unknown | null {
  if (!isRecord(value)) fail("SNAPSHOT_INVALID");
  if (value.kind === "missing") {
    if (!hasExactKeys(value, ["kind"])) fail("SNAPSHOT_INVALID");
    return null;
  }
  if (value.kind !== "found" || !hasExactKeys(value, ["kind", "snapshot"])
    || !hasExactKeys(value.snapshot, ["datasetKind", "eventId", "eventVersion", "recordJson", "impacts", "locationLabelPresent", "locationLabel"])) {
    fail("SNAPSHOT_INVALID");
  }
  return value.snapshot;
}

/** Returns null when some supporting reference has no approved attribution row; every other mismatch fails. */
function validateLookupResult(
  value: unknown,
  prepared: PreparedPublicEventProjectionSnapshot,
): ValidatedLookupResult | null {
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
  // More rows than references is always invalid. Fewer is handled after the rows are checked (returns null).
  if (value.publicAttributions.length > expectedAttributions.size) fail("LOOKUP_RESULT_INVALID");
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
      || !isOptionalDateTime(candidate.retrieved_at)
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
      retrieved_at: candidate.retrieved_at,
      excerpt_public_use_approved: false,
      excerpt: null,
    });
  }

  // Fewer approved rows than supporting references: at least one reference has no public attribution (see the caller).
  if (publicAttributions.length < expectedAttributions.size) return null;
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