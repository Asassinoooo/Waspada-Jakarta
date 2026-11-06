import React from "react";
import type { EventView, PublicContext } from "@waspada/worker/public-contracts";
import { categoryLabel, evidenceLabel, formatDate, formatInstant } from "./display.js";
import { HeroIllustration } from "./HeroIllustration.js";

type LandingStatus = "loading" | "loaded" | "unavailable";
type LandingContextStatus = "loading" | "loaded" | "unavailable";

export interface LandingProps {
  context: PublicContext | null;
  contextStatus?: LandingContextStatus;
  events: readonly EventView[];
  status: LandingStatus;
  onRetry?: () => void;
}

const guideItems = [
  {
    id: "laporan",
    label: "Laporan",
    heading: "Mulai dari apa yang dilaporkan",
    body: "Baca ringkasan lalu buka detail untuk melihat uraian, cakupan, status, dan waktu kejadian. Informasi yang tidak diketahui tetap ditandai.",
  },
  {
    id: "bukti",
    label: "Bukti",
    heading: "Periksa sumber untuk tiap klaim",
    body: "Lihat label bukti, nama sumber, tautan, dan waktu yang dicantumkan. Label menerangkan jenis dukungan; bukan nilai keyakinan model.",
  },
  {
    id: "konteks",
    label: "Konteks",
    heading: "Bandingkan waktu dan batas informasi",
    body: "Waktu kejadian, waktu terbit sumber, masa berlaku, dan waktu data diterima menjelaskan hal berbeda. Status kesegaran membantu membaca kebutuhan peninjauan, bukan memastikan kondisi saat ini.",
  },
] as const;

type GuideId = (typeof guideItems)[number]["id"];

function lifecycleText(value: EventView["lifecycle"]) {
  switch (value) {
    case "planned":
      return "Direncanakan";
    case "ongoing":
      return "Berlangsung";
    case "resolved":
      return "Selesai";
    case "cancelled":
      return "Dibatalkan";
    case "unknown":
      return "Belum diketahui";
  }
}

function freshnessText(value: EventView["freshness"]["status"]) {
  switch (value) {
    case "current":
      return "Pembaruan dalam batas waktu";
    case "needs_update":
      return "Perlu diperbarui";
    case "expired":
      return "Masa berlaku sumber berakhir";
  }
}

function eventTimeText(event: EventView) {
  const { start, end, precision } = event.event_time;
  if (precision === "unknown" || !start) return "Waktu kejadian tidak diketahui";

  const format = precision === "date" ? formatDate : formatInstant;
  const first = format(start);
  if (end) {
    const last = format(end);
    return first + " sampai " + last + (precision === "date" ? " · rentang tanggal" : " · rentang waktu");
  }
  if (precision === "date") return first + " · tanggal saja";
  if (precision === "range") return first + " · rentang waktu";
  return first + " · waktu tepat";
}

function datasetText(context: PublicContext) {
  if (context.dataset_mode === "live") return "Record dari API · mode live";
  if (context.dataset_label === "historical") return "Contoh historis · mode demo";
  return "Data sintetis · mode demo";
}

function eventDetailHref(eventId: string) {
  return "#detail/api/" + encodeURIComponent(eventId);
}

export function Landing({ context, contextStatus, events, status, onRetry }: LandingProps) {
  const [selectedGuide, setSelectedGuide] = React.useState<GuideId>("laporan");
  const selectedItem = guideItems.find((item) => item.id === selectedGuide) ?? guideItems[0];

  return (
    <main id="main-content" className="main-shell landing-shell" tabIndex={-1}>
      <section className="landing-hero" aria-labelledby="landing-title">
        <div className="landing-hero__copy">
          <p className="landing-kicker">Informasi publik Jakarta</p>
          <h1 id="landing-title">Pahami Jakarta sebelum melangkah.</h1>
          <p className="landing-hero__summary">
            Baca laporan, waktu kejadian, dan bukti untuk memahami dampak pada aktivitasmu.
          </p>
          <div className="landing-hero__actions">
            <a className="landing-button landing-button--primary" href="#jelajah">Jelajahi laporan</a>
            <a className="landing-button landing-button--secondary" href="#ringkasan-saya">Atur minat <span>(opsional)</span></a>
          </div>
          <p className="landing-hero__access">Jelajah laporan publik tanpa akun. Minat tidak perlu diatur untuk mulai membaca.</p>
        </div>
        <HeroIllustration />
      </section>

      <section className="landing-guide" id="panduan" aria-labelledby="landing-guide-title">
        <div className="landing-section-heading">
          <p className="landing-kicker">Cara membaca informasi</p>
          <h2 id="landing-guide-title">Laporan · Bukti · Konteks</h2>
          <p>Gunakan panduan singkat ini untuk membaca setiap bagian. Ini bukan hasil pemeriksaan atau verifikasi otomatis.</p>
        </div>
        <div className="landing-guide__layout">
          <div className="landing-guide__choices" role="group" aria-label="Pilih topik panduan">
            {guideItems.map((item) => (
              <button
                key={item.id}
                className="landing-guide__choice"
                type="button"
                aria-pressed={selectedGuide === item.id}
                aria-controls="landing-guide-panel"
                onClick={() => setSelectedGuide(item.id)}
              >
                <span>{item.label}</span>
                <span aria-hidden="true">{selectedGuide === item.id ? "—" : "+"}</span>
              </button>
            ))}
          </div>
          <article
            className="landing-guide__panel"
            id="landing-guide-panel"
            aria-live="polite"
            aria-atomic="true"
            aria-labelledby="landing-guide-panel-title"
          >
            <p className="landing-guide__eyebrow">Panduan membaca</p>
            <h3 id="landing-guide-panel-title">{selectedItem.heading}</h3>
            <p>{selectedItem.body}</p>
          </article>
        </div>
      </section>
    </main>
  );
}
