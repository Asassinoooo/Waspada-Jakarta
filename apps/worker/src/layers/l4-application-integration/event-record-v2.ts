/**
 * HOSTED-02: the one builder for the stored domain schema 2.0 Event record (docs/contracts.schema.json, $defs/Event).
 * Publication and withdrawal both write their event_versions.record_json through buildEventRecordV2, so the 23 keys
 * the public SQL readers check (migrations 013 and 016) are always exact.
 *
 * This is the domain namespace. It is not the public /api/v1 DTO (contracts/public-api.ts), which is projected from it.
 * Publication mode and waivers are not part of the record. They stay on the publication decision.
 *
 * Nothing here invents a fact. A timestamp the source does not give stays null or unknown, and a place, origin or
 * evidence reference that the proposal does not carry is left empty. A free-text location label is not a place id.
 */
import type { EventProposalDto } from "./moderation-api.js";
import { publicClaimIdFor } from "./public-read-model.js";

export const EVENT_RECORD_V2_KEYS = [
  "schema_version", "trace_id", "record_type", "dataset_kind", "event_id", "version",
  "supersedes_version", "title", "summary", "category", "tags", "lifecycle", "freshness",
  "event_time", "validity", "scope", "claims", "impact_refs", "publication_status",
  "withdrawal_reason", "publication_decision_id", "published_at", "withdrawn_at",
] as const;

/** Domain Tag.value pattern (contracts.schema.json). Non-matching values are dropped, never coerced. */
const TAG_VALUE_PATTERN = /^[a-z][a-z0-9_]*$/u;
const DATE_TIME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/u;
const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;
const SUMMARY_MAX_CODE_POINTS = 500;

export type EventRecordDatasetKind = "live" | "historical" | "synthetic";

export interface DomainTimeScope {
  readonly start: string | null;
  readonly end: string | null;
  readonly precision: "exact" | "date" | "range" | "unknown";
}

export interface DomainValidity {
  readonly valid_from: string | null;
  readonly valid_until: string | null;
}

export interface DomainScope {
  readonly place_ids: readonly string[];
  readonly service_ids: readonly string[];
  readonly institution_ids: readonly string[];
  readonly audience_ids: readonly string[];
  readonly geometry_ids: readonly string[];
}

export interface DomainFreshness {
  readonly status: "current" | "needs_update" | "expired";
  readonly evaluated_at: string;
  readonly review_due_at: string | null;
  readonly basis: "source_validity" | "fast_observation_review" | "undated_advisory_review" | "manual_review" | "unknown";
}

export interface DomainTag {
  readonly namespace: "topic" | "service" | "audience" | "hazard" | "transport_mode" | "place_type";
  readonly value: string;
}

/** Domain EvidenceRef (contracts.schema.json). Only persisted evidence the proposal's own report revision used. */
export interface DomainEvidenceRef {
  readonly report_revision_id: string;
  readonly permitted_text_hash: string;
  readonly span_start: number;
  readonly span_end: number;
  readonly offset_unit: "unicode_code_points";
  readonly relation: "supports";
}

/** Domain PublishedClaim. support and origin_ids are filled only from persisted evidence, never from the model. */
export interface DomainPublishedClaim {
  readonly claim_id: string;
  readonly text: string;
  readonly event_time: DomainTimeScope;
  readonly validity: DomainValidity;
  readonly scope: DomainScope;
  readonly qualifiers: readonly string[];
  readonly support: readonly DomainEvidenceRef[];
  readonly contradictions: readonly unknown[];
  readonly context_evidence: readonly unknown[];
  readonly origin_ids: readonly string[];
  readonly evidence_label: "issuer_notice" | "attributed_report" | "independent_corroboration" | "crowdsourced_observation";
}

export type EventRecordWithdrawalReason =
  | "source_retracted"
  | "evidence_ineligible"
  | "incorrect_event_match"
  | "privacy_removal"
  | "duplicate"
  | "other";

export interface EventRecordV2 {
  readonly schema_version: "2.0";
  readonly trace_id: string;
  readonly record_type: "Event";
  readonly dataset_kind: EventRecordDatasetKind;
  readonly event_id: string;
  readonly version: number;
  readonly supersedes_version: number | null;
  readonly title: string;
  readonly summary: string;
  readonly category: string;
  readonly tags: readonly DomainTag[];
  readonly lifecycle: string;
  readonly freshness: DomainFreshness;
  readonly event_time: DomainTimeScope;
  readonly validity: DomainValidity;
  readonly scope: DomainScope;
  readonly claims: readonly DomainPublishedClaim[];
  readonly impact_refs: readonly { readonly impact_id: string; readonly version: number }[];
  readonly publication_status: "published" | "withdrawn";
  readonly withdrawal_reason: EventRecordWithdrawalReason | null;
  readonly publication_decision_id: string;
  readonly published_at: string | null;
  readonly withdrawn_at: string | null;
}

