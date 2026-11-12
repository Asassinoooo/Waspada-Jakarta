import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { EventView } from "@waspada/worker/public-contracts";
import { EventDetail } from "../src/EventDetail.js";
import { MapHome } from "../src/MapHome.js";
import { publicationPathText, sourceCountText, sourceNamesOf } from "../src/published-events.js";

/** MERGE-REVIEW-01 (kept through UI-V2-B): the public map home shows published public events only, each with its own named sources. */

function publishedEvent(overrides: Record<string, unknown> = {}): EventView {
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
    ...overrides,
  } as unknown as EventView;
}

test("a published event counts its distinct named sources and carries no invented source or verification label", () => {
  const event = publishedEvent();
  assert.deepEqual(sourceNamesOf(event), ["Detik News", "Antara News"]);
  assert.equal(sourceCountText(sourceNamesOf(event).length), "2 sumber");
  const html = renderToStaticMarkup(createElement(MapHome, { initialEvents: [event] }));
  assert.match(html, /2 sumber/);
  assert.doesNotMatch(html, /Laporan Terverifikasi|Terverifikasi Independen|Laporan Publik Terverifikasi/);
  assert.doesNotMatch(html, /waspada\.jakarta\.go\.id/, "no invented source URL");
});

test("the publication path is stated only when the API gives one", () => {
  assert.equal(
    publicationPathText({ mode: "agent_auto", source_count: 2 }),
    "Diringkas otomatis oleh agen AI · dilaporkan oleh 2 media",
  );
  assert.equal(
    publicationPathText({ mode: "moderator_reviewed", source_count: 1 }),
    "Ditinjau moderator · dilaporkan oleh 1 media",
  );
  assert.equal(publicationPathText(undefined), null, "an unknown path is not labelled as automatic");
});

test("the map home intro states the publication path and claims neither verification nor corroboration", () => {
  const html = renderToStaticMarkup(createElement(MapHome, { initialEvents: [publishedEvent()] }));
  assert.match(html, /Hanya laporan yang sudah terbit/);
  assert.match(html, /bukan hasil pemeriksaan atau verifikasi otomatis/);
  assert.doesNotMatch(html, /terverifikasi|verifikasi multi-sumber|independen|terkonfirmasi/iu);
});

test("the detail sheet states the publication path and keeps the sheet variant free of a second main landmark", () => {
  const detail = publishedEvent({
    geometries: [],
    publication: { mode: "agent_auto", source_count: 2 },
  });
  const html = renderToStaticMarkup(createElement(EventDetail, {
    mode: "api-event",
    apiDetail: { eventId: "inc-published-1", status: "loaded", data: detail as never },
    apiHistory: { eventId: "inc-published-1", status: "loaded", data: { data: [], page: { next_cursor: null, cursor_expires_at: null } } },
    context: null,
    variant: "sheet",
  }));
  assert.match(html, /class="event-detail-sheet"/);
  assert.doesNotMatch(html, /<main/, "the sheet must not add a second main landmark");
  assert.match(html, /<dt>Cara penerbitan<\/dt><dd>Diringkas otomatis oleh agen AI · dilaporkan oleh 2 media<\/dd>/);
  assert.doesNotMatch(html, /terverifikasi|terkonfirmasi/iu);
});

test("the public map reads only the published events endpoint, never the moderation queue", () => {
  const files = [
    "../src/published-events.ts",
    "../src/MapHome.tsx",
    "../src/MapEventList.tsx",
    "../src/MapPopup.tsx",
    "../src/MapFilterSheet.tsx",
    "../src/EventMapCanvas.tsx",
  ];
  for (const file of files) {
    const source = readFileSync(new URL(file, import.meta.url), "utf8");
    assert.doesNotMatch(source, /fetchModerationProposals|fetchProposalDetail|\/api\/v1\/moderation/, file);
  }
  const hook = readFileSync(new URL("../src/published-events.ts", import.meta.url), "utf8");
  assert.match(hook, /listEvents\(\)/);
  assert.match(hook, /getEventGeoJSON\(\)/);
});

test("the public map home keeps internal wording out of the public copy", () => {
  const html = renderToStaticMarkup(createElement(MapHome, { initialEvents: [publishedEvent()] }));
  assert.doesNotMatch(html, /fixture|cursor|polling/iu);
});
