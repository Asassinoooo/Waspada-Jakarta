/**
 * DET-FILTER-02 bounded one-shot deterministic-filter shadow evaluation.
 *
 * Default mode is fully offline over checked-in synthetic RSS fixtures
 * (`fixtures/synthetic-*.xml`): zero network, zero persistence, zero model
 * calls. Real fetching requires BOTH `--live` AND every requested source
 * passing the Step 1 clearance re-check immediately before its fetch; any
 * failure aborts that feed with a `source_not_cleared` count and no fetch.
 *
 * Bounds: one GET per feed, 20s abort timeout, 2_000_000-byte streamed body
 * cap (excess -> `oversized`, body discarded); at most 5 live feeds; stop
 * after 100 raw parsed items total (feed order as configured, document order
 * within a feed; mid-feed stop is deterministic; `truncated: true` when hit).
 * Never fetches article pages, images, or media. Freshness mirrors the
 * poller: `ageHours > lookbackHours -> stale` with the same `Date.parse`
 * semantics (unparseable dates never count as stale); default lookback 48h.
 * Never reads `NEWS_MAX_AGE_HOURS` and never changes production defaults.
 *
 * Isolation: parse (`parseRssDiscoveryXml`) -> sanitize
 * (`sanitizeRssDescription`) -> match (`matchDeterministicRelevance`) ->
 * aggregate counts. Holds no DB handle, performs zero mutations, builds no
 * revision/chunk/job/triage objects. Stdout prints aggregate counts plus
 * rule/version IDs only -- never titles, excerpts, URLs, matched text, or
 * credentials. Direct imports are limited to the four pure evaluation
 * helpers plus `DEFAULT_NEWS_FEEDS` (feed allowlist) and
 * `evaluateSourcePermissions` (clearance semantics re-used read-only); the
 * transitive closure is pure (node:crypto, saxes, versioned JSON datasets).
 * Nothing here imports or calls gated persistence, AI/chat providers,
 * embeddings, semantic triage, or queues. `NEWS_DETERMINISTIC_FILTER_MODE`
 * stays `shadow`; candidate/ambiguous/low_signal semantics stay frozen.
 *
 * Clearance for this task: acquisition approved+enabled AND a recorded grant
 * covering deterministic processing of RSS title/excerpt metadata (a
 * title/excerpt retention or model-use token; a model token is NOT required).
 * A public URL or HTTP 200 is NEVER permission. Absent a registry snapshot
 * (`--registry-json`, a JSON object mapping sourceId to RegistryPermissionRow
 * as SELECTed in Step 1) every live source fails closed to
 * `source_not_cleared`.
 *
 * `--review N` prints at most N sampled title/excerpt pairs (truncated to 500
 * code points each) for transient terminal inspection only: it requires a
 * registry snapshot granting title+description retention for every evaluated
 * source, writes nothing to disk, and errors out (`review_not_permitted`)
 * with no clearance evidence. `--labels <path>` joins externally recorded
 * human labels (`{ "labels": [{ "id", "label": "actionable_jakarta_incident"
 * | "not_actionable" }] }`, id = stable guid or link) to compute
 * precision/recall/F1; no labeled sample means no accuracy claim.
 *
 * Exit codes: 0 success; 1 fetch/permission/parse/oversize failure (with a
 * machine-readable `error_code` line on stderr, no content); 2 usage or
 * invalid operator input.
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseRssDiscoveryXml } from "../../apps/worker/src/layers/l1-data-knowledge/rss-discovery.js";
import { sanitizeRssDescription } from "../../apps/worker/src/layers/l1-data-knowledge/rss-news-ingest.js";
import {
  getDeterministicDatasetVersions,
  matchDeterministicRelevance,
} from "../../apps/worker/src/layers/l1-data-knowledge/deterministic-relevance.js";
import { DEFAULT_NEWS_FEEDS } from "../../apps/worker/src/runtime/news-poll-runtime.js";
import {
  evaluateSourcePermissions,
  type RegistryPermissionRow,
} from "../../apps/worker/src/layers/l1-data-knowledge/news-triage.js";

export const MAX_EVAL_RESPONSE_BYTES = 2_000_000;
export const EVAL_FETCH_TIMEOUT_MS = 20_000;
export const EVAL_MAX_ITEMS_TOTAL = 100;
export const EVAL_MAX_LIVE_FEEDS = 5;
export const EVAL_DEFAULT_LOOKBACK_HOURS = 48;
export const EVAL_REVIEW_TRUNCATION_CODE_POINTS = 500;

export const EVAL_MODIFIER_KEYS = [
  "forecast_override_applied",
  "weather_forecast_override_applied",
  "planned_traffic_override_applied",
  "negation_downgrade_applied",
] as const;

export type EvalModifierKey = (typeof EVAL_MODIFIER_KEYS)[number];

const HERE = dirname(fileURLToPath(import.meta.url));
export const EVAL_FIXTURE_DIR = join(HERE, "fixtures");

export type EvalVerdict = "candidate" | "ambiguous" | "low_signal";

export interface EvalMatchedItem {
  readonly id: string;
  readonly status: EvalVerdict;
  readonly locationKeys: readonly string[];
  readonly groupIds: readonly string[];
  readonly role: "scene" | "non_scene_or_reference" | "unknown";
  readonly modifiers: readonly EvalModifierKey[];
}

export interface EvalFeedCounts {
  readonly sourceId: string;
  readonly fetched: number;
  readonly parsed: number;
  readonly invalid: number;
  readonly stale: number;
  readonly oversized: number;
  readonly source_not_cleared: number;
  readonly candidate: number;
  readonly ambiguous: number;
  readonly low_signal: number;
  readonly considered: number;
  readonly enforce_skipped: number;
  readonly candidate_rate: number | null;
  readonly ai_call_reduction: number | null;
}

export interface EvalBreakdowns {
  readonly byLocation: Readonly<Record<string, number>>;
  readonly byGroup: Readonly<Record<string, number>>;
  readonly byRole: Readonly<Record<string, number>>;
  readonly byModifier: Readonly<Record<string, number>>;
}

export interface EvalLabelMetrics {
  readonly sampleSize: number;
  readonly tp: number;
  readonly fp: number;
  readonly fn: number;
  readonly tn: number;
  readonly precision: number | null;
  readonly recall: number | null;
  readonly f1: number | null;
}

export interface EvalReport {
  readonly mode: "synthetic" | "live";
  readonly now: string;
  readonly lookbackHours: number;
  readonly feeds: readonly EvalFeedCounts[];
  readonly total: EvalFeedCounts;
  readonly breakdowns: EvalBreakdowns;
  readonly versions: {
    readonly detRuleVersion: string;
    readonly detGazetteerVersion: string;
    readonly detLexiconVersion: string;
  };
  readonly labels: EvalLabelMetrics | null;
  readonly truncated: boolean;
}

export interface EvalFeedError {
  readonly sourceId?: string;
  readonly error_code: string;
}

export interface ShadowEvalOutput {
  readonly exitCode: 0 | 1 | 2;
  readonly result: EvalReport | null;
  readonly errors: readonly EvalFeedError[];
  readonly reviewSample: readonly {
    readonly id: string;
    readonly title: string;
    readonly excerpt: string | null;
  }[] | null;
}

function rate(numerator: number, denominator: number): number | null {
  if (denominator === 0) return null;
  return numerator / denominator;
}

function emptyCounts(sourceId: string): EvalFeedCounts {
  return {
    sourceId,
    fetched: 0,
    parsed: 0,
    invalid: 0,
    stale: 0,
    oversized: 0,
    source_not_cleared: 0,
    candidate: 0,
    ambiguous: 0,
    low_signal: 0,
    considered: 0,
    enforce_skipped: 0,
    candidate_rate: null,
    ai_call_reduction: null,
  };
}

// ---------------------------------------------------------------------------
// CLI argument parsing.
// ---------------------------------------------------------------------------

export interface EvalCliOptions {
  readonly live: boolean;
  readonly sourceIds: readonly string[];
  readonly lookbackHours: number;
  readonly reviewLimit: number | null;
  readonly labelsPath: string | null;
  readonly registryPath: string | null;
  readonly nowOverride: string | null;
}

type ArgParseResult =
  | { readonly ok: true; readonly options: EvalCliOptions }
  | { readonly ok: false; readonly errorCode: string };

export function parseEvalArgs(argv: readonly string[]): ArgParseResult {
  const knownIds = new Set(DEFAULT_NEWS_FEEDS.map((feed) => feed.sourceId));
  let live = false;
  const sourceIds: string[] = [];
  let lookbackHours = EVAL_DEFAULT_LOOKBACK_HOURS;
  let reviewLimit: number | null = null;
  let labelsPath: string | null = null;
  let registryPath: string | null = null;
  let nowOverride: string | null = null;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    switch (arg) {
      case "--live":
        live = true;
        break;
      case "--source": {
        const value = argv[i + 1];
        i += 1;
        if (value === undefined || value.length === 0) return { ok: false, errorCode: "USAGE" };
        if (!knownIds.has(value)) return { ok: false, errorCode: "USAGE" };
        sourceIds.push(value);
        break;
      }
      case "--lookback-hours": {
        const value = argv[i + 1];
        i += 1;
        const parsed = value === undefined ? NaN : Number(value);
        if (!Number.isFinite(parsed) || parsed <= 0) return { ok: false, errorCode: "USAGE" };
        lookbackHours = parsed;
        break;
      }
      case "--review": {
        const value = argv[i + 1];
        i += 1;
        const parsed = value === undefined ? NaN : Number(value);
        if (!Number.isInteger(parsed) || parsed < 1) return { ok: false, errorCode: "USAGE" };
        reviewLimit = parsed;
        break;
      }
      case "--labels":
      case "--registry-json":
      case "--now": {
        const value = argv[i + 1];
        i += 1;
        if (value === undefined || value.length === 0) return { ok: false, errorCode: "USAGE" };
        if (arg === "--labels") labelsPath = value;
        else if (arg === "--registry-json") registryPath = value;
        else nowOverride = value;
        break;
      }
      case "--help":
      case "-h":
        return { ok: false, errorCode: "USAGE" };
      default:
        return { ok: false, errorCode: "USAGE" };
    }
  }

  if (!live && sourceIds.length > 0) return { ok: false, errorCode: "USAGE" };
  if (live && sourceIds.length > EVAL_MAX_LIVE_FEEDS) return { ok: false, errorCode: "USAGE" };
  return {
    ok: true,
    options: { live, sourceIds, lookbackHours, reviewLimit, labelsPath, registryPath, nowOverride },
  };
}

// ---------------------------------------------------------------------------
// Clearance: fail-closed re-check immediately before any fetch.
// ---------------------------------------------------------------------------

function isRegistryRow(value: unknown): value is RegistryPermissionRow {
  if (typeof value !== "object" || value === null) return false;
  const row = value as Record<string, unknown>;
  return (
    typeof row.approval_status === "string" &&
    typeof row.auto_acquisition_enabled === "boolean" &&
    typeof row.registry_status === "string" &&
    (Array.isArray(row.reuse_basis) || row.reuse_basis === null) &&
    (typeof row.reuse_license_url === "string" || row.reuse_license_url === null) &&
    (typeof row.reuse_scope === "string" || row.reuse_scope === null) &&
    (typeof row.reuse_reviewer === "string" || row.reuse_reviewer === null) &&
    (typeof row.reuse_reviewed_at === "string" || row.reuse_reviewed_at === null) &&
    (typeof row.reuse_expires_at === "string" || row.reuse_expires_at === null)
  );
}

export function loadRegistrySnapshot(jsonText: string): {
  readonly ok: boolean;
  readonly rows: Record<string, RegistryPermissionRow>;
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText) as unknown;
  } catch {
    return { ok: false, rows: {} };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, rows: {} };
  }
  const rows: Record<string, RegistryPermissionRow> = {};
  for (const [sourceId, row] of Object.entries(parsed as Record<string, unknown>)) {
    if (!isRegistryRow(row)) return { ok: false, rows: {} };
    rows[sourceId] = row;
  }
  return { ok: true, rows };
}

/**
 * Eval clearance: acquisition approved+enabled AND a recorded grant covering
 * deterministic processing of RSS title/excerpt metadata. Retention grants
 * suffice on their own; model-use grants also imply processing permission.
 * Anything else (including legacy-only tokens without reviewer-recorded
 * license evidence, and missing rows) fails closed.
 */
