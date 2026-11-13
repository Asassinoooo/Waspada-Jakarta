import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { AccountStore, StoredAccountSession } from "../../db/src/accounts.js";
import {
  createModerationApiHandler,
  isModerationPath,
  type EventProposalDto,
  type ModeratorDecisionCommand,
  type StoredEvidenceChunk,
} from "../src/layers/l4-application-integration/moderation-api.js";

// ============================================================================
// Fixtures
// ============================================================================

const sampleProposal: EventProposalDto = {
  schema_version: "2.0",
  proposal_id: "prop-flood-001",
  title: "Banjir 50cm di Kemang Raya",
  incident_type: "flood",
  severity: "high",
  event_time: {
    precision: "exact",
    value: "2026-10-26T10:00:00+07:00",
  },
  location_label: "Kemang Raya, Jakarta Selatan",
  coordinates: [106.815, -6.265],
  claims: [
    {
      claim_id: "claim-001",
      claim_text: "Air merendam jalan setinggi 50 sentimeter",
      evidence_label: "under_review",
      support_assessment: "supported",
      quote_text: "genangan setinggi 50 cm merendam jalan",
      evidence_ref_id: "chunk-0",
    },
  ],
  proposed_at: "2026-10-26T10:05:00+07:00",
};

const sampleChunks: readonly StoredEvidenceChunk[] = [
  {
    chunk_index: 0,
    text: "Hujan deras menyebabkan genangan setinggi 50 cm merendam jalan Kemang Raya siang ini.",
    span_start: 0,
    span_end: 85,
  },
];

class MemoryAccountStore {
  private readonly sessions = new Map<string, StoredAccountSession>();

  addSession(token: string, session: StoredAccountSession): void {
    const hash = createHash("sha256").update(token).digest("hex");
    this.sessions.set(hash, session);
  }

  async readSession(tokenSha256: string): Promise<StoredAccountSession | null> {
    return this.sessions.get(tokenSha256) ?? null;
  }
}

// ============================================================================
// Route Dispatch Tests
// ============================================================================

test("isModerationPath identifies moderation routes correctly", () => {
  assert.equal(isModerationPath("/api/v1/moderation"), true);
  assert.equal(isModerationPath("/api/v1/moderation/proposals"), true);
  assert.equal(isModerationPath("/api/v1/moderation/proposals/prop-1"), true);
  assert.equal(isModerationPath("/api/v1/events"), false);
  assert.equal(isModerationPath("/api/v1/auth/session"), false);
});

test("GET /api/v1/moderation/proposals lists pending proposals under review", async () => {
  const handler = createModerationApiHandler({
    datasetScope: "live",
    principal: {
      actorId: "mod-1",
      role: "moderator",
      active: true,
    },
    proposals: [sampleProposal],
  });

  const response = await handler(new Request("http://localhost/api/v1/moderation/proposals"));
  assert.ok(response);
  assert.equal(response.status, 200);

  const body = (await response.json()) as {
    proposals: EventProposalDto[];
    items: EventProposalDto[];
  };
  assert.equal(body.proposals.length, 1);
  assert.equal(body.proposals[0]?.proposal_id, "prop-flood-001");
  assert.equal(body.proposals[0]?.title, "Banjir 50cm di Kemang Raya");
  assert.equal(body.items.length, 1);
});

test("GET /api/v1/moderation/proposals returns empty list when none pending", async () => {
  const handler = createModerationApiHandler({
    datasetScope: "live",
    principal: {
      actorId: "mod-1",
      role: "moderator",
      active: true,
    },
    proposals: [],
  });

  const response = await handler(new Request("http://localhost/api/v1/moderation/proposals"));
  assert.ok(response);
  assert.equal(response.status, 200);

  const body = (await response.json()) as { proposals: EventProposalDto[] };
  assert.deepEqual(body.proposals, []);
});

