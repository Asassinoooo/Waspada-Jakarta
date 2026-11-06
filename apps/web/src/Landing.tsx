import React from "react";
import type { EventView, PublicContext } from "@waspada/worker/public-contracts";
import { HeroIllustration } from "./HeroIllustration.js";

type LandingStatus = "loading" | "loaded" | "unavailable";
type LandingContextStatus = "loading" | "loaded" | "unavailable";

export interface LandingProps {
  context?: PublicContext | null;
  contextStatus?: LandingContextStatus;
  events?: readonly EventView[];
  status?: LandingStatus;
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

export function Landing(_props: LandingProps = {}) {
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
