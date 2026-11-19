/**
 * NFR-07 (malicious source text, A3): the public event detail shows source text as escaped text. A script, an image
 * with a handler, or a javascript: link written into a title, summary, claim, outlet name, excerpt or URL never
 * reaches the page as markup. Server render only: no network, no browser.
 */
import assert from "node:assert/strict";
import { createElement } from "react";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { EventDetail as EventDetailRecord, PublicClaim, PublicContext } from "@waspada/worker/public-contracts";
import { EventDetail } from "../src/EventDetail.js";

const SCRIPT = "<script>alert('nfr07')</script>";
const IMAGE = "<img src=x onerror=\"alert('nfr07')\">";

function hostileRecord(): EventDetailRecord {
  const claim: PublicClaim = {
    claim_id: "claim-nfr07-a3",
    text: `Genangan di Cawang ${SCRIPT}`,
    event_time: { start: "2026-11-12T02:30:00.000Z", end: null, precision: "exact" },
    validity: { valid_from: null, valid_until: null },
    scope: { places: [], services: [], institutions: [], audiences: [] },
    qualifiers: [],
    evidence_label: "attributed_report",
    sources: [{
      display_name: `Kompas ${SCRIPT}`,
      url: "javascript:alert('nfr07')",
      published_at: "2026-11-12T03:00:00.000Z",
      observed_at: null,
      excerpt: `</p>${IMAGE}`,
    }],
  };
  return {
    event_id: "evt-nfr07-a3",
    version: 1,
    title: `Banjir ${SCRIPT}`,
    summary: `Ringkasan ${IMAGE}`,
    category: "disasters_weather",
    tags: [],
    lifecycle: "ongoing",
    freshness: { status: "current", evaluated_at: "2026-11-12T09:00:00.000Z", review_due_at: null, basis: "fast_observation_review" },
    event_time: { start: "2026-11-12T02:30:00.000Z", end: null, precision: "exact" },
    validity: { valid_from: null, valid_until: null },
    scope: { places: ["Cawang, Jakarta Timur"], services: [], institutions: [], audiences: [] },
    claims: [claim],
    impacts: [],
    published_at: "2026-11-12T09:05:00.000Z",
    geometries: [],
  };
}

const liveContext: PublicContext = {
  dataset_mode: "live",
  dataset_label: "live",
  generated_at: "2026-11-12T08:00:00.000Z",
  sources: [],
};

function renderDetail(data: EventDetailRecord): string {
  return renderToStaticMarkup(createElement(EventDetail, {
    mode: "api-event",
    apiDetail: { eventId: data.event_id, status: "loaded", data } as never,
    apiHistory: { eventId: data.event_id, status: "loaded", data: { data: [], page: { next_cursor: null, cursor_expires_at: null } } } as never,
    context: liveContext,
    variant: "sheet",
  }));
}

test("NFR-07 A3: a script, an image handler and a javascript: link in source text never reach the public page as markup", () => {
  const html = renderDetail(hostileRecord());
  assert.match(html, /Banjir/u, "the page still renders");
  assert.doesNotMatch(html, /<script/iu, "no raw script element");
  assert.doesNotMatch(html, /<img/iu, "no raw image element");
  assert.doesNotMatch(html, /href="javascript:alert/iu, "the attacker's javascript: URL is never the href");
  assert.match(
    html,
    /href="javascript:throw new Error\(&#x27;React has blocked a javascript: URL/u,
    "React replaces the javascript: href with its blocked-URL form",
  );
});

test("NFR-07 A3: the hostile text is shown escaped, so the reader sees the words and the browser runs nothing", () => {
  const html = renderDetail(hostileRecord());
  assert.match(html, /&lt;script&gt;alert\(&#x27;nfr07&#x27;\)&lt;\/script&gt;/u, "the claim text is escaped");
  assert.match(html, /&lt;img src=x onerror=&quot;alert\(&#x27;nfr07&#x27;\)&quot;&gt;/u, "the summary and excerpt are escaped");
});
