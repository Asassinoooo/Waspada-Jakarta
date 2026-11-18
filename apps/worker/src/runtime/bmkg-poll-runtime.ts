/**
 * BMKG Realtime Hazard & Earthquake Poller (Layer 1 Data Knowledge).
 *
 * Ingests realtime seismic and hazard observation feeds from the Indonesian
 * Agency for Meteorology, Climatology, and Geophysics (BMKG TEWS):
 * - AutoGempa (latest automated sensor-detected earthquake)
 * - GempaTerkini (latest 15 verified felt earthquakes)
 *
 * Converts earthquakes felt in Jakarta or affecting Jakarta (HOSTED-36) into
 * immutable L1 StoredReportRevision records for cross-verification against
 * news wire reports and citizen observations.
 */

import { createHash } from "node:crypto";
import type { StoredEvidenceChunk, StoredReportRevision } from "./petabencana-poll-runtime.js";
import {
  BLOCKED_REDIRECT_ERROR,
  isBlockedRedirect,
  OUTBOUND_REDIRECT_POLICY,
} from "./outbound-fetch-policy.js";

export const BMKG_GEMPA_SOURCE_ID = "source-bmkg-gempa";
export const DEFAULT_BMKG_AUTOGEMPA_ENDPOINT = "https://data.bmkg.go.id/DataMKG/TEWS/autogempa.json";
export const DEFAULT_BMKG_GEMPATERKINI_ENDPOINT = "https://data.bmkg.go.id/DataMKG/TEWS/gempaterkini.json";
/**
 * HOSTED-36: every BMKG revision links to this page, with no fragment. The fragment never kept an earthquake's identity:
 * report_revision_id (from DateTime) does. The old gempabumi-terkini.html page returns 404 (checked in a browser, 19 Nov 2026); this is the felt-earthquake page.
 */
export const BMKG_CANONICAL_BASE = "https://www.bmkg.go.id/gempabumi/gempabumi-dirasakan";
export const DEFAULT_POLL_TIMEOUT_MS = 20_000;

/** HOSTED-36: place names that keep an earthquake, matched as whole words, case-insensitively. "Jakarta Pusat" etc. contain "Jakarta". */
const JAKARTA_PLACE_NAME = /\b(?:jakarta|kepulauan\s+seribu)\b/iu;
/** HOSTED-36: the epicentre envelope around Jakarta (lon 106.65..107.05, lat -6.40..-6.05). */
const JAKARTA_EPICENTRE = { west: 106.65, east: 107.05, south: -6.4, north: -6.05 } as const;

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
 * HOSTED-36 (owner decision, 18 Nov 2026): keeps only an earthquake that is felt in Jakarta or affects Jakarta. It is
 * kept when one of these holds:
 *   (a) Dirasakan (the felt-intensity list) names Jakarta or a Jakarta city or regency;
 *   (b) Wilayah (the region text) names Jakarta or a Jakarta city or regency;
 *   (c) the epicentre (Coordinates "lat,lon") lies inside the Jakarta envelope.
 * Magnitude, a neighbouring province, "Jawa", and any non-empty Dirasakan do not keep it. This is a filter only: nothing
 * here draws a radius, polygon or danger zone.
 */
export function isSeismicEventRelevant(item: BmkgGempaRawItem): boolean {
  if (JAKARTA_PLACE_NAME.test(item.Dirasakan || "")) return true;
  if (JAKARTA_PLACE_NAME.test(item.Wilayah || "")) return true;

  const parts = (item.Coordinates || "").split(",");
  if (parts.length !== 2) return false;
  const lat = parseFloat(parts[0]!.trim());
  const lon = parseFloat(parts[1]!.trim());
  return (
    Number.isFinite(lat) &&
    Number.isFinite(lon) &&
    lon >= JAKARTA_EPICENTRE.west &&
    lon <= JAKARTA_EPICENTRE.east &&
    lat >= JAKARTA_EPICENTRE.south &&
    lat <= JAKARTA_EPICENTRE.north
  );
}

/**
 * The feed's own time as an ISO instant. A missing DateTime keeps the in-memory fallback to retrieved_at, which the
 * store never writes as a publish time (F-14). An unparseable DateTime is null: it neither throws nor falls back to
 * the retrieval time, so the item still flows with no publish time.
 */
function feedPublishedAt(dateTime: string, retrievedAt: string): string | null {
  if (!dateTime) return retrievedAt;
  const parsed = Date.parse(dateTime);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
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
    canonical_url: BMKG_CANONICAL_BASE,
    permitted_text: permittedText,
    permitted_text_hash: hash,
    published_at: feedPublishedAt(item.DateTime, retrievedAt),
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
    let blockedRedirects = 0;

    try {
      // 1. Fetch autogempa (latest automated alert)
      try {
        const res = await fetchImpl(autogempaEndpoint, {
          signal: controller.signal,
          // NFR-07: a redirect is refused, not followed to a host BMKG did not name here.
          redirect: OUTBOUND_REDIRECT_POLICY,
          headers: {
            Accept: "application/json",
            "User-Agent": "WaspadaJakarta-NewsPoller/1.0",
          },
        });
        if (isBlockedRedirect(res)) blockedRedirects += 1;
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
          // NFR-07: a redirect is refused, not followed.
          redirect: OUTBOUND_REDIRECT_POLICY,
          headers: {
            Accept: "application/json",
            "User-Agent": "WaspadaJakarta-NewsPoller/1.0",
          },
        });
        if (isBlockedRedirect(res)) blockedRedirects += 1;
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

      // A refused redirect is a failed fetch, not a silent empty result.
      const blocked = blockedRedirects > 0;
      return {
        outcome: revisions.length > 0 ? "success" : blocked ? "error" : "empty",
        fetchedCount: totalFetched,
        filteredCount: totalFiltered,
        revisions,
        ...(blocked ? { error: BLOCKED_REDIRECT_ERROR } : {}),
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
