import { createHash } from "node:crypto";
import {
  parseRssDiscoveryXml,
  type RssDiscoveryItem,
  type RssDiscoveryParseResult,
} from "./rss-discovery.js";
import {
  matchDeterministicRelevance,
  loadDeterministicDatasets,
} from "./deterministic-relevance.js";

/**
 * DET-FILTER-01: the versioned JSON datasets are the sole location/incident
 * vocabulary for RSS triage. The legacy `JAKARTA_TOPONYMS` /
 * `INCIDENT_KEYWORDS` string lists were removed; use `loadDeterministicDatasets()`
 * (re-exported here for tests) or `matchDeterministicRelevance()` instead.
 * `geographic-gazetteer.ts` keeps its own unrelated `JAKARTA_TOPONYMS`
 * (typed `GazetteerPlace[]` spatial hints) and is untouched by this task.
 */
export function loadRssDeterministicDatasets(): ReturnType<typeof loadDeterministicDatasets> {
  return loadDeterministicDatasets();
}

export const DEFAULT_LOCAL_NEWS_MAX_AGE_HOURS = 48;
export const DEFAULT_PROD_NEWS_MAX_AGE_HOURS = 6;

export function resolveNewsMaxAgeHours(maxAgeHours?: number): number {
  if (typeof maxAgeHours === "number" && Number.isFinite(maxAgeHours) && maxAgeHours > 0) {
    return maxAgeHours;
  }
  const envVal = typeof process !== "undefined" ? process.env?.NEWS_MAX_AGE_HOURS : undefined;
  if (envVal) {
    const parsed = Number(envVal);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }
  const isProd = typeof process !== "undefined" && process.env?.NODE_ENV === "production";
  return isProd ? DEFAULT_PROD_NEWS_MAX_AGE_HOURS : DEFAULT_LOCAL_NEWS_MAX_AGE_HOURS;
}

export interface ParseAndFilterNewsRssOptions {
  readonly maxAgeHours?: number;
}

export interface ClassifiedNewsItem {
  readonly guid: string;
  readonly title: string;
  readonly link: string;
  readonly pubDate: string | null;
  readonly descriptionExcerpt: string | null;
  readonly matchedToponyms: readonly string[];
  readonly matchedKeywords: readonly string[];
  readonly isLikelyRelevant: boolean;
}

/**
 * Bounded RSS description sanitizer (WJ-INT-02).
 * Strips tags, decodes common entities, collapses whitespace, NFKC-normalizes,
 * truncates to 2000 code points. Never fetches or parses full articles.
 */
export function sanitizeRssDescription(raw: string | null): string | null {
  if (raw === null || typeof raw !== "string") return null;
  const noTags = raw.replace(/<[^>]*>/g, " ");
  const decoded = noTags
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'");
  const collapsed = decoded.replace(/\s+/g, " ").trim().normalize("NFKC");
  if (collapsed.length === 0) return null;
  return Array.from(collapsed).slice(0, 2000).join("");
}

export interface PreparedNewsReportRevision {
  readonly report_revision_id: string;
  readonly source_id: string;
  readonly canonical_url: string;
  readonly source_revision_key: string | null;
  readonly content_hash: string;
  readonly permitted_text: string;
  readonly permitted_text_hash: string;
  readonly normalization_version: string;
  readonly published_at: string | null;
  readonly retrieved_at: string;
  readonly revision_status: "unreviewed";
  readonly evidence_chunks: readonly {
    readonly chunk_index: number;
    readonly text: string;
    readonly span_start: number;
    readonly span_end: number;
  }[];
}

export interface FilteredNewsResult {
  readonly totalParsed: number;
  /** Relevant kept items (`isLikelyRelevant === true`); kept volume is `keptCount`. */
  readonly matchedCount: number;
  /** All kept valid/fresh items (revisions built for every kept item). */
  readonly keptCount: number;
  readonly rejectedCount: number;
  readonly items: readonly ClassifiedNewsItem[];
  readonly revisions: readonly PreparedNewsReportRevision[];
}

