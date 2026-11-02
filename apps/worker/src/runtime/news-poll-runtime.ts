import { createHash } from "node:crypto";
import {
  buildAuthorizedRevision,
  parseAndFilterNewsRss,
  type PreparedNewsReportRevision,
} from "../layers/l1-data-knowledge/rss-news-ingest.js";
import {
  precheckNewsItem,
  triageNewsItemSemantic,
  type DeterministicTriageMode,
  type NewsTriageDecision,
  type TriageAuthorization,
  type TriageNewsItem,
} from "../layers/l1-data-knowledge/news-triage.js";
import {
  getDeterministicDatasetVersions,
  matchDeterministicRelevance,
  type DeterministicRelevanceResult,
} from "../layers/l1-data-knowledge/deterministic-relevance.js";
import { NEWS_TRIAGE_POLICY_VERSION } from "../../../db/src/news-triage-store.js";
export interface StoredEvidenceChunk {
  readonly chunk_index: number;
  readonly text: string;
  readonly span_start: number;
  readonly span_end: number;
}

/** L1 -> L2 frozen contract: report revision ready for AI grounding / review */
export interface StoredReportRevision {
  readonly report_revision_id: string;
  readonly source_id: string;
  readonly canonical_url: string;
  readonly permitted_text: string;
  readonly permitted_text_hash: string;
  readonly published_at: string | null;
  readonly retrieved_at: string;
  readonly revision_status: "unreviewed";
  readonly chunks: readonly StoredEvidenceChunk[];
  readonly evidence_chunks?: readonly StoredEvidenceChunk[];
  readonly content_hash?: string;
  readonly source_revision_key?: string | null;
  /** WJ-INT-02 triage outcome; present only when the poller ran the gate. */
  readonly triage?: NewsTriageDecision;
  /**
   * WJ-INT-02B retention capability fingerprint (§4): sha256 of the five
   * model/retention grants evaluated at poll time. The persist layer
   * recomputes it from the fresh registry row; mismatch blocks replay.
   */
  readonly permissionsFingerprint?: string;
}

/** WJ-INT-02A held triage decision: metadata only, never article content. */
export interface HeldTriageDecision {
  readonly sourceId: string;
  readonly itemIdentityHash: string;
  readonly reportRevisionId: string;
  readonly traceId: string;
  readonly canonicalUrl: string;
  readonly sourceRevisionKey: string | null;
  readonly decision: NewsTriageDecision;
  /**
   * WJ-INT-02B replay marker: true when the decision reuses a cached prior
   * evaluation instead of a fresh one. The persist layer skips writes for
   */
  readonly replayed?: boolean;
}

export interface NewsFeedConfig {
  readonly url: string;
  readonly sourceId: string;
  readonly maxAgeHours?: number;
}

export const DEFAULT_ANTARA_FEEDS: readonly NewsFeedConfig[] = [
  {
    url: "https://www.antaranews.com/rss/metro.xml",
    sourceId: "source-antara-metro",
  },
  {
    url: "https://www.antaranews.com/rss/hukum.xml",
    sourceId: "source-antara-hukum",
  },
];

/**
 * Verified high-reliability Indonesian news feeds covering emergency, disaster,
 * and safety incidents in Jakarta.
 */
export const DEFAULT_NEWS_FEEDS: readonly NewsFeedConfig[] = [
  // Antara News Agency (National News Wire & Specialized Incident Desks)
  {
    url: "https://www.antaranews.com/rss/metro.xml",
    sourceId: "source-antara-metro",
  },
  {
    url: "https://www.antaranews.com/rss/hukum.xml",
    sourceId: "source-antara-hukum",
  },
  {
    url: "https://www.antaranews.com/rss/terkini.xml",
    sourceId: "source-antara-terkini",
  },
  {
    url: "https://www.antaranews.com/rss/top-news.xml",
    sourceId: "source-antara-topnews",
  },
  {
    url: "https://www.antaranews.com/rss/humaniora.xml",
    sourceId: "source-antara-humaniora",
  },
  {
    url: "https://www.antaranews.com/rss/warta-bumi.xml",
    sourceId: "source-antara-wartabumi",
  },
  // Detikcom News (Realtime Incident & Emergency Reports)
  {
    url: "https://news.detik.com/berita/rss",
    sourceId: "source-detik-news",
  },
  {
    url: "https://news.detik.com/rss",
    sourceId: "source-detik-utama",
  },
  // CNN Indonesia (Verified National & Regional Incidents)
  {
    url: "https://www.cnnindonesia.com/nasional/rss",
    sourceId: "source-cnn-nasional",
  },
  {
    url: "https://www.cnnindonesia.com/rss",
    sourceId: "source-cnn-utama",
  },
  // CNBC Indonesia (City Infrastructure, Transport Disruption & Public Utilities)
  {
    url: "https://www.cnbcindonesia.com/news/rss",
    sourceId: "source-cnbc-news",
  },
  // SINDOnews (Metropolitan & Regional Incident Coverage)
  {
    url: "https://nasional.sindonews.com/rss",
    sourceId: "source-sindonews-nasional",
  },
  {
    url: "https://daerah.sindonews.com/rss",
    sourceId: "source-sindonews-daerah",
  },
  // Tempo.co (Investigative & National News Wire)
  {
    url: "https://rss.tempo.co/nasional",
    sourceId: "source-tempo-nasional",
  },
];
export const DEFAULT_POLL_TIMEOUT_MS = 20_000;

