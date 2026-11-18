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
const PETABENCANA_REPORT_TYPE = /^Laporan (.+?) PetaBencana ID /;

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
    // HOSTED-35a: the "Waktu pembuatan laporan" line is when the citizen created the report, not when the event happened.
    // The source gives no event time, so it stays unknown.
    eventTime: { value: null, precision: "unknown" },
    entities: [],
    impacts: [],
    operationalStatus: "unknown",
    // HOSTED-36: the claim text is the report's own sentence (summary), which is a substring of the chunk. Not a placeholder.
    evidence: evidenceFromFirstChunk(input, summary),
    conflictingInfo: [],
    uncertaintyNotes: [
      "Tingkat keparahan tidak tersedia dari sumber.",
      "Waktu kejadian tidak dinyatakan sumber; waktu pembuatan laporan bukan waktu kejadian.",
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

type EventTime = ReportInterpretation["eventTime"];
interface CalendarDay { readonly year: number; readonly month: number; readonly day: number }
/** A calendar date the report text states. The year is null when the text gives none. */
interface StatedDate { readonly day: number; readonly month: number; readonly year: number | null }

const UNKNOWN_EVENT_TIME: EventTime = { value: null, precision: "unknown" };
// Asia/Jakarta (WIB) is UTC+7 all year round, so the offset is fixed.
const WIB_OFFSET_MINUTES = 7 * 60;
const MINUTES_PER_DAY = 24 * 60;
const DAYS_IN_MONTH = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const MONTH_NUMBERS: Readonly<Record<string, number>> = {
  januari: 1, jan: 1,
  februari: 2, feb: 2, pebruari: 2,
  maret: 3, mar: 3,
  april: 4, apr: 4,
  mei: 5,
  juni: 6, jun: 6,
  juli: 7, jul: 7,
  agustus: 8, agu: 8, agt: 8, ags: 8,
  september: 9, sep: 9, sept: 9,
  oktober: 10, okt: 10,
  november: 11, nov: 11,
  desember: 12, des: 12,
};
// Longest names first, so "november" is not read as "nov" followed by letters.
const MONTH_NAMES = Object.keys(MONTH_NUMBERS).sort((a, b) => b.length - a.length).join("|");
const ZONE_OFFSET_HOURS: Readonly<Record<string, number>> = { wib: 7, wita: 8, wit: 9 };

// "18 November 2026", "17 Nov", "17 November." (day, month name, optional year)
const NAMED_DATE = new RegExp(`(?<!\\d)(\\d{1,2})\\s+(${MONTH_NAMES})\\b\\.?(?:\\s+(\\d{4})(?!\\d))?`, "giu");
// "17/11/2026" or "Senin (17/11)" (day/month in the Indonesian order, year optional)
const SLASH_DATE = /(?<![\d/])(\d{1,2})\/(\d{1,2})(?:\/(\d{4}))?(?![\d/])/gu;
// "17-11-2026" or "17.11.2026"
const DASH_DOT_DATE = /(?<![\d.-])(\d{1,2})([-.])(\d{1,2})\2(\d{4})(?!\d)/gu;
// "pukul 14.30 WIB", "jam 9 pagi", "pkl 14:30"
const PREFIXED_CLOCK = new RegExp(
  `(?<![\\p{L}\\d])(?:pukul|pkl\\.?|pk\\.?|jam)\\s*(\\d{1,2})(?:[.:](\\d{2}))?(?:\\s+(dini hari|pagi|siang|sore|malam))?(?:\\s+(wib|wita|wit)(?!\\p{L}))?`,
  "giu",
);
// "14.30 WIB" or "14:30 WIB"
const ZONED_CLOCK = /(?<!\d)(\d{1,2})[.:](\d{2})\s*(wib|wita|wit)(?!\p{L})/giu;
// "14:30" with no zone. The lookbehind skips an ISO timestamp such as "2026-11-16T10:00:00Z".
const COLON_CLOCK = /(?<![\dT:])(\d{1,2}):(\d{2})(?![\d:])/gu;
const EXPLICIT_ZONE = /(?:Z|[+-]\d{2}:\d{2})$/iu;
const DATE_TIME_START = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/u;
const LEADING_DATE = /^(\d{4})-(\d{2})-(\d{2})/u;

function isValidCalendarDay(day: number, month: number): boolean {
  return Number.isInteger(month) && month >= 1 && month <= 12 && day >= 1 && day <= DAYS_IN_MONTH[month - 1]!;
}

/**
 * Every calendar date the report text states, in an Indonesian or numeric form. Relative words such as "kemarin",
 * "tadi malam" or "hari ini" state no date, so they never count.
 */
export function statedCalendarDates(reportText: string): StatedDate[] {
  const dates: StatedDate[] = [];
  const add = (day: number, month: number, year: number | null): void => {
    if (isValidCalendarDay(day, month)) dates.push({ day, month, year });
  };
  for (const match of reportText.matchAll(NAMED_DATE)) {
    add(Number(match[1]), MONTH_NUMBERS[match[2]!.toLowerCase()]!, match[3] ? Number(match[3]) : null);
  }
  for (const match of reportText.matchAll(SLASH_DATE)) {
    add(Number(match[1]), Number(match[2]), match[3] ? Number(match[3]) : null);
  }
  for (const match of reportText.matchAll(DASH_DOT_DATE)) {
    add(Number(match[1]), Number(match[3]), Number(match[4]));
  }
  return dates;
}

/**
 * The minutes after midnight UTC that a clock word can mean. An hour of 13 or more, or one with a leading zero such
 * as "09.30", is a 24-hour clock. A bare hour from 1 to 11 may be either half of the day, so both are kept. A period
 * word ("pagi", "siang", "sore", "malam", "dini hari") fixes the half. An unclear combination gives no time.
 */
function localHoursOf(hourText: string, period: string | null): number[] {
  const hour = Number(hourText);
  if (period === null) {
    if (hour === 0 || hour >= 13) return hour <= 23 ? [hour] : [];
    if (hourText.length === 2 && hourText.startsWith("0")) return [hour];
    if (hour === 12) return [0, 12];
    return [hour, hour + 12];
  }
  if (hour < 1 || hour > 12) return [];
  switch (period) {
    case "pagi": return hour <= 11 ? [hour] : [];
    case "siang": return hour >= 11 ? [hour] : hour <= 4 ? [hour + 12] : [];
    case "sore": return hour <= 6 ? [hour + 12] : [];
    case "malam": return hour === 12 ? [0] : hour >= 6 ? [hour + 12] : hour <= 4 ? [hour] : [];
    case "dini hari": return hour === 12 ? [0] : hour <= 5 ? [hour] : [];
    default: return [];
  }
}

/** The UTC minute of the day for every clock time the report text states. A time with no zone is read as WIB. */
function statedClockMinutes(reportText: string): Set<number> {
  const minutes = new Set<number>();
  const add = (hourText: string, minuteText: string | undefined, period: string | null, zone: string | null): void => {
    const minute = minuteText === undefined ? 0 : Number(minuteText);
    if (minute > 59) return;
    const offsetHours = zone === null ? 7 : ZONE_OFFSET_HOURS[zone]!;
    for (const hour of localHoursOf(hourText, period)) {
      const utc = (hour * 60 + minute - offsetHours * 60) % MINUTES_PER_DAY;
      minutes.add((utc + MINUTES_PER_DAY) % MINUTES_PER_DAY);
    }
  };
  for (const match of reportText.matchAll(PREFIXED_CLOCK)) {
    add(match[1]!, match[2], match[3]?.toLowerCase() ?? null, match[4]?.toLowerCase() ?? null);
  }
  for (const match of reportText.matchAll(ZONED_CLOCK)) {
    add(match[1]!, match[2], null, match[3]!.toLowerCase());
  }
  for (const match of reportText.matchAll(COLON_CLOCK)) {
    add(match[1]!, match[2], null, null);
  }
  return minutes;
}

/** An ISO date-time as epoch milliseconds. With no zone it is read as WIB, never as the machine's local time. */
function instantOf(value: string): number | null {
  if (!DATE_TIME_START.test(value)) return null;
  const zoned = EXPLICIT_ZONE.test(value) ? value : `${value}+07:00`;
  const ms = Date.parse(zoned);
  return Number.isFinite(ms) ? ms : null;
}

function jakartaDay(ms: number): CalendarDay {
  const shifted = new Date(ms + WIB_OFFSET_MINUTES * 60_000);
  return { year: shifted.getUTCFullYear(), month: shifted.getUTCMonth() + 1, day: shifted.getUTCDate() };
}

function utcMinuteOfDay(ms: number): number {
  return ((Math.floor(ms / 60_000) % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
}

function leadingCalendarDay(value: string): CalendarDay | null {
  const match = LEADING_DATE.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  return isValidCalendarDay(day, month) ? { year, month, day } : null;
}

function isoDay(date: CalendarDay): string {
  return `${String(date.year).padStart(4, "0")}-${String(date.month).padStart(2, "0")}-${String(date.day).padStart(2, "0")}`;
}

function statedDateMatches(stated: StatedDate, target: CalendarDay, publishedYear: number | null): boolean {
  if (stated.day !== target.day || stated.month !== target.month) return false;
  if (stated.year !== null) return stated.year === target.year;
  // No year in the text: the day and month must fall in the publication year, when that year is known.
  return publishedYear === null || publishedYear === target.year;
}

function groundEventTime(eventTime: EventTime, reportText: string, publishedAt: string | null): EventTime {
  const { value, precision } = eventTime;
  if (value === null || precision === "unknown") return UNKNOWN_EVENT_TIME;

  const stated = statedCalendarDates(reportText);
  const publishedInstant = publishedAt === null ? null : instantOf(publishedAt);
  const publishedYear = publishedInstant === null ? null : jakartaDay(publishedInstant).year;
  const dateIsStated = (target: CalendarDay): boolean =>
    stated.some((date) => statedDateMatches(date, target, publishedYear));

  if (precision === "exact") {
    const instant = instantOf(value);
    if (instant !== null) {
      // The publication minute is never the event: a value at that minute is the publish time copied across. A dateline
      // that prints the publish date and time would otherwise pass as a stated date and clock time.
      if (publishedInstant !== null && Math.floor(instant / 60_000) === Math.floor(publishedInstant / 60_000)) {
        return UNKNOWN_EVENT_TIME;
      }
      const day = jakartaDay(instant);
      // A clock time alone is not enough: without a stated date, the date is the model's own guess.
      if (!dateIsStated(day)) return UNKNOWN_EVENT_TIME;
      if (statedClockMinutes(reportText).has(utcMinuteOfDay(instant))) {
        // A zone-less time is written with WIB, so the stored value cannot be read in the server's local zone.
        return { value: EXPLICIT_ZONE.test(value) ? value : `${value}+07:00`, precision: "exact" };
      }
      return { value: isoDay(day), precision: "date" };
    }
  }

  // "date", "range", and an "exact" value that holds only a day. A range keeps no span: the text does not verify its end.
  const day = leadingCalendarDay(value);
  if (day === null || !dateIsStated(day)) return UNKNOWN_EVENT_TIME;
  return { value: isoDay(day), precision: "date" };
}

/**
 * HOSTED-35a: no invented event time. The model's event time is kept only when the report text states it.
 * - exact needs a stated calendar date that matches the value's WIB date and a stated clock time that matches its
 *   instant. A stated date with no matching clock time gives precision date.
 * - date and range need a stated calendar date that matches the value's day. A range keeps only that day.
 * - anything else, including a value with no stated date, becomes unknown with a null value.
 * The publication time is never an event time, so a day that only matches it is unknown. A relative word such as
 * "kemarin" states no date. Nothing is shifted or filled in. Source-stated times (PetaBencana, BMKG) never reach
 * this function.
 */
export function groundInterpretationTime(
  interpretation: ReportInterpretation,
  reportText: string,
  publishedAt: string | null | undefined,
): ReportInterpretation {
  const current = interpretation.eventTime;
  const next = groundEventTime(current, reportText, publishedAt ?? null);
  if (next.value === current.value && next.precision === current.precision) return interpretation;
  return { ...interpretation, eventTime: next };
}
