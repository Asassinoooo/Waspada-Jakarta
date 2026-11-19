import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { createTestDatabase, type TestDatabase } from "../../db/test/harness.js";
import { applyMigrations, readMigrations } from "../../db/src/migrations.js";
import { createSourceApprovalStore, type SourceApprovalStore } from "../../db/src/source-approval-store.js";
import {
  createSourceApprovalApiHandler,
  type SourceApprovalApiHandler,
} from "../src/layers/l4-application-integration/source-approval-api.js";
import type { ModerationPrincipal } from "../src/layers/l4-application-integration/moderation-api.js";

/**
 * FR-12 source approval route: GET /api/v1/admin/sources and POST /api/v1/admin/sources/:id/approval.
 * Only an active administrator with the exact Origin and the session CSRF token may write. Each
 * successful write is read back from PGlite as the registry row, the trace and the audit row.
 * All fixtures are synthetic and no network or model call is made.
 */

const APP_ORIGIN = "https://waspada.example";
const NOTE = "Syarat penggunaan diperiksa ulang oleh administrator.";
const NOW = "2026-11-13T09:00:00.000Z";
const ADMIN_CSRF = "admin-csrf-token-0123456789abcdef";

const principals: Record<string, ModerationPrincipal> = {
  admin: { actorId: "admin-1", role: "admin", active: true, csrfToken: ADMIN_CSRF, channel: "web", datasetScope: "live" },
  moderator: { actorId: "moderator-1", role: "moderator", active: true, csrfToken: "moderator-csrf-token-0123456789", channel: "web", datasetScope: "live" },
  user: { actorId: "user-1", role: "user", active: true, csrfToken: "user-csrf-token-0123456789abcdef", channel: "web", datasetScope: "live" },
  inactiveAdmin: { actorId: "admin-2", role: "admin", active: false, csrfToken: "inactive-csrf-token-0123456789ab", channel: "web", datasetScope: "live" },
};