test("GET /api/v1/moderation/proposals/:id returns proposal details and evidence chunks", async () => {
  const chunksRecord: Record<string, readonly StoredEvidenceChunk[]> = {
    "prop-flood-001": sampleChunks,
  };

  const handler = createModerationApiHandler({
    datasetScope: "live",
    principal: {
      actorId: "mod-1",
      role: "moderator",
      active: true,
    },
    proposals: [sampleProposal],
    chunks: chunksRecord,
  });

  const response = await handler(
    new Request("http://localhost/api/v1/moderation/proposals/prop-flood-001"),
  );
  assert.ok(response);
  assert.equal(response.status, 200);

  const body = (await response.json()) as {
    proposal: EventProposalDto;
    chunks: StoredEvidenceChunk[];
    title: string;
    incident_type: string;
  };
  assert.equal(body.proposal.proposal_id, "prop-flood-001");
  assert.equal(body.title, "Banjir 50cm di Kemang Raya");
  assert.equal(body.incident_type, "flood");
  assert.equal(body.chunks.length, 1);
  assert.equal(body.chunks[0]?.chunk_index, 0);
  assert.match(body.chunks[0]?.text ?? "", /Kemang Raya/);
});

test("GET /api/v1/moderation/proposals/:id returns 404 when proposal not found", async () => {
  const handler = createModerationApiHandler({
    datasetScope: "live",
    principal: {
      actorId: "mod-1",
      role: "moderator",
      active: true,
    },
    proposals: [sampleProposal],
  });

  const response = await handler(
    new Request("http://localhost/api/v1/moderation/proposals/non-existent-id"),
  );
  assert.ok(response);
  assert.equal(response.status, 404);

  const body = (await response.json()) as { code: string; message: string };
  assert.equal(body.code, "PROPOSAL_NOT_FOUND");
});

test("Method not allowed returns 405", async () => {
  const handler = createModerationApiHandler({
    datasetScope: "live",
    principal: {
      actorId: "mod-1",
      role: "moderator",
      active: true,
      csrfToken: "csrf-token-123",
    },
  });

  const postList = await handler(
    new Request("http://localhost/api/v1/moderation/proposals", {
      method: "POST",
      headers: { "x-csrf-token": "csrf-token-123" },
    }),
  );
  assert.equal(postList?.status, 405);

  const postDetail = await handler(
    new Request("http://localhost/api/v1/moderation/proposals/prop-1", {
      method: "POST",
      headers: { "x-csrf-token": "csrf-token-123" },
    }),
  );
  assert.equal(postDetail?.status, 405);

  const getPublish = await handler(
    new Request("http://localhost/api/v1/moderation/proposals/prop-1/publish", {
      method: "GET",
    }),
  );
  assert.equal(getPublish?.status, 405);
});

test("Unknown moderation route returns 404, non-moderation route returns undefined", async () => {
  const handler = createModerationApiHandler({
    datasetScope: "live",
    principal: {
      actorId: "mod-1",
      role: "moderator",
      active: true,
    },
  });

  const unknown = await handler(new Request("http://localhost/api/v1/moderation/unknown-subpath"));
  assert.equal(unknown?.status, 404);

  const nonModeration = await handler(new Request("http://localhost/api/v1/events"));
  assert.equal(nonModeration, undefined, "Leaves non-moderation routes to other handlers");
});

// ============================================================================
// Authentication & Role Authorization Tests
// ============================================================================

test("Unauthenticated request returns 401 Unauthorized", async () => {
  const handler = createModerationApiHandler({
    datasetScope: "live",
    authenticate: async () => null,
  });

  const response = await handler(new Request("http://localhost/api/v1/moderation/proposals"));
  assert.ok(response);
  assert.equal(response.status, 401);

  const body = (await response.json()) as { code: string };
  assert.equal(body.code, "UNAUTHORIZED");
});

test("Inactive user returns 403 Forbidden (ACCOUNT_INACTIVE)", async () => {
  const handler = createModerationApiHandler({
    datasetScope: "live",
    principal: {
      actorId: "mod-suspended",
      role: "moderator",
      active: false,
    },
  });

  const response = await handler(new Request("http://localhost/api/v1/moderation/proposals"));
  assert.ok(response);
  assert.equal(response.status, 403);

  const body = (await response.json()) as { code: string };
  assert.equal(body.code, "ACCOUNT_INACTIVE");
});

