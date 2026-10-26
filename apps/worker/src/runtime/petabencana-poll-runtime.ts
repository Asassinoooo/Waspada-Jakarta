import {
  parsePetaBencanaReports,
  formatPetabencanaReportText,
  PETABENCANA_SOURCE_ID,
  PETABENCANA_CANONICAL_BASE,
  PETABENCANA_JAKARTA_ENVELOPE,
} from "../layers/l1-data-knowledge/petabencana-ingest.js";
import { preparePermittedText } from "../layers/l1-data-knowledge/text-preparation.js";
import type { PetabencanaReport, PetabencanaParseResult } from "../layers/l1-data-knowledge/petabencana-geojson.js";

export { parsePetaBencanaReports };

export const DEFAULT_PETABENCANA_ENDPOINT =
  "https://api.petabencana.id/reports?admin=ID-JK&timeperiod=86400&disaster=flood&geoformat=geojson";

export const DEFAULT_POLL_TIMEOUT_MS = 20_000;

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

export interface PetaBencanaLeaseManager {
  acquireLease(leaseKey: string, ttlMs: number): Promise<boolean>;
}

export interface PetaBencanaPollRuntimeOptions {
  /** Target endpoint URL (defaults to DEFAULT_PETABENCANA_ENDPOINT) */
  readonly endpoint?: string;
  /** Timeout in milliseconds (defaults to 20_000 ms) */
  readonly timeoutMs?: number;
  /** Source ID to tag revisions (defaults to PETABENCANA_SOURCE_ID "petabencana") */
  readonly sourceId?: string;
  /** Base URL for canonical URLs (defaults to PETABENCANA_CANONICAL_BASE) */
  readonly canonicalBase?: string;
  /** Custom fetch implementation for testing or custom transport */
  readonly fetch?: typeof fetch;
  /** Callback executed with parsed StoredReportRevision records after a successful poll */
  readonly onRevisions?: (revisions: readonly StoredReportRevision[]) => Promise<void> | void;
  /** Storage / persistence port for storing revisions */
  readonly persistence?: {
    saveRevisions(revisions: readonly StoredReportRevision[]): Promise<void>;
  };
  /** Clock function to obtain ISO timestamp (defaults to () => new Date().toISOString()) */
  readonly now?: () => string;
  /** Optional lease manager for idempotency / slot lease */
  readonly leaseManager?: PetaBencanaLeaseManager;
  /** Slot duration in milliseconds when scheduledTime is supplied (defaults to 60_000 ms) */
  readonly slotDurationMs?: number;
}

export interface PetaBencanaPollResult {
  readonly outcome: "success" | "empty" | "error" | "skipped";
  readonly fetchedCount: number;
  readonly filteredCount: number;
  readonly revisions: readonly StoredReportRevision[];
  readonly error?: string;
  readonly httpStatus?: number;
  readonly reason?: string;
}

export interface PetaBencanaPollRuntime {
  poll(scheduledTime?: number): Promise<PetaBencanaPollResult>;
  pollOnce(): Promise<PetaBencanaPollResult>;
}

function isValidRfc3339(timestamp: unknown): timestamp is string {
  if (typeof timestamp !== "string") return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.exec(timestamp);
  if (!match) return false;
  const parsed = Date.parse(timestamp);
  return Number.isFinite(parsed);
}

function isInsideEnvelope(
  coordinates: readonly [number, number] | readonly [number, number, number],
  envelope: typeof PETABENCANA_JAKARTA_ENVELOPE,
): boolean {
  const [lon, lat] = coordinates;
  return (
    Number.isFinite(lon) &&
    Number.isFinite(lat) &&
    lon >= envelope.west &&
    lon <= envelope.east &&
    lat >= envelope.south &&
    lat <= envelope.north
  );
}

function extractFeatureCollectionText(rawText: string): string {
  try {
    const parsed = JSON.parse(rawText);
    if (parsed && typeof parsed === "object") {
      if (parsed.type === "FeatureCollection") {
        return rawText;
      }
      if (parsed.result && typeof parsed.result === "object" && parsed.result.type === "FeatureCollection") {
        return JSON.stringify(parsed.result);
      }
    }
  } catch {
    // Return rawText so parsePetaBencanaReports handles malformed JSON error
  }
  return rawText;
}

