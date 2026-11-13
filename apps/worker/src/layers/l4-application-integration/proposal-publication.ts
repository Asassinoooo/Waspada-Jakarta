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
import type { SqlExecutor } from "../../../../db/src/sql.js";
import type { EventProposalWriter } from "../../../../db/src/event-proposal-writer.js";
import type { EventProposalDto } from "./moderation-api.js";
import {
  PublicReadModel,
  proposalToEventDetail,
  publicClaimIdFor,
  publicEventIdForProposal,
} from "./public-read-model.js";
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

/** Distinct publishers across claims: the registry source, or the outlet when there is none. */
export function distinctPublishers(proposal: EventProposalDto): number {
  const publishers = new Set<string>();
  for (const claim of proposal.claims ?? []) {
    const key = claim.source_id || claim.outlet || null;
    if (key) publishers.add(key);
  }
  return publishers.size;
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
    record_json: unknown;
  }>(
    `SELECT decision.decision_id, decision.event_version, decision.proposal_id, decision.trace_id,
            decision.record_json->>'disposition' AS disposition, proposal.record_json
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
  readonly decisionId: string;
  readonly decidedAt: string;
  /** TG-FR12: the version a correction was made from. A correction publishes only over that version. */
  readonly baseVersion?: number;
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
  const gateOptions = { publicDisplaySourceIds: core.publicDisplaySourceIds, linkedInvestigationStatus };

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
  const sourceCount = distinctPublishers(proposal);

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

  await tx.query(
    `INSERT INTO waspada.publication_decisions (
       dataset_kind, decision_id, trace_id, proposal_id, policy_version,
       event_id, event_version, reviewer_id, decided_at, record_json)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::timestamptz, $10::jsonb)`,
    [
      datasetKind,
      decisionId,
      traceId,
      proposalId,
      PUBLICATION_POLICY_VERSION,
      eventId,
      version,
      actor.actorId,
      decidedAt,
      JSON.stringify({
        disposition: "publish",
        ...actorRecord,
        publication_mode: publicationMode,
        gate: action === "auto_publish"
          ? "agent_auto_publication"
          : action === "correct" ? "moderator_correction" : "moderator_review",
        source_count: sourceCount,
        reason: core.reason,
        ...(waivers.length > 0 ? { waivers } : {}),
        ...(action === "correct" ? { base_version: core.baseVersion ?? null } : {}),
      }),
    ],
  );
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
      version > 1 ? version - 1 : null,
      detail.title,
      detail.summary.length > 0 ? detail.summary : detail.title,
      detail.category,
      detail.lifecycle,
      decisionId,
      decidedAt,
      JSON.stringify({ claims: detail.claims, impact_refs: [], publication_mode: publicationMode }),
    ],
  );
  for (const claim of detail.claims) {
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
      const tombstone = {
        schema_version: "2.0",
        record_type: "Event",
        dataset_kind: datasetKind,
        trace_id: latest.traceId,
        event_id: input.eventId,
        version,
        supersedes_version: latest.version,
        title: published.title,
        summary: published.summary,
        category: published.category,
        lifecycle: published.lifecycle,
        claims: [],
        impact_refs: [],
        publication_status: "withdrawn",
        withdrawal_reason: input.reasonCategory,
        publication_decision_id: decisionId,
        published_at: null,
        withdrawn_at: decidedAt,
      };
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
