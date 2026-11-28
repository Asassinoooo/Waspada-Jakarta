import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { AdminSourceApprovalItem, AdminSourceApprovalResponse } from "@waspada/worker/source-approval-contracts";
import type { AccountUser, SessionEnvelope } from "@waspada/worker/account-contracts";
import {
  SourceApprovalHttpError,
  SourceApprovalPayloadError,
  canManageSourceApprovals,
  createSourceApprovalClient,
  sourceApprovalNoteError,
} from "../src/source-approval-client.js";
import {
  SourceApprovalList,
  SourceApprovalPanel,
  accessRestrictionsText,
  pollingIntervalText,
  publicDisplayText,
  reuseBasisText,
  sourceHealthLines,
  sourceMatchesFilter,
  sourceNeedsAttention,
} from "../src/SourceApprovalPanel.js";

const CSRF = "csrf-token-with-enough-entropy";
const NOTE = "Syarat penggunaan diperiksa ulang oleh administrator.";

const baseUser: AccountUser = {
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
function authenticated(role: AccountUser["role"], overrides: Partial<AccountUser> = {}, csrf: string | null = CSRF): SessionEnvelope {
  return {
    ...anonymousSession,
    status: "authenticated",
    csrf_token: csrf,
    user: { ...baseUser, role, ...overrides },
  };
}

function source(overrides: Partial<AdminSourceApprovalItem>): AdminSourceApprovalItem {
  return {
    source_id: "source-uji",
    display_name: "Sumber uji",
    source_kind: "newsroom",
    access_method: "rss",
    registry_status: "active",
    approval_status: "pending",
    auto_acquisition_enabled: false,
    auto_publication_policy: "never",
    public_display_granted: false,
    reuse_basis: [],
    access_restrictions: [],
    polling_interval_seconds: null,
    health_status: "unknown",
    last_checked_at: null,
    last_success_at: null,
    last_failure_at: null,
    ...overrides,
  };
}

const SOURCES: AdminSourceApprovalItem[] = [
  source({ source_id: "source-menunggu", display_name: "Sumber menunggu", approval_status: "pending" }),
  source({
    source_id: "source-disetujui",
    display_name: "Sumber disetujui",
    approval_status: "approved",
    auto_acquisition_enabled: true,
    public_display_granted: true,
    reuse_basis: ["public_display"],
    health_status: "healthy",
    last_checked_at: "2026-11-19T09:05:00.000Z",
    last_success_at: "2026-11-19T09:05:00.000Z",
  }),
  source({ source_id: "source-dicabut", display_name: "Sumber dicabut", approval_status: "revoked" }),
];

interface RecordedCall {
  readonly url: string;
  readonly init: RequestInit;
}

function fakeFetch(responses: Array<{ status: number; body?: unknown }>): { fetch: typeof fetch; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  let index = 0;
  const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    const next = responses[Math.min(index, responses.length - 1)]!;
    index += 1;
    const body = next.body === undefined ? null : JSON.stringify(next.body);
    return new Response(body, { status: next.status, headers: { "content-type": "application/json" } });
  };
  return { fetch: fetcher as unknown as typeof fetch, calls };
}

const listBody = { sources: SOURCES };
const approvalBody: AdminSourceApprovalResponse = {
  previous_approval_status: "pending",
  source: source({ source_id: "source-menunggu", display_name: "Sumber menunggu", approval_status: "approved" }),
  audit_id: "audit-approval-1",
};

test("the client reads the admin source list through the same-origin route with credentials and no cache", async () => {
  const { fetch, calls } = fakeFetch([{ status: 200, body: listBody }]);
  const client = createSourceApprovalClient(fetch);
  const result = await client.listSources();
  assert.deepEqual(result.sources.map((item) => item.source_id), ["source-menunggu", "source-disetujui", "source-dicabut"]);
  assert.equal(calls[0]?.url, "/api/v1/admin/sources");
  assert.equal(calls[0]?.init.method, "GET");
  assert.equal(calls[0]?.init.credentials, "same-origin");
  assert.equal(calls[0]?.init.cache, "no-store");
});

