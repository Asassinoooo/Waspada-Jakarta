import { createPublicEventGeoJSONCandidateRepository } from "../../../db/src/public-event-geojson-candidates.js";
import {
  createPublicEventSnapshotRepository,
  type PublicEventSnapshot,
} from "../../../db/src/public-event-snapshot.js";
import {
  createPublicProjectionLookupRepository,
  PUBLIC_PROJECTION_LOOKUP_LIMITS,
  type PublicProjectionLookupQuery,
  type PublicScopeNameKey,
  type PublicScopeNameLookup,
  type PublicSourceAttributionLookup,
  type PublicSupportingEvidenceKey,
} from "../../../db/src/public-projection-lookups.js";
import { withPostgresSqlExecutor } from "../../../db/src/postgres-sql-executor.js";
import type { SqlExecutor } from "../../../db/src/sql.js";
import type { PublicFeatureCollection } from "../contracts/public-api.js";
import {
  preparePublicEventProjectionSnapshot,
  PublicEventProjectionServiceError,
  type PreparedPublicEventProjectionSnapshot,
} from "../layers/l4-application-integration/public-event-projection-service.js";
import { readPublicGeoJSONQuery, type PublicGeoJSONQuery } from "../layers/l4-application-integration/public-geojson-query.js";
import {
  projectPublicGeoJSONCandidateCollection,
  type PublicGeoJSONCandidateLookupBatch,
} from "../layers/l4-application-integration/public-geometry-projection.js";
import { isValidHyperdriveConnectionString } from "./public-event-list-runtime.js";

const maxCandidates = 500;
const maxProjectorLookupEntries = 10_000;
const lookupBatchSize = PUBLIC_PROJECTION_LOOKUP_LIMITS.scopeKeys;
const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u;
const hashPattern = /^[a-f0-9]{64}$/u;
const dateTimePattern = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|([+-])(\d{2}):(\d{2}))$/u;
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

export interface PublicEventGeoJSONRuntimeConfiguration {
  readonly datasetMode?: string;
  readonly connectionString?: string;
}

export type PublicEventGeoJSONSqlExecutorRunner = <Result>(
  connectionString: string,
  operation: (executor: SqlExecutor) => Promise<Result>,
) => Promise<Result>;

export interface PublicEventGeoJSONRuntimeDependencies {
  /** Test seam for a fake SQL executor; production uses the PostgreSQL adapter. */
  readonly withSqlExecutor?: PublicEventGeoJSONSqlExecutorRunner;
}

export interface PublicEventGeoJSONRuntime {
  read(search: URLSearchParams): Promise<PublicFeatureCollection>;
}

export type PublicEventGeoJSONRuntimeErrorCode = "READ_FAILED";

/** Fixed runtime errors never include request, record, SQL, or driver details. */
export class PublicEventGeoJSONRuntimeError extends Error {
  constructor(readonly code: PublicEventGeoJSONRuntimeErrorCode = "READ_FAILED") {
    super("The public GeoJSON read could not be completed.");
    this.name = "PublicEventGeoJSONRuntimeError";
  }
}

interface EventGroup {
  readonly eventId: string;
  readonly eventVersion: number;
  readonly candidates: unknown[];
  snapshot?: PublicEventSnapshot;
  prepared?: PreparedPublicEventProjectionSnapshot;
}

interface ValidatedLookups {
  readonly scopeNames: readonly PublicScopeNameLookup[];
  readonly publicAttributions: readonly PublicSourceAttributionLookup[];
}

/**
 * Builds the live GeoJSON route runtime only for exact live mode and a valid
 * injected Hyperdrive connection. Each accepted request owns one SQL operation.
 */
export function createPublicEventGeoJSONRuntime(
  configuration: PublicEventGeoJSONRuntimeConfiguration,
  dependencies: PublicEventGeoJSONRuntimeDependencies = {},
): PublicEventGeoJSONRuntime | undefined {
  if (configuration.datasetMode !== "live"
    || !isValidHyperdriveConnectionString(configuration.connectionString)) {
    return undefined;
  }

  const connectionString = configuration.connectionString;
  const withSqlExecutor = dependencies.withSqlExecutor ?? withPostgresSqlExecutor;
  return {
    async read(search) {
      const query = readPublicGeoJSONQuery(search);
      return withSqlExecutor(connectionString, async (executor) => {
        try {
          return await readCollection(executor, query);
        } catch (error) {
          if (error instanceof PublicEventGeoJSONRuntimeError) throw error;
          throw new PublicEventGeoJSONRuntimeError();
        }
      });
    },
  };
}

