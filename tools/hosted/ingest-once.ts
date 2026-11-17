// HOSTED-13: pure decisions for the scheduled one-cycle hosted ingest (`serve:hosted-ingest:once`).
// Flag parsing, the time budget and the AI-job drain loop. Dependencies are injected, so the drain is
// tested with fakes. No database and no network at import time. Log text carries counts, stop reasons and
// fixed codes only: never URLs, keys, prompts, job text or raw error messages.
import type { SqlExecutor } from "../../apps/db/src/sql.js";
import { safeErrorLabel } from "../live-source-coverage.js";

export const DEFAULT_INGEST_TIME_BUDGET_MINUTES = 20;
export const MIN_INGEST_TIME_BUDGET_MINUTES = 1;
/** Upper bound: setup, the poll cycle, one in-flight job and the freshness pass must fit in the 30-minute workflow timeout. */
export const MAX_INGEST_TIME_BUDGET_MINUTES = 25;
/** The drain stops after this many jobs in a row that did not complete (failed, deferred or lost the lease). */
export const DRAIN_MAX_CONSECUTIVE_NOT_COMPLETED = 3;

export interface RunFlags {
  readonly headless: boolean;
  readonly once: boolean;
  /** Set for an unsupported combination. Fixed text. The caller prints it and exits 1. */
  readonly error?: string;
}

/** `--once` is valid only with `--headless`. Without it the process would open the local PGlite server. */
export function parseRunFlags(argv: readonly string[]): RunFlags {
  const headless = argv.includes("--headless");
  const once = argv.includes("--once");
  if (once && !headless) {
    return {
      headless,
      once,
      error: "--once runs only with --headless (the hosted database). Use npm run serve:hosted-ingest:once.",
    };
  }
  return { headless, once };
}

export interface IngestTimeBudget {
  readonly budgetMs: number;
  /** True when INGEST_TIME_BUDGET_MINUTES was set but not an integer from 1 to 25. The raw value is never echoed. */
  readonly invalid: boolean;
}

/** Reads INGEST_TIME_BUDGET_MINUTES. An unset, empty or invalid value falls back to the 20-minute default. */
export function resolveIngestTimeBudget(raw: string | undefined): IngestTimeBudget {
  const defaultMs = DEFAULT_INGEST_TIME_BUDGET_MINUTES * 60_000;
  const trimmed = raw?.trim() ?? "";
  if (trimmed === "") return { budgetMs: defaultMs, invalid: false };
  const minutes = /^\d+$/u.test(trimmed) ? Number(trimmed) : Number.NaN;
  if (!Number.isSafeInteger(minutes) || minutes < MIN_INGEST_TIME_BUDGET_MINUTES || minutes > MAX_INGEST_TIME_BUDGET_MINUTES) {
    return { budgetMs: defaultMs, invalid: true };
  }
  return { budgetMs: minutes * 60_000, invalid: false };
}

/**
 * The drain starts no new job at or after this instant. The clock starts when the run starts (before the
 * coverage guard), so the poll cycle and setup use up the same budget as the drain.
 */
export function drainDeadlineMs(runStartMs: number, budgetMs: number): number {
  return runStartMs + budgetMs;
}

export function isTimeBudgetExhausted(nowMs: number, deadlineMs: number): boolean {
  return nowMs >= deadlineMs;
}

export type DrainStop = "budget" | "empty" | "consecutive_not_completed";

export interface DrainDeps {
  readonly deadlineMs: number;
  readonly now: () => number;
  /** Read-only. True when the claim predicate would find a job right now. */
  readonly hasClaimableJob: () => Promise<boolean>;
  /** One claim-and-process step. True: the job completed. False: it failed, was deferred or lost its lease. */
  readonly processNextJob: () => Promise<boolean>;
  readonly maxConsecutiveNotCompleted?: number;
}

export interface DrainResult {
  readonly completed: number;
  readonly notCompleted: number;
  readonly stop: DrainStop;
}

