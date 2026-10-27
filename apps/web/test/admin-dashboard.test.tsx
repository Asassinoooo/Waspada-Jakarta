import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { AdminItem, AdminLayerSummary, AdminMonitorState, AdminSnapshot } from "../src/admin-types.js";
import { AdminDashboard, AdminRecordInspector, countAdminGeometry, currentApiObservation, displayedLayers, filterAdminItems, findSelectedAdminItem } from "../src/AdminDashboard.js";

const unmapped: AdminItem = {
  id: "fictional-flood-01",
  title: "Contoh fiktif genangan dekat Tebet",
  summary: "Laporan sintetis untuk alur demo.",
  category: "disasters_weather",
  layer: "L1",
  state: "queued",
  operationalPriority: "attention",
  placeLabel: "Kelurahan Tebet",
  geometry: null,
  geometryBasis: "none",
  geometryNote: "Lokasi terlalu umum untuk dipetakan.",
  sourceNames: ["Sumber simulasi"],
  eventVersion: null,
  publicEventId: null,
  datasetKind: "synthetic",
  observedAt: null,
  fetchedAt: null,
  publishedAt: null,
  evidenceSummary: "Bukti dan waktu bersifat fiktif.",
  stopReason: null,
  nextStep: "Contoh pemeriksaan lanjutan",
  budget: null,
  steps: [],
};

const mapped: AdminItem = {
  ...unmapped,
  id: "fictional-rain-02",
  title: "Contoh fiktif hujan lokal",
  category: "disasters_weather",
  layer: "L2",
  state: "running",
  placeLabel: "Kecamatan Menteng",
  geometry: { type: "Point", coordinates: [106.83, -6.2] },
  geometryBasis: "synthetic_example",
  geometryNote: "Koordinat hanya untuk contoh.",
};

test("admin search and filters keep map/list coverage limited to the selected snapshot subset", () => {
  const matches = filterAdminItems([unmapped, mapped], {
    query: "tebet",
    layer: "L1",
    state: "queued",
    geometry: "unmapped",
  });

  assert.deepEqual(matches.map((item) => item.id), ["fictional-flood-01"]);
  assert.deepEqual(countAdminGeometry(matches), { mapped: 0, unmapped: 1, unknown: 0, total: 1 });
  assert.equal(findSelectedAdminItem(matches, "fictional-rain-02"), null);
  assert.equal(findSelectedAdminItem(matches, "fictional-flood-01"), unmapped);
  assert.deepEqual(filterAdminItems([unmapped, mapped], {
    query: "hujan",
    layer: "all",
    state: "all",
    geometry: "mapped",
  }).map((item) => item.id), ["fictional-rain-02"]);
});

const apiSnapshot: AdminSnapshot = {
  mode: "public_api",
  capturedAt: "2026-10-10T08:00:00.000Z",
  context: {
    dataset_mode: "demo",
    dataset_label: "synthetic",
    generated_at: "2026-10-10T08:00:00.000Z",
    sources: [],
  },
  datasetMode: "demo",
  items: [],
  layers: [],
  sources: [],
  activities: [],
  probes: [],
  limitations: [],
  hasMoreEvents: false,
};

function monitorStateWithAttempt(attempt: NonNullable<AdminMonitorState["currentAttempt"]>): AdminMonitorState {
  return {
    status: "connected",
    snapshot: apiSnapshot,
    attemptedAt: attempt.at,
    lastSuccessAt: apiSnapshot.capturedAt,
    nextPollAt: null,
    consecutiveFailures: 0,
    currentAttempt: attempt,
  };
}