async function readCollection(
  executor: SqlExecutor,
  query: PublicGeoJSONQuery,
): Promise<PublicFeatureCollection> {
  const candidates = await createPublicEventGeoJSONCandidateRepository(executor).read(
    toCandidateQuery(query),
  );
  if (!Array.isArray(candidates) || candidates.length > maxCandidates) fail();
  if (candidates.length === 0) {
    return projectPublicGeoJSONCandidateCollection({ candidates: [], lookupBatches: [] });
  }

  const groups = groupCandidates(candidates);
  const eventIds = [...groups.values()].map(({ eventId }) => eventId).sort(compareStrings);
  const snapshots = await createPublicEventSnapshotRepository(executor).readMany(eventIds);
  if (!Array.isArray(snapshots) || snapshots.length > groups.size) fail();

  const snapshotById = new Map<string, PublicEventSnapshot>();
  for (const snapshot of snapshots) {
    if (!isSnapshotIdentity(snapshot)
      || !groups.has(publicVersionKey(snapshot.eventId, snapshot.eventVersion))
      || snapshotById.has(snapshot.eventId)) {
      fail();
    }
    snapshotById.set(snapshot.eventId, snapshot);
  }
  if (snapshotById.size !== groups.size) fail();

  let lookupEntryCount = 0;
  const scopeKeyById = new Map<string, PublicScopeNameKey>();
  const supportKeyById = new Map<string, PublicSupportingEvidenceKey>();
  for (const group of orderedGroups(groups)) {
    const snapshot = snapshotById.get(group.eventId);
    if (snapshot === undefined || snapshot.eventVersion !== group.eventVersion) fail();
    let prepared: PreparedPublicEventProjectionSnapshot;
    try {
      prepared = preparePublicEventProjectionSnapshot(snapshot, group.eventId);
    } catch (error) {
      if (error instanceof PublicEventProjectionServiceError) fail();
      fail();
    }
    if (prepared.eventRecord.event_id !== group.eventId
      || prepared.eventRecord.version !== group.eventVersion) {
      fail();
    }
    lookupEntryCount += prepared.query.scopeKeys.length
      + prepared.query.supportReferences.length
      + prepared.impactRecords.length;
    if (lookupEntryCount > maxProjectorLookupEntries) fail();

    group.snapshot = snapshot;
    group.prepared = prepared;
    for (const key of prepared.query.scopeKeys) scopeKeyById.set(scopeKey(key), key);
    for (const key of prepared.query.supportReferences) supportKeyById.set(supportKey(key), key);
  }

  const requestedScopeKeys = [...scopeKeyById.values()].sort(compareScopeKeys);
  const requestedSupportReferences = [...supportKeyById.values()].sort(compareSupportReferences);
  const resolvedScopeNames = new Map<string, PublicScopeNameLookup>();
  const resolvedAttributions = new Map<string, PublicSourceAttributionLookup>();
  const batchCount = Math.ceil(Math.max(
    requestedScopeKeys.length,
    requestedSupportReferences.length,
  ) / lookupBatchSize);
  const lookupRepository = createPublicProjectionLookupRepository(executor);
  for (let index = 0; index < batchCount; index += 1) {
    const offset = index * lookupBatchSize;
    const request: PublicProjectionLookupQuery = {
      scopeKeys: requestedScopeKeys.slice(offset, offset + lookupBatchSize),
      supportReferences: requestedSupportReferences.slice(offset, offset + lookupBatchSize),
    };
    const result = await lookupRepository.resolve(request);
    const validated = validateLookupResult(result, request);
    for (const name of validated.scopeNames) resolvedScopeNames.set(scopeKey({
      entityType: name.entity_type,
      entityId: name.id,
    }), name);
    for (const attribution of validated.publicAttributions) {
      resolvedAttributions.set(supportKey({
        reportRevisionId: attribution.report_revision_id,
        permittedTextHash: attribution.permitted_text_hash,
        spanStart: attribution.span_start,
        spanEnd: attribution.span_end,
        offsetUnit: attribution.offset_unit,
        relation: attribution.relation,
      }), attribution);
    }
  }

  const lookupBatches: PublicGeoJSONCandidateLookupBatch[] = orderedGroups(groups).map((group) => {
    const prepared = group.prepared;
    if (prepared === undefined) fail();
    const scopeNames = prepared.query.scopeKeys.flatMap((key) => {
      const name = resolvedScopeNames.get(scopeKey(key));
      return name === undefined ? [] : [name];
    });
    const publicAttributions = prepared.query.supportReferences.flatMap((key) => {
      const attribution = resolvedAttributions.get(supportKey(key));
      return attribution === undefined ? [] : [attribution];
    });
    return {
      eventId: group.eventId,
      eventVersion: group.eventVersion,
      scopeNames,
      publicAttributions,
      impacts: prepared.impactRecords,
    };
  });

  return projectPublicGeoJSONCandidateCollection({ candidates, lookupBatches });
}

