import type {
  PublicEventListCursor,
  PublicEventListFilters,
} from "./public-event-list-projection-service.js";

export const PUBLIC_EVENT_LIST_CURSOR_TTL_MS = 15 * 60 * 1_000;
export const PUBLIC_EVENT_LIST_CURSOR_TOKEN_MAX_LENGTH = 2_048;

const tokenVersion = "v1";
const signatureDomain = "waspada.public-event-list.cursor.signature.v1\u0000";
const filterBindingDomain = "waspada.public-event-list.cursor.filters.v1\u0000";
const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const cursorTimestampPattern = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{6})Z$/u;
const filterDateTimePattern = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|([+-])(\d{2}):(\d{2}))$/u;
const expiryPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const maxDateRangeMicros = 90n * 24n * 60n * 60n * 1_000_000n;
const maxFilterDateTimeLength = 128;
const categories = new Set([
  "crime_personal_security",
  "demonstrations_public_gatherings",
  "crowds_major_events",
  "violence_immediate_threats",
  "disasters_weather",
  "fires_infrastructure_hazards",
  "transport_road_incidents",
  "utilities_essential_services",
  "health_environmental_advisories",
  "group_specific_critical_notices",
]);
const lifecycles = new Set(["planned", "ongoing", "resolved", "cancelled", "unknown"]);
const freshnessStatuses = new Set(["current", "needs_update", "expired"]);
const filterKeys = ["category", "lifecycle", "freshness", "from", "to", "q", "place_id"] as const;
const payloadKeys = ["firstPublishedAt", "eventId", "expiresAt", "filterBinding"] as const;
const textEncoder = new TextEncoder();

export interface PublicEventListCursorIssuedToken {
  readonly token: string;
  /** UTC ISO timestamp corresponding to the token's enforced expiry. */
  readonly expiresAt: string;
}

export interface PublicEventListDecodedCursor {
  readonly cursor: PublicEventListCursor;
  /** UTC ISO timestamp corresponding to the token's enforced expiry. */
  readonly expiresAt: string;
}

export interface PublicEventListCursorCodec {
  issue(cursor: PublicEventListCursor, filters?: PublicEventListFilters): Promise<PublicEventListCursorIssuedToken>;
  decode(token: string, filters?: PublicEventListFilters): Promise<PublicEventListDecodedCursor>;
}

export type PublicEventListCursorCodecErrorCode =
  | "INVALID_CURSOR"
  | "CURSOR_EXPIRED"
  | "CURSOR_FILTER_MISMATCH"
  | "CURSOR_ISSUE_FAILED";

const errorMessages: Record<PublicEventListCursorCodecErrorCode, string> = {
  INVALID_CURSOR: "The public event list cursor is invalid.",
  CURSOR_EXPIRED: "The public event list cursor has expired.",
  CURSOR_FILTER_MISMATCH: "The public event list cursor does not match these filters.",
  CURSOR_ISSUE_FAILED: "The public event list cursor could not be issued.",
};

/** Stable redacted errors; details from Web Crypto, inputs, and keys are discarded. */
export class PublicEventListCursorCodecError extends Error {
  constructor(readonly code: PublicEventListCursorCodecErrorCode) {
    super(errorMessages[code]);
    this.name = "PublicEventListCursorCodecError";
  }
}

/**
 * Creates a stateless HMAC cursor codec. The caller owns key provisioning and
 * clock selection; this module uses only Workers-compatible Web Crypto APIs.
 */
