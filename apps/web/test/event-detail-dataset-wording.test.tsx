import assert from "node:assert/strict";
import { createElement } from "react";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { EventDetail as EventDetailRecord, PublicContext } from "@waspada/worker/public-contracts";
import { EventDetail } from "../src/EventDetail.js";

// R-05: a live record must not be labelled synthetic or fixture. Only the demo dataset carries that wording.

function record(overrides: Record<string, unknown> = {}): EventDetailRecord {
  return {
    event_id: "evt-live-1",
    version: 1,
    title: "Genangan di Cawang",
    summary: "Ringkasan singkat laporan.",
    category: "disasters_weather",
    tags: [],
    lifecycle: "ongoing",
    freshness: { status: "current", evaluated_at: "2026-11-12T09:00:00.000Z", review_due_at: null, basis: "fast_observation_review" },
    event_time: { start: "2026-11-12T08:00:00.000Z", end: null, precision: "exact" },
    validity: { valid_from: null, valid_until: null },
    scope: { places: ["Cawang, Jakarta Timur"], services: [], institutions: [], audiences: [] },
    claims: [],
    impacts: [],
    published_at: "2026-11-12T09:05:00.000Z",
    ...overrides,
  } as unknown as EventDetailRecord;
}

function context(mode: "live" | "demo"): PublicContext {
  return { dataset_mode: mode, dataset_label: mode === "live" ? "live" : "synthetic", generated_at: "2026-11-12T08:00:00.000Z", sources: [] } as unknown as PublicContext;
}

/** Visible text only, so CSS class names such as "fixture-notice" do not count as wording. */
function textOf(html: string): string {
  return html.replace(/<[^>]+>/gu, " ");
}

const emptyHistory = { eventId: "evt-live-1", status: "loaded", data: { data: [], page: { next_cursor: null, cursor_expires_at: null } } } as never;

function renderDetail(current: PublicContext | null, data: EventDetailRecord = record()): string {
  return renderToStaticMarkup(createElement(EventDetail, {
    mode: "api-event",
    apiDetail: { eventId: data.event_id, status: "loaded", data } as never,
    apiHistory: emptyHistory,
    context: current,
    variant: "sheet",
  }));
}

test("R-05: a live record is labelled as live data, never as synthetic or fixture", () => {
  const html = renderDetail(context("live"));
  assert.doesNotMatch(textOf(html), /sintetis|fixture|Contoh API|dataset demo/u);
  // HOSTED-24A (R-09): the hosted site is not a local API, so the live kicker names the event detail only.
  assert.match(html, /Detail peristiwa</u);
  assert.doesNotMatch(textOf(html), /API lokal/u);
  assert.match(html, /Record ini menampilkan waktu dan sumbernya\. Ini bukan peringatan darurat/u);
  assert.match(html, /<dt>Siklus<\/dt><dd>Berlangsung<\/dd>/u);
  assert.match(html, /Dievaluasi /u);
  assert.match(html, /Data API/u);
  assert.match(html, /Tidak tersedia pada record/u);
});

test("R-05: a demo record keeps the synthetic demo wording", () => {
  const html = renderDetail(context("demo"));
  assert.match(html, /Detail dari API lokal · record sintetis/u);
  assert.match(html, /Record ini berasal dari fixture demo sintetis\./u);
  assert.match(html, /<dt>Siklus<\/dt><dd>Berlangsung \(nilai fixture\)<\/dd>/u);
  assert.match(html, /Evaluasi fixture /u);
  assert.match(html, /Contoh API/u);
});

test("R-05: with no known dataset mode the record is labelled neutrally", () => {
  const html = renderDetail(null);
  assert.doesNotMatch(textOf(html), /sintetis|fixture|Contoh API|dataset live/u);
  assert.match(html, /Detail peristiwa</u);
});

test("R-05: live loading and unavailable states do not call the record a sample", () => {
  const loading = renderToStaticMarkup(createElement(EventDetail, {
    mode: "api-event",
    apiDetail: { eventId: "evt-live-1", status: "loading" } as never,
    apiHistory: emptyHistory,
    context: context("live"),
    variant: "sheet",
  }));
  const unavailable = renderToStaticMarkup(createElement(EventDetail, {
    mode: "api-event",
    apiDetail: { eventId: "evt-live-1", status: "unavailable" } as never,
    apiHistory: emptyHistory,
    context: context("live"),
    variant: "sheet",
  }));
  for (const html of [loading, unavailable]) {
    assert.doesNotMatch(textOf(html), /sintetis|fixture|contoh/iu);
  }
});

test("R-05: live history entries carry no demo fixture label", () => {
  const history = {
    eventId: "evt-live-1",
    status: "loaded",
    data: {
      data: [{ event_id: "evt-live-1", version: 2, change_type: "published", changed_at: "2026-11-12T09:05:00.000Z", summary: "Versi pertama." }],
      page: { next_cursor: null, cursor_expires_at: null },
    },
  } as never;
  const html = renderToStaticMarkup(createElement(EventDetail, {
    mode: "api-event",
    apiDetail: { eventId: "evt-live-1", status: "loaded", data: record() } as never,
    apiHistory: history,
    context: context("live"),
    variant: "sheet",
  }));
  assert.doesNotMatch(textOf(html), /fixture|sintetis/u);
  assert.match(html, /Waktu: /u);
});