test("API records and dataset labels require a new current context after entry or context failure", () => {
  const staleContext = monitorStateWithAttempt({
    at: "2026-10-10T07:59:59.000Z",
    context: apiSnapshot.context,
    probes: [],
  });
  const baselineAttempt = staleContext.currentAttempt;
  const entryBaseline = currentApiObservation(staleContext, baselineAttempt);
  assert.equal(entryBaseline.snapshot, null);
  assert.equal(entryBaseline.context, null);

  const currentContextFailure = monitorStateWithAttempt({
    at: "2026-10-10T07:59:59.000Z",
    context: null,
    probes: [],
  });
  const failedContext = currentApiObservation(currentContextFailure, baselineAttempt);
  assert.equal(failedContext.isCurrentAttempt, true);
  assert.equal(failedContext.currentAttempt?.at, baselineAttempt?.at, "attempt timestamps can collide at millisecond precision");
  assert.notEqual(failedContext.currentAttempt, baselineAttempt);
  assert.equal(failedContext.snapshot, null);
  assert.equal(failedContext.context, null);

  const currentDemoContext = monitorStateWithAttempt({
    at: "2026-10-10T08:00:02.000Z",
    context: apiSnapshot.context,
    probes: [],
  });
  const loadingDemoContext = { ...currentDemoContext, status: "loading" as const };
  const loadingObservation = currentApiObservation(loadingDemoContext, baselineAttempt);
  assert.equal(loadingObservation.context?.dataset_mode, "demo");
  assert.equal(loadingObservation.snapshot, null, "a new context cannot unlock prior event and geometry payloads while other probes are pending");

  const validContext = currentApiObservation(currentDemoContext, baselineAttempt);
  assert.equal(validContext.snapshot, apiSnapshot);
  assert.equal(validContext.context?.dataset_mode, "demo");
});

test("public inspector keeps lifecycle, freshness, date precision, validity, and browser retrieval distinct", () => {
  const publicItem: AdminItem = {
    ...mapped,
    id: "public-event-101",
    title: "Pemberitahuan publik contoh",
    geometryBasis: "source_supported",
    publicEventId: "event-101",
    datasetKind: "synthetic",
    eventVersion: 3,
    observedAt: "2026-10-10T07:50:00.000Z",
    fetchedAt: "2026-10-10T08:00:00.000Z",
    publishedAt: "2026-10-10T07:45:00.000Z",
    publicStatus: {
      lifecycle: "resolved",
      freshness: {
        status: "needs_update",
        evaluated_at: "2026-10-10T07:55:00.000Z",
        review_due_at: "2026-10-10T10:00:00.000Z",
        basis: "manual_review",
      },
      eventTime: { start: "2026-10-09", end: null, precision: "date" },
      validity: { valid_from: "2026-10-09T10:00:00.000Z", valid_until: null },
    },
    publicSources: [{
      displayName: "BMKG",
      url: "https://www.bmkg.go.id/",
      publishedAt: "2026-10-09T09:30:00.000Z",
      observedAt: "2026-10-09T10:30:00.000Z",
    }],
  };
  const html = renderToStaticMarkup(<AdminRecordInspector item={publicItem} mode="public_api" geometryKnown />);

  assert.match(html, /Status laporan<\/dt><dd>Selesai<\/dd>/);
  assert.match(html, /Kondisi informasi<\/dt><dd>Perlu diperbarui<\/dd>/);
  assert.match(html, /tanggal saja/);
  assert.match(html, /Mulai 9 Okt 2026.*; akhir tidak dinyatakan/);
  assert.match(html, /Browser membaca data/);
  assert.match(html, /Terbit pada data publik/);
  assert.match(html, /Lokasi di peta<\/dt><dd>Sesuai lokasi dari sumber<\/dd>/);
  assert.match(html, /href="https:\/\/www\.bmkg\.go\.id\/" referrerPolicy="no-referrer"/);
  assert.match(html, /Sumber terbit/);
  assert.match(html, /Sumber diamati/);
  assert.match(html, /Laporan publik lengkap dapat memuat tautan lain/);
  assert.match(html, /href="#detail\/api\/event-101"/);
  assert.match(html, /Data internal yang tidak tersedia/);
  assert.doesNotMatch(html, /Prioritas pemrosesan contoh|Perlu perhatian dalam contoh|Urutan biasa|Tertahan dalam contoh/);
  assert.doesNotMatch(html, /Kelayakan publikasi: layak/u);

  const cappedItem = { ...publicItem, publicSources: Array.from({ length: 21 }, () => publicItem.publicSources?.[0] ?? {
    displayName: "BMKG",
    url: "https://www.bmkg.go.id/",
    publishedAt: null,
    observedAt: null,
  }) };
  const cappedHtml = renderToStaticMarkup(<AdminRecordInspector item={cappedItem} mode="public_api" geometryKnown />);
  assert.equal((cappedHtml.match(/href="https:\/\/www\.bmkg\.go\.id\/"/g) ?? []).length, 20);
});

