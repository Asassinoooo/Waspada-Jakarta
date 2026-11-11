import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { LaporanPublik, publicEventToCard, publicationBadgeText } from "../src/LaporanPublik.js";

/** MERGE-REVIEW-01: #jelajah shows published public events only, with each claim's own source. */

function publishedEvent(publication: { mode: "agent_auto" | "moderator_reviewed"; source_count: number } | undefined) {
  return {
    event_id: "inc-published-1",
    version: 1,
    title: "Genangan di Cawang",
    summary: "Genangan 50 cm di Cawang. Banjir merendam Jalan DI Panjaitan.",
    category: "disasters_weather",
    incident_type: "genangan_air_luapan_saluran",
    tags: [],
    lifecycle: "ongoing",
    freshness: { status: "current", evaluated_at: "2026-11-10T08:05:00.000Z", review_due_at: null, basis: "fast_observation_review" },
    event_time: { start: "2026-11-10T08:00:00.000Z", end: null, precision: "exact" },
    validity: { valid_from: null, valid_until: null },
    scope: { places: ["Cawang, Jakarta Timur"], services: [], institutions: [], audiences: [] },
    claims: [
      {
        claim_id: "claim-1",
        text: "Genangan 50 cm di Cawang",
        event_time: { start: null, end: null, precision: "exact" },
        validity: { valid_from: null, valid_until: null },
        scope: { places: [], services: [], institutions: [], audiences: [] },
        qualifiers: [],
        evidence_label: "attributed_report",
        sources: [{ display_name: "Detik News", url: "https://news.example/cawang", published_at: null, observed_at: null, excerpt: "Genangan setinggi 50 cm" }],
      },
      {
        claim_id: "claim-2",
        text: "Banjir merendam Jalan DI Panjaitan",
        event_time: { start: null, end: null, precision: "exact" },
        validity: { valid_from: null, valid_until: null },
        scope: { places: [], services: [], institutions: [], audiences: [] },
        qualifiers: [],
        evidence_label: "attributed_report",
        sources: [{ display_name: "Antara News", url: "https://news.example/antara", published_at: null, observed_at: null, excerpt: "Banjir merendam" }],
      },
    ],
    impacts: [],
    published_at: "2026-11-10T08:05:00.000Z",
    geometries: [],
    ...(publication ? { publication } : {}),
  } as unknown as Parameters<typeof publicEventToCard>[0];
}

test("a published event maps to a card whose claims link only to their own sources", () => {
  const card = publicEventToCard(publishedEvent({ mode: "agent_auto", source_count: 2 }));
  assert.equal(card.proposal_id, "inc-published-1");
  assert.equal(card.source_count, 2);
  assert.equal(card.publication_mode, "agent_auto");
  assert.deepEqual(card.claims.map((claim) => claim.source_url), [
    "https://news.example/cawang",
    "https://news.example/antara",
  ]);
  assert.deepEqual(card.claims.map((claim) => claim.outlet), ["Detik News", "Antara News"]);
  assert.ok(!JSON.stringify(card).includes("Laporan Terverifikasi"), "no invented source label");
  assert.ok(!JSON.stringify(card).includes("waspada.jakarta.go.id"), "no invented source URL");
});

test("publication badge states who published the version and how many media reported it", () => {
  const agent = publicEventToCard(publishedEvent({ mode: "agent_auto", source_count: 2 }));
  assert.equal(publicationBadgeText(agent), "Diringkas otomatis oleh agen AI · dilaporkan oleh 2 media");
  const moderated = publicEventToCard(publishedEvent({ mode: "moderator_reviewed", source_count: 1 }));
  assert.equal(publicationBadgeText(moderated), "Ditinjau moderator · dilaporkan oleh 1 media");
});

test("#jelajah renders the published version with the honest badge and no invented verification labels", () => {
  const card = publicEventToCard(publishedEvent({ mode: "agent_auto", source_count: 2 }));
  const html = renderToStaticMarkup(createElement(LaporanPublik, { initialProposals: [card], initialSelectedId: card.proposal_id }));
  assert.match(html, /Diringkas otomatis oleh agen AI · dilaporkan oleh 2 media/);
  assert.match(html, /href="https:\/\/news\.example\/cawang"/);
  assert.match(html, /href="https:\/\/news\.example\/antara"/);
  assert.doesNotMatch(html, /Terverifikasi Independen/);
  assert.doesNotMatch(html, /2 Sumber \(/);
  assert.doesNotMatch(html, /Laporan Publik Terverifikasi/);
  assert.doesNotMatch(html, /Laporan Terverifikasi/);
});

test("the public page reads only the published events endpoint, never the moderation queue", () => {
  const source = readFileSync(new URL("../src/LaporanPublik.tsx", import.meta.url), "utf8");
  assert.match(source, /listEvents\(\)/);
  assert.doesNotMatch(source, /fetchModerationProposals/);
  assert.doesNotMatch(source, /\/api\/v1\/moderation/);
  assert.doesNotMatch(source, /fetchProposalDetail/);
});