export type NewsFeedPollStatus = "success" | "fetch_error" | "timeout" | "parse_error";

export interface NewsFeedPollResult {
  readonly url: string;
  readonly sourceId: string;
  readonly status: NewsFeedPollStatus;
  readonly error?: string;
  readonly totalParsed: number;
  /** Relevant kept items (`parseAndFilterNewsRss().matchedCount`); kept volume is `keptCount`. */
  readonly matchedCount: number;
  /** All kept valid/fresh items. */
  readonly keptCount: number;
  readonly rejectedCount: number;
  readonly revisions: readonly StoredReportRevision[];
  /** WJ-INT-02A held decisions (drop/uncertain metadata only). */
  readonly held: readonly HeldTriageDecision[];
  /** WJ-INT-02 per-feed triage counts; present only when the gate ran. */
  readonly triageCounts?: NewsTriageCounts;
}

export interface NewsTriageCounts {
  readonly total: number;
  readonly ingested: number;
  readonly dropped: number;
  readonly uncertain: number;
  readonly authzRejected: number;
  readonly geoRejected: number;
  readonly nonActionable: number;
  readonly providerFailures: number;
  readonly byCategory: Readonly<Record<string, number>>;
  /** DET-FILTER-01 count-only observability (no content in logs). */
  readonly detConsidered: number;
  readonly detCandidate: number;
  readonly detAmbiguous: number;
  readonly detLowSignal: number;
  readonly detBroadOnly: number;
  readonly detSpecific: number;
  readonly detStrong: number;
  readonly detSupporting: number;
  readonly detAlertOnly: number;
  readonly detNonScene: number;
  readonly detUnknownRole: number;
  readonly detModelCallsSkipped: number;
  readonly detRuleVersion: string;
  readonly detGazetteerVersion: string;
  readonly detLexiconVersion: string;
}

export interface NewsPollSummary {
  readonly success: boolean;
  readonly polledAt: string;
  readonly totalFeeds: number;
  readonly successfulFeeds: number;
  readonly failedFeeds: number;
  readonly totalItemsParsed: number;
  readonly totalMatched: number;
  readonly totalRejected: number;
  readonly feedResults: readonly NewsFeedPollResult[];
  readonly revisions: readonly StoredReportRevision[];
  /** WJ-INT-02A held decisions across feeds (metadata only). */
  readonly held: readonly HeldTriageDecision[];
  /** WJ-INT-02 aggregated gate counts across feeds; present only when the gate ran. */
  readonly triageCounts?: NewsTriageCounts;
}

export type NewsPollResult = NewsPollSummary & readonly StoredReportRevision[];

export interface NewsPollRuntimeOptions {
  /** Feeds to poll; defaults to DEFAULT_ANTARA_FEEDS */
  readonly feeds?: readonly NewsFeedConfig[];
  /** Custom fetch function; defaults to global fetch */
  readonly fetchFn?: typeof fetch;
  /** Request timeout in ms; defaults to 20_000 (20s) */
  readonly timeoutMs?: number;
  /** Maximum article age in hours from retrievedAt to accept; defaults to NEWS_MAX_AGE_HOURS env (48h dev, 6h prod) */
  readonly maxAgeHours?: number;
  /** Timestamp generator; defaults to () => new Date().toISOString() */
  readonly now?: () => string;
  /** Optional callback invoked with filtered revisions */
  readonly onRevisions?: (revisions: readonly StoredReportRevision[]) => Promise<void> | void;
  /**
   * WJ-INT-02 gate wiring. When absent, the poller preserves its legacy
   * behavior (all valid fresh items returned, no triage attached).
   * Synthetic fixtures and unit tests only — live RSS ingestion MUST use
   * `createLiveNewsPollRuntime`, which requires an explicit gate.
   */
  readonly triage?: {
    /** Source remit label for the prompt, e.g. "metro news". */
    readonly sourceRemit?: string;
    /** Authorization check against source_registry; defaults to cleared. */
    readonly checkAuthorization?: (sourceId: string) => Promise<{ cleared: boolean }> | { cleared: boolean };
    /** One structured chat completion; transport failures become uncertain. */
    readonly callChat?: (system: string, user: string) => Promise<unknown>;
    /**
     * WJ-INT-02B persistent idempotency: cached decision for an identical
     * (identity, content, policy) evaluation. Defaults to a miss (null);
     * synthetic fixtures keep the in-memory default.
     */
    readonly findPriorDecision?: (key: {
      readonly itemIdentityHash: string;
      readonly contentHash: string;
      readonly policyVersion: string;
      /** Content-version pin for the provider-error retry budget (§4 revision id). */
      readonly reportRevisionId?: string;
      /**
       * WJ-INT-02B retention capability fingerprint (§4): changed
       * model/retention capabilities block replay and force fresh evaluation.
       * Display-only narrowing leaves the fingerprint unchanged (publish/read
       * gates still block redistribution downstream).
       */
      readonly permissionsFingerprint?: string;
    }) => Promise<NewsTriageDecision | null>;
    /** Triage policy version pinning the evaluation; defaults to the store version. */
    readonly policyVersion?: string;
    /** Max concurrent semantic calls; defaults to 4. */
    readonly concurrency?: number;
    /**
     * DET-FILTER-01 shadow/enforce switch. Default `shadow` (zero behavior
     * change). The live composition resolves this from
     * `NEWS_DETERMINISTIC_FILTER_MODE`; tests set it per-case.
     */
    readonly deterministicMode?: DeterministicTriageMode;
  };
}