/**
 * Drains the live AI queue for one run. The claim and the lease stay in the runner, so no job is processed
 * twice. The budget is checked before each claim, so the drain never starts work after the deadline. The
 * `false` from processNextJob is ambiguous (no job, or a failed job), so the claimable check decides "empty".
 * A thrown error is not caught here: it means the database is unavailable, and the caller treats it as fatal.
 */
export async function drainAiJobs(deps: DrainDeps): Promise<DrainResult> {
  const limit = deps.maxConsecutiveNotCompleted ?? DRAIN_MAX_CONSECUTIVE_NOT_COMPLETED;
  let completed = 0;
  let notCompleted = 0;
  let streak = 0;
  for (;;) {
    if (isTimeBudgetExhausted(deps.now(), deps.deadlineMs)) return { completed, notCompleted, stop: "budget" };
    if (streak >= limit) return { completed, notCompleted, stop: "consecutive_not_completed" };
    if (!(await deps.hasClaimableJob())) return { completed, notCompleted, stop: "empty" };
    if (await deps.processNextJob()) {
      completed += 1;
      streak = 0;
    } else {
      notCompleted += 1;
      streak += 1;
    }
  }
}

/**
 * Read-only mirror of the claim predicate in apps/db (claimAiJob). Only the runner's claim takes a lease;
 * this check just decides whether the drain should stop.
 */
export async function hasClaimableAiJob(
  executor: Pick<SqlExecutor, "query">,
  datasetKind: string,
  nowIso: string,
): Promise<boolean> {
  const result = await executor.query<{ found: number }>(
    `SELECT 1 AS found
       FROM waspada.ai_jobs
      WHERE dataset_kind = $2
        AND ((status IN ('pending', 'retry') AND available_at <= $1)
          OR (status = 'leased' AND lease_expires_at < $1))
      LIMIT 1`,
    [nowIso, datasetKind],
  );
  return result.rows.length > 0;
}

/** HOSTED-20: the publication sweep reads at most this many undecided proposals per run, newest first. */
export const PUBLICATION_SWEEP_LIMIT = 200;
/** The sweep stops after this many decisions in a row that threw (for example a dropped connection). */
export const PUBLICATION_SWEEP_MAX_CONSECUTIVE_FAILURES = 3;
/** At most this much of the budget is kept back from the drain for the sweep. */
export const PUBLICATION_SWEEP_RESERVE_MAX_MS = 3 * 60_000;

/**
 * The share of the run budget the drain leaves for the publication sweep: a quarter of the budget, capped at
 * three minutes. The drain then stops early, so a long AI backlog cannot starve the publication step.
 */
export function publicationSweepReserveMs(budgetMs: number): number {
  return Math.min(PUBLICATION_SWEEP_RESERVE_MAX_MS, Math.floor(budgetMs / 4));
}

/**
 * Undecided proposals for one dataset, newest first. A publication decision of any disposition counts as
 * decided, so proposals that the expiry sweep or a moderator already closed are not listed again.
 */
export async function listUndecidedProposalIds(
  executor: Pick<SqlExecutor, "query">,
  datasetKind: string,
  limit: number,
): Promise<string[]> {
  const result = await executor.query<{ proposal_id: string }>(
    `SELECT ep.proposal_id
       FROM waspada.event_proposals ep
      WHERE ep.dataset_kind = $1
        AND NOT EXISTS (
          SELECT 1 FROM waspada.publication_decisions pd
           WHERE pd.dataset_kind = ep.dataset_kind AND pd.proposal_id = ep.proposal_id
        )
      ORDER BY ep.proposed_at DESC, ep.proposal_id DESC
      LIMIT $2`,
    [datasetKind, limit],
  );
  return result.rows.map((row) => row.proposal_id);
}

/**
 * The fields of a decideProposal outcome that the sweep reads. Structural on purpose, so this module does not
 * import the Worker's publication types. Reasons and codes are fixed gate or refusal codes, never message text.
 */
