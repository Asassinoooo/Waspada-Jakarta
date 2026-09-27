export const PUBLIC_EVENT_UPDATES_CURSOR_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
export const PUBLIC_EVENT_UPDATES_CURSOR_TOKEN_MAX_LENGTH = 2_048;

const tokenVersion = "v1";
const signatureDomain = "waspada.public-event-updates.cursor.signature.v1\u0000";
const sequencePattern = /^(0|[1-9][0-9]{0,18})$/u;
const expiryPattern = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{3})Z$/u;
const maximumSequence = "9223372036854775807";
const payloadKeys = ["dataset", "sequence", "expires_at"] as const;
const textEncoder = new TextEncoder();

export interface PublicEventUpdatesCursorIssuedToken {
  readonly token: string;
  readonly expiresAt: string;
}

export interface PublicEventUpdatesDecodedCursor {
  readonly sequence: string;
  readonly expiresAt: string;
}

export interface PublicEventUpdatesCursorCodec {
  issue(sequence: unknown): Promise<PublicEventUpdatesCursorIssuedToken>;
  decode(token: unknown): Promise<PublicEventUpdatesDecodedCursor>;
}

export type PublicEventUpdatesCursorCodecErrorCode =
  | "INVALID_CURSOR"
  | "CURSOR_EXPIRED"
  | "CURSOR_ISSUE_FAILED";

const errorMessages: Record<PublicEventUpdatesCursorCodecErrorCode, string> = {
  INVALID_CURSOR: "The public update cursor is invalid.",
  CURSOR_EXPIRED: "The public update cursor has expired.",
  CURSOR_ISSUE_FAILED: "The public update cursor could not be issued.",
};

/** Fixed errors omit raw tokens, sequences, key material, and Web Crypto details. */
export class PublicEventUpdatesCursorCodecError extends Error {
  constructor(readonly code: PublicEventUpdatesCursorCodecErrorCode) {
    super(errorMessages[code]);
    this.name = "PublicEventUpdatesCursorCodecError";
  }
}

/** Creates a stateless, domain-separated HMAC cursor codec using Workers Web Crypto. */
export function createPublicEventUpdatesCursorCodec(options: {
  readonly key: CryptoKey;
  readonly now: () => number;
}): PublicEventUpdatesCursorCodec {
  return {
    async issue(sequence) {
      const validatedSequence = validateIssueSequence(sequence);
      const expiresAt = formatExpiry(readClock(options.now, "CURSOR_ISSUE_FAILED"));

      try {
        const payloadText = JSON.stringify({
          dataset: "live",
          sequence: validatedSequence,
          expires_at: expiresAt,
        });
        const payloadEncoded = encodeBase64Url(textEncoder.encode(payloadText));
        const tokenPrefix = `${tokenVersion}.${payloadEncoded}`;
        const signature = await globalThis.crypto.subtle.sign(
          "HMAC",
          options.key,
          textEncoder.encode(`${signatureDomain}${tokenPrefix}.`),
        );
        const token = `${tokenPrefix}.${encodeBase64Url(new Uint8Array(signature))}`;
        if (token.length > PUBLIC_EVENT_UPDATES_CURSOR_TOKEN_MAX_LENGTH) fail("CURSOR_ISSUE_FAILED");
        return { token, expiresAt };
      } catch {
        fail("CURSOR_ISSUE_FAILED");
      }
    },

    async decode(token) {
      if (typeof token !== "string" || token.length === 0
        || token.length > PUBLIC_EVENT_UPDATES_CURSOR_TOKEN_MAX_LENGTH) {
        fail("INVALID_CURSOR");
      }

      const parts = token.split(".");
      if (parts.length !== 3 || parts[0] !== tokenVersion) fail("INVALID_CURSOR");
      const payloadEncoded = parts[1]!;
      const signatureEncoded = parts[2]!;
      const payloadBytes = decodeBase64UrlOrNull(payloadEncoded);
      const signatureBytes = decodeBase64UrlOrNull(signatureEncoded);
      if (payloadBytes === null || signatureBytes === null || signatureBytes.length !== 32) {
        fail("INVALID_CURSOR");
      }

      let signatureValid: boolean;
      try {
        signatureValid = await globalThis.crypto.subtle.verify(
          "HMAC",
          options.key,
          signatureBytes,
          textEncoder.encode(`${signatureDomain}${tokenVersion}.${payloadEncoded}.`),
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
      if (payload === null || !hasExactKeys(payload, payloadKeys)
        || JSON.stringify(payload) !== payloadText
        || payload.dataset !== "live"
        || !isSequence(payload.sequence)
        || typeof payload.expires_at !== "string"
        || !isCanonicalExpiry(payload.expires_at)) {
        fail("INVALID_CURSOR");
      }

      const now = readClock(options.now, "INVALID_CURSOR");
      if (Date.parse(payload.expires_at) <= now) fail("CURSOR_EXPIRED");
      return { sequence: payload.sequence, expiresAt: payload.expires_at };
    },
  };
}

function validateIssueSequence(value: unknown): string {
  if (!isSequence(value)) fail("CURSOR_ISSUE_FAILED");
  return value;
}

function isSequence(value: unknown): value is string {
  return typeof value === "string"
    && sequencePattern.test(value)
    && compareSequences(value, maximumSequence) <= 0;
}

function compareSequences(left: string, right: string): number {
  if (left.length !== right.length) return left.length < right.length ? -1 : 1;
  return left === right ? 0 : left < right ? -1 : 1;
}

function isCanonicalExpiry(value: string): boolean {
  const match = expiryPattern.exec(value);
  if (match === null || Number(match[1]) < 1) return false;
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  if (month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) return false;
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    && date.toISOString() === value
    && day >= 1
    && day <= daysInMonth(Number(match[1]), month);
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function formatExpiry(now: number): string {
  if (!Number.isSafeInteger(now)) fail("CURSOR_ISSUE_FAILED");
  try {
    const value = new Date(now + PUBLIC_EVENT_UPDATES_CURSOR_TTL_MS).toISOString();
    if (!isCanonicalExpiry(value)) fail("CURSOR_ISSUE_FAILED");
    return value;
  } catch {
    fail("CURSOR_ISSUE_FAILED");
  }
}

function readClock(
  now: () => number,
  code: "INVALID_CURSOR" | "CURSOR_ISSUE_FAILED",
): number {
  try {
    const value = now();
    if (!Number.isSafeInteger(value)) fail(code);
    return value;
  } catch {
    fail(code);
  }
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

function fail(code: PublicEventUpdatesCursorCodecErrorCode): never {
  throw new PublicEventUpdatesCursorCodecError(code);
}
