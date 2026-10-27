import {
  parseAndFilterNewsRss,
  type PreparedNewsReportRevision,
} from "../layers/l1-data-knowledge/rss-news-ingest.js";

/** L1 -> L2 frozen contract: evidence chunk representation */
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

export const DEFAULT_POLL_TIMEOUT_MS = 20_000;

export type NewsFeedPollStatus = "success" | "fetch_error" | "timeout" | "parse_error";

export interface NewsFeedPollResult {
  readonly url: string;
  readonly sourceId: string;
  readonly status: NewsFeedPollStatus;
  readonly error?: string;
  readonly totalParsed: number;
  readonly matchedCount: number;
  readonly rejectedCount: number;
  readonly revisions: readonly StoredReportRevision[];
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
  });
  return arr;
}

async function pollSingleFeed(
  feed: NewsFeedConfig,
  retrievedAt: string,
  fetchFn: typeof fetch,
  timeoutMs: number,
  maxAgeHours?: number,
): Promise<NewsFeedPollResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new Error(`Request timed out after ${timeoutMs}ms`));
  }, timeoutMs);


  let xmlText: string;
  try {
    const response = await fetchFn(feed.url, {
      signal: controller.signal,
      headers: {
        "User-Agent": "WaspadaJakarta-NewsPoller/1.0",
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
        rejectedCount: 0,
        revisions: [],
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
      rejectedCount: 0,
      revisions: [],
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
        rejectedCount: 0,
        revisions: [],
      };
    }

    const revisions = parseResult.revisions.map(toStoredReportRevision);
    return {
      url: feed.url,
      sourceId: feed.sourceId,
      status: "success",
      totalParsed: parseResult.totalParsed,
      matchedCount: parseResult.matchedCount,
      rejectedCount: parseResult.rejectedCount,
      revisions,
    };
  } catch (error: unknown) {
    return {
      url: feed.url,
      sourceId: feed.sourceId,
      status: "parse_error",
      error: error instanceof Error ? error.message : String(error),
      totalParsed: 0,
      matchedCount: 0,
      rejectedCount: 0,
      revisions: [],
    };
  }
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
      return pollSingleFeed(feed, timestamp, fetchFn, timeoutMs, maxAgeHours);
    },

    async poll(): Promise<NewsPollResult> {
      const retrievedAt = now();
      const feedResults = await Promise.all(
        feeds.map((feed) => pollSingleFeed(feed, retrievedAt, fetchFn, timeoutMs, maxAgeHours)),
      );

      const seenKeys = new Set<string>();
      const allRevisions: StoredReportRevision[] = [];
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
      };

      return createNewsPollResult(summary);
    },
  };
}
