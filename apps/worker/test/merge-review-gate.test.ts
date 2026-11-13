import assert from "node:assert/strict";
import test from "node:test";
import { createModerationApiHandler } from "../src/layers/l4-application-integration/moderation-api.js";
import {
  assessAutoPublication,
  assessProposalSourceGate,
  evaluateAutoPublication,
  parseAutoPublishSourcePermission,
  SOURCE_PERMISSION_WAIVED_LOCAL,
} from "../src/layers/l4-application-integration/publication-policy.js";

/** MERGE-REVIEW-01 (ADR-061): deterministic gate and the moderation reject rule. No database. */

const PERMITTED = { publicDisplaySourceIds: new Set(["source-detik", "source-antara"]) };

function clean(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: "2.0",
    proposal_id: "prop-gate-1",
    incident_id: "inc-gate-1",
    title: "Banjir di Cawang",
    incident_type: "genangan_air_luapan_saluran",
    primary_category: "disasters_weather",
    severity: "medium",
    event_time: { precision: "exact", value: "2026-11-10T08:00:00.000Z" },
    location_label: "Cawang, Jakarta Timur",
    coordinates: null,
    claims: [
      {
        claim_id: "claim-1",
        claim_text: "Genangan 50 cm di Cawang",
        evidence_label: "attributed_report",
        support_assessment: "supported",
        quote_text: "Genangan setinggi 50 cm",
        evidence_ref_id: "chk-1",
        source_id: "source-detik",
        outlet: "Detik News",
        source_url: "https://news.example/cawang",
      },
    ],
    impacts: [],
    caveats: [],
    has_discrepancy: false,
    discrepancy_summary: null,
    discrepancies: [],
    correlation_relationship: "primary_initial",
    is_multi_source: false,
    source_count: 1,
    source_id: "source-detik",
    proposed_at: "2026-11-10T08:05:00.000Z",
    ...overrides,
  };
}

function withClaims(claims: Record<string, unknown>[]): Record<string, unknown> {
  return clean({ claims });
}

test("auto gate passes a clean single-publisher proposal", () => {
  assert.deepEqual(assessAutoPublication(clean(), PERMITTED), []);
});

test("auto gate passes a merge without discrepancy across two attributed publishers", () => {
  const merged = withClaims([
    (clean().claims as Record<string, unknown>[])[0]!,
    {
      claim_id: "claim-2",
      claim_text: "Banjir merendam Jalan DI Panjaitan",
      evidence_label: "attributed_report",
      support_assessment: "supported",
      quote_text: "Banjir merendam",
      evidence_ref_id: "chk-2",
      source_id: "source-antara",
      outlet: "Antara News",
      source_url: "https://news.example/antara",
    },
  ]);
  assert.deepEqual(assessAutoPublication({ ...merged, source_count: 2, is_multi_source: true }, PERMITTED), []);
});

test("auto gate queues a flagged discrepancy", () => {
  const flagged = clean({
    has_discrepancy: true,
    discrepancy_summary: "Laporan rev-a menyebut 50 cm, laporan rev-b menyebut 30 cm.",
    discrepancies: [{ kind: "water_height", description: "50 cm vs 30 cm" }],
  });
  assert.ok(assessAutoPublication(flagged, PERMITTED).includes("discrepancy_flagged"));
});

test("auto gate queues a proposal whose discrepancy status is unknown", () => {
  const legacy = clean();
  delete (legacy as Record<string, unknown>).has_discrepancy;
  assert.ok(assessAutoPublication(legacy, PERMITTED).includes("discrepancy_status_unknown"));
});

test("auto gate never accepts independent_corroboration as an automatic label", () => {
  const corroborated = withClaims([
    { ...(clean().claims as Record<string, unknown>[])[0], evidence_label: "independent_corroboration" },
  ]);
  assert.ok(assessAutoPublication(corroborated, PERMITTED).includes("claim_label_not_allowed"));
});

test("auto gate queues a claim without a source link", () => {
  const unlinked = withClaims([{ ...(clean().claims as Record<string, unknown>[])[0], source_url: null }]);
  assert.ok(assessAutoPublication(unlinked, PERMITTED).includes("claim_source_link_missing"));
});

