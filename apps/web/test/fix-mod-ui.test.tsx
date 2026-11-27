import assert from "node:assert/strict";
import test from "node:test";
import * as React from "react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

if (!("React" in globalThis)) {
  Object.defineProperty(globalThis, "React", { value: React, configurable: true, writable: true });
}
import {
  categoryChoiceOptions,
  categoryRefusalMessage,
  hasCategoryMismatch,
  ModerationActionError,
  ModeratorReviewQueue,
  planCategoryPublish,
  publishModerationDecision,
  type CategoryResolutionFields,
  type EventProposalDto,
  type ModeratorDecisionCommand,
} from "../src/ModeratorReview.js";

// FIX-MOD-UI: the review screen sends a triage/interpreter choice only for a proposal the worker flagged as mismatched.

const baseClaim = {
  claim_id: "claim-001",
  claim_text: "Banjir setinggi 40 cm merendam ruas jalan tol.",
  evidence_label: "under_review" as const,
  support_assessment: "supported" as const,
  quote_text: "banjir setinggi 40 cm merendam ruas jalan tol",
  evidence_ref_id: "chunk-0",
};

const plainProposal: EventProposalDto = {
  schema_version: "2.0",
  proposal_id: "proposal-plain-001",
  title: "Banjir di Kampung Melayu Jakarta Timur",
  incident_type: "flood",
  primary_category: "disasters_weather",
  severity: "high",
  event_time: { precision: "exact", value: "2026-11-20T07:00:00.000Z" },
  location_label: "Kampung Melayu, Jakarta Timur",
  coordinates: null,
  claims: [baseClaim],
  caveats: [],
  proposed_at: "2026-11-20T07:15:00.000Z",
};

const mismatchProposal: EventProposalDto = {
  ...plainProposal,
  proposal_id: "proposal-mismatch-001",
  title: "Banjir menutup ruas jalan tol di Jakarta Timur",
  primary_category: "disasters_weather",
  interpretation_category: "transport_road_incidents",
  compatibility_category: "flood",
  caveats: ["category_mismatch_review"],
};

const noInterpreterProposal: EventProposalDto = {
  ...mismatchProposal,
  proposal_id: "proposal-mismatch-002",
  interpretation_category: null,
};

/** The fields a choice contributes. Throws when the plan blocks, so a test fails on the wrong branch. */
function okFields(plan: ReturnType<typeof planCategoryPublish>): CategoryResolutionFields {
  if (!plan.ok) throw new Error(`publish was blocked: ${plan.hint}`);
  return plan.fields;
}

