import type { EventView, Freshness, Lifecycle, PublicClaim, PublicImpact, TimeScope, Validity } from "../../contracts/public-api.js";

/**
 * Lookup rows are deliberately runtime-checked. They are supplied by trusted
 * application code, but can still contain stale, duplicated, or malformed data.
 */
export interface PublicProjectionLookups {
  readonly scopeNames: readonly unknown[];
  readonly publicAttributions: readonly unknown[];
  readonly impacts: readonly unknown[];
}

export type PublicProjectionErrorCode =
  | "INVALID_EVENT"
  | "EVENT_NOT_PUBLIC"
  | "LOOKUPS_INVALID"
  | "NAME_LOOKUP_FAILED"
  | "ATTRIBUTION_FAILED"
  | "INVALID_IMPACT"
  | "IMPACT_RESOLUTION_FAILED";

const errorMessages: Record<PublicProjectionErrorCode, string> = {
  INVALID_EVENT: "The event cannot be projected.",
  EVENT_NOT_PUBLIC: "The event is not eligible for the public view.",
  LOOKUPS_INVALID: "The projection lookup inputs are invalid.",
  NAME_LOOKUP_FAILED: "A public scope name could not be resolved.",
  ATTRIBUTION_FAILED: "A public source attribution could not be resolved.",
  INVALID_IMPACT: "An impact record cannot be projected.",
  IMPACT_RESOLUTION_FAILED: "The event impact versions could not be resolved.",
};

/** A bounded failure with no input values or private record content. */
export class PublicProjectionError extends Error {
  constructor(readonly code: PublicProjectionErrorCode) {
    super(errorMessages[code]);
    this.name = "PublicProjectionError";
  }
}

type ScopeKind = "place" | "service" | "institution" | "audience";
type TagNamespace = "topic" | "service" | "audience" | "hazard" | "transport_mode" | "place_type";
type ClaimEvidenceLabel = PublicClaim["evidence_label"];
type ImpactType = PublicImpact["impact_type"];

interface EvidenceReference {
  readonly reportRevisionId: string;
  readonly permittedTextHash: string;
  readonly spanStart: number;
  readonly spanEnd: number;
  readonly offsetUnit: "unicode_code_points";
  readonly relation: "supports" | "contradicts" | "updates" | "context";
}

interface StoredScope {
  readonly placeIds: readonly string[];
  readonly serviceIds: readonly string[];
  readonly institutionIds: readonly string[];
  readonly audienceIds: readonly string[];
  readonly geometryIds: readonly string[];
}

interface ValidatedClaim {
  readonly claimId: string;
  readonly text: string;
  readonly eventTime: TimeScope;
  readonly validity: Validity;
  readonly scope: StoredScope;
  readonly qualifiers: readonly string[];
  readonly support: readonly EvidenceReference[];
  readonly evidenceLabel: ClaimEvidenceLabel;
}

interface ValidatedEvent {
  readonly eventId: string;
  readonly version: number;
  readonly title: string;
  readonly summary: string;
  readonly category: EventView["category"];
  readonly tags: EventView["tags"];
  readonly lifecycle: Lifecycle;
  readonly freshness: Freshness;
  readonly eventTime: TimeScope;
  readonly validity: Validity;
  readonly scope: StoredScope;
  readonly claims: readonly ValidatedClaim[];
  readonly impactRefs: readonly { readonly impactId: string; readonly version: number }[];
  readonly publishedAt: string;
}

interface ValidatedImpact {
  readonly datasetKind: "live" | "historical" | "synthetic";
  readonly impactId: string;
  readonly version: number;
  readonly eventId: string;
  readonly eventVersion: number;
  readonly impactType: ImpactType;
  readonly title: string;
  readonly description: string;
  readonly lifecycle: Lifecycle;
  readonly freshness: Freshness;
  readonly eventTime: TimeScope;
  readonly validity: Validity;
  readonly scope: StoredScope;
  readonly supportingClaimIds: readonly string[];
}

const idPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u;
const hashPattern = /^[a-f0-9]{64}$/u;
const tagValuePattern = /^[a-z][a-z0-9_]*$/u;
const categories = new Set<EventView["category"]>([
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
const lifecycles = new Set<Lifecycle>(["planned", "ongoing", "resolved", "cancelled", "unknown"]);
const freshnessStatuses = new Set<Freshness["status"]>(["current", "needs_update", "expired"]);
const freshnessBases = new Set<Freshness["basis"]>([
  "source_validity",
  "fast_observation_review",
  "undated_advisory_review",
  "manual_review",
  "unknown",
]);
const tagNamespaces = new Set<TagNamespace>(["topic", "service", "audience", "hazard", "transport_mode", "place_type"]);
const claimEvidenceLabels = new Set<ClaimEvidenceLabel>([
  "issuer_notice",
  "attributed_report",
  "independent_corroboration",
  "crowdsourced_observation",
]);
const impactTypes = new Set<ImpactType>([
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
/**
 * Projects one schema 2.0 Event into the existing public EventView allowlist.
 * Unknown storage fields are ignored. The live-shaped values used by unit tests
 * are synthetic test fixtures, not live source records, publications, or rights.
 */
export function projectPublicEvent(eventValue: unknown, lookupsValue: PublicProjectionLookups): EventView {
  const lookups = validateLookups(lookupsValue);
  const event = validateEvent(eventValue);
  const eventScope = projectScope(event.scope, lookups.scopeNames);
  const projectedClaims: PublicClaim[] = [];

  for (const claim of event.claims) {
    projectedClaims.push({
      claim_id: claim.claimId,
      text: claim.text,
      event_time: claim.eventTime,
      validity: claim.validity,
      scope: projectScope(claim.scope, lookups.scopeNames),
      qualifiers: sortedStrings(claim.qualifiers),
      evidence_label: claim.evidenceLabel,
      sources: projectSources(event.datasetKind, claim.support, lookups.publicAttributions),
    });
  }

  const projectedImpacts = projectImpacts(event, lookups.impacts, lookups.scopeNames);

  projectedClaims.sort((left, right) => compareStrings(left.claim_id, right.claim_id));
  projectedImpacts.sort((left, right) => compareStrings(left.impact_id, right.impact_id)
    || left.version - right.version);

  return {
    event_id: event.eventId,
    version: event.version,
    title: event.title,
    summary: event.summary,
    category: event.category,
    tags: event.tags,
    lifecycle: event.lifecycle,
    freshness: event.freshness,
    event_time: event.eventTime,
    validity: event.validity,
    scope: eventScope,
    claims: projectedClaims,
    impacts: projectedImpacts,
    published_at: event.publishedAt,
  };
}

function validateLookups(value: unknown): {
  readonly scopeNames: readonly unknown[];
  readonly publicAttributions: readonly unknown[];
  readonly impacts: readonly unknown[];
} {
  if (!isRecord(value)
    || !Array.isArray(value.scopeNames)
    || !Array.isArray(value.publicAttributions)
    || !Array.isArray(value.impacts)) {
    fail("LOOKUPS_INVALID");
  }
  return {
    scopeNames: value.scopeNames,
    publicAttributions: value.publicAttributions,
    impacts: value.impacts,
  };
}

function validateEvent(value: unknown): ValidatedEvent & { readonly datasetKind: "live" } {
  if (!isRecord(value)) fail("INVALID_EVENT");
  requireEqual(value.schema_version, "2.0", "INVALID_EVENT");
  requireEqual(value.record_type, "Event", "INVALID_EVENT");
  readId(value.trace_id, "INVALID_EVENT");
  const datasetKind = readEnum(value.dataset_kind, ["live", "historical", "synthetic"] as const, "INVALID_EVENT");
  if (datasetKind !== "live") fail("EVENT_NOT_PUBLIC");

  const publicationStatus = readEnum(value.publication_status, ["published", "withdrawn"] as const, "INVALID_EVENT");
  if (publicationStatus !== "published") fail("EVENT_NOT_PUBLIC");

  const eventId = readId(value.event_id, "INVALID_EVENT");
  const version = readVersion(value.version, "INVALID_EVENT");
  const supersedesVersion = value.supersedes_version === null
    ? null
    : readVersion(value.supersedes_version, "INVALID_EVENT");
  if ((version === 1 && supersedesVersion !== null)
    || (version > 1 && supersedesVersion !== version - 1)) fail("INVALID_EVENT");

  const title = readString(value.title, 240, "INVALID_EVENT");
  const summary = readString(value.summary, 2000, "INVALID_EVENT");
  const category = readEnum(value.category, [...categories], "INVALID_EVENT");
  const tags = readTags(value.tags, "INVALID_EVENT");
  const lifecycle = readEnum(value.lifecycle, [...lifecycles], "INVALID_EVENT");
  const freshness = readFreshness(value.freshness, "INVALID_EVENT");
  const eventTime = readTimeScope(value.event_time, "INVALID_EVENT");
  const validity = readValidity(value.validity, "INVALID_EVENT");
  const scope = readScope(value.scope, "INVALID_EVENT");
  requireEqual(value.withdrawal_reason, null, "INVALID_EVENT");
  readId(value.publication_decision_id, "INVALID_EVENT");
  if (value.withdrawn_at !== null) fail("INVALID_EVENT");
  const publishedAt = readDateTime(value.published_at, "INVALID_EVENT");

  if (!Array.isArray(value.claims) || value.claims.length === 0) fail("INVALID_EVENT");
  const claims: ValidatedClaim[] = [];
  const claimIds = new Set<string>();
  for (const claimValue of value.claims) {
    const claim = readClaim(claimValue, "INVALID_EVENT");
    if (claimIds.has(claim.claimId)) fail("INVALID_EVENT");
    claimIds.add(claim.claimId);
    claims.push(claim);
  }

  if (!Array.isArray(value.impact_refs)) fail("INVALID_EVENT");
  const impactRefs: Array<{ impactId: string; version: number }> = [];
  const impactKeys = new Set<string>();
  for (const referenceValue of value.impact_refs) {
    if (!isRecord(referenceValue)) fail("INVALID_EVENT");
    const impactId = readId(referenceValue.impact_id, "INVALID_EVENT");
    const impactVersion = readVersion(referenceValue.version, "INVALID_EVENT");
    const key = pairKey(impactId, impactVersion);
    if (impactKeys.has(key)) fail("INVALID_EVENT");
    impactKeys.add(key);
    impactRefs.push({ impactId, version: impactVersion });
  }

  if (!scopeHasPublicTarget(scope)) fail("INVALID_EVENT");

  return {
    datasetKind: "live",
    eventId,
    version,
    title,
    summary,
    category,
    tags,
    lifecycle,
    freshness,
    eventTime,
    validity,
    scope,
    claims,
    impactRefs,
    publishedAt,
  };
}

function readClaim(value: unknown, code: PublicProjectionErrorCode): ValidatedClaim {
  if (!isRecord(value)) fail(code);
  const claimId = readId(value.claim_id, code);
  const text = readString(value.text, 4000, code);
  const eventTime = readTimeScope(value.event_time, code);
  const validity = readValidity(value.validity, code);
  const scope = readScope(value.scope, code);
  if (!scopeHasPublicTarget(scope)) fail(code);
  const qualifiers = readStringArray(value.qualifiers, 500, code);
  if (!Array.isArray(value.support) || value.support.length === 0) fail(code);
  const support = value.support.map((reference) => readEvidenceReference(reference, "supports", code));
  rejectDuplicateReferences(support, code);
  if (!Array.isArray(value.contradictions)) fail(code);
  const contradictions = value.contradictions.map((reference) => readEvidenceReference(reference, "contradicts", code));
  rejectDuplicateReferences(contradictions, code);
  if (!Array.isArray(value.context_evidence)) fail(code);
  const contextEvidence = value.context_evidence.map((reference) => readEvidenceReference(reference, "context", code));
  rejectDuplicateReferences(contextEvidence, code);
  readIdArray(value.origin_ids, code, true);
  const evidenceLabel = readEnum(value.evidence_label, [...claimEvidenceLabels], code);

  // `contradictions` and `context_evidence` are shape-checked but never used as
  // source attributions. Only the supports relation reaches the public source list.
  void contradictions;
  void contextEvidence;
  return { claimId, text, eventTime, validity, scope, qualifiers, support, evidenceLabel };
}

function readEvidenceReference(
  value: unknown,
  expectedRelation: EvidenceReference["relation"],
  code: PublicProjectionErrorCode,
): EvidenceReference {
  if (!isRecord(value)) fail(code);
  const reportRevisionId = readId(value.report_revision_id, code);
  const permittedTextHash = typeof value.permitted_text_hash === "string" && hashPattern.test(value.permitted_text_hash)
    ? value.permitted_text_hash
    : fail(code);
  const spanStart = readSafeInteger(value.span_start, 0, 10_000_000, code);
  const spanEnd = readSafeInteger(value.span_end, 1, 10_000_000, code);
  if (spanEnd <= spanStart) fail(code);
  requireEqual(value.offset_unit, "unicode_code_points", code);
  const relation = readEnum(value.relation, ["supports", "contradicts", "updates", "context"] as const, code);
  if (relation !== expectedRelation && !(expectedRelation === "context" && relation === "updates")) fail(code);
  return { reportRevisionId, permittedTextHash, spanStart, spanEnd, offsetUnit: "unicode_code_points", relation };
}

function readTags(value: unknown, code: PublicProjectionErrorCode): EventView["tags"] {
  if (!Array.isArray(value)) fail(code);
  const result: EventView["tags"] = [];
  const keys = new Set<string>();
  for (const tagValue of value) {
    if (!isRecord(tagValue)) fail(code);
    const namespace = readEnum(tagValue.namespace, [...tagNamespaces], code);
    if (typeof tagValue.value !== "string" || !tagValuePattern.test(tagValue.value)) fail(code);
    if (Array.from(tagValue.value).length > 64) fail(code);
    const key = `${namespace}\u0000${tagValue.value}`;
    if (keys.has(key)) fail(code);
    keys.add(key);
    result.push({ namespace, value: tagValue.value });
  }
  result.sort((left, right) => compareStrings(left.namespace, right.namespace) || compareStrings(left.value, right.value));
  return result;
}

function readFreshness(value: unknown, code: PublicProjectionErrorCode): Freshness {
  if (!isRecord(value)) fail(code);
  const status = readEnum(value.status, [...freshnessStatuses], code);
  const evaluatedAt = readDateTime(value.evaluated_at, code);
  const reviewDueAt = value.review_due_at === null ? null : readDateTime(value.review_due_at, code);
  const basis = readEnum(value.basis, [...freshnessBases], code);
  return { status, evaluated_at: evaluatedAt, review_due_at: reviewDueAt, basis };
}

function readTimeScope(value: unknown, code: PublicProjectionErrorCode): TimeScope {
  if (!isRecord(value)) fail(code);
  const precision = readEnum(value.precision, ["exact", "date", "range", "unknown"] as const, code);
  const start = value.start;
  const end = value.end;
  if (precision === "unknown") {
    if (start !== null || end !== null) fail(code);
    return { start: null, end: null, precision };
  }
  if (precision === "exact") {
    const exactStart = readDateTime(start, code);
    const exactEnd = end === null ? null : readDateTime(end, code);
    if (exactEnd !== null && Date.parse(exactEnd) < Date.parse(exactStart)) fail(code);
    return { start: exactStart, end: exactEnd, precision };
  }
  if (precision === "date") {
    const dateStart = readDateOnly(start, code);
    const dateEnd = end === null ? null : readDateOnly(end, code);
    if (dateEnd !== null && dateEnd < dateStart) fail(code);
    return { start: dateStart, end: dateEnd, precision };
  }

  const startIsDate = isDateOnly(start);
  const endIsDate = isDateOnly(end);
  if (startIsDate && endIsDate) {
    if (end < start) fail(code);
    return { start, end, precision };
  }
  const rangeStart = readDateTime(start, code);
  const rangeEnd = readDateTime(end, code);
  if (Date.parse(rangeEnd) < Date.parse(rangeStart)) fail(code);
  return { start: rangeStart, end: rangeEnd, precision };
}

function readValidity(value: unknown, code: PublicProjectionErrorCode): Validity {
  if (!isRecord(value)) fail(code);
  const validFrom = value.valid_from === null ? null : readDateTime(value.valid_from, code);
  const validUntil = value.valid_until === null ? null : readDateTime(value.valid_until, code);
  if (validFrom !== null && validUntil !== null && Date.parse(validFrom) >= Date.parse(validUntil)) fail(code);
  return { valid_from: validFrom, valid_until: validUntil };
}

function readScope(value: unknown, code: PublicProjectionErrorCode): StoredScope {
  if (!isRecord(value)) fail(code);
  return {
    placeIds: readIdArray(value.place_ids, code, false),
    serviceIds: readIdArray(value.service_ids, code, false),
    institutionIds: readIdArray(value.institution_ids, code, false),
    audienceIds: readIdArray(value.audience_ids, code, false),
    geometryIds: readIdArray(value.geometry_ids, code, false),
  };
}

function scopeHasPublicTarget(scope: StoredScope): boolean {
  return scope.placeIds.length + scope.serviceIds.length + scope.institutionIds.length + scope.audienceIds.length > 0;
}

function readIdArray(value: unknown, code: PublicProjectionErrorCode, nonEmpty: boolean): string[] {
  if (!Array.isArray(value) || (nonEmpty && value.length === 0)) fail(code);
  const result: string[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    const id = readId(entry, code);
    if (seen.has(id)) fail(code);
    seen.add(id);
    result.push(id);
  }
  return result;
}

function readStringArray(value: unknown, maxLength: number, code: PublicProjectionErrorCode): string[] {
  if (!Array.isArray(value)) fail(code);
  const result: string[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    const item = readString(entry, maxLength, code);
    if (seen.has(item)) fail(code);
    seen.add(item);
    result.push(item);
  }
  return result;
}

function rejectDuplicateReferences(references: readonly EvidenceReference[], code: PublicProjectionErrorCode): void {
  const keys = new Set<string>();
  for (const reference of references) {
    const key = evidenceKey(reference);
    if (keys.has(key)) fail(code);
    keys.add(key);
  }
}

function projectScope(scope: StoredScope, names: readonly unknown[]): EventView["scope"] {
  const result: EventView["scope"] = { places: [], services: [], institutions: [], audiences: [] };
  const fields = [
    { kind: "place" as const, ids: scope.placeIds, output: result.places },
    { kind: "service" as const, ids: scope.serviceIds, output: result.services },
    { kind: "institution" as const, ids: scope.institutionIds, output: result.institutions },
    { kind: "audience" as const, ids: scope.audienceIds, output: result.audiences },
  ];

  for (const field of fields) {
    for (const id of field.ids) field.output.push(resolveScopeName(names, field.kind, id));
    field.output.sort(compareStrings);
  }
  return result;
}

function resolveScopeName(names: readonly unknown[], kind: ScopeKind, id: string): string {
  const matches: Array<{ readonly displayName: string }> = [];
  for (const value of names) {
    if (!isRecord(value)) continue;
    if (value.entity_type !== kind || value.id !== id) continue;
    if (!isValidDisplayName(value.display_name)) fail("NAME_LOOKUP_FAILED");
    matches.push({ displayName: value.display_name });
  }
  if (matches.length !== 1) fail("NAME_LOOKUP_FAILED");
  return matches[0]!.displayName;
}

function projectSources(
  datasetKind: "live",
  references: readonly EvidenceReference[],
  attributions: readonly unknown[],
): PublicClaim["sources"] {
  const sources: PublicClaim["sources"] = [];
  for (const reference of references) {
    const matches: unknown[] = [];
    for (const candidate of attributions) {
      if (isExactAttributionMatch(candidate, datasetKind, reference)) matches.push(candidate);
    }
    if (matches.length !== 1) fail("ATTRIBUTION_FAILED");
    sources.push(projectAttribution(matches[0]));
  }
  if (sources.length === 0) fail("ATTRIBUTION_FAILED");
  sources.sort((left, right) => compareStrings(left.display_name, right.display_name)
    || compareStrings(left.url, right.url)
    || compareNullable(left.published_at, right.published_at)
    || compareNullable(left.observed_at, right.observed_at)
    || compareNullable(left.excerpt, right.excerpt));
  return sources;
}

function isExactAttributionMatch(value: unknown, datasetKind: "live", reference: EvidenceReference): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  return value.dataset_kind === datasetKind
    && value.report_revision_id === reference.reportRevisionId
    && value.permitted_text_hash === reference.permittedTextHash
    && value.span_start === reference.spanStart
    && value.span_end === reference.spanEnd
    && value.offset_unit === reference.offsetUnit
    && value.relation === "supports";
}

function projectAttribution(value: unknown): PublicClaim["sources"][number] {
  if (!isRecord(value) || value.public_use_approved !== true) fail("ATTRIBUTION_FAILED");
  if (!isValidDisplayName(value.display_name)) fail("ATTRIBUTION_FAILED");
  const url = readHttpsUrl(value.url, "ATTRIBUTION_FAILED");
  const publishedAt = value.published_at === null ? null : readDateTime(value.published_at, "ATTRIBUTION_FAILED");
  const observedAt = value.observed_at === null ? null : readDateTime(value.observed_at, "ATTRIBUTION_FAILED");
  if (typeof value.excerpt_public_use_approved !== "boolean") fail("ATTRIBUTION_FAILED");
  let excerpt: string | null = null;
  if (value.excerpt_public_use_approved === true) {
    excerpt = value.excerpt === null ? null : readString(value.excerpt, 300, "ATTRIBUTION_FAILED");
  }
  return {
    display_name: value.display_name,
    url,
    published_at: publishedAt,
    observed_at: observedAt,
    excerpt,
  };
}

function projectImpacts(
  event: ValidatedEvent & { readonly datasetKind: "live" },
  values: readonly unknown[],
  scopeNames: readonly unknown[],
): PublicImpact[] {
  const validated: ValidatedImpact[] = [];
  const identities = new Set<string>();
  for (const value of values) {
    const impact = validateImpact(value);
    const identity = pairKey(impact.impactId, impact.version);
    if (identities.has(identity)) fail("IMPACT_RESOLUTION_FAILED");
    identities.add(identity);
    validated.push(impact);
  }

  if (validated.length !== event.impactRefs.length) fail("IMPACT_RESOLUTION_FAILED");
  const projected: PublicImpact[] = [];
  const claimIds = new Set(event.claims.map((claim) => claim.claimId));
  const matched = new Set<string>();
  for (const reference of event.impactRefs) {
    const referenceKey = pairKey(reference.impactId, reference.version);
    const matches = validated.filter((impact) => impact.impactId === reference.impactId
      && impact.version === reference.version
      && impact.datasetKind === event.datasetKind
      && impact.eventId === event.eventId
      && impact.eventVersion === event.version);
    if (matches.length !== 1) fail("IMPACT_RESOLUTION_FAILED");
    const impact = matches[0]!;
    matched.add(referenceKey);
    if (impact.supportingClaimIds.some((claimId) => !claimIds.has(claimId))) fail("IMPACT_RESOLUTION_FAILED");
    projected.push({
      impact_id: impact.impactId,
      version: impact.version,
      impact_type: impact.impactType,
      title: impact.title,
      description: impact.description,
      lifecycle: impact.lifecycle,
      freshness: impact.freshness,
      event_time: impact.eventTime,
      validity: impact.validity,
      scope: projectScope(impact.scope, scopeNames),
    });
  }

  if (matched.size !== validated.length) fail("IMPACT_RESOLUTION_FAILED");
  return projected;
}

function validateImpact(value: unknown): ValidatedImpact {
  const code: PublicProjectionErrorCode = "INVALID_IMPACT";
  if (!isRecord(value)) fail(code);
  requireEqual(value.schema_version, "2.0", code);
  requireEqual(value.record_type, "Impact", code);
  readId(value.trace_id, code);
  const datasetKind = readEnum(value.dataset_kind, ["live", "historical", "synthetic"] as const, code);
  const impactId = readId(value.impact_id, code);
  const version = readVersion(value.version, code);
  const eventId = readId(value.event_id, code);
  const eventVersion = readVersion(value.event_version, code);
  const impactType = readEnum(value.impact_type, [...impactTypes], code);
  const title = readString(value.title, 240, code);
  const description = readString(value.description, 2000, code);
  const lifecycle = readEnum(value.lifecycle, [...lifecycles], code);
  const freshness = readFreshness(value.freshness, code);
  const eventTime = readTimeScope(value.event_time, code);
  const validity = readValidity(value.validity, code);
  const scope = readScope(value.scope, code);
  if (!scopeHasPublicTarget(scope)) fail(code);
  readDateTime(value.published_at, code);
  const supportingClaimIds = readIdArray(value.supporting_claim_ids, code, true);
  return {
    datasetKind,
    impactId,
    version,
    eventId,
    eventVersion,
    impactType,
    title,
    description,
    lifecycle,
    freshness,
    eventTime,
    validity,
    scope,
    supportingClaimIds,
  };
}

function readId(value: unknown, code: PublicProjectionErrorCode): string {
  if (typeof value !== "string" || value.length > 128 || !idPattern.test(value)) fail(code);
  return value;
}

function readVersion(value: unknown, code: PublicProjectionErrorCode): number {
  return readSafeInteger(value, 1, 2_147_483_647, code);
}

function readSafeInteger(value: unknown, min: number, max: number, code: PublicProjectionErrorCode): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) fail(code);
  return value;
}

function readString(value: unknown, maxLength: number, code: PublicProjectionErrorCode): string {
  if (typeof value !== "string" || value.length === 0 || Array.from(value).length > maxLength) fail(code);
  return value;
}

function isValidDisplayName(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && Array.from(value).length <= 200
    && value.trim() === value
    && value.trim().length > 0;
}

function readDateTime(value: unknown, code: PublicProjectionErrorCode): string {
  if (!isDateTime(value)) fail(code);
  return value;
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

function readDateOnly(value: unknown, code: PublicProjectionErrorCode): string {
  if (!isDateOnly(value)) fail(code);
  return value;
}

function isDateOnly(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
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

function readHttpsUrl(value: unknown, code: PublicProjectionErrorCode): string {
  if (typeof value !== "string" || value.length > 2048 || value.trim() !== value) fail(code);
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return fail(code);
  }
  if (parsed.protocol !== "https:" || parsed.hostname.length === 0 || parsed.username.length > 0 || parsed.password.length > 0) {
    fail(code);
  }
  return value;
}

function readEnum<const T extends readonly string[]>(value: unknown, allowed: T, code: PublicProjectionErrorCode): T[number] {
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) fail(code);
  return value as T[number];
}

function requireEqual(value: unknown, expected: unknown, code: PublicProjectionErrorCode): void {
  if (value !== expected) fail(code);
}

function evidenceKey(reference: EvidenceReference): string {
  return [reference.reportRevisionId, reference.permittedTextHash, reference.spanStart,
    reference.spanEnd, reference.offsetUnit, reference.relation].join("\u0000");
}

function pairKey(id: string, version: number): string {
  return `${id}\u0000${version}`;
}

function sortedStrings(values: readonly string[]): string[] {
  return [...values].sort(compareStrings);
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareNullable(left: string | null, right: string | null): number {
  if (left === null) return right === null ? 0 : -1;
  if (right === null) return 1;
  return compareStrings(left, right);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function fail(code: PublicProjectionErrorCode): never {
  throw new PublicProjectionError(code);
}