/** Used when the source gives no event time, and for every withdrawn tombstone. */
export const UNKNOWN_TIME_SCOPE: DomainTimeScope = { start: null, end: null, precision: "unknown" };
export const NULL_VALIDITY: DomainValidity = { valid_from: null, valid_until: null };
export const EMPTY_SCOPE: DomainScope = {
  place_ids: [], service_ids: [], institution_ids: [], audience_ids: [], geometry_ids: [],
};

export interface EventRecordV2Input {
  readonly datasetKind: EventRecordDatasetKind;
  readonly traceId: string;
  readonly eventId: string;
  readonly version: number;
  readonly supersedesVersion: number | null;
  readonly decisionId: string;
  readonly status: "published" | "withdrawn";
  /** published_at for a publication, withdrawn_at for a withdrawal. Never a value the caller invented. */
  readonly statusAt: string;
  /** Required for a withdrawal, null for a publication. */
  readonly withdrawalReason: EventRecordWithdrawalReason | null;
  readonly title: string;
  readonly summary: string;
  readonly category: string;
  readonly lifecycle: string;
  readonly tags: readonly DomainTag[];
  readonly freshness: DomainFreshness;
  readonly eventTime: DomainTimeScope;
  readonly validity: DomainValidity;
  readonly scope: DomainScope;
  readonly claims: readonly DomainPublishedClaim[];
}

/** The one builder. A withdrawn version is a tombstone: no claims, no impacts, a reason and withdrawn_at. */
export function buildEventRecordV2(input: EventRecordV2Input): EventRecordV2 {
  const published = input.status === "published";
  return {
    schema_version: "2.0",
    trace_id: input.traceId,
    record_type: "Event",
    dataset_kind: input.datasetKind,
    event_id: input.eventId,
    version: input.version,
    supersedes_version: input.supersedesVersion,
    title: input.title,
    summary: input.summary,
    category: input.category,
    tags: published ? input.tags : [],
    lifecycle: input.lifecycle,
    freshness: input.freshness,
    event_time: published ? input.eventTime : UNKNOWN_TIME_SCOPE,
    validity: published ? input.validity : NULL_VALIDITY,
    scope: published ? input.scope : EMPTY_SCOPE,
    claims: published ? input.claims : [],
    impact_refs: [],
    publication_status: input.status,
    withdrawal_reason: input.withdrawalReason,
    publication_decision_id: input.decisionId,
    published_at: published ? input.statusAt : null,
    withdrawn_at: published ? null : input.statusAt,
  };
}

/** The record of a withdrawn version. Its own fields are kept only as far as the stored event row gives them. */
export function buildWithdrawnEventRecordV2(input: {
  readonly datasetKind: EventRecordDatasetKind;
  readonly traceId: string;
  readonly eventId: string;
  readonly version: number;
  readonly supersedesVersion: number;
  readonly decisionId: string;
  readonly withdrawnAt: string;
  readonly reasonCategory: EventRecordWithdrawalReason;
  readonly title: string;
  readonly summary: string;
  readonly category: string;
  readonly lifecycle: string;
}): EventRecordV2 {
  return buildEventRecordV2({
    datasetKind: input.datasetKind,
    traceId: input.traceId,
    eventId: input.eventId,
    version: input.version,
    supersedesVersion: input.supersedesVersion,
    decisionId: input.decisionId,
    status: "withdrawn",
    statusAt: input.withdrawnAt,
    withdrawalReason: input.reasonCategory,
    title: input.title,
    summary: input.summary,
    category: input.category,
    lifecycle: input.lifecycle,
    tags: [],
    freshness: { status: "needs_update", evaluated_at: input.withdrawnAt, review_due_at: null, basis: "unknown" },
    eventTime: UNKNOWN_TIME_SCOPE,
    validity: NULL_VALIDITY,
    scope: EMPTY_SCOPE,
    claims: [],
  });
}

/**
 * The event time a proposal supports. An exact value must be an RFC 3339 date-time, and a date must be a calendar
 * date. Anything else (a range, a missing or unparseable value) is unknown. A timestamp is never invented.
 */
