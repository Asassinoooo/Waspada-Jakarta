import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { EventDetail as EventDetailRecord, PublicContext } from "@waspada/worker/public-contracts";
import { presentationFallsThrough, type Route } from "../src/App.js";
import { EventDetail } from "../src/EventDetail.js";
import { documentTitleFor, freshnessBasisLabel } from "../src/display.js";
import { EMPTY_LIST_TITLE, EMPTY_SEARCH_TITLE, MapEventList } from "../src/MapEventList.js";
import {
  discrepancyKindLabel,
  eventTimePrecisionLabel,
  proposalEventTimeText,
  triageDispositionLabel,
  triageReasonLabel,
} from "../src/moderation-labels.js";
import { SOURCE_APPROVAL_INTRO, sourceApprovalDialogBody } from "../src/SourceApprovalPanel.js";
import { nodeView } from "../src/pipeline-flow-model.js";
import { PipelineDrawer } from "../src/PipelineFlow.js";
import { demoSnapshot } from "./pipeline-flow-fixtures.js";

// HOSTED-34: wording and raw-code fixes on the live web UI.

test("HOSTED-34: approve and revoke dialogs describe publication only, and collection is never changed", () => {
  assert.equal(
    sourceApprovalDialogBody("approved"),
    "Menyetujui mengizinkan laporan dari sumber ini tampil publik. Pengumpulan otomatis tidak berubah.",
  );
  const revoke = sourceApprovalDialogBody("revoked");
  assert.match(revoke, /^Mencabut menghentikan penerbitan dari sumber ini\./u);
  assert.match(revoke, /Pengumpulan otomatis tetap berjalan, dan terbit otomatis diatur ke tidak pernah\./u);
  assert.match(revoke, /Kejadian yang sudah terbit tidak ditarik\./u);

  // The old copy claimed approval switches collection on and revocation switches it off. The backend does neither.
  for (const text of [sourceApprovalDialogBody("approved"), revoke, SOURCE_APPROVAL_INTRO]) {
    assert.doesNotMatch(text, /menyalakan|mematikan pengumpulan/u);
  }
  assert.match(SOURCE_APPROVAL_INTRO, /Pengumpulan otomatis tidak berubah/u);
  assert.match(SOURCE_APPROVAL_INTRO, /Mencabut menghentikan penerbitan/u);
});

test("HOSTED-34: the triage, discrepancy and precision labels map known codes and fall back to lainnya", () => {
  assert.equal(eventTimePrecisionLabel("exact"), "jam tercatat");
  assert.equal(eventTimePrecisionLabel("date"), "tanggal saja");
  assert.equal(eventTimePrecisionLabel("range"), "rentang");
  assert.equal(eventTimePrecisionLabel("unknown"), "tidak disebutkan");
  assert.equal(eventTimePrecisionLabel("hourly_guess"), "lainnya");
  assert.equal(eventTimePrecisionLabel(null), "lainnya");

  assert.equal(discrepancyKindLabel("casualty_count"), "jumlah korban");
  assert.equal(discrepancyKindLabel("water_depth"), "ketinggian air");
  assert.equal(discrepancyKindLabel("new_kind_from_a_future_build"), "lainnya");

  assert.equal(triageDispositionLabel("drop"), "dibuang");
  assert.equal(triageReasonLabel("triage_v1_ingest"), "lolos triase");
  assert.equal(triageReasonLabel("ambiguous_location"), "lokasi belum jelas");
  assert.equal(triageReasonLabel("some_unlisted_reason"), "lainnya");
  // An inherited object key is not a label: the lookup is an own-property check.
  assert.equal(triageDispositionLabel("constructor"), "lainnya");
  assert.equal(triageReasonLabel("toString"), "lainnya");
});

test("HOSTED-34: a date-only event time shows the date and no clock time; an unknown time reads tidak disebutkan", () => {
  assert.equal(proposalEventTimeText({ precision: "date", value: "2026-11-17" }), "17 Nov 2026 (tanggal saja)");
  assert.doesNotMatch(proposalEventTimeText({ precision: "date", value: "2026-11-17" }), /WIB|:|\d{2}\.\d{2}/u);

  assert.match(proposalEventTimeText({ precision: "exact", value: "2026-11-17T07:00:00+07:00" }), /17 Nov 2026, 07\.00 WIB \(jam tercatat\)/u);
  assert.equal(proposalEventTimeText({ precision: "range", value: "10.00-12.00" }), "10.00-12.00 (rentang)");
  assert.equal(proposalEventTimeText({ precision: "unknown", value: null }), "tidak disebutkan");
  assert.equal(proposalEventTimeText({ precision: "date", value: null }), "tidak disebutkan");
});

test("HOSTED-34: the freshness basis reads in Indonesian and an unknown code reads lainnya", () => {
  assert.equal(freshnessBasisLabel("fast_observation_review"), "tinjauan cepat laporan");
  assert.equal(freshnessBasisLabel("source_validity"), "masa berlaku sumber");
  assert.equal(freshnessBasisLabel("unknown"), "belum diketahui");
  assert.equal(freshnessBasisLabel("brand_new_basis"), "lainnya");
  assert.equal(freshnessBasisLabel(undefined), "lainnya");
});