export function isSourceClearedForEval(
  row: RegistryPermissionRow | undefined,
  nowIso: string,
  sourceId: string,
): boolean {
  if (row === undefined) return false;
  let permissions;
  try {
    permissions = evaluateSourcePermissions(row, nowIso, sourceId);
  } catch {
    return false;
  }
  if (permissions.acquisition !== true) return false;
  return (
    permissions.titleRetention === true ||
    permissions.descriptionRetention === true ||
    permissions.titleModel === true ||
    permissions.descriptionModel === true
  );
}

// ---------------------------------------------------------------------------
// Bounded fetch: one GET per feed, abort timeout, streamed byte cap.
// ---------------------------------------------------------------------------

export interface EvalFetchResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly body: ReadableStream<Uint8Array> | null;
  text(): Promise<string>;
}

export type EvalFetchFn = (
  url: string,
  init: { readonly signal: AbortSignal; readonly headers: Record<string, string> },
) => Promise<EvalFetchResponse>;

export type FeedFetchResult =
  | { readonly ok: true; readonly bytes: Uint8Array }
  | { readonly ok: false; readonly code: "timeout" | "fetch_error" | "oversized" };

export async function fetchFeedBody(
  url: string,
  fetchFn: EvalFetchFn,
  timeoutMs: number,
  maxBytes: number,
): Promise<FeedFetchResult> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error(`Request timed out after ${timeoutMs}ms`));
  }, timeoutMs);
  try {
    const response = await fetchFn(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": "WaspadaJakarta-DetFilterShadowEval/1.0 (+one-shot-evaluation)",
        Accept: "application/rss+xml, application/xml, text/xml, */*",
      },
    });
    if (!response.ok) return { ok: false, code: "fetch_error" };
    if (response.body === null || typeof (response.body as unknown as { getReader?: unknown }).getReader !== "function") {
      const text = await response.text();
      const bytes = new TextEncoder().encode(text);
      if (bytes.byteLength > maxBytes) return { ok: false, code: "oversized" };
      return { ok: true, bytes };
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value !== undefined) {
        total += value.byteLength;
        if (total > maxBytes) {
          await reader.cancel().catch(() => undefined);
          return { ok: false, code: "oversized" };
        }
        chunks.push(value);
      }
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return { ok: true, bytes };
  } catch (error: unknown) {
    if (
      timedOut ||
      controller.signal.aborted ||
      (error instanceof Error &&
        (error.name === "AbortError" || error.name === "TimeoutError" || error.message.includes("timed out")))
    ) {
      return { ok: false, code: "timeout" };
    }
    return { ok: false, code: "fetch_error" };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// In-memory evaluation: parse -> sanitize -> match -> aggregate counts.
// ---------------------------------------------------------------------------

export interface EvalXmlOptions {
  /** Raw-item budget for the 100-item total cap; stops mid-feed deterministically. */
  readonly itemBudget?: number;
  /** Transient content retention for --review display only; never persisted. */
  readonly collectSamples?: number;
}

export type EvalXmlResult =
  | {
      readonly ok: true;
      readonly fetched: number;
      readonly parsed: number;
      readonly invalid: number;
      readonly stale: number;
      readonly items: readonly EvalMatchedItem[];
      readonly samples: readonly { readonly id: string; readonly title: string; readonly excerpt: string | null }[];
      readonly budgetExhausted: boolean;
    }
  | { readonly ok: false; readonly error: string };

export function evaluateRssXml(
  xmlText: string,
  retrievedAt: string,
  lookbackHours: number,
  options?: EvalXmlOptions,
): EvalXmlResult {
  const budget = options?.itemBudget ?? EVAL_MAX_ITEMS_TOTAL;
  const sampleLimit = options?.collectSamples ?? 0;
  const parsed = parseRssDiscoveryXml(xmlText, retrievedAt);
  if (parsed.kind === "error") return { ok: false, error: parsed.error.code };

  let fetched = 0;
  let invalid = 0;
  let stale = 0;
  const items: EvalMatchedItem[] = [];
  const samples: { id: string; title: string; excerpt: string | null }[] = [];
  const retrievedMs = Date.parse(retrievedAt);

  for (const raw of parsed.items) {
    if (fetched >= budget) {
      return { ok: true, fetched, parsed: items.length + stale, invalid, stale, items, samples, budgetExhausted: true };
    }
    fetched += 1;
    if (!raw.title || !raw.link) {
      invalid += 1;
      continue;
    }
    if (raw.pubDate) {
      const pubMs = Date.parse(raw.pubDate);
      if (Number.isFinite(pubMs) && Number.isFinite(retrievedMs)) {
        if ((retrievedMs - pubMs) / (1000 * 60 * 60) > lookbackHours) {
          stale += 1;
          continue;
        }
      }
    }
    const excerpt = sanitizeRssDescription(raw.description);
    const verdict = matchDeterministicRelevance(raw.title, excerpt);
    const locationKeys = verdict.locationMatches.map((match) => `${match.level}x${match.matchStrength}`);
    const groupIds = verdict.eventMatches.map((match) => match.groupId);
    const modifiers = EVAL_MODIFIER_KEYS.filter((key) =>
      verdict.reasons.some((reason) => reason === key),
    );
    items.push({
      id: raw.guid ?? raw.link,
      status: verdict.status,
      locationKeys,
      groupIds,
      role: verdict.locationRole,
      modifiers,
    });
    if (samples.length < sampleLimit) {
      samples.push({ id: raw.guid ?? raw.link, title: raw.title, excerpt });
    }
  }
  return {
    ok: true,
    fetched,
    parsed: items.length + stale,
    invalid,
    stale,
    items,
    samples,
    budgetExhausted: false,
  };
}

function finalizeCounts(sourceId: string, base: Omit<EvalFeedCounts, "sourceId" | "considered" | "enforce_skipped" | "candidate_rate" | "ai_call_reduction">): EvalFeedCounts {
  const considered = base.candidate + base.ambiguous + base.low_signal;
  const enforce_skipped = base.ambiguous + base.low_signal;
  return {
    sourceId,
    ...base,
    considered,
    enforce_skipped,
    candidate_rate: rate(base.candidate, considered),
    ai_call_reduction: rate(enforce_skipped, considered),
  };
}

// ---------------------------------------------------------------------------
// Labels: externally recorded human ground truth joined by stable id.
// ---------------------------------------------------------------------------

export interface EvalLabelEntry {
  readonly id: string;
  readonly label: "actionable_jakarta_incident" | "not_actionable";
}

export function parseLabelsFile(jsonText: string): {
  readonly ok: boolean;
  readonly labels: readonly EvalLabelEntry[];
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText) as unknown;
  } catch {
    return { ok: false, labels: [] };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, labels: [] };
  }
  const raw = (parsed as Record<string, unknown>).labels;
  if (!Array.isArray(raw)) return { ok: false, labels: [] };
  const seen = new Set<string>();
  const labels: EvalLabelEntry[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) return { ok: false, labels: [] };
    const record = entry as Record<string, unknown>;
    if (typeof record.id !== "string" || record.id.length === 0) return { ok: false, labels: [] };
    if (record.label !== "actionable_jakarta_incident" && record.label !== "not_actionable") {
      return { ok: false, labels: [] };
    }
    if (seen.has(record.id)) return { ok: false, labels: [] };
    seen.add(record.id);
    labels.push({ id: record.id, label: record.label });
  }
  return { ok: true, labels };
}

