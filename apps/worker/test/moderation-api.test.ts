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

test("Authentication via AccountStore with session cookie and bearer token", async () => {
  const store = new MemoryAccountStore();
  const token = "a".repeat(48);

  store.addSession(token, {
    channel: "web",
    csrfToken: "cookie-csrf-secret",
    account: {
      id: "acc-mod-1",
      display_name: "Mod One",
      email: "mod@example.com",
      role: "moderator",
      active: true,
      onboarding_version: 1,
      onboarding_completed_at: "2026-10-01T00:00:00Z",
      version: 1,
    },
  });

  const handler = createModerationApiHandler({
    accountStore: store as unknown as AccountStore,
    proposals: [sampleProposal],
  });

  // Cookie authentication
  const cookieReq = new Request("http://localhost/api/v1/moderation/proposals", {
    headers: { cookie: `__Host-waspada_session=${token}` },
  });
  const cookieRes = await handler(cookieReq);
  assert.equal(cookieRes?.status, 200);

  // Bearer authentication
  const bearerReq = new Request("http://localhost/api/v1/moderation/proposals", {
    headers: { authorization: `Bearer ${token}` },
  });
  const bearerRes = await handler(bearerReq);
  assert.equal(bearerRes?.status, 200);

  // Invalid token
  const invalidReq = new Request("http://localhost/api/v1/moderation/proposals", {
    headers: { authorization: `Bearer ${"b".repeat(48)}` },
  });
  const invalidRes = await handler(invalidReq);
  assert.equal(invalidRes?.status, 401);
});

// ============================================================================
// CSRF Validation Tests
// ============================================================================

test("POST publication requires valid CSRF token", async () => {
  const publisherCalls: unknown[] = [];
  const handler = createModerationApiHandler({
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

test("POST publish handles publisher conflict outcome (409)", async () => {
  const handler = createModerationApiHandler({
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