test("Active user with role 'user' returns 403 Forbidden", async () => {
  const handler = createModerationApiHandler({
    datasetScope: "live",
    principal: {
      actorId: "regular-user-1",
      role: "user",
      active: true,
    },
  });

  const response = await handler(new Request("http://localhost/api/v1/moderation/proposals"));
  assert.ok(response);
  assert.equal(response.status, 403);

  const body = (await response.json()) as { code: string };
  assert.equal(body.code, "FORBIDDEN");
});

test("Active user with role 'moderator' is authorized", async () => {
  const handler = createModerationApiHandler({
    datasetScope: "live",
    principal: {
      actorId: "mod-1",
      role: "moderator",
      active: true,
    },
    proposals: [sampleProposal],
  });

  const response = await handler(new Request("http://localhost/api/v1/moderation/proposals"));
  assert.ok(response);
  assert.equal(response.status, 200);
});

test("Active user with role 'admin' is authorized", async () => {
  const handler = createModerationApiHandler({
    datasetScope: "live",
    principal: {
      actorId: "admin-1",
      role: "admin",
      active: true,
    },
    proposals: [sampleProposal],
  });

  const response = await handler(new Request("http://localhost/api/v1/moderation/proposals"));
  assert.ok(response);
  assert.equal(response.status, 200);
});

test("moderation reads only the browser cookie session, under the shared cookie name for each mode", async () => {
  const store = new MemoryAccountStore();
  const token = "a".repeat(48);
  store.addSession(token, moderatorSession("cookie-csrf-secret"));

  const hostHandler = createModerationApiHandler({
    datasetScope: "live",
    accountStore: store as unknown as AccountStore,
    proposals: [sampleProposal],
  });
  assert.equal((await hostHandler(new Request("http://localhost/api/v1/moderation/proposals", {
    headers: { cookie: `__Host-waspada_session=${token}` },
  })))?.status, 200);
  assert.equal((await hostHandler(new Request("http://localhost/api/v1/moderation/proposals", {
    headers: { cookie: `waspada_session_dev=${token}` },
  })))?.status, 401, "the development cookie is not accepted in host mode");
  assert.equal((await hostHandler(new Request("http://localhost/api/v1/moderation/proposals", {
    headers: { authorization: `Bearer ${token}` },
  })))?.status, 401, "bearer tokens never authorize moderation");

  const loopbackHandler = createModerationApiHandler({
    datasetScope: "live",
    accountStore: store as unknown as AccountStore,
    cookieMode: "loopback",
    proposals: [sampleProposal],
  });
  assert.equal((await loopbackHandler(new Request("http://localhost/api/v1/moderation/proposals", {
    headers: { cookie: `waspada_session_dev=${token}` },
  })))?.status, 200);
  assert.equal((await hostHandler(new Request("http://localhost/api/v1/moderation/proposals", {
    headers: { authorization: `Bearer ${"b".repeat(48)}` },
  })))?.status, 401);
});