test("simulation processing priority appears inside its named disclosure with a clear limit", () => {
  const html = renderToStaticMarkup(<AdminRecordInspector item={unmapped} mode="simulation" geometryKnown />);
  const disclosure = html.match(/<details class="admin-disclosure admin-inspector__disclosure"><summary>Urutan contoh dan batasnya<\/summary>([\s\S]*?)<\/details>/);

  assert.ok(disclosure, "priority details remain under the keyboard-accessible native disclosure summary");
  assert.match(disclosure[1], /<dt>Prioritas pemrosesan contoh<\/dt><dd>Perlu perhatian dalam contoh<\/dd>/);
  assert.match(disclosure[1], /Prioritas ini hanya menunjukkan urutan kerja dalam contoh, bukan tingkat bahaya atau keparahan\./);
});

test("API layer cards retain only explicitly observed public summaries", () => {
  const measured: AdminLayerSummary[] = [
    { layer: "L1", name: "Konteks", description: "Sumber pada konteks publik.", availability: "observed", count: 2, state: "ready", note: "Dikembalikan oleh konteks." },
    { layer: "L2", name: "Pencarian", description: "Internal.", availability: "observed", count: 8, state: "ready", note: "Tidak boleh ditampilkan." },
    { layer: "L3", name: "Investigasi", description: "Internal.", availability: "simulated", count: 3, state: "ready", note: "Tidak boleh ditampilkan." },
    { layer: "L4", name: "Event", description: "Record publik pada halaman.", availability: "observed", count: 5, state: "attention", note: "Batas halaman API." },
    { layer: "L5", name: "Probe", description: "Probe browser.", availability: "observed", count: 3, state: "ready", note: "Permintaan terukur di browser." },
  ];
  const layers = displayedLayers({ ...apiSnapshot, layers: measured }, "public_api");

  assert.deepEqual(layers.map(({ layer, availability, count }) => ({ layer, availability, count })), [
    { layer: "L1", availability: "observed", count: 2 },
    { layer: "L2", availability: "unavailable", count: null },
    { layer: "L3", availability: "unavailable", count: null },
    { layer: "L4", availability: "observed", count: 5 },
    { layer: "L5", availability: "observed", count: 3 },
  ]);
});

test("additional source geometries count as mapped while unmapped records remain in the queue", () => {
  const multiGeometry: AdminItem = {
    ...mapped,
    id: "public-event-two-shapes",
    geometry: null,
    additionalGeometries: [{ type: "Point", coordinates: [106.83, -6.2] }],
    geometryBasis: "source_supported",
  };

  assert.deepEqual(countAdminGeometry([unmapped, multiGeometry]), { mapped: 1, unmapped: 1, unknown: 0, total: 2 });
  assert.deepEqual(countAdminGeometry([unmapped, multiGeometry], false), { mapped: null, unmapped: null, unknown: 2, total: 2 });
});

test("default render explains the fictional example and keeps details in closed disclosures", () => {
  const html = renderToStaticMarkup(<AdminDashboard />);

  assert.equal((html.match(/<main\b/g) ?? []).length, 1);
  assert.match(html, /<main id="main-content" tabindex="-1"/);
  assert.match(html, /Pilih laporan untuk melihat sumber, waktu, status informasi, dan lokasinya di peta\./);
  assert.match(html, /Semua laporan dan lokasi di sini adalah rekaan\./);
  assert.match(html, /Contoh tampilan/);
  assert.match(html, /Data aplikasi/);
  assert.match(html, /Ada lokasi peta/);
  assert.match(html, /Tidak ada lokasi peta/);
  assert.match(html, /Tinjau bukti publik/);
  assert.match(html, /Rincian proses, sumber, dan pembacaan/);
  assert.doesNotMatch(html, /<details[^>]*\bopen(?:="")?\s*>/);
  assert.doesNotMatch(html, /Terbitkan|Setujui|Mulai akuisisi|Mulai investigasi/u);
  assert.doesNotMatch(html, /Lima lapisan sistem|CRS84|PANTAUAN API|SIMULASI LOKAL · DEMO/u);
});

test("admin workspace renders the 3-column layout with queue, operations map, and record inspector", () => {
  const html = renderToStaticMarkup(<AdminDashboard />);
  assert.match(html, /class="[^"]*\badmin-workspace\b[^"]*"/);
  assert.match(html, /class="admin-queue"/);
  assert.match(html, /class="admin-map-panel"/);
  assert.match(html, /class="admin-inspector"/);
  assert.match(html, /Daftar laporan/);
  assert.match(html, /Peta laporan/);
  assert.match(html, /Detail laporan/);
});
