/**
 * Correlated Proposal Engine (Layer 2 Model Grounding).
 *
 * Integrates multi-source correlated clusters (from Layer 1 MultiSourceCorrelator)
 * into grounded schema 2.0 EventProposalDto records.
 *
 * When supported by >= 2 distinct sources (e.g. PetaBencana AND ANTARA News):
 * - Marks `is_multi_source: true`
 * - Sets `source_count: cluster.sources.length`
 * - Elevates claims with `is_corroborated: true` (recommending independent_corroboration)
 * - Fuses evidence chunks across all distinct report revisions into unified groundings.
 */

import type {
  CorrelatedIncidentCluster,
  IncidentCategory,
  StoredEvidenceChunk,
  StoredReportRevision,
} from "../l1-data-knowledge/multisource-correlator.js";

export type IncidentSeverity = "low" | "medium" | "high" | "critical";

export interface EventProposalClaimDto {
  readonly claim_id: string;
  readonly claim_text: string;
  readonly evidence_label: "under_review";
  readonly support_assessment: "supported";
  readonly quote_text: string;
  readonly evidence_ref_id: string;
  readonly is_corroborated?: boolean;
}

/** Frozen Contract 2: EventProposalDto Schema 2.0 with Corroboration */
export interface EventProposalDto {
  readonly schema_version: "2.0";
  readonly proposal_id: string;
  readonly title: string;
  readonly incident_type: IncidentCategory;
  readonly severity: IncidentSeverity;
  readonly event_time: {
    readonly precision: "exact" | "date" | "range" | "unknown";
    readonly value: string;
  };
  readonly location_label: string;
  readonly coordinates: readonly [longitude: number, latitude: number] | null;
  readonly claims: readonly EventProposalClaimDto[];
  readonly proposed_at: string;
  readonly is_multi_source?: boolean;
  readonly source_count?: number;
}

export interface ProposalEngineOptions {
  readonly proposedAt?: string;
}

/**
 * Extracts an exact substring from chunkText guaranteed to satisfy chunkText.includes(quote).
 */
function extractExactQuote(chunkText: string, searchKeywords: readonly string[]): string {
  if (!chunkText || chunkText.trim().length === 0) {
    return chunkText;
  }

  const rawSentences = chunkText.split(/(?<=[.!?\n])\s+/);
  let bestQuote = "";
  let bestScore = -1;

  for (const raw of rawSentences) {
    const trimmed = raw.trim();
    if (trimmed.length < 8) continue;
    if (!chunkText.includes(trimmed)) continue;

    let score = 0;
    const lower = trimmed.toLowerCase();
    for (const kw of searchKeywords) {
      if (kw && lower.includes(kw.toLowerCase())) {
        score += kw.length;
      }
    }

    if (score > bestScore) {
      bestScore = score;
      bestQuote = trimmed;
    }
  }

  if (bestQuote && chunkText.includes(bestQuote)) {
    return bestQuote;
  }

  const trimmedWhole = chunkText.trim();
  if (chunkText.includes(trimmedWhole)) {
    return trimmedWhole;
  }

  return chunkText;
}

/**
 * Evaluates incident severity based on combined report text.
 */
function detectCombinedSeverity(text: string): IncidentSeverity {
  const lower = text.toLowerCase();

  const criticalPatterns = [
    /\b(tewas|meninggal|korban\s+jiwa|jiwa\s+melayang|merenggut\s+nyawa)\b/,
    /\b(siaga\s+1|siaga\s+satu)\b/,
    /\b(kebakaran\s+hebat|ludes\s+terbakar|rata\s+dengan\s+tanah)\b/,
    /\b(ratusan\s+rumah\s+(?:terendam|tenggelam|hangus))\b/,
    /\b(puluhan\s+rumah\s+(?:hangus|ludes|terbakar))\b/,
    /\b([2-9]\s*meter|200\s*cm|[2-9][0-9]{2}\s*cm)\b/,
  ];
  for (const p of criticalPatterns) {
    if (p.test(lower)) return "critical";
  }

  const highPatterns = [
    /\b(luka\s+berat|luka\s+parah|kritis|dilarikan\s+ke\s+rumah\s+sakit|dilarikan\s+ke\s+rs)\b/,
    /\b(siaga\s+2|siaga\s+dua)\b/,
    /\b(1\s*meter|1[.,]5\s*meter|1[0-9]{2}\s*cm)\b/,
    /\b(lumpuh\s+total|terputus\s+total|evakuasi\s+warga|ratusan\s+warga\s+mengungsi)\b/,
    /\b(belasan\s+rumah\s+terbakar|puluhan\s+kios\s+terbakar)\b/,
    /\b(tabrakan\s+beruntun|ringsek\s+berat)\b/,
  ];
  for (const p of highPatterns) {
    if (p.test(lower)) return "high";
  }

  const lowPatterns = [
    /\b(siaga\s+4|siaga\s+empat)\b/,
    /\b([1-3][0-9]\s*cm|semata\s+kaki|dangkal|genangan\s+tipis)\b/,
    /\b(cepat\s+surut|berangsur\s+surut|sudah\s+surut)\b/,
    /\b(dapat\s+dilalui|bisa\s+dilalui\s+kendaraan|lancar)\b/,
    /\b(nihil\s+korban|tidak\s+ada\s+korban|hanya\s+dahan\s+kecil)\b/,
  ];
  for (const p of lowPatterns) {
    if (p.test(lower)) return "low";
  }

  return "medium";
}

