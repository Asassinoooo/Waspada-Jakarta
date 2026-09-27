import type {
  EventDetail,
  PublicFeature,
  PublicFeatureCollection,
  PublicGeoJSONGeometry,
  PublicGeoJSONPosition,
  PublicGeometry,
} from "../../contracts/public-api.js";
import {
  PublicProjectionError,
  projectPublicEventForGeometry,
  type PublicEventGeometryProjectionContext,
  type PublicGeometrySupportReference,
  type PublicProjectionLookups,
} from "./public-projection.js";

const MAX_GEOMETRY_POSITIONS = 10_000;
const MAX_SUPPORT_REFERENCES = 32;
const MAX_PUBLIC_GEOMETRIES = 500;
const MAX_FEATURES = 500;
const MAX_DETAIL_POSITIONS = 100_000;
const MAX_LOOKUP_ENTRIES_PER_BATCH = 500;
const MAX_TOTAL_LOOKUP_ENTRIES = 10_000;
const MAX_EVENT_ARRAY_ITEMS = 500;
const MAX_EVENT_ARRAY_ITEMS_PER_GROUP = 10_000;
const MAX_TOTAL_EVENT_ARRAY_ITEMS = 50_000;
const MAX_EVENT_COMPARE_NODES = 500_000;
const MAX_EVENT_COMPARE_STRING_UNITS = 50_000_000;
const MAX_JSON_DEPTH = 32;

const candidateRowKeys = [
  "datasetKind", "eventId", "eventVersion", "category", "lifecycle", "freshness",
  "geometryId", "eventRecordJson", "geometryRecordJson",
] as const;
const candidateLookupBatchKeys = [
  "eventId", "eventVersion", "scopeNames", "publicAttributions", "impacts",
] as const;

const idPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const hashPattern = /^[a-f0-9]{64}$/u;

const geometryRoles = new Set<PublicGeometry["role"]>([
  "incident_scene",
  "affected_area",
  "warning_boundary",
  "route_segment",
  "service_stop",
  "facility",
  "venue",
  "service_area",
  "approximate_place",
]);
const precisionBases = new Set([
  "source_supplied",
  "provider_accuracy",
  "gazetteer_match",
  "moderator_generalization",
  "unknown",
]);
const pointRoles = new Set<PublicGeometry["role"]>([
  "incident_scene", "service_stop", "facility", "venue", "approximate_place",
]);
const lineRoles = new Set<PublicGeometry["role"]>(["route_segment"]);
const areaRoles = new Set<PublicGeometry["role"]>(["affected_area", "warning_boundary", "service_area"]);

export type PublicGeometryProjectionErrorCode =
  | "INVALID_GEOMETRIES"
  | "INVALID_GEOMETRY"
  | "GEOMETRY_RESOLUTION_FAILED"
  | "GEOMETRY_LIMIT_EXCEEDED"
  | "INVALID_EVENT_DETAIL"
  | "INVALID_GEOJSON_CANDIDATES";

const errorMessages: Record<PublicGeometryProjectionErrorCode, string> = {
  INVALID_GEOMETRIES: "The event geometry inputs are invalid.",
  INVALID_GEOMETRY: "A geometry cannot be projected.",
  GEOMETRY_RESOLUTION_FAILED: "The event geometry references could not be resolved.",
  GEOMETRY_LIMIT_EXCEEDED: "The public geometry limit was exceeded.",
  INVALID_EVENT_DETAIL: "The projected event details cannot be mapped.",
  INVALID_GEOJSON_CANDIDATES: "The public GeoJSON candidates cannot be projected.",
};

/** A bounded projection error that does not expose input geometry or evidence. */
export class PublicGeometryProjectionError extends Error {
  constructor(readonly code: PublicGeometryProjectionErrorCode) {
    super(errorMessages[code]);
    this.name = "PublicGeometryProjectionError";
  }
}

interface SupportReference {
  readonly reportRevisionId: string;
  readonly permittedTextHash: string;
  readonly spanStart: number;
  readonly spanEnd: number;
  readonly offsetUnit: "unicode_code_points";
  readonly relation: "supports";
}

interface ValidatedGeometryRecord extends PublicGeometry {
  readonly datasetKind: "live" | "historical" | "synthetic";
  readonly sourceEvidence: readonly SupportReference[];
}

interface PositionBudget {
  count: number;
}

interface CoordinateCounter {
  count: number;
  readonly detailBudget: PositionBudget;
}

/**
 * Projects a current public Event into EventDetail, adding only geometries
 * linked by the event/claims and an exact published-claim support reference.
 */
export function projectPublicEventDetail(
  eventValue: unknown,
  lookupsValue: PublicProjectionLookups,
  geometryValues: unknown,
): EventDetail {
  const context = projectPublicEventForGeometry(eventValue, lookupsValue);
  const geometries = projectReferencedGeometries(geometryValues, context);
  return { ...context.eventView, geometries };
}

/**
 * Projects only previously projected EventDetail values into the unchanged
 * GeoJSON FeatureCollection allowlist. Feature order and IDs are deterministic.
 */
