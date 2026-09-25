const MAX_REPORT_CODE_POINTS = 200_000;

/**
 * NFKC normalization, CRLF/CR to LF, then the narrow contact patterns below.
 * Changing any part of this sequence or its replacements requires a new version.
 */
export const NORMALIZATION_VERSION = "nfkc-lf-contact-redaction-v1";
export const MAX_PERMITTED_TEXT_CODE_POINTS = MAX_REPORT_CODE_POINTS;

const EMAIL_PATTERN = /(?<![A-Z0-9._%+-])[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}(?![A-Z0-9.-])/giu;
const INDONESIAN_MOBILE_PATTERN = /(?<![A-Z0-9])(?:\+62|62|0)[ .-]?8(?:[ .-]?\d){8,11}(?!\d)/giu;

export interface RedactionCounts {
  readonly email: number;
  readonly indonesianMobile: number;
}

export interface PreparedText {
  /** SHA-256 of the caller-supplied text; the text itself is never returned. */
  readonly sourceInputHash: string;
  /** SHA-256 of the exact normalized and redacted UTF-8 text. */
  readonly permittedTextHash: string;
  readonly normalizationVersion: typeof NORMALIZATION_VERSION;
  readonly permittedText: string;
  /** Counts only. Matched values are never included in returned metadata. */
  readonly redactions: RedactionCounts;
}

/**
 * Deterministic text preparation for text that a caller has already screened
 * for source access and reuse permission. Pattern matching is incomplete: this
 * is not a comprehensive PII detector and does not authorize live persistence.
 */
export async function preparePermittedText(input: string): Promise<PreparedText> {
  if (typeof input !== "string") throw new Error("Input must be text");
  if (input.length > MAX_REPORT_CODE_POINTS * 2) throw new Error("Input exceeds the text preparation limit");
  if (hasUnpairedSurrogate(input)) throw new Error("Input contains invalid Unicode");

  const inputCodePoints = Array.from(input).length;
  if (inputCodePoints > MAX_REPORT_CODE_POINTS) throw new Error("Input exceeds the text preparation limit");

  const sourceInputHash = await sha256Utf8(input);
  let permittedText = input.normalize("NFKC").replace(/\r\n?/g, "\n");
  const email = { count: 0 };
  permittedText = permittedText.replace(EMAIL_PATTERN, () => {
    email.count += 1;
    return "[REDACTED:email]";
  });
  const indonesianMobile = { count: 0 };
  permittedText = permittedText.replace(INDONESIAN_MOBILE_PATTERN, () => {
    indonesianMobile.count += 1;
    return "[REDACTED:indonesian-mobile]";
  });

  if (Array.from(permittedText).length > MAX_PERMITTED_TEXT_CODE_POINTS) {
    throw new Error("Normalized text exceeds the text preparation limit");
  }

  return {
    sourceInputHash,
    permittedTextHash: await sha256Utf8(permittedText),
    normalizationVersion: NORMALIZATION_VERSION,
    permittedText,
    redactions: { email: email.count, indonesianMobile: indonesianMobile.count },
  };
}

async function sha256Utf8(value: string): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error("SHA-256 is unavailable in this runtime");
  const digest = await subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return true;
    }
  }
  return false;
}
