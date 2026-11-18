/**
 * MERGE-REVIEW-01 (ADR-061): the one writer for proposal decisions. The agent auto-publisher and
 * moderators both call decideProposal, so they share one gate, one audit row and one public
 * projection. A decision is recorded as a publication_decisions row. event_proposals is append-only,
 * so the decision is never written onto the proposal.
 *
 * TG-FR12: a moderator may also withdraw a published event (withdrawPublishedEvent) or correct it
 * (submitEventCorrection). Both write one new event version, one publication decision and one audit
 * record in one transaction. A correction is a stored proposal and passes the same gate as any other.
 */
import { createHash, randomUUID } from "node:crypto";
import type { SqlExecutor, TransactionalSqlExecutor } from "../../../../db/src/sql.js";
import type { EventProposalWriter } from "../../../../db/src/event-proposal-writer.js";
import { persistGeometryInCallerTransaction } from "../../../../db/src/geometry-writer.js";
import type { EventProposalDto } from "./moderation-api.js";
import {
  PublicReadModel,
  proposalToEventDetail,
  publicClaimIdFor,
  publicEventIdForProposal,
} from "./public-read-model.js";
import {
  buildEventRecordV2,
  buildWithdrawnEventRecordV2,
  domainClaimsFor,
  domainEventTime,
  domainFreshness,
  domainTags,
  type DomainEvidenceRef,
  EMPTY_SCOPE,
  NULL_VALIDITY,
  reviewSummaryFor,
} from "./event-record-v2.js";
import { publicLocationLabel, publicPointLabel, publicPointOutcomeFor, type PublicPointSource } from "./public-point.js";
import { countPublicationOutlets } from "./publication-source-count.js";
import {
  assessCorrectionGate,
  assessProposalSourceGate,
  evaluateAutoPublication,
  isValidProposalReviewTtlHours,
  type AutoPublicationWaiver,
  type AutoPublishSourcePermission,
  type LinkedInvestigationStatus,
  type ProposalGateReason,
} from "./publication-policy.js";

export const AGENT_AUTO_PUBLISHER_ID = "agent:auto-publisher";
export const PUBLICATION_POLICY_VERSION = "merge-review-v1";
/** REVIEW-EXPIRY-01 (ADR-062): the sweep's actor. It records a decision and never publishes. */
export const AGENT_REVIEW_EXPIRY_ID = "agent:review-expiry";
export const REVIEW_TTL_ELAPSED_REASON = "review_ttl_elapsed";
/** TG-FR12: the withdrawal reasons the Event contract allows (`withdrawal_reason`). */
export const WITHDRAWAL_REASON_CATEGORIES = [
  "source_retracted",
  "evidence_ineligible",
  "incorrect_event_match",
  "privacy_removal",
  "duplicate",
  "other",
] as const;
export type WithdrawalReasonCategory = (typeof WITHDRAWAL_REASON_CATEGORIES)[number];
/** TG-FR12: audit actions for the two moderator actions on a published event. */
export const AUDIT_ACTION_WITHDRAWN = "event_withdrawn";
export const AUDIT_ACTION_CORRECTION = "event_correction";

type TransactionRunner = SqlExecutor & { transaction?: <Result>(work: (tx: SqlExecutor) => Promise<Result>) => Promise<Result> };

async function runInTransaction<Result>(
  executor: SqlExecutor,
  work: (tx: SqlExecutor) => Promise<Result>,
): Promise<Result> {
  const runner = executor as TransactionRunner;
  if (typeof runner.transaction === "function") return runner.transaction(work);
  await executor.execute("BEGIN");
  try {
    const result = await work(executor);
    await executor.execute("COMMIT");
    return result;
  } catch (err) {
    try {
      await executor.execute("ROLLBACK");
    } catch {
      // The original failure is the one to report.
    }
    throw err;
  }
}

export type PublicationActor =
  | { readonly kind: "agent"; readonly actorId: typeof AGENT_AUTO_PUBLISHER_ID }
  | { readonly kind: "moderator"; readonly actorId: string };

export type ProposalDecisionAction = "auto_publish" | "publish" | "reject";

export interface ProposalDecisionDependencies {
  readonly executor: SqlExecutor;
  readonly datasetKind: "live" | "historical" | "synthetic";
  /** Live registry check. Fail-closed: an error or a missing source counts as not permitted. */
  readonly checkPublicDisplay: (sourceId: string) => Promise<boolean>;
}

/** Refusals a moderator correction can end with. Each is recorded as a rejected decision and an audit record. */
export type CorrectionRefusalCode =
  | "publication_not_authorized"
  | "investigation_stopped_for_review"
  | "publication_failed"
  | "stale_base_version"
  | "event_withdrawn"
  | "event_not_found";

export type ProposalDecisionOutcome =
  | {
    readonly status: "published";
    readonly decisionId: string;
    readonly eventId: string;
    readonly version: number;
    readonly publicationMode: "agent_auto" | "moderator_reviewed";
  }
  | { readonly status: "rejected"; readonly decisionId: string }
  /**
   * F-ALERT-01: the proposal's public facts already appear in the current published version. The decision is
   * recorded as no_material_change. No version, claim, outbox row or update is written.
   */
  | { readonly status: "unchanged"; readonly decisionId: string; readonly eventId: string; readonly version: number }
  | { readonly status: "queued"; readonly reasons: readonly ProposalGateReason[] }
  | {
    readonly status: "denied";
    readonly code:
      | "proposal_not_found"
      | "publication_not_authorized"
      | "publication_failed"
      /** F-04: a moderator must resolve a stopped_for_review investigation before the proposal can publish. */
      | "investigation_stopped_for_review"
      /** TG-FR12: a withdrawn event is never published again by an agent or a moderator. */
      | "event_withdrawn"
      | CorrectionRefusalCode;
    readonly reasons?: readonly ProposalGateReason[];
  }
  | { readonly status: "already_decided"; readonly disposition: string };

/** TG-FR12: the result of withdrawing a published event. */
export type WithdrawalOutcome =
  | {
    readonly status: "withdrawn";
    readonly eventId: string;
    readonly version: number;
    readonly decisionId: string;
    readonly withdrawnAt: string;
    readonly reasonCategory: WithdrawalReasonCategory;
  }
  | { readonly status: "already_withdrawn"; readonly eventId: string; readonly version: number }
  | { readonly status: "denied"; readonly code: "event_not_found" | "withdrawal_failed" };

/** TG-FR12: the fields a moderator may correct. The summary is derived from claim text, so claims are edited instead. */
export interface EventCorrectionEdits {
  readonly title?: string;
  readonly category?: string;
  readonly eventTime?: { readonly precision: "exact" | "date" | "range" | "unknown"; readonly value: string | null };
  readonly locationLabel?: string;
  /** Edits the text of existing claims. The quote, source and evidence of each claim are unchanged. */
  readonly claims?: readonly { readonly claimId: string; readonly text: string }[];
}

/** TG-FR12: the result of a correction. A refused correction publishes nothing. */
export type CorrectionOutcome =
  | {
    readonly status: "published" | "unchanged";
    readonly eventId: string;
    readonly version: number;
    readonly proposalId: string;
    readonly decisionId: string;
  }
  | { readonly status: "refused"; readonly code: CorrectionRefusalCode; readonly reasons: readonly ProposalGateReason[]; readonly proposalId?: string }
  | { readonly status: "invalid"; readonly code: "claim_not_found" };

type EventDetail = ReturnType<typeof proposalToEventDetail>;

/** What one publish attempt returns from its transaction. `detail` is set only when the transaction committed a publication. */
interface PublishAttempt {
  readonly outcome: ProposalDecisionOutcome;
  readonly detail?: EventDetail;
}

function parseProposal(raw: unknown): EventProposalDto {
  return (typeof raw === "string" ? JSON.parse(raw) : raw) as EventProposalDto;
}

/** The disposition of the latest decision for a proposal, or null when it is undecided. */
async function latestDisposition(
  executor: SqlExecutor,
  datasetKind: string,
  proposalId: string,
): Promise<{ readonly disposition: string } | null> {
  const prior = await executor.query<{ disposition: string | null }>(
    `SELECT record_json->>'disposition' AS disposition
     FROM waspada.publication_decisions
     WHERE dataset_kind = $1 AND proposal_id = $2
     ORDER BY decided_at DESC, decision_id DESC
     LIMIT 1`,
    [datasetKind, proposalId],
  );
  if (prior.rows.length === 0) return null;
  return { disposition: prior.rows[0]!.disposition ?? "unknown" };
}

/**
 * F-CONC-01: takes the decision lock for one proposal, for the rest of the enclosing transaction.
 * The key is the one persistProposalWithTx takes, so a write and a decision on the same proposal also
 * serialize. A row lock (SELECT ... FOR UPDATE) would need UPDATE on event_proposals, which the L4
 * publication writer role does not hold, and that table is append-only. So the lock is on the key.
 */
async function lockProposalDecisions(tx: SqlExecutor, datasetKind: string, proposalId: string): Promise<void> {
  const hash = createHash("sha256").update(datasetKind).update(":").update(proposalId).digest();
  await tx.query("SELECT pg_advisory_xact_lock($1::integer, $2::integer)", [
    hash.readInt32BE(0),
    hash.readInt32BE(4),
  ]);
}

/**
 * F-ALERT-01: serializes publication of one public event. The next version number and the "same facts as the
 * current version" check both read the event's latest publication, so decisions on different proposals of one
 * event must not interleave. It is taken after the proposal lock, so every decision takes the locks in one order.
 * TG-FR12: withdrawal takes this lock too, so a withdrawal and a publication of one event cannot interleave.
 */
async function lockEventPublication(tx: SqlExecutor, datasetKind: string, eventId: string): Promise<void> {
  const hash = createHash("sha256").update("event").update(":").update(datasetKind).update(":").update(eventId).digest();
  await tx.query("SELECT pg_advisory_xact_lock($1::integer, $2::integer)", [
    hash.readInt32BE(0),
    hash.readInt32BE(4),
  ]);
}

/**
 * F-04: the status of the investigation a proposal links to, from its latest checkpoint. Null when the
 * proposal has no link. A link always has a checkpoint, so a missing or unknown status throws, which
 * fails the decision closed.
 */
