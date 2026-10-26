import { createHash } from "node:crypto";
import {
  parseRssDiscoveryXml,
  type RssDiscoveryItem,
  type RssDiscoveryParseResult,
} from "./rss-discovery.js";

/** Daftar toponimi kecamatan, wilayah administrasi, dan koridor utama DKI Jakarta */
export const JAKARTA_TOPONYMS: readonly string[] = [
  // 5 Wilayah Administrasi
  "jakarta", "dki jakarta", "jakarta pusat", "jakarta selatan", "jakarta barat", "jakarta timur", "jakarta utara", "kepulauan seribu",
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
];

/** Kata kunci kejadian darurat, gangguan keselamatan, dan bencana perkotaan */
export const INCIDENT_KEYWORDS: readonly string[] = [
  "banjir", "genangan", "tergenang", "kebakaran", "api melahap", "damkar", "gulkarmat",
  "pohon tumbang", "kecelakaan", "tabrakan", "terguling", "tawuran", "bentrokan",
  "cuaca ekstrem", "hujan lebat", "angin kencang", "angin puting beliung", "amblas", "longsor",
  "rob", "tanggul", "pintu air", "siaga", "gempa",
];

export interface ClassifiedNewsItem {
  readonly guid: string;
  readonly title: string;
  readonly link: string;
  readonly pubDate: string | null;
  readonly matchedToponyms: readonly string[];
  readonly matchedKeywords: readonly string[];
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
  const title = (item.title ?? "").toLowerCase();
  if (title.length === 0) {
    return { isRelevant: false, matchedToponyms: [], matchedKeywords: [] };
  }

  const matchedToponyms = JAKARTA_TOPONYMS.filter((topo) => {
    // Exact word or boundary match
    const regex = new RegExp(`\\b${escapeRegex(topo)}\\b`, "iu");
    return regex.test(title);
  });

  const matchedKeywords = INCIDENT_KEYWORDS.filter((keyword) => {
    const regex = new RegExp(`\\b${escapeRegex(keyword)}\\b`, "iu");
    return regex.test(title);
  });

  const isRelevant = matchedToponyms.length > 0 && matchedKeywords.length > 0;
  return { isRelevant, matchedToponyms, matchedKeywords };
}

export function parseAndFilterNewsRss(
  xmlText: string,
  retrievedAt: string,
  sourceId: string = "source-antara-metro",
): FilteredNewsResult | { readonly error: string } {
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

    const { isRelevant, matchedToponyms, matchedKeywords } = classifyNewsItem(rawItem);
    if (!isRelevant) {
      rejectedCount += 1;
      continue;
    }

    const guid = rawItem.guid ?? rawItem.link;
    const classified: ClassifiedNewsItem = {
      guid,
      title: rawItem.title.trim(),
      link: rawItem.link.trim(),
      pubDate: rawItem.pubDate,
      matchedToponyms,
      matchedKeywords,
    };
    items.push(classified);

    // Prepare L1 report revision (ADR-005: title and headline excerpt only)
    const permittedText = classified.title;
    const permittedTextHash = sha256(permittedText);
    const contentHash = sha256(`${classified.link}:${permittedText}`);
    const revisionId = `rep-${sourceId}-${sha256(guid).slice(0, 16)}`;

    // Calculate code points for evidence span
    const codePointLength = Array.from(permittedText).length;

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
      evidence_chunks: [
        {
          chunk_index: 0,
          text: permittedText,
          span_start: 0,
          span_end: codePointLength,
        },
      ],
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