export function domainEventTime(eventTime: EventProposalDto["event_time"] | undefined): DomainTimeScope {
  const raw = typeof eventTime?.value === "string" ? eventTime.value.trim() : "";
  if (eventTime?.precision === "exact" && DATE_TIME_PATTERN.test(raw)) {
    const parsed = Date.parse(raw);
    if (!Number.isNaN(parsed)) return { start: new Date(parsed).toISOString(), end: null, precision: "exact" };
  }
  if (eventTime?.precision === "date" && DATE_ONLY_PATTERN.test(raw)) {
    return { start: raw, end: null, precision: "date" };
  }
  return UNKNOWN_TIME_SCOPE;
}

/** Tags a proposal carries that the domain allows. A value that breaks the pattern is dropped, and duplicates collapse. */
export function domainTags(proposal: EventProposalDto): DomainTag[] {
  const candidates: DomainTag[] = [
    { namespace: "topic", value: proposal.incident_type },
    { namespace: "hazard", value: proposal.severity },
  ];
  const seen = new Set<string>();
  const tags: DomainTag[] = [];
  for (const tag of candidates) {
    if (typeof tag.value !== "string" || tag.value.length > 64 || !TAG_VALUE_PATTERN.test(tag.value)) continue;
    const key = `${tag.namespace}:${tag.value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    tags.push(tag);
  }
  return tags;
}

/** Freshness follows the event time. Without a dated event time the record says needs_update, basis unknown. */
export function domainFreshness(eventTime: DomainTimeScope, evaluatedAt: string): DomainFreshness {
  if (eventTime.start === null) {
    return { status: "needs_update", evaluated_at: evaluatedAt, review_due_at: null, basis: "unknown" };
  }
  return { status: "current", evaluated_at: evaluatedAt, review_due_at: null, basis: "fast_observation_review" };
}

/**
 * The deterministic review summary for a published version (ADR-020 amendment). It is a template in Bahasa
 * Indonesia, never model text. A correction uses the moderator's own note, truncated to the stored limit.
 */
export function reviewSummaryFor(
  action: "auto_publish" | "publish" | "correct",
  input: { readonly sourceCount: number; readonly reason: string | null },
): string {
  if (action === "auto_publish") return `Diterbitkan otomatis dari ${input.sourceCount} sumber`;
  if (action === "publish") return "Diterbitkan oleh moderator";
  const note = (input.reason ?? "").trim();
  return note.length > 0
    ? Array.from(note).slice(0, SUMMARY_MAX_CODE_POINTS).join("")
    : "Dikoreksi oleh moderator";
}

/**
 * The domain claims of a published version, built from the same claims the public DTO uses. The claim id comes from
 * publicClaimIdFor, so the stored claim, its event_claims row and the DTO agree. `links.support` is the persisted
 * evidence the proposal's own report revision used. `links.originIdsByClaim` is the origin rows of each claim, by claim
 * index (HOSTED-15, ADR-020 amendment); a claim with no registered source has none. `links.geometryIds` is the point
 * geometry of the event, shared by its claims.
 */
export function domainClaimsFor(
  proposal: EventProposalDto,
  eventId: string,
  eventTime: DomainTimeScope,
  claims: readonly { readonly text: string; readonly evidence_label: DomainPublishedClaim["evidence_label"] }[],
  links: {
    readonly support?: readonly DomainEvidenceRef[];
    /** HOSTED-31: the support of each claim, by claim index. It replaces `support` for the claims it covers. */
    readonly supportByClaim?: readonly (readonly DomainEvidenceRef[])[];
    readonly geometryIds?: readonly string[];
    readonly originIdsByClaim?: readonly (readonly string[])[];
  } = {},
): DomainPublishedClaim[] {
  const geometryIds = links.geometryIds ?? [];
  return (proposal.claims ?? []).map((claim, index) => ({
    claim_id: publicClaimIdFor(claim, eventId, index),
    text: claims[index]?.text ?? claim.claim_text,
    event_time: eventTime,
    validity: NULL_VALIDITY,
    scope: { ...EMPTY_SCOPE, geometry_ids: [...geometryIds] },
    qualifiers: [],
    support: [...(links.supportByClaim?.[index] ?? links.support ?? [])],
    contradictions: [],
    context_evidence: [],
    origin_ids: [...(links.originIdsByClaim?.[index] ?? [])],
    evidence_label: claims[index]?.evidence_label ?? "attributed_report",
  }));
}