export function createPublicEventListCursorCodec(options: {
  readonly key: CryptoKey;
  readonly now: () => number;
}): PublicEventListCursorCodec {
  return {
    async issue(cursor, filters) {
      const validatedCursor = validateCursorBoundary(cursor);
      const normalizedFilters = normalizeFiltersBoundary(filters);
      const now = readClock(options.now, "CURSOR_ISSUE_FAILED");
      const expiresAt = formatExpiry(now);

      try {
        const subtle = globalThis.crypto.subtle;
        const filterBinding = await subtle.sign(
          "HMAC",
          options.key,
          joinBytes(textEncoder.encode(filterBindingDomain), textEncoder.encode(JSON.stringify(normalizedFilters))),
        );
        const payload = JSON.stringify({
          firstPublishedAt: validatedCursor.firstPublishedAt,
          eventId: validatedCursor.eventId,
          expiresAt,
          filterBinding: encodeBase64Url(new Uint8Array(filterBinding)),
        });
        const payloadEncoded = encodeBase64Url(textEncoder.encode(payload));
        const tokenPrefix = `${tokenVersion}.${payloadEncoded}`;
        const signature = await subtle.sign(
          "HMAC",
          options.key,
          joinBytes(textEncoder.encode(`${signatureDomain}${tokenPrefix}.`)),
        );
        const token = `${tokenPrefix}.${encodeBase64Url(new Uint8Array(signature))}`;
        if (token.length > PUBLIC_EVENT_LIST_CURSOR_TOKEN_MAX_LENGTH) fail("CURSOR_ISSUE_FAILED");
        return { token, expiresAt };
      } catch {
        fail("CURSOR_ISSUE_FAILED");
      }
    },

    async decode(token, filters) {
      if (typeof token !== "string" || token.length === 0
        || token.length > PUBLIC_EVENT_LIST_CURSOR_TOKEN_MAX_LENGTH) {
        fail("INVALID_CURSOR");
      }

      const parts = token.split(".");
      if (parts.length !== 3 || parts[0] !== tokenVersion) fail("INVALID_CURSOR");
      const payloadEncoded = parts[1]!;
      const signatureEncoded = parts[2]!;
      const payloadBytes = decodeBase64UrlOrNull(payloadEncoded);
      const signatureBytes = decodeBase64UrlOrNull(signatureEncoded);
      if (payloadBytes === null || signatureBytes === null || signatureBytes.length !== 32) fail("INVALID_CURSOR");

      let signatureValid: boolean;
      try {
        signatureValid = await globalThis.crypto.subtle.verify(
          "HMAC",
          options.key,
          signatureBytes,
          joinBytes(textEncoder.encode(`${signatureDomain}${tokenVersion}.${payloadEncoded}.`)),
        );
      } catch {
        fail("INVALID_CURSOR");
      }
      if (!signatureValid) fail("INVALID_CURSOR");

      let payloadText: string;
      let payloadValue: unknown;
      try {
        payloadText = new TextDecoder("utf-8", { fatal: true }).decode(payloadBytes);
        payloadValue = JSON.parse(payloadText) as unknown;
      } catch {
        fail("INVALID_CURSOR");
      }
      const payload = snapshotPlainRecord(payloadValue);
      if (payload === null || !hasExactKeys(payload, payloadKeys)) fail("INVALID_CURSOR");
      // Reject duplicate JSON keys and non-canonical encodings after authentication.
      if (JSON.stringify(payload) !== payloadText) fail("INVALID_CURSOR");

      const cursor = validateCursorBoundary({
        firstPublishedAt: payload.firstPublishedAt,
        eventId: payload.eventId,
      });
      if (typeof payload.expiresAt !== "string" || !isCanonicalExpiry(payload.expiresAt)) fail("INVALID_CURSOR");
      if (typeof payload.filterBinding !== "string") fail("INVALID_CURSOR");
      const filterBinding = decodeBase64UrlOrNull(payload.filterBinding);
      if (filterBinding === null || filterBinding.length !== 32) fail("INVALID_CURSOR");

      const expiresAt = payload.expiresAt;
      const now = readClock(options.now, "INVALID_CURSOR");
      if (Date.parse(expiresAt) <= now) fail("CURSOR_EXPIRED");

      const normalizedFilters = normalizeFiltersBoundary(filters);
      let filtersMatch: boolean;
      try {
        filtersMatch = await globalThis.crypto.subtle.verify(
          "HMAC",
          options.key,
          filterBinding,
          joinBytes(textEncoder.encode(filterBindingDomain), textEncoder.encode(JSON.stringify(normalizedFilters))),
        );
      } catch {
        fail("INVALID_CURSOR");
      }
      if (!filtersMatch) fail("CURSOR_FILTER_MISMATCH");

      return { cursor, expiresAt };
    },
  };
}

