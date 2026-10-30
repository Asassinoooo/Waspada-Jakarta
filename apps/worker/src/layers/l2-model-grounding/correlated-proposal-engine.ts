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

export interface IncidentDiscrepancy {
  readonly kind: "water_depth" | "severity_assessment" | "casualty_count" | "operational_status";
  readonly description: string;
  readonly source_a: { readonly source_id: string; readonly claim_text: string };
  readonly source_b: { readonly source_id: string; readonly claim_text: string };
}

/** Frozen Contract 2: EventProposalDto Schema 2.0 with Corroboration & Discrepancies */
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
  readonly has_discrepancy?: boolean;
  readonly discrepancies?: readonly IncidentDiscrepancy[];
  readonly caveats?: readonly string[];
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
 * - detects cross-source discrepancies across quantitative and qualitative indicators
 */

interface ExtractedDepth {
  readonly valueInCm: number;
  readonly rawText: string;
  readonly sentence: string;
}

function parseDepthInCm(rawNum: string, unitStr: string): number | null {
  const normalizedNum = parseFloat(rawNum.replace(",", "."));
  if (isNaN(normalizedNum) || normalizedNum <= 0) return null;
  const unit = unitStr.toLowerCase();
  if (unit === "m" || unit === "meter") {
    // Distances > 10m are not flood water depth in urban Jakarta
    if (normalizedNum > 10) return null;
    return Math.round(normalizedNum * 100);
  }
  if (unit === "cm") {
    if (normalizedNum > 1000) return null;
    return Math.round(normalizedNum);
  }
  return null;
}

function extractDepthsFromReport(report: StoredReportRevision): readonly ExtractedDepth[] {
  const depths: ExtractedDepth[] = [];
  const textsToSearch: string[] = [];
  if (report.chunks && report.chunks.length > 0) {
    for (const chunk of report.chunks) {
      if (chunk.text) textsToSearch.push(chunk.text);
    }
  }
  if (textsToSearch.length === 0 && report.permitted_text) {
    textsToSearch.push(report.permitted_text);
  }

  const depthPattern = /\b(\d+(?:[.,]\d+)?)\s*(cm|meter|m)\b/gi;

  for (const text of textsToSearch) {
    const sentences = text.split(/(?<=[.!?\n])\s+/);
    for (const rawSentence of sentences) {
      const sentence = rawSentence.trim();
      if (!sentence) continue;
      depthPattern.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = depthPattern.exec(sentence)) !== null) {
        const val = parseDepthInCm(match[1]!, match[2]!);
        if (val !== null) {
          depths.push({
            valueInCm: val,
            rawText: match[0],
            sentence,
          });
        }
      }
    }
  }

  return depths;
}

function findDepthDiscrepancy(
  reportA: StoredReportRevision,
  reportB: StoredReportRevision,
): IncidentDiscrepancy | null {
  const depthsA = extractDepthsFromReport(reportA);
  const depthsB = extractDepthsFromReport(reportB);
  if (depthsA.length === 0 || depthsB.length === 0) return null;

  let maxDiff = -1;
  let bestA: ExtractedDepth | null = null;
  let bestB: ExtractedDepth | null = null;

  for (const dA of depthsA) {
    for (const dB of depthsB) {
      const diff = Math.abs(dA.valueInCm - dB.valueInCm);
      if (diff > maxDiff) {
        maxDiff = diff;
        bestA = dA;
        bestB = dB;
      }
    }
  }

  let minDiff = Infinity;
  for (const dA of depthsA) {
    for (const dB of depthsB) {
      const diff = Math.abs(dA.valueInCm - dB.valueInCm);
      if (diff < minDiff) {
        minDiff = diff;
      }
    }
  }

  if (bestA && bestB && minDiff >= 30) {
    return {
      kind: "water_depth",
      description: `Perbedaan laporan ketinggian air: ${reportA.source_id} (${bestA.valueInCm} cm) vs ${reportB.source_id} (${bestB.valueInCm} cm) dengan selisih ${Math.abs(bestA.valueInCm - bestB.valueInCm)} cm.`,
      source_a: {
        source_id: reportA.source_id,
        claim_text: bestA.sentence || `${bestA.valueInCm} cm`,
      },
      source_b: {
        source_id: reportB.source_id,
        claim_text: bestB.sentence || `${bestB.valueInCm} cm`,
      },
    };
  }

  return null;
}

interface ExtractedCasualty {
  readonly count: number;
  readonly isNihil: boolean;
  readonly rawText: string;
  readonly sentence: string;
}

