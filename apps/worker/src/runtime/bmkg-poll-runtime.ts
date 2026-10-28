/**
 * BMKG Realtime Hazard & Earthquake Poller (Layer 1 Data Knowledge).
 *
 * Ingests realtime seismic and hazard observation feeds from the Indonesian
 * Agency for Meteorology, Climatology, and Geophysics (BMKG TEWS):
 * - AutoGempa (latest automated sensor-detected earthquake)
 * - GempaTerkini (latest 15 verified felt earthquakes)
 *
 * Converts seismic events proximate to Greater Jakarta / Western Java into
 * immutable L1 StoredReportRevision records for cross-verification against
 * news wire reports and citizen observations.
 */

import { createHash } from "node:crypto";
import type { StoredEvidenceChunk, StoredReportRevision } from "./petabencana-poll-runtime.js";

export const BMKG_GEMPA_SOURCE_ID = "source-bmkg-gempa";
export const DEFAULT_BMKG_AUTOGEMPA_ENDPOINT = "https://data.bmkg.go.id/DataMKG/TEWS/autogempa.json";
export const DEFAULT_BMKG_GEMPATERKINI_ENDPOINT = "https://data.bmkg.go.id/DataMKG/TEWS/gempaterkini.json";
export const BMKG_CANONICAL_BASE = "https://www.bmkg.go.id/gempabumi-terkini.html";
export const DEFAULT_POLL_TIMEOUT_MS = 20_000;

export interface BmkgGempaRawItem {
  readonly Tanggal: string;
  readonly Jam: string;
  readonly DateTime: string;
  readonly Coordinates: string;
  readonly Lintang: string;
  readonly Bujur: string;
  readonly Magnitude: string;
  readonly Kedalaman: string;
  readonly Wilayah: string;
  readonly Potensi: string;
  readonly Dirasakan?: string;
  readonly Shakemap?: string;
}

export interface BmkgPollResult {
  readonly outcome: "success" | "empty" | "error" | "skipped";
  readonly fetchedCount: number;
  readonly filteredCount: number;
  readonly revisions: readonly StoredReportRevision[];
  readonly error?: string;
}

export interface BmkgPollRuntimeOptions {
  readonly autogempaEndpoint?: string;
  readonly gempaterkiniEndpoint?: string;
  readonly timeoutMs?: number;
  readonly fetch?: typeof fetch;
  readonly now?: () => string;
  readonly onRevisions?: (revisions: readonly StoredReportRevision[]) => Promise<void> | void;
}

