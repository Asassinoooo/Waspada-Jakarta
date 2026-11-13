import assert from "node:assert/strict";
import test from "node:test";
import {
  PublicReadModel,
  proposalToEventDetail,
  publicSeverity,
} from "../src/layers/l4-application-integration/public-read-model.js";
import { syntheticEventFixtures } from "../src/layers/l4-application-integration/synthetic-fixtures.js";

/** SEV-01: the public estimate of impact. Never a safety claim and never a radius. */

const sourceStatus = { listPublicSourceStatus: () => [] };

function proposal(overrides: Record<string, unknown> = {}) {
  return {
    schema_version: "2.0",
    proposal_id: "prop-sev-001",
    title: "Genangan setinggi 40cm di Kemang",
    incident_type: "flood",
    primary_category: "disasters_weather",
    severity: "critical",
    event_time: { precision: "exact", value: "2026-11-12T08:00:00.000Z" },
    location_label: "Kemang, Jakarta Selatan",
    coordinates: [106.8145, -6.2615],
    claims: [],
    impacts: [],
    proposed_at: "2026-11-12T08:05:00.000Z",
    ...overrides,
  };
}

test("publicSeverity passes low, medium and high through unchanged", () => {
  assert.equal(publicSeverity("low"), "low");
  assert.equal(publicSeverity("medium"), "medium");
  assert.equal(publicSeverity("high"), "high");
});

test("publicSeverity shows critical as high, never as a higher level", () => {
  assert.equal(publicSeverity("critical"), "high");
});

test("publicSeverity omits unknown and any other value, and never guesses a level", () => {
  for (const value of ["unknown", "", "HIGH", "Tinggi", "severe", null, undefined, 3, {}, ["high"]]) {
    assert.equal(publicSeverity(value), undefined, `value ${JSON.stringify(value)} must not map`);
  }
});

test("a proposal with severity critical publishes as high", () => {
  const detail = proposalToEventDetail(proposal() as never);
  assert.equal(detail.severity, "high");
  assert.equal(JSON.parse(JSON.stringify(detail)).severity, "high");
});

test("a proposal with severity unknown publishes with no severity key at all", () => {
  const detail = proposalToEventDetail(proposal({ severity: "unknown" }) as never);
  assert.equal(Object.hasOwn(detail, "severity"), false);
  assert.equal("severity" in JSON.parse(JSON.stringify(detail)), false);
});

test("the hazard tag still carries the internal severity, unchanged by the public estimate", () => {
  const detail = proposalToEventDetail(proposal({ severity: "critical" }) as never);
  assert.deepEqual(
    detail.tags.find((tag) => tag.namespace === "hazard"),
    { namespace: "hazard", value: "critical" },
  );
});

test("the public list and detail both carry the mapped severity of a published proposal", () => {
  PublicReadModel.clearPublishedEvents();
  const model = new PublicReadModel(sourceStatus, [], [proposal() as never]);

  const page = model.events(new URLSearchParams());
  assert.equal(page.data.length, 1);
  assert.equal(page.data[0]?.severity, "high");

  const detail = model.detail(page.data[0]!.event_id);
  assert.equal(detail?.severity, "high");
});

test("the public list and detail omit the severity key for an unassessed proposal", () => {
  PublicReadModel.clearPublishedEvents();
  const model = new PublicReadModel(sourceStatus, [], [proposal({ severity: "unknown" }) as never]);

  const page = model.events(new URLSearchParams());
  assert.equal(page.data.length, 1);
  assert.equal(Object.hasOwn(page.data[0]!, "severity"), false);
  assert.equal(Object.hasOwn(model.detail(page.data[0]!.event_id)!, "severity"), false);
});

test("a raw published record maps its severity the same way", () => {
  PublicReadModel.clearPublishedEvents();
  const model = new PublicReadModel(sourceStatus, [], [
    {
      event_id: "evt-raw-sev-1",
      title: "Pohon tumbang di Cawang",
      primary_category: "disasters_weather",
      severity: "medium",
    } as never,
  ]);
  assert.equal(model.events(new URLSearchParams()).data[0]?.severity, "medium");
});

test("the GeoJSON feature properties never carry severity, only the point and its existing fields", () => {
  PublicReadModel.clearPublishedEvents();
  const model = new PublicReadModel(sourceStatus, [], [proposal() as never]);
  const collection = model.geoJSON();
  assert.equal(collection.features.length, 1);
  assert.equal(Object.hasOwn(collection.features[0]!.properties, "severity"), false);
});

test("the demo fixtures carry a mix of low, medium and high so the demo list shows all three", () => {
  PublicReadModel.clearPublishedEvents();
  const levels = new Set(syntheticEventFixtures.map((event) => event.severity));
  assert.deepEqual([...levels].sort(), ["high", "low", "medium"]);

  const page = new PublicReadModel(sourceStatus).events(new URLSearchParams({ limit: "100" }));
  assert.deepEqual(
    page.data.map((event) => event.severity),
    syntheticEventFixtures.map((event) => event.severity),
  );
});