const ZERO_CASUALTY_PATTERNS: readonly RegExp[] = [
  /\b(?:nihil|tidak\s+ada)\s+(?:laporan\s+)?(?:korban(?:\s+jiwa)?|jiwa|orang\s+(?:tewas|meninggal|luka))\b/i,
  /\b(?:korban(?:\s+jiwa)?)\s*[:=-]?\s*(?:nihil|tidak\s+ada|0\b)/i,
  /\b0\s*(?:orang\s+)?(?:korban|tewas|meninggal|luka|kritis)\b/i,
  /\bkorban\s+jiwa\s+nihil\b/i,
  /\bkorban\s+nihil\b/i,
  /\bnihil\s+korban\b/i,
  /\btidak\s+ada\s+korban\b/i,
];

const POSITIVE_CASUALTY_PATTERN = /\b(\d+)\s*(?:orang\s+)?(?:korban(?:\s+jiwa)?|tewas|meninggal|luka(?:-luka)?|kritis)\b/gi;

function extractCasualtiesFromReport(report: StoredReportRevision): readonly ExtractedCasualty[] {
  const casualties: ExtractedCasualty[] = [];
  const textsToSearch: string[] = [];
  if (report.chunks && report.chunks.length > 0) {
    for (const chunk of report.chunks) {
      if (chunk.text) textsToSearch.push(chunk.text);
    }
  }
  if (textsToSearch.length === 0 && report.permitted_text) {
    textsToSearch.push(report.permitted_text);
  }

  for (const text of textsToSearch) {
    const sentences = text.split(/(?<=[.!?\n])\s+/);
    for (const rawSentence of sentences) {
      const sentence = rawSentence.trim();
      if (!sentence) continue;

      let matchedZero = false;
      for (const zp of ZERO_CASUALTY_PATTERNS) {
        const m = zp.exec(sentence);
        if (m) {
          casualties.push({
            count: 0,
            isNihil: true,
            rawText: m[0],
            sentence,
          });
          matchedZero = true;
          break;
        }
      }

      if (matchedZero) continue;

      POSITIVE_CASUALTY_PATTERN.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = POSITIVE_CASUALTY_PATTERN.exec(sentence)) !== null) {
        const count = parseInt(m[1]!, 10);
        if (count === 0) {
          casualties.push({
            count: 0,
            isNihil: true,
            rawText: m[0],
            sentence,
          });
        } else if (!isNaN(count) && count > 0) {
          casualties.push({
            count,
            isNihil: false,
            rawText: m[0],
            sentence,
          });
        }
      }
    }
  }

  return casualties;
}

function findCasualtyDiscrepancy(
  reportA: StoredReportRevision,
  reportB: StoredReportRevision,
): IncidentDiscrepancy | null {
  const casA = extractCasualtiesFromReport(reportA);
  const casB = extractCasualtiesFromReport(reportB);
  if (casA.length === 0 || casB.length === 0) return null;

  for (const cA of casA) {
    for (const cB of casB) {
      if (cA.isNihil && cB.count >= 1) {
        return {
          kind: "casualty_count",
          description: `Perbedaan laporan korban jiwa/luka: ${reportA.source_id} melaporkan nihil/0 korban vs ${reportB.source_id} melaporkan ${cB.count} korban.`,
          source_a: {
            source_id: reportA.source_id,
            claim_text: cA.sentence || cA.rawText,
          },
          source_b: {
            source_id: reportB.source_id,
            claim_text: cB.sentence || cB.rawText,
          },
        };
      }
      if (cB.isNihil && cA.count >= 1) {
        return {
          kind: "casualty_count",
          description: `Perbedaan laporan korban jiwa/luka: ${reportB.source_id} melaporkan nihil/0 korban vs ${reportA.source_id} melaporkan ${cA.count} korban.`,
          source_a: {
            source_id: reportA.source_id,
            claim_text: cA.sentence || cA.rawText,
          },
          source_b: {
            source_id: reportB.source_id,
            claim_text: cB.sentence || cB.rawText,
          },
        };
      }

      if (!cA.isNihil && !cB.isNihil && cA.count !== cB.count) {
        return {
          kind: "casualty_count",
          description: `Perbedaan laporan jumlah korban: ${reportA.source_id} (${cA.count} korban) vs ${reportB.source_id} (${cB.count} korban).`,
          source_a: {
            source_id: reportA.source_id,
            claim_text: cA.sentence || cA.rawText,
          },
          source_b: {
            source_id: reportB.source_id,
            claim_text: cB.sentence || cB.rawText,
          },
        };
      }
    }
  }

  return null;
}

interface DetectedStatus {
  readonly group: "flood_recession" | "traffic_flow" | "fire_suppression";
  readonly side: "positive" | "negative";
  readonly label: string;
  readonly matchedText: string;
  readonly sentence: string;
}