export async function mapPetabencanaReportsToRevisions(
  reports: readonly PetabencanaReport[],
  retrievedAt: string,
  options: {
    readonly sourceId?: string;
    readonly canonicalBase?: string;
    readonly envelope?: typeof PETABENCANA_JAKARTA_ENVELOPE;
  } = {},
): Promise<{
  readonly revisions: readonly StoredReportRevision[];
  readonly filteredCount: number;
}> {
  const sourceId = options.sourceId ?? PETABENCANA_SOURCE_ID;
  const canonicalBase = options.canonicalBase ?? PETABENCANA_CANONICAL_BASE;
  const envelope = options.envelope ?? PETABENCANA_JAKARTA_ENVELOPE;

  const revisions: StoredReportRevision[] = [];
  let filteredCount = 0;

  for (const report of reports) {
    if (report.featureId === null) {
      filteredCount += 1;
      continue;
    }

    if (report.geometry && report.geometry.type === "Point") {
      if (!isInsideEnvelope(report.geometry.coordinates, envelope)) {
        filteredCount += 1;
        continue;
      }
    }

    const rawFeatureId = String(report.featureId);
    const sanitizedId = rawFeatureId.replace(/[^A-Za-z0-9._:-]/g, "_");
    const reportRevisionId = `petabencana-report-${sanitizedId}`;
    const canonicalUrl = `${canonicalBase}report/${encodeURIComponent(rawFeatureId)}`;

    const formattedText = formatPetabencanaReportText(report);
    const prepared = await preparePermittedText(formattedText);
    const codePoints = Array.from(prepared.permittedText);

    const chunks: StoredEvidenceChunk[] = [
      {
        chunk_index: 0,
        text: prepared.permittedText,
        span_start: 0,
        span_end: codePoints.length,
      },
    ];

    const publishedAt =
      report.sourceCreatedAt && isValidRfc3339(report.sourceCreatedAt)
        ? report.sourceCreatedAt
        : null;

    revisions.push({
      report_revision_id: reportRevisionId,
      source_id: sourceId,
      canonical_url: canonicalUrl,
      permitted_text: prepared.permittedText,
      permitted_text_hash: prepared.permittedTextHash,
      published_at: publishedAt,
      retrieved_at: retrievedAt,
      revision_status: "unreviewed",
      chunks,
    });
  }

  return { revisions, filteredCount };
}

