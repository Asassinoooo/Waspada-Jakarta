import type { EventView, PublicContext } from "@waspada/worker/public-contracts";
import { categoryLabel, evidenceLabel, formatEventTime, formatInstant, freshnessLabel, lifecycleLabel } from "./display.js";
import { documentedPresentationFixture as presentation } from "./presentation-fixture.js";
import { MapPanel } from "./MapPanel.js";

interface EventDetailProps {
  mode: "presentation" | "api-event";
  event?: EventView;
  context: PublicContext | null;
}

function PresentationDetail() {
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
              <div><dt>Waktu kejadian</dt><dd>{formatInstant(event.eventTime.start)} · presisi tepat menurut fixture</dd></div>
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
            <div><dt>Waktu event</dt><dd><time dateTime={event.eventTime.start}>{formatInstant(event.eventTime.start)}</time> · {event.eventTime.precision}</dd></div>
            <div><dt>Validitas issuer</dt><dd><time dateTime={event.validity.validFrom}>{formatInstant(event.validity.validFrom)}</time> sampai <time dateTime={event.validity.validUntil}>{formatInstant(event.validity.validUntil)}</time></dd></div>
            <div><dt>Event diterbitkan</dt><dd><time dateTime={event.publishedAt}>{formatInstant(event.publishedAt)}</time></dd></div>
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

          <MapPanel selection={{ kind: "presentation" }} onReturnToList={() => { window.location.hash = "#jelajah"; }} />
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

function ApiEventDetail({ event, context }: { event: EventView; context: PublicContext | null }) {
  return (
    <>
      <section className="detail-heading" aria-labelledby="detail-title">
        <p className="section-kicker">Detail dari API lokal</p>
        <h1 id="detail-title">{event.title}</h1>
        <p>{event.summary}</p>
        <div className="fixture-notice" role="note">
          Record ini sintetis. API lokal belum menyediakan klaim, geometri, atau riwayat detail untuk record ini.
        </div>
      </section>

      <section className="status-grid" aria-label="Dimensi status yang terpisah">
        <div className="status-cell"><dt>Siklus</dt><dd>{lifecycleLabel(event.lifecycle)}</dd></div>
        <div className="status-cell"><dt>Kesegaran</dt><dd>{freshnessLabel(event.freshness.status)}</dd><small>Evaluasi {formatInstant(event.freshness.evaluated_at)}; basis {event.freshness.basis.replaceAll("_", " ")}.</small></div>
        <div className="status-cell"><dt>Bukti</dt><dd>{evidenceLabel(event.claims[0]?.evidence_label)}</dd></div>
        <div className="status-cell"><dt>Relevansi</dt><dd>Tidak dinilai</dd><small>Minat pengguna tidak digunakan.</small></div>
      </section>

      <div className="detail-columns">
        <section className="detail-panel" aria-labelledby="api-facts-heading">
          <div className="panel-heading">
            <div><p className="section-kicker">Proyeksi publik</p><h2 id="api-facts-heading">Waktu dan cakupan</h2></div>
            <span className="synthetic-label">Contoh API</span>
          </div>
          <dl className="detail-facts detail-facts--spacious">
            <div><dt>Waktu kejadian</dt><dd>{formatEventTime(event)}</dd></div>
            <div><dt>Validitas</dt><dd>{event.validity.valid_from || event.validity.valid_until
              ? <>{event.validity.valid_from ? formatInstant(event.validity.valid_from) : "Tidak ada waktu awal"} sampai {event.validity.valid_until ? formatInstant(event.validity.valid_until) : "Tidak ada waktu akhir"}</>
              : "Tidak tersedia pada record"}</dd></div>
            <div><dt>Event diterbitkan</dt><dd><time dateTime={event.published_at}>{formatInstant(event.published_at)}</time></dd></div>
            <div><dt>Respons API dibuat</dt><dd>{formatInstant(context?.generated_at)}</dd></div>
            <div><dt>Waktu pengambilan sumber</dt><dd>Tidak disediakan oleh proyeksi API publik</dd></div>
            <div><dt>Cakupan tempat/layanan</dt><dd>{event.scope.places.concat(event.scope.services, event.scope.institutions, event.scope.audiences).join(", ") || "Tidak tersedia pada record"}</dd></div>
          </dl>
        </section>

        <section className="detail-panel" aria-labelledby="api-claim-heading">
          <div className="panel-heading">
            <div><p className="section-kicker">Klaim per sumber</p><h2 id="api-claim-heading">Bukti</h2></div>
          </div>
          {event.claims.length === 0 ? (
            <div className="state-panel state-panel--compact" role="note">
              <strong>Belum ada klaim pada proyeksi ini.</strong>
              <p>Jangan menganggap ringkasan sebagai bukti; waktu sumber, kutipan, dan atribusi tidak tersedia.</p>
            </div>
          ) : (
            <div className="claims-list">
              {event.claims.map((claim) => (
                <article className="claim-card" key={claim.claim_id}>
                  <span className="claim-card__label">{evidenceLabel(claim.evidence_label)}</span>
                  <blockquote>{claim.text}</blockquote>
                  <p>Waktu kejadian claim: {formatEventTime({ event_time: claim.event_time })}</p>
                  {claim.qualifiers.length > 0 && <p className="qualifier">{claim.qualifiers.join(" ")}</p>}
                  {claim.sources.map((source) => (
                    <div className="source-record" key={source.url}>
                      <h3>{source.display_name}</h3>
                      <p>Dipublikasikan: {formatInstant(source.published_at)} · diamati: {formatInstant(source.observed_at)}</p>
                      {source.excerpt && <blockquote className="source-excerpt">{source.excerpt}</blockquote>}
                      <a className="text-link" href={source.url} target="_blank" rel="noreferrer">Buka sumber publik</a>
                    </div>
                  ))}
                </article>
              ))}
            </div>
          )}
        </section>
      </div>

      <div className="detail-columns detail-columns--bottom">
        <MapPanel
          selection={{ kind: "api-event", event }}
          onReturnToList={() => { window.location.hash = "#jelajah"; }}
        />
        <section className="detail-panel history-panel" aria-labelledby="api-history-heading">
          <div className="panel-heading">
            <div><p className="section-kicker">Riwayat event</p><h2 id="api-history-heading">Perubahan</h2></div>
            <span className="count-chip">Versi {event.version}</span>
          </div>
          <div className="state-panel state-panel--compact" role="note">
            <strong>Riwayat perubahan belum tersedia di demo lokal.</strong>
            <p>Record ini memuat versi dan waktu publikasi, tetapi API lokal tidak menyediakan endpoint riwayat event.</p>
          </div>
        </section>
      </div>
    </>
  );
}

export function EventDetail({ mode, event, context }: EventDetailProps) {
  return (
    <main id="main-content" className="main-shell detail-page">
      <a className="back-link" href="#jelajah">Kembali ke daftar</a>
      {mode === "presentation"
        ? <PresentationDetail />
        : event
          ? <ApiEventDetail event={event} context={context} />
          : <div className="state-panel"><strong>Record tidak ditemukan.</strong><p>Kembali ke daftar contoh API.</p></div>}
    </main>
  );
}