test("auto gate queues a claim whose source lacks public-display permission", () => {
  const unpermitted = withClaims([{ ...(clean().claims as Record<string, unknown>[])[0], source_id: "source-bmkg-unlicensed" }]);
  assert.ok(assessAutoPublication(unpermitted, PERMITTED).includes("source_rights_missing"));
});

test("auto gate queues missing location or time, and an unresolved correlation", () => {
  const noPlace = clean({ location_label: null, coordinates: null });
  assert.ok(assessAutoPublication(noPlace, PERMITTED).includes("location_missing"));

  const noTime = clean({ event_time: { precision: "unknown", value: null } });
  assert.ok(assessAutoPublication(noTime, PERMITTED).includes("time_missing"));

  const unresolved = clean({ correlation_relationship: "unresolved" });
  assert.ok(assessAutoPublication(unresolved, PERMITTED).includes("correlation_unresolved"));
});

test("auto gate fails closed on an unsupported claim or an unknown category", () => {
  const uncertain = withClaims([{ ...(clean().claims as Record<string, unknown>[])[0], support_assessment: "uncertain" }]);
  assert.ok(assessAutoPublication(uncertain, PERMITTED).includes("claim_unsupported"));

  const badCategory = clean({ primary_category: "not_a_category" });
  assert.ok(assessProposalSourceGate(badCategory, PERMITTED).includes("schema_invalid"));
});

test("moderator source gate ignores a discrepancy, but still requires source links and rights", () => {
  const discrepant = clean({ has_discrepancy: true, discrepancy_summary: "Ada perbedaan." });
  assert.deepEqual(assessProposalSourceGate(discrepant, PERMITTED), []);

  const unlinked = withClaims([{ ...(clean().claims as Record<string, unknown>[])[0], source_url: null }]);
  assert.ok(assessProposalSourceGate(unlinked, PERMITTED).includes("claim_source_link_missing"));
});

/* ADR-061 amendment: local live mode may waive only the public-display permission check. */

const UNPERMITTED = withClaims([{ ...(clean().claims as Record<string, unknown>[])[0], source_id: "source-bmkg-unlicensed" }]);

test("source permission parser fails closed: only the exact value local_relaxed relaxes the check", () => {
  for (const value of [undefined, null, "", "required", "LOCAL_RELAXED", "local-relaxed", "yes", " local_relaxed"]) {
    assert.equal(parseAutoPublishSourcePermission(value), "required", `value ${JSON.stringify(value)} must mean required`);
  }
  assert.equal(parseAutoPublishSourcePermission("local_relaxed"), "local_relaxed");
});

test("auto gate without a sourcePermission keeps the permission check and records no waiver", () => {
  const assessment = evaluateAutoPublication(UNPERMITTED, PERMITTED);
  assert.ok(assessment.reasons.includes("source_rights_missing"));
  assert.deepEqual(assessment.waivers, []);
});

test("local_relaxed passes an unpermitted source, and records the waiver", () => {
  const assessment = evaluateAutoPublication(UNPERMITTED, {
    ...PERMITTED,
    sourcePermission: parseAutoPublishSourcePermission("local_relaxed"),
  });
  assert.deepEqual(assessment.reasons, []);
  assert.deepEqual(assessment.waivers, [SOURCE_PERMISSION_WAIVED_LOCAL]);
});

test("local_relaxed records no waiver when every source already has permission", () => {
  const assessment = evaluateAutoPublication(clean(), { ...PERMITTED, sourcePermission: "local_relaxed" });
  assert.deepEqual(assessment.reasons, []);
  assert.deepEqual(assessment.waivers, [], "nothing was skipped, so nothing is recorded");
});

test("local_relaxed still queues a flagged discrepancy", () => {
  const flagged = { ...UNPERMITTED, has_discrepancy: true, discrepancy_summary: "Ada perbedaan.", discrepancies: [{ kind: "water_height" }] };
  const assessment = evaluateAutoPublication(flagged, { ...PERMITTED, sourcePermission: "local_relaxed" });
  assert.ok(assessment.reasons.includes("discrepancy_flagged"));
});

