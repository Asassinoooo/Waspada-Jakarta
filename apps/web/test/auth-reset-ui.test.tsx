import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AccountHttpError } from "../src/account-client.js";
import {
  formatResetCode,
  normaliseResetCodeInput,
  passwordResetFailureMessage,
  resetCodeIssueFailureMessage,
  validatePasswordReset,
} from "../src/account-messages.js";
import { PasswordResetPage } from "../src/AccountPages.js";
import { routeFromHash } from "../src/App.js";

/** AUTH-RESET-01: the #lupa-sandi page and the administrator's reset code, on the web. */

test("AUTH-RESET-01: #lupa-sandi is its own public route", () => {
  assert.deepEqual(routeFromHash("#lupa-sandi"), { screen: "password-reset" });
});

test("AUTH-RESET-01: the page explains how to get a code and has the four fields", () => {
  const html = renderToStaticMarkup(createElement(PasswordResetPage));
  assert.match(html, /Atur ulang kata sandi/u);
  assert.match(html, /Hubungi administrator/u);
  assert.match(html, /berlaku 30 menit dan hanya bisa dipakai sekali/u);
  assert.match(html, /Administrator tidak pernah meminta kata sandi Anda/u);
  for (const id of ["reset-username", "reset-code", "reset-password", "reset-confirm"]) {
    assert.match(html, new RegExp(`id="${id}"`, "u"));
  }
  assert.match(html, /autoComplete="one-time-code"|autocomplete="one-time-code"/u);
  assert.match(html, /href="#masuk"/u);
});

test("AUTH-RESET-01: codes normalise like the server, and show as two groups of five", () => {
  assert.equal(normaliseResetCodeInput(" 7k3qp-9xw2m "), "7K3QP9XW2M");
  assert.equal(normaliseResetCodeInput("O0IL1"), "00111");
  assert.equal(formatResetCode("7k3qp9xw2m"), "7K3QP-9XW2M");
});

test("AUTH-RESET-01: the form checks the username, code, password length and confirmation before sending", () => {
  assert.deepEqual(validatePasswordReset({ username: "warga.satu", code: "7K3QP-9XW2M", password: "sandi-baru-123", confirm: "sandi-baru-123" }), {});
  const errors = validatePasswordReset({ username: "A", code: "123", password: "pendek", confirm: "lain" });
  assert.deepEqual(Object.keys(errors).sort(), ["code", "confirm", "password", "username"]);
  assert.ok(validatePasswordReset({ username: "warga", code: "7K3QP9XW2U", password: "x".repeat(10), confirm: "x".repeat(10) }).code,
    "U is not a Crockford symbol");
});

test("AUTH-RESET-01: a refused code gets one generic message that never says whether the username exists", () => {
  const refused = passwordResetFailureMessage(new AccountHttpError(400));
  assert.match(refused, /Nama pengguna atau kode tidak cocok/u);
  assert.doesNotMatch(refused, /tidak terdaftar|tidak ditemukan/u);
  assert.match(passwordResetFailureMessage(new AccountHttpError(429)), /Terlalu banyak percobaan/u);
  assert.match(passwordResetFailureMessage(new Error("x")), /tidak tersedia/u);
  assert.match(resetCodeIssueFailureMessage(new AccountHttpError(404)), /tidak memakai kata sandi/u);
  assert.match(resetCodeIssueFailureMessage(new AccountHttpError(409)), /nonaktif/u);
});

test("AUTH-RESET-01: the login form links to Lupa kata sandi, and the admin row offers a reset code only for others' active accounts", () => {
  const source = readFileSync(new URL("../src/AccountPages.tsx", import.meta.url), "utf8");
  assert.match(source, /<a className="account-form__link" href="#lupa-sandi">Lupa kata sandi\?<\/a>/u);
  // ADMIN-UI-03: the reset code sits in the editor that only opens for someone else's account, and only when it is active.
  assert.match(source, /\{!isSelf && open && \([\s\S]*?\{user\.active && \([\s\S]*?<AdminResetCode user=\{user\} client=\{client\} csrfToken=\{csrfToken\} \/>/u);
  assert.equal((source.match(/<AdminResetCode /gu) ?? []).length, 1, "the reset control is rendered in one place only");
  assert.match(source, /Kode hanya ditampilkan sekarang/u);
});
