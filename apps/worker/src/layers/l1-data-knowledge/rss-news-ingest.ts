import { createHash } from "node:crypto";
import {
  parseRssDiscoveryXml,
  type RssDiscoveryItem,
  type RssDiscoveryParseResult,
} from "./rss-discovery.js";

/** Daftar toponimi kecamatan, wilayah administrasi, dan koridor utama DKI Jakarta */
export const JAKARTA_TOPONYMS: readonly string[] = [
  // 5 Wilayah Administrasi & Singkatan Populer
  "jakarta", "dki jakarta", "jakarta pusat", "jakarta selatan", "jakarta barat", "jakarta timur", "jakarta utara", "kepulauan seribu",
  "jakpus", "jaksel", "jakbar", "jaktim", "jakut", "pulau tidung", "pulau pramuka", "pulau pari",
  // Jakarta Pusat (8 Kecamatan)
  "gambir", "sawah besar", "kemayoran", "senen", "cempaka putih", "menteng", "tanah abang", "johar baru",
  // Jakarta Selatan (10 Kecamatan)
  "kebayoran baru", "kebayoran lama", "pesanggrahan", "cilandak", "pasar minggu", "jagakarsa", "mampang prapatan", "pancoran", "tebet", "setiabudi",
  // Jakarta Barat (8 Kecamatan)
  "cengkareng", "grogol petamburan", "taman sari", "tambora", "kebon jeruk", "kalideres", "palmerah", "kembangan",
  // Jakarta Timur (10 Kecamatan)
  "matraman", "pulo gadung", "pulogadung", "jatinegara", "duren sawit", "kramat jati", "makasar", "pasar rebo", "ciracas", "cipayung", "cakung",
  // Jakarta Utara (6 Kecamatan)
  "koja", "kelapa gading", "tanjung priok", "pademangan", "penjaringan", "cilincing",
  // Koridor & Tempat Penting
  "sudirman", "thamrin", "gatot subroto", "rasuna said", "kuningan", "monas", "harmoni", "cawang", "rawamangun", "pluit", "ancol", "grogol",
  "pejompongan", "benhil", "kemang", "blok m", "petojo", "cideng", "glodok", "roxy", "manggarai", "slipi", "tomang", "kalibata",
  "gandaria", "senayan", "pondok indah", "fatmawati", "lebak bulus", "ragunan", "cipete", "bintaro", "pulomas", "klender", "cibubur", "salemba", "kramat",
  "semanggi", "dukuh atas", "casablanca", "antasari", "kampung rambutan", "pulo gebang", "csw",
];

/** Kata kunci kejadian darurat, gangguan keselamatan, dan bencana perkotaan */
export const INCIDENT_KEYWORDS: readonly string[] = [
  "banjir", "genangan", "tergenang", "tenggelam", "kebakaran", "api melahap", "damkar", "gulkarmat", "terbakar", "hangus",
  "pohon tumbang", "kecelakaan", "tabrakan", "terguling", "tabrak", "laka lantas", "tawuran", "bentrokan",
  "cuaca ekstrem", "hujan lebat", "angin kencang", "angin puting beliung", "amblas", "longsor", "ambruk", "runtuh",
  "rob", "tanggul", "pintu air", "siaga", "gempa", "evakuasi", "macet total", "ledakan",
  "tewas", "meninggal", "korban", "jenazah", "luka", "kritis", "pembunuhan", "penusukan", "penembakan", "begal", "pencurian", "rampok",
  // Disrupsi lalu lintas dan koridor transportasi
  "rekayasa lalu lintas", "rekayasa lalin", "penutupan jalan", "pengalihan arus", "contraflow", "macet parah",
  "antrean kendaraan", "tabrakan beruntun", "truk terguling", "transjakarta dialihkan", "rute distop",
  "krl anjlok", "gangguan persinyalan", "krl tertahan", "underpass tergenang", "jalan amblas", "catenary putus",
];
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
  readonly matchedCount: number;
  readonly rejectedCount: number;
  readonly items: readonly ClassifiedNewsItem[];
  readonly revisions: readonly PreparedNewsReportRevision[];
}

export function classifyNewsItem(item: RssDiscoveryItem): {
  readonly isRelevant: boolean;
  readonly matchedToponyms: readonly string[];
  readonly matchedKeywords: readonly string[];
} {
  const haystack = `${item.title ?? ""}\n${item.description ?? ""}`.toLowerCase();
  if (haystack.trim().length === 0) {
    return { isRelevant: false, matchedToponyms: [], matchedKeywords: [] };
  }

  const matchedToponyms = JAKARTA_TOPONYMS.filter((topo) => {
    // Exact word or boundary match
    const regex = new RegExp(`\\b${escapeRegex(topo)}\\b`, "iu");
    return regex.test(haystack);
  });

  const matchedKeywords = INCIDENT_KEYWORDS.filter((keyword) => {
    return haystack.includes(keyword.toLowerCase());
  });

  const isRelevant = matchedToponyms.length > 0 && matchedKeywords.length > 0;
  return { isRelevant, matchedToponyms, matchedKeywords };
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
    matchedCount: items.length,
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

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