export function projectPublicFeatureCollection(
  eventDetails: readonly EventDetail[],
): PublicFeatureCollection {
  if (!Array.isArray(eventDetails)) fail("INVALID_EVENT_DETAIL");

  const features: PublicFeature[] = [];
  const featureIds = new Set<string>();
  const detailBudget: PositionBudget = { count: 0 };
  for (const detailValue of eventDetails as readonly unknown[]) {
    const detail = readProjectedDetail(detailValue, detailBudget);
    for (const geometry of detail.geometries) {
      if (features.length >= MAX_FEATURES) fail("GEOMETRY_LIMIT_EXCEEDED");
      const id = publicFeatureId(detail.eventId, detail.version, geometry.geometry_id);
      if (featureIds.has(id)) fail("INVALID_EVENT_DETAIL");
      featureIds.add(id);
      features.push({
        type: "Feature",
        id,
        geometry: geometry.geometry,
        properties: {
          event_id: detail.eventId,
          version: detail.version,
          title: detail.title,
          category: detail.category,
          lifecycle: detail.lifecycle,
          freshness: detail.freshness,
          geometry_role: geometry.role,
        },
      });
    }
  }

  features.sort((left, right) => compareStrings(left.properties.event_id, right.properties.event_id)
    || left.properties.version - right.properties.version
    || compareStrings(left.id, right.id));
  return { type: "FeatureCollection", features };
}

export interface PublicGeoJSONCandidateLookupBatch extends PublicProjectionLookups {
  readonly eventId: string;
  readonly eventVersion: number;
}

export interface PublicGeoJSONCandidateProjectionEnvelope {
  readonly candidates: readonly unknown[];
  readonly lookupBatches: readonly PublicGeoJSONCandidateLookupBatch[];
}

interface ValidatedGeoJSONCandidate {
  readonly datasetKind: "live";
  readonly eventId: string;
  readonly eventVersion: number;
  readonly category: EventDetail["category"];
  readonly lifecycle: EventDetail["lifecycle"];
  readonly freshness: EventDetail["freshness"]["status"];
  readonly geometryId: string;
  readonly eventRecordJson: unknown;
  readonly geometryRecordJson: unknown;
}

interface CandidateGroup {
  readonly eventId: string;
  readonly eventVersion: number;
  readonly category: EventDetail["category"];
  readonly lifecycle: EventDetail["lifecycle"];
  readonly freshness: EventDetail["freshness"]["status"];
  readonly eventRecordJson: unknown;
  readonly candidates: ValidatedGeoJSONCandidate[];
  lookupBatch?: PublicProjectionLookups;
}

interface CandidateWorkBudget {
  lookupEntries: number;
  eventArrayItems: number;
  eventCompareNodes: number;
  eventCompareStringUnits: number;
}

interface EventArrayBudget {
  count: number;
}

type ScopeNameKey = readonly [kind: "place" | "service" | "institution" | "audience", id: string];

const scopeNameKinds = new Set<ScopeNameKey[0]>(["place", "service", "institution", "audience"]);

/**
 * Projects only the bounded candidate rows selected by the accepted public
 * GeoJSON reader. It validates each Event through the strict L4 boundary but
 * intentionally does not resolve geometry references outside the selected set.
 */
export function projectPublicGeoJSONCandidateCollection(input: unknown): PublicFeatureCollection {
  try {
    return projectPublicGeoJSONCandidateCollectionUnchecked(input);
  } catch (error) {
    if (error instanceof PublicGeometryProjectionError || error instanceof PublicProjectionError) throw error;
    fail("INVALID_GEOJSON_CANDIDATES");
  }
}