export interface NewsPollRuntime {
  poll(): Promise<NewsPollResult>;
  pollFeed(feed: NewsFeedConfig, retrievedAt?: string): Promise<NewsFeedPollResult>;
}

export function toStoredReportRevision(
  prepared: PreparedNewsReportRevision,
): StoredReportRevision {
  const chunks: readonly StoredEvidenceChunk[] = prepared.evidence_chunks.map((c) => ({
    chunk_index: c.chunk_index,
    text: c.text,
    span_start: c.span_start,
    span_end: c.span_end,
  }));

  return {
    report_revision_id: prepared.report_revision_id,
    source_id: prepared.source_id,
    canonical_url: prepared.canonical_url,
    permitted_text: prepared.permitted_text,
    permitted_text_hash: prepared.permitted_text_hash,
    published_at: prepared.published_at,
    retrieved_at: prepared.retrieved_at,
    revision_status: "unreviewed",
    chunks,
    evidence_chunks: chunks,
    content_hash: prepared.content_hash,
    source_revision_key: prepared.source_revision_key,
  };
}

export function createNewsPollResult(summary: NewsPollSummary): NewsPollResult {
  const arr = [...summary.revisions] as unknown as NewsPollResult;
  Object.defineProperties(arr, {
    success: { value: summary.success, enumerable: true },
    polledAt: { value: summary.polledAt, enumerable: true },
    totalFeeds: { value: summary.totalFeeds, enumerable: true },
    successfulFeeds: { value: summary.successfulFeeds, enumerable: true },
    failedFeeds: { value: summary.failedFeeds, enumerable: true },
    totalItemsParsed: { value: summary.totalItemsParsed, enumerable: true },
    totalMatched: { value: summary.totalMatched, enumerable: true },
    totalRejected: { value: summary.totalRejected, enumerable: true },
    feedResults: { value: summary.feedResults, enumerable: true },
    revisions: { value: summary.revisions, enumerable: true },
    held: { value: summary.held ?? [], enumerable: true },
    ...(summary.triageCounts ? { triageCounts: { value: summary.triageCounts, enumerable: true } } : {}),
  });
  return arr;
}

/** DET-FILTER-01 count-only observability: increments counters from a verdict. */
function recordDeterministicCounters(
  counts: {
    detConsidered: number; detCandidate: number; detAmbiguous: number; detLowSignal: number;
    detBroadOnly: number; detSpecific: number; detStrong: number; detSupporting: number;
    detAlertOnly: number; detNonScene: number; detUnknownRole: number; detModelCallsSkipped: number;
  },
  verdict: DeterministicRelevanceResult,
): void {
  counts.detConsidered += 1;
  if (verdict.status === 'candidate') {
    counts.detCandidate += 1;
  } else if (verdict.status === 'ambiguous') {
    counts.detAmbiguous += 1;
  } else {
    counts.detLowSignal += 1;
  }
  if (verdict.locationMatches.some((match) => match.matchStrength === 'specific')) {
    counts.detSpecific += 1;
  }
  if (verdict.locationMatches.some((match) => match.matchStrength === 'broad_only')) {
    counts.detBroadOnly += 1;
  }
  if (verdict.eventMatches.some((match) => match.strength === 'strong')) {
    counts.detStrong += 1;
  }
  if (verdict.eventMatches.some((match) => match.strength === 'supporting')) {
    counts.detSupporting += 1;
  }
  if (verdict.eventMatches.some((match) => match.strength === 'alert_only')) {
    counts.detAlertOnly += 1;
  }
  if (verdict.locationRole === 'non_scene_or_reference') {
    counts.detNonScene += 1;
  } else if (verdict.locationRole === 'unknown') {
    counts.detUnknownRole += 1;
  }
}

/**
 * WJ-INT-02A gate: Stage A deterministic pre-check per item, then bounded
 * concurrent Stage B semantic triage. Ingest decisions keep their revision;
 * drop/uncertain decisions become held metadata (never article content).
 * Never throws: every failure path resolves to `uncertain`.
 */

