import assert from "node:assert/strict";
import test from "node:test";
import { proposalToEventDetail } from "../src/layers/l4-application-integration/public-read-model.js";

function baseProposal(overrides: Record<string, unknown> = {}) {
  return {
    schema_version: "2.0",
    proposal_id: "prop-cat-001",
    title: "Kebakaran melanda pasar",
    incident_type: "kebakaran_pasar",
    severity: "high",
    event_time: { precision: "exact", value: "2026-10-30T16:00:00.000Z" },
    location_label: "Jakarta",
    coordinates: null,
    claims: [],
    impacts: [],
    proposed_at: "2026-10-30T16:00:00.000Z",
    ...overrides,
  };
}

test("proposalToEventDetail uses a valid canonical category", () => {
  const detail = proposalToEventDetail(baseProposal({ primary_category: "fires_infrastructure_hazards" }) as never);
  assert.equal(detail.category, "fires_infrastructure_hazards");
});
test("proposalToEventDetail rejects missing category on new pipeline records", () => {
  assert.throws(
    () => proposalToEventDetail(baseProposal({ primary_category: undefined }) as never),
    (error: unknown) =>
      error instanceof Error && error.name === "PublicEventDetailProjectionServiceError" &&
      error.message === "INVALID_EVENT",
  );
});

test("proposalToEventDetail rejects invalid category on new pipeline records", () => {
  assert.throws(
    () => proposalToEventDetail(baseProposal({ primary_category: "flood" }) as never),
    (error: unknown) =>
      error instanceof Error && error.name === "PublicEventDetailProjectionServiceError" &&
      error.message === "INVALID_EVENT",
  );
});
test("proposalToEventDetail maps legacy records behind the explicit marker", () => {
  const detail = proposalToEventDetail(
    baseProposal({ primary_category: undefined, record_json: { legacy_category: true } }) as never,
  );
  assert.equal(typeof detail.category, "string");
});