function projectPublicGeoJSONCandidateCollectionUnchecked(input: unknown): PublicFeatureCollection {
  if (!isPlainRecord(input)
    || !hasExactKeys(input, ["candidates", "lookupBatches"])) {
    fail("INVALID_GEOJSON_CANDIDATES");
  }

  const candidateValues = readArray(input.candidates, 0, MAX_FEATURES, "GEOMETRY_LIMIT_EXCEEDED");
  const lookupBatchValues = readArray(input.lookupBatches, 0, MAX_FEATURES, "GEOMETRY_LIMIT_EXCEEDED");
  if (candidateValues.length === 0) {
    if (lookupBatchValues.length !== 0) fail("INVALID_GEOJSON_CANDIDATES");
    return { type: "FeatureCollection", features: [] };
  }

  const budget: CandidateWorkBudget = {
    lookupEntries: 0,
    eventArrayItems: 0,
    eventCompareNodes: 0,
    eventCompareStringUnits: 0,
  };
  const groups = new Map<string, CandidateGroup>();
  const versionByEvent = new Map<string, number>();
  const candidateIdentities = new Set<string>();
  const geometryIdsByEvent = new Map<string, Set<string>>();

  for (const candidateValue of candidateValues) {
    const candidate = readCandidate(candidateValue);
    const groupKey = publicVersionKey(candidate.eventId, candidate.eventVersion);
    const identity = JSON.stringify([candidate.eventId, candidate.eventVersion, candidate.geometryId]);
    if (candidateIdentities.has(identity)) fail("GEOMETRY_RESOLUTION_FAILED");
    candidateIdentities.add(identity);

    const priorVersion = versionByEvent.get(candidate.eventId);
    if (priorVersion !== undefined && priorVersion !== candidate.eventVersion) {
      fail("GEOMETRY_RESOLUTION_FAILED");
    }
    versionByEvent.set(candidate.eventId, candidate.eventVersion);

    const eventGeometryIds = geometryIdsByEvent.get(candidate.eventId) ?? new Set<string>();
    if (eventGeometryIds.has(candidate.geometryId)) fail("GEOMETRY_RESOLUTION_FAILED");
    eventGeometryIds.add(candidate.geometryId);
    geometryIdsByEvent.set(candidate.eventId, eventGeometryIds);

    const existing = groups.get(groupKey);
    if (existing === undefined) {
      groups.set(groupKey, {
        eventId: candidate.eventId,
        eventVersion: candidate.eventVersion,
        category: candidate.category,
        lifecycle: candidate.lifecycle,
        freshness: candidate.freshness,
        eventRecordJson: candidate.eventRecordJson,
        candidates: [candidate],
      });
      continue;
    }

    if (existing.category !== candidate.category
      || existing.lifecycle !== candidate.lifecycle
      || existing.freshness !== candidate.freshness
      || !sameJSONValue(existing.eventRecordJson, candidate.eventRecordJson, budget, 0)) {
      fail("GEOMETRY_RESOLUTION_FAILED");
    }
    existing.candidates.push(candidate);
  }

  const lookupGroups = new Set<string>();
  if (lookupBatchValues.length !== groups.size) fail("GEOMETRY_RESOLUTION_FAILED");
  for (const batchValue of lookupBatchValues) {
    const batch = readCandidateLookupBatch(batchValue, budget);
    const key = publicVersionKey(batch.eventId, batch.eventVersion);
    const group = groups.get(key);
    if (group === undefined || lookupGroups.has(key)) fail("GEOMETRY_RESOLUTION_FAILED");
    lookupGroups.add(key);
    group.lookupBatch = batch.lookups;
  }
  if (lookupGroups.size !== groups.size) fail("GEOMETRY_RESOLUTION_FAILED");

  const detailBudget: PositionBudget = { count: 0 };
  const projectedDetails: EventDetail[] = [];
  for (const group of groups.values()) {
    const lookups = group.lookupBatch;
    if (lookups === undefined) fail("GEOMETRY_RESOLUTION_FAILED");

    const impacts = preflightEventWork(group.eventRecordJson, lookups.impacts, budget);
    validateExactScopeNameBatch(group.eventRecordJson, impacts, lookups.scopeNames);
    const context = projectPublicEventForGeometry(group.eventRecordJson, lookups);
    if (context.eventId !== group.eventId
      || context.version !== group.eventVersion
      || context.eventView.event_id !== group.eventId
      || context.eventView.version !== group.eventVersion
      || context.eventView.category !== group.category
      || context.eventView.lifecycle !== group.lifecycle
      || context.eventView.freshness.status !== group.freshness) {
      fail("GEOMETRY_RESOLUTION_FAILED");
    }
    validateExactAttributionBatch(lookups.publicAttributions, context);

    const geometries: PublicGeometry[] = [];
    for (const candidate of group.candidates) {
      preflightKnownStrings(candidate.geometryRecordJson, [["display_label", 400]]);
      const geometry = readGeometryRecord(candidate.geometryRecordJson, detailBudget);
      if (candidate.datasetKind !== "live"
        || candidate.eventId !== context.eventId
        || candidate.eventVersion !== context.version
        || candidate.category !== context.eventView.category
        || candidate.lifecycle !== context.eventView.lifecycle
        || candidate.freshness !== context.eventView.freshness.status
        || candidate.geometryId !== geometry.geometry_id
        || geometry.datasetKind !== "live") {
        fail("GEOMETRY_RESOLUTION_FAILED");
      }

      const supportedBySameClaim = context.claims.some((claim) =>
        claim.geometryIds.includes(geometry.geometry_id)
        && claim.supports.some((claimSupport) =>
          geometry.sourceEvidence.some((geometrySupport) => supportsMatch(claimSupport, geometrySupport))));
      if (!supportedBySameClaim) fail("GEOMETRY_RESOLUTION_FAILED");

      geometries.push({
        geometry_id: geometry.geometry_id,
        role: geometry.role,
        geometry: geometry.geometry,
        precision_m: geometry.precision_m,
        label: geometry.label,
      });
    }
    projectedDetails.push({ ...context.eventView, geometries });
  }

  return projectPublicFeatureCollection(projectedDetails);
}

function readCandidate(value: unknown): ValidatedGeoJSONCandidate {
  if (!isRecord(value) || !hasExactKeys(value, candidateRowKeys)
    || value.datasetKind !== "live"
    || !isId(value.eventId)
    || !isPositiveInteger(value.eventVersion)
    || !isCategory(value.category)
    || !isLifecycle(value.lifecycle)
    || !isFreshness(value.freshness)
    || !isId(value.geometryId)
    || !isCandidateEventRecord(value.eventRecordJson, value)) {
    fail("INVALID_GEOJSON_CANDIDATES");
  }
  return {
    datasetKind: "live",
    eventId: value.eventId,
    eventVersion: value.eventVersion,
    category: value.category,
    lifecycle: value.lifecycle,
    freshness: value.freshness,
    geometryId: value.geometryId,
    eventRecordJson: value.eventRecordJson,
    geometryRecordJson: value.geometryRecordJson,
  };
}

function isCandidateEventRecord(
  value: unknown,
  candidate: Record<string, unknown>,
): boolean {
  return isRecord(value)
    && value.schema_version === "2.0"
    && value.record_type === "Event"
    && value.dataset_kind === "live"
    && value.event_id === candidate.eventId
    && value.version === candidate.eventVersion
    && value.category === candidate.category
    && value.lifecycle === candidate.lifecycle
    && isRecord(value.freshness)
    && value.freshness.status === candidate.freshness;
}

