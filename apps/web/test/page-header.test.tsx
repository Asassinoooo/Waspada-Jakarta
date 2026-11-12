import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { AccountUser, SessionEnvelope } from "@waspada/worker/account-contracts";
import { AccountPage } from "../src/AccountPages.js";
import { HelpPage } from "../src/HelpPage.js";
import { Preferences } from "../src/Preferences.js";
import { PREFERENCES_STORAGE_KEY, type PreferencesStorage } from "../src/preferences-store.js";
import { UpdateCenterContent, type UpdateCenterState } from "../src/UpdatesCenter.js";
import { PageHeader } from "../src/ui/PageHeader.js";

// UI-V2-D: every secondary page shows one h1 from PageHeader and at most one primary action.
// Skipped: the admin AccountAccessGate (a role gate, not a secondary page) and the authenticated
// onboarding steps (they need a full account fixture; the anonymous step is covered).

class MemoryStorage implements PreferencesStorage {
  readonly values = new Map<string, string>();

  getItem(key: string) {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string) {
    this.values.set(key, value);
  }

  removeItem(key: string) {
    this.values.delete(key);
  }
}

const checkedAt = "2026-11-12T04:06:00.000Z";

const user: AccountUser = {
  id: "account-17",
  display_name: "Ayu Warga",
  email: "ayu@example.test",
  role: "user",
  active: true,
  onboarding_version: 1,
  onboarding_completed_at: "2026-10-15T04:00:00.000Z",
  version: 1,
};

const anonymousSession: SessionEnvelope = {
  version: "account-v1",
  status: "anonymous",
  password_login_available: true,
  registration_available: true,
  csrf_token: null,
  user: null,
};

const userSession: SessionEnvelope = {
  ...anonymousSession,
  status: "authenticated",
  csrf_token: "csrf-token-with-enough-entropy",
  user,
};