/**
 * Extracts physical event time and precision across all report texts and metadata.
 */
function extractCombinedEventTime(
  reports: readonly StoredReportRevision[],
): { readonly precision: "exact" | "date" | "range" | "unknown"; readonly value: string } {
  for (const rep of reports) {
    const text = rep.permitted_text;
    const rangeMatch = text.match(
      /\b(?:antara|sejak|dari)\s*(?:pukul|jam)?\s*([0-2]?[0-9][.:][0-5][0-9])\s*(?:hingga|sampai|-)\s*(?:pukul|jam)?\s*([0-2]?[0-9][.:][0-5][0-9])/i,
    );
    if (rangeMatch) {
      return { precision: "range", value: rangeMatch[0] };
    }
  }

  for (const rep of reports) {
    const text = rep.permitted_text;
    const clockMatch = text.match(/\b(?:pukul|jam|pk\.?)\s*([0-2]?[0-9][.:][0-5][0-9])(?:\s*(?:wib|wita|wit))?\b/i);
    if (clockMatch && rep.published_at) {
      const datePart = rep.published_at.slice(0, 10);
      const timePart = clockMatch[1]!.replace(".", ":");
      const normalizedClock = `${datePart} ${timePart} WIB`;
      return { precision: "exact", value: normalizedClock };
    }
  }

  for (const rep of reports) {
    if (rep.published_at) {
      return { precision: "exact", value: rep.published_at };
    }
  }

  for (const rep of reports) {
    if (rep.retrieved_at) {
      return { precision: "date", value: rep.retrieved_at.slice(0, 10) };
    }
  }

  return { precision: "unknown", value: new Date().toISOString() };
}

/**
 * Generates human-readable Indonesian title based on category, location, and severity.
 */
function generateIndonesianTitle(
  category: IncidentCategory,
  locationLabel: string,
  severity: IncidentSeverity,
): string {
  let categoryName: string;
  switch (category) {
    case "flood":
      categoryName = severity === "low" ? "Genangan Air" : "Banjir";
      break;
    case "fire":
      categoryName = "Kebakaran";
      break;
    case "accident":
      categoryName = "Kecelakaan Lalu Lintas";
      break;
    case "tree_fall":
      categoryName = "Pohon Tumbang";
      break;
    case "crime":
      categoryName = "Gangguan Keamanan";
      break;
    case "weather":
      categoryName = "Cuaca Ekstrem";
      break;
  }
  return `${categoryName} di ${locationLabel}`;
}

/**
 * Resolves chunks from a report safely.
 */
function resolveChunks(report: StoredReportRevision): readonly StoredEvidenceChunk[] {
  if (Array.isArray(report.chunks) && report.chunks.length > 0) {
    return report.chunks;
  }
  if (typeof report.permitted_text === "string" && report.permitted_text.trim().length > 0) {
    return [
      {
        chunk_index: 0,
        text: report.permitted_text,
        span_start: 0,
        span_end: Array.from(report.permitted_text).length,
      },
    ];
  }
  return [];
}

/**
 * Generates an EventProposalDto (Schema 2.0) from a CorrelatedIncidentCluster.
 *
 * Fuses evidence chunks across all report revisions in the cluster.
 * If cluster is multi-source (sources >= 2):
 * - sets is_multi_source = true
 * - sets source_count = sources.length
 * - sets is_corroborated = true on each claim
 */
