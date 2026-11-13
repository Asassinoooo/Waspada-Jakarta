import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  ModerationActionError,
  PublishedEventModeration,
  WITHDRAWAL_REASON_OPTIONS,
  gateReasonLabel,
  submitEventCorrection,
  withdrawPublishedEvent,
  withdrawalReasonError,
} from "../src/PublishedEventModeration.js";

/**
 * TG-FR12 (FR-12): moderator controls for a published event. The controls send the same
 * CSRF-protected POST as the other moderation actions, and show gate refusals in plain Bahasa
 * Indonesia. The client functions are tested with an injected fetcher, so no network is used.
 */

function recordingFetcher(status: number, body: unknown) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { fetcher, calls };
}

test("withdrawal reason categories are exactly the contract vocabulary, each with an Indonesian label", () => {
  assert.deepEqual(
    WITHDRAWAL_REASON_OPTIONS.map((option) => option.value),
    ["source_retracted", "evidence_ineligible", "incorrect_event_match", "privacy_removal", "duplicate", "other"],
  );
  for (const option of WITHDRAWAL_REASON_OPTIONS) {
    assert.ok(option.label.length > 0);
  }
});

test("withdrawal reason text is checked on the client: 10 to 500 characters", () => {
  assert.notEqual(withdrawalReasonError("pendek"), null);
  assert.equal(withdrawalReasonError("Sumber asli menarik laporan."), null);
  assert.notEqual(withdrawalReasonError("x".repeat(501)), null);
});

test("every gate reason the server can return has a readable Indonesian message", () => {
  const reasons = [
    "schema_invalid", "claims_missing", "claim_unsupported", "claim_quote_missing", "claim_source_link_missing",
    "source_rights_missing", "time_missing", "investigation_stopped_for_review", "publication_not_authorized",
  ];
  for (const reason of reasons) {
    const label = gateReasonLabel(reason);
    assert.ok(label.length > 0);
    assert.notEqual(label, reason, `${reason} must not be shown as a raw code`);
  }
  assert.match(gateReasonLabel("time_missing"), /waktu/i);
});

test("withdrawPublishedEvent posts to the withdraw route with the CSRF header and the reason body", async () => {
  const { fetcher, calls } = recordingFetcher(200, { ok: true, status: "withdrawn", version: 2 });
  const result = await withdrawPublishedEvent(
    "evt-banjir-kemang",
    { reason: "Sumber asli menarik laporan.", reason_category: "source_retracted" },
    { fetcher, csrfToken: "csrf-fixture" },
  );
  assert.equal(result.status, "withdrawn");
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, "/api/v1/moderation/events/evt-banjir-kemang/withdraw");
  assert.equal(calls[0]?.init.method, "POST");
  const headers = calls[0]?.init.headers as Record<string, string>;
  assert.equal(headers["X-CSRF-Token"], "csrf-fixture");
  assert.equal(calls[0]?.init.credentials, "same-origin");
  assert.deepEqual(JSON.parse(String(calls[0]?.init.body)), {
    reason: "Sumber asli menarik laporan.",
    reason_category: "source_retracted",
  });
});

test("withdrawPublishedEvent surfaces a second withdrawal as ALREADY_WITHDRAWN with its HTTP status", async () => {
  const { fetcher } = recordingFetcher(409, { code: "ALREADY_WITHDRAWN", message: "sudah ditarik" });
  await assert.rejects(
    () => withdrawPublishedEvent("evt-1", { reason: "Alasan yang cukup panjang.", reason_category: "other" }, { fetcher, csrfToken: "t" }),
    (error: unknown) => error instanceof ModerationActionError && error.status === 409 && error.code === "ALREADY_WITHDRAWN",
  );
});

test("submitEventCorrection posts to the corrections route and returns the published version", async () => {
  const { fetcher, calls } = recordingFetcher(200, { ok: true, status: "published", version: 3 });
  const result = await submitEventCorrection(
    "evt-banjir-kemang",
    { base_version: 2, title: "Banjir 50 cm di Kemang Raya", claims: [{ claim_id: "claim-1", claim_text: "Air setinggi 50 cm" }] },
    { fetcher, csrfToken: "csrf-fixture" },
  );
  assert.equal(result.status, "published");
  assert.equal(calls[0]?.url, "/api/v1/moderation/events/evt-banjir-kemang/corrections");
  assert.equal((calls[0]?.init.headers as Record<string, string>)["X-CSRF-Token"], "csrf-fixture");
});

test("submitEventCorrection keeps the gate reasons from a 422 refusal so the form can explain them", async () => {
  const { fetcher } = recordingFetcher(422, { code: "CORRECTION_NOT_PUBLISHABLE", reasons: ["time_missing", "claim_unsupported"] });
  await assert.rejects(
    () => submitEventCorrection("evt-1", { base_version: 1, title: "Judul baru" }, { fetcher, csrfToken: "t" }),
    (error: unknown) => {
      if (!(error instanceof ModerationActionError)) return false;
      return error.status === 422 && error.code === "CORRECTION_NOT_PUBLISHABLE"
        && JSON.stringify(error.reasons) === JSON.stringify(["time_missing", "claim_unsupported"]);
    },
  );
});

test("the published-event controls render a withdraw and a correction action for each event, with no raw codes", () => {
  const html = renderToStaticMarkup(createElement(PublishedEventModeration, {
    events: [{
      event_id: "evt-banjir-kemang",
      version: 2,
      title: "Banjir 50 cm di Kemang Raya",
      category: "disasters_weather",
      claims: [{ claim_id: "claim-1", text: "Air merendam jalan setinggi 50 sentimeter" }],
    }],
    csrfToken: "csrf-fixture",
  } as never));
  assert.match(html, /Tarik peristiwa/);
  assert.match(html, /Ajukan koreksi/);
  assert.match(html, /Banjir 50 cm di Kemang Raya/);
  assert.doesNotMatch(html, /alert\(|javascript:/);
});
