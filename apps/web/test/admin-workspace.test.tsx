import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { AccountUser, SessionEnvelope } from "@waspada/worker/account-contracts";
import type { PublicContext } from "@waspada/worker/public-contracts";
import { routeFromHash } from "../src/App.js";
import { AccountAccessGate, AdminAccountsPanel, hasProtectedShellAccess } from "../src/AccountPages.js";
import { AdminWorkspace } from "../src/AdminWorkspace.js";
import {
  ADMIN_TAB_IDS,
  adminGateShell,
  adminPrimaryAction,
  adminTabHash,
  adminTabsFor,
  adminWorkspaceTabFromHash,
  resolveAdminTab,
  tabNeedsWideScreen,
  type AdminTab,
} from "../src/admin-workspace-model.js";

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
function authenticated(role: AccountUser["role"], overrides: Partial<AccountUser> = {}): SessionEnvelope {
  return {
    ...anonymousSession,
    status: "authenticated",
    csrf_token: "csrf-token-with-enough-entropy",
    user: { ...user, role, ...overrides },
  };
}
const adminSession = authenticated("admin", { id: "admin-1", display_name: "Rani Admin", role: "admin" });
const moderatorSession = authenticated("moderator", { id: "moderator-1", display_name: "Dimas Moderator", role: "moderator" });
const userSession = authenticated("user");

const demoContext = {
  dataset_mode: "demo",
  dataset_label: "synthetic",
  generated_at: "2026-11-12T08:00:00.000Z",
  sources: [],
} as unknown as PublicContext;

/** Labels of the rendered tab buttons, in order. */
function tabLabels(markup: string): string[] {
  return [...markup.matchAll(/<button[^>]*role="tab"[^>]*>([\s\S]*?)<\/button>/gu)]
    .map((match) => (match[1] ?? "").replace(/<[^>]+>/gu, "").replace(/&amp;/gu, "&").trim());
}

function tabButton(markup: string, tab: AdminTab): string {
  return markup.match(new RegExp(`<button[^>]*id="admin-tab-${tab}"[^>]*>`, "u"))?.[0] ?? "";
}

test("admin sees six tabs, moderators see three, and users, inactive accounts and anonymous visitors see none", () => {
  assert.deepEqual(adminTabsFor({ role: "admin", active: true }).map((tab) => tab.id), ["ringkasan", "tinjau", "alur", "embedding", "akun", "sumber"]);
  assert.deepEqual(adminTabsFor({ role: "moderator", active: true }).map((tab) => tab.id), ["tinjau", "alur", "embedding"]);
  assert.deepEqual(adminTabsFor({ role: "user", active: true }), []);
  assert.deepEqual(adminTabsFor({ role: "admin", active: false }), [], "a deactivated administrator has no tabs");
  assert.deepEqual(adminTabsFor(null), [], "anonymous visitors have no tabs");
});

test("the workspace renders the admin rail with six tabs and the moderator rail without admin-only tabs", () => {
  const admin = renderToStaticMarkup(<AdminWorkspace initialTab="ringkasan" session={adminSession} context={demoContext} isNarrowScreen={false} onRefreshSession={() => {}} />);
  assert.deepEqual(tabLabels(admin), ["Ringkasan", "Tinjau bukti", "Alur agen", "Embedding 3D", "Akun & peran", "Demo sumber"]);

  const moderator = renderToStaticMarkup(<AdminWorkspace initialTab="tinjau" session={moderatorSession} context={demoContext} isNarrowScreen={false} onRefreshSession={() => {}} />);
  assert.deepEqual(tabLabels(moderator), ["Tinjau bukti", "Alur agen", "Embedding 3D"]);
  assert.doesNotMatch(moderator, /Akun &amp; peran|Demo sumber/u, "admin-only tabs are not rendered for a moderator");
  assert.doesNotMatch(moderator, /id="admin-panel-akun"|id="admin-panel-sumber"|id="admin-panel-ringkasan"/u);
});

test("tabs use the tablist, tab and tabpanel roles with aria-selected on the open tab only", () => {
  const markup = renderToStaticMarkup(<AdminWorkspace initialTab="akun" session={adminSession} context={demoContext} isNarrowScreen={false} onRefreshSession={() => {}} />);
  assert.match(markup, /role="tablist" aria-label="Bagian ruang kerja" aria-orientation="vertical"/u, "desktop uses a vertical rail");
  assert.equal((markup.match(/role="tab"/gu) ?? []).length, 6);
  assert.equal((markup.match(/role="tabpanel"/gu) ?? []).length, 6, "every tab has a panel, so aria-controls always resolves");

  const selected = tabButton(markup, "akun");
  assert.match(selected, /aria-selected="true"/u);
  assert.match(selected, /tabindex="0"/u);
  assert.match(selected, /aria-controls="admin-panel-akun"/u);
  assert.equal((markup.match(/aria-selected="true"/gu) ?? []).length, 1);
  assert.match(tabButton(markup, "sumber"), /aria-selected="false"/u);

  const panel = markup.match(/<div id="admin-panel-akun"[^>]*>/u)?.[0] ?? "";
  assert.match(panel, /aria-labelledby="admin-tab-akun"/u);
  assert.doesNotMatch(panel, /hidden=""/u, "the open panel is visible");
  assert.match(markup.match(/<div id="admin-panel-sumber"[^>]*>/u)?.[0] ?? "", /hidden=""/u, "closed panels stay hidden");
});

