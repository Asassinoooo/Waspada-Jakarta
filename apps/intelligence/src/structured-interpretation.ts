import type { ReportInterpretation } from "./agents/report-interpretation-agent.js";
import { ReportInterpretationSchema } from "./agents/report-interpretation-agent.js";

/**
 * AI-RPM-01: structured authoritative sources build their interpretation
 * deterministically, so no interpretation model call is spent on them.
 *
 * The ids must match the worker's source ids (PETABENCANA_SOURCE_ID and
 * BMKG_GEMPA_SOURCE_ID). Tests pin that match.
 *
 * The job only has the revision text, so the structured facts are read back
 * from the canonical text that the worker formatters write. A fact that does
 * not parse stays unknown or null. Nothing is inferred beyond the source text.
 */
export const PETABENCANA_SOURCE_ID = "petabencana";
export const BMKG_GEMPA_SOURCE_ID = "source-bmkg-gempa";

/**
 * HOSTED-17 (owner decision, 17 Nov 2026): PetaBencana reports carry no place-name field, only a map point. Their
 * location label is this fixed source label, not a place. It is written by the deterministic path only, so the model
 * path's grounding never sees it. It is never derived from the report text, a gazetteer or a region.
 */
export const PETABENCANA_SOURCE_LABEL = "Laporan warga PetaBencana";

export interface StructuredInterpretationInput {
  readonly sourceId: string | undefined;
  readonly reportText: string;
  readonly evidenceChunks: ReadonlyArray<{ readonly chunkId: string; readonly text: string }>;
}

// "Koordinat lokasi [lon, lat]." (PetaBencana formatter)
const PETABENCANA_COORDINATES = /Koordinat lokasi \[(-?\d+(?:\.\d+)?), (-?\d+(?:\.\d+)?)\]/;
// "Waktu pembuatan laporan: <RFC3339>." (PetaBencana formatter)
const PETABENCANA_CREATED_AT = /Waktu pembuatan laporan: (\S+?)\.(?=\s|$)/;
const PETABENCANA_REPORT_TYPE = /^Laporan (.+?) PetaBencana ID /;
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

// "[lon, lat] BMKG: Gempa bumi M <mag> di <wilayah>, kedalaman ..." (BMKG mapper)
const BMKG_COORDINATE_PREFIX = /^\[(-?\d+(?:\.\d+)?), (-?\d+(?:\.\d+)?)\] /;
const BMKG_REGION = /Gempa bumi M \S+ di (.+?), kedalaman /;

function parseCoordinates(match: RegExpMatchArray | null): [number, number] | null {
  if (!match) return null;
  const lon = Number(match[1]);
  const lat = Number(match[2]);
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;
  if (lon < -180 || lon > 180 || lat < -90 || lat > 90) return null;
  return [lon, lat];
}

function buildPetaBencana(input: StructuredInterpretationInput): ReportInterpretation {
  const text = input.reportText;
  const summary = text.split(" Koordinat lokasi ")[0]!.trim() || text.trim();
  const reportType = PETABENCANA_REPORT_TYPE.exec(text)?.[1]?.trim() || "banjir";
  const coordinates = parseCoordinates(PETABENCANA_COORDINATES.exec(text));
  const createdRaw = PETABENCANA_CREATED_AT.exec(text)?.[1] ?? null;
  const createdMs = createdRaw !== null && RFC3339.test(createdRaw) ? Date.parse(createdRaw) : Number.NaN;
  const eventTime = Number.isFinite(createdMs)
    ? { value: new Date(createdMs).toISOString(), precision: "exact" as const }
    : { value: null, precision: "unknown" as const };

  return {
    summary,
    incidentType: reportType,
    severity: "unknown",
    // Every PetaBencana feed in this pipeline is flood (disaster=flood).
    primaryCategory: "disasters_weather",
    location: {
      // HOSTED-17: the fixed source label. The coordinate, when present, is still the source's own text.
      label: PETABENCANA_SOURCE_LABEL,
      approximateCoordinates: coordinates,
      precision: coordinates ? "approximate" : "unknown",
    },
    eventTime,
    entities: [],
    impacts: [],
    operationalStatus: "unknown",
    // HOSTED-36: the claim text is the report's own sentence (summary), which is a substring of the chunk. Not a placeholder.
    evidence: evidenceFromFirstChunk(input, summary),
    conflictingInfo: [],
    uncertaintyNotes: [
      "Tingkat keparahan tidak tersedia dari sumber.",
      ...(coordinates ? ["Titik lokasi berasal dari laporan warga, bukan batas wilayah resmi."] : []),
    ],
    confidence: "medium",
  };
}

