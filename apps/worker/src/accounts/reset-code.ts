/**
 * AUTH-RESET-01 one-time password reset codes. Ten Crockford base32 characters carry 50 bits, drawn from
 * WebCrypto. The administrator sees the code once; the store keeps only its PBKDF2 hash.
 */

export const PASSWORD_RESET_CODE_LENGTH = 10;
export const PASSWORD_RESET_CODE_TTL_MS = 30 * 60_000;

/** Crockford base32: no I, L, O or U, so a typed code is hard to misread. Exactly 32 symbols. */
const crockfordAlphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const normalisedCodePattern = /^[0-9A-HJKMNP-TV-Z]{10}$/u;

/** A fresh code. 32 symbols and a 5-bit mask mean no modulo bias. */
export function generatePasswordResetCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(PASSWORD_RESET_CODE_LENGTH));
  let code = '';
  for (const byte of bytes) code += crockfordAlphabet.charAt(byte & 31);
  return code;
}

/** Accepts what a person types. Case, spaces and hyphens are ignored, and O, I and L read as 0 and 1. */
export function normalisePasswordResetCode(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 64) return null;
  const cleaned = value.toUpperCase().replace(/[\s-]/gu, '').replace(/O/gu, '0').replace(/[IL]/gu, '1');
  return normalisedCodePattern.test(cleaned) ? cleaned : null;
}