function readCandidateLookupBatch(
  value: unknown,
  budget: CandidateWorkBudget,
): { readonly eventId: string; readonly eventVersion: number; readonly lookups: PublicProjectionLookups } {
  if (!isRecord(value) || !hasExactKeys(value, candidateLookupBatchKeys)
    || !isId(value.eventId) || !isPositiveInteger(value.eventVersion)) {
    fail("INVALID_GEOJSON_CANDIDATES");
  }

  const scopeNames = readArray(value.scopeNames, 0, MAX_LOOKUP_ENTRIES_PER_BATCH, "GEOMETRY_LIMIT_EXCEEDED");
  const publicAttributions = readArray(value.publicAttributions, 0, MAX_LOOKUP_ENTRIES_PER_BATCH, "GEOMETRY_LIMIT_EXCEEDED");
  const impacts = readArray(value.impacts, 0, MAX_LOOKUP_ENTRIES_PER_BATCH, "GEOMETRY_LIMIT_EXCEEDED");
  for (const scopeName of scopeNames) preflightKnownStrings(scopeName, [["display_name", 400]]);
  for (const attribution of publicAttributions) {
    preflightKnownStrings(attribution, [
      ["display_name", 400], ["url", 2048], ["published_at", 64], ["observed_at", 64],
    ]);
    if (isRecord(attribution) && attribution.excerpt_public_use_approved === true) {
      preflightKnownStrings(attribution, [["excerpt", 600]]);
    }
    if (isRecord(attribution) && typeof attribution.permitted_text_hash === "string"
      && attribution.permitted_text_hash.length > 64) {
      fail("GEOMETRY_LIMIT_EXCEEDED");
    }
  }
  budget.lookupEntries += scopeNames.length + publicAttributions.length + impacts.length;
  if (budget.lookupEntries > MAX_TOTAL_LOOKUP_ENTRIES) fail("GEOMETRY_LIMIT_EXCEEDED");

  return {
    eventId: value.eventId,
    eventVersion: value.eventVersion,
    lookups: { scopeNames, publicAttributions, impacts },
  };
}

function preflightEventWork(
  eventValue: unknown,
  impactValues: readonly unknown[],
  budget: CandidateWorkBudget,
): readonly unknown[] {
  if (!isRecord(eventValue)) fail("INVALID_GEOJSON_CANDIDATES");
  const eventBudget: EventArrayBudget = { count: 0 };
  const readBounded = (value: unknown, minimum = 0): unknown[] =>
    readBoundedEventArray(value, minimum, eventBudget, budget);

  preflightKnownStrings(eventValue, [["title", 480], ["summary", 4_000], ["published_at", 64]]);
  preflightDateInputs(eventValue.event_time);
  preflightDateInputs(eventValue.validity);
  preflightDateInputs(eventValue.freshness);
  const tags = readBounded(eventValue.tags);
  for (const tagValue of tags) preflightKnownStrings(tagValue, [["value", 128]]);
  const claims = readBounded(eventValue.claims, 1);
  readBounded(eventValue.impact_refs);
  preflightScopeArrays(eventValue.scope, readBounded);

  for (const claimValue of claims) {
    if (!isRecord(claimValue)) fail("INVALID_GEOJSON_CANDIDATES");
    preflightKnownStrings(claimValue, [["text", 8_000]]);
    preflightDateInputs(claimValue.event_time);
    preflightDateInputs(claimValue.validity);
    preflightScopeArrays(claimValue.scope, readBounded);
    const qualifiers = readBounded(claimValue.qualifiers);
    for (const qualifier of qualifiers) preflightStringLength(qualifier, 1_000);
    const support = readBounded(claimValue.support, 1);
    const contradictions = readBounded(claimValue.contradictions);
    const contextEvidence = readBounded(claimValue.context_evidence);
    for (const reference of [...support, ...contradictions, ...contextEvidence]) {
      preflightKnownStrings(reference, [["permitted_text_hash", 64]]);
    }
    readBounded(claimValue.origin_ids, 1);
  }

  for (const impactValue of impactValues) {
    if (!isRecord(impactValue)) fail("INVALID_GEOJSON_CANDIDATES");
    preflightKnownStrings(impactValue, [["title", 480], ["description", 4_000], ["published_at", 64]]);
    preflightDateInputs(impactValue.event_time);
    preflightDateInputs(impactValue.validity);
    preflightDateInputs(impactValue.freshness);
    preflightScopeArrays(impactValue.scope, readBounded);
    readBounded(impactValue.supporting_claim_ids, 1);
  }

  if (eventBudget.count > MAX_EVENT_ARRAY_ITEMS_PER_GROUP) fail("GEOMETRY_LIMIT_EXCEEDED");
  return impactValues;
}

function preflightKnownStrings(value: unknown, fields: readonly (readonly [string, number])[]): void {
  if (!isRecord(value)) return;
  for (const [field, maximum] of fields) preflightStringLength(value[field], maximum);
}

function preflightStringLength(value: unknown, maximum: number): void {
  if (typeof value === "string" && value.length > maximum) fail("GEOMETRY_LIMIT_EXCEEDED");
}

function preflightDateInputs(value: unknown): void {
  preflightKnownStrings(value, [
    ["start", 64], ["end", 64], ["valid_from", 64], ["valid_until", 64],
    ["evaluated_at", 64], ["review_due_at", 64], ["published_at", 64],
  ]);
}
function readBoundedEventArray(
  value: unknown,
  minimum: number,
  eventBudget: EventArrayBudget,
  requestBudget: CandidateWorkBudget,
): unknown[] {
  if (!Array.isArray(value) || value.length < minimum) fail("INVALID_GEOJSON_CANDIDATES");
  if (value.length > MAX_EVENT_ARRAY_ITEMS) fail("GEOMETRY_LIMIT_EXCEEDED");
  const values = readArray(value, minimum, MAX_EVENT_ARRAY_ITEMS, "INVALID_GEOJSON_CANDIDATES");
  eventBudget.count += values.length;
  if (eventBudget.count > MAX_EVENT_ARRAY_ITEMS_PER_GROUP) fail("GEOMETRY_LIMIT_EXCEEDED");
  requestBudget.eventArrayItems += values.length;
  if (requestBudget.eventArrayItems > MAX_TOTAL_EVENT_ARRAY_ITEMS) fail("GEOMETRY_LIMIT_EXCEEDED");
  return values;
}