export async function applyTriageGate(
  stored: readonly StoredReportRevision[],
  classified: ReadonlyArray<{ guid: string; title: string; descriptionExcerpt: string | null; link: string; pubDate: string | null }>,
  feed: NewsFeedConfig,
  retrievedAt: string,
  triage: NonNullable<NewsPollRuntimeOptions["triage"]>,
): Promise<{ revisions: StoredReportRevision[]; held: HeldTriageDecision[]; triageCounts: NewsTriageCounts }> {
  const byGuid = new Map(classified.map((c) => [c.guid, c]));
  const checkAuthorization = triage.checkAuthorization ?? (async () => ({ cleared: true }));
  const callChat = triage.callChat;
  // WJ-INT-02B persistent idempotency. Synthetic fixtures keep the in-memory
  // default (always miss); live ingestion supplies the composition lookup.
  const findPriorDecision = triage.findPriorDecision ?? (async () => null);
  const policyVersion = triage.policyVersion ?? NEWS_TRIAGE_POLICY_VERSION;
  const concurrency = Math.max(1, Math.min(triage.concurrency ?? 4, 8));
  const deterministicMode: DeterministicTriageMode = triage.deterministicMode ?? 'shadow';
  const detVersions = getDeterministicDatasetVersions();
  const detCounts = {
    detConsidered: 0, detCandidate: 0, detAmbiguous: 0, detLowSignal: 0,
    detBroadOnly: 0, detSpecific: 0, detStrong: 0, detSupporting: 0,
    detAlertOnly: 0, detNonScene: 0, detUnknownRole: 0, detModelCallsSkipped: 0,
  };
  const counts = {
    total: stored.length, ingested: 0, dropped: 0, uncertain: 0,
    authzRejected: 0, geoRejected: 0, nonActionable: 0, providerFailures: 0,
    ...detCounts,
    byCategory: {} as Record<string, number>,
    detRuleVersion: detVersions.rule,
    detGazetteerVersion: detVersions.gazetteer,
    detLexiconVersion: detVersions.lexicon,
  };
  const byCategory: Record<string, number> = counts.byCategory;
  const kept: StoredReportRevision[] = [];
  const heldOut: HeldTriageDecision[] = [];

  const tasks = stored.map((rev) => async (): Promise<void> => {
    const item = byGuid.get(rev.source_revision_key ?? "") ?? byGuid.get(rev.canonical_url);
    const identity = rev.source_revision_key ?? rev.canonical_url;
    const identityHash = createHash("sha256").update(`${rev.source_id}|${identity}`).digest("hex");
    const contentHash = rev.content_hash ?? rev.permitted_text_hash;
    // WJ-INT-02B concurrency note (§G): authorization, cache lookup, and the
    // model call below happen BEFORE the persistence xact lock, so two
    // overlapping polls can both observe a cache miss and issue duplicate
    // model calls for the same evaluation. This is accepted by design: no
    // long-lived transaction is held across the external model call, and no
    // new lock/queue infrastructure is introduced. Safety comes from the
    // persistence layer — the xact-scoped advisory lock plus the
    // conflict-before-early-return check make the second committer replay
    // idempotently (no duplicate revisions, jobs, or history corruption);
    // the bounded provider-error budget suppresses hot retry loops.
    // WJ-INT-02B authorization-first order: resolve the source capabilities
    // BEFORE consulting the cache. A cached decision never bypasses current
    // authorization — revoked or narrowed permissions re-evaluate instead.
    let authz: TriageAuthorization = { cleared: true };
    try {
      const result = await checkAuthorization(rev.source_id);
      if (result !== null && typeof result === "object") {
        authz = result as TriageAuthorization;
      }
    } catch {
      authz = { cleared: false, reason: "source_not_cleared" };
    }
    const permissionsFingerprint = createHash("sha256")
      .update(JSON.stringify({
        titleRetention: authz.permissions?.titleRetention === true,
        descriptionRetention: authz.permissions?.descriptionRetention === true,
        derivedRetention: authz.permissions?.derivedRetention === true,
        titleModel: authz.permissions?.titleModel === true,
        descriptionModel: authz.permissions?.descriptionModel === true,
      }), "utf8")
      .digest("hex");
    const permissionsAllowReplay =
      authz.cleared === true &&
      authz.permissions?.titleRetention === true &&
      authz.permissions?.derivedRetention === true &&
      (authz.permissions?.descriptionRetention === true || (item?.descriptionExcerpt ?? null) === null);
    let prior: NewsTriageDecision | null = null;
    if (permissionsAllowReplay) {
      try {
        prior = await findPriorDecision({
          itemIdentityHash: identityHash,
          contentHash,
          policyVersion,
          reportRevisionId: rev.report_revision_id,
          permissionsFingerprint,
        });
      } catch {
        // Lookup failure is not a cache miss: skip the replay and run the
        // fresh authorized evaluation below; the persist layer records it.
        prior = null;
      }
    }
    if (prior && permissionsAllowReplay) {
      if (prior.disposition === "ingest") {
        counts.ingested += 1;
        if (prior.primaryCategory) {
          byCategory[prior.primaryCategory] = (byCategory[prior.primaryCategory] ?? 0) + 1;
        }
        // The kept revision is rebuilt under the CURRENT permissions below
        // (same authorized path as a fresh evaluation); the cache supplies
        // only the disposition outcome, never raw text.
        const replayTitle = item?.title ?? rev.permitted_text.split("\n\n")[0] ?? "";
        const replayExcerpt = authz.permissions?.descriptionRetention === true
          ? (item?.descriptionExcerpt ?? null)
          : null;
        try {
          const rebuilt = buildAuthorizedRevision(
            rev,
            { title: replayTitle, descriptionExcerpt: replayExcerpt, canonicalUrl: rev.canonical_url, retrievedAt },
            { titleRetention: true, descriptionRetention: replayExcerpt !== null },
          );
          kept.push({ ...rev, ...rebuilt, evidence_chunks: rebuilt.chunks, triage: prior, permissionsFingerprint });
        } catch {
          counts.ingested -= 1;
          counts.uncertain += 1;
          heldOut.push({
            sourceId: rev.source_id,
            itemIdentityHash: identityHash,
            reportRevisionId: rev.report_revision_id,
            traceId: `trace-${rev.report_revision_id}`,
            canonicalUrl: rev.canonical_url,
            sourceRevisionKey: rev.source_revision_key ?? null,
            decision: {
              disposition: "uncertain",
              jakartaScope: prior.jakartaScope,
              actionability: prior.actionability,
              primaryCategory: prior.primaryCategory,
              incidentType: prior.incidentType,
              confidence: "low",
              reasonCodes: ["retention_not_permitted"],
              evidence: [],
              modelStatus: "not_cleared",
            },
          });
        }
      } else {
        if (prior.disposition === "drop") {
          counts.dropped += 1;
        } else {
          counts.uncertain += 1;
        }
        heldOut.push({
          sourceId: rev.source_id,
          itemIdentityHash: identityHash,
          reportRevisionId: rev.report_revision_id,
          traceId: `trace-${rev.report_revision_id}`,
          canonicalUrl: rev.canonical_url,
          sourceRevisionKey: rev.source_revision_key ?? null,
          decision: prior,
          replayed: true,
        });
      }
      return;
    }
    // Fresh evaluation continues with the capabilities resolved above
    // (single pass: Stage A and Stage B on the authorized excerpt only).
    // Never the original description when description-model use is denied;
    // never persist what retention denies (see below).
    const frozenAuthz = (): TriageAuthorization => authz;
    const excerptForPrompt =
      authz.permissions?.descriptionModel === true ? (item?.descriptionExcerpt ?? null) : null;
    const preparedTitle = item?.title ?? rev.permitted_text.split("\n\n")[0] ?? null;
    // DET-FILTER-01: run the pure prefilter on the SAME authorized text the
    // model would receive (title + authorized excerpt only). Never sees
    // unauthorized description text.
    let deterministic: DeterministicRelevanceResult | undefined;
    try {
      deterministic = matchDeterministicRelevance(preparedTitle ?? '', excerptForPrompt);
    } catch {
      deterministic = undefined;
    }
    if (deterministic !== undefined) {
      recordDeterministicCounters(detCounts, deterministic);
    }
    const hasStrongOrSupport = deterministic !== undefined && deterministic.eventMatches.some(
      (match) => match.strength === 'strong' || match.strength === 'supporting',
    );
    const hasSpecificOrBroad = deterministic !== undefined && deterministic.locationMatches.some(
      (match) => match.matchStrength === 'specific' || match.matchStrength === 'broad_only',
    );
    const prepared: TriageNewsItem = {
      sourceId: rev.source_id,
      stableIdentity: identity,
      title: preparedTitle,
      descriptionExcerpt: excerptForPrompt,
      link: rev.canonical_url,
      pubDate: item?.pubDate ?? rev.published_at,
      retrievedAt,
      keywordHit: hasStrongOrSupport,
      gazetteerHit: hasSpecificOrBroad,
      maxAgeHours: feed.maxAgeHours ?? 48,
      deterministic,
    };
    let stageA: Awaited<ReturnType<typeof precheckNewsItem>>;
    try {
      stageA = await precheckNewsItem(prepared, false, frozenAuthz, deterministicMode);
    } catch {
      stageA = { needsSemantic: false, decision: null };
    }
    let decisionResult: NewsTriageDecision | null = stageA.decision;
    if (!stageA.needsSemantic && deterministic !== undefined && deterministic.status !== 'candidate' && deterministicMode === 'enforce') {
      detCounts.detModelCallsSkipped += 1;
    }
    if (stageA.needsSemantic) {
      if (!callChat) {
        decisionResult = {
          disposition: "uncertain", jakartaScope: "unknown", actionability: "unknown",
          primaryCategory: null, incidentType: null, confidence: "low",
          reasonCodes: ["provider_error"], evidence: [], modelStatus: "provider_error",
        };
      } else {
        decisionResult = await triageNewsItemSemantic(
          {
            sourceId: rev.source_id,
            sourceRemit: triage.sourceRemit ?? "general news",
            title: prepared.title ?? "",
            descriptionExcerpt: prepared.descriptionExcerpt,
            pubDate: prepared.pubDate,
            retrievedAt,
          },
          callChat,
        );
      }
    }
    const finalDecision: NewsTriageDecision = decisionResult ?? {
      disposition: "uncertain", jakartaScope: "unknown", actionability: "unknown",
      primaryCategory: null, incidentType: null, confidence: "low",
      reasonCodes: ["provider_error"], evidence: [], modelStatus: "provider_error",
    };
    if (finalDecision.disposition === "ingest") {
      // Authorized-payload enforcement: persist ONLY permitted parts. Model
      // use without durable retention (title unretainable, an evaluated
      // excerpt that retention denies, or derived retention denied so no
      // chunks/embeddings/summaries may be derived) routes to held, never to
      // a revision. Never drop for this.
      const titleRetained = authz.permissions?.titleRetention === true;
      const excerptRetained = authz.permissions?.descriptionRetention === true;
      const derivedRetained = authz.permissions?.derivedRetention === true;
      if (!titleRetained || (prepared.descriptionExcerpt !== null && !excerptRetained) || !derivedRetained) {
        counts.uncertain += 1;
        heldOut.push({
          sourceId: rev.source_id,
          itemIdentityHash: identityHash,
          reportRevisionId: rev.report_revision_id,
          traceId: `trace-${rev.report_revision_id}`,
          canonicalUrl: rev.canonical_url,
          sourceRevisionKey: rev.source_revision_key ?? null,
          decision: {
            disposition: "uncertain",
            jakartaScope: finalDecision.jakartaScope,
            actionability: finalDecision.actionability,
            primaryCategory: finalDecision.primaryCategory,
            incidentType: finalDecision.incidentType,
            confidence: "low",
            reasonCodes: ["retention_not_permitted"],
            evidence: [],
            modelStatus: "not_cleared",
          },
        });
        return;
      }
      const title = prepared.title ?? rev.permitted_text.split("\n\n")[0] ?? "";
      let authorized: StoredReportRevision;
      try {
        const built = buildAuthorizedRevision(
          rev,
          {
            title,
            descriptionExcerpt: excerptRetained ? prepared.descriptionExcerpt : null,
            canonicalUrl: rev.canonical_url,
            retrievedAt,
          },
          { titleRetention: true, descriptionRetention: excerptRetained },
        );
        authorized = { ...rev, ...built, evidence_chunks: built.chunks };
      } catch {
        // TitleRetentionNotPermitted backstop: same held routing as above.
        counts.uncertain += 1;
        heldOut.push({
          sourceId: rev.source_id,
          itemIdentityHash: identityHash,
          reportRevisionId: rev.report_revision_id,
          traceId: `trace-${rev.report_revision_id}`,
          canonicalUrl: rev.canonical_url,
          sourceRevisionKey: rev.source_revision_key ?? null,
          decision: {
            disposition: "uncertain",
            jakartaScope: finalDecision.jakartaScope,
            actionability: finalDecision.actionability,
            primaryCategory: finalDecision.primaryCategory,
            incidentType: finalDecision.incidentType,
            confidence: "low",
            reasonCodes: ["retention_not_permitted"],
            evidence: [],
            modelStatus: "not_cleared",
          },
        });
        return;
      }
      counts.ingested += 1;
      if (finalDecision.primaryCategory) {
        byCategory[finalDecision.primaryCategory] = (byCategory[finalDecision.primaryCategory] ?? 0) + 1;
      }
      // The kept revision IS the authorized payload: hashes, chunks, revision
      // id, and the downstream job all derive from it. The caller persists it
      // atomically with the decision row.
      kept.push({ ...authorized, triage: finalDecision, permissionsFingerprint });
    } else {
      if (finalDecision.disposition === "drop") {
        counts.dropped += 1;
      } else {
        counts.uncertain += 1;
      }
      if (finalDecision.reasonCodes.includes("source_not_cleared")) counts.authzRejected += 1;
      if (finalDecision.jakartaScope === "outside_scope") counts.geoRejected += 1;
      if (finalDecision.reasonCodes.includes("non_actionable")) counts.nonActionable += 1;
      if (finalDecision.modelStatus === "provider_error" || finalDecision.modelStatus === "invalid_model_output") {
        counts.providerFailures += 1;
      }
      // Held decisions carry metadata only: no permitted_text, no chunks,
      // no title/description. The caller persists the audit row; nothing else.
      heldOut.push({
        sourceId: rev.source_id,
        itemIdentityHash: identityHash,
        reportRevisionId: rev.report_revision_id,
        traceId: `trace-${rev.report_revision_id}`,
        canonicalUrl: rev.canonical_url,
        sourceRevisionKey: rev.source_revision_key ?? null,
        decision: finalDecision,
      });
    }
  });
  for (let i = 0; i < tasks.length; i += concurrency) {
    await Promise.all(tasks.slice(i, i + concurrency).map((run) => run()));
  }

  return { revisions: kept, held: heldOut, triageCounts: counts };
}
async function pollSingleFeed(
  feed: NewsFeedConfig,
  retrievedAt: string,
  fetchFn: typeof fetch,
  timeoutMs: number,
  maxAgeHours?: number,
  triage?: NewsPollRuntimeOptions["triage"],
): Promise<NewsFeedPollResult> {
  // WJ-INT-02B acquisition enforcement (§3): an uncleared source is skipped
  // BEFORE any fetch or parse — no request, no bytes, no model use. Denied
  // when cleared is false, the lookup throws/returns nothing (fail closed),
  // or explicit permissions deny acquisition. Legacy callers returning a bare
  // { cleared: true } without permissions keep the old allow behavior.
  if (triage?.checkAuthorization) {
    let authz: TriageAuthorization | null = null;
    try {
      const result = await triage.checkAuthorization(feed.sourceId);
      if (result !== null && typeof result === "object") {
        authz = result as TriageAuthorization;
      }
    } catch {
      authz = null;
    }
    const denied = authz === null ||
      authz.cleared !== true ||
      (authz.permissions !== undefined && authz.permissions.acquisition !== true);
    if (denied) {
      return {
        url: feed.url,
        sourceId: feed.sourceId,
        status: "success",
        error: "source_not_cleared",
        totalParsed: 0,
        matchedCount: 0,
        keptCount: 0,
        rejectedCount: 0,
        revisions: [],
        held: [],
        triageCounts: {
          total: 0, ingested: 0, dropped: 0, uncertain: 0, authzRejected: 1,
          geoRejected: 0, nonActionable: 0, providerFailures: 0, byCategory: {},
          detConsidered: 0, detCandidate: 0, detAmbiguous: 0, detLowSignal: 0,
          detBroadOnly: 0, detSpecific: 0, detStrong: 0, detSupporting: 0,
          detAlertOnly: 0, detNonScene: 0, detUnknownRole: 0, detModelCallsSkipped: 0,
          detRuleVersion: '', detGazetteerVersion: '', detLexiconVersion: '',
        },
      };
    }
  }
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new Error(`Request timed out after ${timeoutMs}ms`));
  }, timeoutMs);


  let xmlText: string;
  try {
    const response = await fetchFn(feed.url, {
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 WaspadaJakarta-NewsPoller/1.0",
        "Accept": "application/rss+xml, application/xml, text/xml, */*",
      },
    });

    if (!response.ok) {
      return {
        url: feed.url,
        sourceId: feed.sourceId,
        status: "fetch_error",
        error: `HTTP ${response.status} ${response.statusText}`,
        totalParsed: 0,
        matchedCount: 0,
        keptCount: 0,
        rejectedCount: 0,
        revisions: [],
        held: [],
      };
    }

    xmlText = await response.text();
  } catch (error: unknown) {
    const isTimeout =
      controller.signal.aborted ||
      (error instanceof Error &&
        (error.name === "AbortError" ||
          error.name === "TimeoutError" ||
          error.message.includes("timed out")));

    return {
      url: feed.url,
      sourceId: feed.sourceId,
      status: isTimeout ? "timeout" : "fetch_error",
      error: error instanceof Error ? error.message : String(error),
      totalParsed: 0,
      matchedCount: 0,
      keptCount: 0,
      rejectedCount: 0,
      revisions: [],
      held: [],
    };
  } finally {
    clearTimeout(timer);
  }

  try {
    const effectiveMaxAge = feed.maxAgeHours ?? maxAgeHours;
    const parseResult = parseAndFilterNewsRss(xmlText, retrievedAt, feed.sourceId, effectiveMaxAge);
    if ("error" in parseResult) {
      return {
        url: feed.url,
        sourceId: feed.sourceId,
        status: "parse_error",
        error: `XML parse error: ${parseResult.error}`,
        totalParsed: 0,
        matchedCount: 0,
        keptCount: 0,
        rejectedCount: 0,
        revisions: [],
        held: [],
      };
    }

    const store = parseResult.revisions.map(toStoredReportRevision);
    const gated = triage
      ? await applyTriageGate(store, parseResult.items, feed, retrievedAt, triage)
      : { revisions: store, held: [], triageCounts: undefined };
    return {
      url: feed.url,
      sourceId: feed.sourceId,
      status: "success",
      totalParsed: parseResult.totalParsed,
      matchedCount: parseResult.matchedCount,
      keptCount: parseResult.keptCount,
      rejectedCount: parseResult.rejectedCount,
      revisions: gated.revisions,
      held: gated.held,
      ...(gated.triageCounts ? { triageCounts: gated.triageCounts } : {}),
    };
  } catch (error: unknown) {
    return {
      url: feed.url,
      sourceId: feed.sourceId,
      status: "parse_error",
      error: error instanceof Error ? error.message : String(error),
      totalParsed: 0,
      matchedCount: 0,
      keptCount: 0,
      rejectedCount: 0,
      revisions: [],
      held: [],
    };
  }
}

