// HOSTED-03: source readiness for the live server. Pure checks (coverage guard, per-source health line)
// plus one read-only registry query. Output carries counts, source ids and enum values only: never URLs,
// keys, item text or raw error messages. A failed poll is classified from its text and the text is dropped.
import type { SqlExecutor } from "../apps/db/src/sql.js";
import { DEFAULT_NEWS_FEEDS, type NewsTriageCounts } from "../apps/worker/src/runtime/news-poll-runtime.js";
import { BMKG_GEMPA_SOURCE_ID } from "../apps/worker/src/runtime/bmkg-poll-runtime.js";
import { PETABENCANA_SOURCE_ID } from "../apps/worker/src/layers/l1-data-knowledge/petabencana-ingest.js";
import { BLOCKED_REDIRECT_ERROR } from "../apps/worker/src/runtime/outbound-fetch-policy.js";

export const STRUCTURED_LIVE_SOURCE_IDS: readonly string[] = [PETABENCANA_SOURCE_ID, BMKG_GEMPA_SOURCE_ID];

/** The 16 sources the hosted server must poll: 14 RSS feeds, PetaBencana and BMKG. */
export function expectedLiveSourceIds(): string[] {
  return [...DEFAULT_NEWS_FEEDS.map((feed) => feed.sourceId), ...STRUCTURED_LIVE_SOURCE_IDS];
}

/** The poll set the server actually starts with, derived from the same constants. */
export function livePollSourceIds(): string[] {
  return [...DEFAULT_NEWS_FEEDS.map((feed) => feed.sourceId), PETABENCANA_SOURCE_ID, BMKG_GEMPA_SOURCE_ID];
}

export interface RegistryRow {
  readonly source_id: string;
  readonly approval_status: string;
  readonly registry_status: string;
  readonly auto_acquisition_enabled: boolean;
}

export interface CoverageReport {
  /** False only when a source is missing or the poll set disagrees with the expected list. */
  readonly ok: boolean;
  readonly expected: number;
  readonly missing: readonly string[];
  /** Present but not ready (revoked, suspended, pending or auto-acquisition off). Skipped, never fatal. */
  readonly notReady: readonly { readonly sourceId: string; readonly label: string; readonly reason: string }[];
  readonly notPolled: readonly string[];
  readonly unexpectedPolled: readonly string[];
}

/** Why a present row is not pollable. Source ids and enum values only. */
function skipLabel(row: RegistryRow): string {
  if (row.approval_status !== "approved") return row.approval_status;
  if (row.registry_status !== "active") return `registry_${row.registry_status}`;
  return "auto_acquisition_off";
}

/**
 * Coverage guard (owner decision, 16 Nov). Refuses only when a source is missing from the registry, or when
 * the poll set does not match the expected list. A revoked or disabled source is not fatal: it is logged as
 * skipped and the other sources keep running.
 */
export function checkLiveSourceCoverage(input: {
  readonly expectedIds: readonly string[];
  readonly pollSetIds: readonly string[];
  readonly rows: readonly RegistryRow[];
}): CoverageReport {
  const byId = new Map(input.rows.map((row) => [row.source_id, row] as const));
  const missing: string[] = [];
  const notReady: { sourceId: string; label: string; reason: string }[] = [];
  for (const id of input.expectedIds) {
    const row = byId.get(id);
    if (row === undefined) {
      missing.push(id);
      continue;
    }
    if (!shouldPollFeed(row)) {
      const reasons = [`approval=${row.approval_status}`, `registry=${row.registry_status}`];
      if (row.auto_acquisition_enabled !== true) reasons.push("auto_acquisition=off");
      notReady.push({ sourceId: id, label: skipLabel(row), reason: reasons.join(" ") });
    }
  }
  const expected = new Set(input.expectedIds);
  const polled = new Set(input.pollSetIds);
  const notPolled = input.expectedIds.filter((id) => !polled.has(id));
  const unexpectedPolled = input.pollSetIds.filter((id) => !expected.has(id));
  return {
    ok: missing.length === 0 && notPolled.length === 0 && unexpectedPolled.length === 0,
    expected: input.expectedIds.length,
    missing,
    notReady,
    notPolled,
    unexpectedPolled,
  };
}

/**
 * Per-cycle fetch decision for an RSS feed, made from source_registry before any request is sent.
 * Only an approved, auto-acquisition-enabled row is polled. A revoked or disabled row, or a missing row
 * (fail closed), is not fetched. The triage gate still runs after fetch and is not the control here.
 */
export function shouldPollFeed(row: RegistryRow | undefined): boolean {
  return row !== undefined && row.approval_status === "approved" && row.auto_acquisition_enabled === true;
}

/** Fatal refusal lines: missing sources or poll-set mismatch only. */
export function formatCoverageFailure(report: CoverageReport): string[] {
  const lines = [`Refusing to start: live source coverage is incomplete (${report.expected} sources required).`];
  if (report.missing.length > 0) lines.push(`  missing from source_registry: ${report.missing.join(", ")}`);
  if (report.notPolled.length > 0) lines.push(`  not in poll set: ${report.notPolled.join(", ")}`);
  if (report.unexpectedPolled.length > 0) lines.push(`  unexpected poll set entries: ${report.unexpectedPolled.join(", ")}`);
  lines.push("  Missing rows are inserted by `npm run hosted:bootstrap`, which never changes an existing row.");
  return lines;
}