async function latestInvestigationStatus(
  tx: SqlExecutor,
  datasetKind: string,
  investigationId: string | null,
): Promise<LinkedInvestigationStatus | null> {
  if (investigationId === null) return null;
  const result = await tx.query<{ case_status: string }>(
    `SELECT case_status FROM waspada.investigation_checkpoints
     WHERE dataset_kind = $1 AND investigation_id = $2
     ORDER BY checkpoint_version DESC LIMIT 1`,
    [datasetKind, investigationId],
  );
  const status = result.rows[0]?.case_status;
  if (status === "open" || status === "paused" || status === "completed" || status === "stopped_for_review") {
    return status;
  }
  throw new Error("linked investigation has no readable status");
}

/**
 * Writes a decision that publishes nothing: a reject or an expiry. publication_decisions is
 * append-only, so this is the only write. event_id and event_version stay NULL.
 * F-CONC-01: decideProposal calls this inside the proposal's decision lock, after the already-decided
 * check. publication_decisions has no unique index on (dataset_kind, proposal_id), so the lock is what
 * stops two decisions from both inserting. The expiry sweep does not take the lock (see expireStaleProposals).
 */
async function insertUnpublishedDecision(
  executor: SqlExecutor,
  input: {
    readonly datasetKind: string;
    readonly decisionId: string;
    readonly traceId: string;
    readonly proposalId: string;
    readonly reviewerId: string;
    readonly decidedAt: string;
    readonly record: Record<string, unknown>;
  },
): Promise<void> {
  await executor.query(
    `INSERT INTO waspada.publication_decisions (
       dataset_kind, decision_id, trace_id, proposal_id, policy_version,
       event_id, event_version, reviewer_id, decided_at, record_json)
     VALUES ($1, $2, $3, $4, $5, NULL, NULL, $6, $7::timestamptz, $8::jsonb)`,
    [
      input.datasetKind,
      input.decisionId,
      input.traceId,
      input.proposalId,
      PUBLICATION_POLICY_VERSION,
      input.reviewerId,
      input.decidedAt,
      JSON.stringify(input.record),
    ],
  );
}

/** TG-FR12: one audit record for a moderator action on an event. audit_records is append-only. */
async function writeAuditRecord(
  tx: SqlExecutor,
  input: {
    readonly datasetKind: string;
    readonly traceId: string;
    readonly occurredAt: string;
    readonly actorId: string;
    readonly action: string;
    readonly eventId: string;
    readonly reason: string | null;
    readonly details: Record<string, unknown>;
  },
): Promise<void> {
  await tx.query(
    `INSERT INTO waspada.audit_records (
       dataset_kind, audit_id, trace_id, occurred_at, actor_id, action,
       entity_type, entity_id, reason, details)
     VALUES ($1, $2, $3, $4::timestamptz, $5, $6, 'event', $7, $8, $9::jsonb)`,
    [
      input.datasetKind,
      `aud-${randomUUID()}`,
      input.traceId,
      input.occurredAt,
      input.actorId,
      input.action,
      input.eventId,
      input.reason,
      JSON.stringify(input.details),
    ],
  );
}

/**
 * HOSTED-28 (owner decision, 18 Nov 2026; F-09): the publication source_count is the number of distinct outlets across the
 * claims. A syndicated copy is not counted. The rule is countPublicationOutlets (publication-source-count.ts), which
 * mirrors the count the public card shows.
 */
export function distinctOutlets(proposal: EventProposalDto): number {
  return countPublicationOutlets(proposal.claims ?? []).outlets;
}

/** Stable JSON with sorted keys, so two equal values always serialize to the same text. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const members = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
    return `{${members.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** Text compared for the same fact: Unicode-normalized, whitespace collapsed, case folded. */
function foldText(value: string): string {
  return value.normalize("NFC").replace(/\s+/gu, " ").trim().toLowerCase();
}

/**
 * F-ALERT-01: the public facts of one projected version, in canonical form. Equal keys mean a reader sees the
 * same facts. The key leaves out what changes without a new fact: the version number, publication and evaluation
 * times, the publication mode and source count, claim identifiers, and claim provenance (outlet, link, excerpt),
 * because a second outlet reporting the same facts is corroboration, not an update. Times, places, category,
 * lifecycle, severity, geometry and claim wording are compared, so a changed fact is always material.
 */
function publicContentKey(detail: EventDetail): string {
  return canonicalJson({
    title: foldText(detail.title),
    summary: foldText(detail.summary),
    category: detail.category,
    incident_type: detail.incident_type,
    tags: detail.tags,
    lifecycle: detail.lifecycle,
    event_time: detail.event_time,
    validity: detail.validity,
    scope: detail.scope,
    severity: detail.severity ?? null,
    impacts: detail.impacts,
    geometries: detail.geometries.map((geometry) => ({
      role: geometry.role,
      geometry: geometry.geometry,
      precision_m: geometry.precision_m,
      label: geometry.label,
    })),
    claims: detail.claims
      .map((claim) => canonicalJson({
        text: foldText(claim.text),
        evidence_label: claim.evidence_label,
        event_time: claim.event_time,
        validity: claim.validity,
        scope: claim.scope,
        qualifiers: claim.qualifiers,
      }))
      .sort(),
  });
}

/**
 * The newest decision that wrote a version of an event: a publication or a withdrawal. Its version number is the
 * event's current version. Null when the event has never been published. The proposal is the one behind that
 * decision, which is the publication's proposal for a publish and the withdrawn publication's proposal for a withdraw.
 */
interface LatestEventDecision {
  readonly version: number;
  readonly disposition: "publish" | "withdraw";
  readonly decisionId: string;
  readonly proposalId: string;
  readonly traceId: string;
  readonly proposal: EventProposalDto;
  /** HOSTED-26: the decision's own record (gate, publication mode, waivers and location fields). */
  readonly decisionRecord: Record<string, unknown>;
}

async function latestEventDecision(
  executor: SqlExecutor,
  datasetKind: string,
  eventId: string,
): Promise<LatestEventDecision | null> {
  const latest = await executor.query<{
    decision_id: string;
    event_version: number;
    proposal_id: string;
    trace_id: string;
    disposition: string;
    decision_record: unknown;
    record_json: unknown;
  }>(
    `SELECT decision.decision_id, decision.event_version, decision.proposal_id, decision.trace_id,
            decision.record_json->>'disposition' AS disposition, decision.record_json AS decision_record,
            proposal.record_json
     FROM waspada.publication_decisions AS decision
     JOIN waspada.event_proposals AS proposal
       ON proposal.dataset_kind = decision.dataset_kind AND proposal.proposal_id = decision.proposal_id
     WHERE decision.dataset_kind = $1 AND decision.event_id = $2
       AND decision.record_json->>'disposition' IN ('publish', 'withdraw')
     ORDER BY decision.event_version DESC
     LIMIT 1`,
    [datasetKind, eventId],
  );
  const row = latest.rows[0];
  if (!row) return null;
  return {
    version: row.event_version,
    disposition: row.disposition === "withdraw" ? "withdraw" : "publish",
    decisionId: row.decision_id,
    proposalId: row.proposal_id,
    traceId: row.trace_id,
    proposal: parseProposal(row.record_json),
    decisionRecord: parseJsonObject(row.decision_record) ?? {},
  };
}

async function resolvePublicDisplay(
  dependencies: ProposalDecisionDependencies,
  proposal: EventProposalDto,
): Promise<Set<string>> {
  const allowed = new Set<string>();
  const sourceIds = new Set<string>();
  for (const claim of proposal.claims ?? []) {
    if (typeof claim.source_id === "string" && claim.source_id.length > 0) sourceIds.add(claim.source_id);
  }
  for (const sourceId of sourceIds) {
    try {
      if (await dependencies.checkPublicDisplay(sourceId)) allowed.add(sourceId);
    } catch {
      // Fail closed: a rights check error is treated as not permitted.
    }
  }
  return allowed;
}

/**
 * HOSTED-28 (owner decision, 18 Nov 2026): the claim sources of a proposal that are registered but not approved (revoked,
 * suspended or pending). These are refused with `source_revoked` before any local_relaxed waiver. Read outside the lock,
 * like resolvePublicDisplay. A source with no registry row is not listed, so the existing waiver still applies to it. A
 * failed read lists every claim source, so the gate refuses rather than publishes (fail closed).
 */
async function resolveRevokedSourceIds(executor: SqlExecutor, proposal: EventProposalDto): Promise<Set<string>> {
  const sourceIds = [...new Set(
    (proposal.claims ?? [])
      .map((claim) => claim.source_id)
      .filter((sourceId): sourceId is string => typeof sourceId === "string" && sourceId.length > 0),
  )];
  if (sourceIds.length === 0) return new Set();
  try {
    const rows = await executor.query<{ source_id: string; approval_status: string }>(
      "SELECT source_id, approval_status FROM waspada.source_registry WHERE source_id = ANY($1::text[])",
      [sourceIds],
    );
    const statusById = new Map(rows.rows.map((row) => [row.source_id, row.approval_status] as const));
    return new Set(sourceIds.filter((sourceId) => statusById.has(sourceId) && statusById.get(sourceId) !== "approved"));
  } catch {
    return new Set(sourceIds);
  }
}

/**
 * HOSTED-10 and HOSTED-26: what a publication adds to the stored record, from persisted rows only. A coordinate-bearing
 * event with support gets one Point geometry in the same transaction (see writePointGeometry).
 */
interface PublicationEnrichment {
  /** Support for each claim. Filled only when the proposal was built from one report revision. */
  readonly support: readonly DomainEvidenceRef[];
  /** HOSTED-15: the evidence_references ids of the same support, in the same order. They link the origin rows. */
  readonly supportEvidenceRefIds: readonly string[];
  /** HOSTED-26: the event's one Point geometry id, or empty. Every claim of the version links to it. */
  readonly geometryIds: readonly string[];
  /** Set only for a coordinate-bearing event. It records the source of the point. */
  readonly geometrySource: PublicPointSource | null;
  readonly geometryStatus: "point_written" | "pending_geometry_writer" | "whole_view" | "not_required_group_notice";
}

/**
 * Runs one optional write or read inside a savepoint. A failure rolls back only that savepoint. The caller decides
 * whether the missing piece is acceptable.
 */
async function withOptionalSavepoint<Result>(
  tx: SqlExecutor,
  name: string,
  work: () => Promise<Result>,
): Promise<{ readonly ok: true; readonly value: Result } | { readonly ok: false }> {
  await tx.query(`SAVEPOINT ${name}`);
  try {
    const value = await work();
    await tx.query(`RELEASE SAVEPOINT ${name}`);
    return { ok: true, value };
  } catch {
    try {
      await tx.query(`ROLLBACK TO SAVEPOINT ${name}`);
      await tx.query(`RELEASE SAVEPOINT ${name}`);
    } catch {
      // The failed savepoint is the one to report; the outer transaction is handled by its caller.
    }
    return { ok: false };
  }
}