export function createPetaBencanaPollRuntime(
  options: PetaBencanaPollRuntimeOptions = {},
): PetaBencanaPollRuntime {
  const endpoint = options.endpoint ?? DEFAULT_PETABENCANA_ENDPOINT;
  const timeoutMs = options.timeoutMs ?? DEFAULT_POLL_TIMEOUT_MS;
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const nowFn = options.now ?? (() => new Date().toISOString());

  async function executePoll(scheduledTime?: number): Promise<PetaBencanaPollResult> {
    if (options.leaseManager && scheduledTime !== undefined) {
      const slotMs = options.slotDurationMs ?? 60_000;
      const slotIndex = Math.floor(scheduledTime / slotMs);
      const leaseKey = `petabencana-poll-slot:${slotIndex}`;
      try {
        const acquired = await options.leaseManager.acquireLease(leaseKey, slotMs);
        if (!acquired) {
          return {
            outcome: "skipped",
            reason: "lease_already_held",
            fetchedCount: 0,
            filteredCount: 0,
            revisions: [],
          };
        }
      } catch (leaseError) {
        return {
          outcome: "error",
          fetchedCount: 0,
          filteredCount: 0,
          revisions: [],
          error: `Lease acquisition failed: ${leaseError instanceof Error ? leaseError.message : String(leaseError)}`,
        };
      }
    }

    const retrievedAt = nowFn();

    let timeoutHandle: NodeJS.Timeout | number | undefined;
    const controller = typeof AbortController !== "undefined" ? new AbortController() : undefined;

    let response: Response;
    try {
      if (controller) {
        timeoutHandle = setTimeout(() => {
          controller.abort(new Error(`Request timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }

      response = await fetchImpl(endpoint, {
        method: "GET",
        headers: {
          Accept: "application/json, application/geo+json",
        },
        signal: controller?.signal,
      });
    } catch (networkError: unknown) {
      const isTimeout =
        (networkError instanceof Error && networkError.name === "AbortError") ||
        (networkError instanceof Error && networkError.message.toLowerCase().includes("timed out")) ||
        (typeof DOMException !== "undefined" &&
          networkError instanceof DOMException &&
          networkError.name === "TimeoutError");

      return {
        outcome: "error",
        fetchedCount: 0,
        filteredCount: 0,
        revisions: [],
        error: isTimeout
          ? `Request timed out after ${timeoutMs}ms`
          : networkError instanceof Error
          ? networkError.message
          : String(networkError),
      };
    } finally {
      clearTimeout(timeoutHandle);
    }

    if (!response.ok) {
      return {
        outcome: "error",
        httpStatus: response.status,
        fetchedCount: 0,
        filteredCount: 0,
        revisions: [],
        error: `HTTP ${response.status}: ${response.statusText || "Request failed"}`,
      };
    }

    let rawText: string;
    try {
      rawText = await response.text();
    } catch (readError) {
      return {
        outcome: "error",
        fetchedCount: 0,
        filteredCount: 0,
        revisions: [],
        error: `Failed to read response body: ${readError instanceof Error ? readError.message : String(readError)}`,
      };
    }

    const textToParse = extractFeatureCollectionText(rawText);
    let parseResult: PetabencanaParseResult;
    try {
      parseResult = parsePetaBencanaReports(textToParse, retrievedAt);
    } catch (parseError) {
      return {
        outcome: "error",
        fetchedCount: 0,
        filteredCount: 0,
        revisions: [],
        error: `PetaBencana parser exception: ${parseError instanceof Error ? parseError.message : String(parseError)}`,
      };
    }

    if (parseResult.kind === "error") {
      return {
        outcome: "error",
        fetchedCount: 0,
        filteredCount: 0,
        revisions: [],
        error: `PetaBencana parser error: ${parseResult.error.code}`,
      };
    }

    if (parseResult.kind === "empty" || parseResult.reports.length === 0) {
      return {
        outcome: "empty",
        fetchedCount: 0,
        filteredCount: 0,
        revisions: [],
      };
    }

    let mapped: { revisions: readonly StoredReportRevision[]; filteredCount: number };
    try {
      mapped = await mapPetabencanaReportsToRevisions(parseResult.reports, retrievedAt, {
        sourceId: options.sourceId,
        canonicalBase: options.canonicalBase,
      });
    } catch (mapError) {
      return {
        outcome: "error",
        fetchedCount: parseResult.reports.length,
        filteredCount: 0,
        revisions: [],
        error: `Report mapping failed: ${mapError instanceof Error ? mapError.message : String(mapError)}`,
      };
    }

    const { revisions, filteredCount } = mapped;

    if (revisions.length === 0) {
      return {
        outcome: "empty",
        fetchedCount: parseResult.reports.length,
        filteredCount,
        revisions: [],
      };
    }

    if (options.onRevisions) {
      try {
        await options.onRevisions(revisions);
      } catch (callbackError) {
        return {
          outcome: "error",
          fetchedCount: parseResult.reports.length,
          filteredCount,
          revisions,
          error: `Callback onRevisions failed: ${callbackError instanceof Error ? callbackError.message : String(callbackError)}`,
        };
      }
    }

    if (options.persistence?.saveRevisions) {
      try {
        await options.persistence.saveRevisions(revisions);
      } catch (persistError) {
        return {
          outcome: "error",
          fetchedCount: parseResult.reports.length,
          filteredCount,
          revisions,
          error: `Persistence saveRevisions failed: ${persistError instanceof Error ? persistError.message : String(persistError)}`,
        };
      }
    }

    return {
      outcome: "success",
      fetchedCount: parseResult.reports.length,
      filteredCount,
      revisions,
    };
  }

  return {
    poll: executePoll,
    pollOnce: () => executePoll(),
  };
}