export interface SweepDecision {
  readonly status: string;
  readonly reasons?: readonly string[];
  readonly code?: string;
}

export interface PublicationSweepDeps {
  readonly listUndecided: (limit: number) => Promise<readonly string[]>;
  /** Runs the gate and decideProposal for one proposal. A throw is counted as failed, never logged. */
  readonly decide: (proposalId: string) => Promise<SweepDecision>;
  readonly deadlineMs: number;
  readonly now: () => number;
  readonly limit?: number;
  readonly maxConsecutiveFailures?: number;
}

export type PublicationSweepStop = "done" | "limit" | "budget" | "consecutive_failed";

export interface PublicationSweepResult {
  /** Proposals the sweep tried, including the ones that threw. */
  readonly assessed: number;
  readonly published: number;
  readonly unchanged: number;
  /** The gate queued the proposal for a moderator. No decision row is written for a hold. */
  readonly held: number;
  readonly denied: number;
  /** Already decided by the moment of the call, for example by the job notification that ran first. */
  readonly skipped: number;
  readonly failed: number;
  readonly heldReasons: Readonly<Record<string, number>>;
  readonly deniedCodes: Readonly<Record<string, number>>;
  /** Labels of thrown errors: an error code or a class name. Never a message. */
  readonly failedCodes: Readonly<Record<string, number>>;
  readonly stop: PublicationSweepStop;
}

function countUp(counts: Record<string, number>, key: string): void {
  counts[key] = (counts[key] ?? 0) + 1;
}

/**
 * HOSTED-20: runs the auto-publish gate over the undecided proposals, newest first, through the injected decide
 * (decideProposal in the Worker). The budget is checked before each proposal. Counts only, so the result can be
 * logged without source text.
 */
export async function sweepUndecidedProposals(deps: PublicationSweepDeps): Promise<PublicationSweepResult> {
  const limit = deps.limit ?? PUBLICATION_SWEEP_LIMIT;
  const maxFailures = deps.maxConsecutiveFailures ?? PUBLICATION_SWEEP_MAX_CONSECUTIVE_FAILURES;
  const ids = await deps.listUndecided(limit);
  let assessed = 0;
  let published = 0;
  let unchanged = 0;
  let held = 0;
  let denied = 0;
  let skipped = 0;
  let failed = 0;
  const heldReasons: Record<string, number> = {};
  const deniedCodes: Record<string, number> = {};
  const failedCodes: Record<string, number> = {};
  let streak = 0;
  let stop: PublicationSweepStop = ids.length >= limit ? "limit" : "done";
  for (const proposalId of ids) {
    if (isTimeBudgetExhausted(deps.now(), deps.deadlineMs)) {
      stop = "budget";
      break;
    }
    if (streak >= maxFailures) {
      stop = "consecutive_failed";
      break;
    }
    assessed += 1;
    let decision: SweepDecision;
    try {
      decision = await deps.decide(proposalId);
    } catch (err) {
      failed += 1;
      streak += 1;
      countUp(failedCodes, safeErrorLabel(err));
      continue;
    }
    streak = 0;
    switch (decision.status) {
      case "published":
        published += 1;
        break;
      case "unchanged":
        unchanged += 1;
        break;
      case "queued":
        held += 1;
        for (const reason of decision.reasons ?? []) countUp(heldReasons, reason);
        break;
      case "already_decided":
        skipped += 1;
        break;
      case "denied":
        denied += 1;
        countUp(deniedCodes, decision.code ?? "unknown");
        break;
      default:
        denied += 1;
        countUp(deniedCodes, "unexpected_status");
        break;
    }
  }
  return {
    assessed,
    published,
    unchanged,
    held,
    denied,
    skipped,
    failed,
    heldReasons,
    deniedCodes,
    failedCodes,
    stop,
  };
}