test("moderation writes need an active moderator, the exact Origin, and the session CSRF token", async () => {
  const store = new MemoryAccountStore();
  const moderatorToken = "m".repeat(48);
  const userToken = "u".repeat(48);
  store.addSession(moderatorToken, moderatorSession("csrf-mod-session"));
  store.addSession(userToken, { ...moderatorSession("csrf-user-session"), account: { ...moderatorSession("x").account, id: "acc-user-1", role: "user" } });
  const published: unknown[] = [];
  const appOrigin = "https://waspada.example";
  const handler = createModerationApiHandler({
    datasetScope: "live",
    accountStore: store as unknown as AccountStore,
    appOrigin,
    csrfProtection: true,
    proposals: [sampleProposal],
    publisher: {
      publish: async (input: unknown) => {
        published.push(input);
        return { status: "written", receipt: { decision_id: "dec-test" } };
      },
    },
  });
  const publishUrl = "http://localhost/api/v1/moderation/proposals/prop-flood-001/publish";
  const publish = (headers: Record<string, string>, body: unknown = { evidence_label: "attributed_report" }) => handler(new Request(publishUrl, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  }));

  assert.equal((await publish({ origin: appOrigin, "x-csrf-token": "csrf-mod-session" }))?.status, 401, "no session is 401");
  assert.equal((await publish({
    cookie: `__Host-waspada_session=${userToken}`, origin: appOrigin, "x-csrf-token": "csrf-user-session",
  }))?.status, 403, "a user session is forbidden even with valid CSRF");
  assert.equal((await handler(new Request("http://localhost/api/v1/moderation/proposals", {
    headers: { cookie: `__Host-waspada_session=${userToken}` },
  })))?.status, 403, "a user session cannot read the queue");
  const moderatorCookie = `__Host-waspada_session=${moderatorToken}`;
  const missingCsrf = await publish({ cookie: moderatorCookie, origin: appOrigin });
  assert.equal(missingCsrf?.status, 403);
  assert.equal(((await missingCsrf?.json()) as { code: string }).code, "CSRF_TOKEN_INVALID");
  assert.equal((await publish({ cookie: moderatorCookie, origin: appOrigin, "x-csrf-token": "wrong-token" }))?.status, 403);
  assert.equal((await publish({ cookie: moderatorCookie, origin: "https://evil.example", "x-csrf-token": "csrf-mod-session" }))?.status, 403);
  assert.equal((await publish({ cookie: moderatorCookie, "x-csrf-token": "csrf-mod-session" }))?.status, 403, "a missing Origin is refused");
  assert.equal(published.length, 0, "no refused request reaches the publisher");

  const accepted = await publish({ cookie: moderatorCookie, origin: appOrigin, "x-csrf-token": "csrf-mod-session" });
  assert.equal(accepted?.status, 200);
  assert.equal(published.length, 1);
  assert.equal((published[0] as { actorId: string }).actorId, "acc-mod-1");

  const spoofed = await publish(
    { cookie: moderatorCookie, origin: appOrigin, "x-csrf-token": "csrf-mod-session" },
    { evidence_label: "attributed_report", actorId: "someone-else", proposal_id: "other" },
  );
  assert.equal(spoofed?.status, 200);
  assert.equal((published[1] as { actorId: string; proposal_id: string }).actorId, "acc-mod-1", "the body cannot choose the reviewer");
  assert.equal((published[1] as { proposal_id: string }).proposal_id, "prop-flood-001");

  const badLabel = await publish(
    { cookie: moderatorCookie, origin: appOrigin, "x-csrf-token": "csrf-mod-session" },
    { evidence_label: "verified_by_government" },
  );
  assert.equal(badLabel?.status, 400);
  assert.equal(((await badLabel?.json()) as { code: string }).code, "INVALID_EVIDENCE_LABEL");
  assert.equal(published.length, 2);
});

test("a principal from another dataset is denied even when its role is moderator", async () => {
  const handler = createModerationApiHandler({
    datasetScope: "live",
    principal: { actorId: "mod-synthetic", role: "moderator", active: true, datasetScope: "synthetic", csrfToken: "t" },
    proposals: [sampleProposal],
  });
  const response = await handler(new Request("http://localhost/api/v1/moderation/proposals"));
  assert.equal(response?.status, 403);
  assert.equal(((await response?.json()) as { code: string }).code, "FORBIDDEN");
});

function moderatorSession(csrfToken: string): StoredAccountSession {
  return {
    channel: "web",
    csrfToken,
    account: {
      id: "acc-mod-1",
      display_name: "Mod One",
      email: null,
      role: "moderator",
      active: true,
      onboarding_version: 1,
      onboarding_completed_at: "2026-10-01T00:00:00Z",
      version: 1,
    },
  };
}

// ============================================================================
// CSRF Validation Tests
// ============================================================================

