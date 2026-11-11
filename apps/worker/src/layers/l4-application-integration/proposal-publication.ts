/**
 * MERGE-REVIEW-01 (ADR-061): the one writer for proposal decisions. The agent auto-publisher and
 * moderators both call decideProposal, so they share one gate, one audit row and one public
 * projection. A decision is recorded as a publication_decisions row. event_proposals is append-only,
 * so the decision is never written onto the proposal.
 */
import { randomUUID } from "node:crypto";
import type { SqlExecutor } from "../../../../db/src/sql.js";
import type { EventProposalDto } from "./moderation-api.js";
import { PublicReadModel, proposalToEventDetail, publicEventIdForProposal } from "./public-read-model.js";
import {
  assessAutoPublication,
  assessProposalSourceGate,
  type ProposalGateReason,
} from "./publication-policy.js";

export const AGENT_AUTO_PUBLISHER_ID = "agent:auto-publisher";
export const PUBLICATION_POLICY_VERSION = "merge-review-v1";

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
 * - auto_publish: runs assessAutoPublication. A failing check queues the proposal for a moderator.
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

  const prior = await executor.query<{ disposition: string | null }>(
    `SELECT record_json->>'disposition' AS disposition
     FROM waspada.publication_decisions
     WHERE dataset_kind = $1 AND proposal_id = $2
     ORDER BY decided_at DESC, decision_id DESC
     LIMIT 1`,
    [datasetKind, input.proposalId],
  );
  if (prior.rows.length > 0) {
    return { status: "already_decided", disposition: prior.rows[0]!.disposition ?? "unknown" };
  }

  const decidedAt = new Date().toISOString();
  const decisionId = `dec-${randomUUID()}`;
  const actorRecord = { actor_kind: input.actor.kind, actor_id: input.actor.actorId };

  if (input.action === "reject") {
    await executor.query(
      `INSERT INTO waspada.publication_decisions (
         dataset_kind, decision_id, trace_id, proposal_id, policy_version,
         event_id, event_version, reviewer_id, decided_at, record_json)
       VALUES ($1, $2, $3, $4, $5, NULL, NULL, $6, $7::timestamptz, $8::jsonb)`,
      [
        datasetKind,
        decisionId,
        row.trace_id,
        input.proposalId,
        PUBLICATION_POLICY_VERSION,
        input.actor.actorId,
        decidedAt,
        JSON.stringify({ disposition: "reject", ...actorRecord, reason: input.reason ?? null }),
      ],
    );
    return { status: "rejected", decisionId };
  }

  const publicDisplaySourceIds = await resolvePublicDisplay(dependencies, proposal);
  const gateOptions = { publicDisplaySourceIds };

  if (input.action === "auto_publish") {
    const reasons = assessAutoPublication(proposal, gateOptions);
    if (reasons.length > 0) return { status: "queued", reasons };
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
      publication: { mode: publicationMode, source_count: sourceCount },
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