export interface BmkgPollRuntime {
  poll(): Promise<BmkgPollResult>;
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * Checks if an earthquake is geographically relevant to Greater Jakarta / Western Java
 * or has magnitude >= 4.0 within the impact corridor.
 */
export function isSeismicEventRelevant(item: BmkgGempaRawItem): boolean {
  const wilayah = (item.Wilayah || "").toLowerCase();
  const dirasakan = (item.Dirasakan || "").toLowerCase();

  // 1. Explicit mention of Jakarta, Banten, Selat Sunda, or Western Java
  if (
    wilayah.includes("jakarta") ||
    dirasakan.includes("jakarta") ||
    wilayah.includes("banten") ||
    wilayah.includes("selat sunda") ||
    wilayah.includes("sukabumi") ||
    wilayah.includes("cianjur") ||
    wilayah.includes("bogor") ||
    wilayah.includes("bekasi") ||
    wilayah.includes("tangerang")
  ) {
    return true;
  }

  // 2. Coordinate distance check
  const parts = item.Coordinates.split(",");
  if (parts.length === 2) {
    const lat = parseFloat(parts[0]!.trim());
    const lon = parseFloat(parts[1]!.trim());
    if (Number.isFinite(lat) && Number.isFinite(lon)) {
      // Bounding corridor: lat -8.5 to -5.0, lon 104.5 to 108.5
      if (lat >= -8.5 && lat <= -5.0 && lon >= 104.5 && lon <= 108.5) {
        return true;
      }
    }
  }

  // 3. Significant felt earthquake with Mag >= 5.0
  const mag = parseFloat(item.Magnitude);
  if (Number.isFinite(mag) && mag >= 5.0 && (wilayah.includes("jawa") || dirasakan.length > 0)) {
    return true;
  }

  return false;
}

/**
 * Maps a BMKG raw earthquake item to a StoredReportRevision.
 */
export function mapBmkgGempaToRevision(
  item: BmkgGempaRawItem,
  retrievedAt: string,
): StoredReportRevision | null {
  if (!isSeismicEventRelevant(item)) {
    return null;
  }

  const parts = item.Coordinates.split(",");
  const lat = parts.length === 2 ? parseFloat(parts[0]!.trim()) : null;
  const lon = parts.length === 2 ? parseFloat(parts[1]!.trim()) : null;

  const coordPrefix =
    lat !== null && lon !== null && Number.isFinite(lat) && Number.isFinite(lon)
      ? `[${lon.toFixed(4)}, ${lat.toFixed(4)}] `
      : "";

  const dirasakanText = item.Dirasakan ? ` Dirasakan (MMI): ${item.Dirasakan}.` : "";
  const permittedText = `${coordPrefix}BMKG: Gempa bumi M ${item.Magnitude} di ${item.Wilayah}, kedalaman ${item.Kedalaman}. ${item.Potensi}.${dirasakanText}`.trim();

  const codePointLength = Array.from(permittedText).length;
  const hash = sha256(permittedText);
  const revKey = item.DateTime || `${item.Tanggal}-${item.Jam}`;
  const reportRevisionId = `rep-bmkg-${sha256(revKey).slice(0, 16)}`;

  const chunk: StoredEvidenceChunk = {
    chunk_index: 0,
    text: permittedText,
    span_start: 0,
    span_end: codePointLength,
  };

  return {
    report_revision_id: reportRevisionId,
    source_id: BMKG_GEMPA_SOURCE_ID,
    canonical_url: `${BMKG_CANONICAL_BASE}#${reportRevisionId}`,
    permitted_text: permittedText,
    permitted_text_hash: hash,
    published_at: item.DateTime ? new Date(item.DateTime).toISOString() : retrievedAt,
    retrieved_at: retrievedAt,
    revision_status: "unreviewed",
    chunks: [chunk],
  };
}

export function createBmkgPollRuntime(
  options: BmkgPollRuntimeOptions = {},
): BmkgPollRuntime {
  const autogempaEndpoint = options.autogempaEndpoint ?? DEFAULT_BMKG_AUTOGEMPA_ENDPOINT;
  const gempaterkiniEndpoint = options.gempaterkiniEndpoint ?? DEFAULT_BMKG_GEMPATERKINI_ENDPOINT;
  const timeoutMs = options.timeoutMs ?? DEFAULT_POLL_TIMEOUT_MS;
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const nowFn = options.now ?? (() => new Date().toISOString());

  async function poll(): Promise<BmkgPollResult> {
    const retrievedAt = nowFn();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error(`Timeout after ${timeoutMs}ms`)), timeoutMs);

    const revisions: StoredReportRevision[] = [];
    const seenHashes = new Set<string>();
    let totalFetched = 0;
    let totalFiltered = 0;

    try {
      // 1. Fetch autogempa (latest automated alert)
      try {
        const res = await fetchImpl(autogempaEndpoint, {
          signal: controller.signal,
          headers: {
            Accept: "application/json",
            "User-Agent": "WaspadaJakarta-NewsPoller/1.0",
          },
        });
        if (res.ok) {
          const data = (await res.json()) as { Infogempa?: { gempa?: BmkgGempaRawItem } };
          const gempa = data?.Infogempa?.gempa;
          if (gempa) {
            totalFetched += 1;
            const rev = mapBmkgGempaToRevision(gempa, retrievedAt);
            if (rev && !seenHashes.has(rev.permitted_text_hash)) {
              seenHashes.add(rev.permitted_text_hash);
              revisions.push(rev);
              totalFiltered += 1;
            }
          }
        }
      } catch {}

      // 2. Fetch gempaterkini (latest felt earthquakes)
      try {
        const res = await fetchImpl(gempaterkiniEndpoint, {
          signal: controller.signal,
          headers: {
            Accept: "application/json",
            "User-Agent": "WaspadaJakarta-NewsPoller/1.0",
          },
        });
        if (res.ok) {
          const data = (await res.json()) as { Infogempa?: { gempa?: BmkgGempaRawItem[] } };
          const list = data?.Infogempa?.gempa;
          if (Array.isArray(list)) {
            for (const item of list) {
              totalFetched += 1;
              const rev = mapBmkgGempaToRevision(item, retrievedAt);
              if (rev && !seenHashes.has(rev.permitted_text_hash)) {
                seenHashes.add(rev.permitted_text_hash);
                revisions.push(rev);
                totalFiltered += 1;
              }
            }
          }
        }
      } catch {}

      if (options.onRevisions && revisions.length > 0) {
        await options.onRevisions(revisions);
      }

      return {
        outcome: revisions.length > 0 ? "success" : "empty",
        fetchedCount: totalFetched,
        filteredCount: totalFiltered,
        revisions,
      };
    } catch (err) {
      return {
        outcome: "error",
        fetchedCount: totalFetched,
        filteredCount: totalFiltered,
        revisions: [],
        error: err instanceof Error ? err.message : String(err),
      };
    } finally {
      clearTimeout(timer);
    }
  }

  return { poll };
}