function groupCandidates(
  candidates: readonly unknown[],
): Map<string, EventGroup> {
  const groups = new Map<string, EventGroup>();
  const versionByEvent = new Map<string, number>();
  const geometryIds = new Map<string, Set<string>>();
  for (const value of candidates) {
    if (!isRecord(value)
      || !isIdentifier(value.eventId)
      || !isPositiveVersion(value.eventVersion)
      || !isIdentifier(value.geometryId)) {
      fail();
    }
    const priorVersion = versionByEvent.get(value.eventId);
    if (priorVersion !== undefined && priorVersion !== value.eventVersion) fail();
    versionByEvent.set(value.eventId, value.eventVersion);
    const eventGeometryIds = geometryIds.get(value.eventId) ?? new Set<string>();
    if (eventGeometryIds.has(value.geometryId)) fail();
    eventGeometryIds.add(value.geometryId);
    geometryIds.set(value.eventId, eventGeometryIds);

    const identity = publicVersionKey(value.eventId, value.eventVersion);
    const existing = groups.get(identity);
    if (existing === undefined) {
      groups.set(identity, {
        eventId: value.eventId,
        eventVersion: value.eventVersion,
        candidates: [value],
      });
    } else {
      existing.candidates.push(value);
    }
  }
  return groups;
}

function orderedGroups(groups: ReadonlyMap<string, EventGroup>): EventGroup[] {
  return [...groups.values()].sort((left, right) => compareStrings(left.eventId, right.eventId)
    || left.eventVersion - right.eventVersion);
}

function toCandidateQuery(query: PublicGeoJSONQuery) {
  return {
    bbox: query.bbox,
    ...(query.category === null ? {} : { category: query.category }),
    ...(query.lifecycle === null ? {} : { lifecycle: query.lifecycle }),
    ...(query.freshness === null ? {} : { freshness: query.freshness }),
  };
}