/** The persisted evidence of the proposal's grounding context, and the report revisions the proposal was built from. */
interface OwnEvidence {
  readonly revisions: readonly string[];
  readonly refs: readonly DomainEvidenceRef[];
  /** HOSTED-15: the evidence_references id of each ref, in the same order as refs. Never written into a claim. */
  readonly refIds: readonly string[];
}

/**
 * HOSTED-10: the persisted evidence the proposal's grounding context records. A span is listed only when the exact
 * evidence_references row exists. The revisions are the proposal's own report_revision_ids, or, when it carries none,
 * the revisions its context cites.
 */
async function ownEvidence(
  tx: SqlExecutor,
  datasetKind: string,
  proposal: EventProposalDto,
): Promise<OwnEvidence> {
  const extra = proposal as unknown as { context_id?: unknown; report_revision_ids?: unknown };
  if (typeof extra.context_id !== "string" || extra.context_id.length === 0) return { revisions: [], refs: [], refIds: [] };
  const context = await tx.query<{ record_json: unknown }>(
    `SELECT record_json FROM waspada.grounding_contexts WHERE dataset_kind = $1 AND context_id = $2`,
    [datasetKind, extra.context_id],
  );
  const contextRecord = parseJsonObject(context.rows[0]?.record_json);
  const entries = Array.isArray(contextRecord?.evidence) ? contextRecord.evidence : [];
  const candidates: DomainEvidenceRef[] = [];
  for (const entry of entries) {
    if (!isRecordValue(entry)) continue;
    if (typeof entry.report_revision_id !== "string" || entry.report_revision_id.length === 0) continue;
    if (typeof entry.permitted_text_hash !== "string" || !/^[a-f0-9]{64}$/u.test(entry.permitted_text_hash)) continue;
    if (!Number.isSafeInteger(entry.span_start) || !Number.isSafeInteger(entry.span_end)) continue;
    const spanStart = entry.span_start as number;
    const spanEnd = entry.span_end as number;
    if (spanStart < 0 || spanEnd <= spanStart) continue;
    if (entry.offset_unit !== "unicode_code_points" || entry.relation !== "supports") continue;
    candidates.push({
      report_revision_id: entry.report_revision_id,
      permitted_text_hash: entry.permitted_text_hash,
      span_start: spanStart,
      span_end: spanEnd,
      offset_unit: "unicode_code_points",
      relation: "supports",
    });
  }

  const refs: DomainEvidenceRef[] = [];
  const refIds: string[] = [];
  for (const candidate of candidates) {
    const persisted = await tx.query<{ evidence_ref_id: string }>(
      `SELECT evidence_ref_id::text AS evidence_ref_id FROM waspada.evidence_references
       WHERE dataset_kind = $1 AND report_revision_id = $2 AND permitted_text_hash = $3
         AND span_start = $4 AND span_end = $5 AND offset_unit = $6 AND relation = $7`,
      [
        datasetKind,
        candidate.report_revision_id,
        candidate.permitted_text_hash,
        candidate.span_start,
        candidate.span_end,
        candidate.offset_unit,
        candidate.relation,
      ],
    );
    if (persisted.rows.length !== 1) continue;
    const evidenceRefId = persisted.rows[0]!.evidence_ref_id;
    if (!refs.some((existing) => existing.report_revision_id === candidate.report_revision_id
      && existing.permitted_text_hash === candidate.permitted_text_hash
      && existing.span_start === candidate.span_start && existing.span_end === candidate.span_end)) {
      refs.push(candidate);
      refIds.push(evidenceRefId);
    }
  }

  const declared = Array.isArray(extra.report_revision_ids)
    ? [...new Set(extra.report_revision_ids.filter((id): id is string => typeof id === "string" && id.length > 0))]
    : [];
  const revisions = declared.length > 0
    ? declared
    : [...new Set(refs.map((ref) => ref.report_revision_id))];
  return { revisions, refs, refIds };
}

/**
 * HOSTED-26: the id of the one Point a published event gets at one coordinate. It is a pure function of the dataset, the
 * event and the exact coordinate, so a later version at the same place names the same row. Only the publication writes
 * "geo-pub-" ids.
 */
export function pointGeometryIdFor(datasetKind: string, eventId: string, coordinates: readonly [number, number]): string {
  const hash = createHash("sha256")
    .update(`${datasetKind}|${eventId}|${coordinates[0]}|${coordinates[1]}`)
    .digest("hex");
  return `geo-pub-${hash.slice(0, 32)}`;
}

interface PointWriteInput {
  readonly datasetKind: string;
  readonly traceId: string;
  readonly eventId: string;
  readonly coordinates: readonly [number, number];
  readonly source: PublicPointSource;
  readonly locationLabel: unknown;
  readonly support: readonly DomainEvidenceRef[];
}

/**
 * HOSTED-26: writes the event's one Point, or reuses the row an earlier version wrote. It returns the geometry id, or
 * null when there is no row and no support to write one, so the event stays a whole view. It runs inside the caller's
 * savepoint, which also covers the geometry's own evidence links.
 *
 * A row that already exists under this id is the same point of the same event, so it is reused whatever its trace,
 * label or evidence. The writer's own comparison would refuse a later version, because that version's trace and
 * support differ. So this path checks existence first, and the point keeps the trace, label and evidence of the first
 * version that wrote it.
 */
async function writePointGeometry(tx: SqlExecutor, input: PointWriteInput): Promise<string | null> {
  const geometryId = pointGeometryIdFor(input.datasetKind, input.eventId, input.coordinates);
  const existing = await tx.query<{ geometry_id: string }>(
    "SELECT geometry_id FROM waspada.geometries WHERE dataset_kind = $1 AND geometry_id = $2",
    [input.datasetKind, geometryId],
  );
  if (existing.rows.length > 0) return geometryId;
  if (input.support.length === 0) return null;

  await persistGeometryInCallerTransaction(tx, {
    schema_version: "2.0",
    trace_id: input.traceId,
    record_type: "Geometry",
    dataset_kind: input.datasetKind,
    geometry_id: geometryId,
    role: "approximate_place",
    geojson: { type: "Point", coordinates: [input.coordinates[0], input.coordinates[1]] },
    coordinate_reference_system: "OGC:CRS84",
    precision_m: null,
    precision_basis: input.source === "source_text" ? "source_supplied" : "unknown",
    display_label: publicPointLabel(input.locationLabel),
    source_evidence: input.support.map((ref) => ({
      report_revision_id: ref.report_revision_id,
      permitted_text_hash: ref.permitted_text_hash,
      span_start: ref.span_start,
      span_end: ref.span_end,
      offset_unit: ref.offset_unit,
      relation: ref.relation,
    })),
  });
  return geometryId;
}

/**
 * HOSTED-10 and HOSTED-26: the support and the location status of a publication. It never refuses. A coordinate-bearing
 * event with support gets one Point geometry (geometry_status "point_written"). A coordinate-bearing event with no
 * support, and no row written earlier, records "pending_geometry_writer" and stays a whole view. An event with no usable
 * coordinate records "whole_view". A group notice with no location records "not_required_group_notice". The support of a
 * claim is filled only when the proposal came from one report revision, so no claim is given evidence from another
 * revision.
 */
async function enrichPublication(
  tx: SqlExecutor,
  input: {
    readonly datasetKind: string;
    readonly traceId: string;
    readonly eventId: string;
    readonly version: number;
    readonly category: string;
    readonly proposal: EventProposalDto;
  },
): Promise<PublicationEnrichment> {
  const { proposal } = input;
  const evidence = await withOptionalSavepoint(tx, "hosted10_evidence", () => ownEvidence(tx, input.datasetKind, proposal));
  const own: OwnEvidence = evidence.ok ? evidence.value : { revisions: [], refs: [], refIds: [] };
  const supportIndexes = own.revisions.length === 1
    ? own.refs.flatMap((ref, index) => (ref.report_revision_id === own.revisions[0] ? [index] : []))
    : [];
  const support = supportIndexes.map((index) => own.refs[index]!);
  const supportEvidenceRefIds = supportIndexes.map((index) => own.refIds[index]!);

  // HOSTED-14: the point's source comes from the claims' own source ids (source_text only for PetaBencana or BMKG).
  const outcome = publicPointOutcomeFor({
    category: input.category,
    locationLabel: proposal.location_label,
    coordinates: proposal.coordinates,
    claimSourceIds: (proposal.claims ?? []).map((claim) => claim.source_id),
  });
  if (outcome.status === "point") {
    const point = await withOptionalSavepoint(tx, "hosted26_point", () => writePointGeometry(tx, {
      datasetKind: input.datasetKind,
      traceId: input.traceId,
      eventId: input.eventId,
      coordinates: outcome.coordinates,
      source: outcome.source,
      locationLabel: proposal.location_label,
      support,
    }));
    const geometryId = point.ok ? point.value : null;
    return {
      support,
      supportEvidenceRefIds,
      geometryIds: geometryId === null ? [] : [geometryId],
      geometrySource: outcome.source,
      geometryStatus: geometryId === null ? "pending_geometry_writer" : "point_written",
    };
  }
  if (outcome.status === "not_required_group_notice") {
    return {
      support,
      supportEvidenceRefIds,
      geometryIds: [],
      geometrySource: null,
      geometryStatus: "not_required_group_notice",
    };
  }
  return {
    support,
    supportEvidenceRefIds,
    geometryIds: [],
    geometrySource: null,
    geometryStatus: "whole_view",
  };
}

/** HOSTED-15: the origin kind of an evidence label. A label with no entry here keeps the origin kind "unknown". */
const ORIGIN_KIND_BY_LABEL: Readonly<Partial<Record<string, string>>> = {
  issuer_notice: "issuer_statement",
  attributed_report: "reporter_observation",
  crowdsourced_observation: "crowdsourced_observation",
};

/**
 * HOSTED-15: the origin id of one registered source in one dataset. It is a pure function of the two, so every
 * publication from that source reuses the same row.
 */
export function originIdFor(datasetKind: string, sourceId: string): string {
  const hash = createHash("sha256").update("origin:").update(datasetKind).update(":").update(sourceId).digest("hex");
  return `origin-${hash.slice(0, 40)}`;
}

interface OriginWriteResult {
  /** The origin ids of each claim, by claim index. A claim with no registered source has none. */
  readonly originIdsByClaim: readonly (readonly string[])[];
  /** The number of distinct registered sources that have an origin row in this publication. */
  readonly origins: number;
}

