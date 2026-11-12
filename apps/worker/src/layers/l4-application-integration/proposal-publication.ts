/**
 * MERGE-REVIEW-01 (ADR-061): the one writer for proposal decisions. The agent auto-publisher and
 * moderators both call decideProposal, so they share one gate, one audit row and one public
 * projection. A decision is recorded as a publication_decisions row. event_proposals is append-only,
 * so the decision is never written onto the proposal.
 */
import { randomUUID } from "node:crypto";
import type { SqlExecutor } from "../../../../db/src/sql.js";
import type { EventProposalWriter } from "../../../../db/src/event-proposal-writer.js";
import type { EventProposalDto } from "./moderation-api.js";
import { PublicReadModel, proposalToEventDetail, publicEventIdForProposal } from "./public-read-model.js";
import {
  assessProposalSourceGate,
  evaluateAutoPublication,
  isValidProposalReviewTtlHours,
  type AutoPublicationWaiver,
  type AutoPublishSourcePermission,
  type ProposalGateReason,
} from "./publication-policy.js";

export const AGENT_AUTO_PUBLISHER_ID = "agent:auto-publisher";
export const PUBLICATION_POLICY_VERSION = "merge-review-v1";
/** REVIEW-EXPIRY-01 (ADR-062): the sweep's actor. It records a decision and never publishes. */
export const AGENT_REVIEW_EXPIRY_ID = "agent:review-expiry";
export const REVIEW_TTL_ELAPSED_REASON = "review_ttl_elapsed";

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

export type ProposalDecisionOutcome =
  | {
    readonly status: "published";
    readonly decisionId: string;
    readonly eventId: string;
    readonly version: number;
    readonly publicationMode: "agent_auto" | "moderator_reviewed";
  }
  | { readonly status: "rejected"; readonly decisionId: string }
  | { readonly status: "queued"; readonly reasons: readonly ProposalGateReason[] }
  | {
    readonly status: "denied";
    readonly code: "proposal_not_found" | "publication_not_authorized" | "publication_failed";
    readonly reasons?: readonly ProposalGateReason[];
  }
  | { readonly status: "already_decided"; readonly disposition: string };

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
 * Writes a decision that publishes nothing: a reject or an expiry. publication_decisions is
 * append-only, so this is the only write. event_id and event_version stay NULL.
 * ADR-061 note: publication_decisions has no unique index on (dataset_kind, proposal_id). Two
 * decisions racing for the same proposal can both insert. That race is accepted, as in ADR-061.
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

/** Distinct publishers across claims: the registry source, or the outlet when there is none. */
export function distinctPublishers(proposal: EventProposalDto): number {
  const publishers = new Set<string>();
  for (const claim of proposal.claims ?? []) {
    const key = claim.source_id || claim.outlet || null;
    if (key) publishers.add(key);
  }
  return publishers.size;
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
 * Applies one decision to one proposal.
 * - auto_publish: runs evaluateAutoPublication. A failing check queues the proposal for a moderator.
 *   `sourcePermission: "local_relaxed"` (local live mode only, ADR-061 amendment) skips only the
 *   public-display permission check, and the waiver is recorded on the decision and the public version.
 * - publish: a moderator decision. It runs the source gate (schema, links, rights) and does not
 *   require a clean discrepancy status, because the moderator has reviewed it.
 * - reject: records a rejection and never publishes.
 * A proposal that already has a decision is never decided again.
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
  const rows = await executor.query<{ trace_id: string; record_json: unknown }>(
    `SELECT trace_id, record_json FROM waspada.event_proposals
     WHERE dataset_kind = $1 AND proposal_id = $2`,
    [datasetKind, input.proposalId],
  );
  const row = rows.rows[0];
  if (!row) return { status: "denied", code: "proposal_not_found" };
  const proposal = parseProposal(row.record_json);

  const prior = await latestDisposition(executor, datasetKind, input.proposalId);
  if (prior) {
    return { status: "already_decided", disposition: prior.disposition };
  }

  const decidedAt = new Date().toISOString();
  const decisionId = `dec-${randomUUID()}`;
  const actorRecord = { actor_kind: input.actor.kind, actor_id: input.actor.actorId };

  if (input.action === "reject") {
    await insertUnpublishedDecision(executor, {
      datasetKind,
      decisionId,
      traceId: row.trace_id,
      proposalId: input.proposalId,
      reviewerId: input.actor.actorId,
      decidedAt,
      record: { disposition: "reject", ...actorRecord, reason: input.reason ?? null },
    });
    return { status: "rejected", decisionId };
  }

  const publicDisplaySourceIds = await resolvePublicDisplay(dependencies, proposal);
  const gateOptions = { publicDisplaySourceIds };

  let waivers: readonly AutoPublicationWaiver[] = [];
  if (input.action === "auto_publish") {
    const assessment = evaluateAutoPublication(proposal, { ...gateOptions, sourcePermission: input.sourcePermission });
    if (assessment.reasons.length > 0) return { status: "queued", reasons: assessment.reasons };
    waivers = assessment.waivers;
  } else {
    const reasons = assessProposalSourceGate(proposal, gateOptions);
    if (reasons.length > 0) return { status: "denied", code: "publication_not_authorized", reasons };
  }

  const eventId = publicEventIdForProposal(proposal);
  const priorPublished = await executor.query<{ count: number }>(
    `SELECT COUNT(*)::int AS count FROM waspada.publication_decisions
     WHERE dataset_kind = $1 AND event_id = $2 AND record_json->>'disposition' = 'publish'`,
    [datasetKind, eventId],
  );
  const version = (priorPublished.rows[0]?.count ?? 0) + 1;
  const publicationMode = input.actor.kind === "agent" ? "agent_auto" : "moderator_reviewed";
  const sourceCount = distinctPublishers(proposal);

  // Build the public version first. Invalid data then fails before any decision is written.
  let detail;
  try {
    detail = proposalToEventDetail(proposal, undefined, {
      version,
      publication: { mode: publicationMode, source_count: sourceCount, ...(waivers.length > 0 ? { waivers } : {}) },
    });
  } catch {
    return { status: "denied", code: "publication_failed" };
  }

  // The decision, the published version and its claims are one transaction. The decision and the
  // version reference each other through deferred foreign keys, so they commit together or not at all.
  try {
    await runInTransaction(executor, async (tx) => {
      await tx.query(
        `INSERT INTO waspada.publication_decisions (
           dataset_kind, decision_id, trace_id, proposal_id, policy_version,
           event_id, event_version, reviewer_id, decided_at, record_json)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::timestamptz, $10::jsonb)`,
        [
          datasetKind,
          decisionId,
          row.trace_id,
          input.proposalId,
          PUBLICATION_POLICY_VERSION,
          eventId,
          version,
          input.actor.actorId,
          decidedAt,
          JSON.stringify({
            disposition: "publish",
            ...actorRecord,
            publication_mode: publicationMode,
            gate: input.action === "auto_publish" ? "agent_auto_publication" : "moderator_review",
            source_count: sourceCount,
            reason: input.reason ?? null,
            ...(waivers.length > 0 ? { waivers } : {}),
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
          row.trace_id,
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
    });
  } catch {
    return { status: "denied", code: "publication_failed" };
  }

  PublicReadModel.publish(detail);
  return { status: "published", decisionId, eventId, version, publicationMode };
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