function preflightScopeArrays(
  value: unknown,
  readBounded: (value: unknown, minimum?: number) => unknown[],
): void {
  if (!isRecord(value)) fail("INVALID_GEOJSON_CANDIDATES");
  readBounded(value.place_ids);
  readBounded(value.service_ids);
  readBounded(value.institution_ids);
  readBounded(value.audience_ids);
  readBounded(value.geometry_ids);
}

function validateExactScopeNameBatch(
  eventValue: unknown,
  impactValues: readonly unknown[],
  values: readonly unknown[],
): void {
  if (!isRecord(eventValue)) fail("INVALID_GEOJSON_CANDIDATES");
  const expected = new Set<string>();
  collectScopeNameKeys(eventValue.scope, expected);
  const claims = readArray(eventValue.claims, 1, MAX_EVENT_ARRAY_ITEMS, "INVALID_GEOJSON_CANDIDATES");
  for (const claimValue of claims) {
    if (!isRecord(claimValue)) fail("INVALID_GEOJSON_CANDIDATES");
    collectScopeNameKeys(claimValue.scope, expected);
  }
  for (const impactValue of impactValues) {
    if (!isRecord(impactValue)) fail("INVALID_GEOJSON_CANDIDATES");
    collectScopeNameKeys(impactValue.scope, expected);
  }

  const seen = new Set<string>();
  for (const value of values) {
    if (!isRecord(value)
      || typeof value.entity_type !== "string"
      || !scopeNameKinds.has(value.entity_type as ScopeNameKey[0])
      || !isId(value.id)) {
      fail("INVALID_GEOJSON_CANDIDATES");
    }
    const key = JSON.stringify([value.entity_type, value.id]);
    if (!expected.has(key) || seen.has(key)) fail("GEOMETRY_RESOLUTION_FAILED");
    seen.add(key);
  }
  if (seen.size !== expected.size) fail("GEOMETRY_RESOLUTION_FAILED");
}

function collectScopeNameKeys(value: unknown, output: Set<string>): void {
  if (!isRecord(value)) fail("INVALID_GEOJSON_CANDIDATES");
  const fields: ReadonlyArray<readonly [ScopeNameKey[0], unknown]> = [
    ["place", value.place_ids],
    ["service", value.service_ids],
    ["institution", value.institution_ids],
    ["audience", value.audience_ids],
  ];
  for (const [kind, idsValue] of fields) {
    const ids = readArray(idsValue, 0, MAX_EVENT_ARRAY_ITEMS, "INVALID_GEOJSON_CANDIDATES");
    for (const idValue of ids) {
      if (!isId(idValue)) fail("INVALID_GEOJSON_CANDIDATES");
      output.add(JSON.stringify([kind, idValue]));
    }
  }
}

function validateExactAttributionBatch(
  values: readonly unknown[],
  context: PublicEventGeometryProjectionContext,
): void {
  const expected = new Set<string>();
  for (const claim of context.claims) {
    for (const support of claim.supports) expected.add(supportKey(support));
  }

  const seen = new Set<string>();
  for (const value of values) {
    if (!isRecord(value)
      || value.dataset_kind !== "live"
      || value.offset_unit !== "unicode_code_points"
      || value.relation !== "supports"
      || !isId(value.report_revision_id)
      || typeof value.permitted_text_hash !== "string"
      || !hashPattern.test(value.permitted_text_hash)) {
      fail("INVALID_GEOJSON_CANDIDATES");
    }
    const spanStart = readInteger(value.span_start, 0, 10_000_000, "INVALID_GEOJSON_CANDIDATES");
    const spanEnd = readInteger(value.span_end, 1, 10_000_000, "INVALID_GEOJSON_CANDIDATES");
    if (spanEnd <= spanStart) fail("INVALID_GEOJSON_CANDIDATES");
    const key = supportKey({
      reportRevisionId: value.report_revision_id,
      permittedTextHash: value.permitted_text_hash,
      spanStart,
      spanEnd,
      offsetUnit: "unicode_code_points",
      relation: "supports",
    });
    if (!expected.has(key) || seen.has(key)) fail("GEOMETRY_RESOLUTION_FAILED");
    seen.add(key);
  }
  if (seen.size !== expected.size) fail("GEOMETRY_RESOLUTION_FAILED");
}

function sameJSONValue(
  left: unknown,
  right: unknown,
  budget: CandidateWorkBudget,
  depth: number,
): boolean {
  if (typeof left === "string" && typeof right === "string") {
    budget.eventCompareStringUnits += left.length + right.length;
    if (budget.eventCompareStringUnits > MAX_EVENT_COMPARE_STRING_UNITS) fail("GEOMETRY_LIMIT_EXCEEDED");
    return left === right;
  }
  if (typeof left === "number" && typeof right === "number") return Object.is(left, right);
  if (left === right && (left === null || typeof left !== "object")) return true;
  budget.eventCompareNodes += 1;
  if (budget.eventCompareNodes > MAX_EVENT_COMPARE_NODES || depth > MAX_JSON_DEPTH) {
    fail("GEOMETRY_LIMIT_EXCEEDED");
  }

  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    const leftValues = readArray(left, 0, MAX_EVENT_ARRAY_ITEMS, "INVALID_GEOJSON_CANDIDATES");
    const rightValues = readArray(right, 0, MAX_EVENT_ARRAY_ITEMS, "INVALID_GEOJSON_CANDIDATES");
    for (let index = 0; index < leftValues.length; index += 1) {
      if (!sameJSONValue(leftValues[index], rightValues[index], budget, depth + 1)) return false;
    }
    return true;
  }

  if (!isRecord(left) || !isRecord(right)) return false;
  const leftKeys = jsonRecordKeys(left);
  const rightKeys = jsonRecordKeys(right);
  if (leftKeys.length !== rightKeys.length) return false;
  for (let index = 0; index < leftKeys.length; index += 1) {
    if (leftKeys[index] !== rightKeys[index]) return false;
    const leftDescriptor = Object.getOwnPropertyDescriptor(left, leftKeys[index]!);
    const rightDescriptor = Object.getOwnPropertyDescriptor(right, rightKeys[index]!);
    if (leftDescriptor === undefined || rightDescriptor === undefined
      || !("value" in leftDescriptor) || !("value" in rightDescriptor)
      || !sameJSONValue(leftDescriptor.value, rightDescriptor.value, budget, depth + 1)) return false;
  }
  return true;
}