export function classifyNewsItem(item: RssDiscoveryItem): {
  readonly isRelevant: boolean;
  readonly matchedToponyms: readonly string[];
  readonly matchedKeywords: readonly string[];
} {
  const title = item.title ?? "";
  const excerpt = sanitizeRssDescription(item.description);
  if (`${title}\n${excerpt ?? ""}`.trim().length === 0) {
    return { isRelevant: false, matchedToponyms: [], matchedKeywords: [] };
  }

  const result = matchDeterministicRelevance(title, excerpt);
  const matchedToponyms = result.locationMatches.map((match) => match.matchedAlias);
  const matchedKeywords = result.eventMatches.map((match) => match.matchedTerm);
  return { isRelevant: result.status === "candidate", matchedToponyms, matchedKeywords };
}
export function parseAndFilterNewsRss(
  xmlText: string,
  retrievedAt: string,
  sourceId: string = "source-antara-metro",
  optionsOrMaxAgeHours?: number | ParseAndFilterNewsRssOptions,
): FilteredNewsResult | { readonly error: string } {
  const maxAgeHours = typeof optionsOrMaxAgeHours === "number"
    ? optionsOrMaxAgeHours
    : optionsOrMaxAgeHours?.maxAgeHours;
  const effectiveMaxAgeHours = resolveNewsMaxAgeHours(maxAgeHours);
  const parseResult: RssDiscoveryParseResult = parseRssDiscoveryXml(xmlText, retrievedAt);
  if (parseResult.kind === "error") {
    return { error: parseResult.error.code };
  }

  const items: ClassifiedNewsItem[] = [];
  const revisions: PreparedNewsReportRevision[] = [];
  let rejectedCount = 0;

  for (const rawItem of parseResult.items) {
    if (!rawItem.title || !rawItem.link) {
      rejectedCount += 1;
      continue;
    }

    // Freshness check: discard items older than maxAgeHours from retrievedAt
    if (rawItem.pubDate) {
      const pubDateMs = Date.parse(rawItem.pubDate);
      const retrievedAtMs = Date.parse(retrievedAt);
      if (Number.isFinite(pubDateMs) && Number.isFinite(retrievedAtMs)) {
        const ageHours = (retrievedAtMs - pubDateMs) / (1000 * 60 * 60);
        if (ageHours > effectiveMaxAgeHours) {
          rejectedCount += 1;
          continue;
        }
      }
    }

    const { isRelevant, matchedToponyms, matchedKeywords } = classifyNewsItem(rawItem);

    const guid = rawItem.guid ?? rawItem.link;
    const descriptionExcerpt = sanitizeRssDescription(rawItem.description);
    const classified: ClassifiedNewsItem = {
      guid,
      title: rawItem.title.trim(),
      link: rawItem.link.trim(),
      pubDate: rawItem.pubDate,
      descriptionExcerpt,
      matchedToponyms,
      matchedKeywords,
      isLikelyRelevant: isRelevant,
    };
    items.push(classified);

    // WJ-INT-02B content-version identity: stable item identity across edits,
    // content hash over the authorized payload, revision id bound to both.
    const permittedText = descriptionExcerpt !== null
      ? `${classified.title}\n\n${descriptionExcerpt}`
      : classified.title;
    const permittedTextHash = sha256(permittedText);
    const contentHash = newsContentHash(permittedText, classified.link);
    const revisionId = newsRevisionId(sourceId, guid, contentHash);

    // Calculate code points for evidence spans (chunk 0 = title, chunk 1 = excerpt)
    const titleCodePoints = Array.from(classified.title).length;
    const fullCodePoints = Array.from(permittedText).length;
    const evidenceChunks: PreparedNewsReportRevision["evidence_chunks"] = descriptionExcerpt !== null
      ? [
        { chunk_index: 0, text: classified.title, span_start: 0, span_end: titleCodePoints },
        { chunk_index: 1, text: descriptionExcerpt, span_start: titleCodePoints + 2, span_end: fullCodePoints },
      ]
      : [
        { chunk_index: 0, text: permittedText, span_start: 0, span_end: fullCodePoints },
      ];

    revisions.push({
      report_revision_id: revisionId,
      source_id: sourceId,
      canonical_url: classified.link,
      source_revision_key: guid,
      content_hash: contentHash,
      permitted_text: permittedText,
      permitted_text_hash: permittedTextHash,
      normalization_version: "nfkc_v1",
      published_at: parsePubDate(classified.pubDate),
      retrieved_at: retrievedAt,
      revision_status: "unreviewed",
      evidence_chunks: evidenceChunks,
    });
  }

  return {
    totalParsed: parseResult.items.length,
    matchedCount: items.filter((entry) => entry.isLikelyRelevant).length,
    keptCount: items.length,
    rejectedCount,
    items,
    revisions,
  };
}

