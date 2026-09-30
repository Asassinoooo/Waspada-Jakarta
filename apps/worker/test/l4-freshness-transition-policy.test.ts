import assert from "node:assert/strict";
import test from "node:test";
import {
  evaluateFreshnessTransition,
  FreshnessTransitionPolicyError,
  type FreshnessTransitionInput,
} from "../src/layers/l4-application-integration/freshness-transition-policy.js";

const baseInput: FreshnessTransitionInput = {
  previousStatus: "current",
  validUntil: null,
  reviewDueAt: "2026-09-30T11:00:00Z",
  now: "2026-09-30T10:00:00Z",
  newApplicableEvidenceEvaluated: false,
};

function evaluate(overrides: Partial<FreshnessTransitionInput> = {}) {
  return evaluateFreshnessTransition({ ...baseInput, ...overrides });
}

test("review deadline equality becomes needs_update and the immediately-before instant stays current", () => {
  assert.deepEqual(
    evaluate({ now: "2026-09-30T10:59:59.999999Z" }),
    { status: "current", reason: "current_state_retained" },
  );
  assert.deepEqual(
    evaluate({ now: "2026-09-30T18:00:00+07:00" }),
    { status: "needs_update", reason: "review_deadline_missed" },
  );
  assert.deepEqual(
    evaluate({
      now: "2026-09-30T11:00:00.000001Z",
      reviewDueAt: "2026-09-30T11:00:00.000000Z",
    }),
    { status: "needs_update", reason: "review_deadline_missed" },
  );
});

test("issuer validity expires at equality and takes precedence over a due deadline and new evidence", () => {
  assert.deepEqual(
    evaluate({
      validUntil: "2026-09-30T11:00:00Z",
      reviewDueAt: "2026-09-30T10:00:00Z",
      now: "2026-09-30T10:59:59.999999Z",
      newApplicableEvidenceEvaluated: true,
    }),
    { status: "current", reason: "new_applicable_evidence_evaluated" },
  );
  assert.deepEqual(
    evaluate({
      validUntil: "2026-09-30T11:00:00Z",
      reviewDueAt: "2026-09-30T10:00:00Z",
      now: "2026-09-30T18:00:00+07:00",
      newApplicableEvidenceEvaluated: true,
    }),
    { status: "expired", reason: "issuer_validity_ended" },
  );
});

test("needs_update and expired remain sticky without a new Layer 4 evidence evaluation", () => {
  assert.deepEqual(
    evaluate({ previousStatus: "needs_update", reviewDueAt: null }),
    { status: "needs_update", reason: "stale_state_retained" },
  );
  assert.deepEqual(
    evaluate({
      previousStatus: "expired",
      validUntil: null,
      reviewDueAt: null,
    }),
    { status: "expired", reason: "stale_state_retained" },
  );
  assert.deepEqual(
    evaluate({
      previousStatus: "needs_update",
      reviewDueAt: "2026-09-30T09:00:00Z",
    }),
    { status: "needs_update", reason: "stale_state_retained" },
  );
});

test("new applicable evidence evaluated by Layer 4 can restore stale states while issuer validity remains in force", () => {
  assert.deepEqual(
    evaluate({
      previousStatus: "needs_update",
      validUntil: "2026-10-01T00:00:00Z",
      reviewDueAt: "2026-10-01T00:00:00Z",
      newApplicableEvidenceEvaluated: true,
    }),
    { status: "current", reason: "new_applicable_evidence_evaluated" },
  );
  assert.deepEqual(
    evaluate({
      previousStatus: "expired",
      validUntil: null,
      reviewDueAt: null,
      newApplicableEvidenceEvaluated: true,
    }),
    { status: "current", reason: "new_applicable_evidence_evaluated" },
  );
});

test("invalid timestamps and malformed policy inputs fail with one stable non-echoing error", () => {
  const invalidInputs: unknown[] = [
    { ...baseInput, now: "2026-09-30T11:00:00" },
    { ...baseInput, now: "2026-02-30T11:00:00Z" },
    { ...baseInput, now: "2026-09-30T11:00:60Z" },
    { ...baseInput, now: "2026-09-30T11:00:00+24:00" },
    { ...baseInput, reviewDueAt: 42 },
    { ...baseInput, previousStatus: "resolved" },
    { ...baseInput, newApplicableEvidenceEvaluated: "yes" },
    { ...baseInput, privateMarker: "must not be echoed" },
    null,
  ];

  for (const input of invalidInputs) {
    assert.throws(
      () => evaluateFreshnessTransition(input as FreshnessTransitionInput),
      (error: unknown) => {
        assert.ok(error instanceof FreshnessTransitionPolicyError);
        assert.equal(error.code, "INVALID_INPUT");
        assert.equal(error.message, "Invalid freshness transition input.");
        assert.equal(error.message.includes("must not be echoed"), false);
        return true;
      },
    );
  }
});

test("the policy returns only freshness and reason without mutating a record or changing lifecycle/publication fields", () => {
  const input = Object.freeze({ ...baseInput });
  const serializedInput = JSON.stringify(input);
  const result = evaluateFreshnessTransition(input);

  assert.deepEqual(Object.keys(result).sort(), ["reason", "status"]);
  assert.equal(result.status, "current");
  assert.equal(JSON.stringify(input), serializedInput);

  assert.throws(
    () => evaluateFreshnessTransition({
      ...baseInput,
      lifecycle: "resolved",
      publicationStatus: "withdrawn",
    } as unknown as FreshnessTransitionInput),
    FreshnessTransitionPolicyError,
  );
});
