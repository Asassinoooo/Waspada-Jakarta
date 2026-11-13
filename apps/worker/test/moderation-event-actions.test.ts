import assert from "node:assert/strict";
import test from "node:test";
import {
  createModerationApiHandler,
  type EventCorrectionCommand,
  type EventCorrectionResult,
  type EventWithdrawalCommand,
  type EventWithdrawalResult,
  type ModerationPrincipal,
} from "../src/layers/l4-application-integration/moderation-api.js";

/**
 * TG-FR12 (FR-12): withdrawal and correction of a published event are moderator actions. These tests
 * exercise the HTTP surface with injected dependencies: authentication, role, CSRF, body validation,
 * and the mapping from publication outcomes to status codes. The database effects are tested in
 * event-withdrawal-correction-db.test.ts.
 */

const APP_ORIGIN = "https://app.test";
const CSRF = "csrf-token-fixture";
const BASE = "https://app.test/api/v1/moderation/events/evt-banjir-kemang";

function principal(role: string, overrides: Partial<ModerationPrincipal> = {}): ModerationPrincipal {
  return { actorId: "acc-mod-1", role, active: true, csrfToken: CSRF, channel: "web", ...overrides };
}

function writeRequest(path: string, body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`${BASE}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: APP_ORIGIN,
      "x-csrf-token": CSRF,
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

const VALID_WITHDRAWAL = {
  reason: "Sumber asli menarik kembali laporan ini.",
  reason_category: "source_retracted",
};

const VALID_CORRECTION = {
  base_version: 2,
  title: "Banjir 50 cm di Kemang Raya",
  category: "disasters_weather",
  claims: [{ claim_id: "claim-1", claim_text: "Air merendam jalan setinggi 50 sentimeter" }],
};

function harness(options: {
  readonly role?: string;
  readonly withdrawal?: EventWithdrawalResult;
  readonly correction?: EventCorrectionResult;
  readonly withoutActions?: boolean;
  readonly anonymous?: boolean;
} = {}) {
  const withdrawCalls: { eventId: string; command: EventWithdrawalCommand; actorId: string }[] = [];
  const correctionCalls: { eventId: string; command: EventCorrectionCommand; actorId: string }[] = [];
  const handler = createModerationApiHandler({
    authenticate: async () => (options.anonymous ? null : principal(options.role ?? "moderator")),
    appOrigin: APP_ORIGIN,
    csrfProtection: true,
    datasetScope: "live",
    ...(options.withoutActions
      ? {}
      : {
        withdrawEvent: async (eventId, command, who) => {
          withdrawCalls.push({ eventId, command, actorId: who.actorId });
          return options.withdrawal ?? { status: "not_found" };
        },
        submitCorrection: async (eventId, command, who) => {
          correctionCalls.push({ eventId, command, actorId: who.actorId });
          return options.correction ?? { status: "not_found" };
        },
      }),
  });
  return { handler, withdrawCalls, correctionCalls };
}

async function errorOf(response: Response | undefined): Promise<{ code: string; reasons?: unknown }> {
  return (await response?.json()) as { code: string; reasons?: unknown };
}

// ----------------------------------------------------------------------------
// Withdrawal: POST /api/v1/moderation/events/:eventId/withdraw
// ----------------------------------------------------------------------------

test("withdraw: anonymous request is refused with 401 and nothing is withdrawn", async () => {
  const { handler, withdrawCalls } = harness({ anonymous: true });
  const response = await handler(writeRequest("/withdraw", VALID_WITHDRAWAL));
  assert.equal(response?.status, 401);
  assert.equal((await errorOf(response)).code, "UNAUTHORIZED");
  assert.equal(withdrawCalls.length, 0);
});

test("withdraw: a plain user session is refused with 403 (retract_information is moderator-only)", async () => {
  const { handler, withdrawCalls } = harness({ role: "user" });
  const response = await handler(writeRequest("/withdraw", VALID_WITHDRAWAL));
  assert.equal(response?.status, 403);
  assert.equal((await errorOf(response)).code, "FORBIDDEN");
  assert.equal(withdrawCalls.length, 0);
});

test("withdraw: a request without the exact Origin is refused before any write", async () => {
  const { handler, withdrawCalls } = harness();
  const response = await handler(writeRequest("/withdraw", VALID_WITHDRAWAL, { origin: "https://evil.test" }));
  assert.equal(response?.status, 403);
  assert.equal((await errorOf(response)).code, "CSRF_ORIGIN_MISMATCH");
  assert.equal(withdrawCalls.length, 0);
});

test("withdraw: a request without the X-CSRF-Token header is refused before any write", async () => {
  const { handler, withdrawCalls } = harness();
  const request = new Request(`${BASE}/withdraw`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: APP_ORIGIN },
    body: JSON.stringify(VALID_WITHDRAWAL),
  });
  const response = await handler(request);
  assert.equal(response?.status, 403);
  assert.equal((await errorOf(response)).code, "CSRF_TOKEN_INVALID");
  assert.equal(withdrawCalls.length, 0);
});

test("withdraw: a moderator with a valid request reaches the writer with the actor from the session", async () => {
  const { handler, withdrawCalls } = harness({
    withdrawal: {
      status: "withdrawn",
      event_id: "evt-banjir-kemang",
      version: 3,
      decision_id: "dec-1",
      withdrawn_at: "2026-11-13T10:00:00.000Z",
      withdrawal_reason: "source_retracted",
    },
  });
  const response = await handler(writeRequest("/withdraw", VALID_WITHDRAWAL));
  assert.equal(response?.status, 200);
  const body = (await response?.json()) as { ok: boolean; status: string; version: number; withdrawal_reason: string };
  assert.equal(body.ok, true);
  assert.equal(body.status, "withdrawn");
  assert.equal(body.version, 3);
  assert.equal(body.withdrawal_reason, "source_retracted");
  assert.deepEqual(withdrawCalls, [
    {
      eventId: "evt-banjir-kemang",
      command: { reason: VALID_WITHDRAWAL.reason, reason_category: "source_retracted" },
      actorId: "acc-mod-1",
    },
  ]);
});

test("withdraw: an admin session is allowed", async () => {
  const { handler, withdrawCalls } = harness({
    role: "admin",
    withdrawal: { status: "withdrawn", event_id: "evt-banjir-kemang", version: 3, decision_id: "dec-1", withdrawn_at: "2026-11-13T10:00:00.000Z", withdrawal_reason: "other" },
  });
  const response = await handler(writeRequest("/withdraw", { ...VALID_WITHDRAWAL, reason_category: "other" }));
  assert.equal(response?.status, 200);
  assert.equal(withdrawCalls.length, 1);
});

test("withdraw: a reason shorter than 10 characters is refused with 400 and no write", async () => {
  const { handler, withdrawCalls } = harness();
  const response = await handler(writeRequest("/withdraw", { ...VALID_WITHDRAWAL, reason: "pendek" }));
  assert.equal(response?.status, 400);
  assert.equal((await errorOf(response)).code, "INVALID_REASON");
  assert.equal(withdrawCalls.length, 0);
});

test("withdraw: a reason longer than 500 characters is refused with 400", async () => {
  const { handler, withdrawCalls } = harness();
  const response = await handler(writeRequest("/withdraw", { ...VALID_WITHDRAWAL, reason: "x".repeat(501) }));
  assert.equal(response?.status, 400);
  assert.equal((await errorOf(response)).code, "INVALID_REASON");
  assert.equal(withdrawCalls.length, 0);
});

test("withdraw: a reason category outside the contract vocabulary is refused with 400", async () => {
  const { handler, withdrawCalls } = harness();
  const response = await handler(writeRequest("/withdraw", { ...VALID_WITHDRAWAL, reason_category: "resolved" }));
  assert.equal(response?.status, 400);
  assert.equal((await errorOf(response)).code, "INVALID_REASON_CATEGORY");
  assert.equal(withdrawCalls.length, 0);
});

test("withdraw: a second withdrawal of the same event is refused with 409 ALREADY_WITHDRAWN", async () => {
  const { handler } = harness({ withdrawal: { status: "already_withdrawn", event_id: "evt-banjir-kemang", version: 3 } });
  const response = await handler(writeRequest("/withdraw", VALID_WITHDRAWAL));
  assert.equal(response?.status, 409);
  assert.equal((await errorOf(response)).code, "ALREADY_WITHDRAWN");
});

test("withdraw: an event with no published version is refused with 404", async () => {
  const { handler } = harness({ withdrawal: { status: "not_found" } });
  const response = await handler(writeRequest("/withdraw", VALID_WITHDRAWAL));
  assert.equal(response?.status, 404);
  assert.equal((await errorOf(response)).code, "EVENT_NOT_FOUND");
});

test("withdraw: GET is not allowed on the withdraw route", async () => {
  const { handler } = harness();
  const response = await handler(new Request(`${BASE}/withdraw`, { headers: { origin: APP_ORIGIN } }));
  assert.equal(response?.status, 405);
});

test("withdraw: without a configured writer the route answers 503, never a silent success", async () => {
  const { handler } = harness({ withoutActions: true });
  const response = await handler(writeRequest("/withdraw", VALID_WITHDRAWAL));
  assert.equal(response?.status, 503);
  assert.equal((await errorOf(response)).code, "WITHDRAWAL_UNAVAILABLE");
});

// ----------------------------------------------------------------------------
// Corrections: POST /api/v1/moderation/events/:eventId/corrections
// ----------------------------------------------------------------------------

test("correction: a plain user session is refused with 403", async () => {
  const { handler, correctionCalls } = harness({ role: "user" });
  const response = await handler(writeRequest("/corrections", VALID_CORRECTION));
  assert.equal(response?.status, 403);
  assert.equal(correctionCalls.length, 0);
});

test("correction: a request without the CSRF token is refused before any write", async () => {
  const { handler, correctionCalls } = harness();
  const request = new Request(`${BASE}/corrections`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: APP_ORIGIN },
    body: JSON.stringify(VALID_CORRECTION),
  });
  const response = await handler(request);
  assert.equal(response?.status, 403);
  assert.equal((await errorOf(response)).code, "CSRF_TOKEN_INVALID");
  assert.equal(correctionCalls.length, 0);
});

test("correction: a valid correction reaches the writer with the normalized command", async () => {
  const { handler, correctionCalls } = harness({
    correction: { status: "published", event_id: "evt-banjir-kemang", version: 3, proposal_id: "corr-1", decision_id: "dec-2" },
  });
  const response = await handler(writeRequest("/corrections", VALID_CORRECTION));
  assert.equal(response?.status, 200);
  const body = (await response?.json()) as { ok: boolean; status: string; version: number };
  assert.equal(body.status, "published");
  assert.equal(body.version, 3);
  assert.equal(correctionCalls.length, 1);
  assert.equal(correctionCalls[0]?.actorId, "acc-mod-1");
  assert.equal(correctionCalls[0]?.command.base_version, 2);
  assert.equal(correctionCalls[0]?.command.title, VALID_CORRECTION.title);
  assert.deepEqual(correctionCalls[0]?.command.claims, VALID_CORRECTION.claims);
});

test("correction: identical facts answer 200 unchanged, with no new version", async () => {
  const { handler } = harness({
    correction: { status: "unchanged", event_id: "evt-banjir-kemang", version: 2, proposal_id: "corr-2", decision_id: "dec-3" },
  });
  const response = await handler(writeRequest("/corrections", VALID_CORRECTION));
  assert.equal(response?.status, 200);
  assert.equal(((await response?.json()) as { status: string }).status, "unchanged");
});

test("correction: a gate refusal answers 422 with the gate reasons and publishes nothing", async () => {
  const { handler } = harness({
    correction: { status: "refused", code: "publication_not_authorized", reasons: ["time_missing"] },
  });
  const response = await handler(writeRequest("/corrections", VALID_CORRECTION));
  assert.equal(response?.status, 422);
  const body = await errorOf(response);
  assert.equal(body.code, "CORRECTION_NOT_PUBLISHABLE");
  assert.deepEqual(body.reasons, ["time_missing"]);
});

test("correction: a base version that is no longer current answers 409 STALE_BASE_VERSION", async () => {
  const { handler } = harness({
    correction: { status: "refused", code: "stale_base_version", reasons: [] },
  });
  const response = await handler(writeRequest("/corrections", VALID_CORRECTION));
  assert.equal(response?.status, 409);
  assert.equal((await errorOf(response)).code, "STALE_BASE_VERSION");
});

test("correction: a withdrawn event cannot be corrected and answers 409 EVENT_WITHDRAWN", async () => {
  const { handler } = harness({
    correction: { status: "refused", code: "event_withdrawn", reasons: [] },
  });
  const response = await handler(writeRequest("/corrections", VALID_CORRECTION));
  assert.equal(response?.status, 409);
  assert.equal((await errorOf(response)).code, "EVENT_WITHDRAWN");
});

test("correction: an unknown event answers 404", async () => {
  const { handler } = harness({ correction: { status: "not_found" } });
  const response = await handler(writeRequest("/corrections", VALID_CORRECTION));
  assert.equal(response?.status, 404);
});

test("correction: a missing or non-integer base_version is refused with 400 and no write", async () => {
  const { handler, correctionCalls } = harness();
  const missing = await handler(writeRequest("/corrections", { ...VALID_CORRECTION, base_version: undefined }));
  assert.equal(missing?.status, 400);
  const fractional = await handler(writeRequest("/corrections", { ...VALID_CORRECTION, base_version: 1.5 }));
  assert.equal(fractional?.status, 400);
  assert.equal(correctionCalls.length, 0);
});

test("correction: an event_time without a parseable value is refused with 400", async () => {
  const { handler, correctionCalls } = harness();
  const response = await handler(writeRequest("/corrections", {
    ...VALID_CORRECTION,
    event_time: { precision: "exact", value: "bukan tanggal" },
  }));
  assert.equal(response?.status, 400);
  assert.equal((await errorOf(response)).code, "INVALID_EVENT_TIME");
  assert.equal(correctionCalls.length, 0);
});

test("correction: claim text edits must carry a claim_id and text, or are refused with 400", async () => {
  const { handler, correctionCalls } = harness();
  const response = await handler(writeRequest("/corrections", {
    ...VALID_CORRECTION,
    claims: [{ claim_text: "tanpa id" }],
  }));
  assert.equal(response?.status, 400);
  assert.equal((await errorOf(response)).code, "INVALID_CLAIMS");
  assert.equal(correctionCalls.length, 0);
});

test("correction: a title outside 3 to 240 characters is refused with 400", async () => {
  const { handler, correctionCalls } = harness();
  const response = await handler(writeRequest("/corrections", { ...VALID_CORRECTION, title: "ab" }));
  assert.equal(response?.status, 400);
  assert.equal((await errorOf(response)).code, "INVALID_TITLE");
  assert.equal(correctionCalls.length, 0);
});

test("correction: a category outside the official slugs is refused with 400", async () => {
  const { handler, correctionCalls } = harness();
  const response = await handler(writeRequest("/corrections", { ...VALID_CORRECTION, category: "banjir" }));
  assert.equal(response?.status, 400);
  assert.equal((await errorOf(response)).code, "INVALID_CATEGORY");
  assert.equal(correctionCalls.length, 0);
});

test("correction: GET is not allowed on the corrections route", async () => {
  const { handler } = harness();
  const response = await handler(new Request(`${BASE}/corrections`, { headers: { origin: APP_ORIGIN } }));
  assert.equal(response?.status, 405);
});
