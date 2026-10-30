/**
 * Multi-Source Correlator (Layer 1 Data Knowledge).
 *
 * Provides semantic retrieval, evidence-based cross-source correlation,
 * and deterministic duplicate suppression across heterogeneous reports
 * (PetaBencana citizen observations, RSS news feeds, BMKG weather alerts,
 * and push webhooks).
 *
 * Replaces hard-coded rule matrices with semantic candidate discovery,
 * flexible categorization, and explicit uncertainty handling.
 */

import {
  JAKARTA_ENVELOPE,
  JAKARTA_GAZETTEER,
  JAKARTA_TOPONYMS,
  haversineDistanceMeters,
  findJakartaToponym,
  extractCoordinatesHint,
  isCoordinateInJakarta,
  type GazetteerPlace,
} from "./geographic-gazetteer.js";
import {
  cosineSimilarity,
  generateDeterministicTextVector,
} from "./semantic-retriever.js";

export {
  JAKARTA_ENVELOPE,
  JAKARTA_GAZETTEER,
  JAKARTA_TOPONYMS,
  haversineDistanceMeters,
  findJakartaToponym,
  extractCoordinatesHint,
  isCoordinateInJakarta,
};

export type IncidentCategory =
  | "flood"
  | "fire"
  | "accident"
  | "tree_fall"
  | "crime"
  | "weather"
  | "transport_road_incidents"
  | (string & {});

export interface StoredEvidenceChunk {
  readonly chunk_index: number;
  readonly text: string;
  readonly span_start: number;
  readonly span_end: number;
}

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
}

/** Correlated Incident Cluster representing an evolving multi-source incident */
export interface CorrelatedIncidentCluster {
  readonly cluster_id: string;
  readonly primary_category: IncidentCategory;
  readonly location_label: string;
  readonly coordinates: readonly [number, number] | null;
  readonly reports: readonly StoredReportRevision[];
  readonly is_multi_source: boolean;
  readonly sources: readonly string[];
  readonly uncertainty_notes?: readonly string[];
}

export const JAKARTA_CORRELATION_LIMITS = {
  maxSpatialDistanceMeters: 2500,
  maxTemporalWindowMs: 4 * 60 * 60 * 1000, // 4 hours
  duplicateWindowMs: 6 * 60 * 60 * 1000,   // 6 hours
} as const;

export type JakartaToponym = GazetteerPlace;

/**
 * Extracts a numeric Unix epoch millisecond timestamp for temporal comparisons.
 */
export function extractReportTimestamp(report: StoredReportRevision): number {
  if (report.published_at) {
    const parsed = Date.parse(report.published_at);
    if (!Number.isNaN(parsed)) return parsed;
  }
  const matchRfc = /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})\b/.exec(
    report.permitted_text,
  );
  if (matchRfc) {
    const parsed = Date.parse(matchRfc[0]);
    if (!Number.isNaN(parsed)) return parsed;
  }
  const parsedRetrieved = Date.parse(report.retrieved_at);
  if (!Number.isNaN(parsedRetrieved)) return parsedRetrieved;

  return Date.now();
}

/**
 * Extracts coordinate and location metadata from a report revision.
 * Unlike rigid rule systems, does NOT reject reports without coordinates;
 * marks location uncertainty instead.
 */