/**
 * HOSTED-15: writes one evidence origin per registered source of the claims, and links each origin to the persisted
 * evidence the version cites (the same support every claim carries). A source that is not in the registry gets no
 * origin, so no claim ever names a row that does not exist. The origin content is the registry's display name and
 * public hosts only. The publication role only inserts: a repeated source hits ON CONFLICT DO NOTHING and reuses its
 * row. The bare conflict clause needs no read grant, and it is safe because each origin table's only unique key is
 * its primary key (keep it that way, or name the target and grant the SELECT it needs). Origins are not corroboration,
 * so both status fields stay "unknown". Origin rows are append-only.
 */
export async function writeOriginRows(
  tx: SqlExecutor,
  input: {
    readonly datasetKind: string;
    readonly traceId: string;
    readonly claims: readonly { readonly sourceId: string | null; readonly evidenceLabel: string | null }[];
    readonly supportEvidenceRefIds: readonly string[];
  },
): Promise<OriginWriteResult> {
  const sourceIds = [...new Set(input.claims.map((claim) => claim.sourceId).filter((id): id is string => !!id))];
  const registered = new Map<string, { readonly displayName: string; readonly approvedHosts: readonly string[] }>();
  if (sourceIds.length > 0) {
    const rows = await tx.query<{ source_id: string; display_name: string; approved_hosts: string[] }>(
      "SELECT source_id, display_name, approved_hosts FROM waspada.source_registry WHERE source_id = ANY($1::text[])",
      [sourceIds],
    );
    for (const row of rows.rows) {
      registered.set(row.source_id, { displayName: row.display_name, approvedHosts: row.approved_hosts });
    }
  }

  const originBySource = new Map<string, string>();
  for (const sourceId of sourceIds) {
    const source = registered.get(sourceId);
    if (!source) continue;
    const label = input.claims.find((claim) => claim.sourceId === sourceId)?.evidenceLabel ?? null;
    const originId = originIdFor(input.datasetKind, sourceId);
    const originKind = (label === null ? undefined : ORIGIN_KIND_BY_LABEL[label]) ?? "unknown";
    await tx.query(
      `INSERT INTO waspada.evidence_origins
         (dataset_kind, origin_id, trace_id, origin_kind, actor_label, source_id, lineage_relation, independence_status, record_json)
       VALUES ($1, $2, $3, $4, $5, $6, 'unknown', 'unknown', $7::jsonb)
       ON CONFLICT DO NOTHING`,
      [
        input.datasetKind,
        originId,
        input.traceId,
        originKind,
        Array.from(source.displayName).slice(0, 200).join(""),
        sourceId,
        JSON.stringify({ public_hosts: [...source.approvedHosts].slice(0, 10) }),
      ],
    );
    for (const evidenceRefId of input.supportEvidenceRefIds) {
      await tx.query(
        `INSERT INTO waspada.origin_evidence (dataset_kind, origin_id, evidence_ref_id)
         VALUES ($1, $2, $3::bigint)
         ON CONFLICT DO NOTHING`,
        [input.datasetKind, originId, evidenceRefId],
      );
    }
    originBySource.set(sourceId, originId);
  }

  return {
    originIdsByClaim: input.claims.map((claim) => {
      const originId = claim.sourceId === null ? undefined : originBySource.get(claim.sourceId);
      return originId === undefined ? [] : [originId];
    }),
    origins: originBySource.size,
  };
}

/** HOSTED-22: the review version of every attribution row this publisher writes. See writeSourceAttributions. */
const ATTRIBUTION_REVIEW_VERSION = 1;
/** HOSTED-22: the fixed audit reason. It names the rule and carries no source text. */
const ATTRIBUTION_DECISION_REASON = "Attribution follows the source's approval in source_registry at publication (owner decision, 17 Nov 2026).";
/** HOSTED-22: a query parameter named like a credential. A link carrying one is never shown publicly. */
const CREDENTIAL_PARAM_PATTERN = /^(api[-_]?key|apikey|key|token|access[-_]?token|auth|secret|signature|sig|password)$/iu;

/**
 * HOSTED-22: the review decision id of one supporting evidence reference. It is a pure function of the two, so a
 * repeated publication names the same row.
 */
export function attributionDecisionIdFor(datasetKind: string, evidenceRefId: string): string {
  const hash = createHash("sha256").update("attribution:").update(datasetKind).update(":").update(evidenceRefId).digest("hex");
  return `attr-${hash.slice(0, 40)}`;
}

/**
 * HOSTED-22: the URL an attribution may show, or null. Only an https link with no credentials and no credential-like
 * query parameter passes. The schema requires https, so an http link gets no attribution rather than a changed scheme.
 */
export function attributionUrlFor(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const url = value.trim();
  if (url.length < 9 || url.length > 2048 || /\s/u.test(url) || !url.startsWith("https://")) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" || parsed.username !== "" || parsed.password !== "") return null;
  for (const name of parsed.searchParams.keys()) {
    if (CREDENTIAL_PARAM_PATTERN.test(name)) return null;
  }
  return url;
}

interface AttributionSupportRow {
  readonly evidence_ref_id: string;
  readonly report_revision_id: string;
  readonly permitted_text_hash: string;
  readonly span_start: number;
  readonly span_end: number;
  readonly source_id: string;
  readonly canonical_url: string;
  readonly published_at: string | null;
}

export interface AttributionWriteResult {
  /** Supporting references that got an approved attribution. A repeat leaves the existing row as it is. */
  readonly attributed: number;
  /** Supporting references with no permitted source, no approved registry row, or no usable https link or name. */
  readonly skipped: number;
}

/**
 * HOSTED-22 (owner decision, 16-17 Nov 2026): approving a source grants public display of its attribution. For each
 * supporting evidence reference of a published version, the publication transaction inserts one approved
 * public_attribution_review_decisions row when the reference's source (its revision's source_id) is a claim source that
 * passed the public-display rights check (decideProposal's publicDisplaySourceIds) and is approved in source_registry.
 * The name is the registry display name. The link is the revision's canonical URL, https only. The publish time is the
 * revision's own published_at, NULL when the source gave none: the acquisition time is never a publish time (F-14).
 * source_observed_at stays NULL. The actor is agent:auto-publisher.
 *
 * Insert only. review_version is fixed at 1, because the publication role has no read on the table and cannot compute a
 * next version. A bare ON CONFLICT DO NOTHING keeps the first decision for a reference. A repeat publication therefore
 * changes nothing, and a later moderator decision on that reference is never overwritten. A reference with no row gets
 * no approved attribution, and the public projector then refuses that version for the reference (ATTRIBUTION_FAILED).
 */
export async function writeSourceAttributions(
  tx: SqlExecutor,
  input: {
    readonly datasetKind: string;
    readonly evidenceRefIds: readonly string[];
    readonly publicDisplaySourceIds: ReadonlySet<string>;
    readonly decidedAt: string;
  },
): Promise<AttributionWriteResult> {
  // The table's CHECK allows only the live dataset.
  if (input.datasetKind !== "live" || input.evidenceRefIds.length === 0) return { attributed: 0, skipped: 0 };
  const refs = await tx.query<AttributionSupportRow>(
    `SELECT evidence.evidence_ref_id::text AS evidence_ref_id, evidence.report_revision_id,
            evidence.permitted_text_hash, evidence.span_start, evidence.span_end,
            revision.source_id, revision.canonical_url,
            CASE WHEN revision.published_at IS NULL THEN NULL
              ELSE to_char(revision.published_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
            END AS published_at
     FROM waspada.evidence_references AS evidence
     JOIN waspada.report_revisions AS revision
       ON revision.dataset_kind = evidence.dataset_kind
      AND revision.report_revision_id = evidence.report_revision_id
     WHERE evidence.dataset_kind = $1
       AND evidence.evidence_ref_id = ANY($2::bigint[])
       AND evidence.relation = 'supports'
       AND evidence.offset_unit = 'unicode_code_points'`,
    [input.datasetKind, [...input.evidenceRefIds]],
  );

  const sourceIds = [...new Set(refs.rows.map((row) => row.source_id))];
  const registry = new Map<string, { readonly displayName: string; readonly approved: boolean }>();
  if (sourceIds.length > 0) {
    const rows = await tx.query<{ source_id: string; display_name: string; approval_status: string }>(
      "SELECT source_id, display_name, approval_status FROM waspada.source_registry WHERE source_id = ANY($1::text[])",
      [sourceIds],
    );
    for (const row of rows.rows) {
      registry.set(row.source_id, { displayName: row.display_name.trim(), approved: row.approval_status === "approved" });
    }
  }

  let attributed = 0;
  let skipped = 0;
  for (const ref of refs.rows) {
    const source = registry.get(ref.source_id);
    const url = attributionUrlFor(ref.canonical_url);
    const rightsBasisRef = `source_registry:${ref.source_id}`;
    if (source === undefined || !source.approved || !input.publicDisplaySourceIds.has(ref.source_id)
      || source.displayName.length === 0 || source.displayName.length > 200
      || rightsBasisRef.length > 500 || url === null) {
      skipped += 1;
      continue;
    }
    await tx.query(
      `INSERT INTO waspada.public_attribution_review_decisions (
         review_decision_id, dataset_kind, evidence_ref_id, report_revision_id, permitted_text_hash,
         span_start, span_end, offset_unit, relation, review_version, decision_status, rights_basis_ref,
         public_display_name, source_url, source_published_at, source_observed_at, reviewer_id,
         decision_reason, reviewed_at)
       VALUES ($1, $2, $3::bigint, $4, $5, $6::integer, $7::integer, 'unicode_code_points', 'supports', $8::integer,
         'approved', $9, $10, $11, $12::timestamptz, NULL, $13, $14, $15::timestamptz)
       ON CONFLICT DO NOTHING`,
      [
        attributionDecisionIdFor(input.datasetKind, ref.evidence_ref_id),
        input.datasetKind,
        ref.evidence_ref_id,
        ref.report_revision_id,
        ref.permitted_text_hash,
        ref.span_start,
        ref.span_end,
        ATTRIBUTION_REVIEW_VERSION,
        rightsBasisRef,
        source.displayName,
        url,
        ref.published_at,
        AGENT_AUTO_PUBLISHER_ID,
        ATTRIBUTION_DECISION_REASON,
        input.decidedAt,
      ],
    );
    attributed += 1;
  }
  return { attributed, skipped };
}