function parsePubDate(pubDate: string | null): string | null {
  if (pubDate === null) return null;
  const parsed = Date.parse(pubDate);
  if (!Number.isFinite(parsed)) return null;
  return new Date(parsed).toISOString();
}

function sha256(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}


/**
 * WJ-INT-02B content-version identity. `stableIdentity` (RSS guid, falling
 * back to link) never changes across edits; the content hash changes on any
 * authorized title/description edit; the revision id binds both so a new
 * content version is a new revision while the item stays the same.
 */
export function newsItemIdentityHash(sourceId: string, stableIdentity: string): string {
  if (!sourceId || typeof sourceId !== "string") {
    throw new TypeError("sourceId must be a non-empty string");
  }
  if (!stableIdentity || typeof stableIdentity !== "string") {
    throw new TypeError("stableIdentity (guid || link) must be a non-empty string");
  }
  return sha256(`${sourceId}|${stableIdentity}`);
}

export function newsContentHash(authorizedPermittedText: string, canonicalUrl: string): string {
  return sha256(`${canonicalUrl}:${authorizedPermittedText}`);
}

export function newsRevisionId(sourceId: string, stableIdentity: string, contentHash: string): string {
  return `rep-${sourceId}-${sha256(`${sourceId}|${stableIdentity}|${contentHash}`).slice(0, 16)}`;
}

export interface AuthorizedRevisionInputs {
  readonly title: string;
  readonly descriptionExcerpt: string | null;
  readonly canonicalUrl: string;
  readonly retrievedAt: string;
}

export interface AuthorizedRevisionPermissions {
  readonly titleRetention: boolean;
  readonly descriptionRetention: boolean;
}

interface AuthorizedChunkShape {
  readonly chunk_index: number;
  readonly text: string;
  readonly span_start: number;
  readonly span_end: number;
}

/**
 * WJ-INT-02B authorized-payload rebuild. Rebuilds the persisted revision from
 * ONLY the permitted parts: title when titleRetention holds (otherwise the
 * item cannot persist and this throws), plus the description excerpt only
 * when descriptionRetention holds. Hashes, revision id, and chunks all derive
 * from the authorized payload; every other field is preserved from storage.
 */
export function buildAuthorizedRevision(
  stored: {
    readonly report_revision_id: string;
    readonly source_id: string;
    readonly canonical_url: string;
    readonly source_revision_key?: string | null;
    readonly published_at?: string | null;
    readonly retrieved_at?: string;
    readonly revision_status?: "unreviewed";
  },
  classified: AuthorizedRevisionInputs,
  permissions: AuthorizedRevisionPermissions,
): {
  readonly report_revision_id: string;
  readonly source_id: string;
  readonly canonical_url: string;
  readonly permitted_text: string;
  readonly permitted_text_hash: string;
  readonly published_at: string | null;
  readonly retrieved_at: string;
  readonly revision_status: "unreviewed";
  readonly chunks: readonly AuthorizedChunkShape[];
  readonly content_hash: string;
  readonly source_revision_key: string | null;
} {
  if (!permissions.titleRetention) {
    throw new Error("TitleRetentionNotPermitted");
  }
  const stableIdentity = stored.source_revision_key ?? stored.canonical_url;
  const title = classified.title;
  const excerpt = permissions.descriptionRetention ? classified.descriptionExcerpt : null;
  const permittedText = excerpt !== null ? `${title}\n\n${excerpt}` : title;
  const permittedTextHash = sha256(permittedText);
  const contentHash = newsContentHash(permittedText, stored.canonical_url);
  const titleCodePoints = Array.from(title).length;
  const fullCodePoints = Array.from(permittedText).length;
  const chunks: readonly AuthorizedChunkShape[] = excerpt !== null
    ? [
      { chunk_index: 0, text: title, span_start: 0, span_end: titleCodePoints },
      { chunk_index: 1, text: excerpt, span_start: titleCodePoints + 2, span_end: fullCodePoints },
    ]
    : [
      { chunk_index: 0, text: permittedText, span_start: 0, span_end: fullCodePoints },
    ];
  return {
    report_revision_id: newsRevisionId(stored.source_id, stableIdentity, contentHash),
    source_id: stored.source_id,
    canonical_url: stored.canonical_url,
    permitted_text: permittedText,
    permitted_text_hash: permittedTextHash,
    published_at: stored.published_at ?? null,
    retrieved_at: classified.retrievedAt,
    revision_status: "unreviewed",
    chunks,
    content_hash: contentHash,
    source_revision_key: stored.source_revision_key ?? null,
  };
}
