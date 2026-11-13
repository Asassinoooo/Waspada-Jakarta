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
import { SourceApprovalList, SourceApprovalPanel } from "../src/SourceApprovalPanel.js";

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
    ...overrides,
  };
}

const SOURCES: AdminSourceApprovalItem[] = [
  source({ source_id: "source-menunggu", display_name: "Sumber menunggu", approval_status: "pending" }),
  source({ source_id: "source-disetujui", display_name: "Sumber disetujui", approval_status: "approved", auto_acquisition_enabled: true, public_display_granted: true }),
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
  assert.match(withActions, /Tampil publik diizinkan/u);
  assert.match(withActions, /Tampil publik belum diizinkan/u);
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