test("POST publication requires valid CSRF token", async () => {
  const publisherCalls: unknown[] = [];
  const handler = createModerationApiHandler({
    datasetScope: "live",
    principal: {
      actorId: "mod-1",
      role: "moderator",
      active: true,
      csrfToken: "expected-csrf-token",
    },
    publisher: {
      publish: async (input: unknown) => {
        publisherCalls.push(input);
        return { status: "written", receipt: { outcome: "written" } };
      },
    },
  });

  // 1. Missing CSRF header -> 403
  const missingCsrf = await handler(
    new Request("http://localhost/api/v1/moderation/proposals/prop-1/publish", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "publish" }),
    }),
  );
  assert.equal(missingCsrf?.status, 403);
  const missingBody = (await missingCsrf?.json()) as { code: string };
  assert.equal(missingBody.code, "CSRF_TOKEN_INVALID");
  assert.equal(publisherCalls.length, 0);

  // 2. Mismatched CSRF header -> 403
  const wrongCsrf = await handler(
    new Request("http://localhost/api/v1/moderation/proposals/prop-1/publish", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-csrf-token": "wrong-csrf-token",
      },
      body: JSON.stringify({ action: "publish" }),
    }),
  );
  assert.equal(wrongCsrf?.status, 403);
  assert.equal(publisherCalls.length, 0);

  // 3. Valid CSRF token -> 200
  const validCsrf = await handler(
    new Request("http://localhost/api/v1/moderation/proposals/prop-1/publish", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-csrf-token": "expected-csrf-token",
      },
      body: JSON.stringify({
        action: "publish",
        evidence_label: "attributed_report",
        reason: "Valid report",
      }),
    }),
  );
  assert.equal(validCsrf?.status, 200);
  assert.equal(publisherCalls.length, 1);
});

test("GET requests do not require CSRF token", async () => {
  const handler = createModerationApiHandler({
    datasetScope: "live",
    principal: {
      actorId: "mod-1",
      role: "moderator",
      active: true,
      csrfToken: "expected-csrf-token",
    },
    proposals: [sampleProposal],
  });

  const response = await handler(
    new Request("http://localhost/api/v1/moderation/proposals"), // no x-csrf-token header
  );
  assert.equal(response?.status, 200);
});

// ============================================================================
// Publication Action Tests
// ============================================================================

test("POST /api/v1/moderation/proposals/:id/publish executes publication via publisher", async () => {
  let capturedInput: unknown = null;
  const handler = createModerationApiHandler({
    datasetScope: "live",
    principal: {
      actorId: "mod-lead-1",
      role: "moderator",
      active: true,
      csrfToken: "csrf-pub-1",
    },
    proposals: [sampleProposal],
    publicationService: {
      publish: async (input: unknown) => {
        capturedInput = input;
        return {
          status: "written",
          receipt: {
            outcome: "written",
            decisionId: "decision-mod-101",
            eventId: "event-flood-kemang",
            eventVersion: 1,
          },
        };
      },
    },
  });

  const command: ModeratorDecisionCommand = {
    proposal_id: "prop-flood-001",
    action: "publish",
    evidence_label: "attributed_report",
    reason: "Terverifikasi oleh tim moderasi.",
  };

  const response = await handler(
    new Request("http://localhost/api/v1/moderation/proposals/prop-flood-001/publish", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-csrf-token": "csrf-pub-1",
      },
      body: JSON.stringify(command),
    }),
  );

  assert.ok(response);
  assert.equal(response.status, 200);

  const body = (await response.json()) as {
    ok: boolean;
    status: string;
    receipt: { outcome: string; decisionId: string; eventId: string; eventVersion: number };
  };
  assert.equal(body.ok, true);
  assert.equal(body.status, "written");
  assert.equal(body.receipt.outcome, "written");
  assert.equal(body.receipt.eventId, "event-flood-kemang");

  const expectedPayload = capturedInput as Record<string, unknown>;
  assert.equal(expectedPayload.proposalId, "prop-flood-001");
  assert.equal(expectedPayload.actorId, "mod-lead-1");
  assert.equal(expectedPayload.action, "publish");
  assert.equal(expectedPayload.evidence_label, "attributed_report");
  assert.equal(expectedPayload.reason, "Terverifikasi oleh tim moderasi.");
});

test("POST publish handles publisher denial outcomes cleanly", async () => {
  const handler = createModerationApiHandler({
    datasetScope: "live",
    principal: {
      actorId: "mod-1",
      role: "moderator",
      active: true,
      csrfToken: "csrf-key",
    },
    publicationService: {
      publish: async () => ({
        status: "denied",
        code: "publication_not_authorized",
      }),
    },
  });

  const response = await handler(
    new Request("http://localhost/api/v1/moderation/proposals/prop-1/publish", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-csrf-token": "csrf-key",
      },
      body: JSON.stringify({ action: "publish" }),
    }),
  );

  assert.ok(response);
  assert.equal(response.status, 403);
  const body = (await response.json()) as { ok: boolean; code: string; status: string };
  assert.equal(body.ok, false);
  assert.equal(body.code, "publication_not_authorized");
});