function jsonRecordKeys(value: Record<string, unknown>): string[] {
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail("INVALID_GEOJSON_CANDIDATES");
  const keys = Reflect.ownKeys(value);
  if (keys.length > 256 || keys.some((key) => typeof key !== "string")) {
    fail("GEOMETRY_LIMIT_EXCEEDED");
  }
  const result = keys as string[];
  result.sort(compareStrings);
  for (const key of result) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
      fail("INVALID_GEOJSON_CANDIDATES");
    }
  }
  return result;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function publicVersionKey(eventId: string, version: number): string {
  return JSON.stringify([eventId, version]);
}
function projectReferencedGeometries(
  values: unknown,
  context: PublicEventGeometryProjectionContext,
): PublicGeometry[] {
  if (!Array.isArray(values)) fail("INVALID_GEOMETRIES");

  const referencedIds = new Set(context.geometryIds);
  for (const claim of context.claims) {
    for (const geometryId of claim.geometryIds) referencedIds.add(geometryId);
  }
  if (referencedIds.size > MAX_PUBLIC_GEOMETRIES || values.length > MAX_PUBLIC_GEOMETRIES) {
    fail("GEOMETRY_LIMIT_EXCEEDED");
  }
  if (values.length !== referencedIds.size) fail("GEOMETRY_RESOLUTION_FAILED");

  const seenIds = new Set<string>();
  const result: PublicGeometry[] = [];
  const detailBudget: PositionBudget = { count: 0 };
  for (const value of values) {
    const geometry = readGeometryRecord(value, detailBudget);
    if (geometry.datasetKind !== "live" || !referencedIds.has(geometry.geometry_id)) {
      fail("GEOMETRY_RESOLUTION_FAILED");
    }
    if (seenIds.has(geometry.geometry_id)) fail("GEOMETRY_RESOLUTION_FAILED");
    seenIds.add(geometry.geometry_id);

    const isSupportedByReferencingClaim = context.claims.some((claim) =>
      claim.geometryIds.includes(geometry.geometry_id)
      && claim.supports.some((claimSupport) =>
        geometry.sourceEvidence.some((geometrySupport) => supportsMatch(claimSupport, geometrySupport))));
    if (!isSupportedByReferencingClaim) fail("GEOMETRY_RESOLUTION_FAILED");

    result.push({
      geometry_id: geometry.geometry_id,
      role: geometry.role,
      geometry: geometry.geometry,
      precision_m: geometry.precision_m,
      label: geometry.label,
    });
  }
  if (seenIds.size !== referencedIds.size) fail("GEOMETRY_RESOLUTION_FAILED");
  result.sort((left, right) => compareStrings(left.geometry_id, right.geometry_id));
  return result;
}

function readGeometryRecord(value: unknown, detailBudget: PositionBudget): ValidatedGeometryRecord {
  if (!isRecord(value)
    || value.schema_version !== "2.0"
    || value.record_type !== "Geometry"
    || !isId(value.trace_id)
    || !isDatasetKind(value.dataset_kind)
    || !isId(value.geometry_id)
    || typeof value.coordinate_reference_system !== "string"
    || value.coordinate_reference_system !== "OGC:CRS84") {
    fail("INVALID_GEOMETRY");
  }

  const role = readEnum(value.role, geometryRoles, "INVALID_GEOMETRY");
  if (typeof value.precision_basis !== "string" || !precisionBases.has(value.precision_basis)) {
    fail("INVALID_GEOMETRY");
  }

  let precisionM: number | null;
  if (value.precision_m === null) {
    precisionM = null;
  } else if (typeof value.precision_m === "number"
    && Number.isFinite(value.precision_m)
    && value.precision_m >= 0
    && value.precision_m <= 10_000_000) {
    precisionM = value.precision_m;
  } else {
    fail("INVALID_GEOMETRY");
  }

  let label: string | null;
  if (value.display_label === null) {
    label = null;
  } else if (typeof value.display_label === "string"
    && codePointLength(value.display_label) >= 1
    && codePointLength(value.display_label) <= 200) {
    label = value.display_label;
  } else {
    fail("INVALID_GEOMETRY");
  }

  const counter: CoordinateCounter = { count: 0, detailBudget };
  const geometry = readGeoJSONGeometry(value.geojson, counter);
  if (!roleAcceptsGeometry(role, geometry.type)) fail("INVALID_GEOMETRY");
  const sourceEvidence = readSourceEvidence(value.source_evidence);

  return {
    datasetKind: value.dataset_kind,
    geometry_id: value.geometry_id,
    role,
    geometry,
    precision_m: precisionM,
    label,
    sourceEvidence,
  };
}