test("on a narrow screen the rail becomes a horizontal strip", () => {
  const markup = renderToStaticMarkup(<AdminWorkspace initialTab="tinjau" session={moderatorSession} context={null} isNarrowScreen={true} onRefreshSession={() => {}} />);
  assert.match(markup, /aria-orientation="horizontal"/u);
});

test("a hidden tab falls back to the first tab the viewer may open", () => {
  assert.equal(resolveAdminTab("akun", ["tinjau", "alur", "embedding"]), "tinjau");
  assert.equal(resolveAdminTab("alur", ["tinjau", "alur", "embedding"]), "alur");
  assert.equal(resolveAdminTab("sumber", []), null);

  const markup = renderToStaticMarkup(<AdminWorkspace initialTab="sumber" session={moderatorSession} context={null} isNarrowScreen={false} onRefreshSession={() => {}} />);
  assert.match(tabButton(markup, "tinjau"), /aria-selected="true"/u, "a moderator who lands on #admin/sumber opens Tinjau bukti");
  assert.doesNotMatch(markup, /Demo sumber/u);
});

test("the workspace renders nothing for users and anonymous visitors, so no tab is ever mounted for them", () => {
  assert.equal(renderToStaticMarkup(<AdminWorkspace initialTab="tinjau" session={userSession} context={null} isNarrowScreen={false} onRefreshSession={() => {}} />), "");
  assert.equal(hasProtectedShellAccess("review", userSession), false);
  assert.equal(hasProtectedShellAccess("review", anonymousSession), false);
});

test("users and anonymous visitors get the access gate, with administrator wording for admin-only tabs", () => {
  const anonymous = { status: "anonymous" as const, session: anonymousSession };
  const signedIn = { status: "authenticated" as const, session: userSession };

  const anonAdmin = renderToStaticMarkup(<AccountAccessGate shell={adminGateShell("sumber")} sessionState={anonymous} isNarrowScreen={false} onRefreshSession={() => {}} />);
  assert.match(anonAdmin, /Ruang administrator hanya tersedia untuk akun administrator yang masuk\./u);
  const anonReview = renderToStaticMarkup(<AccountAccessGate shell={adminGateShell("tinjau")} sessionState={anonymous} isNarrowScreen={false} onRefreshSession={() => {}} />);
  assert.match(anonReview, /Tampilan tinjau hanya tersedia untuk akun moderator atau administrator yang masuk\./u);

  const forbidden = renderToStaticMarkup(<AccountAccessGate shell={adminGateShell("ringkasan")} sessionState={signedIn} isNarrowScreen={true} onRefreshSession={() => {}} />);
  assert.match(forbidden, /Akses tidak tersedia/u);
  assert.doesNotMatch(forbidden, /Buka di layar|Demo sumber|Alur agen/u);
});

test("legacy and canonical admin hashes open the workspace on the matching tab", () => {
  assert.equal(adminWorkspaceTabFromHash("#admin"), "ringkasan");
  assert.equal(adminWorkspaceTabFromHash("#admin-workspace"), "ringkasan");
  assert.equal(adminWorkspaceTabFromHash("#tinjau-bukti"), "tinjau");
  assert.equal(adminWorkspaceTabFromHash("#alur-agen"), "alur");
  assert.equal(adminWorkspaceTabFromHash("#visualisasi-3d"), "embedding");
  assert.equal(adminWorkspaceTabFromHash("#embedding-3d"), "embedding");
  assert.equal(adminWorkspaceTabFromHash("#demo-sumber"), "sumber");
  assert.equal(adminWorkspaceTabFromHash("#admin/akun"), "akun");
  assert.equal(adminWorkspaceTabFromHash("#peta"), null, "public hashes are not admin hashes");
  assert.equal(adminWorkspaceTabFromHash("#akun"), null);
  assert.deepEqual(routeFromHash("#tinjau-bukti"), { screen: "admin-workspace", initialTab: "tinjau" });
  for (const tab of ADMIN_TAB_IDS) assert.equal(adminWorkspaceTabFromHash(adminTabHash(tab)), tab);
});

test("only the Alur and Embedding canvases need a wide screen", () => {
  assert.deepEqual(ADMIN_TAB_IDS.filter((tab) => tabNeedsWideScreen(tab)), ["alur", "embedding"]);
});