test("POST publish refuses a proposal linked to a stopped investigation with 409 and the reason code (F-04)", async () => {
  const handler = createModerationApiHandler({
    datasetScope: "live",
    principal: {
      actorId: "mod-1",
      role: "moderator",
      active: true,
      csrfToken: "csrf-key",
    },
    publicationService: {
      publish: async () => ({
        status: "denied",
        code: "investigation_stopped_for_review",
      }),
    },
  });

  const response = await handler(
    new Request("http://localhost/api/v1/moderation/proposals/prop-1/publish", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-csrf-token": "csrf-key",
      },
      body: JSON.stringify({ action: "publish" }),
    }),
  );

  assert.ok(response);
  assert.equal(response.status, 409);
  const body = (await response.json()) as { ok: boolean; code: string; status: string };
  assert.equal(body.ok, false);
  assert.equal(body.status, "denied");
  assert.equal(body.code, "investigation_stopped_for_review");
});

test("POST publish handles publisher conflict outcome (409)", async () => {
  const handler = createModerationApiHandler({
    datasetScope: "live",
    principal: {
      actorId: "mod-1",
      role: "moderator",
      active: true,
      csrfToken: "csrf-key",
    },
    publicationService: {
      publish: async () => ({
        status: "conflict",
        code: "proposal_already_decided",
      }),
    },
  });

  const response = await handler(
    new Request("http://localhost/api/v1/moderation/proposals/prop-1/publish", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-csrf-token": "csrf-key",
      },
      body: JSON.stringify({ action: "publish" }),
    }),
  );

  assert.ok(response);
  assert.equal(response.status, 409);
  const body = (await response.json()) as { ok: boolean; code: string; status: string };
  assert.equal(body.ok, false);
  assert.equal(body.status, "conflict");
  assert.equal(body.code, "proposal_already_decided");
});

// ============================================================================
// WJ-INT-02A Inspection-only uncertain triage review
// ============================================================================

const triageItems = [
  {
    source_id: "source-antara-metro",
    item_identity_hash: "a1b2c3d4e5f6…",
    disposition: "uncertain",
    jakarta_scope: "unknown",
    actionability: "unknown",
    primary_category: null,
    incident_type: null,
    confidence: "low",
    reason_codes: ["ambiguous_location"],
    model_status: "ok",
    policy_version: "wj-int-02-v1",
    evaluated_at: "2026-10-26T08:00:00Z",
    reviewed_at: null,
    reviewed_by: null,
  },
];

test("GET triage requires auth: anonymous 401, inactive 403, non-moderator 403", async () => {
  const anon = createModerationApiHandler({
    datasetScope: "live", authenticate: async () => null, listUncertainTriage: async () => triageItems });
  const anonRes = await anon(new Request("http://localhost/api/v1/moderation/triage"));
  assert.equal(anonRes?.status, 401);

  const suspended = createModerationApiHandler({
    datasetScope: "live",
    principal: { actorId: "m", role: "moderator", active: false },
    listUncertainTriage: async () => triageItems,
  });
  assert.equal((await suspended(new Request("http://localhost/api/v1/moderation/triage")))?.status, 403);

  const user = createModerationApiHandler({
    datasetScope: "live",
    principal: { actorId: "u", role: "user", active: true },
    listUncertainTriage: async () => triageItems,
  });
  assert.equal((await user(new Request("http://localhost/api/v1/moderation/triage")))?.status, 403);
});

test("GET triage returns safelisted metadata fields only", async () => {
  const handler = createModerationApiHandler({
    datasetScope: "live",
    principal: { actorId: "mod-1", role: "moderator", active: true },
    listUncertainTriage: async () => triageItems,
  });
  const response = await handler(new Request("http://localhost/api/v1/moderation/triage"));
  assert.equal(response?.status, 200);
  const body = (await response!.json()) as { items: Record<string, unknown>[] };
  assert.equal(body.items.length, 1);
  const item = body.items[0]!;
  assert.ok(!("permitted_text" in item) && !("title" in item) && !("canonical_url" in item) && !("url" in item));
  assert.equal(item.source_id, "source-antara-metro");
  assert.equal(item.disposition, "uncertain");
});

