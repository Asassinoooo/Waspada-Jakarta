/**
 * REVIEW-EXPIRY-01 (ADR-062): the Worker's scheduled expiry sweep. It runs only when DATASET_MODE is
 * exactly "live" and a database source is configured. Demo mode and a missing database are no-ops.
 * DATASET_MODE is read without a default, so an unset value never turns the sweep on.
 */
import type { SqlExecutor } from "../../../db/src/sql.js";
import { createEventProposalWriter } from "../../../db/src/event-proposal-writer.js";
import { expireStaleProposals, type ExpireStaleProposalsResult } from "../layers/l4-application-integration/proposal-publication.js";
import { parseProposalReviewTtlHours } from "../layers/l4-application-integration/publication-policy.js";

export interface ReviewExpiryEnvironment {
  readonly DATASET_MODE?: string;
  readonly PROPOSAL_REVIEW_TTL_HOURS?: string;
  readonly SQL_EXECUTOR?: unknown;
  readonly HYPERDRIVE?: { readonly connectionString?: string };
}

export type ReviewExpiryOutcome =
  | { readonly ran: false; readonly reason: "not_live" | "no_database" }
  | ({ readonly ran: true; readonly ttl_hours: number } & ExpireStaleProposalsResult);

export async function runScheduledReviewExpiry(input: {
  readonly env: ReviewExpiryEnvironment;
  readonly now: Date;
  readonly withSqlExecutor: <Result>(operation: (executor: SqlExecutor) => Promise<Result>) => Promise<Result>;
}): Promise<ReviewExpiryOutcome> {
  if (input.env.DATASET_MODE !== "live") return { ran: false, reason: "not_live" };
  if (!(input.env.SQL_EXECUTOR || input.env.HYPERDRIVE?.connectionString)) {
    return { ran: false, reason: "no_database" };
  }
  const ttlHours = parseProposalReviewTtlHours(input.env.PROPOSAL_REVIEW_TTL_HOURS);
  const result = await input.withSqlExecutor((executor) => expireStaleProposals({
    executor,
    writer: createEventProposalWriter(executor),
    datasetKind: "live",
    now: input.now,
    ttlHours,
  }));
  return { ran: true, ttl_hours: ttlHours, ...result };
}