test("on a narrow screen Alur and Embedding show an empty state instead of the canvas, while the other tabs still load", () => {
  for (const tab of ["alur", "embedding"] as const) {
    const markup = renderToStaticMarkup(<AdminWorkspace initialTab={tab} session={adminSession} context={demoContext} isNarrowScreen={true} onRefreshSession={() => {}} />);
    assert.match(markup, /Buka di layar yang lebih lebar untuk tampilan ini\./u, tab);
    assert.doesNotMatch(markup, /Memuat alur agen|Memuat visualisasi 3D/u, `${tab} does not start its chunk on a phone`);
  }
  // The overview is lazy: on a cold render it shows its loading state, and once loaded it renders inline.
  const overview = renderToStaticMarkup(<AdminWorkspace initialTab="ringkasan" session={adminSession} context={demoContext} isNarrowScreen={true} onRefreshSession={() => {}} />);
  assert.match(overview, /Memuat ringkasan…|class="admin-page"/u);
  assert.doesNotMatch(overview, /Buka di layar yang lebih lebar/u);
});

test("the workspace has exactly one main landmark, one skip target and one h1", () => {
  const markup = renderToStaticMarkup(<AdminWorkspace initialTab="ringkasan" session={adminSession} context={demoContext} isNarrowScreen={false} onRefreshSession={() => {}} />);
  assert.equal((markup.match(/<main\b/gu) ?? []).length, 1);
  assert.equal((markup.match(/id="main-content"/gu) ?? []).length, 1);
  assert.equal((markup.match(/<h1\b/gu) ?? []).length, 1);
  assert.match(markup, /<a class="skip-link" href="#main-content">Lewati ke konten utama<\/a>/u);
});

test("the header offers one primary link per tab and keeps the way back to the public map", () => {
  const admin = renderToStaticMarkup(<AdminWorkspace initialTab="ringkasan" session={adminSession} context={demoContext} isNarrowScreen={false} onRefreshSession={() => {}} />);
  assert.equal((admin.match(/class="button button--primary admin-ws__primary"/gu) ?? []).length, 1);
  assert.match(admin, /class="button button--primary admin-ws__primary" href="#admin\/tinjau">Tinjau bukti<\/a>/u);
  assert.match(admin, /class="admin-ws__home" href="#peta">Waspada Jakarta<\/a>/u);
  assert.match(admin, /aria-label="Aksi lain"|>Aksi lain</u, "secondary actions sit in the ⋯ menu");

  const moderatorOnAlur = renderToStaticMarkup(<AdminWorkspace initialTab="alur" session={moderatorSession} context={null} isNarrowScreen={false} onRefreshSession={() => {}} />);
  assert.doesNotMatch(moderatorOnAlur, /admin-ws__primary/u, "the flow tab has no primary action");
});

test("primary actions point only at tabs the viewer may open", () => {
  assert.deepEqual(adminPrimaryAction("ringkasan", ADMIN_TAB_IDS), { label: "Tinjau bukti", href: "#admin/tinjau" });
  assert.deepEqual(adminPrimaryAction("tinjau", ["tinjau", "alur", "embedding"]), { label: "Alur agen", href: "#admin/alur" });
  assert.equal(adminPrimaryAction("tinjau", ["tinjau"]), null, "withheld when the flow tab is not open to the viewer");
  assert.equal(adminPrimaryAction("sumber", ADMIN_TAB_IDS), null);
});

test("the source tab keeps its demo label in the header badge", () => {
  const markup = renderToStaticMarkup(<AdminWorkspace initialTab="sumber" session={adminSession} context={demoContext} isNarrowScreen={false} onRefreshSession={() => {}} />);
  assert.match(markup, /DEMO SUMBER — pratinjau data publik; bukan peringatan Waspada/u);
  assert.match(markup, /<span class="site-header__badge-label">Data contoh<\/span>/u);
});

test("the Akun tab opens the user panel only for an administrator who finished the introduction", () => {
  const ready = renderToStaticMarkup(<AdminAccountsPanel session={adminSession} onRefreshSession={() => {}} />);
  assert.match(ready, /Akun pengguna/u);
  assert.doesNotMatch(ready, /tersedia di layar desktop/u, "the panel is single-column on phones too");

  const notFinished = renderToStaticMarkup(<AdminAccountsPanel session={authenticated("admin", { role: "admin", onboarding_version: 0 })} onRefreshSession={() => {}} />);
  assert.match(notFinished, /Selesaikan pengenalan akun/u);
  assert.doesNotMatch(notFinished, /Akun pengguna/u);

  const moderator = renderToStaticMarkup(<AdminAccountsPanel session={moderatorSession} onRefreshSession={() => {}} />);
  assert.doesNotMatch(moderator, /Akun pengguna/u, "moderators never see the user list");
});

test("canonical tab hashes use the #admin/<tab> form", () => {
  assert.equal(adminTabHash("sumber"), "#admin/sumber");
  assert.equal(adminTabHash("akun"), "#admin/akun");
  assert.equal(adminTabHash("embedding"), "#admin/embedding");
});