function normalizeFiltersBoundary(value: PublicEventListFilters | undefined): PublicEventListFilters {
  if (value === undefined) return {};
  const filters = snapshotPlainRecord(value);
  if (filters === null || !hasAllowedKeys(filters, filterKeys)) fail("INVALID_CURSOR");

  const normalized: {
    category?: PublicEventListFilters["category"];
    lifecycle?: PublicEventListFilters["lifecycle"];
    freshness?: PublicEventListFilters["freshness"];
    from?: string;
    to?: string;
    q?: string;
    place_id?: string;
  } = {};

  if (Object.hasOwn(filters, "category")) {
    if (typeof filters.category !== "string" || !categories.has(filters.category)) fail("INVALID_CURSOR");
    normalized.category = filters.category as PublicEventListFilters["category"];
  }
  if (Object.hasOwn(filters, "lifecycle")) {
    if (typeof filters.lifecycle !== "string" || !lifecycles.has(filters.lifecycle)) fail("INVALID_CURSOR");
    normalized.lifecycle = filters.lifecycle as PublicEventListFilters["lifecycle"];
  }
  if (Object.hasOwn(filters, "freshness")) {
    if (typeof filters.freshness !== "string" || !freshnessStatuses.has(filters.freshness)) fail("INVALID_CURSOR");
    normalized.freshness = filters.freshness as PublicEventListFilters["freshness"];
  }

  let fromMicros: bigint | null = null;
  let toMicros: bigint | null = null;
  if (Object.hasOwn(filters, "from")) {
    if (typeof filters.from !== "string") fail("INVALID_CURSOR");
    fromMicros = parseFilterDateTimeMicrosOrNull(filters.from);
    if (fromMicros === null) fail("INVALID_CURSOR");
    normalized.from = filters.from;
  }
  if (Object.hasOwn(filters, "to")) {
    if (typeof filters.to !== "string") fail("INVALID_CURSOR");
    toMicros = parseFilterDateTimeMicrosOrNull(filters.to);
    if (toMicros === null) fail("INVALID_CURSOR");
    normalized.to = filters.to;
  }
  if (fromMicros !== null && toMicros !== null
    && (toMicros < fromMicros || toMicros - fromMicros > maxDateRangeMicros)) {
    fail("INVALID_CURSOR");
  }

  if (Object.hasOwn(filters, "q")) {
    if (typeof filters.q !== "string") fail("INVALID_CURSOR");
    const query = filters.q.trim();
    if (query.length > 120) fail("INVALID_CURSOR");
    if (query.length > 0) normalized.q = query.toLocaleLowerCase("id");
  }
  if (Object.hasOwn(filters, "place_id")) {
    if (typeof filters.place_id !== "string") fail("INVALID_CURSOR");
    const placeId = filters.place_id.trim();
    if (placeId.length > 128) fail("INVALID_CURSOR");
    if (placeId.length > 0) normalized.place_id = placeId;
  }

  return normalized;
}

function validateCursorBoundary(value: unknown): PublicEventListCursor {
  const cursor = snapshotPlainRecord(value);
  if (cursor === null || !hasExactKeys(cursor, ["firstPublishedAt", "eventId"])
    || !isCanonicalCursorTimestamp(cursor.firstPublishedAt)
    || !isIdentifier(cursor.eventId)) {
    fail("INVALID_CURSOR");
  }
  return { firstPublishedAt: cursor.firstPublishedAt, eventId: cursor.eventId };
}

function isCanonicalCursorTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = cursorTimestampPattern.exec(value);
  if (match === null) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  return year >= 1 && month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth(year, month)
    && hour <= 23 && minute <= 59 && second <= 59;
}

function isIdentifier(value: unknown): value is string {
  return typeof value === "string" && identifierPattern.test(value);
}

function isCanonicalExpiry(value: string): boolean {
  if (!expiryPattern.test(value)) return false;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString() === value;
}