function readSourceEvidence(value: unknown): SupportReference[] {
  const references = readArray(value, 1, MAX_SUPPORT_REFERENCES, "INVALID_GEOMETRY");
  const seen = new Set<string>();
  return references.map((referenceValue) => {
    if (!isRecord(referenceValue)) fail("INVALID_GEOMETRY");
    const revisionId = readId(referenceValue.report_revision_id, "INVALID_GEOMETRY");
    const hash = referenceValue.permitted_text_hash;
    if (typeof hash !== "string" || hash.length !== 64 || !hashPattern.test(hash)) fail("INVALID_GEOMETRY");
    const spanStart = readInteger(referenceValue.span_start, 0, 10_000_000, "INVALID_GEOMETRY");
    const spanEnd = readInteger(referenceValue.span_end, 1, 10_000_000, "INVALID_GEOMETRY");
    if (spanEnd <= spanStart
      || referenceValue.offset_unit !== "unicode_code_points"
      || referenceValue.relation !== "supports"
      || !hasExactKeys(referenceValue, [
        "report_revision_id", "permitted_text_hash", "span_start", "span_end", "offset_unit", "relation",
      ])) {
      fail("INVALID_GEOMETRY");
    }

    const parsed: SupportReference = {
      reportRevisionId: revisionId,
      permittedTextHash: hash,
      spanStart,
      spanEnd,
      offsetUnit: "unicode_code_points",
      relation: "supports",
    };
    const key = supportKey(parsed);
    if (seen.has(key)) fail("INVALID_GEOMETRY");
    seen.add(key);
    return parsed;
  });
}

function readGeoJSONGeometry(value: unknown, counter: CoordinateCounter): PublicGeoJSONGeometry {
  if (!isRecord(value) || !hasExactKeys(value, ["type", "coordinates"])) fail("INVALID_GEOMETRY");
  const type = value.type;
  const coordinates = value.coordinates;
  if (type === "Point") {
    return { type, coordinates: readPosition(coordinates, counter) };
  }
  if (type === "LineString") {
    return { type, coordinates: readLine(coordinates, counter) };
  }
  if (type === "Polygon") {
    return { type, coordinates: readPolygon(coordinates, counter) };
  }
  if (type === "MultiPoint") {
    return {
      type,
      coordinates: readArray(coordinates, 1, MAX_GEOMETRY_POSITIONS, "INVALID_GEOMETRY")
        .map((position) => readPosition(position, counter)),
    };
  }
  if (type === "MultiLineString") {
    return {
      type,
      coordinates: readArray(coordinates, 1, MAX_GEOMETRY_POSITIONS, "INVALID_GEOMETRY")
        .map((line) => readLine(line, counter)),
    };
  }
  if (type === "MultiPolygon") {
    return {
      type,
      coordinates: readArray(coordinates, 1, MAX_GEOMETRY_POSITIONS, "INVALID_GEOMETRY")
        .map((polygon) => readPolygon(polygon, counter)),
    };
  }
  fail("INVALID_GEOMETRY");
}

function readPosition(value: unknown, counter: CoordinateCounter): PublicGeoJSONPosition {
  const position = readArray(value, 2, 2, "INVALID_GEOMETRY");
  const longitude = position[0];
  const latitude = position[1];
  if (typeof longitude !== "number" || !Number.isFinite(longitude) || longitude < -180 || longitude > 180
    || typeof latitude !== "number" || !Number.isFinite(latitude) || latitude < -90 || latitude > 90) {
    fail("INVALID_GEOMETRY");
  }
  counter.count += 1;
  counter.detailBudget.count += 1;
  if (counter.count > MAX_GEOMETRY_POSITIONS || counter.detailBudget.count > MAX_DETAIL_POSITIONS) {
    fail("GEOMETRY_LIMIT_EXCEEDED");
  }
  return [longitude, latitude];
}

function readLine(value: unknown, counter: CoordinateCounter): PublicGeoJSONPosition[] {
  return readArray(value, 2, MAX_GEOMETRY_POSITIONS, "INVALID_GEOMETRY")
    .map((position) => readPosition(position, counter));
}

function readRing(value: unknown, counter: CoordinateCounter): PublicGeoJSONPosition[] {
  const ring = readArray(value, 4, MAX_GEOMETRY_POSITIONS, "INVALID_GEOMETRY")
    .map((position) => readPosition(position, counter));
  const first = ring[0]!;
  const last = ring[ring.length - 1]!;
  if (first[0] !== last[0] || first[1] !== last[1]) fail("INVALID_GEOMETRY");
  return ring;
}

function readPolygon(value: unknown, counter: CoordinateCounter): PublicGeoJSONPosition[][] {
  return readArray(value, 1, MAX_GEOMETRY_POSITIONS, "INVALID_GEOMETRY")
    .map((ring) => readRing(ring, counter));
}

function readProjectedDetail(value: unknown, budget: PositionBudget): {
  readonly eventId: string;
  readonly version: number;
  readonly title: string;
  readonly category: EventDetail["category"];
  readonly lifecycle: EventDetail["lifecycle"];
  readonly freshness: EventDetail["freshness"]["status"];
  readonly geometries: readonly PublicGeometry[];
} {
  if (!isRecord(value)
    || !isId(value.event_id)
    || !isPositiveInteger(value.version)
    || !isBoundedString(value.title, 240)
    || !isCategory(value.category)
    || !isLifecycle(value.lifecycle)
    || !isRecord(value.freshness)
    || !isFreshness(value.freshness.status)
    || !Array.isArray(value.geometries)) {
    fail("INVALID_EVENT_DETAIL");
  }
  if (value.geometries.length > MAX_PUBLIC_GEOMETRIES) fail("GEOMETRY_LIMIT_EXCEEDED");
  const geometries = value.geometries.map((geometryValue) => readProjectedGeometry(geometryValue, budget));
  return {
    eventId: value.event_id,
    version: value.version,
    title: value.title,
    category: value.category,
    lifecycle: value.lifecycle,
    freshness: value.freshness.status,
    geometries,
  };
}