export function generateCorrelatedProposal(
  cluster: CorrelatedIncidentCluster,
  options?: ProposalEngineOptions,
): EventProposalDto {
  if (!cluster || !Array.isArray(cluster.reports) || cluster.reports.length === 0) {
    throw new TypeError("Cannot generate proposal from empty or malformed cluster");
  }

  const isMultiSource = cluster.is_multi_source || cluster.sources.length >= 2;
  const sourceCount = cluster.sources.length;

  const combinedText = cluster.reports.map((r) => r.permitted_text).join(" ");
  const severity = detectCombinedSeverity(combinedText);
  const event_time = extractCombinedEventTime(cluster.reports);
  const title = generateIndonesianTitle(cluster.primary_category, cluster.location_label, severity);

  const cleanClusterId = cluster.cluster_id.replace(/[^A-Za-z0-9._:-]/g, "-");
  const proposal_id = cleanClusterId.startsWith("prop-") ? cleanClusterId : `prop-${cleanClusterId}`;

  const searchKeywords = [
    cluster.primary_category,
    cluster.location_label.split(",")[0] ?? "",
    "ketinggian",
    "korban",
    "petugas",
    "evakuasi",
    "kondisi",
    "status",
    "genangan",
    "terbakar",
    "rusak",
  ];

  const claims: EventProposalClaimDto[] = [];

  // Fuse chunks across distinct reports
  for (let rIdx = 0; rIdx < cluster.reports.length; rIdx++) {
    const report = cluster.reports[rIdx]!;
    const chunks = resolveChunks(report);
    if (chunks.length === 0) continue;

    // Pick up to 2 representative chunks per report
    const selectedChunks = chunks.slice(0, 2);

    for (let cIdx = 0; cIdx < selectedChunks.length; cIdx++) {
      const chunk = selectedChunks[cIdx]!;
      const quoteText = extractExactQuote(chunk.text, searchKeywords);
      if (!quoteText) continue;

      let claimText: string;
      const isNewsSource =
        report.source_id.includes("antara") ||
        report.source_id.includes("news") ||
        report.source_id.includes("rss");
      const isSensorOrCitizen =
        report.source_id.includes("petabencana") ||
        report.source_id.includes("sensor") ||
        report.source_id.includes("citizen");

      if (isNewsSource) {
        claimText = `${title} dilaporkan melalui pemantauan media di wilayah kejadian.`;
      } else if (isSensorOrCitizen) {
        claimText = `Laporan observasi warga dan sensor lapangan mengonfirmasi kondisi di ${cluster.location_label}.`;
      } else if (claims.length === 0) {
        claimText = `${title} dilaporkan terjadi di lokasi kejadian.`;
      } else {
        claimText = `Dampak kejadian dengan tingkat keparahan ${severity} terpantau di sekitar ${cluster.location_label}.`;
      }

      claims.push({
        claim_id: `claim-${claims.length + 1}`,
        claim_text: claimText,
        evidence_label: "under_review",
        support_assessment: "supported",
        quote_text: quoteText,
        evidence_ref_id: `ref-${report.report_revision_id}-${chunk.chunk_index}`,
        is_corroborated: isMultiSource ? true : false,
      });

      // Cap at 4 claims max to keep proposal focused
      if (claims.length >= 4) break;
    }

    if (claims.length >= 4) break;
  }

  // Fallback claim if somehow no chunks produced a claim
  if (claims.length === 0) {
    const firstRep = cluster.reports[0]!;
    const firstText = firstRep.permitted_text.trim();
    claims.push({
      claim_id: "claim-1",
      claim_text: `${title} dilaporkan terjadi di lokasi.`,
      evidence_label: "under_review",
      support_assessment: "supported",
      quote_text: firstText.slice(0, 80),
      evidence_ref_id: `ref-${firstRep.report_revision_id}-0`,
      is_corroborated: isMultiSource ? true : false,
    });
  }

  const proposed_at =
    options?.proposedAt ?? cluster.reports[0]?.retrieved_at ?? new Date().toISOString();

  return {
    schema_version: "2.0",
    proposal_id,
    title,
    incident_type: cluster.primary_category,
    severity,
    event_time,
    location_label: cluster.location_label,
    coordinates: cluster.coordinates,
    claims,
    proposed_at,
    is_multi_source: isMultiSource,
    source_count: sourceCount,
  };
}