test("POST triage review enforces CSRF and sets reviewed flag idempotently", async () => {
  let marked = 0;
  const fullHash = "a".repeat(64);
  const handler = createModerationApiHandler({
    datasetScope: "live",
    principal: { actorId: "mod-1", role: "moderator", active: true, csrfToken: "csrf-triage" },
    markTriageReviewed: async () => {
      marked += 1;
      return true;
    },
  });
  const noCsrf = await handler(
    new Request("http://localhost/api/v1/moderation/triage/review", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ item_identity_hash: fullHash }),
    }),
  );
  assert.equal(noCsrf?.status, 403);

  const ok = await handler(
    new Request("http://localhost/api/v1/moderation/triage/review", {
      method: "POST",
      headers: { "content-type": "application/json", "x-csrf-token": "csrf-triage" },
      body: JSON.stringify({ item_identity_hash: fullHash }),
    }),
  );
  assert.equal(ok?.status, 200);
  assert.equal(marked, 1);
  const again = await handler(
    new Request("http://localhost/api/v1/moderation/triage/review", {
      method: "POST",
      headers: { "content-type": "application/json", "x-csrf-token": "csrf-triage" },
      body: JSON.stringify({ item_identity_hash: fullHash }),
    }),
  );
  assert.equal(again?.status, 200);
  assert.equal(marked, 2);
});

test("POST publish rejects unresolved category mismatch with 409 until resolved", async () => {
  const published: unknown[] = [];
  const mismatched = {
    schema_version: "2.0" as const,
    proposal_id: "prop-mismatch-001",
    title: "Demonstrasi menutup jalan",
    incident_type: "demonstrasi",
    primary_category: "demonstrations_public_gatherings",
    severity: "medium" as const,
    event_time: { precision: "exact" as const, value: "2026-10-30T16:00:00.000Z" },
    location_label: "Jakarta",
    coordinates: null,
    claims: [],
    impacts: [],
    caveats: ["category_mismatch_review"],
    proposed_at: "2026-10-30T16:00:00.000Z",
  };
  const handler = createModerationApiHandler({
    datasetScope: "live",
    principal: { actorId: "mod-1", role: "moderator", active: true, csrfToken: "csrf-mismatch" },
    getProposalDetail: async () => ({ proposal: mismatched, chunks: [] }),
    publicationService: {
      publish: async (input: unknown) => {
        published.push(input);
        return { status: "written" };
      },
    },
  });
  const post = (body: unknown) =>
    handler(
      new Request("http://localhost/api/v1/moderation/proposals/prop-mismatch-001/publish", {
        method: "POST",
        headers: { "content-type": "application/json", "x-csrf-token": "csrf-mismatch" },
        body: JSON.stringify(body),
      }),
    );
  const blocked = await post({ action: "publish" });
  assert.equal(blocked?.status, 409);
  assert.equal(published.length, 0);
  const resolved = await post({ action: "publish", category_resolution: "accept_triage" });
  assert.equal(resolved?.status, 200);
  assert.equal(published.length, 1);
});

test("POST publish passes structured proposals without mismatch caveat", async () => {
  const published: unknown[] = [];
  const plain = {
    schema_version: "2.0" as const,
    proposal_id: "prop-plain-001",
    title: "Kebakaran melanda pasar",
    incident_type: "kebakaran_pasar",
    primary_category: "fires_infrastructure_hazards",
    severity: "high" as const,
    event_time: { precision: "exact" as const, value: "2026-10-30T16:00:00.000Z" },
    location_label: "Jakarta",
    coordinates: null,
    claims: [],
    impacts: [],
    caveats: [],
    proposed_at: "2026-10-30T16:00:00.000Z",
  };
  const handler = createModerationApiHandler({
    datasetScope: "live",
    principal: { actorId: "mod-1", role: "moderator", active: true, csrfToken: "csrf-plain" },
    getProposalDetail: async () => ({ proposal: plain, chunks: [] }),
    publicationService: {
      publish: async (input: unknown) => {
        published.push(input);
        return { status: "written" };
      },
    },
  });
  const res = await handler(
    new Request("http://localhost/api/v1/moderation/proposals/prop-plain-001/publish", {
      method: "POST",
      headers: { "content-type": "application/json", "x-csrf-token": "csrf-plain" },
      body: JSON.stringify({ action: "publish" }),
    }),
  );
  assert.equal(res?.status, 200);
  assert.equal(published.length, 1);
});

