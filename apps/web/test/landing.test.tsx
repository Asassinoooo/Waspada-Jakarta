import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { EventView, PublicContext } from "@waspada/worker/public-contracts";
import { Landing } from "../src/Landing.js";

const demoContext: PublicContext = {
  dataset_mode: "demo",
  dataset_label: "synthetic",
  generated_at: "2026-09-25T04:06:00.000Z",
  sources: [],
};

const historicalDemoContext: PublicContext = {
  ...demoContext,
  dataset_label: "historical",
};

const liveContext: PublicContext = {
  ...demoContext,
  dataset_mode: "live",
  dataset_label: "live",
};

function makeEvent(overrides: Partial<EventView> = {}): EventView {
  return {
    event_id: "public-event-1",
    version: 2,
    title: "Pemberitahuan layanan fiktif",
    summary: "Ringkasan publik dari record uji.",
    category: "transport_road_incidents",
    tags: [],
    lifecycle: "ongoing",
    freshness: {
      status: "current",
      evaluated_at: "2026-09-25T04:06:00.000Z",
      review_due_at: null,
      basis: "manual_review",
    },
    event_time: {
      start: "2026-09-25T04:00:00.000Z",
      end: null,
      precision: "exact",
    },
    validity: { valid_from: null, valid_until: null },
    scope: { places: [], services: [], institutions: [], audiences: [] },
    claims: [{
      claim_id: "claim-1",
      text: "Layanan mengalami perubahan menurut sumber.",
      event_time: { start: null, end: null, precision: "unknown" },
      validity: { valid_from: null, valid_until: null },
      scope: { places: [], services: [], institutions: [], audiences: [] },
      qualifiers: [],
      evidence_label: "issuer_notice",
      sources: [{
        display_name: "Operator layanan",
        url: "https://example.invalid/source",
        published_at: "2026-09-25T04:05:00.000Z",
        observed_at: null,
        excerpt: null,
      }],
    }],
    impacts: [],
    published_at: "2026-09-25T04:06:00.000Z",
    ...overrides,
  };
}

function renderLanding(options: {
  context?: PublicContext | null;
  events?: readonly EventView[];
  status?: "loading" | "loaded" | "unavailable";
  onRetry?: () => void;
} = {}) {
  return renderToStaticMarkup(createElement(Landing, {
    context: options.context === undefined ? demoContext : options.context,
    events: options.events ?? [],
    status: options.status ?? "loaded",
    onRetry: options.onRetry,
  }));
}

test("landing provides direct account-free actions and a captioned illustrative hero", () => {
  const markup = renderLanding();

  assert.match(markup, /Pahami Jakarta sebelum melangkah/);
  assert.match(markup, /href="#jelajah">Jelajahi laporan/);
  assert.match(markup, /href="#ringkasan-saya">Atur minat/);
  assert.match(markup, /href="#panduan">Cara membaca laporan/);
  assert.match(markup, /href="#privasi">Privasi dan data/);
  assert.match(markup, /Jelajah laporan publik tanpa akun/);
  assert.match(markup, /Ilustrasi Jakarta — bukan peta kejadian/);
  assert.match(markup, /landing-river-reveal/);
});

test("unknown dataset context suppresses supplied reports", () => {
  const privateLookingTitle = "Judul yang tidak boleh tampil saat mode belum diketahui";
  const markup = renderLanding({
    context: null,
    events: [makeEvent({ title: privateLookingTitle })],
  });

  assert.match(markup, /Mode data belum dapat diverifikasi/);
  assert.match(markup, /Laporan disembunyikan sampai status dataset tersedia/);
  assert.doesNotMatch(markup, new RegExp(privateLookingTitle));
});

test("demo reports are labelled from the selected dataset and contain no invented map geometry", () => {
  const event = makeEvent({ title: "Contoh laporan dalam demo" });
  const syntheticMarkup = renderLanding({ context: demoContext, events: [event] });
  const historicalMarkup = renderLanding({ context: historicalDemoContext, events: [event] });

  assert.match(syntheticMarkup, /Data sintetis · mode demo/);
  assert.match(syntheticMarkup, /bukan peringatan langsung/);
  assert.match(syntheticMarkup, /Contoh laporan dalam demo/);
  assert.match(historicalMarkup, /Contoh historis · mode demo/);
  assert.doesNotMatch(syntheticMarkup, /latitude|longitude|koordinat|GeoJSON/i);
});

test("live report preview keeps evidence, status, source and event time distinct", () => {
  const markup = renderLanding({ context: liveContext, events: [makeEvent()] });

  assert.match(markup, /Record dari API · mode live/);
  assert.match(markup, /Pemberitahuan layanan fiktif/);
  assert.match(markup, /Berlangsung/);
  assert.match(markup, /Pembaruan dalam batas waktu/);
  assert.match(markup, /Pemberitahuan dari penerbit/);
  assert.match(markup, /Operator layanan/);
  assert.match(markup, /Waktu kejadian/);
  assert.match(markup, /25 Sep 2026/);
  assert.match(markup, /waktu tepat/);
  assert.match(markup, /href="#detail\/api\/public-event-1"/);
  assert.doesNotMatch(markup, /nilai fixture|verified|terverifikasi/i);
});

test("loading, failed, and empty states do not imply safety or reuse old reports", () => {
  const event = makeEvent({ title: "Jangan tampilkan laporan lama" });
  const loading = renderLanding({ status: "loading", events: [event] });
  const unavailable = renderLanding({ status: "unavailable", events: [event], onRetry: () => {} });
  const empty = renderLanding({ status: "loaded", events: [] });

  assert.match(loading, /Memuat laporan publik/);
  assert.doesNotMatch(loading, /Jangan tampilkan laporan lama/);
  assert.match(unavailable, /role="alert"/);
  assert.match(unavailable, /Coba lagi/);
  assert.doesNotMatch(unavailable, /Jangan tampilkan laporan lama/);
  assert.match(empty, /Belum ada laporan pada halaman data ini/);
  assert.match(empty, /bukan pernyataan bahwa kondisi wilayah aman/);
});

test("reading guide uses user-controlled instructional panels without verification claims", () => {
  const markup = renderLanding();

  assert.match(markup, /aria-label="Pilih topik panduan"/);
  assert.match(markup, /aria-pressed="true" aria-controls="landing-guide-panel">.*?Laporan/s);
  assert.match(markup, /Bukti/);
  assert.match(markup, /bukan hasil pemeriksaan atau verifikasi otomatis/);
  assert.match(markup, /Tidak ada laporan, kecocokan, atau pembaruan bukan bukti bahwa wilayah aman/);
  assert.doesNotMatch(markup, /verified|laporan terverifikasi/i);
});