function formatCounts(label: string, counts: Readonly<Record<string, number>>): string | null {
  const entries = Object.entries(counts).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  if (entries.length === 0) return null;
  return `[Once] Publication ${label}: ${entries.map(([key, count]) => `${key}=${count}`).join(" ")}.`;
}

/** Count-only log lines for one sweep. The reason lines appear only when there is something to count. */
export function formatPublicationLines(result: PublicationSweepResult): string[] {
  const lines = [
    `[Once] Publication: assessed=${result.assessed} published=${result.published} unchanged=${result.unchanged} ` +
      `held=${result.held} denied=${result.denied} skipped=${result.skipped} failed=${result.failed} stop=${result.stop}.`,
  ];
  for (const [label, counts] of [
    ["held reasons", result.heldReasons],
    ["denied codes", result.deniedCodes],
    ["failed codes", result.failedCodes],
  ] as const) {
    const line = formatCounts(label, counts);
    if (line !== null) lines.push(line);
  }
  return lines;
}

export function formatDrainLine(drain: DrainResult): string {
  return `[Once] AI jobs: completed=${drain.completed} not_completed=${drain.notCompleted} stop=${drain.stop}.`;
}

/**
 * HOSTED-24C: the counts of one attribution backfill run (see tools/hosted/attribution-backfill.ts). Each unit is one
 * published live event version, never a reference and never a source.
 */
export interface AttributionBackfillResult {
  /** Versions attempted in this run: attributed + skipped + failed. Zero when the run's candidate query failed. */
  readonly candidates: number;
  /** Versions whose every resolved supporting reference has an approved attribution row after this run's write. */
  readonly attributed: number;
  /** Versions still without a complete approved attribution: refused by the rights rules, or with an unresolved reference. */
  readonly skipped: number;
  /** Versions whose write threw (rolled back, and the run goes on). A whole-step failure counts as one. */
  readonly failed: number;
}

/** HOSTED-24C: the one public count line of the attribution backfill. Fixed fields, no source text, URL or error text. */
export function formatAttributionLine(result: AttributionBackfillResult): string {
  return `[Once] Attribution backfill: candidates=${result.candidates} attributed=${result.attributed} skipped=${result.skipped} failed=${result.failed}`;
}

export interface OnceSteps {
  /** One poll cycle. A throw is reported through onPollError and does not stop the run. */
  readonly poll: () => Promise<void>;
  readonly onPollError: (error: unknown) => void;
  /** Throws are hard errors: the caller stops the run and exits 1. */
  readonly drain: () => Promise<DrainResult>;
  readonly sweep: () => Promise<PublicationSweepResult>;
  /**
   * HOSTED-24C: optional, so a run without it keeps its order and its lines. It runs after the sweep. A throw is
   * counted as one failed step, is never fatal, and never reaches the log as text.
   */
  readonly attribution?: () => Promise<AttributionBackfillResult>;
  readonly freshness: () => Promise<void>;
  readonly log: (line: string) => void;
}

/**
 * HOSTED-20: the order of one `--once` run: poll, drain the AI queue, the publication sweep over what is still
 * undecided, then one freshness pass. A throw from drain, sweep or freshness is not caught here.
 * HOSTED-24C: the attribution backfill runs after the sweep and before the freshness pass, and never fails the run.
 */
export async function runOnceSequence(steps: OnceSteps): Promise<void> {
  try {
    await steps.poll();
  } catch (err) {
    steps.onPollError(err);
  }
  const drain = await steps.drain();
  steps.log(formatDrainLine(drain));
  const sweep = await steps.sweep();
  for (const line of formatPublicationLines(sweep)) steps.log(line);
  if (steps.attribution !== undefined) {
    let backfill: AttributionBackfillResult;
    try {
      backfill = await steps.attribution();
    } catch {
      backfill = { candidates: 0, attributed: 0, skipped: 0, failed: 1 };
    }
    steps.log(formatAttributionLine(backfill));
  }
  await steps.freshness();
}
