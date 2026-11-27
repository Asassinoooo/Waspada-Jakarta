// PERF-09b: the demo presentation detail (`#detail/presentation`, demo dataset only). EventDetail loads it on demand, so
// its synthetic fixture and the fixture's map panel stay out of the map home's first chunk.
import { categoryLabel, evidenceLabel, eventTimeText, formatInstant, freshnessLabel, lifecycleLabel } from "./display.js";
import { documentedPresentationFixture as presentation } from "./presentation-fixture.js";
import { MapPanel } from "./GeoMapPanel.js";

export function PresentationDetail() {
  const event = presentation.event;
  const claim = presentation.claim;
  const source = presentation.source;

  return (
    <>
      <section className="detail-heading" aria-labelledby="detail-title">
        <p className="section-kicker">Contoh detail terpisah dari API</p>
        <h1 id="detail-title">{event.title}</h1>
        <p>{event.summary}</p>
        <div className="fixture-notice" role="note">
          Nilai di bawah berasal dari fixture dokumentasi schema 2.0. Ini contoh presentasi sintetis, bukan data API atau peringatan.
        </div>
      </section>

      <section className="status-grid" aria-label="Dimensi status yang terpisah">
        <div className="status-cell"><dt>Siklus</dt><dd>{lifecycleLabel(event.lifecycle)}</dd></div>
        <div className="status-cell"><dt>Kesegaran</dt><dd>{freshnessLabel(event.freshness.status)}</dd><small>Dihitung pada {formatInstant(event.freshness.evaluatedAt)} dalam fixture.</small></div>
        <div className="status-cell"><dt>Bukti</dt><dd>{evidenceLabel(claim.evidenceLabel)}</dd></div>
        <div className="status-cell"><dt>Relevansi</dt><dd>Tidak dinilai</dd><small>Contoh ini tidak memakai minat pengguna.</small></div>
      </section>

      <div className="detail-columns">
        <section className="detail-panel" aria-labelledby="claim-heading">
          <div className="panel-heading">
            <div><p className="section-kicker">Klaim dan sumber</p><h2 id="claim-heading">Bukti per klaim</h2></div>
            <span className="fixture-chip">Fixture</span>
          </div>
          <article className="claim-card">
            <span className="claim-card__label">{evidenceLabel(claim.evidenceLabel)} · nilai fixture</span>
            <blockquote>{claim.text}</blockquote>
            <p className="qualifier">{claim.qualifier}</p>
            <dl className="detail-facts">
              <div><dt>Waktu kejadian</dt><dd>{eventTimeText(event.eventTime)}</dd></div>
              <div><dt>Siklus event</dt><dd>{lifecycleLabel(event.lifecycle)}</dd></div>
              <div><dt>Status dukungan</dt><dd>Span fixture ditandai mendukung klaim</dd></div>
              <div><dt>Bukti bertentangan</dt><dd>Daftar fixture kosong; tidak menilai keadaan nyata</dd></div>
            </dl>
          </article>

          <div className="source-record">
            <h3>{source.displayName}</h3>
            <p className="source-record__type">Sumber dan isi di bawah hanya berada dalam fixture sintetik.</p>
            <dl className="detail-facts">
              <div><dt>Waktu sumber diterbitkan</dt><dd><time dateTime={source.publishedAt}>{formatInstant(source.publishedAt)}</time></dd></div>
              <div><dt>Waktu sistem mengambil sumber</dt><dd><time dateTime={source.retrievedAt}>{formatInstant(source.retrievedAt)}</time></dd></div>
              <div><dt>Waktu observasi</dt><dd>Tidak ada dalam fixture</dd></div>
              <div><dt>URL fixture</dt><dd className="url-text">{source.url} · domain contoh .invalid, bukan tautan live</dd></div>
            </dl>
            <blockquote className="source-excerpt">{source.permittedText}</blockquote>
            <p className="span-note">
              Span {source.evidenceSpan.start}–{source.evidenceSpan.end} {source.evidenceSpan.offsetUnit.replaceAll("_", " ")} ditandai mendukung.
            </p>
          </div>
        </section>

        <section className="detail-panel" aria-labelledby="impact-heading">
          <div className="panel-heading">
            <div><p className="section-kicker">Cakupan dan dampak</p><h2 id="impact-heading">Detail yang didukung fixture</h2></div>
          </div>

          <dl className="detail-facts detail-facts--spacious">
            <div><dt>Kategori</dt><dd>{categoryLabel(event.category)}</dd></div>
            <div><dt>Waktu event</dt><dd><time dateTime={event.eventTime.start}>{eventTimeText(event.eventTime)}</time> · {event.eventTime.precision}</dd></div>
            <div><dt>Validitas issuer</dt><dd><time dateTime={event.validity.validFrom}>{formatInstant(event.validity.validFrom)}</time> sampai <time dateTime={event.validity.validUntil}>{formatInstant(event.validity.validUntil)}</time></dd></div>
            <div><dt>Peristiwa diterbitkan</dt><dd><time dateTime={event.publishedAt}>{formatInstant(event.publishedAt)}</time></dd></div>
            <div><dt>Evaluasi freshness fixture</dt><dd><time dateTime={event.freshness.evaluatedAt}>{formatInstant(event.freshness.evaluatedAt)}</time></dd></div>
            <div><dt>Basis freshness</dt><dd>Validitas sumber (nilai fixture)</dd></div>
          </dl>

          <div className="impact-summary">
            <span className="impact-marker" aria-hidden="true">↗</span>
            <div>
              <strong>{presentation.impact.title}</strong>
              <p>{presentation.impact.description}</p>
              <span>Jenis dampak fixture: {presentation.impact.type.replaceAll("_", " ")}</span>
            </div>
          </div>

          <MapPanel selection={{ kind: "presentation" }} onReturnToList={() => { window.location.hash = "#peta"; }} />
        </section>
      </div>

      <section className="detail-panel history-panel" aria-labelledby="history-heading">
        <div className="panel-heading">
          <div><p className="section-kicker">Versi publik dalam contoh</p><h2 id="history-heading">Riwayat versi</h2></div>
          <span className="count-chip">Versi {event.version}</span>
        </div>
        <p className="history-current">
          Fixture mencantumkan versi {event.version} dengan waktu terbit {formatInstant(event.publishedAt)}. Ini bukan riwayat perubahan sebelumnya.
        </p>
        <div className="state-panel state-panel--compact" role="note">
          <strong>Tidak ada perubahan terdahulu di contoh ini.</strong>
          <p>{presentation.openApiHistoryNote} Tidak ada koreksi atau pembaruan yang ditambahkan oleh UI.</p>
        </div>
      </section>
    </>
  );
}