const OPERATIONAL_STATUS_PATTERNS = [
  // Flood status
  {
    group: "flood_recession" as const,
    side: "positive" as const,
    pattern: /\b(sudah\s+surut|telah\s+surut|air\s+surut|surut\s+total|genangan\s+surut|berangsur\s+surut|kondisi\s+surut)\b/i,
    label: "sudah surut",
  },
  {
    group: "flood_recession" as const,
    side: "negative" as const,
    pattern: /\b(masih\s+tergenang|belum\s+surut|masih\s+terendam|tergenang\s+banjir|air\s+masih\s+tinggi|banjir\s+masih\s+merendam)\b/i,
    label: "masih tergenang",
  },

  // Traffic status
  {
    group: "traffic_flow" as const,
    side: "positive" as const,
    pattern: /\b(arus\s+lancar|lancar\s+terkendali|lalu\s+lintas\s+lancar|lalin\s+lancar|sudah\s+dapat\s+dilalui|bisa\s+dilalui\s+kendaraan|arus\s+normal)\b/i,
    label: "arus lancar",
  },
  {
    group: "traffic_flow" as const,
    side: "negative" as const,
    pattern: /\b(macet\s+total|jalan\s+ditutup|lalin\s+lumpuh|lalu\s+lintas\s+lumpuh|ditutup\s+total|akses\s+ditutup|akses\s+terputus)\b/i,
    label: "macet total / jalan ditutup",
  },

  // Fire suppression status
  {
    group: "fire_suppression" as const,
    side: "positive" as const,
    pattern: /\b(sudah\s+padam|telah\s+padam|berhasil\s+dipadamkan|api\s+padam|proses\s+pendinginan)\b/i,
    label: "sudah padam",
  },
  {
    group: "fire_suppression" as const,
    side: "negative" as const,
    pattern: /\b(api\s+masih\s+berkobar|masih\s+terbakar|api\s+merembet|belum\s+padam|masih\s+menyala)\b/i,
    label: "api masih berkobar",
  },
];

function extractOperationalStatuses(report: StoredReportRevision): readonly DetectedStatus[] {
  const statuses: DetectedStatus[] = [];
  const textsToSearch: string[] = [];
  if (report.chunks && report.chunks.length > 0) {
    for (const chunk of report.chunks) {
      if (chunk.text) textsToSearch.push(chunk.text);
    }
  }
  if (textsToSearch.length === 0 && report.permitted_text) {
    textsToSearch.push(report.permitted_text);
  }

  for (const text of textsToSearch) {
    const sentences = text.split(/(?<=[.!?\n])\s+/);
    for (const rawSentence of sentences) {
      const sentence = rawSentence.trim();
      if (!sentence) continue;

      for (const item of OPERATIONAL_STATUS_PATTERNS) {
        const m = item.pattern.exec(sentence);
        if (m) {
          statuses.push({
            group: item.group,
            side: item.side,
            label: item.label,
            matchedText: m[0],
            sentence,
          });
        }
      }
    }
  }

  return statuses;
}

function findOperationalStatusDiscrepancy(
  reportA: StoredReportRevision,
  reportB: StoredReportRevision,
): IncidentDiscrepancy | null {
  const statusesA = extractOperationalStatuses(reportA);
  const statusesB = extractOperationalStatuses(reportB);
  if (statusesA.length === 0 || statusesB.length === 0) return null;

  for (const sA of statusesA) {
    for (const sB of statusesB) {
      if (sA.group === sB.group && sA.side !== sB.side) {
        return {
          kind: "operational_status",
          description: `Perbedaan status operasional: ${reportA.source_id} melaporkan "${sA.matchedText}" vs ${reportB.source_id} melaporkan "${sB.matchedText}".`,
          source_a: {
            source_id: reportA.source_id,
            claim_text: sA.sentence || sA.matchedText,
          },
          source_b: {
            source_id: reportB.source_id,
            claim_text: sB.sentence || sB.matchedText,
          },
        };
      }
    }
  }

  return null;
}

