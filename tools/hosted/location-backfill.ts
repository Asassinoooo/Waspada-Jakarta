// HOSTED-26: the location backfill for published live events (owner decision, 18 Nov 2026). An event published before the
// point writer (migration 054) recorded "pending_geometry_writer" and has no geometry. An event published before the label
// was stored (migration 055) has a decision that says a label was present, but no label text. This module finds the live
// events whose latest decision publishes and has one of those gaps, and gives each to refreshPublishedLocation, which
// writes one new version when the proposal can fill the gap. It runs no gate, changes no claim and edits no row. The
// result holds counts only: no event id, title, label, URL or error text is returned or logged.
import type { TransactionalSqlExecutor } from "../../apps/db/src/sql.js";
import {
  refreshPublishedLocation,
  type LocationRefreshInput,
  type LocationRefreshOutcome,
} from "../../apps/worker/src/layers/l4-application-integration/proposal-publication.js";
import type { LocationBackfillResult } from "./ingest-once.js";

/** HOSTED-26: at most this many events are attempted in one run. The next run takes the rest. */
export const LOCATION_BACKFILL_LIMIT = 100;
/** HOSTED-26: the run stops after this many events in a row threw (for example a dropped connection). */
export const LOCATION_BACKFILL_MAX_CONSECUTIVE_FAILURES = 3;

/** The refresh one event runs through. The publication's own refreshPublishedLocation by default. */
export type LocationRefresh = (executor: TransactionalSqlExecutor, input: LocationRefreshInput) => Promise<LocationRefreshOutcome>;

export interface LocationBackfillDeps {
  readonly executor: TransactionalSqlExecutor;
  /** The rights check for the attribution write of each new version. Fail-closed: a throw counts as not permitted. */
  readonly checkPublicDisplay: (sourceId: string) => Promise<boolean>;
  /** No new event is attempted at or after this instant. */
  readonly deadlineMs: number;
  readonly now: () => number;
  readonly limit?: number;
  readonly maxConsecutiveFailures?: number;
  /** Injected by tests. Production uses refreshPublishedLocation. */
  readonly refresh?: LocationRefresh;
}

/**
 * The live events whose latest decision is a publication and still lacks a location the publication can now give: the
 * geometry was never written (pending_geometry_writer), or the decision says a label was present but stores none. The
 * latest decision is the one with the highest event version. Oldest publication first, at most `limit` events.
 */
export const LOCATION_CANDIDATE_SQL = `
  WITH latest AS (
    SELECT DISTINCT ON (decision.event_id)
           decision.event_id, decision.decided_at, decision.record_json
    FROM waspada.publication_decisions AS decision
    WHERE decision.dataset_kind = 'live'
      AND decision.event_id IS NOT NULL
      AND decision.record_json->>'disposition' IN ('publish', 'withdraw')
    ORDER BY decision.event_id, decision.event_version DESC
  )
  SELECT latest.event_id
  FROM latest
  WHERE latest.record_json->>'disposition' = 'publish'
    AND (
      NOT (latest.record_json ? 'location_label')
      AND (latest.record_json->>'geometry_status' = 'pending_geometry_writer'
        OR latest.record_json->>'location_label_present' = 'true')
    )
  ORDER BY latest.decided_at ASC, latest.event_id ASC
  LIMIT $1`;

interface CandidateRow {
  readonly event_id: string;
}

/**
 * HOSTED-26: runs the backfill once. Oldest publications first, at most `limit` events, each checked against the budget
 * before it starts. An event whose refresh throws is counted as failed, its transaction is rolled back, and the run goes
 * on. A failed candidate query returns a failed count of one, so the caller's run goes on. Counts only.
 */
export async function backfillPublishedLocations(deps: LocationBackfillDeps): Promise<LocationBackfillResult> {
  const limit = deps.limit ?? LOCATION_BACKFILL_LIMIT;
  const maxFailures = deps.maxConsecutiveFailures ?? LOCATION_BACKFILL_MAX_CONSECUTIVE_FAILURES;
  const refresh: LocationRefresh = deps.refresh ?? refreshPublishedLocation;
  let candidates: readonly CandidateRow[];
  try {
    candidates = (await deps.executor.query<CandidateRow>(LOCATION_CANDIDATE_SQL, [limit])).rows;
  } catch {
    return { candidates: 0, refreshed: 0, skipped: 0, failed: 1 };
  }
  let refreshed = 0;
  let skipped = 0;
  let failed = 0;
  let streak = 0;
  for (const candidate of candidates) {
    if (deps.now() >= deps.deadlineMs || streak >= maxFailures) break;
    try {
      const outcome = await refresh(deps.executor, {
        datasetKind: "live",
        eventId: candidate.event_id,
        checkPublicDisplay: deps.checkPublicDisplay,
      });
      streak = 0;
      if (outcome.status === "refreshed") refreshed += 1;
      else skipped += 1;
    } catch {
      failed += 1;
      streak += 1;
    }
  }
  return { candidates: refreshed + skipped + failed, refreshed, skipped, failed };
}