test("local_relaxed still queues a claim without a source link", () => {
  const unlinked = withClaims([{
    ...(UNPERMITTED.claims as Record<string, unknown>[])[0],
    source_url: null,
  }]);
  const assessment = evaluateAutoPublication(unlinked, { ...PERMITTED, sourcePermission: "local_relaxed" });
  assert.ok(assessment.reasons.includes("claim_source_link_missing"));
});

test("local_relaxed does not reach the moderator source gate", () => {
  assert.ok(assessProposalSourceGate(UNPERMITTED, PERMITTED).includes("source_rights_missing"));
});

/* F-04 (ADR-061 amendment): a proposal linked to a stopped_for_review investigation is refused on both paths. */

const STOPPED = { ...PERMITTED, linkedInvestigationStatus: "stopped_for_review" as const };

test("F-04: a proposal linked to a stopped_for_review investigation is queued by the auto gate", () => {
  assert.deepEqual(evaluateAutoPublication(clean(), STOPPED).reasons, ["investigation_stopped_for_review"]);
});

test("F-04: the moderator source gate refuses the same proposal", () => {
  assert.deepEqual(assessProposalSourceGate(clean(), STOPPED), ["investigation_stopped_for_review"]);
});

test("F-04: local_relaxed waives the permission check only, never a stopped investigation", () => {
  const assessment = evaluateAutoPublication(UNPERMITTED, { ...STOPPED, sourcePermission: "local_relaxed" });
  assert.deepEqual(assessment.reasons, ["investigation_stopped_for_review"]);
  assert.deepEqual(assessment.waivers, [SOURCE_PERMISSION_WAIVED_LOCAL]);
});

test("F-04 control: a completed, open or paused investigation, or no investigation link, leaves the gate unchanged", () => {
  for (const status of [undefined, null, "open", "paused", "completed"] as const) {
    assert.deepEqual(
      evaluateAutoPublication(clean(), { ...PERMITTED, linkedInvestigationStatus: status }).reasons,
      [],
      `status ${String(status)} must not add a reason`,
    );
  }
});

function moderationHandler(extra: Record<string, unknown> = {}) {
  const published: unknown[] = [];
  const rejected: string[] = [];
  const handler = createModerationApiHandler({
    datasetScope: "live",
    principal: { actorId: "mod-1", role: "moderator", active: true, csrfToken: "csrf-reject" },
    getProposalDetail: async () => ({ proposal: clean() as never, chunks: [] }),
    publicationService: {
      publish: async (input: unknown) => {
        published.push(input);
        return { status: "written" };
      },
    },
    ...extra,
  } as never);
  const post = (proposalId: string, body: unknown) =>
    handler(
      new Request(`http://localhost/api/v1/moderation/proposals/${proposalId}/publish`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-csrf-token": "csrf-reject" },
        body: JSON.stringify(body),
      }),
    );
  return { post, published, rejected };
}

test("moderation reject never publishes and is recorded through the reject writer", async () => {
  const rejectedIds: string[] = [];
  const { post, published } = moderationHandler({
    rejectProposal: async (proposalId: string) => {
      rejectedIds.push(proposalId);
      return { status: "rejected" };
    },
  });
  const response = await post("prop-gate-1", { action: "reject", reason: "bukan insiden" });
  assert.equal(response?.status, 200);
  assert.equal(published.length, 0, "reject must not reach the publisher");
  assert.deepEqual(rejectedIds, ["prop-gate-1"]);
});

test("moderation reject is refused with 503 when no rejection writer is wired, and still never publishes", async () => {
  const { post, published } = moderationHandler();
  const response = await post("prop-gate-1", { action: "reject" });
  assert.equal(response?.status, 503);
  assert.equal(published.length, 0);
});

test("moderation refuses any action other than publish or reject", async () => {
  const { post, published } = moderationHandler();
  const response = await post("prop-gate-1", { action: "investigate" });
  assert.equal(response?.status, 400);
  assert.equal(published.length, 0, "investigate must not publish");
});