export function computeLabelMetrics(
  evaluated: ReadonlyMap<string, EvalVerdict> | readonly EvalMatchedItem[],
  labels: readonly EvalLabelEntry[],
): EvalLabelMetrics {
  // Note: Array.isArray does not narrow readonly-array unions (readonly
  // arrays are not assignable to any[]), so discriminate on Map#get instead.
  const byId: ReadonlyMap<string, EvalVerdict> =
    typeof (evaluated as ReadonlyMap<string, EvalVerdict>).get === "function"
      ? (evaluated as ReadonlyMap<string, EvalVerdict>)
      : new Map<string, EvalVerdict>(
          (evaluated as readonly EvalMatchedItem[]).map((item) => [item.id, item.status]),
        );
  let tp = 0;
  let fp = 0;
  let fn = 0;
  let tn = 0;
  for (const entry of labels) {
    const status = byId.get(entry.id);
    if (status === undefined) continue;
    const predicted = status === "candidate";
    const actual = entry.label === "actionable_jakarta_incident";
    if (predicted && actual) tp += 1;
    else if (predicted && !actual) fp += 1;
    else if (!predicted && actual) fn += 1;
    else tn += 1;
  }
  const sampleSize = tp + fp + fn + tn;
  const precision = rate(tp, tp + fp);
  const recall = rate(tp, tp + fn);
  const f1 =
    precision === null || recall === null || precision + recall === 0
      ? null
      : (2 * precision * recall) / (precision + recall);
  return { sampleSize, tp, fp, fn, tn, precision, recall, f1 };
}