export function extractReportLocation(
  report: StoredReportRevision,
): {
  readonly locationLabel: string;
  readonly coordinates: readonly [number, number] | null;
  readonly toponymKey?: string;
  readonly isUncertain?: boolean;
} | null {
  const text = report.permitted_text;

  // 1. Explicit bracketed coordinates: [lon, lat] or [lat, lon]
  const coordRegex = /\[\s*([0-9.-]+)\s*,\s*([0-9.-]+)\s*\]/;
  const match = text.match(coordRegex);
  let explicitCoords: [number, number] | null = null;
  if (match && match[1] && match[2]) {
    const p1 = Number(match[1]);
    const p2 = Number(match[2]);
    if (
      p1 >= JAKARTA_ENVELOPE.west &&
      p1 <= JAKARTA_ENVELOPE.east &&
      p2 >= JAKARTA_ENVELOPE.south &&
      p2 <= JAKARTA_ENVELOPE.north
    ) {
      explicitCoords = [p1, p2];
    } else if (
      p2 >= JAKARTA_ENVELOPE.west &&
      p2 <= JAKARTA_ENVELOPE.east &&
      p1 >= JAKARTA_ENVELOPE.south &&
      p1 <= JAKARTA_ENVELOPE.north
    ) {
      explicitCoords = [p2, p1];
    }
  }

  // 2. Gazetteer lookup
  const matchedToponym = findJakartaToponym(text);

  if (matchedToponym) {
    return {
      locationLabel: matchedToponym.label,
      coordinates: explicitCoords ?? matchedToponym.coordinates,
      toponymKey: matchedToponym.key,
    };
  }

  if (explicitCoords) {
    let nearestPlace: GazetteerPlace | null = null;
    let nearestDist = Infinity;
    for (const place of JAKARTA_GAZETTEER) {
      const d = haversineDistanceMeters(explicitCoords, place.coordinates);
      if (d < nearestDist) {
        nearestDist = d;
        nearestPlace = place;
      }
    }
    const label = nearestPlace && nearestDist <= 1500
      ? nearestPlace.label
      : `DKI Jakarta [${explicitCoords[0].toFixed(4)}, ${explicitCoords[1].toFixed(4)}]`;

    return {
      locationLabel: label,
      coordinates: explicitCoords,
      toponymKey: nearestDist <= 1500 ? nearestPlace?.key : undefined,
    };
  }

  // Uncertain location - preserved rather than rejected
  return {
    locationLabel: "DKI Jakarta (Lokasi spesifik belum teridentifikasi)",
    coordinates: null,
    isUncertain: true,
  };
}

/**
 * Detects an incident category hint from report text.
 * Returns flexible descriptive categories rather than forcing everything.
 */
export function detectReportCategory(report: StoredReportRevision): IncidentCategory | null {
  const text = report.permitted_text.toLowerCase();

  if (/\b(pohon\s+tumbang|dahan\s+patah|batang\s+pohon\s+roboh)\b/i.test(text)) {
    return "tree_fall";
  }
  if (/\b(kebakaran|si\s+jago\s+merah|kobaran\s+api|damkar|gulkarmat|hangus\s+terbakar)\b/i.test(text)) {
    return "fire";
  }
  if (
    /\b(kecelakaan|laka\s+lantas|tabrakan\s+beruntun|tabrakan|terguling|truk\s+terguling|rekayasa\s+(?:lalu\s+lintas|lalin)|penutupan\s+jalan|pengalihan\s+arus|contraflow|macet\s+(?:total|parah)|krl\s+anjlok|gangguan\s+persinyalan)\b/i.test(
      text,
    )
  ) {
    return "accident";
  }
  if (/\b(banjir|genangan(?:\s+air)?|tergenang|tanggul\s+jebol|rob|luapan\s+kali)\b/i.test(text)) {
    return "flood";
  }
  if (/\b(tawuran|bentrokan|begal|penusukan|perampokan|curanmor|pembunuhan|terbunuh)\b/i.test(text)) {
    return "crime";
  }
  if (/\b(cuaca\s+ekstrem|puting\s+beliung|angin\s+kencang|hujan\s+lebat|hujan\s+deras|badai|longsor|gempa)\b/i.test(text)) {
    return "weather";
  }

  if (report.source_id.includes("petabencana") || report.canonical_url.includes("flood")) {
    return "flood";
  }

  return "weather";
}

/**
 * Checks category compatibility between two reports.
 * Allows related cross-cutting hazards (e.g. flood and heavy rain weather).
 */
export function areCategoriesCompatible(
  catA: IncidentCategory,
  catB: IncidentCategory,
  textA: string = "",
  textB: string = "",
): boolean {
  if (catA === catB) return true;

  // Flood and Weather compatibility
  if (
    (catA === "flood" && catB === "weather") ||
    (catA === "weather" && catB === "flood")
  ) {
    const combined = `${textA} ${textB}`.toLowerCase();
    if (
      combined.includes("banjir") ||
      combined.includes("genangan") ||
      combined.includes("tergenang") ||
      combined.includes("hujan")
    ) {
      return true;
    }
  }

  return false;
}

/**
 * Checks whether two locations are spatially proximate.
 */