test("approval posts the status, the trimmed note and the session CSRF token to the sourceId route", async () => {
  const { fetch, calls } = fakeFetch([{ status: 200, body: approvalBody }]);
  const client = createSourceApprovalClient(fetch);
  const result = await client.setApproval("source-menunggu", "approved", `  ${NOTE}  `, CSRF);
  assert.equal(result.source.approval_status, "approved");
  assert.equal(result.previous_approval_status, "pending");
  assert.equal(calls[0]?.url, "/api/v1/admin/sources/source-menunggu/approval");
  assert.equal(calls[0]?.init.method, "POST");
  const headers = calls[0]?.init.headers as Record<string, string>;
  assert.equal(headers["X-CSRF-Token"], CSRF);
  assert.deepEqual(JSON.parse(String(calls[0]?.init.body)), { status: "approved", note: NOTE });
});

test("a source id with reserved characters is encoded in the approval path", async () => {
  const { fetch, calls } = fakeFetch([{ status: 200, body: approvalBody }]);
  await createSourceApprovalClient(fetch).setApproval("source/uji 1", "revoked", NOTE, CSRF);
  assert.equal(calls[0]?.url, "/api/v1/admin/sources/source%2Fuji%201/approval");
});

test("server refusals surface as HTTP errors that keep the status and the stable code", async () => {
  const forbidden = fakeFetch([{ status: 403, body: { code: "FORBIDDEN", message: "x" } }]);
  await assert.rejects(createSourceApprovalClient(forbidden.fetch).listSources(), (error: unknown) =>
    error instanceof SourceApprovalHttpError && error.status === 403 && error.code === "FORBIDDEN");

  const conflict = fakeFetch([{ status: 409, body: { code: "SOURCE_APPROVAL_UNCHANGED" } }]);
  await assert.rejects(createSourceApprovalClient(conflict.fetch).setApproval("source-menunggu", "approved", NOTE, CSRF), (error: unknown) =>
    error instanceof SourceApprovalHttpError && error.status === 409 && error.code === "SOURCE_APPROVAL_UNCHANGED");

  const notJson = fakeFetch([{ status: 500 }]);
  await assert.rejects(createSourceApprovalClient(notJson.fetch).listSources(), (error: unknown) =>
    error instanceof SourceApprovalHttpError && error.status === 500 && error.code === null);
});

test("payloads that do not match the contract are rejected instead of being rendered", async () => {
  const extraKey = fakeFetch([{ status: 200, body: { sources: [{ ...SOURCES[0], reuse_license_url: "https://private.example" }] } }]);
  await assert.rejects(createSourceApprovalClient(extraKey.fetch).listSources(), SourceApprovalPayloadError);

  const badStatus = fakeFetch([{ status: 200, body: { sources: [{ ...SOURCES[0], approval_status: 42 }] } }]);
  await assert.rejects(createSourceApprovalClient(badStatus.fetch).listSources(), SourceApprovalPayloadError);

  const extraTop = fakeFetch([{ status: 200, body: { sources: [], next: "x" } }]);
  await assert.rejects(createSourceApprovalClient(extraTop.fetch).listSources(), SourceApprovalPayloadError);
});

test("invalid writes are refused before any request leaves the browser", async () => {
  const { fetch, calls } = fakeFetch([{ status: 200, body: approvalBody }]);
  const client = createSourceApprovalClient(fetch);
  await assert.rejects(client.setApproval("source-menunggu", "approved", "pendek", CSRF), SourceApprovalPayloadError);
  await assert.rejects(client.setApproval("source-menunggu", "approved", NOTE, "short"), SourceApprovalPayloadError);
  await assert.rejects(client.setApproval("source-menunggu", "suspended" as "approved", NOTE, CSRF), SourceApprovalPayloadError);
  await assert.rejects(client.setApproval("", "approved", NOTE, CSRF), SourceApprovalPayloadError);
  assert.equal(calls.length, 0);
});