// ---------------------------------------------------------------------------
// Orchestration (injectable for offline tests; no network unless live).
// ---------------------------------------------------------------------------

export interface ShadowEvalInput {
  readonly mode: "synthetic" | "live";
  readonly lookbackHours: number;
  readonly now: string;
  readonly fixtureXmls?: readonly { readonly sourceId: string; readonly xmlText: string }[];
  readonly liveSourceIds?: readonly string[];
  readonly registryRows?: Record<string, RegistryPermissionRow> | null;
  readonly labels?: readonly EvalLabelEntry[] | null;
  readonly reviewLimit?: number | null;
  readonly fetchFn?: EvalFetchFn;
  readonly timeoutMs?: number;
  readonly maxBytes?: number;
}

export async function runShadowEval(input: ShadowEvalInput): Promise<ShadowEvalOutput> {
  const versions = getDeterministicDatasetVersions();
  const timeoutMs = input.timeoutMs ?? EVAL_FETCH_TIMEOUT_MS;
  const maxBytes = input.maxBytes ?? MAX_EVAL_RESPONSE_BYTES;
  const reviewLimit = input.reviewLimit ?? null;
  const errors: EvalFeedError[] = [];
  const feeds: EvalFeedCounts[] = [];
  const allItems: EvalMatchedItem[] = [];
  const byLocation: Record<string, number> = {};
  const byGroup: Record<string, number> = {};
  const byRole: Record<string, number> = { scene: 0, non_scene_or_reference: 0, unknown: 0 };
  const byModifier: Record<string, number> = {};
  for (const key of EVAL_MODIFIER_KEYS) byModifier[key] = 0;
  let truncated = false;
  let remaining = EVAL_MAX_ITEMS_TOTAL;
  // Transient review content only: held in memory for the terminal sample,
  // never persisted. Attached to the output only when the retention gate
  // below passes; otherwise dropped.
  const reviewPool: { readonly id: string; readonly title: string; readonly excerpt: string | null }[] = [];

  const recordItems = (items: readonly EvalMatchedItem[]): void => {
    for (const item of items) {
      allItems.push(item);
      for (const key of item.locationKeys) byLocation[key] = (byLocation[key] ?? 0) + 1;
      for (const groupId of item.groupIds) byGroup[groupId] = (byGroup[groupId] ?? 0) + 1;
      byRole[item.role] = (byRole[item.role] ?? 0) + 1;
      for (const modifier of item.modifiers) byModifier[modifier] = (byModifier[modifier] ?? 0) + 1;
    }
  };

  const collectSamples = (evaluation: EvalXmlResult): void => {
    if (reviewLimit === null || !evaluation.ok) return;
    for (const sample of evaluation.samples) {
      if (reviewPool.length >= reviewLimit) break;
      reviewPool.push(sample);
    }
  };
  if (input.mode === "synthetic") {
    const fixtures = [...(input.fixtureXmls ?? [])].sort((a, b) => (a.sourceId < b.sourceId ? -1 : a.sourceId > b.sourceId ? 1 : 0));
    if (fixtures.length === 0) {
      return { exitCode: 1, result: null, errors: [{ error_code: "NO_FIXTURES" }], reviewSample: null };
    }
    for (const fixture of fixtures) {
      const evaluated = evaluateRssXml(fixture.xmlText, input.now, input.lookbackHours, {
        itemBudget: remaining,
        collectSamples: reviewLimit ?? 0,
      });
      collectSamples(evaluated);
      if (!evaluated.ok) {
        feeds.push(emptyCounts(fixture.sourceId));
        errors.push({ sourceId: fixture.sourceId, error_code: evaluated.error });
        continue;
      }
      if (evaluated.budgetExhausted) truncated = true;
      remaining -= evaluated.fetched;
      recordItems(evaluated.items);
      feeds.push(
        finalizeCounts(fixture.sourceId, {
          fetched: evaluated.fetched,
          parsed: evaluated.parsed,
          invalid: evaluated.invalid,
          stale: evaluated.stale,
          oversized: 0,
          source_not_cleared: 0,
          candidate: evaluated.items.filter((item) => item.status === "candidate").length,
          ambiguous: evaluated.items.filter((item) => item.status === "ambiguous").length,
          low_signal: evaluated.items.filter((item) => item.status === "low_signal").length,
        }),
      );
      if (remaining <= 0) {
        truncated = true;
        break;
      }
    }
  } else {
    const feedById = new Map(DEFAULT_NEWS_FEEDS.map((feed) => [feed.sourceId, feed] as const));
    const requested =
      input.liveSourceIds !== undefined && input.liveSourceIds.length > 0
        ? input.liveSourceIds
        : DEFAULT_NEWS_FEEDS.slice(0, EVAL_MAX_LIVE_FEEDS).map((feed) => feed.sourceId);
    if (requested.length > EVAL_MAX_LIVE_FEEDS) {
      return { exitCode: 2, result: null, errors: [{ error_code: "USAGE" }], reviewSample: null };
    }
    const fetchFn = input.fetchFn ?? (globalThis.fetch as unknown as EvalFetchFn);
    for (const sourceId of requested) {
      const feed = feedById.get(sourceId);
      if (feed === undefined) {
        feeds.push(emptyCounts(sourceId));
        errors.push({ sourceId, error_code: "USAGE" });
        continue;
      }
      // Clearance re-check immediately before fetching; never fetch uncleared.
      if (!isSourceClearedForEval(input.registryRows?.[sourceId], input.now, sourceId)) {
        feeds.push({ ...emptyCounts(sourceId), source_not_cleared: 1 });
        errors.push({ sourceId, error_code: "source_not_cleared" });
        continue;
      }
      const fetched = await fetchFeedBody(feed.url, fetchFn, timeoutMs, maxBytes);
      if (!fetched.ok) {
        if (fetched.code === "oversized") {
          feeds.push({ ...emptyCounts(sourceId), oversized: 1 });
        } else {
          feeds.push(emptyCounts(sourceId));
        }
        errors.push({ sourceId, error_code: fetched.code });
        continue;
      }
      const xmlText = new TextDecoder("utf-8", { fatal: false }).decode(fetched.bytes);
      const evaluated = evaluateRssXml(xmlText, input.now, input.lookbackHours, {
        itemBudget: remaining,
        collectSamples: reviewLimit ?? 0,
      });
      collectSamples(evaluated);
      if (!evaluated.ok) {
        feeds.push(emptyCounts(sourceId));
        errors.push({ sourceId, error_code: evaluated.error });
        continue;
      }
      if (evaluated.budgetExhausted) truncated = true;
      remaining -= evaluated.fetched;
      recordItems(evaluated.items);
      feeds.push(
        finalizeCounts(sourceId, {
          fetched: evaluated.fetched,
          parsed: evaluated.parsed,
          invalid: evaluated.invalid,
          stale: evaluated.stale,
          oversized: 0,
          source_not_cleared: 0,
          candidate: evaluated.items.filter((item) => item.status === "candidate").length,
          ambiguous: evaluated.items.filter((item) => item.status === "ambiguous").length,
          low_signal: evaluated.items.filter((item) => item.status === "low_signal").length,
        }),
      );
      if (remaining <= 0) {
        truncated = true;
        break;
      }
    }
  }

  const sum = (pick: (counts: EvalFeedCounts) => number): number =>
    feeds.reduce((acc, feed) => acc + pick(feed), 0);
  const total = finalizeCounts("total", {
    fetched: sum((feed) => feed.fetched),
    parsed: sum((feed) => feed.parsed),
    invalid: sum((feed) => feed.invalid),
    stale: sum((feed) => feed.stale),
    oversized: sum((feed) => feed.oversized),
    source_not_cleared: sum((feed) => feed.source_not_cleared),
    candidate: sum((feed) => feed.candidate),
    ambiguous: sum((feed) => feed.ambiguous),
    low_signal: sum((feed) => feed.low_signal),
  });

  const report: EvalReport = {
    mode: input.mode,
    now: input.now,
    lookbackHours: input.lookbackHours,
    feeds,
    total,
    breakdowns: { byLocation, byGroup, byRole, byModifier },
    versions: {
      detRuleVersion: versions.rule,
      detGazetteerVersion: versions.gazetteer,
      detLexiconVersion: versions.lexicon,
    },
    labels:
      input.labels !== undefined && input.labels !== null
        ? computeLabelMetrics(allItems, input.labels)
        : null,
    truncated,
  };

  let reviewSample: ShadowEvalOutput["reviewSample"] = null;
  if (reviewLimit !== null) {
    // Review display needs recorded retention permission for every evaluated
    // source; with no clearance evidence the flag errors out.
    const permitted =
      input.registryRows !== undefined &&
      input.registryRows !== null &&
      feeds.every((feed) => {
        if (feed.sourceId === "total") return true;
        const row = input.registryRows?.[feed.sourceId];
        if (row === undefined) return false;
        let permissions;
        try {
          permissions = evaluateSourcePermissions(row, input.now, feed.sourceId);
        } catch {
          return false;
        }
        return permissions.titleRetention === true && permissions.descriptionRetention === true;
      });
    if (!permitted) {
      return { exitCode: 2, result: null, errors: [{ error_code: "review_not_permitted" }], reviewSample: null };
    }
    reviewSample = reviewPool.map((sample) => ({
      id: sample.id,
      title: truncateCodePoints(sample.title, EVAL_REVIEW_TRUNCATION_CODE_POINTS),
      excerpt: sample.excerpt === null ? null : truncateCodePoints(sample.excerpt, EVAL_REVIEW_TRUNCATION_CODE_POINTS),
    }));
    return { exitCode: errors.length > 0 ? 1 : 0, result: report, errors, reviewSample };
  }

  return { exitCode: errors.length > 0 ? 1 : 0, result: report, errors, reviewSample };
}