function buildBmkgGempa(input: StructuredInterpretationInput): ReportInterpretation {
  const text = input.reportText;
  const coordinates = parseCoordinates(BMKG_COORDINATE_PREFIX.exec(text));
  const summary = text.replace(BMKG_COORDINATE_PREFIX, "").trim() || text.trim();
  const region = BMKG_REGION.exec(text)?.[1]?.trim() ?? null;

  return {
    summary,
    incidentType: "gempa bumi",
    // Magnitude is not a severity level; the source gives no severity field.
    severity: "unknown",
    primaryCategory: "disasters_weather",
    location: {
      label: region && region.length > 0 ? region : null,
      approximateCoordinates: coordinates,
      precision: coordinates || region ? "approximate" : "unknown",
    },
    // The BMKG revision carries no event timestamp: serve:live does not persist
    // published_at, and the text has none. The time stays unknown.
    eventTime: { value: null, precision: "unknown" },
    entities: [],
    impacts: [],
    operationalStatus: "unknown",
    // HOSTED-36: the claim text is the quake's own sentence (summary), which is a substring of the chunk. Not a placeholder.
    evidence: evidenceFromFirstChunk(input, summary),
    conflictingInfo: [],
    uncertaintyNotes: [
      "Waktu kejadian tidak tersedia dalam teks sumber.",
      "Tingkat keparahan tidak dinyatakan sumber.",
    ],
    confidence: "medium",
  };
}

function evidenceFromFirstChunk(
  input: StructuredInterpretationInput,
  supports: string,
): ReportInterpretation["evidence"] {
  const first = input.evidenceChunks[0];
  if (!first || first.text.length === 0) return [];
  return [{ chunkId: first.chunkId, exactQuote: first.text, supports }];
}

/**
 * The deterministic interpretation for a PetaBencana or BMKG revision, or null
 * when the source is not one of them. The result always passes
 * ReportInterpretationSchema, so downstream code is unchanged.
 */
export function deterministicStructuredInterpretation(
  input: StructuredInterpretationInput,
): ReportInterpretation | null {
  if (input.sourceId === PETABENCANA_SOURCE_ID) {
    return ReportInterpretationSchema.parse(buildPetaBencana(input));
  }
  if (input.sourceId === BMKG_GEMPA_SOURCE_ID) {
    return ReportInterpretationSchema.parse(buildBmkgGempa(input));
  }
  return null;
}

function normalizeForMatch(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * HOSTED-14: true when the report text states the label. The label, or any comma-separated part of it, must appear
 * in the text, case-insensitively. Parts shorter than three characters do not count. A bare "Jakarta" still passes
 * when the text names Jakarta, so a broad label is a known gap.
 */
export function labelIsStatedInText(label: string | null, reportText: string): boolean {
  if (label === null) return false;
  const haystack = normalizeForMatch(reportText);
  const parts = [label, ...label.split(",")].map(normalizeForMatch).filter((part) => part.length >= 3);
  return parts.some((part) => haystack.includes(part));
}

/**
 * HOSTED-14: no invented location. A model's label is kept only when the report text states it. A model coordinate is
 * kept only when a stated place name backs it, which here means the stated label. Otherwise the label and the
 * coordinate become null, and the precision becomes unknown when nothing is left. Nothing is replaced with a default.
 * Source-stated coordinates (PetaBencana, BMKG) never reach this function: they come from the deterministic path.
 */
export function groundInterpretationLocation(interpretation: ReportInterpretation, reportText: string): ReportInterpretation {
  const { label, approximateCoordinates, precision } = interpretation.location;
  const stated = labelIsStatedInText(label, reportText);
  const nextLabel = stated ? label : null;
  const nextCoordinates = stated ? approximateCoordinates : null;
  if (nextLabel === label && nextCoordinates === approximateCoordinates) return interpretation;
  return {
    ...interpretation,
    location: {
      label: nextLabel,
      approximateCoordinates: nextCoordinates,
      precision: nextLabel === null && nextCoordinates === null ? "unknown" : precision,
    },
  };
}