test("the note must be 10 to 500 characters after trimming", () => {
  assert.match(sourceApprovalNoteError("") ?? "", /10/u);
  assert.match(sourceApprovalNoteError("   sembilan   ") ?? "", /10/u, "whitespace does not count toward the minimum");
  assert.equal(sourceApprovalNoteError("sepuluh ch."), null);
  assert.equal(sourceApprovalNoteError(NOTE), null);
  assert.match(sourceApprovalNoteError("x".repeat(501)) ?? "", /500/u);
  assert.equal(sourceApprovalNoteError("x".repeat(500)), null);
});

test("only an active administrator with a session CSRF token may manage source approval", () => {
  assert.equal(canManageSourceApprovals(authenticated("admin", { role: "admin" })), true);
  assert.equal(canManageSourceApprovals(authenticated("moderator", { role: "moderator" })), false, "moderators read the workspace but never change approval");
  assert.equal(canManageSourceApprovals(authenticated("user")), false);
  assert.equal(canManageSourceApprovals(authenticated("admin", { role: "admin", active: false })), false);
  assert.equal(canManageSourceApprovals(authenticated("admin", { role: "admin" }, null)), false, "without a CSRF token the control is withheld");
  assert.equal(canManageSourceApprovals(anonymousSession), false);
});

test("the list shows the approval, collection and public display state, and an action only where a handler is supplied", () => {
  const withActions = renderToStaticMarkup(<SourceApprovalList sources={SOURCES} onRequestChange={() => {}} />);
  assert.match(withActions, /Sumber menunggu/u);
  assert.match(withActions, /Menunggu/u);
  assert.match(withActions, /Disetujui/u);
  assert.match(withActions, /Dicabut/u);
  assert.match(withActions, /Pengumpulan otomatis aktif/u);
  assert.match(withActions, /Tampil publik: diizinkan/u);
  assert.match(withActions, /Tampil publik: tidak diizinkan/u);
  assert.match(withActions, /aria-label="Setujui Sumber menunggu"/u);
  assert.match(withActions, /aria-label="Cabut persetujuan Sumber disetujui"/u, "an approved source offers revocation");
  assert.match(withActions, /aria-label="Setujui Sumber dicabut"/u, "a revoked source may be approved again");
  assert.equal((withActions.match(/<button/gu) ?? []).length, 3);

  const readOnly = renderToStaticMarkup(<SourceApprovalList sources={SOURCES} />);
  assert.match(readOnly, /Sumber menunggu/u);
  assert.doesNotMatch(readOnly, /<button/u, "without a handler no approval control is rendered");
});

test("the panel shows approval controls to an administrator only and loads the list after mount", () => {
  const admin = renderToStaticMarkup(<SourceApprovalPanel session={authenticated("admin", { role: "admin" })} />);
  assert.match(admin, /Persetujuan sumber/u);
  assert.match(admin, /Memuat daftar sumber/u, "the server-rendered markup shows the loading state before the list arrives");
  assert.doesNotMatch(admin, /<button/u);

  for (const [name, session] of [
    ["moderator", authenticated("moderator", { role: "moderator" })],
    ["user", authenticated("user")],
    ["anonymous", anonymousSession],
  ] as const) {
    const markup = renderToStaticMarkup(<SourceApprovalPanel session={session} />);
    assert.match(markup, /hanya dapat diubah oleh administrator yang masuk/u, name);
    assert.doesNotMatch(markup, /<button|Memuat daftar sumber|Setujui|Cabut/u, `${name} gets no list and no control`);
  }

  const noToken = renderToStaticMarkup(<SourceApprovalPanel session={authenticated("admin", { role: "admin" }, null)} />);
  assert.match(noToken, /Muat ulang halaman/u, "an administrator without a session token is asked to reload, not told the role is wrong");
  assert.doesNotMatch(noToken, /<button|Memuat daftar sumber|Setujui|Cabut/u);
});

