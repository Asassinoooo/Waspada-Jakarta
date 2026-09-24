import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { EventView, PublicContext } from "@waspada/worker/public-contracts";
import { SiteHeader } from "../src/App.js";
import { EventDetail } from "../src/EventDetail.js";
import { EventFeed } from "../src/EventFeed.js";
import { ModeratorReview } from "../src/ModeratorReview.js";
import type { MapSelection } from "../src/MapPanel.js";

const demoContext: PublicContext = {
  dataset_mode: "demo",
  dataset_label: "synthetic",
  generated_at: "2026-09-24T10:00:00.000Z",
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

function renderFeed(options: { status?: "loading" | "loaded" | "unavailable"; events?: EventView[]; query?: string; selection?: MapSelection } = {}) {
  return renderToStaticMarkup(
    <EventFeed
      status={options.status ?? "loaded"}
      events={options.events ?? [sampleEvent]}
      context={demoContext}
      query={options.query ?? ""}
      onQueryChange={() => {}}
      onRetry={() => {}}
      mapSelection={options.selection ?? { kind: "presentation" }}
      onSelectApiEvent={() => {}}
      onSelectPresentation={() => {}}
      mobilePanel="list"
      onMobilePanelChange={() => {}}
    />,
  );
}

test("persistent shell and discovery expose synthetic dataset and linked list/map controls", () => {
  const header = renderToStaticMarkup(<SiteHeader route={{ screen: "discover" }} />);
  const page = renderFeed();

  assert.match(header, /DEMO — data sintetis; bukan peringatan langsung/);
  assert.match(header, /Tidak ada sumber live yang terhubung/);
  assert.match(header, /Lewati ke konten utama/);
  assert.match(page, /Contoh fiktif: pemberitahuan kelompok/);
  assert.match(page, /aria-label="Tampilan jelajah"/);
  assert.match(page, /aria-pressed="true">Daftar/);
  assert.match(page, /aria-pressed="false">Peta/);
  assert.match(page, /Siklus/);
  assert.match(page, /Kesegaran/);
  assert.match(page, /Bukti/);
  assert.match(page, /Relevansi/);
  const selectedApi = renderFeed({ selection: { kind: "api-event", event: sampleEvent } });
  assert.match(selectedApi, /Tidak dipetakan/);
  assert.match(page, /106\.8, -6\.2 → 106\.81, -6\.21/);
});

test("loading, empty, and unavailable states give honest next steps", () => {
  const loading = renderFeed({ status: "loading", events: [] });
  const empty = renderFeed({ events: [] });
  const noMatch = renderFeed({ query: "tidak-ada" });
  const unavailable = renderFeed({ status: "unavailable", events: [] });

  assert.match(loading, /Memuat record sintetis/);
  assert.match(empty, /bukan pernyataan bahwa area aman/);
  assert.match(noMatch, /Tidak ada laporan yang cocok/);
  assert.match(unavailable, /keadaan keselamatan tidak diketahui/);
  assert.match(unavailable, />Coba lagi</);
});

test("documented detail keeps evidence times distinct and does not invent history", () => {
  const markup = renderToStaticMarkup(<EventDetail mode="presentation" context={demoContext} />);

  assert.match(markup, /Contoh detail terpisah dari API/);
  assert.match(markup, /Bus 12 diversion \(synthetic demo\)/);
  assert.match(markup, /Waktu sumber diterbitkan/);
  assert.match(markup, /Waktu sistem mengambil sumber/);
  assert.match(markup, /URL fixture/);
  assert.match(markup, /Tidak ada perubahan terdahulu di contoh ini/);
  assert.match(markup, /data: \[\]/);
  assert.match(markup, /Jalan Contoh \(synthetic\)/);
  assert.doesNotMatch(markup, /<a[^>]+example\.invalid/);
});

test("API detail preserves unknown fields as unknown and has no invented geometry", () => {
  const markup = renderToStaticMarkup(
    <EventDetail mode="api-event" event={sampleEvent} context={demoContext} />,
  );

  assert.match(markup, /Detail dari API lokal/);
  assert.match(markup, /Waktu kejadian tidak diketahui/);
  assert.match(markup, /Tidak tersedia pada record/);
  assert.match(markup, /API lokal belum menyediakan klaim, geometri, atau riwayat/);
  assert.match(markup, /Riwayat perubahan belum tersedia/);
});

test("moderator presentation is explicitly read-only and has no decision controls", () => {
  const markup = renderToStaticMarkup(<ModeratorReview />);

  assert.match(markup, /Bukan antrean moderator/);
  assert.match(markup, /Pratinjau baca saja/);
  assert.match(markup, /Synthetic Transit Operator/);
  assert.match(markup, /Mendukung klaim fixture/);
  assert.match(markup, /reviewed_synthetic_fixture/);
  assert.doesNotMatch(markup, /<button/);
  assert.doesNotMatch(markup, /Terbitkan klaim|Simpan koreksi|Tolak klaim|Tarik versi/);
});