function parseJsonObject(value: unknown): Record<string, unknown> | null {
  try {
    const parsed = typeof value === "string" ? JSON.parse(value) : value;
    return isRecordValue(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Input to the one publish transaction shared by the agent, a moderator publish and a moderator correction. */
interface PublishCore {
  readonly datasetKind: "live" | "historical" | "synthetic";
  readonly proposalId: string;
  readonly traceId: string;
  readonly proposal: EventProposalDto;
  readonly investigationId: string | null;
  readonly action: "auto_publish" | "publish" | "correct";
  readonly actor: PublicationActor;
  readonly reason: string | null;
  readonly sourcePermission?: AutoPublishSourcePermission;
  readonly publicDisplaySourceIds: ReadonlySet<string>;
  /** HOSTED-28: claim sources that are not approved. Refused before any waiver. Resolved by resolveRevokedSourceIds. */
  readonly revokedSourceIds: ReadonlySet<string>;
  readonly decisionId: string;
  readonly decidedAt: string;
  /** TG-FR12: the version a correction was made from. A correction publishes only over that version. */
  readonly baseVersion?: number;
}

/** HOSTED-26: the rows of one published version. The caller builds the decision record, so every gate and location field is explicit. */
interface PublishedVersionWrite {
  readonly datasetKind: "live" | "historical" | "synthetic";
  readonly traceId: string;
  readonly eventId: string;
  readonly version: number;
  readonly proposalId: string;
  readonly decisionId: string;
  readonly decidedAt: string;
  /** The reviewer of the decision and of the review row. */
  readonly actorId: string;
  readonly proposal: EventProposalDto;
  readonly detail: EventDetail;
  readonly enrichment: PublicationEnrichment;
  readonly decisionRecord: Record<string, unknown>;
  readonly publicDisplaySourceIds: ReadonlySet<string>;
  /** The public update the version adds. The review row takes this change type and summary. */
  readonly review: { readonly changeType: "published" | "corrected"; readonly summary: string };
}

/**
 * HOSTED-26: the one write of a published version, shared by a publication and a location refresh. It writes the publish
 * decision, the origin and attribution rows of the version, the version and its claims, the claim-geometry links and the
 * approved review row. It runs inside the caller's transaction and writes nothing else. A caller that must not write
 * throws before it is reached, which rolls the whole transaction back.
 */
async function writePublishedVersion(tx: SqlExecutor, input: PublishedVersionWrite): Promise<void> {
  const { datasetKind, traceId, eventId, version, decisionId, decidedAt, proposal, detail, enrichment } = input;
  await tx.query(
    `INSERT INTO waspada.publication_decisions (
       dataset_kind, decision_id, trace_id, proposal_id, policy_version,
       event_id, event_version, reviewer_id, decided_at, record_json)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::timestamptz, $10::jsonb)`,
    [
      datasetKind,
      decisionId,
      traceId,
      input.proposalId,
      PUBLICATION_POLICY_VERSION,
      eventId,
      version,
      input.actorId,
      decidedAt,
      JSON.stringify(input.decisionRecord),
    ],
  );
  // HOSTED-02: the stored record is the domain schema 2.0 Event, built by the shared builder. Publication mode and
  // waivers are not part of it: they stay on the publication decision row.
  const eventTime = domainEventTime(proposal.event_time);
  // HOSTED-15: the origin rows of the registered sources, linked to the evidence the version cites. They are written
  // before the record, so each claim's origin_ids names a row of this transaction. Count-only log line.
  const origins = await writeOriginRows(tx, {
    datasetKind,
    traceId,
    claims: (proposal.claims ?? []).map((claim, index) => ({
      sourceId: claim.source_id ?? null,
      evidenceLabel: detail.claims[index]?.evidence_label ?? null,
    })),
    supportEvidenceRefIds: enrichment.supportEvidenceRefIds,
  });
  if (origins.origins > 0) {
    console.info(JSON.stringify({ event: "publication_origins", origins: origins.origins, support_refs: enrichment.supportEvidenceRefIds.length }));
  }
  // HOSTED-22: the approved attribution of each supporting reference, from the source's approval at publication. Live only.
  const attributions = await writeSourceAttributions(tx, {
    datasetKind,
    evidenceRefIds: enrichment.supportEvidenceRefIds,
    publicDisplaySourceIds: input.publicDisplaySourceIds,
    decidedAt,
  });
  if (attributions.attributed > 0 || attributions.skipped > 0) {
    console.info(JSON.stringify({ event: "publication_attributions", attributed: attributions.attributed, skipped: attributions.skipped }));
  }
  const scope = { ...EMPTY_SCOPE, geometry_ids: [...enrichment.geometryIds] };
  const record = buildEventRecordV2({
    datasetKind,
    traceId,
    eventId,
    version,
    supersedesVersion: version > 1 ? version - 1 : null,
    decisionId,
    status: "published",
    statusAt: decidedAt,
    withdrawalReason: null,
    title: detail.title,
    summary: detail.summary.length > 0 ? detail.summary : detail.title,
    category: detail.category,
    lifecycle: detail.lifecycle,
    tags: domainTags(proposal),
    freshness: domainFreshness(eventTime, decidedAt),
    eventTime,
    validity: NULL_VALIDITY,
    scope,
    claims: domainClaimsFor(proposal, eventId, eventTime, detail.claims.map((claim) => ({
      text: claim.text,
      evidence_label: claim.evidence_label,
    })), {
      support: enrichment.support,
      geometryIds: enrichment.geometryIds,
      originIdsByClaim: origins.originIdsByClaim,
    }),
  });
  await tx.query(
    `INSERT INTO waspada.event_versions (
       dataset_kind, event_id, version, trace_id, supersedes_version, title, summary, category,
       lifecycle, publication_status, publication_decision_id, published_at, record_json)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'published', $10, $11::timestamptz, $12::jsonb)`,
    [
      datasetKind,
      eventId,
      version,
      traceId,
      record.supersedes_version,
      record.title,
      record.summary,
      record.category,
      record.lifecycle,
      decisionId,
      decidedAt,
      JSON.stringify(record),
    ],
  );
  for (const claim of record.claims) {
    await tx.query(
      `INSERT INTO waspada.event_claims (
         dataset_kind, event_id, event_version, claim_id, publication_status, claim_text, evidence_label, record_json)
       VALUES ($1, $2, $3, $4, 'published', $5, $6, $7::jsonb)`,
      [
        datasetKind,
        eventId,
        version,
        claim.claim_id,
        claim.text,
        claim.evidence_label,
        JSON.stringify(claim),
      ],
    );
  }
  // HOSTED-26: each claim links the geometry ids its claim scope names, which are the version's point. Only a version
  // with a point writes links. The public detail and the GeoJSON feed both need these rows to show the pin.
  if (enrichment.geometryIds.length > 0) {
    for (const claim of record.claims) {
      for (const geometryId of claim.scope.geometry_ids) {
        await tx.query(
          `INSERT INTO waspada.event_claim_geometries (dataset_kind, event_id, event_version, claim_id, geometry_id)
           VALUES ($1, $2, $3, $4, $5)`,
          [datasetKind, eventId, version, claim.claim_id, geometryId],
        );
      }
    }
  }
  // HOSTED-02: the approved review row is what the public history and updates views read. Its summary is a fixed
  // template (ADR-020 amendment). Only the live dataset has review rows: its CHECK allows no other dataset_kind.
  if (datasetKind === "live") {
    await tx.query(
      `INSERT INTO waspada.public_event_history_review_decisions (
         dataset_kind, event_id, event_version, review_status, change_type, summary, reviewer_id, reviewed_at)
       VALUES ($1, $2, $3, 'approved', $4, $5, $6, $7::timestamptz)`,
      [datasetKind, eventId, version, input.review.changeType, input.review.summary, input.actorId, decidedAt],
    );
  }
}

/**
 * The publish transaction body. It runs inside a transaction the caller opened, and takes the proposal lock and
 * the event lock in that order. A correction refusal is recorded (rejected decision plus audit record) in the same
 * transaction, so the proposal the moderator submitted never stays undecided.
 */
async function publishInTransaction(tx: SqlExecutor, core: PublishCore): Promise<PublishAttempt> {
  const { datasetKind, proposalId, traceId, proposal, action, actor, decisionId, decidedAt } = core;
  const actorRecord = { actor_kind: actor.kind, actor_id: actor.actorId };

  const refuseCorrection = async (
    code: CorrectionRefusalCode,
    reasons: readonly ProposalGateReason[],
  ): Promise<PublishAttempt> => {
    await insertUnpublishedDecision(tx, {
      datasetKind,
      decisionId,
      traceId,
      proposalId,
      reviewerId: actor.actorId,
      decidedAt,
      record: {
        disposition: "reject",
        ...actorRecord,
        reason: core.reason,
        refusal_code: code,
        gate_reasons: [...reasons],
        base_version: core.baseVersion ?? null,
      },
    });
    await writeAuditRecord(tx, {
      datasetKind,
      traceId,
      occurredAt: decidedAt,
      actorId: actor.actorId,
      action: AUDIT_ACTION_CORRECTION,
      eventId: publicEventIdForProposal(proposal),
      reason: core.reason,
      details: { outcome: "refused", refusal_code: code, gate_reasons: [...reasons], proposal_id: proposalId, base_version: core.baseVersion ?? null, decision_id: decisionId },
    });
    return { outcome: { status: "denied", code, reasons } };
  };

  await lockProposalDecisions(tx, datasetKind, proposalId);
  const prior = await latestDisposition(tx, datasetKind, proposalId);
  if (prior) return { outcome: { status: "already_decided", disposition: prior.disposition } };

  const linkedInvestigationStatus = await latestInvestigationStatus(tx, datasetKind, core.investigationId);
  const gateOptions = {
    publicDisplaySourceIds: core.publicDisplaySourceIds,
    revokedSourceIds: core.revokedSourceIds,
    linkedInvestigationStatus,
  };

  let waivers: readonly AutoPublicationWaiver[] = [];
  if (action === "auto_publish") {
    const assessment = evaluateAutoPublication(proposal, { ...gateOptions, sourcePermission: core.sourcePermission });
    if (assessment.reasons.length > 0) return { outcome: { status: "queued", reasons: assessment.reasons } };
    waivers = assessment.waivers;
  } else if (action === "publish") {
    const reasons = assessProposalSourceGate(proposal, gateOptions);
    if (reasons.includes("investigation_stopped_for_review")) {
      return { outcome: { status: "denied", code: "investigation_stopped_for_review" } };
    }
    if (reasons.length > 0) return { outcome: { status: "denied", code: "publication_not_authorized", reasons } };
  } else {
    // TG-FR12: a correction uses the moderator source gate plus the event-time check.
    const reasons = assessCorrectionGate(proposal, gateOptions);
    if (reasons.includes("investigation_stopped_for_review")) {
      return refuseCorrection("investigation_stopped_for_review", reasons);
    }
    if (reasons.length > 0) return refuseCorrection("publication_not_authorized", reasons);
  }

  const eventId = publicEventIdForProposal(proposal);
  await lockEventPublication(tx, datasetKind, eventId);
  const latest = await latestEventDecision(tx, datasetKind, eventId);
  // TG-FR12: a withdrawn event is final for this slice. Nothing publishes a new version over the tombstone.
  if (latest?.disposition === "withdraw") {
    if (action === "correct") return refuseCorrection("event_withdrawn", []);
    return { outcome: { status: "denied", code: "event_withdrawn" } };
  }
  if (action === "correct") {
    if (!latest) return refuseCorrection("event_not_found", []);
    if (core.baseVersion !== latest.version) return refuseCorrection("stale_base_version", []);
  }

  const version = (latest?.version ?? 0) + 1;
  const publicationMode = action === "auto_publish" ? "agent_auto" : "moderator_reviewed";
  const sourceCount = distinctOutlets(proposal);

  // Build the public version before any write. Invalid data then refuses without a decision row.
  let detail: EventDetail;
  try {
    detail = proposalToEventDetail(proposal, undefined, {
      version,
      publication: { mode: publicationMode, source_count: sourceCount, ...(waivers.length > 0 ? { waivers } : {}) },
    });
  } catch {
    if (action === "correct") return refuseCorrection("publication_failed", []);
    return { outcome: { status: "denied", code: "publication_failed" } };
  }

  // F-ALERT-01: a repeated report of facts that are already public adds no version and no update. It is recorded
  // as no_material_change, and the new source is kept on that decision for audit only. A current version whose
  // proposal can no longer be projected is not compared, so this proposal publishes as before.
  if (latest?.disposition === "publish") {
    let currentKey: string | null = null;
    try {
      currentKey = publicContentKey(proposalToEventDetail(latest.proposal, undefined, { version: latest.version }));
    } catch {
      currentKey = null;
    }
    if (currentKey !== null && currentKey === publicContentKey(detail)) {
      await insertUnpublishedDecision(tx, {
        datasetKind,
        decisionId,
        traceId,
        proposalId,
        reviewerId: actor.actorId,
        decidedAt,
        record: {
          disposition: "no_material_change",
          ...actorRecord,
          reason: core.reason,
          matched_event_id: eventId,
          matched_event_version: latest.version,
          matched_decision_id: latest.decisionId,
          source_count: sourceCount,
          ...(action === "correct" ? { base_version: core.baseVersion ?? null } : {}),
        },
      });
      if (action === "correct") {
        await writeAuditRecord(tx, {
          datasetKind,
          traceId,
          occurredAt: decidedAt,
          actorId: actor.actorId,
          action: AUDIT_ACTION_CORRECTION,
          eventId,
          reason: core.reason,
          details: { outcome: "unchanged", proposal_id: proposalId, decision_id: decisionId, event_version: latest.version, base_version: core.baseVersion ?? null },
        });
      }
      return { outcome: { status: "unchanged", decisionId, eventId, version: latest.version } };
    }
  }

  // HOSTED-10 and HOSTED-26: the support and the location status are read only after the unchanged check. A point gets
  // its one geometry row here, inside this transaction. An event with no usable coordinate is published as a whole view,
  // never refused for it.
  const enrichment = await enrichPublication(tx, { datasetKind, traceId, eventId, version, category: detail.category, proposal });
  // HOSTED-18: the public list needs whether a label was present. HOSTED-26: the sanitized label text is stored with it
  // (owner decision, 18 Nov 2026). The Event record has no label slot, so both stay on the publication decision.
  const locationLabelPresent = typeof proposal.location_label === "string" && proposal.location_label.trim().length > 0;
  const locationLabel = publicLocationLabel(proposal.location_label);

  await writePublishedVersion(tx, {
    datasetKind,
    traceId,
    eventId,
    version,
    proposalId,
    decisionId,
    decidedAt,
    actorId: actor.actorId,
    proposal,
    detail,
    enrichment,
    publicDisplaySourceIds: core.publicDisplaySourceIds,
    decisionRecord: {
      disposition: "publish",
      ...actorRecord,
      location_label_present: locationLabelPresent,
      // HOSTED-26: always written (null for none or a generic label), so the location backfill never re-selects it.
      location_label: locationLabel,
      publication_mode: publicationMode,
      gate: action === "auto_publish"
        ? "agent_auto_publication"
        : action === "correct" ? "moderator_correction" : "moderator_review",
      source_count: sourceCount,
      reason: core.reason,
      ...(waivers.length > 0 ? { waivers } : {}),
      ...(action === "correct" ? { base_version: core.baseVersion ?? null } : {}),
      // HOSTED-10 and HOSTED-26: the point's source and the location status live here. "point_written" means the
      // version's claims link one geometry row (event_claim_geometries).
      geometry_source: enrichment.geometrySource,
      geometry_status: enrichment.geometryStatus,
    },
    review: {
      changeType: action === "correct" ? "corrected" : "published",
      summary: reviewSummaryFor(action, { sourceCount, reason: core.reason }),
    },
  });
  if (action === "correct") {
    await writeAuditRecord(tx, {
      datasetKind,
      traceId,
      occurredAt: decidedAt,
      actorId: actor.actorId,
      action: AUDIT_ACTION_CORRECTION,
      eventId,
      reason: core.reason,
      details: { outcome: "published", proposal_id: proposalId, decision_id: decisionId, event_version: version, supersedes_version: latest?.version ?? null, base_version: core.baseVersion ?? null },
    });
  }
  return {
    outcome: { status: "published", decisionId, eventId, version, publicationMode },
    detail,
  };
}

/**
 * Applies one decision to one proposal.
 * - auto_publish: runs evaluateAutoPublication. A failing check queues the proposal for a moderator.
 *   `sourcePermission: "local_relaxed"` (local live mode only, ADR-061 amendment) skips only the
 *   public-display permission check, and the waiver is recorded on the decision and the public version.
 * - publish: a moderator decision. It runs the source gate (schema, links, rights) and does not
 *   require a clean discrepancy status, because the moderator has reviewed it.
 * - reject: records a rejection and never publishes.
 * F-04: a proposal linked to a stopped_for_review investigation is refused by auto_publish (queued) and by
 * publish (denied, investigation_stopped_for_review). Reject is still allowed.
 * A proposal that already has a decision is never decided again. F-CONC-01: every decision on one proposal
 * takes the same lock, and the already-decided check runs after the lock, inside the transaction that writes.
 * F-ALERT-01: a publish that passes the gate but carries the same public facts as the event's current version is
 * recorded as no_material_change and returns "unchanged". It writes no version, claim or outbox row.
 * TG-FR12: an event withdrawn by a moderator is never published again (denied, event_withdrawn).
 * HOSTED-28: a claim from a source that is not approved is refused with source_revoked, before any local_relaxed waiver.
 * The proposal is queued (auto_publish) or denied (publish). Published events are not withdrawn.
 */
export async function decideProposal(
  dependencies: ProposalDecisionDependencies,
  input: {
    readonly proposalId: string;
    readonly action: ProposalDecisionAction;
    readonly actor: PublicationActor;
    readonly reason?: string;
    /** Read only for auto_publish. Omitted means `required`, so the permission check applies. */
    readonly sourcePermission?: AutoPublishSourcePermission;
  },
): Promise<ProposalDecisionOutcome> {
  const { executor, datasetKind } = dependencies;
  const rows = await executor.query<{ trace_id: string; record_json: unknown; investigation_id: string | null }>(
    `SELECT trace_id, record_json, investigation_id FROM waspada.event_proposals
     WHERE dataset_kind = $1 AND proposal_id = $2`,
    [datasetKind, input.proposalId],
  );
  const row = rows.rows[0];
  if (!row) return { status: "denied", code: "proposal_not_found" };
  const proposal = parseProposal(row.record_json);

  const decidedAt = new Date().toISOString();
  const decisionId = `dec-${randomUUID()}`;
  const actorRecord = { actor_kind: input.actor.kind, actor_id: input.actor.actorId };

  // F-CONC-01: the lock is taken first, and the already-decided check and the gate both run after it, in the
  // transaction that writes. A check made before the lock could read "undecided" while another decision on the
  // same proposal was still committing.
  if (input.action === "reject") {
    return runInTransaction<ProposalDecisionOutcome>(executor, async (tx) => {
      await lockProposalDecisions(tx, datasetKind, input.proposalId);
      const prior = await latestDisposition(tx, datasetKind, input.proposalId);
      if (prior) return { status: "already_decided", disposition: prior.disposition };
      await insertUnpublishedDecision(tx, {
        datasetKind,
        decisionId,
        traceId: row.trace_id,
        proposalId: input.proposalId,
        reviewerId: input.actor.actorId,
        decidedAt,
        record: { disposition: "reject", ...actorRecord, reason: input.reason ?? null },
      });
      return { status: "rejected", decisionId };
    });
  }

  // External registry checks run before the lock, so no database lock is held across them. Fail-closed.
  const publicDisplaySourceIds = await resolvePublicDisplay(dependencies, proposal);
  const revokedSourceIds = await resolveRevokedSourceIds(executor, proposal);
  // Narrowed outside the closure below: "reject" returned above, so this is the publish side of the action.
  const publishAction: "auto_publish" | "publish" = input.action;

  // The decision, the published version and its claims are one transaction. The decision and the
  // version reference each other through deferred foreign keys, so they commit together or not at all.
  // Any write error rolls the whole transaction back, and the caller sees publication_failed.
  let attempt: PublishAttempt;
  try {
    attempt = await runInTransaction<PublishAttempt>(executor, (tx) => publishInTransaction(tx, {
      datasetKind,
      proposalId: input.proposalId,
      traceId: row.trace_id,
      proposal,
      investigationId: row.investigation_id,
      action: publishAction,
      actor: input.actor,
      reason: input.reason ?? null,
      sourcePermission: input.sourcePermission,
      publicDisplaySourceIds,
      revokedSourceIds,
      decisionId,
      decidedAt,
    }));
  } catch {
    return { status: "denied", code: "publication_failed" };
  }

  // Only after COMMIT: the public read model never shows a publication that rolled back.
  if (attempt.detail) PublicReadModel.publish(attempt.detail);
  return attempt.outcome as ProposalDecisionOutcome;
}

/**
 * TG-FR12: withdraws a published event. One transaction writes a new version whose publication_status is
 * `withdrawn` (the contract's tombstone: no claims, no impacts, a withdrawal_reason, withdrawn_at), a withdraw
 * decision, and an audit record. The lifecycle is not changed: withdrawal is not resolution. Only after COMMIT is
 * the event removed from the in-memory public read model. Public database views drop the event on their own,
 * because they read only a current published version.
 */
export async function withdrawPublishedEvent(
  dependencies: ProposalDecisionDependencies,
  input: {
    readonly eventId: string;
    readonly actorId: string;
    readonly reasonCategory: WithdrawalReasonCategory;
    readonly reason: string;
  },
): Promise<WithdrawalOutcome> {
  const { executor, datasetKind } = dependencies;
  const decidedAt = new Date().toISOString();
  const decisionId = `dec-${randomUUID()}`;
  let outcome: WithdrawalOutcome;
  try {
    outcome = await runInTransaction<WithdrawalOutcome>(executor, async (tx) => {
      await lockEventPublication(tx, datasetKind, input.eventId);
      const latest = await latestEventDecision(tx, datasetKind, input.eventId);
      if (!latest) return { status: "denied", code: "event_not_found" };
      if (latest.disposition === "withdraw") {
        return { status: "already_withdrawn", eventId: input.eventId, version: latest.version };
      }
      const current = await tx.query<{ title: string; summary: string; category: string; lifecycle: string }>(
        `SELECT title, summary, category, lifecycle FROM waspada.event_versions
         WHERE dataset_kind = $1 AND event_id = $2 AND version = $3`,
        [datasetKind, input.eventId, latest.version],
      );
      const published = current.rows[0];
      if (!published) return { status: "denied", code: "event_not_found" };

      const version = latest.version + 1;
      await tx.query(
        `INSERT INTO waspada.publication_decisions (
           dataset_kind, decision_id, trace_id, proposal_id, policy_version,
           event_id, event_version, reviewer_id, decided_at, record_json)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::timestamptz, $10::jsonb)`,
        [
          datasetKind,
          decisionId,
          latest.traceId,
          latest.proposalId,
          PUBLICATION_POLICY_VERSION,
          input.eventId,
          version,
          input.actorId,
          decidedAt,
          JSON.stringify({
            disposition: "withdraw",
            actor_kind: "moderator",
            actor_id: input.actorId,
            reason_category: input.reasonCategory,
            reason: input.reason,
            supersedes_version: latest.version,
          }),
        ],
      );
      const tombstone = buildWithdrawnEventRecordV2({
        datasetKind,
        traceId: latest.traceId,
        eventId: input.eventId,
        version,
        supersedesVersion: latest.version,
        decisionId,
        withdrawnAt: decidedAt,
        reasonCategory: input.reasonCategory,
        title: published.title,
        summary: published.summary,
        category: published.category,
        lifecycle: published.lifecycle,
      });
      await tx.query(
        `INSERT INTO waspada.event_versions (
           dataset_kind, event_id, version, trace_id, supersedes_version, title, summary, category,
           lifecycle, publication_status, withdrawal_reason, publication_decision_id, published_at, withdrawn_at, record_json)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'withdrawn', $10, $11, NULL, $12::timestamptz, $13::jsonb)`,
        [
          datasetKind,
          input.eventId,
          version,
          latest.traceId,
          latest.version,
          published.title,
          published.summary,
          published.category,
          published.lifecycle,
          input.reasonCategory,
          decisionId,
          decidedAt,
          JSON.stringify(tombstone),
        ],
      );
      await writeAuditRecord(tx, {
        datasetKind,
        traceId: latest.traceId,
        occurredAt: decidedAt,
        actorId: input.actorId,
        action: AUDIT_ACTION_WITHDRAWN,
        eventId: input.eventId,
        reason: input.reason,
        details: {
          reason_category: input.reasonCategory,
          decision_id: decisionId,
          event_version: version,
          supersedes_version: latest.version,
          policy_version: PUBLICATION_POLICY_VERSION,
        },
      });
      return {
        status: "withdrawn",
        eventId: input.eventId,
        version,
        decisionId,
        withdrawnAt: decidedAt,
        reasonCategory: input.reasonCategory,
      };
    });
  } catch {
    return { status: "denied", code: "withdrawal_failed" };
  }
  // Only after COMMIT: the read model never drops an event for a withdrawal that rolled back.
  if (outcome.status === "withdrawn") PublicReadModel.withdraw(input.eventId);
  return outcome;
}

/**
 * TG-FR12: the corrected proposal. Every field the moderator did not edit is kept from the proposal behind the
 * current version, and each claim keeps its quote, source and evidence. Only claim text changes. The incident id
 * is the event id, so the correction resolves to the same public event. `kind` marks it as a correction.
 */
export function buildCorrectedProposal(
  base: EventProposalDto,
  input: {
    readonly eventId: string;
    readonly proposalId: string;
    readonly proposedAt: string;
    readonly baseVersion: number;
    readonly actorId: string;
    readonly edits: EventCorrectionEdits;
  },
): EventProposalDto {
  const textByClaimId = new Map((input.edits.claims ?? []).map((edit) => [edit.claimId, edit.text] as const));
  const claims = (base.claims ?? []).map((claim, index) => {
    const text = textByClaimId.get(publicClaimIdFor(claim, input.eventId, index));
    return text === undefined ? claim : { ...claim, claim_text: text };
  });
  const eventTime = input.edits.eventTime ?? base.event_time;
  return {
    ...base,
    proposal_id: input.proposalId,
    incident_id: input.eventId,
    proposed_at: input.proposedAt,
    title: input.edits.title ?? base.title,
    primary_category: input.edits.category ?? (base as { primary_category?: string }).primary_category,
    event_time: eventTime,
    location_label: input.edits.locationLabel ?? base.location_label,
    claims,
    kind: "correction",
    base_version: input.baseVersion,
    correction_actor_id: input.actorId,
  } as unknown as EventProposalDto;
}

/**
 * TG-FR12: submits a moderator correction to a published event. The corrected payload is stored as a proposal
 * linked to the event (event_id, base_event_version), in the same transaction as its decision. It then goes through
 * the moderator gate (assessCorrectionGate) and the shared publish core. A refusal is recorded as a rejected
 * decision and an audit record, and publishes nothing. Identical facts return "unchanged" with no new version.
 */
export async function submitEventCorrection(
  dependencies: ProposalDecisionDependencies,
  input: {
    readonly eventId: string;
    readonly baseVersion: number;
    readonly actorId: string;
    readonly edits: EventCorrectionEdits;
    readonly reason?: string | null;
  },
): Promise<CorrectionOutcome> {
  const { executor, datasetKind } = dependencies;
  // A snapshot outside the transaction: it finds the base proposal for the registry check, and stops early for an
  // event that does not exist. The authoritative version check runs again under the event lock.
  const snapshot = await latestEventDecision(executor, datasetKind, input.eventId);
  if (!snapshot) return { status: "refused", code: "event_not_found", reasons: [] };

  const claimIds = (snapshot.proposal.claims ?? []).map((claim, index) => publicClaimIdFor(claim, input.eventId, index));
  for (const edit of input.edits.claims ?? []) {
    if (!claimIds.includes(edit.claimId)) return { status: "invalid", code: "claim_not_found" };
  }

  const proposalId = `corr-${randomUUID()}`;
  const proposedAt = new Date().toISOString();
  const corrected = buildCorrectedProposal(snapshot.proposal, {
    eventId: input.eventId,
    proposalId,
    proposedAt,
    baseVersion: input.baseVersion,
    actorId: input.actorId,
    edits: input.edits,
  });
  const publicDisplaySourceIds = await resolvePublicDisplay(dependencies, corrected);
  const revokedSourceIds = await resolveRevokedSourceIds(executor, corrected);
  const decisionId = `dec-${randomUUID()}`;

  let attempt: PublishAttempt;
  try {
    attempt = await runInTransaction<PublishAttempt>(executor, async (tx) => {
      const origin = await tx.query<{ trace_id: string; candidate_id: string; context_id: string; investigation_id: string | null }>(
        `SELECT trace_id, candidate_id, context_id, investigation_id FROM waspada.event_proposals
         WHERE dataset_kind = $1 AND proposal_id = $2`,
        [datasetKind, snapshot.proposalId],
      );
      const originRow = origin.rows[0];
      if (!originRow) return { outcome: { status: "denied", code: "event_not_found" } };
      await tx.query(
        `INSERT INTO waspada.event_proposals (
           dataset_kind, proposal_id, trace_id, candidate_id, context_id, event_id, base_event_version,
           investigation_id, proposed_at, record_json)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::timestamptz, $10::jsonb)`,
        [
          datasetKind,
          proposalId,
          originRow.trace_id,
          originRow.candidate_id,
          originRow.context_id,
          input.eventId,
          input.baseVersion,
          originRow.investigation_id,
          proposedAt,
          JSON.stringify(corrected),
        ],
      );
      return publishInTransaction(tx, {
        datasetKind,
        proposalId,
        traceId: originRow.trace_id,
        proposal: corrected,
        investigationId: originRow.investigation_id,
        action: "correct",
        actor: { kind: "moderator", actorId: input.actorId },
        reason: input.reason ?? null,
        publicDisplaySourceIds,
        revokedSourceIds,
        decisionId,
        decidedAt: proposedAt,
        baseVersion: input.baseVersion,
      });
    });
  } catch {
    return { status: "refused", code: "publication_failed", reasons: [], proposalId };
  }

  if (attempt.detail) PublicReadModel.publish(attempt.detail);
  const outcome = attempt.outcome;
  if (outcome.status === "published" || outcome.status === "unchanged") {
    return { status: outcome.status, eventId: outcome.eventId, version: outcome.version, proposalId, decisionId: outcome.decisionId };
  }
  if (outcome.status === "denied") {
    return { status: "refused", code: outcome.code as CorrectionRefusalCode, reasons: outcome.reasons ?? [], proposalId };
  }
  return { status: "refused", code: "publication_failed", reasons: [], proposalId };
}

/** HOSTED-26: the gate a location refresh records. It runs no gate of its own: the proposal already passed it for this event. */
const LOCATION_REFRESH_GATE = "location_refresh";
/** HOSTED-26: the fixed audit reason of a location refresh. */
const LOCATION_REFRESH_REASON = "Lokasi peta diperbarui (HOSTED-26)";
/** HOSTED-26: the fixed public update summary. It says what changed, and nothing about the facts. */
const LOCATION_REFRESH_SUMMARY = "Lokasi peta diperbarui.";

/** Why a location refresh wrote no version. Fixed codes only. */
export type LocationRefreshSkipReason =
  | "no_publication"
  | "withdrawn"
  | "nothing_to_add"
  | "publication_failed"
  | "event_changed"
  /** HOSTED-28: a claim's source is no longer approved, so the event gets no new public version. */
  | "source_revoked";

export type LocationRefreshOutcome =
  | { readonly status: "refreshed"; readonly version: number }
  | { readonly status: "skipped"; readonly reason: LocationRefreshSkipReason };

export interface LocationRefreshInput {
  readonly datasetKind: "live";
  readonly eventId: string;
  /** The rights check for the attribution write of the new version. Fail-closed: a throw counts as not permitted. */
  readonly checkPublicDisplay: (sourceId: string) => Promise<boolean>;
  readonly now?: () => Date;
}

/** Ends the refresh transaction without a write. The transaction rolls back, and the caller gets the reason. */
class LocationRefreshSkip extends Error {
  constructor(readonly reason: LocationRefreshSkipReason) {
    super(reason);
    this.name = "LocationRefreshSkip";
  }
}

/** HOSTED-26: the geometry ids in the stored record of one version of an event. */
async function versionGeometryIds(tx: SqlExecutor, datasetKind: string, eventId: string, version: number): Promise<readonly string[]> {
  const row = await tx.query<{ record_json: unknown }>(
    "SELECT record_json FROM waspada.event_versions WHERE dataset_kind = $1 AND event_id = $2 AND version = $3",
    [datasetKind, eventId, version],
  );
  const record = parseJsonObject(row.rows[0]?.record_json);
  const scope = record && isRecordValue(record.scope) ? record.scope : null;
  return scope && Array.isArray(scope.geometry_ids)
    ? scope.geometry_ids.filter((id): id is string => typeof id === "string")
    : [];
}

/**
 * HOSTED-26 (owner decision, 18 Nov 2026): gives a published event its location. It writes one version after the latest
 * one, when that version lacks something the latest proposal now supplies: its one Point (the latest version has no
 * geometry, and the proposal has single-revision support and a coordinate in the box), or the public location label
 * (the latest decision has none, and the proposal names a specific place). Everything else is copied from the proposal
 * and the latest decision. Claims and facts are not re-decided, and no gate runs: the proposal already passed it for this
 * event. The version is recorded as a corrected update with a fixed summary. A withdrawn event is never refreshed.
 *
 * One transaction under the event lock. When nothing would be added, the transaction is ended and rolled back, so no
 * geometry row or version is left behind. The version uses the publication's own write path (writePublishedVersion).
 * After the commit, the in-memory public read model shows the new version. A database error throws, so the caller counts
 * a failure. A refresh of an event that another decision changed meanwhile is skipped (event_changed).
 */
export async function refreshPublishedLocation(
  executor: TransactionalSqlExecutor,
  input: LocationRefreshInput,
): Promise<LocationRefreshOutcome> {
  const { datasetKind, eventId } = input;
  // The registry checks run before the lock, as in decideProposal, so no database lock is held across them.
  const before = await latestEventDecision(executor, datasetKind, eventId);
  if (!before) return { status: "skipped", reason: "no_publication" };
  if (before.disposition === "withdraw") return { status: "skipped", reason: "withdrawn" };
  const publicDisplaySourceIds = await resolvePublicDisplay(
    { executor, datasetKind, checkPublicDisplay: input.checkPublicDisplay },
    before.proposal,
  );
  const decidedAt = (input.now ?? (() => new Date()))().toISOString();
  const decisionId = `dec-${randomUUID()}`;

  let written: { readonly version: number; readonly detail: EventDetail };
  try {
    written = await runInTransaction(executor, async (tx) => {
      await lockEventPublication(tx, datasetKind, eventId);
      const latest = await latestEventDecision(tx, datasetKind, eventId);
      if (!latest) throw new LocationRefreshSkip("no_publication");
      if (latest.disposition === "withdraw") throw new LocationRefreshSkip("withdrawn");
      if (latest.decisionId !== before.decisionId) throw new LocationRefreshSkip("event_changed");
      // HOSTED-28: a new version is a publication, so an event with a revoked claim source is not refreshed. Nothing is withdrawn.
      if ((await resolveRevokedSourceIds(tx, latest.proposal)).size > 0) throw new LocationRefreshSkip("source_revoked");

      const proposal = latest.proposal;
      const version = latest.version + 1;
      // The publication mode and the waivers of the latest decision carry over. No new gate run, so no new waiver.
      const publicationMode = latest.decisionRecord.publication_mode === "agent_auto" ? "agent_auto" : "moderator_reviewed";
      const waivers = Array.isArray(latest.decisionRecord.waivers)
        ? latest.decisionRecord.waivers.filter((waiver): waiver is string => typeof waiver === "string")
        : [];
      const sourceCount = distinctOutlets(proposal);
      let detail: EventDetail;
      try {
        detail = proposalToEventDetail(proposal, undefined, {
          version,
          publication: { mode: publicationMode, source_count: sourceCount, ...(waivers.length > 0 ? { waivers } : {}) },
        });
      } catch {
        throw new LocationRefreshSkip("publication_failed");
      }

      const enrichment = await enrichPublication(tx, { datasetKind, traceId: latest.traceId, eventId, version, category: detail.category, proposal });
      const latestGeometryIds = await versionGeometryIds(tx, datasetKind, eventId, latest.version);
      const locationLabel = publicLocationLabel(proposal.location_label);
      const addsPoint = enrichment.geometryStatus === "point_written" && latestGeometryIds.length === 0;
      const addsLabel = locationLabel !== null && latest.decisionRecord.location_label === undefined;
      if (!addsPoint && !addsLabel) throw new LocationRefreshSkip("nothing_to_add");

      await writePublishedVersion(tx, {
        datasetKind,
        traceId: latest.traceId,
        eventId,
        version,
        proposalId: latest.proposalId,
        decisionId,
        decidedAt,
        actorId: AGENT_AUTO_PUBLISHER_ID,
        proposal,
        detail,
        enrichment,
        publicDisplaySourceIds,
        decisionRecord: {
          disposition: "publish",
          actor_kind: "agent",
          actor_id: AGENT_AUTO_PUBLISHER_ID,
          // Carried over from the latest decision, so the list eligibility of the event does not change.
          location_label_present: latest.decisionRecord.location_label_present === true,
          // HOSTED-26: always written (null for none or a generic label), so the location backfill never re-selects it.
      location_label: locationLabel,
          publication_mode: publicationMode,
          gate: LOCATION_REFRESH_GATE,
          source_count: sourceCount,
          reason: LOCATION_REFRESH_REASON,
          ...(waivers.length > 0 ? { waivers } : {}),
          base_version: latest.version,
          geometry_source: enrichment.geometrySource,
          geometry_status: enrichment.geometryStatus,
        },
        review: { changeType: "corrected", summary: LOCATION_REFRESH_SUMMARY },
      });
      return { version, detail };
    });
  } catch (error) {
    if (error instanceof LocationRefreshSkip) return { status: "skipped", reason: error.reason };
    throw error;
  }
  // Only after COMMIT: the in-memory public read model never shows a version that rolled back.
  PublicReadModel.publish(written.detail);
  return { status: "refreshed", version: written.version };
}

export interface ExpireStaleProposalsInput {
  readonly executor: SqlExecutor;
  readonly writer: EventProposalWriter;
  readonly datasetKind: "live" | "historical" | "synthetic";
  readonly now: Date | string;
  /** Integer 1..720. Validate upstream with parseProposalReviewTtlHours. */
  readonly ttlHours: number;
  /** Clamped to 1..50 by the writer. Default 50. */
  readonly limit?: number;
}

export interface ExpireStaleProposalsResult {
  readonly expired: number;
  readonly skipped_already_decided: number;
  /** A candidate whose decision row could not be written. The next cycle retries it. */
  readonly failed: number;
}

/**
 * REVIEW-EXPIRY-01 (ADR-062): marks undecided proposals older than the review TTL as expired.
 * Each expiry is one publication_decisions row with disposition "expire". It never publishes, never
 * writes event versions or claims, and never touches PublicReadModel or incidents. An expired
 * proposal is not resolution or a safety claim. A later moderator publish or reject is refused
 * as already_decided.
 */
export async function expireStaleProposals(input: ExpireStaleProposalsInput): Promise<ExpireStaleProposalsResult> {
  if (!isValidProposalReviewTtlHours(input.ttlHours)) {
    throw new TypeError("ttlHours must be an integer from 1 to 720");
  }
  const nowMs = input.now instanceof Date ? input.now.getTime() : Date.parse(input.now);
  if (!Number.isFinite(nowMs)) {
    throw new TypeError("now must be a valid instant");
  }
  const expiredAt = new Date(nowMs).toISOString();
  const cutoff = new Date(nowMs - input.ttlHours * 3_600_000).toISOString();

  const candidates = await input.writer.readExpirableProposals({
    datasetKind: input.datasetKind,
    cutoff,
    limit: input.limit ?? 50,
  });

  let expired = 0;
  let skippedAlreadyDecided = 0;
  let failed = 0;
  for (const candidate of candidates) {
    try {
      if (await latestDisposition(input.executor, input.datasetKind, candidate.proposal_id)) {
        skippedAlreadyDecided += 1;
        continue;
      }
      const trace = await input.executor.query<{ trace_id: string }>(
        `SELECT trace_id FROM waspada.event_proposals
         WHERE dataset_kind = $1 AND proposal_id = $2`,
        [input.datasetKind, candidate.proposal_id],
      );
      const traceId = trace.rows[0]?.trace_id;
      if (!traceId) {
        failed += 1;
        continue;
      }
      await insertUnpublishedDecision(input.executor, {
        datasetKind: input.datasetKind,
        decisionId: `dec-${randomUUID()}`,
        traceId,
        proposalId: candidate.proposal_id,
        reviewerId: AGENT_REVIEW_EXPIRY_ID,
        decidedAt: expiredAt,
        record: {
          disposition: "expire",
          actor_kind: "agent",
          actor_id: AGENT_REVIEW_EXPIRY_ID,
          reason: REVIEW_TTL_ELAPSED_REASON,
          ttl_hours: input.ttlHours,
          proposed_at: candidate.proposed_at,
          expired_at: expiredAt,
        },
      });
      expired += 1;
    } catch {
      // Count only. Driver errors can echo SQL parameters, so the message is not logged.
      failed += 1;
    }
  }
  return { expired, skipped_already_decided: skippedAlreadyDecided, failed };
}