const PRIMARY_CLASS = /class="[^"]*\b(?:button--primary|experience-action--primary)\b[^"]*"/gu;

function h1Count(html: string): number {
  return (html.match(/<h1[\s>]/gu) ?? []).length;
}

function primaryCount(html: string): number {
  return (html.match(PRIMARY_CLASS) ?? []).length;
}

function assertSecondaryPage(html: string, label: string, expectedPrimary: 0 | 1) {
  assert.equal(h1Count(html), 1, `${label} has exactly one h1`);
  assert.equal(primaryCount(html), expectedPrimary, `${label} has ${expectedPrimary} primary action`);
  assert.match(html, /class="page-column"/u, `${label} uses the page-column wrapper`);
  assert.doesNotMatch(html, /href="#jelajah"/u, `${label} no longer links to the legacy #jelajah hash`);
}

test("PageHeader renders one h1 and optional eyebrow, lead and single action", () => {
  const bare = renderToStaticMarkup(<PageHeader title="Pembaruan" />);
  assert.equal(h1Count(bare), 1);
  assert.match(bare, /<h1 class="page-header__title">Pembaruan<\/h1>/u);
  assert.doesNotMatch(bare, /page-header__eyebrow|page-header__lead|page-header__action/u);

  const full = renderToStaticMarkup(
    <PageHeader
      eyebrow="Bantuan · informasi dan kontrol"
      title="Panduan dan privasi"
      titleId="help-page-title"
      lead="Ringkasan singkat."
      action={<button type="button" className="button button--quiet">Lihat pengenalan lagi</button>}
    />,
  );
  assert.equal(h1Count(full), 1);
  assert.match(full, /<h1 id="help-page-title" class="page-header__title">Panduan dan privasi<\/h1>/u);
  assert.match(full, /<p class="page-header__eyebrow">Bantuan · informasi dan kontrol<\/p>/u);
  assert.match(full, /<p class="page-header__lead">Ringkasan singkat\.<\/p>/u);
  assert.match(full, /<div class="page-header__action"><button type="button" class="button button--quiet">Lihat pengenalan lagi<\/button><\/div>/u);
  assert.equal(primaryCount(full), 0, "a quiet action does not count as primary");
});

test("Pembaruan shows one primary refresh action in its empty and results states", () => {
  const ready: UpdateCenterState = { status: "ready", phase: "updates", items: [], checkedAt, resetNotice: false, failure: null };
  const empty = renderToStaticMarkup(<UpdateCenterContent gate="live" state={ready} onRefresh={() => {}} />);
  assertSecondaryPage(empty, "Pembaruan (empty)", 1);

  const loading: UpdateCenterState = { status: "loading", phase: "updates", items: [], checkedAt: null, resetNotice: false, failure: null };
  const busy = renderToStaticMarkup(<UpdateCenterContent gate="live" state={loading} onRefresh={() => {}} />);
  assertSecondaryPage(busy, "Pembaruan (loading)", 0);
  assert.match(busy, /class="skeleton-stack" aria-hidden="true"/u, "loading shows skeleton bars");

  const failed: UpdateCenterState = { status: "unavailable", phase: "updates", items: [], checkedAt: null, resetNotice: false, failure: "feed" };
  const unavailable = renderToStaticMarkup(<UpdateCenterContent gate="live" state={failed} onRefresh={() => {}} />);
  assertSecondaryPage(unavailable, "Pembaruan (unavailable)", 1);
});

test("Area saya keeps one primary save action and none while recovering unreadable interests", () => {
  const storage = new MemoryStorage();
  const form = renderToStaticMarkup(<Preferences storage={storage} />);
  assertSecondaryPage(form, "Area saya", 1);
  assert.match(form, /Simpan di perangkat ini/u);

  const broken = new MemoryStorage();
  broken.values.set(PREFERENCES_STORAGE_KEY, "{tidak valid");
  const recovery = renderToStaticMarkup(<Preferences storage={broken} />);
  assert.match(recovery, /Data minat perlu dipulihkan/u);
  assert.equal(h1Count(recovery), 1, "Area saya recovery has exactly one h1");
  assert.equal(primaryCount(recovery), 0, "Area saya recovery has no primary action");
});

test("Akun, Masuk and Mulai each show one h1 and at most one primary action", () => {
  const loading = renderToStaticMarkup(
    <AccountPage screen="account" sessionState={{ status: "loading", session: null }} isNarrowScreen={false} onRefreshSession={() => {}} />,
  );
  assertSecondaryPage(loading, "Akun (loading)", 0);

  const anonymousAccount = renderToStaticMarkup(
    <AccountPage screen="account" sessionState={{ status: "anonymous", session: anonymousSession }} isNarrowScreen={false} onRefreshSession={() => {}} />,
  );
  assertSecondaryPage(anonymousAccount, "Akun (guest)", 1);

  const account = renderToStaticMarkup(
    <AccountPage screen="account" sessionState={{ status: "authenticated", session: userSession }} isNarrowScreen={false} onRefreshSession={() => {}} />,
  );
  assertSecondaryPage(account, "Akun (signed in)", 1);

  const login = renderToStaticMarkup(
    <AccountPage screen="login" sessionState={{ status: "anonymous", session: anonymousSession }} isNarrowScreen={false} onRefreshSession={() => {}} />,
  );
  assertSecondaryPage(login, "Masuk", 1);

  const onboarding = renderToStaticMarkup(
    <AccountPage screen="onboarding" sessionState={{ status: "anonymous", session: anonymousSession }} isNarrowScreen={false} onRefreshSession={() => {}} />,
  );
  assertSecondaryPage(onboarding, "Mulai (guest)", 1);
});

test("Bantuan and Privasi share one screen with one primary action, Mulai jelajah", () => {
  const storage = new MemoryStorage();
  const privacy = renderToStaticMarkup(<HelpPage section="privasi" storage={storage} />);
  assertSecondaryPage(privacy, "Bantuan · privasi", 1);
  assert.match(privacy, /Mulai jelajah/u);
  assert.match(privacy, /href="#peta"/u);

  const guide = renderToStaticMarkup(<HelpPage section="panduan" storage={storage} />);
  assertSecondaryPage(guide, "Bantuan · panduan", 1);
  assert.match(guide, /Lihat pengenalan lagi/u, "the replay control sits in the header action slot");
});