export function areLocationsProximate(
  locA: { readonly locationLabel: string; readonly coordinates: readonly [number, number] | null; readonly toponymKey?: string } | null,
  locB: { readonly locationLabel: string; readonly coordinates: readonly [number, number] | null; readonly toponymKey?: string } | null,
): boolean {
  if (!locA || !locB) return false;

  // Exact toponym match
  if (locA.toponymKey && locB.toponymKey && locA.toponymKey === locB.toponymKey) {
    return true;
  }

  // Coordinates distance check (Haversine <= 2,500m)
  if (locA.coordinates && locB.coordinates) {
    const dist = haversineDistanceMeters(locA.coordinates, locB.coordinates);
    if (dist <= JAKARTA_CORRELATION_LIMITS.maxSpatialDistanceMeters) {
      return true;
    }
  }

  return false;
}

/**
 * Suppresses duplicate reports from the same source within the duplicate window.
 */
export function suppressDuplicateReports(
  reports: readonly StoredReportRevision[],
): readonly StoredReportRevision[] {
  const accepted: StoredReportRevision[] = [];

  for (const report of reports) {
    let isDuplicate = false;
    const repTime = extractReportTimestamp(report);
    const repLoc = extractReportLocation(report);

    for (const existing of accepted) {
      if (existing.source_id !== report.source_id) {
        continue;
      }

      // Exact ID / URL / content hash duplicates
      if (
        existing.report_revision_id === report.report_revision_id ||
        existing.canonical_url === report.canonical_url ||
        existing.permitted_text_hash === report.permitted_text_hash
      ) {
        isDuplicate = true;
        break;
      }

      // Same source reporting on the same event within duplicate window
      const repCat = detectReportCategory(report);
      const existCat = detectReportCategory(existing);
      if (
        repCat &&
        existCat &&
        areCategoriesCompatible(repCat, existCat, report.permitted_text, existing.permitted_text)
      ) {
        const timeDiff = Math.abs(repTime - extractReportTimestamp(existing));
        if (timeDiff <= JAKARTA_CORRELATION_LIMITS.duplicateWindowMs) {
          const existLoc = extractReportLocation(existing);
          const sim = cosineSimilarity(
            generateDeterministicTextVector(report.permitted_text),
            generateDeterministicTextVector(existing.permitted_text),
          );
          if (sim >= 0.7 && areLocationsProximate(repLoc, existLoc)) {
            isDuplicate = true;
            break;
          }
        }
      }
    }

    if (!isDuplicate) {
      accepted.push(report);
    }
  }

  return accepted;
}

interface MutableCluster {
  cluster_id: string;
  primary_category: IncidentCategory;
  location_label: string;
  coordinates: [number, number] | null;
  toponymKey?: string;
  reports: StoredReportRevision[];
  sources: Set<string>;
  earliestTimestamp: number;
  uncertaintyNotes: string[];
}

/**
 * Evaluates whether an incoming report should be correlated into an existing incident cluster
 * using semantic vector similarity and spatio-temporal consistency.
 */
function shouldCorrelateWithCluster(
  report: StoredReportRevision,
  cluster: MutableCluster,
): boolean {
  const repText = report.permitted_text;
  const clusterCombinedText = cluster.reports.map((r) => r.permitted_text).join(" ");

  const repVec = generateDeterministicTextVector(repText);
  const clusterVec = generateDeterministicTextVector(clusterCombinedText);
  const semanticSim = cosineSimilarity(repVec, clusterVec);

  const repLoc = extractReportLocation(report);
  const repTime = extractReportTimestamp(report);
  const timeDelta = Math.abs(repTime - cluster.earliestTimestamp);

  // 1. Incompatible event types at same place (e.g. fire vs flood) should NOT be merged
  const repCat = detectReportCategory(report);
  if (repCat && cluster.primary_category && !areCategoriesCompatible(cluster.primary_category, repCat, clusterCombinedText, repText)) {
    return false;
  }

  // 2. Clear location contradiction (e.g. distinct subdistricts Kemang vs Rawamangun > 3km apart)
  if (repLoc && cluster.coordinates && repLoc.coordinates) {
    const dist = haversineDistanceMeters(repLoc.coordinates, cluster.coordinates);
    if (dist > JAKARTA_CORRELATION_LIMITS.maxSpatialDistanceMeters) {
      return false;
    }
  } else if (repLoc?.toponymKey && cluster.toponymKey && repLoc.toponymKey !== cluster.toponymKey) {
    // If both have different verified toponyms and both have coordinates distant, keep separate
    const placeA = JAKARTA_GAZETTEER.find((p) => p.key === repLoc.toponymKey);
    const placeB = JAKARTA_GAZETTEER.find((p) => p.key === cluster.toponymKey);
    if (placeA && placeB) {
      const dist = haversineDistanceMeters(placeA.coordinates, placeB.coordinates);
      if (dist > 3000) return false;
    }
  }

  // 3. Temporal delta: within operational window (12 hours)
  if (timeDelta > JAKARTA_CORRELATION_LIMITS.maxTemporalWindowMs) {
    return false;
  }

  // 4. Strong semantic match (cosine similarity >= 0.35) OR shared local corridor with similarity >= 0.2
  const isSpatialMatch = repLoc ? areLocationsProximate(repLoc, {
    locationLabel: cluster.location_label,
    coordinates: cluster.coordinates,
    toponymKey: cluster.toponymKey,
  }) : false;

  if (isSpatialMatch && semanticSim >= 0.20) {
    return true;
  }

  if (semanticSim >= 0.45) {
    return true;
  }

  return false;
}