function validateLookupResult(
  value: unknown,
  requested: PublicProjectionLookupQuery,
): ValidatedLookups {
  if (!isRecord(value) || !hasExactKeys(value, ["scopeNames", "publicAttributions"])
    || !Array.isArray(value.scopeNames) || !Array.isArray(value.publicAttributions)
    || value.scopeNames.length > requested.scopeKeys.length
    || value.publicAttributions.length > requested.supportReferences.length) {
    fail();
  }

  const requestedScopes = new Set(requested.scopeKeys.map(scopeKey));
  const requestedSupports = new Set(requested.supportReferences.map(supportKey));
  const seenScopes = new Set<string>();
  const seenSupports = new Set<string>();
  const scopeNames: PublicScopeNameLookup[] = [];
  const publicAttributions: PublicSourceAttributionLookup[] = [];

  for (const row of value.scopeNames) {
    if (!isPlainRecord(row) || !hasExactKeys(row, scopeLookupKeys)
      || typeof row.entity_type !== "string" || !scopeEntityTypes.has(row.entity_type)
      || !isIdentifier(row.id) || !isDisplayName(row.display_name)) {
      fail();
    }
    const key = scopeKey({ entityType: row.entity_type as PublicScopeNameKey["entityType"], entityId: row.id });
    if (!requestedScopes.has(key) || seenScopes.has(key)) fail();
    seenScopes.add(key);
    scopeNames.push({
      entity_type: row.entity_type as PublicScopeNameLookup["entity_type"],
      id: row.id,
      display_name: row.display_name,
    });
  }

  for (const row of value.publicAttributions) {
    if (!isPlainRecord(row) || !hasExactKeys(row, attributionLookupKeys)
      || row.dataset_kind !== "live"
      || !isIdentifier(row.report_revision_id)
      || typeof row.permitted_text_hash !== "string" || !hashPattern.test(row.permitted_text_hash)
      || !isSafeInteger(row.span_start, 0, 10_000_000)
      || !isSafeInteger(row.span_end, 1, 10_000_000)
      || row.span_end <= row.span_start
      || row.offset_unit !== "unicode_code_points"
      || row.relation !== "supports"
      || row.public_use_approved !== true
      || !isDisplayName(row.display_name)
      || !isHttpsUrl(row.url)
      || !isOptionalDateTime(row.published_at)
      || !isOptionalDateTime(row.observed_at)
      || row.excerpt_public_use_approved !== false
      || row.excerpt !== null) {
      fail();
    }
    const attribution: PublicSourceAttributionLookup = {
      dataset_kind: "live",
      report_revision_id: row.report_revision_id,
      permitted_text_hash: row.permitted_text_hash,
      span_start: row.span_start,
      span_end: row.span_end,
      offset_unit: "unicode_code_points",
      relation: "supports",
      public_use_approved: true,
      display_name: row.display_name,
      url: row.url,
      published_at: row.published_at,
      observed_at: row.observed_at,
      excerpt_public_use_approved: false,
      excerpt: null,
    };
    const key = supportKey({
      reportRevisionId: attribution.report_revision_id,
      permittedTextHash: attribution.permitted_text_hash,
      spanStart: attribution.span_start,
      spanEnd: attribution.span_end,
      offsetUnit: attribution.offset_unit,
      relation: attribution.relation,
    });
    if (!requestedSupports.has(key) || seenSupports.has(key)) fail();
    seenSupports.add(key);
    publicAttributions.push(attribution);
  }

  return { scopeNames, publicAttributions };
}

function isSnapshotIdentity(value: unknown): value is PublicEventSnapshot {
  return isRecord(value)
    && value.datasetKind === "live"
    && isIdentifier(value.eventId)
    && isPositiveVersion(value.eventVersion)
    && isRecord(value.recordJson)
    && Array.isArray(value.impacts);
}

function isIdentifier(value: unknown): value is string {
  return typeof value === "string" && identifierPattern.test(value);
}

function isPositiveVersion(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value)
    && value >= 1 && value <= 2_147_483_647;
}

function isSafeInteger(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value)
    && value >= minimum && value <= maximum;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isDisplayName(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && Array.from(value).length <= 200
    && value.trim() === value;
}

function isHttpsUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 2_048 || value.trim() !== value) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" && parsed.hostname.length > 0
      && parsed.username.length === 0 && parsed.password.length === 0;
  } catch {
    return false;
  }
}

function isOptionalDateTime(value: unknown): value is string | null {
  if (value === null) return true;
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

function daysInMonth(year: number, month: number): number {
  if (month === 2) return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function scopeKey(value: PublicScopeNameKey): string {
  return JSON.stringify([value.entityType, value.entityId]);
}

function supportKey(value: PublicSupportingEvidenceKey): string {
  return JSON.stringify([
    value.reportRevisionId,
    value.permittedTextHash,
    value.spanStart,
    value.spanEnd,
    value.offsetUnit,
    value.relation,
  ]);
}

function compareScopeKeys(left: PublicScopeNameKey, right: PublicScopeNameKey): number {
  return compareStrings(left.entityType, right.entityType) || compareStrings(left.entityId, right.entityId);
}

function compareSupportReferences(
  left: PublicSupportingEvidenceKey,
  right: PublicSupportingEvidenceKey,
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

function publicVersionKey(eventId: string, version: number): string {
  return JSON.stringify([eventId, version]);
}

function fail(): never {
  throw new PublicEventGeoJSONRuntimeError();
}