/**
 * WJ-INT-02A live news poller: synthetic/test-only legacy behavior is
 * preserved in `createNewsPollRuntime`; live RSS ingestion MUST use this
 * factory, which throws without an explicit triage gate.
 */
export function createLiveNewsPollRuntime(
  options: NewsPollRuntimeOptions & { readonly triage: NonNullable<NewsPollRuntimeOptions["triage"]> },
): NewsPollRuntime {
  if (!options.triage?.checkAuthorization || typeof options.triage.findPriorDecision !== "function") {
    throw new TypeError("live RSS ingestion requires authorization and idempotency dependencies");
  }
  return createNewsPollRuntime(options);
}

export function createNewsPollRuntime(
  options: NewsPollRuntimeOptions = {},
): NewsPollRuntime {
  const feeds = options.feeds ?? DEFAULT_ANTARA_FEEDS;
  const fetchFn = options.fetchFn ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_POLL_TIMEOUT_MS;
  const maxAgeHours = options.maxAgeHours;
  const now = options.now ?? (() => new Date().toISOString());

  return {
    async pollFeed(feed: NewsFeedConfig, retrievedAt?: string): Promise<NewsFeedPollResult> {
      const timestamp = retrievedAt ?? now();
      return pollSingleFeed(feed, timestamp, fetchFn, timeoutMs, maxAgeHours, options.triage);
    },

    async poll(): Promise<NewsPollResult> {
      const retrievedAt = now();
      const feedResults = await Promise.all(
        feeds.map((feed) => pollSingleFeed(feed, retrievedAt, fetchFn, timeoutMs, maxAgeHours, options.triage)),
      );

      const seenKeys = new Set<string>();
      const allRevisions: StoredReportRevision[] = [];
      const allHeld: HeldTriageDecision[] = [];
      const seenHeld = new Set<string>();
      let totalItemsParsed = 0;
      let totalMatched = 0;
      let totalRejected = 0;
      let successfulFeeds = 0;

      for (const result of feedResults) {
        if (result.status === "success") {
          successfulFeeds += 1;
        }
        totalItemsParsed += result.totalParsed;
        totalMatched += result.matchedCount;
        totalRejected += result.rejectedCount;

        for (const rev of result.revisions) {
          const dedupKey = rev.canonical_url || rev.report_revision_id;
          if (!seenKeys.has(dedupKey) && !seenKeys.has(rev.report_revision_id)) {
            seenKeys.add(dedupKey);
            seenKeys.add(rev.report_revision_id);
            allRevisions.push(rev);
          }
        }
        for (const held of result.held ?? []) {
          if (!seenHeld.has(held.itemIdentityHash)) {
            seenHeld.add(held.itemIdentityHash);
            allHeld.push(held);
          }
        }
      }

      if (options.onRevisions && allRevisions.length > 0) {
        await options.onRevisions(allRevisions);
      }

      const summary: NewsPollSummary = {
        success: feedResults.length > 0 && successfulFeeds === feedResults.length,
        polledAt: retrievedAt,
        totalFeeds: feedResults.length,
        successfulFeeds,
        failedFeeds: feedResults.length - successfulFeeds,
        totalItemsParsed,
        totalMatched,
        totalRejected,
        feedResults,
        revisions: allRevisions,
        held: allHeld,
        triageCounts: aggregateTriageCounts(feedResults),
      };

      return createNewsPollResult(summary);
    },
  };
}