/**
 * Correlates source report revisions across distinct sources into incident clusters
 * using semantic retrieval and evidence assessment.
 */
export function correlateSourceReports(
  reports: readonly StoredReportRevision[],
): CorrelatedIncidentCluster[] {
  if (!Array.isArray(reports) || reports.length === 0) {
    return [];
  }

  // Step 1: Technical duplicate suppression
  const deduplicated = suppressDuplicateReports(reports);

  const clusters: MutableCluster[] = [];

  for (const report of deduplicated) {
    const location = extractReportLocation(report);
    const category = detectReportCategory(report) ?? "weather";
    const timestamp = extractReportTimestamp(report);

    // Find best correlating existing cluster using semantic evidence assessment
    let matchedCluster: MutableCluster | null = null;
    for (const cluster of clusters) {
      if (shouldCorrelateWithCluster(report, cluster)) {
        matchedCluster = cluster;
        break;
      }
    }

    if (matchedCluster) {
      matchedCluster.reports.push(report);
      matchedCluster.sources.add(report.source_id);
      if (timestamp < matchedCluster.earliestTimestamp) {
        matchedCluster.earliestTimestamp = timestamp;
      }
      // Upgrade coordinates if incoming report has higher precision
      if (location?.coordinates && !matchedCluster.coordinates) {
        matchedCluster.coordinates = [location.coordinates[0], location.coordinates[1]];
        matchedCluster.location_label = location.locationLabel;
        matchedCluster.toponymKey = location.toponymKey;
      }
      // Upgrade location label if incoming report has a specific toponym
      if (location?.locationLabel && !location.isUncertain && matchedCluster.location_label.startsWith("DKI Jakarta")) {
        matchedCluster.location_label = location.locationLabel;
        matchedCluster.toponymKey = location.toponymKey;
      }
    } else {
      const initialCoords: [number, number] | null = location?.coordinates
        ? [location.coordinates[0], location.coordinates[1]]
        : null;

      const clusterId = `cluster-${category}-${(location?.locationLabel ?? "jakarta")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")}-${timestamp}`;

      const uncertaintyNotes: string[] = [];
      if (!initialCoords) {
        uncertaintyNotes.push("Koordinat geografis belum terverifikasi secara presisi");
      }

      clusters.push({
        cluster_id: clusterId,
        primary_category: category,
        location_label: location?.locationLabel ?? "DKI Jakarta",
        coordinates: initialCoords,
        toponymKey: location?.toponymKey,
        reports: [report],
        sources: new Set([report.source_id]),
        earliestTimestamp: timestamp,
        uncertaintyNotes,
      });
    }
  }

  // Convert to immutable CorrelatedIncidentCluster
  return clusters.map((c) => ({
    cluster_id: c.cluster_id,
    primary_category: c.primary_category,
    location_label: c.location_label,
    coordinates: c.coordinates ? [c.coordinates[0], c.coordinates[1]] : null,
    reports: c.reports,
    is_multi_source: c.sources.size >= 2,
    sources: Array.from(c.sources),
    uncertainty_notes: c.uncertaintyNotes.length > 0 ? c.uncertaintyNotes : undefined,
  }));
}
