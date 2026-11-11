import { AccountHttpError } from "./account-client.js";

/**
 * Client-side form rules and status-to-copy mapping for username/password accounts.
 * The server is the authority: these rules only give immediate feedback and mirror
 * `apps/worker/src/accounts/password.ts` (username format, length-only password policy).
 * Error copy is generic on purpose; it never says whether a username exists.
 */

export const USERNAME_PATTERN = /^[a-z0-9_.]{3,32}$/u;
export const PASSWORD_MIN_LENGTH = 10;
export const PASSWORD_MAX_LENGTH = 256;
export const SIGN_IN_HREF = "#masuk";

export type FieldErrors<Field extends string> = Partial<Record<Field, string>>;

export type RegistrationField = "username" | "password" | "confirm";
export type LoginField = "username" | "password";
export type PasswordChangeField = "current" | "next" | "confirm";

export const USERNAME_RULE_MESSAGE = "Gunakan 3 sampai 32 huruf kecil, angka, titik, atau garis bawah.";
export const PASSWORD_RULE_MESSAGE = "Kata sandi minimal 10 karakter dan maksimal 256 karakter.";

/** Trims and lowercases the username the same way the server does before it checks the format. */
export function normaliseUsernameInput(value: string): string {
  return value.trim().toLowerCase();
}

export function passwordPolicyProblem(password: string): string | null {
  if (password.length < PASSWORD_MIN_LENGTH) return "Kata sandi minimal 10 karakter.";
  if (password.length > PASSWORD_MAX_LENGTH) return "Kata sandi maksimal 256 karakter.";
  return null;
}

export function validateLogin(input: { username: string; password: string }): FieldErrors<LoginField> {
  const errors: FieldErrors<LoginField> = {};
  if (input.username.trim().length === 0) errors.username = "Masukkan username.";
  if (input.password.length === 0) errors.password = "Masukkan kata sandi.";
  return errors;
}

export function validateRegistration(input: {
  username: string;
  password: string;
  confirm: string;
}): FieldErrors<RegistrationField> {
  const errors: FieldErrors<RegistrationField> = {};
  if (!USERNAME_PATTERN.test(normaliseUsernameInput(input.username))) errors.username = USERNAME_RULE_MESSAGE;
  const passwordProblem = passwordPolicyProblem(input.password);
  if (passwordProblem !== null) errors.password = passwordProblem;
  if (input.confirm !== input.password) errors.confirm = "Konfirmasi kata sandi belum sama.";
  return errors;
}

export function validatePasswordChange(input: {
  current: string;
  next: string;
  confirm: string;
}): FieldErrors<PasswordChangeField> {
  const errors: FieldErrors<PasswordChangeField> = {};
  if (input.current.length === 0) errors.current = "Masukkan kata sandi saat ini.";
  const passwordProblem = passwordPolicyProblem(input.next);
  if (passwordProblem !== null) errors.next = passwordProblem;
  if (input.confirm !== input.next) errors.confirm = "Konfirmasi kata sandi baru belum sama.";
  return errors;
}

export function statusOfError(error: unknown): number | null {
  return error instanceof AccountHttpError ? error.status : null;
}

export function loginFailureMessage(error: unknown): string {
  switch (statusOfError(error)) {
    case 401: return "Username atau kata sandi tidak sesuai.";
    case 403: return "Permintaan masuk ditolak. Muat ulang halaman lalu coba lagi.";
    case 429: return "Terlalu banyak percobaan masuk. Tunggu beberapa menit sebelum mencoba lagi.";
    case 503: return "Layanan masuk sedang tidak tersedia. Coba lagi nanti.";
    default: return "Masuk belum dapat diproses. Periksa koneksi lalu coba lagi.";
  }
}

export function registrationFailureMessage(error: unknown): string {
  switch (statusOfError(error)) {
    case 400: return "Username atau kata sandi belum memenuhi aturan layanan.";
    case 403: return "Permintaan pendaftaran ditolak. Muat ulang halaman lalu coba lagi.";
    case 404: return "Pendaftaran akun baru belum tersedia di layanan ini.";
    case 409: return "Username ini sudah terdaftar. Pilih username lain.";
    case 429: return "Terlalu banyak percobaan pendaftaran. Tunggu beberapa menit lalu coba lagi.";
    case 503: return "Layanan akun sedang tidak tersedia. Coba lagi nanti.";
    default: return "Pendaftaran belum dapat diproses. Periksa koneksi lalu coba lagi.";
  }
}

export function passwordChangeFailureMessage(error: unknown): string {
  switch (statusOfError(error)) {
    case 400: return PASSWORD_RULE_MESSAGE;
    case 401: return "Sesi berakhir. Masuk kembali untuk mengubah kata sandi.";
    case 403: return "Kata sandi saat ini tidak sesuai, atau perubahan ditolak. Periksa kembali lalu coba lagi.";
    case 409: return "Akun berubah saat permintaan diproses. Muat ulang halaman lalu coba lagi.";
    case 429: return "Terlalu banyak percobaan ubah kata sandi. Tunggu beberapa menit lalu coba lagi.";
    case 503: return "Layanan akun sedang tidak tersedia. Coba lagi nanti.";
    default: return "Kata sandi belum dapat diubah. Periksa koneksi lalu coba lagi.";
  }
}

/**
 * Copy for a moderator-only surface that answered 401 (no session) or 403 (session without an
 * active moderator or admin role). Returns null for any other status.
 */
export function moderatorAccessMessage(status: number | null): string | null {
  if (status === 401) {
    return "Tampilan ini hanya untuk moderator yang sudah masuk. Masuk sebagai moderator untuk membukanya.";
  }
  if (status === 403) {
    return "Akun yang sedang masuk belum memiliki peran moderator yang aktif untuk tampilan ini.";
  }
  return null;
}