describe("FR-12 admin source approval route", () => {
  let db: TestDatabase;
  let store: SourceApprovalStore;
  let handler: SourceApprovalApiHandler;
  let counter = 0;

  before(async () => {
    db = await createTestDatabase();
    await applyMigrations(db.executor, await readMigrations(new URL("../../db/migrations/", import.meta.url)));
    await db.executor.query(
      `INSERT INTO waspada.traces (trace_id, dataset_kind, started_at, outcome, metadata)
       VALUES ('trace-seed-route', 'live', '2026-11-01T00:00:00Z', 'succeeded', '{}'::jsonb)`,
    );
    await db.executor.query(
      `INSERT INTO waspada.source_registry
         (source_id, trace_id, registry_version, display_name, source_kind, remit, access_method,
          approved_hosts, access_restrictions, reuse_basis, registry_status, approval_status,
          health_status, auto_acquisition_enabled, auto_publication_policy)
       VALUES
         ('source-route-pending', 'trace-seed-route', 1, 'Sumber uji menunggu', 'newsroom', ARRAY['banjir'],
          'rss', ARRAY[]::text[], ARRAY['synthetic test fixture'], ARRAY['model_triage'], 'active',
          'pending', 'unknown', true, 'never'),
         ('source-route-public', 'trace-seed-route', 1, 'Sumber uji tampil publik', 'authority', ARRAY['banjir'],
          'rss', ARRAY[]::text[], ARRAY['synthetic test fixture'], ARRAY['public_display'], 'active',
          'pending', 'unknown', true, 'never')`,
    );
    store = createSourceApprovalStore(db.executor, "live");
    handler = createSourceApprovalApiHandler({
      authenticate: async (request) => principals[request.headers.get("x-test-principal") ?? ""] ?? null,
      withStore: (work) => work(store),
      appOrigin: APP_ORIGIN,
      datasetScope: "live",
      now: () => new Date(NOW),
      newId: () => `route-id-${++counter}`,
    });
  });

  after(async () => db?.close());

  function send(method: string, path: string, options: {
    principal?: keyof typeof principals;
    body?: unknown;
    rawBody?: string;
    origin?: string | null;
    csrf?: string | null;
  } = {}): Promise<Response | undefined> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (options.principal) headers["x-test-principal"] = options.principal;
    const origin = options.origin === undefined ? APP_ORIGIN : options.origin;
    if (origin !== null) headers.origin = origin;
    const csrf = options.csrf === undefined ? ADMIN_CSRF : options.csrf;
    if (csrf !== null) headers["x-csrf-token"] = csrf;
    const init: RequestInit = { method, headers };
    if (options.rawBody !== undefined) init.body = options.rawBody;
    else if (options.body !== undefined) init.body = JSON.stringify(options.body);
    return handler(new Request(`${APP_ORIGIN}${path}`, init));
  }

  const approvalPath = (sourceId: string) => `/api/v1/admin/sources/${encodeURIComponent(sourceId)}/approval`;

  async function registry(sourceId: string) {
    const rows = await db.executor.query<{ approval_status: string; auto_acquisition_enabled: boolean; auto_publication_policy: string }>(
      `SELECT approval_status, auto_acquisition_enabled, auto_publication_policy
       FROM waspada.source_registry WHERE source_id = $1`,
      [sourceId],
    );
    return rows.rows[0];
  }

  async function auditCount(): Promise<number> {
    const rows = await db.executor.query<{ count: number }>(
      "SELECT COUNT(*)::int AS count FROM waspada.audit_records WHERE entity_type = 'source'",
    );
    return rows.rows[0]?.count ?? 0;
  }

  it("answers anonymous list and approval requests with 401 and changes nothing", async () => {
    const list = await send("GET", "/api/v1/admin/sources");
    assert.equal(list?.status, 401);
    const write = await send("POST", approvalPath("source-route-pending"), { body: { status: "approved", note: NOTE } });
    assert.equal(write?.status, 401);
    assert.equal((await registry("source-route-pending"))?.approval_status, "pending");
  });

  it("answers moderators, users and inactive administrators with 403 and writes nothing", async () => {
    const auditsBefore = await auditCount();
    for (const principal of ["moderator", "user"] as const) {
      const list = await send("GET", "/api/v1/admin/sources", { principal });
      assert.equal(list?.status, 403, `${principal} may not list sources`);
      const write = await send("POST", approvalPath("source-route-pending"), { principal, body: { status: "approved", note: NOTE } });
      assert.equal(write?.status, 403, `${principal} may not approve a source`);
    }
    const inactive = await send("POST", approvalPath("source-route-pending"), { principal: "inactiveAdmin", body: { status: "approved", note: NOTE } });
    assert.equal(inactive?.status, 403);
    assert.equal((await inactive?.json() as { code: string }).code, "ACCOUNT_INACTIVE");
    assert.equal((await registry("source-route-pending"))?.approval_status, "pending");
    assert.equal(await auditCount(), auditsBefore);
  });

  it("refuses browser writes without the exact Origin or with a missing or wrong CSRF token", async () => {
    const auditsBefore = await auditCount();
    const body = { status: "approved", note: NOTE };
    const wrongOrigin = await send("POST", approvalPath("source-route-pending"), { principal: "admin", body, origin: "https://evil.example" });
    assert.equal(wrongOrigin?.status, 403);
    assert.equal((await wrongOrigin?.json() as { code: string }).code, "CSRF_ORIGIN_MISMATCH");

    const noOrigin = await send("POST", approvalPath("source-route-pending"), { principal: "admin", body, origin: null });
    assert.equal(noOrigin?.status, 403);

    const missingToken = await send("POST", approvalPath("source-route-pending"), { principal: "admin", body, csrf: null });
    assert.equal(missingToken?.status, 403);
    assert.equal((await missingToken?.json() as { code: string }).code, "CSRF_TOKEN_INVALID");

    const wrongToken = await send("POST", approvalPath("source-route-pending"), { principal: "admin", body, csrf: "not-the-session-token-0000000000" });
    assert.equal(wrongToken?.status, 403);

    assert.equal((await registry("source-route-pending"))?.approval_status, "pending");
    assert.equal(await auditCount(), auditsBefore);
  });

  it("approval by an administrator updates the registry and writes one trace and audit row, read back from the database", async () => {
    const response = await send("POST", approvalPath("source-route-pending"), {
      principal: "admin", body: { status: "approved", note: NOTE },
    });
    assert.equal(response?.status, 200);
    const payload = await response?.json() as {
      previous_approval_status: string;
      source: { source_id: string; approval_status: string; public_display_granted: boolean };
    };
    assert.equal(payload.previous_approval_status, "pending");
    assert.equal(payload.source.source_id, "source-route-pending");
    assert.equal(payload.source.approval_status, "approved");
    assert.equal(payload.source.public_display_granted, false, "approval alone grants no public display");

    assert.deepEqual(await registry("source-route-pending"), {
      approval_status: "approved", auto_acquisition_enabled: true, auto_publication_policy: "never",
    }, "approval sets the status only: collection was already on and stays on; the policy is unchanged");
    const audit = await db.executor.query<{ actor_id: string; action: string; reason: string; trace_id: string; dataset_kind: string; details: Record<string, unknown> }>(
      `SELECT actor_id, action, reason, trace_id, dataset_kind, details
       FROM waspada.audit_records WHERE entity_type = 'source' AND entity_id = 'source-route-pending'`,
    );
    assert.equal(audit.rows.length, 1);
    assert.equal(audit.rows[0]?.actor_id, "admin-1");
    assert.equal(audit.rows[0]?.action, "source_approval_approved");
    assert.equal(audit.rows[0]?.reason, NOTE);
    assert.equal(audit.rows[0]?.dataset_kind, "live");
    assert.equal(audit.rows[0]?.details.previous_approval_status, "pending");
    const trace = await db.executor.query<{ outcome: string }>(
      "SELECT outcome FROM waspada.traces WHERE trace_id = $1 AND dataset_kind = 'live'",
      [audit.rows[0]?.trace_id],
    );
    assert.equal(trace.rows[0]?.outcome, "succeeded");
  });

  it("revocation stops auto-publication only: collection stays on (FR-16) and the audit row records the change", async () => {
    const response = await send("POST", approvalPath("source-route-pending"), {
      principal: "admin", body: { status: "revoked", note: NOTE },
    });
    assert.equal(response?.status, 200);
    assert.deepEqual(await registry("source-route-pending"), {
      approval_status: "revoked", auto_acquisition_enabled: true, auto_publication_policy: "never",
    }, "revocation does not switch collection off");
    const audit = await db.executor.query<{ action: string }>(
      `SELECT action FROM waspada.audit_records WHERE entity_id = 'source-route-pending' ORDER BY occurred_at, audit_id`,
    );
    assert.deepEqual(audit.rows.map((row) => row.action), ["source_approval_approved", "source_approval_revoked"]);
  });

  it("answers an approval that repeats the current status with 409 and writes nothing", async () => {
    const auditsBefore = await auditCount();
    const response = await send("POST", approvalPath("source-route-pending"), {
      principal: "admin", body: { status: "revoked", note: NOTE },
    });
    assert.equal(response?.status, 409);
    assert.equal(await auditCount(), auditsBefore);
  });

  it("answers an unknown source with 404 and writes nothing", async () => {
    const auditsBefore = await auditCount();
    const response = await send("POST", approvalPath("source-does-not-exist"), {
      principal: "admin", body: { status: "approved", note: NOTE },
    });
    assert.equal(response?.status, 404);
    assert.equal(await auditCount(), auditsBefore);
  });

  it("refuses malformed bodies with 400 before any write", async () => {
    const auditsBefore = await auditCount();
    const cases: Array<{ name: string; options: Parameters<typeof send>[2] }> = [
      { name: "malformed JSON", options: { principal: "admin", rawBody: "{nope" } },
      { name: "a JSON array", options: { principal: "admin", body: [] } },
      { name: "an unknown status", options: { principal: "admin", body: { status: "suspended", note: NOTE } } },
      { name: "a missing note", options: { principal: "admin", body: { status: "approved" } } },
      { name: "a note of nine characters", options: { principal: "admin", body: { status: "approved", note: "sembilan." } } },
      { name: "a note of 501 characters", options: { principal: "admin", body: { status: "approved", note: "x".repeat(501) } } },
      { name: "a note with a control character", options: { principal: "admin", body: { status: "approved", note: `catatan${"\u0007"}uji panjang` } } },
      { name: "an extra field", options: { principal: "admin", body: { status: "approved", note: NOTE, role: "admin" } } },
    ];
    for (const testCase of cases) {
      const response = await send("POST", approvalPath("source-route-pending"), testCase.options);
      assert.equal(response?.status, 400, testCase.name);
    }
    assert.equal(await auditCount(), auditsBefore);
    assert.equal((await registry("source-route-pending"))?.approval_status, "revoked");
  });

  it("re-approval and a second revocation both leave collection on (FR-16), and the audit log counts each transition", async () => {
    assert.equal((await registry("source-route-pending"))?.auto_acquisition_enabled, true);
    const approved = await send("POST", approvalPath("source-route-pending"), {
      principal: "admin", body: { status: "approved", note: NOTE },
    });
    assert.equal(approved?.status, 200);
    assert.deepEqual(await registry("source-route-pending"), {
      approval_status: "approved", auto_acquisition_enabled: true, auto_publication_policy: "never",
    });

    const revoked = await send("POST", approvalPath("source-route-pending"), {
      principal: "admin", body: { status: "revoked", note: NOTE },
    });
    assert.equal(revoked?.status, 200);
    assert.deepEqual(await registry("source-route-pending"), {
      approval_status: "revoked", auto_acquisition_enabled: true, auto_publication_policy: "never",
    });
    // Every route write shares one occurred_at, so count the transitions rather than rely on row order.
    const audit = await db.executor.query<{ action: string }>(
      `SELECT action FROM waspada.audit_records WHERE entity_id = 'source-route-pending'`,
    );
    const actions = audit.rows.map((row) => row.action);
    assert.equal(actions.filter((action) => action === "source_approval_approved").length, 2);
    assert.equal(actions.filter((action) => action === "source_approval_revoked").length, 2);
  });

  it("the list shows public display as granted only for an approved, collecting source whose reuse basis carries public_display", async () => {
    const readList = async () => {
      const list = await send("GET", "/api/v1/admin/sources", { principal: "admin" });
      assert.equal(list?.status, 200);
      return (await list?.json() as { sources: Array<{ source_id: string; approval_status: string; auto_acquisition_enabled: boolean; public_display_granted: boolean }> }).sources;
    };
    const before = await readList();
    assert.deepEqual(before.map((source) => source.source_id), ["source-route-pending", "source-route-public"]);
    assert.equal(before[0]?.approval_status, "revoked");
    assert.ok(before.every((source) => source.public_display_granted === false), "nothing is approved yet");

    // Approval sets the status only: both sources already collect (FR-16). This source's reuse basis carries
    // public_display, so the existing permission model now grants display for this one source only.
    const approved = await send("POST", approvalPath("source-route-public"), {
      principal: "admin", body: { status: "approved", note: NOTE },
    });
    assert.equal(approved?.status, 200);
    const afterApproval = await readList();
    const publicSource = afterApproval.find((source) => source.source_id === "source-route-public");
    assert.equal(publicSource?.auto_acquisition_enabled, true);
    assert.equal(publicSource?.public_display_granted, true);
    assert.equal(afterApproval.find((source) => source.source_id === "source-route-pending")?.public_display_granted, false);
  });

  it("the admin list adds the restriction and health fields and nothing else, and the health states follow the hosted writer", async () => {
    const readSources = async () => {
      const list = await send("GET", "/api/v1/admin/sources", { principal: "admin" });
      assert.equal(list?.status, 200);
      return (await list?.json() as { sources: Array<Record<string, unknown>> }).sources;
    };
    const expectedFields = [
      "access_method", "access_restrictions", "approval_status", "auto_acquisition_enabled", "auto_publication_policy",
      "display_name", "health_status", "last_checked_at", "last_failure_at", "last_success_at", "polling_interval_seconds",
      "public_display_granted", "registry_status", "reuse_basis", "source_id", "source_kind",
    ];

    // Never checked: the seeded row has no health time, so the admin page shows the no-data line.
    const never = (await readSources()).find((source) => source.source_id === "source-route-pending");
    assert.deepEqual(Object.keys(never ?? {}).sort(), [...expectedFields].sort(), "no license URL, scope or reviewer is added");
    assert.deepEqual(never?.reuse_basis, ["model_triage"]);
    assert.deepEqual(never?.access_restrictions, ["synthetic test fixture"]);
    assert.equal(never?.polling_interval_seconds, null);
    assert.equal(never?.health_status, "unknown");
    assert.equal(never?.last_checked_at, null);
    assert.equal(never?.last_success_at, null);
    assert.equal(never?.last_failure_at, null);

    // A failed check, written as the hosted writer writes it (tools/hosted/source-health.ts): degraded, last_checked_at
    // at the failure, and an earlier success. The failure time is the last check.
    await db.executor.query(
      `UPDATE waspada.source_registry
         SET health_status = 'degraded', last_checked_at = '2026-11-13T08:00:00Z',
             last_success_at = '2026-11-13T07:00:00Z', polling_interval_seconds = 900
       WHERE source_id = 'source-route-public'`,
    );
    const degraded = (await readSources()).find((source) => source.source_id === "source-route-public");
    assert.equal(degraded?.health_status, "degraded");
    assert.equal(degraded?.last_checked_at, "2026-11-13T08:00:00.000Z", "stored instants are returned as ISO");
    assert.equal(degraded?.last_success_at, "2026-11-13T07:00:00.000Z");
    assert.equal(degraded?.last_failure_at, "2026-11-13T08:00:00.000Z");
    assert.equal(degraded?.polling_interval_seconds, 900);
    assert.deepEqual(degraded?.reuse_basis, ["public_display"]);

    // A later success: healthy again, and no failure time is reported.
    await db.executor.query(
      `UPDATE waspada.source_registry
         SET health_status = 'healthy', last_checked_at = '2026-11-13T08:15:00Z', last_success_at = '2026-11-13T08:15:00Z'
       WHERE source_id = 'source-route-public'`,
    );
    const healthy = (await readSources()).find((source) => source.source_id === "source-route-public");
    assert.equal(healthy?.health_status, "healthy");
    assert.equal(healthy?.last_failure_at, null);
    assert.equal(healthy?.last_success_at, "2026-11-13T08:15:00.000Z");
  });

  it("maps a storage failure to 503 with a generic body", async () => {
    const failing = createSourceApprovalApiHandler({
      authenticate: async () => principals.admin ?? null,
      withStore: async () => { throw new Error("connection string postgres://secret@db"); },
      appOrigin: APP_ORIGIN,
      datasetScope: "live",
    });
    const response = await failing(new Request(`${APP_ORIGIN}/api/v1/admin/sources`, {
      headers: { origin: APP_ORIGIN, "x-csrf-token": ADMIN_CSRF },
    }));
    assert.equal(response?.status, 503);
    const text = await response?.text();
    assert.doesNotMatch(text ?? "", /secret|postgres/u);
  });

  it("answers other methods with 405 and unknown subpaths with 404, and ignores unrelated paths", async () => {
    assert.equal((await send("DELETE", "/api/v1/admin/sources", { principal: "admin" }))?.status, 405);
    assert.equal((await send("GET", approvalPath("source-route-pending"), { principal: "admin" }))?.status, 405);
    assert.equal((await send("POST", "/api/v1/admin/sources/source-route-pending/other", { principal: "admin", body: {} }))?.status, 404);
    assert.equal(await send("GET", "/api/v1/events", { principal: "admin" }), undefined);
  });
});