function aggregateTriageCounts(results: readonly NewsFeedPollResult[]): NewsTriageCounts | undefined {
  if (!results.some((r) => r.triageCounts)) return undefined;
  const total = {
    total: 0, ingested: 0, dropped: 0, uncertain: 0, authzRejected: 0, geoRejected: 0,
    nonActionable: 0, providerFailures: 0,
    detConsidered: 0, detCandidate: 0, detAmbiguous: 0, detLowSignal: 0,
    detBroadOnly: 0, detSpecific: 0, detStrong: 0, detSupporting: 0,
    detAlertOnly: 0, detNonScene: 0, detUnknownRole: 0, detModelCallsSkipped: 0,
    detRuleVersion: '', detGazetteerVersion: '', detLexiconVersion: '',
  };
  const byCategory: Record<string, number> = {};
  for (const r of results) {
    const c = r.triageCounts;
    if (!c) continue;
    total.total += c.total; total.ingested += c.ingested; total.dropped += c.dropped;
    total.uncertain += c.uncertain; total.authzRejected += c.authzRejected;
    total.geoRejected += c.geoRejected; total.nonActionable += c.nonActionable;
    total.providerFailures += c.providerFailures;
    total.detConsidered += c.detConsidered; total.detCandidate += c.detCandidate;
    total.detAmbiguous += c.detAmbiguous; total.detLowSignal += c.detLowSignal;
    total.detBroadOnly += c.detBroadOnly; total.detSpecific += c.detSpecific;
    total.detStrong += c.detStrong; total.detSupporting += c.detSupporting;
    total.detAlertOnly += c.detAlertOnly; total.detNonScene += c.detNonScene;
    total.detUnknownRole += c.detUnknownRole; total.detModelCallsSkipped += c.detModelCallsSkipped;
    total.detRuleVersion = c.detRuleVersion;
    total.detGazetteerVersion = c.detGazetteerVersion;
    total.detLexiconVersion = c.detLexiconVersion;
    for (const [k, v] of Object.entries(c.byCategory)) byCategory[k] = (byCategory[k] ?? 0) + v;
  }
  return { ...total, byCategory };
}