const SEVERITY_RANK: Record<IncidentSeverity, number> = {
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

function findSeverityDiscrepancy(
  reportA: StoredReportRevision,
  reportB: StoredReportRevision,
): IncidentDiscrepancy | null {
  const sevA = detectCombinedSeverity(reportA.permitted_text);
  const sevB = detectCombinedSeverity(reportB.permitted_text);

  if (Math.abs(SEVERITY_RANK[sevA] - SEVERITY_RANK[sevB]) >= 2) {
    return {
      kind: "severity_assessment",
      description: `Perbedaan penilaian tingkat keparahan: ${reportA.source_id} (${sevA}) vs ${reportB.source_id} (${sevB}).`,
      source_a: {
        source_id: reportA.source_id,
        claim_text: extractExactQuote(reportA.permitted_text, [sevA, "parah", "kritis", "korban", "rusak", "ringan"]),
      },
      source_b: {
        source_id: reportB.source_id,
        claim_text: extractExactQuote(reportB.permitted_text, [sevB, "parah", "kritis", "korban", "rusak", "ringan"]),
      },
    };
  }

  return null;
}

/**
 * Detects discrepancies across heterogeneous reports in an incident cluster.
 */
export function detectIncidentDiscrepancies(
  reports: readonly StoredReportRevision[],
): readonly IncidentDiscrepancy[] {
  if (!reports || reports.length < 2) return [];

  const discrepancies: IncidentDiscrepancy[] = [];

  for (let i = 0; i < reports.length - 1; i++) {
    for (let j = i + 1; j < reports.length; j++) {
      const repA = reports[i]!;
      const repB = reports[j]!;

      // Discrepancy detection is strictly cross-source
      if (repA.source_id === repB.source_id) continue;

      // 1. Water depth quantitative check
      const depthDisc = findDepthDiscrepancy(repA, repB);
      if (depthDisc) {
        discrepancies.push(depthDisc);
      }

      // 2. Casualty / injuries check
      const casDisc = findCasualtyDiscrepancy(repA, repB);
      if (casDisc) {
        discrepancies.push(casDisc);
      }

      // 3. Operational status check
      const statusDisc = findOperationalStatusDiscrepancy(repA, repB);
      if (statusDisc) {
        discrepancies.push(statusDisc);
      }

      // 4. Severity divergence (if not already flagged for depth or casualty)
      if (!depthDisc && !casDisc) {
        const sevDisc = findSeverityDiscrepancy(repA, repB);
        if (sevDisc) {
          discrepancies.push(sevDisc);
        }
      }
    }
  }

  // Deduplicate discrepancies by kind and source pair
  const seen = new Set<string>();
  const unique: IncidentDiscrepancy[] = [];
  for (const d of discrepancies) {
    const key = [d.kind, d.source_a.source_id, d.source_b.source_id].sort().join("::");
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(d);
    }
  }

  return unique;
}

export function generateCorrelatedProposal(
  cluster: CorrelatedIncidentCluster,
  options?: ProposalEngineOptions,
): EventProposalDto {
  if (!cluster || !Array.isArray(cluster.reports) || cluster.reports.length === 0) {
    throw new TypeError("Cannot generate proposal from empty or malformed cluster");
  }

  const isMultiSource = cluster.is_multi_source || cluster.sources.length >= 2;
  const sourceCount = cluster.sources.length;

  // Cross-source discrepancy detection
  const discrepancies = isMultiSource ? detectIncidentDiscrepancies(cluster.reports) : [];
  const hasDiscrepancy = discrepancies.length > 0;

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
        report.source_id.includes("rss") ||
        report.source_id.includes("detik") ||
        report.source_id.includes("cnn") ||
        report.source_id.includes("kompas") ||
        report.source_id.includes("tempo") ||
        report.source_id.includes("tribun");
      const isSensorOrCitizen =
        report.source_id.includes("petabencana") ||
        report.source_id.includes("sensor") ||
        report.source_id.includes("citizen") ||
        report.source_id.includes("lapor") ||
        report.source_id.includes("warga") ||
        report.source_id.includes("jaki");
      const isOfficialOrDispatch =
        report.source_id.includes("tmc") ||
        report.source_id.includes("dishub") ||
        report.source_id.includes("bpbd") ||
        report.source_id.includes("damkar") ||
        report.source_id.includes("polisi");

      if (isNewsSource) {
        claimText = `${title} dilaporkan melalui pemantauan media di wilayah kejadian.`;
      } else if (isSensorOrCitizen) {
        claimText = `Laporan observasi warga dan sensor lapangan mengonfirmasi kondisi di ${cluster.location_label}.`;
      } else if (isOfficialOrDispatch) {
        claimText = `Laporan dinas dan petugas lapangan mengonfirmasi kondisi di ${cluster.location_label}.`;
      } else if (claims.length === 0) {
        claimText = `${title} dilaporkan terjadi di lokasi kejadian.`;
      } else {
        claimText = `Dampak kejadian dengan tingkat keparahan ${severity} terpantau di sekitar ${cluster.location_label}.`;
      }

      // Check if this report is involved in any discrepancy
      const relevantDiscrepancy = discrepancies.find(
        (d) => d.source_a.source_id === report.source_id || d.source_b.source_id === report.source_id,
      );
      if (relevantDiscrepancy) {
        claimText += ` (Catatan: Terdapat perbedaan data antar-sumber terkait ${relevantDiscrepancy.kind.replace(/_/g, " ")}).`;
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

  const caveats = hasDiscrepancy
    ? discrepancies.map((d) => `Perbedaan keterangan sumber (${d.kind}): ${d.description}`)
    : [];

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
    has_discrepancy: hasDiscrepancy,
    discrepancies,
    ...(caveats.length > 0 ? { caveats } : {}),
  };
}
