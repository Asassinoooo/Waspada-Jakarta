import type { EventView, PublicContext } from "@waspada/worker/public-contracts";

export type FeedStatus = "loading" | "loaded" | "unavailable";

interface EventFeedProps {
  status: FeedStatus;
  events: EventView[];
  context: PublicContext | null;
}

export function EventFeed({ status, events, context }: EventFeedProps) {
  return (
    <main className="page-shell">
      <header className="page-header">
        <div>
          <p className="eyebrow">Situasi dan informasi publik</p>
          <h1>Waspada Jakarta</h1>
        </div>
        <span className="mode-chip">Mode demo</span>
      </header>

      <section className="demo-banner" aria-label="Peringatan mode demo">
        <span aria-hidden="true">DEMO</span>
        <strong>DEMO — data sintetis; bukan peringatan langsung</strong>
      </section>

      <section className="intro" aria-labelledby="feed-heading">
        <div>
          <h2 id="feed-heading">Daftar contoh</h2>
          <p>
            Contoh ini hanya menunjukkan bentuk tampilan. Tidak ada sumber live,
            laporan nyata, atau penilaian kondisi keselamatan yang terhubung.
          </p>
        </div>
        <div className="source-status" aria-live="polite">
          <span className="status-dot" aria-hidden="true" />
          {context?.sources.length === 0
            ? "Tidak ada sumber live yang terhubung"
            : "Status sumber tidak tersedia"}
        </div>
      </section>

      {status === "loading" && (
        <p className="state-panel" role="status">
          Memuat contoh sintetis…
        </p>
      )}

      {status === "unavailable" && (
        <p className="state-panel state-panel--unavailable" role="alert">
          API lokal tidak dapat dihubungi. Data belum tersedia; keadaan
          keselamatan tidak diketahui.
        </p>
      )}

      {status === "loaded" && events.length === 0 && (
        <p className="state-panel" role="status">
          Belum ada data untuk tampilan ini. Kekosongan data tidak berarti area
          aman.
        </p>
      )}

      {status === "loaded" && events.length > 0 && (
        <section className="event-list" aria-label="Contoh data sintetis">
          {events.map((event) => (
            <article className="event-card" key={event.event_id}>
              <div className="event-card__meta">
                <span className="synthetic-tag">Contoh sintetis</span>
                <span className="event-card__state">Status tidak diketahui</span>
              </div>
              <h3>{event.title}</h3>
              <p>{event.summary}</p>
              <p className="event-card__footnote">
                Waktu, lokasi, klaim, dan dampak tidak tersedia pada contoh ini.
              </p>
            </article>
          ))}
        </section>
      )}

      <footer className="page-footer">
        <span>Dataset: {context?.dataset_label ?? "demo"}</span>
        <span>Contoh lokal, tanpa data langsung</span>
      </footer>
    </main>
  );
}
