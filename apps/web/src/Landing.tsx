import React from "react";
import type { EventView, PublicContext } from "@waspada/worker/public-contracts";
import { categoryLabel, evidenceLabel, formatDate, formatInstant } from "./display.js";
import { HeroIllustration } from "./HeroIllustration.js";

type LandingStatus = "loading" | "loaded" | "unavailable";

export interface LandingProps {
  context: PublicContext | null;
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
      return "Batas tinjau lewat";
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

function PublicPreview({
  context,
  events,
  status,
  onRetry,
}: Pick<LandingProps, "context" | "events" | "status" | "onRetry">) {
  let content;

  if (context === null) {
    content = (
      <div className="landing-state" role="status">
        <strong>Mode data belum dapat diverifikasi.</strong>
        <p>Laporan disembunyikan sampai status dataset tersedia. Ini tidak menyatakan kondisi aman.</p>
        {onRetry && <button className="landing-button landing-button--quiet" type="button" onClick={onRetry}>Coba lagi</button>}
      </div>
    );
  } else if (status === "loading") {
    content = (
      <div className="landing-state" role="status" aria-busy="true">
        <span className="landing-state__rule" aria-hidden="true" />
        <strong>Memuat laporan publik…</strong>
        <p>Informasi yang tersedia belum menggambarkan seluruh kondisi Jakarta.</p>
      </div>
    );
  } else if (status === "unavailable") {
    content = (
      <div className="landing-state landing-state--error" role="alert">
        <strong>Laporan belum dapat dimuat.</strong>
        <p>Keadaan terbaru tidak diketahui. Kegagalan memuat data bukan pernyataan bahwa wilayah aman.</p>
        {onRetry && <button className="landing-button landing-button--quiet" type="button" onClick={onRetry}>Coba lagi</button>}
      </div>
    );
  } else if (events.length === 0) {
    content = (
      <div className="landing-state" role="status">
        <strong>Belum ada laporan pada halaman data ini.</strong>
        <p>Hasil kosong bukan pernyataan bahwa kondisi wilayah aman.</p>
      </div>
    );
  } else {
    content = (
      <>
        <p className="landing-preview__dataset">
          {datasetText(context)}
          {context.dataset_mode === "demo" && <span> · bukan peringatan langsung</span>}
        </p>
        <ul className="landing-report-list" aria-label="Cuplikan laporan publik yang dimuat">
          {events.slice(0, 3).map((event) => {
            const firstClaim = event.claims[0];
            const sourceName = firstClaim?.sources[0]?.display_name;
            return (
              <li key={event.event_id + ":" + event.version}>
                <article className="landing-report">
                  <p className="landing-report__category">{categoryLabel(event.category)}</p>
                  <h3><a href={eventDetailHref(event.event_id)}>{event.title}</a></h3>
                  <p className="landing-report__summary">{event.summary}</p>
                  <dl className="landing-report__facts">
                    <div><dt>Siklus</dt><dd>{lifecycleText(event.lifecycle)}</dd></div>
                    <div><dt>Kesegaran</dt><dd>{freshnessText(event.freshness.status)}</dd></div>
                    <div><dt>Bukti</dt><dd>{evidenceLabel(firstClaim?.evidence_label)}</dd></div>
                    <div><dt>Sumber</dt><dd>{sourceName ?? "Sumber belum tersedia"}</dd></div>
                    <div className="landing-report__time"><dt>Waktu kejadian</dt><dd>{eventTimeText(event)}</dd></div>
                  </dl>
                </article>
              </li>
            );
          })}
        </ul>
        <a className="landing-preview__all" href="#jelajah">Jelajahi semua laporan</a>
      </>
    );
  }

  return (
    <section className="landing-preview" aria-labelledby="landing-preview-title">
      <div className="landing-section-heading">
        <p className="landing-kicker">Informasi yang tersedia</p>
        <h2 id="landing-preview-title">Laporan publik</h2>
        <p>Cuplikan mengikuti halaman data API yang dimuat; ini bukan hitungan seluruh kejadian di Jakarta.</p>
      </div>
      {content}
    </section>
  );
}

export function Landing({ context, events, status, onRetry }: LandingProps) {
  const [selectedGuide, setSelectedGuide] = React.useState<GuideId>("laporan");
  const selectedItem = guideItems.find((item) => item.id === selectedGuide) ?? guideItems[0];

  return (
    <main id="main-content" className="main-shell landing-shell">
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

      <PublicPreview context={context} events={events} status={status} onRetry={onRetry} />

      <section className="landing-trust" aria-label="Batas informasi">
        <span className="landing-trust__mark" aria-hidden="true">i</span>
        <p>
          Tidak ada laporan, kecocokan, atau pembaruan bukan bukti bahwa wilayah aman. Periksa waktu, sumber, dan batas informasi pada detail laporan.
        </p>
      </section>

      <nav className="landing-footer-links" aria-label="Panduan dan privasi">
        <a href="#panduan">Cara membaca laporan</a>
        <a href="#privasi">Privasi dan data</a>
      </nav>
    </main>
  );
}
