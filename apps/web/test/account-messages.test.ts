import assert from "node:assert/strict";
import test from "node:test";
import { AccountHttpError } from "../src/account-client.js";
import {
  loginFailureMessage,
  moderatorAccessMessage,
  normaliseUsernameInput,
  passwordChangeFailureMessage,
  registrationFailureMessage,
  validateLogin,
  validatePasswordChange,
  validateRegistration,
} from "../src/account-messages.js";

test("login validation requires both fields and never trims the password", () => {
  assert.deepEqual(validateLogin({ username: "", password: "" }), {
    username: "Masukkan username.",
    password: "Masukkan kata sandi.",
  });
  assert.deepEqual(validateLogin({ username: "   ", password: "x" }), { username: "Masukkan username." });
  assert.deepEqual(validateLogin({ username: "ayu", password: "  spaced  " }), {});
});

test("registration uses the server username format after trim and lowercase, and a length-only password policy", () => {
  assert.equal(normaliseUsernameInput("  Ayu.Rani_2026 "), "ayu.rani_2026");
  assert.deepEqual(validateRegistration({ username: " Ayu.Rani ", password: "kata-sandi-2026", confirm: "kata-sandi-2026" }), {});

  const shortName = validateRegistration({ username: "ab", password: "kata-sandi-2026", confirm: "kata-sandi-2026" });
  assert.match(shortName.username ?? "", /3 sampai 32/u);
  assert.match(validateRegistration({ username: "ayu rani", password: "kata-sandi-2026", confirm: "kata-sandi-2026" }).username ?? "", /huruf kecil/u);
  assert.ok(validateRegistration({ username: "a".repeat(33), password: "kata-sandi-2026", confirm: "kata-sandi-2026" }).username);
  assert.ok(validateRegistration({ username: "ayu-rani", password: "kata-sandi-2026", confirm: "kata-sandi-2026" }).username);

  assert.match(validateRegistration({ username: "ayu", password: "123456789", confirm: "123456789" }).password ?? "", /minimal 10 karakter/u);
  assert.match(validateRegistration({ username: "ayu", password: "x".repeat(257), confirm: "x".repeat(257) }).password ?? "", /maksimal 256/u);
  assert.equal(validateRegistration({ username: "ayu", password: "1234567890", confirm: "1234567890" }).password, undefined);

  assert.deepEqual(
    validateRegistration({ username: "ayu", password: "kata-sandi-2026", confirm: "kata-sandi-2027" }),
    { confirm: "Konfirmasi kata sandi belum sama." },
  );
});

test("password change requires the current password and a matching new password", () => {
  assert.deepEqual(validatePasswordChange({ current: "", next: "kata-sandi-baru-2026", confirm: "kata-sandi-baru-2026" }), {
    current: "Masukkan kata sandi saat ini.",
  });
  assert.match(validatePasswordChange({ current: "lama", next: "pendek", confirm: "pendek" }).next ?? "", /minimal 10/u);
  assert.match(validatePasswordChange({ current: "lama", next: "kata-sandi-baru-2026", confirm: "lain" }).confirm ?? "", /baru belum sama/u);
  assert.deepEqual(validatePasswordChange({ current: "lama", next: "kata-sandi-baru-2026", confirm: "kata-sandi-baru-2026" }), {});
});

test("login failures map by HTTP status and keep the 401 copy generic", () => {
  assert.equal(loginFailureMessage(new AccountHttpError(401)), "Username atau kata sandi tidak sesuai.");
  assert.match(loginFailureMessage(new AccountHttpError(429)), /Terlalu banyak percobaan masuk/u);
  assert.match(loginFailureMessage(new AccountHttpError(503)), /tidak tersedia/u);
  // Unknown failures (network errors, payload errors) never echo raw error text.
  const generic = loginFailureMessage(new Error("internal provider detail with secret"));
  assert.match(generic, /belum dapat diproses/u);
  assert.doesNotMatch(generic, /provider|secret/u);
  assert.doesNotMatch(loginFailureMessage(new AccountHttpError(401)), /terdaftar|tidak ditemukan|belum ada/u);
});

test("registration failures explain a taken username and the closed-registration state", () => {
  assert.match(registrationFailureMessage(new AccountHttpError(409)), /sudah terdaftar/u);
  assert.match(registrationFailureMessage(new AccountHttpError(404)), /belum tersedia/u);
  assert.match(registrationFailureMessage(new AccountHttpError(429)), /Tunggu beberapa menit/u);
  assert.match(registrationFailureMessage(new AccountHttpError(400)), /aturan layanan/u);
  assert.match(registrationFailureMessage(new TypeError("fetch failed")), /belum dapat diproses/u);
});

test("password change failures tell a stale session to sign in again and never claim success on 403", () => {
  assert.match(passwordChangeFailureMessage(new AccountHttpError(401)), /Masuk kembali/u);
  assert.match(passwordChangeFailureMessage(new AccountHttpError(403)), /Kata sandi saat ini tidak sesuai/u);
  assert.match(passwordChangeFailureMessage(new AccountHttpError(409)), /Muat ulang halaman/u);
  assert.match(passwordChangeFailureMessage(new AccountHttpError(429)), /Tunggu beberapa menit/u);
  assert.doesNotMatch(passwordChangeFailureMessage(new AccountHttpError(403)), /berhasil|diubah\./u);
});

test("moderator-only surfaces show sign-in copy for 401 and role copy for 403, and nothing else", () => {
  assert.match(moderatorAccessMessage(401) ?? "", /masuk sebagai moderator/iu);
  assert.match(moderatorAccessMessage(403) ?? "", /peran moderator/u);
  assert.notEqual(moderatorAccessMessage(401), moderatorAccessMessage(403));
  assert.equal(moderatorAccessMessage(500), null);
  assert.equal(moderatorAccessMessage(null), null);
});