function truncateCodePoints(text: string, limit: number): string {
  return Array.from(text).slice(0, limit).join("");
}

function loadFixtureXmls(): { readonly sourceId: string; readonly xmlText: string }[] {
  const names = readdirSync(EVAL_FIXTURE_DIR)
    .filter((name) => name.startsWith("synthetic-") && name.endsWith(".xml"))
    .sort();
  return names.map((name) => ({
    sourceId: name.replace(/\.xml$/, ""),
    xmlText: readFileSync(join(EVAL_FIXTURE_DIR, name), "utf8"),
  }));
}

function readTextFile(path: string): { readonly ok: true; readonly text: string } | { readonly ok: false } {
  try {
    return { ok: true, text: readFileSync(path, "utf8") };
  } catch {
    return { ok: false };
  }
}

/** CLI entrypoint: parse args, load operator inputs, run, print, exit. */
export async function runShadowEvalCli(argv: readonly string[]): Promise<0 | 1 | 2> {
  const parsedArgs = parseEvalArgs(argv);
  if (!parsedArgs.ok) {
    process.stderr.write(`${JSON.stringify({ error_code: parsedArgs.errorCode })}\n`);
    return 2;
  }
  const options = parsedArgs.options;
  const now = options.nowOverride ?? new Date().toISOString();

  let registryRows: Record<string, RegistryPermissionRow> | null = null;
  if (options.registryPath !== null) {
    const file = readTextFile(options.registryPath);
    if (!file.ok) {
      process.stderr.write(`${JSON.stringify({ error_code: "REGISTRY_INVALID" })}\n`);
      return 2;
    }
    const snapshot = loadRegistrySnapshot(file.text);
    if (!snapshot.ok) {
      process.stderr.write(`${JSON.stringify({ error_code: "REGISTRY_INVALID" })}\n`);
      return 2;
    }
    registryRows = snapshot.rows;
  }

  let labels: readonly EvalLabelEntry[] | null = null;
  if (options.labelsPath !== null) {
    const file = readTextFile(options.labelsPath);
    if (!file.ok) {
      process.stderr.write(`${JSON.stringify({ error_code: "LABELS_INVALID" })}\n`);
      return 2;
    }
    const parsedLabels = parseLabelsFile(file.text);
    if (!parsedLabels.ok) {
      process.stderr.write(`${JSON.stringify({ error_code: "LABELS_INVALID" })}\n`);
      return 2;
    }
    labels = parsedLabels.labels;
  }
  const printOutput = (output: ShadowEvalOutput): 0 | 1 | 2 => {
    const result: EvalReport | null = output.result;
    for (const error of output.errors) {
      process.stderr.write(`${JSON.stringify({ sourceId: error.sourceId, error_code: error.error_code })}\n`);
    }
    if (result === null) return output.exitCode;
    const stdoutPayload =
      output.reviewSample === null ? result : { ...result, review_sample: output.reviewSample };
    process.stdout.write(`${JSON.stringify(stdoutPayload)}\n`);
    return output.exitCode;
  };

  if (options.live) {
    const output = await runShadowEval({
      mode: "live",
      lookbackHours: options.lookbackHours,
      now,
      liveSourceIds: options.sourceIds.length > 0 ? [...options.sourceIds] : undefined,
      registryRows,
      labels,
      reviewLimit: options.reviewLimit,
      timeoutMs: EVAL_FETCH_TIMEOUT_MS,
      maxBytes: MAX_EVAL_RESPONSE_BYTES,
    });
    return printOutput(output);
  }

  const fixtures = loadFixtureXmls();
  const output = await runShadowEval({
    mode: "synthetic",
    lookbackHours: options.lookbackHours,
    now,
    fixtureXmls: fixtures,
    registryRows,
    labels,
    reviewLimit: options.reviewLimit,
    timeoutMs: EVAL_FETCH_TIMEOUT_MS,
    maxBytes: MAX_EVAL_RESPONSE_BYTES,
  });
  return printOutput(output);
}


function isDirectExecution(): boolean {
  const entrypoint = process.argv[1];
  return entrypoint !== undefined && resolve(entrypoint) === fileURLToPath(import.meta.url);
}

if (isDirectExecution()) {
  void runShadowEvalCli(process.argv.slice(2))
    .then((exitCode) => {
      process.exitCode = exitCode;
    })
    .catch(() => {
      process.stderr.write(`${JSON.stringify({ error_code: "INTERNAL_ERROR" })}\n`);
      process.exitCode = 2;
    });
}