test("POST publish denies when current registry rights withhold public display", async () => {
  const published: unknown[] = [];
  let checks = 0;
  const gated = {
    schema_version: "2.0" as const,
    proposal_id: "prop-gated-001",
    title: "Banjir 60cm di Tebet Barat",
    incident_type: "flood",
    primary_category: "disasters_weather",
    severity: "high" as const,
    event_time: { precision: "exact" as const, value: "2026-10-30T16:00:00.000Z" },
    location_label: "Tebet Barat, Jakarta Selatan",
    coordinates: null,
    claims: [],
    impacts: [],
    caveats: [],
    proposed_at: "2026-10-30T16:00:00.000Z",
    source_id: "source-restricted-001",
  };
  const handler = createModerationApiHandler({
    datasetScope: "live",
    principal: { actorId: "mod-1", role: "moderator", active: true, csrfToken: "csrf-gated" },
    getProposalDetail: async () => ({ proposal: gated, chunks: [] }),
    checkPublicDisplay: async (sourceId: string) => {
      checks += 1;
      assert.equal(sourceId, "source-restricted-001");
      return false;
    },
    publicationService: {
      publish: async (input: unknown) => {
        published.push(input);
        return { status: "written" };
      },
    },
  });
  const res = await handler(
    new Request("http://localhost/api/v1/moderation/proposals/prop-gated-001/publish", {
      method: "POST",
      headers: { "content-type": "application/json", "x-csrf-token": "csrf-gated" },
      body: JSON.stringify({ action: "publish" }),
    }),
  );
  assert.equal(res?.status, 403);
  const body = (await res!.json()) as { code: string };
  assert.equal(body.code, "PUBLICATION_NOT_AUTHORIZED");
  assert.equal(checks, 1);
  assert.equal(published.length, 0);
});

test("POST publish with accept_interpretation publishes the interpreter category", async () => {
  const published: Array<Record<string, unknown>> = [];
  const mismatched = {
    schema_version: "2.0" as const,
    proposal_id: "prop-mismatch-002",
    title: "Truk terguling menutup jalan tol",
    incident_type: "kecelakaan_truk",
    primary_category: "disasters_weather",
    interpretation_category: "transport_road_incidents",
    severity: "high" as const,
    event_time: { precision: "exact" as const, value: "2026-10-30T16:00:00.000Z" },
    location_label: "Tol Dalam Kota, Jakarta",
    coordinates: null,
    claims: [],
    impacts: [],
    caveats: ["category_mismatch_review"],
    proposed_at: "2026-10-30T16:00:00.000Z",
  };
  const handler = createModerationApiHandler({
    datasetScope: "live",
    principal: { actorId: "mod-1", role: "moderator", active: true, csrfToken: "csrf-interp" },
    getProposalDetail: async () => ({ proposal: mismatched, chunks: [] }),
    publicationService: {
      publish: async (input: unknown) => {
        published.push(input as Record<string, unknown>);
        return { status: "written" };
      },
    },
  });
  const res = await handler(
    new Request("http://localhost/api/v1/moderation/proposals/prop-mismatch-002/publish", {
      method: "POST",
      headers: { "content-type": "application/json", "x-csrf-token": "csrf-interp" },
      body: JSON.stringify({ action: "publish", category_resolution: "accept_interpretation" }),
    }),
  );
  assert.equal(res?.status, 200);
  assert.equal(published.length, 1);
  assert.equal(published[0]!.resolved_category, "transport_road_incidents");
  assert.equal(published[0]!.category_resolution, "accept_interpretation");
});
