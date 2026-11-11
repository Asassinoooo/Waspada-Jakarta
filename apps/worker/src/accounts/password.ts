/**
 * Password hashing for account-v1. WebCrypto only, so the same code runs in
 * Cloudflare Workers and Node 22/24 without node:crypto.
 *
 * Encoding: pbkdf2-sha256$<iterations>$<salt base64url>$<key base64url>
 */

export const PASSWORD_HASH_ALGORITHM = 'pbkdf2-sha256';
export const PASSWORD_HASH_ITERATIONS = 100_000;
export const PASSWORD_MIN_LENGTH = 10;
export const PASSWORD_MAX_LENGTH = 256;

const SALT_BYTES = 16;
const KEY_BYTES = 32;
const MIN_STORED_ITERATIONS = 10_000;
const MAX_STORED_ITERATIONS = 1_000_000;
const USERNAME_PATTERN = /^[a-z0-9_.]{3,32}$/u;
const HASH_PATTERN = /^pbkdf2-sha256\$([1-9][0-9]{4,6})\$([A-Za-z0-9_-]{22})\$([A-Za-z0-9_-]{43})$/u;

export type PasswordPolicyResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: 'password_too_short' | 'password_too_long' | 'password_invalid' };

/** Hashes a password with a fresh random salt. The returned string contains no plaintext. */
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(new ArrayBuffer(SALT_BYTES)));
  const key = await derive(password, salt, PASSWORD_HASH_ITERATIONS);
  return `${PASSWORD_HASH_ALGORITHM}$${PASSWORD_HASH_ITERATIONS}$${base64UrlEncode(salt)}$${base64UrlEncode(key)}`;
}

/**
 * Checks a password against a stored hash in constant time over the derived bytes.
 * A malformed or unparseable stored hash returns false instead of throwing.
 */
export async function verifyPassword(password: string, storedHash: string): Promise<boolean> {
  const parsed = parseStoredHash(storedHash);
  if (!parsed) return false;
  const derived = await derive(password, parsed.salt, parsed.iterations);
  return constantTimeEqualBytes(derived, parsed.key);
}

/** Length-only policy. Composition rules are deliberately not imposed. */
export function validatePasswordPolicy(password: unknown): PasswordPolicyResult {
  if (typeof password !== 'string') return { ok: false, code: 'password_invalid' };
  if (password.length < PASSWORD_MIN_LENGTH) return { ok: false, code: 'password_too_short' };
  if (password.length > PASSWORD_MAX_LENGTH) return { ok: false, code: 'password_too_long' };
  return { ok: true };
}

/** Trims and lowercases a username, then applies the stored format. Returns null when invalid. */
export function normaliseUsername(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const candidate = value.trim().toLowerCase();
  return USERNAME_PATTERN.test(candidate) ? candidate : null;
}

async function derive(password: string, salt: Uint8Array<ArrayBuffer>, iterations: number): Promise<Uint8Array<ArrayBuffer>> {
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    keyMaterial,
    KEY_BYTES * 8,
  );
  return new Uint8Array(bits);
}

function parseStoredHash(value: string): { iterations: number; salt: Uint8Array<ArrayBuffer>; key: Uint8Array<ArrayBuffer> } | null {
  if (typeof value !== 'string' || value.length > 256) return null;
  const match = HASH_PATTERN.exec(value);
  if (!match) return null;
  const iterations = Number(match[1]);
  if (!Number.isSafeInteger(iterations) || iterations < MIN_STORED_ITERATIONS || iterations > MAX_STORED_ITERATIONS) {
    return null;
  }
  const salt = base64UrlDecode(match[2]!);
  const key = base64UrlDecode(match[3]!);
  if (!salt || !key || salt.length !== SALT_BYTES || key.length !== KEY_BYTES) return null;
  return { iterations, salt, key };
}

function constantTimeEqualBytes(left: Uint8Array<ArrayBuffer>, right: Uint8Array<ArrayBuffer>): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left[index]! ^ right[index]!;
  }
  return difference === 0;
}

function base64UrlEncode(bytes: Uint8Array<ArrayBuffer>): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/gu, '');
}

function base64UrlDecode(value: string): Uint8Array<ArrayBuffer> | null {
  const padded = value.replace(/-/gu, '+').replace(/_/gu, '/') + '='.repeat((4 - (value.length % 4)) % 4);
  try {
    const binary = atob(padded);
    const bytes = new Uint8Array(new ArrayBuffer(binary.length));
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  } catch {
    return null;
  }
}