test("the restriction block shows public display, reuse basis, access notes and the polling interval, and never a raw registry token", () => {
  const restricted = source({
    source_id: "source-terbatas",
    display_name: "Sumber terbatas",
    approval_status: "approved",
    auto_acquisition_enabled: true,
    public_display_granted: false,
    reuse_basis: ["public", "model_triage", "token_internal_xyz"],
    access_restrictions: ["Atribusi wajib"],
    polling_interval_seconds: 900,
  });
  const markup = renderToStaticMarkup(<SourceApprovalList sources={[restricted]} />);
  assert.match(markup, /aria-label="Pembatasan Sumber terbatas"/u);
  assert.match(markup, /Tampil publik: tidak diizinkan/u, "a legacy grant alone does not show public display");
  assert.match(markup, /Dasar penggunaan: Dasar lama: publik \(perlu bukti lisensi\), Triase model, Dasar lain \(belum diberi label\)/u);
  assert.match(markup, /Pembatasan akses: Atribusi wajib/u);
  assert.match(markup, /Interval pengambilan: setiap 15 menit/u);
  assert.doesNotMatch(markup, /token_internal_xyz/u, "an unlabelled registry token is never printed");

  assert.equal(publicDisplayText(true), "Tampil publik: diizinkan");
  assert.equal(reuseBasisText([]), "Dasar penggunaan: belum tercatat");
  assert.equal(reuseBasisText(["public_display", "public_display"]), "Dasar penggunaan: Tampil publik", "a repeated token is shown once");
  assert.equal(accessRestrictionsText([]), "Pembatasan akses: tidak ada catatan");
  assert.equal(pollingIntervalText(null), "Interval pengambilan: belum diatur");
  assert.equal(pollingIntervalText(3600), "Interval pengambilan: setiap 1 jam");
  assert.equal(pollingIntervalText(45), "Interval pengambilan: setiap 45 detik");
});

test("the health block shows Jakarta times for a checked source, a failure line without an error code, and the no-data line when never checked", () => {
  const healthy = source({
    source_id: "source-sehat",
    display_name: "Sumber sehat",
    approval_status: "approved",
    health_status: "healthy",
    last_checked_at: "2026-11-19T09:05:00.000Z",
    last_success_at: "2026-11-19T09:05:00.000Z",
  });
  const degraded = source({
    source_id: "source-menurun",
    display_name: "Sumber menurun",
    approval_status: "approved",
    health_status: "degraded",
    last_checked_at: "2026-11-19T10:00:00.000Z",
    last_success_at: "2026-11-18T09:00:00.000Z",
    last_failure_at: "2026-11-19T10:00:00.000Z",
  });
  const neverChecked = source({ source_id: "source-baru", display_name: "Sumber baru", approval_status: "pending" });

  const markup = renderToStaticMarkup(<SourceApprovalList sources={[healthy, degraded, neverChecked]} />);
  assert.match(markup, /aria-label="Kesehatan Sumber sehat"/u);
  assert.match(markup, /Status: Sehat/u);
  assert.match(markup, /Pengambilan berhasil terakhir: 19 Nov 2026, 16\.05 WIB/u, "the instant is shown in WIB");
  assert.match(markup, /Galat aktif: tidak ada/u);
  assert.match(markup, /Status: Menurun/u);
  assert.match(markup, /Pengambilan berhasil terakhir: 18 Nov 2026, 16\.00 WIB/u);
  assert.match(markup, /Galat terakhir: 19 Nov 2026, 17\.00 WIB, penyebab belum dicatat/u);
  assert.equal((markup.match(/Belum ada data kesehatan/gu) ?? []).length, 1, "only the never-checked source gets the no-data line");

  assert.deepEqual(sourceHealthLines(neverChecked), ["Belum ada data kesehatan"]);
  assert.deepEqual(sourceHealthLines(degraded), [
    "Status: Menurun",
    "Pengambilan berhasil terakhir: 18 Nov 2026, 16.00 WIB",
    "Galat terakhir: 19 Nov 2026, 17.00 WIB, penyebab belum dicatat",
  ]);
  assert.deepEqual(sourceHealthLines(source({ health_status: "unavailable", last_checked_at: "2026-11-19T10:00:00.000Z", last_failure_at: "2026-11-19T10:00:00.000Z" })), [
    "Status: Tidak tersedia",
    "Pengambilan berhasil terakhir: belum pernah",
    "Galat terakhir: 19 Nov 2026, 17.00 WIB, penyebab belum dicatat",
  ]);
});