function readProjectedGeometry(value: unknown, budget: PositionBudget): PublicGeometry {
  if (!isRecord(value)
    || !hasExactKeys(value, ["geometry_id", "role", "geometry", "precision_m", "label"])
    || !isId(value.geometry_id)
    || typeof value.role !== "string"
    || !geometryRoles.has(value.role as PublicGeometry["role"])) {
    fail("INVALID_EVENT_DETAIL");
  }
  const counter: CoordinateCounter = { count: 0, detailBudget: budget };
  const geometry = readGeoJSONGeometry(value.geometry, counter);
  const role = value.role as PublicGeometry["role"];
  if (!roleAcceptsGeometry(role, geometry.type)) fail("INVALID_EVENT_DETAIL");

  let precisionM: number | null;
  if (value.precision_m === null) {
    precisionM = null;
  } else if (typeof value.precision_m === "number"
    && Number.isFinite(value.precision_m)
    && value.precision_m >= 0
    && value.precision_m <= 10_000_000) {
    precisionM = value.precision_m;
  } else {
    fail("INVALID_EVENT_DETAIL");
  }

  let label: string | null;
  if (value.label === null) {
    label = null;
  } else if (typeof value.label === "string"
    && codePointLength(value.label) >= 1
    && codePointLength(value.label) <= 200) {
    label = value.label;
  } else {
    fail("INVALID_EVENT_DETAIL");
  }

  return {
    geometry_id: value.geometry_id,
    role,
    geometry,
    precision_m: precisionM,
    label,
  };
}

function roleAcceptsGeometry(role: PublicGeometry["role"], type: PublicGeoJSONGeometry["type"]): boolean {
  if (pointRoles.has(role)) return type === "Point" || type === "MultiPoint";
  if (lineRoles.has(role)) return type === "LineString" || type === "MultiLineString";
  if (areaRoles.has(role)) return type === "Polygon" || type === "MultiPolygon";
  return false;
}

function supportsMatch(left: PublicGeometrySupportReference, right: SupportReference): boolean {
  return left.reportRevisionId === right.reportRevisionId
    && left.permittedTextHash === right.permittedTextHash
    && left.spanStart === right.spanStart
    && left.spanEnd === right.spanEnd
    && left.offsetUnit === right.offsetUnit
    && left.relation === right.relation;
}

function supportKey(reference: SupportReference): string {
  return JSON.stringify([
    reference.reportRevisionId,
    reference.permittedTextHash,
    reference.spanStart,
    reference.spanEnd,
    reference.offsetUnit,
    reference.relation,
  ]);
}

function publicFeatureId(eventId: string, version: number, geometryId: string): string {
  return JSON.stringify([eventId, version, geometryId]);
}

function readArray(value: unknown, minimum: number, maximum: number, code: PublicGeometryProjectionErrorCode): unknown[] {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) fail(code);
  for (const key of Reflect.ownKeys(value)) {
    if (key === "length") continue;
    if (typeof key !== "string" || !/^(0|[1-9][0-9]*)$/u.test(key) || Number(key) >= value.length) fail(code);
  }
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.prototype.hasOwnProperty.call(value, index)) fail(code);
  }
  return value;
}

function readEnum<const T extends string>(value: unknown, allowed: ReadonlySet<T>, code: PublicGeometryProjectionErrorCode): T {
  if (typeof value !== "string" || !allowed.has(value as T)) fail(code);
  return value as T;
}

function readId(value: unknown, code: PublicGeometryProjectionErrorCode): string {
  if (!isId(value)) fail(code);
  return value;
}

function readInteger(value: unknown, minimum: number, maximum: number, code: PublicGeometryProjectionErrorCode): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) fail(code);
  return value;
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Reflect.ownKeys(value);
  return keys.length === expected.length
    && expected.every((key) => Object.prototype.hasOwnProperty.call(value, key))
    && keys.every((key) => typeof key === "string" && expected.includes(key));
}

function isId(value: unknown): value is string {
  return typeof value === "string" && value.length <= 128 && idPattern.test(value);
}

function isDatasetKind(value: unknown): value is "live" | "historical" | "synthetic" {
  return value === "live" || value === "historical" || value === "synthetic";
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 && value <= 2_147_483_647;
}

function isBoundedString(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.length > 0 && codePointLength(value) <= maxLength;
}

function isCategory(value: unknown): value is EventDetail["category"] {
  return typeof value === "string" && [
    "crime_personal_security", "demonstrations_public_gatherings", "crowds_major_events",
    "violence_immediate_threats", "disasters_weather", "fires_infrastructure_hazards",
    "transport_road_incidents", "utilities_essential_services", "health_environmental_advisories",
    "group_specific_critical_notices",
  ].includes(value);
}

function isLifecycle(value: unknown): value is EventDetail["lifecycle"] {
  return value === "planned" || value === "ongoing" || value === "resolved" || value === "cancelled" || value === "unknown";
}

function isFreshness(value: unknown): value is EventDetail["freshness"]["status"] {
  return value === "current" || value === "needs_update" || value === "expired";
}

function codePointLength(value: string): number {
  return Array.from(value).length;
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function fail(code: PublicGeometryProjectionErrorCode): never {
  throw new PublicGeometryProjectionError(code);
}
