import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { EventView, PublicContext } from "@waspada/worker/public-contracts";
import { EventFeed } from "../src/EventFeed.js";

const demoContext: PublicContext = {
  dataset_mode: "demo",
  dataset_label: "synthetic",
  generated_at: "2026-09-24T00:00:00.000Z",
  sources: [],
};

const sampleEvent: EventView = {
  event_id: "synthetic-demo-01",
  version: 1,
  title: "Contoh fiktif: pemberitahuan kelompok",
  summary: "Data contoh untuk pengujian UI.",
  category: "group_specific_critical_notices",
  tags: [{ namespace: "topic", value: "synthetic_demo" }],
  lifecycle: "unknown",
  freshness: {
    status: "needs_update",
    evaluated_at: "2026-09-24T00:00:00.000Z",
    review_due_at: null,
    basis: "unknown",
  },
  event_time: { start: null, end: null, precision: "unknown" },
  validity: { valid_from: null, valid_until: null },
  scope: { places: [], services: [], institutions: [], audiences: [] },
  claims: [],
  impacts: [],
  published_at: "2026-09-24T00:00:00.000Z",
};

test("the visible page keeps the synthetic demo banner and source gap clear", () => {
  const html = renderToStaticMarkup(
    <EventFeed status="loaded" events={[sampleEvent]} context={demoContext} />,
  );

  assert.match(html, /DEMO — data sintetis; bukan peringatan langsung/);
  assert.match(html, /Tidak ada sumber live yang terhubung/);
  assert.match(html, /Contoh fiktif: pemberitahuan kelompok/);
  assert.match(html, /Waktu, lokasi, klaim, dan dampak tidak tersedia/);
});

test("empty and unavailable states never imply an all-clear", () => {
  const emptyHtml = renderToStaticMarkup(
    <EventFeed status="loaded" events={[]} context={demoContext} />,
  );
  assert.match(emptyHtml, /Kekosongan data tidak berarti area aman/);

  const unavailableHtml = renderToStaticMarkup(
    <EventFeed status="unavailable" events={[]} context={null} />,
  );
  assert.match(unavailableHtml, /keadaan keselamatan tidak diketahui/);
  assert.match(unavailableHtml, /DEMO — data sintetis; bukan peringatan langsung/);
});