/** Sends a publish command through the real client and returns the JSON body the worker would receive. */
async function publishedBody(proposalId: string, command: ModeratorDecisionCommand): Promise<Record<string, unknown>> {
  let sent = "";
  const fetcher: typeof fetch = async (_input, init) => {
    sent = String(init?.body);
    return new Response(JSON.stringify({ ok: true, status: "written" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  await publishModerationDecision(proposalId, command, { fetcher, csrfToken: "mock-csrf-token-12345678" });
  return JSON.parse(sent) as Record<string, unknown>;
}

/** The moderator's publish command, built the way the review screen builds it. */
function publishCommand(
  proposal: EventProposalDto,
  choice: Parameters<typeof planCategoryPublish>[1],
): ModeratorDecisionCommand {
  const plan = planCategoryPublish(proposal, choice);
  return {
    proposal_id: proposal.proposal_id,
    action: "publish",
    evidence_label: "attributed_report",
    ...(plan.ok ? plan.fields : {}),
  };
}

function confirmButtonTag(html: string): string {
  const tag = html.match(/<button[^>]*data-action="modal-confirm"[^>]*>/);
  assert.ok(tag, "the approval modal renders its confirm button");
  return tag[0];
}

/** The whole radio input for one category option, so its checked state can be read from the tag. */
function categoryRadioTag(html: string, choice: string): string {
  const tag = html.match(new RegExp(`<input[^>]*name="category_resolution"[^>]*value="${choice}"[^>]*>`));
  assert.ok(tag, `the ${choice} option renders`);
  return tag[0];
}

test("a proposal without the mismatch caveat sends neither category field", async () => {
  assert.equal(hasCategoryMismatch(plainProposal), false);
  assert.deepEqual(planCategoryPublish(plainProposal, null), { ok: true, fields: {} });
  // A stray choice on an unflagged proposal still adds nothing.
  assert.deepEqual(planCategoryPublish(plainProposal, "accept_triage"), { ok: true, fields: {} });

  const body = await publishedBody(plainProposal.proposal_id, publishCommand(plainProposal, null));
  assert.equal(body.action, "publish");
  assert.equal("category_resolution" in body, false);
  assert.equal("resolved_category" in body, false);
});

test("a triage/interpreter mismatch blocks publish until the moderator chooses a category", () => {
  assert.equal(hasCategoryMismatch(mismatchProposal), true);
  const plan = planCategoryPublish(mismatchProposal, null);
  assert.equal(plan.ok, false);
  if (plan.ok) return;
  assert.match(plan.hint, /Pilih salah satu kategori/);
});

test("accept_triage sends primary_category, the triage candidate, as the resolution", async () => {
  const plan = planCategoryPublish(mismatchProposal, "accept_triage");
  assert.deepEqual(okFields(plan), {
    category_resolution: "accept_triage",
    resolved_category: "disasters_weather",
  });

  const body = await publishedBody(mismatchProposal.proposal_id, publishCommand(mismatchProposal, "accept_triage"));
  assert.equal(body.category_resolution, "accept_triage");
  assert.equal(body.resolved_category, "disasters_weather");
});

test("accept_interpretation sends interpretation_category, the interpreter candidate, as the resolution", async () => {
  const plan = planCategoryPublish(mismatchProposal, "accept_interpretation");
  assert.deepEqual(okFields(plan), {
    category_resolution: "accept_interpretation",
    resolved_category: "transport_road_incidents",
  });

  const body = await publishedBody(
    mismatchProposal.proposal_id,
    publishCommand(mismatchProposal, "accept_interpretation"),
  );
  assert.equal(body.category_resolution, "accept_interpretation");
  assert.equal(body.resolved_category, "transport_road_incidents");
});

test("compatibility_category is never offered as a candidate", () => {
  const options = categoryChoiceOptions(mismatchProposal);
  assert.deepEqual(
    options.map((option) => option.category),
    ["disasters_weather", "transport_road_incidents"],
  );
  assert.equal(options.some((option) => option.category === "flood"), false);
});

test("the category options carry Indonesian labels and the source hint for each candidate", () => {
  const options = categoryChoiceOptions(mismatchProposal);
  assert.deepEqual(
    options.map((option) => [option.choice, option.label, option.hint]),
    [
      ["accept_triage", "Bencana", "dari penyaring awal"],
      ["accept_interpretation", "Transportasi", "dari interpretasi agen"],
    ],
  );
});

test("a choice whose candidate the proposal does not record cannot publish", () => {
  const options = categoryChoiceOptions(noInterpreterProposal);
  assert.equal(options[1]?.category, null);
  assert.equal(options[1]?.label, "Tidak tercatat");

  const plan = planCategoryPublish(noInterpreterProposal, "accept_interpretation");
  assert.equal(plan.ok, false);
  if (plan.ok) return;
  assert.match(plan.hint, /tidak tercatat/);

  // The triage candidate is still recorded, so that choice stays available.
  assert.deepEqual(okFields(planCategoryPublish(noInterpreterProposal, "accept_triage")), {
    category_resolution: "accept_triage",
    resolved_category: "disasters_weather",
  });
});

test("the approval modal shows a required category group and a disabled confirm button until a choice is made", () => {
  const html = renderToStaticMarkup(
    createElement(ModeratorReviewQueue, {
      proposals: [mismatchProposal],
      initialModalOpen: true,
    }),
  );

  assert.match(html, /<legend class="modal-legend">Kategori berbeda — pilih kategori yang dipakai<\/legend>/);
  assert.match(html, /<strong>Bencana<\/strong><span>dari penyaring awal<\/span>/);
  assert.match(html, /<strong>Transportasi<\/strong><span>dari interpretasi agen<\/span>/);
  assert.match(categoryRadioTag(html, "accept_triage"), /type="radio"/);
  assert.match(categoryRadioTag(html, "accept_interpretation"), /type="radio"/);
  // No option is pre-selected.
  assert.doesNotMatch(categoryRadioTag(html, "accept_triage"), /checked/);
  assert.doesNotMatch(categoryRadioTag(html, "accept_interpretation"), /checked/);

  assert.match(confirmButtonTag(html), / disabled=""/);
  assert.match(html, /id="category-choice-hint"[^>]*>Pilih salah satu kategori di atas sebelum menerbitkan\.</);
});

test("the confirm button is enabled once a category is chosen, and the chosen option is checked", () => {
  const html = renderToStaticMarkup(
    createElement(ModeratorReviewQueue, {
      proposals: [mismatchProposal],
      initialModalOpen: true,
      initialCategoryChoice: "accept_interpretation",
    }),
  );

  assert.doesNotMatch(confirmButtonTag(html), / disabled=""/);
  assert.match(categoryRadioTag(html, "accept_interpretation"), / checked=""/);
  assert.doesNotMatch(categoryRadioTag(html, "accept_triage"), /checked/);
  assert.doesNotMatch(html, /id="category-choice-hint"/);
});

test("a proposal without the mismatch shows no category group and an enabled confirm button", () => {
  const html = renderToStaticMarkup(
    createElement(ModeratorReviewQueue, {
      proposals: [plainProposal],
      initialModalOpen: true,
    }),
  );

  assert.match(html, /Pilih Klasifikasi Label Bukti/);
  assert.doesNotMatch(html, /Kategori berbeda/);
  assert.doesNotMatch(html, /name="category_resolution"/);
  assert.doesNotMatch(confirmButtonTag(html), / disabled=""/);
});

test("a worker refusal of the category reads as Indonesian text, never as a raw code", () => {
  for (const code of [
    "CATEGORY_MISMATCH_UNRESOLVED",
    "CATEGORY_NOT_CANDIDATE",
    "category_not_candidate",
    "category_candidates_unrecorded",
  ]) {
    const message = categoryRefusalMessage(code);
    assert.ok(message, `${code} has a readable message`);
    assert.match(message, /kategori/i);
    assert.doesNotMatch(message, /_/);
    assert.doesNotMatch(message, /CATEGORY_/);
  }
  assert.equal(categoryRefusalMessage("publication_not_authorized"), null);
  assert.equal(categoryRefusalMessage(null), null);
});

test("a 409 route refusal keeps its code on the error so the screen can show readable text", async () => {
  const fetcher: typeof fetch = async () =>
    new Response(
      JSON.stringify({
        code: "CATEGORY_MISMATCH_UNRESOLVED",
        message: "Proposal proposal-mismatch-001 has an unresolved triage/interpreter category mismatch",
        request_id: "req-1",
      }),
      { status: 409, headers: { "content-type": "application/json" } },
    );

  await assert.rejects(
    () => publishModerationDecision(mismatchProposal.proposal_id, publishCommand(mismatchProposal, null), { fetcher }),
    (err: unknown) => {
      assert.ok(err instanceof ModerationActionError);
      assert.equal(err.status, 409);
      assert.equal(err.code, "CATEGORY_MISMATCH_UNRESOLVED");
      assert.match(categoryRefusalMessage(err.code) ?? "", /Pilih kategori yang dipakai/);
      return true;
    },
  );
});

test("a publish denial arrives in lower case and still maps to readable text", async () => {
  const fetcher: typeof fetch = async () =>
    new Response(
      JSON.stringify({ ok: false, status: "denied", code: "category_not_candidate", error: "category_not_candidate" }),
      { status: 400, headers: { "content-type": "application/json" } },
    );

  await assert.rejects(
    () =>
      publishModerationDecision(
        mismatchProposal.proposal_id,
        publishCommand(mismatchProposal, "accept_triage"),
        { fetcher },
      ),
    (err: unknown) => {
      assert.ok(err instanceof ModerationActionError);
      assert.equal(err.code, "category_not_candidate");
      assert.match(categoryRefusalMessage(err.code) ?? "", /tidak sesuai/);
      return true;
    },
  );
});