function formatExpiry(now: number): string {
  if (!Number.isSafeInteger(now)) fail("CURSOR_ISSUE_FAILED");
  try {
    const expiresAt = new Date(now + PUBLIC_EVENT_LIST_CURSOR_TTL_MS).toISOString();
    if (!isCanonicalExpiry(expiresAt)) fail("CURSOR_ISSUE_FAILED");
    return expiresAt;
  } catch {
    fail("CURSOR_ISSUE_FAILED");
  }
}

function readClock(now: () => number, code: "INVALID_CURSOR" | "CURSOR_ISSUE_FAILED"): number {
  try {
    const value = now();
    if (!Number.isSafeInteger(value)) fail(code);
    return value;
  } catch {
    fail(code);
  }
}

function parseFilterDateTimeMicrosOrNull(value: string): bigint | null {
  if (value.length > maxFilterDateTimeLength) return null;
  const match = filterDateTimePattern.exec(value);
  if (match === null) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetSign = match[9];
  const offsetHour = match[10] === undefined ? 0 : Number(match[10]);
  const offsetMinute = match[11] === undefined ? 0 : Number(match[11]);
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)
    || hour > 23 || minute > 59 || second > 59 || offsetHour > 23 || offsetMinute > 59) {
    return null;
  }

  const fractionalDigits = match[7] ?? "";
  const microsText = fractionalDigits.slice(0, 6).padEnd(6, "0");
  let micros = BigInt(microsText || "0");
  if (fractionalDigits.length > 6 && fractionalDigits[6]! >= "5") micros += 1n;

  const localSeconds = daysFromCivil(year, month, day) * 86_400n
    + BigInt(hour * 3_600 + minute * 60 + second);
  const offsetSeconds = BigInt(offsetHour * 3_600 + offsetMinute * 60)
    * (offsetSign === "+" ? 1n : -1n);
  return (localSeconds - offsetSeconds) * 1_000_000n + micros;
}

function daysFromCivil(year: number, month: number, day: number): bigint {
  const adjustedYear = BigInt(year) - (month <= 2 ? 1n : 0n);
  const era = adjustedYear / 400n;
  const yearOfEra = adjustedYear - era * 400n;
  const adjustedMonth = BigInt(month + (month > 2 ? -3 : 9));
  const dayOfYear = (153n * adjustedMonth + 2n) / 5n + BigInt(day) - 1n;
  const dayOfEra = yearOfEra * 365n + yearOfEra / 4n - yearOfEra / 100n + dayOfYear;
  return era * 146_097n + dayOfEra - 719_468n;
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function snapshotPlainRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;

    const copy: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string") return null;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !Object.hasOwn(descriptor, "value")) return null;
      copy[key] = descriptor.value;
    }
    return copy;
  } catch {
    return null;
  }
}

function hasAllowedKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Reflect.ownKeys(value).every((key) => typeof key === "string" && allowed.includes(key));
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Reflect.ownKeys(value);
  return actual.length === expected.length
    && actual.every((key) => typeof key === "string" && expected.includes(key));
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/gu, "");
}

function decodeBase64UrlOrNull(value: string): Uint8Array<ArrayBuffer> | null {
  if (value.length === 0 || !/^[A-Za-z0-9_-]+$/u.test(value) || value.length % 4 === 1) return null;
  try {
    const standard = value.replace(/-/gu, "+").replace(/_/gu, "/");
    const padded = standard.padEnd(Math.ceil(standard.length / 4) * 4, "=");
    const binary = atob(padded);
    const bytes = new Uint8Array(new ArrayBuffer(binary.length));
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return encodeBase64Url(bytes) === value ? bytes : null;
  } catch {
    return null;
  }
}

function joinBytes(...parts: readonly Uint8Array<ArrayBuffer>[]): Uint8Array<ArrayBuffer> {
  const length = parts.reduce((total, part) => total + part.length, 0);
  const output = new Uint8Array(new ArrayBuffer(length));
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

function fail(code: PublicEventListCursorCodecErrorCode): never {
  throw new PublicEventListCursorCodecError(code);
}