// HOSTED-24B: per-source fetch health for waspada.source_registry, written once after each poll cycle.
// Only a source that the cycle actually tried to fetch is written. A source refused before any request
// (source_not_cleared, or a PetaBencana/BMKG lease skip) keeps its row, because last_checked_at means that
// the feed was checked. One parameterised UPDATE per source. Never an INSERT. A failed write is counted and
// dropped, so it never fails the run. Log text carries counts and fixed codes only: never source ids, URLs,
// keys or error messages.
import type { SqlExecutor } from "../../apps/db/src/sql.js";

/** What one poll cycle learned about one source. `not_fetched` means the source was refused before any request. */
export type SourceFetchOutcome = "ok" | "failed" | "not_fetched";

export interface SourceFetchResult {
  readonly sourceId: string;
  readonly outcome: SourceFetchOutcome;
}

export interface SourceHealthSummary {
  /** Sources whose fetch succeeded this cycle. */
  readonly ok: number;
  /** Sources whose fetch failed this cycle. */
  readonly failed: number;
  /** Sources refused before any request. Their rows are not written. */
  readonly notFetched: number;
  /** Writes that threw. Counted only: the error is dropped and the remaining sources are still written. */
  readonly writeFailed: number;
}

/** Set by pollFeed (apps/worker/src/runtime/news-poll-runtime.ts) when triage authorization denies acquisition. No request is sent. */
const SOURCE_NOT_CLEARED_ERROR = "source_not_cleared";

/**
 * health_status values are the CHECK set from migration 001: unknown, healthy, degraded and unavailable. A
 * successful fetch is `healthy`. A failed fetch is `degraded`, because the next cycle retries the source and the
 * failure is not yet terminal. `unavailable` stays reserved for the acquisition queue's terminal failures
 * (apps/db/src/queue.ts). There is no `failed` value in the CHECK.
 *
 * The guard keeps an older clock value from overwriting a newer check. It matches the acquisition queue's writes
 * (apps/db/src/queue.ts). Both statements touch only the columns that the L1 pipeline role is granted.
 */
const SUCCESS_SQL = `UPDATE waspada.source_registry
   SET health_status = 'healthy', last_checked_at = $2::timestamptz, last_success_at = $2::timestamptz
 WHERE source_id = $1 AND (last_checked_at IS NULL OR last_checked_at <= $2::timestamptz)`;
const FAILURE_SQL = `UPDATE waspada.source_registry
   SET health_status = 'degraded', last_checked_at = $2::timestamptz
 WHERE source_id = $1 AND (last_checked_at IS NULL OR last_checked_at <= $2::timestamptz)`;

/**
 * An RSS feed result from pollFeed. A non-success status is a failed fetch: fetch_error, timeout or parse_error,
 * including a blocked redirect. A success with source_not_cleared is refused before any request.
 */
export function rssFetchOutcome(poll: { readonly status: string; readonly error?: string }): SourceFetchOutcome {
  if (poll.status !== "success") return "failed";
  return poll.error === SOURCE_NOT_CLEARED_ERROR ? "not_fetched" : "ok";
}

/**
 * A PetaBencana or BMKG poll outcome. An empty result is still a successful fetch. A lease skip means another
 * slot is polling, so this cycle sent no request. An unknown value fails closed.
 */
export function structuredFetchOutcome(outcome: string): SourceFetchOutcome {
  if (outcome === "success" || outcome === "empty") return "ok";
  if (outcome === "skipped") return "not_fetched";
  return "failed";
}

/**
 * Writes one row per attempted source, in the order given. Skipped sources are counted and not written. A write
 * that throws is counted under writeFailed, and the loop continues. This function never throws from a write.
 * The clock is read once, so every row in the cycle carries the same timestamp.
 */
export async function recordSourceHealth(
  executor: Pick<SqlExecutor, "query">,
  results: readonly SourceFetchResult[],
  clock: () => Date = () => new Date(),
): Promise<SourceHealthSummary> {
  const at = clock().toISOString();
  let ok = 0;
  let failed = 0;
  let notFetched = 0;
  let writeFailed = 0;
  for (const result of results) {
    if (result.outcome === "not_fetched") {
      notFetched += 1;
      continue;
    }
    const succeeded = result.outcome === "ok";
    if (succeeded) ok += 1;
    else failed += 1;
    try {
      await executor.query(succeeded ? SUCCESS_SQL : FAILURE_SQL, [result.sourceId, at]);
    } catch {
      writeFailed += 1;
    }
  }
  return { ok, failed, notFetched, writeFailed };
}

/**
 * Count-only log lines. `tag` is the log prefix, for example "[Once] Source health". The write-failure line
 * is printed only when a write failed, and carries a count, never an error message.
 */
export function formatSourceHealthLines(summary: SourceHealthSummary, tag: string): string[] {
  const lines = [`${tag}: ok=${summary.ok} failed=${summary.failed} not_fetched=${summary.notFetched}`];
  if (summary.writeFailed > 0) lines.push(`${tag}: write_failed count=${summary.writeFailed}`);
  return lines;
}
