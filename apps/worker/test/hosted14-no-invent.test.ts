/**
 * HOSTED-14: the agent never invents a region or a coordinate. The label comes from the report text or is absent, a
 * model coordinate is kept only when a stated place backs it, and the point source is source_text only for sources
 * whose coordinate is parsed from their own text. Pure: no database, no network.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  extractLocation,
  generateProposalFromReport,
  groundModelLocation,
  type StoredReportRevision,
} from "../src/layers/l2-model-grounding/proposal-engine.js";
import {
  SOURCE_STATED_POINT_SOURCE_IDS,
  pointSourceFor,
  publicPointOutcomeFor,
} from "../src/layers/l4-application-integration/public-point.js";

const NO_PLACE = "Banjir setinggi lutut merendam rumah warga sejak pagi ini.";
const CAWANG = "Banjir setinggi lutut terjadi di Cawang, Jakarta Timur sejak siang.";

function report(sourceId: string, text: string): StoredReportRevision {
  return {
    report_revision_id: "rev-hosted14-1",
    source_id: sourceId,
    canonical_url: "https://example.test/berita/1",
    permitted_text: text,
    permitted_text_hash: "hash-hosted14-1",
    published_at: null,
    retrieved_at: "2026-11-16T10:00:00.000Z",
    revision_status: "unreviewed",
    chunks: [{ chunk_index: 0, text, span_start: 0, span_end: text.length }],
  };
}

describe("HOSTED-14 no default region in the deterministic path", () => {
  it("a Jakarta-scoped source with no stated place has no label, not DKI Jakarta", () => {
    const location = extractLocation(NO_PLACE, "antara-metro");
    assert.deepEqual(location, { locationLabel: null, coordinates: null });
  });

  it("the proposal keeps a null label and a title with no place", () => {
    const proposal = generateProposalFromReport(report("antara-metro", NO_PLACE), { proposedAt: "2026-11-16T10:00:00.000Z" });
    assert.ok(proposal, "the flood report is still in scope");
    assert.equal(proposal.location_label, null);
    assert.equal(proposal.coordinates, null);
    assert.ok(!proposal.title.includes("DKI"), `title must not name a region: ${proposal.title}`);
    assert.ok(!JSON.stringify(proposal).includes("DKI Jakarta"));
  });

  it("a stated place keeps its own label from the text", () => {
    const proposal = generateProposalFromReport(report("antara-metro", CAWANG), { proposedAt: "2026-11-16T10:00:00.000Z" });
    assert.ok(proposal);
    assert.equal(proposal.location_label, "Cawang, Jakarta Timur");
    assert.ok(proposal.title.includes("Cawang"));
  });

  it("a coordinate stated in the source text is kept with the text, even without a place name", () => {
    const text = "Banjir setinggi lutut merendam jalan [106.85, -6.21] sejak pagi.";
    const location = extractLocation(text, "petabencana");
    assert.ok(location);
    assert.deepEqual(location.coordinates, [106.85, -6.21]);
    assert.equal(location.locationLabel, null);
  });
});

describe("HOSTED-14 model coordinate grounding", () => {
  it("keeps a model label and its coordinate when the text states the place", () => {
    const grounded = groundModelLocation({ label: "Cawang, Jakarta Timur", coordinates: [106.87, -6.24] }, CAWANG);
    assert.equal(grounded.locationLabel, "Cawang, Jakarta Timur");
    assert.deepEqual(grounded.coordinates, [106.87, -6.24]);
  });

  it("drops a model coordinate when the text names no place", () => {
    const grounded = groundModelLocation({ label: null, coordinates: [106.87, -6.24] }, NO_PLACE);
    assert.equal(grounded.coordinates, null);
    assert.equal(grounded.locationLabel, null);
  });

  it("drops a model label the text does not state, and does not keep it as a default", () => {
    const grounded = groundModelLocation({ label: "Kemang, Jakarta Selatan", coordinates: [106.81, -6.26] }, NO_PLACE);
    assert.equal(grounded.locationLabel, null);
    assert.equal(grounded.coordinates, null);
  });

  it("keeps a model coordinate that a gazetteer place in the text backs, even when its label is not stated", () => {
    const grounded = groundModelLocation({ label: "Kemang, Jakarta Selatan", coordinates: [106.87, -6.24] }, CAWANG);
    assert.equal(grounded.locationLabel, null, "the unstated label is dropped");
    assert.deepEqual(grounded.coordinates, [106.87, -6.24], "Cawang is a stated gazetteer place");
  });

  it("has no default: no label and no coordinate in gives none out", () => {
    assert.deepEqual(groundModelLocation({}, NO_PLACE), { locationLabel: null, coordinates: null });
  });

  it("drops a coordinate that is not a finite longitude and latitude", () => {
    const grounded = groundModelLocation({ label: "Cawang", coordinates: [Number.NaN, -6.24] }, CAWANG);
    assert.equal(grounded.coordinates, null);
  });
});

describe("HOSTED-14 point source", () => {
  it("is source_text only when every claim comes from a source-stated coordinate source", () => {
    assert.equal(pointSourceFor(["petabencana", "petabencana"]), "source_text");
    assert.equal(pointSourceFor(["source-bmkg-gempa"]), "source_text");
    assert.equal(pointSourceFor(["petabencana", "source-detik"]), "model_approximate", "mixed sources stay model_approximate");
    assert.equal(pointSourceFor(["petabencana", null]), "model_approximate", "a claim with no source id is not source-stated");
    assert.equal(pointSourceFor([]), "model_approximate", "no claims gives no source-stated coordinate");
  });

  it("pins the source-stated set to the two structured sources", () => {
    assert.deepEqual([...SOURCE_STATED_POINT_SOURCE_IDS].sort(), ["petabencana", "source-bmkg-gempa"]);
  });

  it("publicPointOutcomeFor carries the source and keeps the sanity box", () => {
    const point = publicPointOutcomeFor({
      category: "flood",
      locationLabel: "Cawang",
      coordinates: [106.87, -6.24],
      claimSourceIds: ["petabencana"],
    });
    assert.deepEqual(point, { status: "point", coordinates: [106.87, -6.24], source: "source_text" });

    const modelPoint = publicPointOutcomeFor({ category: "flood", locationLabel: "Cawang", coordinates: [106.87, -6.24] });
    assert.deepEqual(modelPoint, { status: "point", coordinates: [106.87, -6.24], source: "model_approximate" });

    const outside = publicPointOutcomeFor({ category: "flood", locationLabel: "Cawang", coordinates: [100, -6.24], claimSourceIds: ["petabencana"] });
    assert.deepEqual(outside, { status: "whole_view" });
  });
});