/** One line per skipped source, for example "revoked: source-x, skipped". Ids and enum values only. */
export function formatCoverageSkips(report: CoverageReport): string[] {
  return report.notReady.map((item) => `${item.label}: ${item.sourceId}, skipped`);
}

/** Per-cycle line for feeds that were not fetched because they are revoked or disabled. Count and ids only. */
export function formatNotFetchedLine(sourceIds: readonly string[]): string {
  const ids = sourceIds.length === 0 ? "none" : sourceIds.join(",");
  return `  [Source Health] revoked_or_disabled_not_fetched count=${sourceIds.length} source_ids=${ids}`;
}

export async function loadRegistryRows(executor: SqlExecutor, sourceIds: readonly string[]): Promise<RegistryRow[]> {
  const result = await executor.query<RegistryRow>(
    `SELECT source_id, approval_status, registry_status, auto_acquisition_enabled
     FROM waspada.source_registry
     WHERE source_id = ANY($1::text[])`,
    [sourceIds],
  );
  return [...result.rows];
}

const ERROR_LABEL_PATTERN = /^[A-Za-z0-9_]{1,40}$/u;
const ERROR_CLASS_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,63}$/u;

/** Error class name only (for example TypeError). Anything unusual becomes "unknown". */
export function errorClassName(error: unknown): string {
  const name = error instanceof Error ? error.name : "unknown";
  return ERROR_CLASS_PATTERN.test(name) ? name : "unknown";
}

/** A short code when the error carries one (Node or pg), otherwise the class name. Never the message. */
export function safeErrorLabel(error: unknown): string {
  const code = (error as { readonly code?: unknown } | null | undefined)?.code;
  if (typeof code === "string" && ERROR_LABEL_PATTERN.test(code)) return code;
  return errorClassName(error);
}

export interface SourceHealthEntry {
  readonly sourceId: string;
  readonly fetched: number;
  readonly newItems: number;
  /** null when this source kind has no dedupe count. */
  readonly deduped: number | null;
  /** null for structured sources, which have no triage gate. */
  readonly triageAccepted: number | null;
  readonly triageRejected: number | null;
  readonly sourceNotCleared: number;
  readonly blockedFetch: number;
  readonly errorClass: string;
}

export function rssFeedHealthEntry(input: {
  readonly sourceId: string;
  readonly status: string;
  readonly error?: string;
  readonly totalParsed: number;
  readonly admitted: number;
  readonly cycleDuplicates: number;
  readonly triage?: NewsTriageCounts;
}): SourceHealthEntry {
  const blocked = input.error === BLOCKED_REDIRECT_ERROR;
  return {
    sourceId: input.sourceId,
    fetched: input.totalParsed,
    newItems: input.admitted,
    deduped: (input.triage?.duplicate ?? 0) + input.cycleDuplicates,
    triageAccepted: input.triage?.ingested ?? null,
    triageRejected: input.triage?.dropped ?? null,
    sourceNotCleared: input.error === "source_not_cleared" ? 1 : (input.triage?.authzRejected ?? 0),
    blockedFetch: blocked ? 1 : 0,
    errorClass: blocked ? "blocked_redirect" : input.status === "success" ? "none" : input.status,
  };
}

/** A source whose poll threw before it returned a result. */
export function failedHealthEntry(sourceId: string, error: unknown): SourceHealthEntry {
  return {
    sourceId,
    fetched: 0,
    newItems: 0,
    deduped: null,
    triageAccepted: null,
    triageRejected: null,
    sourceNotCleared: 0,
    blockedFetch: 0,
    errorClass: errorClassName(error),
  };
}

export interface StructuredPollInput {
  readonly sourceId: string;
  readonly outcome?: string;
  readonly fetched: number;
  readonly revisions: number;
  readonly error?: string;
  /** Set when the poll threw instead of returning an outcome. */
  readonly thrown?: { readonly error: unknown };
}

/**
 * PetaBencana and BMKG. They return an outcome rather than a status enum. The poll window
 * re-reads recent reports, so "new" is the count of revisions that were not in the database yet.
 */
export function structuredHealthEntry(input: StructuredPollInput, newItems: number): SourceHealthEntry {
  if (input.thrown !== undefined) return failedHealthEntry(input.sourceId, input.thrown.error);
  const blocked = input.error === BLOCKED_REDIRECT_ERROR;
  return {
    sourceId: input.sourceId,
    fetched: input.fetched,
    newItems,
    deduped: Math.max(0, input.revisions - newItems),
    triageAccepted: null,
    triageRejected: null,
    sourceNotCleared: 0,
    blockedFetch: blocked ? 1 : 0,
    errorClass: blocked ? "blocked_redirect" : input.outcome === "error" ? classifyPollMessage(input.error) : "none",
  };
}

// The message is matched, never printed. Only the coarse class leaves this module.
function classifyPollMessage(message: string | undefined): string {
  if (message !== undefined && /timed out|timeout|abort/iu.test(message)) return "timeout";
  return "poll_error";
}

/** One fixed-shape line per source per cycle. Counts and ids only. */
export function formatSourceHealthLine(entry: SourceHealthEntry): string {
  const value = (count: number | null): string => (count === null ? "na" : String(count));
  return `  [Source Health] ${entry.sourceId} fetched=${entry.fetched} new=${entry.newItems}`
    + ` deduped=${value(entry.deduped)} triage_accepted=${value(entry.triageAccepted)}`
    + ` triage_rejected=${value(entry.triageRejected)} source_not_cleared=${entry.sourceNotCleared}`
    + ` blocked_fetch=${entry.blockedFetch} error=${entry.errorClass}`;
}
