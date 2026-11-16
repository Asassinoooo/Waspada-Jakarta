/**
 * HOSTED-17: a PetaBencana event carries the fixed label "Laporan warga PetaBencana" as its location label. The publish
 * no-label rule is unchanged: the label is the one place, so such an event is listed as a whole view, while an event
 * with neither a label nor a place stays INVALID_EVENT. Pure: no database, no network.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { EventProposalDto } from "../src/layers/l4-application-integration/moderation-api.js";
import {
  PublicEventDetailProjectionServiceError,
  proposalToEventDetail,
} from "../src/layers/l4-application-integration/public-read-model.js";
import { missingPlaceOrLabel, publicPointLabel } from "../src/layers/l4-application-integration/public-point.js";
import { assessAutoPublication } from "../src/layers/l4-application-integration/publication-policy.js";

// Must equal PETABENCANA_SOURCE_LABEL in apps/intelligence/src/structured-interpretation.ts (pinned there by a test).
const PETABENCANA_FIXED_LABEL = "Laporan warga PetaBencana";
const CLAIM_TEXT = "Laporan banjir warga di sekitar titik PetaBencana";

function proposal(proposalId: string, locationLabel: string | null, coordinates: [number, number] | null): EventProposalDto {
  return {
    schema_version: "2.0",
    proposal_id: proposalId,
    incident_id: "inc-" + proposalId,
    title: "Laporan banjir warga",
    incident_type: "banjir",
    primary_category: "disasters_weather",
    compatibility_category: "flood",
    severity: "unknown",
    event_time: { precision: "exact", value: "2026-11-16T10:00:00.000Z" },
    location_label: locationLabel,
    coordinates,
    claims: [{
      claim_id: "claim-1",
      claim_text: CLAIM_TEXT,
      evidence_label: "crowdsourced_observation",
      support_assessment: "supported",
      quote_text: CLAIM_TEXT,
      evidence_ref_id: "chk-" + proposalId,
      source_id: "petabencana",
      outlet: "PetaBencana.id",
      source_url: "https://petabencana.id/",
    }],
    impacts: [],
    interpretation_category: null,
    source_id: "petabencana",
    is_multi_source: false,
    source_count: 1,
    has_discrepancy: false,
    discrepancy_summary: null,
    discrepancies: [],
    caveats: [],
    correlation_relationship: "primary_initial",
    proposed_at: "2026-11-16T10:05:00.000Z",
  } as EventProposalDto;
}

describe("HOSTED-17 fixed PetaBencana label at publish", () => {
  it("(c) an event with the fixed label and no coordinate is listed as a whole view, not INVALID_EVENT", () => {
    const detail = proposalToEventDetail(proposal("prop-h17-a", PETABENCANA_FIXED_LABEL, null), undefined, { version: 1 });
    assert.equal(detail.location_display, "whole_view");
    assert.deepEqual(detail.geometries, [], "no pin and no point is invented");
    assert.equal(publicPointLabel(PETABENCANA_FIXED_LABEL), PETABENCANA_FIXED_LABEL);
  });

  it("the no-label refusal is unchanged: no label and no coordinate is still INVALID_EVENT", () => {
    assert.throws(
      () => proposalToEventDetail(proposal("prop-h17-b", null, null), undefined, { version: 1 }),
      (error: unknown) => error instanceof PublicEventDetailProjectionServiceError && error.message === "INVALID_EVENT",
    );
  });

  it("the fixed label counts as the one place; an absent label does not", () => {
    assert.equal(missingPlaceOrLabel("disasters_weather", 1), false);
    assert.equal(missingPlaceOrLabel("disasters_weather", 0), true);
  });

  it("the auto-publication gate reports no location_missing for the fixed label, and does without a label", () => {
    const options = { publicDisplaySourceIds: new Set(["petabencana"]) };
    const withLabel = assessAutoPublication(proposal("prop-h17-c", PETABENCANA_FIXED_LABEL, null), options);
    assert.equal(withLabel.includes("location_missing"), false);
    const withoutLabel = assessAutoPublication(proposal("prop-h17-d", null, null), options);
    assert.equal(withoutLabel.includes("location_missing"), true);
  });
});