test("HOSTED-34: the empty text search names the search, and an empty filtered list keeps the area and time message", () => {
  const props = {
    headingId: "t",
    status: "loaded" as const,
    events: [],
    markers: new Map(),
    selectedId: null,
    errorMessage: null,
    onSelect: () => {},
    onReset: () => {},
    onRetry: () => {},
  };
  const search = renderToStaticMarkup(createElement(MapEventList, { ...props, filtersActive: true, searchOnly: true }));
  assert.ok(search.includes(EMPTY_SEARCH_TITLE));
  assert.equal(EMPTY_SEARCH_TITLE, "Tidak ada laporan terbit yang cocok dengan pencarian ini.");
  assert.ok(!search.includes(EMPTY_LIST_TITLE), "a search with no match never says there are no reports in the area");

  const filtered = renderToStaticMarkup(createElement(MapEventList, { ...props, filtersActive: true }));
  assert.ok(filtered.includes(EMPTY_LIST_TITLE));
  assert.ok(!filtered.includes(EMPTY_SEARCH_TITLE));
});

test("HOSTED-34: the tab title names the demo dataset only when the API confirms demo mode", () => {
  assert.equal(documentTitleFor("demo"), "Waspada Jakarta — demo sintetis");
  assert.equal(documentTitleFor("live"), "Waspada Jakarta");
  assert.equal(documentTitleFor(null), "Waspada Jakarta");
  assert.equal(documentTitleFor(undefined), "Waspada Jakarta");

  const indexHtml = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  assert.match(indexHtml, /<title>Waspada Jakarta<\/title>/u, "the static title carries no demo label");
});

test("HOSTED-34: the fixture detail falls through to the map home on a live dataset, and only there", () => {
  const live = { dataset_mode: "live" } as unknown as PublicContext;
  const demo = { dataset_mode: "demo" } as unknown as PublicContext;
  const presentation: Route = { screen: "detail-presentation" };
  assert.equal(presentationFallsThrough(presentation, live), true);
  assert.equal(presentationFallsThrough(presentation, demo), false);
  // An unknown context keeps the route, so the notice about the missing status still shows.
  assert.equal(presentationFallsThrough(presentation, null), false);
  assert.equal(presentationFallsThrough({ screen: "discover" }, live), false);
});

test("HOSTED-34: the cycle node names the last cycle time in WIB, or says none is recorded", () => {
  const snapshot = demoSnapshot();
  const cycleNode = snapshot.nodes.find((node) => node.id === "cycle")!;
  const drawer = { nineRouter: null, generatedAt: null, items: null, itemState: "loading" as const, onClose: () => {} };
  const cycle = {
    running: false,
    sequence: 3,
    started_at: "2026-11-17T07:59:58.000Z",
    finished_at: "2026-11-17T08:00:00.000Z",
    duration_ms: 1800,
    new_items_cap: 5,
    new_items_used: 4,
    feeds_total: 14,
    feeds_failed: 1,
    error_count: 0,
  };
  const withCycle = renderToStaticMarkup(createElement(PipelineDrawer, { ...drawer, view: nodeView(cycleNode), cycle }));
  // 08:00 UTC is 15:00 Jakarta time.
  assert.match(withCycle, /Waktu siklus terakhir: 17 Nov 2026, 15\.00 WIB/u);

  const none = renderToStaticMarkup(createElement(PipelineDrawer, { ...drawer, view: nodeView(cycleNode), cycle: null }));
  assert.match(none, /Belum ada siklus tercatat/u);

  const queue = snapshot.nodes.find((node) => node.id === "ai_queue")!;
  const otherNode = renderToStaticMarkup(createElement(PipelineDrawer, { ...drawer, view: nodeView(queue), cycle }));
  assert.doesNotMatch(otherNode, /Waktu siklus terakhir/u, "only the cycle node shows the cycle time");
});

test("HOSTED-34: the live event detail shows the basis and the plain wording, with no raw codes", () => {
  const data = {
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
  } as unknown as EventDetailRecord;
  const context = { dataset_mode: "live", dataset_label: "live", generated_at: "2026-11-12T08:00:00.000Z", sources: [] } as unknown as PublicContext;
  const html = renderToStaticMarkup(createElement(EventDetail, {
    mode: "api-event",
    apiDetail: { eventId: data.event_id, status: "loaded", data } as never,
    apiHistory: { eventId: data.event_id, status: "loaded", data: { data: [], page: { next_cursor: null, cursor_expires_at: null } } } as never,
    context,
    variant: "sheet",
  }));
  const text = html.replace(/<[^>]+>/gu, " ");
  assert.match(text, /dasar: tinjauan cepat laporan/u);
  assert.match(text, /Data dimuat/u);
  assert.match(text, /Tidak disebutkan/u);
  assert.doesNotMatch(text, /basis |Respons konteks|Tidak disediakan dalam proyeksi|CRS84|Equirektangular|\brecord\b/iu);
});