test("the list parser accepts the restriction and health fields, null health included, and refuses an unknown status or an unreadable instant", async () => {
  const neverChecked = await createSourceApprovalClient(fakeFetch([{ status: 200, body: { sources: [SOURCES[0]] } }]).fetch).listSources();
  assert.equal(neverChecked.sources[0]?.last_checked_at, null);
  assert.equal(neverChecked.sources[0]?.health_status, "unknown");

  const checked = await createSourceApprovalClient(fakeFetch([{ status: 200, body: listBody }]).fetch).listSources();
  assert.equal(checked.sources[1]?.last_success_at, "2026-11-19T09:05:00.000Z");

  const unknownHealth = fakeFetch([{ status: 200, body: { sources: [{ ...SOURCES[0], health_status: "down" }] } }]);
  await assert.rejects(createSourceApprovalClient(unknownHealth.fetch).listSources(), SourceApprovalPayloadError);

  const unreadableInstant = fakeFetch([{ status: 200, body: { sources: [{ ...SOURCES[1], last_success_at: "kemarin" }] } }]);
  await assert.rejects(createSourceApprovalClient(unreadableInstant.fetch).listSources(), SourceApprovalPayloadError);

  const zeroInterval = fakeFetch([{ status: 200, body: { sources: [{ ...SOURCES[0], polling_interval_seconds: 0 }] } }]);
  await assert.rejects(createSourceApprovalClient(zeroInterval.fetch).listSources(), SourceApprovalPayloadError);

  const scalarBasis = fakeFetch([{ status: 200, body: { sources: [{ ...SOURCES[0], reuse_basis: "public_display" }] } }]);
  await assert.rejects(createSourceApprovalClient(scalarBasis.fetch).listSources(), SourceApprovalPayloadError);

  const missingHealth = fakeFetch([{ status: 200, body: { sources: [{ ...SOURCES[0], health_status: undefined }] } }]);
  await assert.rejects(createSourceApprovalClient(missingHealth.fetch).listSources(), SourceApprovalPayloadError);
});

test("ADMIN-UI-03: a pending or failing source needs attention; filters split the list by approval", () => {
  assert.equal(sourceNeedsAttention(source({ approval_status: "pending", health_status: "healthy" })), true);
  assert.equal(sourceNeedsAttention(source({ approval_status: "approved", health_status: "degraded" })), true);
  assert.equal(sourceNeedsAttention(source({ approval_status: "approved", health_status: "unavailable" })), true);
  assert.equal(sourceNeedsAttention(source({ approval_status: "approved", health_status: "healthy" })), false);
  assert.equal(sourceNeedsAttention(source({ approval_status: "revoked", health_status: "unknown" })), false);
  assert.deepEqual(SOURCES.filter((item) => sourceMatchesFilter(item, "approved")).map((item) => item.source_id), ["source-disetujui"]);
  assert.equal(SOURCES.filter((item) => sourceMatchesFilter(item, "all")).length, SOURCES.length);
});

test("ADMIN-UI-03: each row shows approval, health in short form and one action; the details stay behind Rincian", () => {
  const now = Date.parse("2026-11-28T10:00:00.000Z");
  const html = renderToStaticMarkup(
    <SourceApprovalList
      nowMs={now}
      sources={[source({ display_name: "Sumber sehat", approval_status: "approved", health_status: "healthy", last_checked_at: "2026-11-28T09:51:00.000Z", last_success_at: "2026-11-28T09:51:00.000Z", public_display_granted: true })]}
      onRequestChange={() => {}}
    />,
  );
  assert.match(html, /Berhasil 9 menit lalu/u);
  assert.match(html, /source-approval__chip--approved/u);
  assert.match(html, /<details class="source-approval__more"><summary>Rincian<\/summary>/u);
  assert.equal((html.match(/<button/gu) ?? []).length, 1);
  assert.doesNotMatch(html, /\baman\b/u);
});
