import { formatInstant } from "./display.js";
import { documentedPresentationFixture as fixture } from "./presentation-fixture.js";
import { MapPanel } from "./MapPanel.js";

export function ModeratorReview() {
  return (
    <main id="main-content" className="main-shell moderator-page">
      <section className="review-heading" aria-labelledby="review-title">
        <div>
          <p className="section-kicker">Ruang tinjau · contoh UI</p>
          <h1 id="review-title">Tinjau bukti</h1>
          <p>Hubungan sumber, klaim, versi, dan geometri ditampilkan berdampingan.</p>
        </div>
        <span className="read-only-stamp">Pratinjau baca saja</span>
      </section>

      <div className="read-only-callout" role="note">
        <strong>Bukan antrean moderator.</strong>
        <span>
          Record di bawah berasal dari fixture dokumentasi, bukan API review. Tidak ada sesi autentikasi atau tindakan tulis pada demo ini.
        </span>
      </div>

      <section className="review-case-heading" aria-label="Identitas kandidat fixture">
        <div>
          <p className="section-kicker">Kandidat dalam contoh kontrak</p>
          <h2>{fixture.event.title}</h2>
          <p>{fixture.fixtureLabel}</p>
        </div>
        <dl>
          <div><dt>ID event</dt><dd>{fixture.event.id}</dd></div>
          <div><dt>Versi</dt><dd>{fixture.event.version}</dd></div>
          <div><dt>Status contoh</dt><dd>{fixture.publicationDecision.status} · nilai fixture</dd></div>
        </dl>
      </section>

      <div className="review-columns">
        <section className="review-evidence" aria-labelledby="source-review-title">
          <header className="review-column-heading">
            <p className="section-kicker">Revision dan asal</p>
            <h2 id="source-review-title">Bukti sumber</h2>
          </header>
          <div className="source-identity">
            <span className="source-mark" aria-hidden="true">S</span>
            <div>
              <strong>{fixture.source.displayName}</strong>
              <p>source_id: {fixture.source.sourceId}</p>
            </div>
          </div>
          <blockquote className="review-quote">{fixture.source.permittedText}</blockquote>
          <dl className="detail-facts detail-facts--spacious">
            <div><dt>Record sumber</dt><dd>{fixture.source.reportRevisionId}</dd></div>
            <div><dt>Waktu diterbitkan</dt><dd><time dateTime={fixture.source.publishedAt}>{formatInstant(fixture.source.publishedAt)}</time></dd></div>
            <div><dt>Waktu diperoleh sistem</dt><dd><time dateTime={fixture.source.retrievedAt}>{formatInstant(fixture.source.retrievedAt)}</time></dd></div>
            <div><dt>Berlaku dalam fixture</dt><dd><time dateTime={fixture.source.validFrom}>{formatInstant(fixture.source.validFrom)}</time> – <time dateTime={fixture.source.validUntil}>{formatInstant(fixture.source.validUntil)}</time></dd></div>
            <div><dt>Alamat fixture</dt><dd className="url-text">{fixture.source.url} · domain .invalid, tidak dikunjungi</dd></div>
          </dl>
          <div className="span-card">
            <span className="span-card__index">Span {fixture.source.evidenceSpan.start}–{fixture.source.evidenceSpan.end}</span>
            <strong>{fixture.source.evidenceSpan.relation === "supports" ? "Mendukung klaim fixture" : "Hubungan tidak diketahui"}</strong>
            <p>Offset {fixture.source.evidenceSpan.offsetUnit.replaceAll("_", " ")}; hash isi {fixture.source.contentHash.slice(0, 16)}…</p>
          </div>
        </section>

        <section className="review-proposal" aria-labelledby="claim-review-title">
          <header className="review-column-heading">
            <p className="section-kicker">Proyeksi event</p>
            <h2 id="claim-review-title">Klaim dan dukungan</h2>
          </header>
          <article className="review-claim">
            <div className="claim-card__label">{fixture.claim.evidenceLabel.replaceAll("_", " ")} · nilai fixture</div>
            <blockquote>{fixture.claim.text}</blockquote>
            <p className="qualifier">{fixture.claim.qualifier}</p>
            <dl className="detail-facts">
              <div><dt>Waktu kejadian</dt><dd><time dateTime={fixture.event.eventTime.start}>{formatInstant(fixture.event.eventTime.start)}</time> · {fixture.event.eventTime.precision}</dd></div>
              <div><dt>Siklus</dt><dd>{fixture.event.lifecycle} · nilai fixture</dd></div>
              <div><dt>Freshness</dt><dd>{fixture.event.freshness.status} pada evaluasi {formatInstant(fixture.event.freshness.evaluatedAt)}</dd></div>
              <div><dt>Asal pendukung</dt><dd>{fixture.claim.originId}</dd></div>
            </dl>
          </article>
          <div className="review-support-grid">
            <div><span>Dukungan</span><strong>{fixture.claim.sourceSupport}</strong></div>
            <div><span>Kontradiksi</span><strong>{fixture.claim.contraryEvidenceCount} tercatat di fixture</strong></div>
            <div><span>Relasi asal</span><strong>{fixture.origin.lineageRelation}</strong></div>
            <div><span>Status independensi</span><strong>{fixture.origin.independenceStatus} · nilai fixture</strong></div>
          </div>
          <p className="review-boundary-note">
            Jumlah dan status di sini menjelaskan record contoh saja; bukan temuan tentang sumber atau kejadian nyata.
          </p>
        </section>
      </div>

      <div className="review-columns review-columns--lower">
        <section className="detail-panel" aria-labelledby="decision-title">
          <div className="panel-heading">
            <div><p className="section-kicker">Riwayat yang tercantum di fixture</p><h2 id="decision-title">Keputusan publikasi contoh</h2></div>
            <span className="fixture-chip">Read-only</span>
          </div>
          <dl className="detail-facts detail-facts--spacious">
            <div><dt>Decision ID</dt><dd>{fixture.publicationDecision.id}</dd></div>
            <div><dt>Hasil fixture</dt><dd>{fixture.publicationDecision.status}</dd></div>
            <div><dt>Alasan</dt><dd>{fixture.publicationDecision.reasonCode}</dd></div>
            <div><dt>Reviewer ID sintetik</dt><dd>{fixture.publicationDecision.reviewerId}</dd></div>
            <div><dt>Waktu keputusan</dt><dd><time dateTime={fixture.publicationDecision.decidedAt}>{formatInstant(fixture.publicationDecision.decidedAt)}</time></dd></div>
          </dl>
          <div className="state-panel state-panel--compact" role="note">
            <strong>Riwayat perubahan kosong pada contoh OpenAPI.</strong>
            <p>Hanya versi 1 dan keputusan fixture yang tercantum. Tidak ada pembaruan atau koreksi yang ditambahkan.</p>
          </div>
        </section>

        <div className="review-map">
          <MapPanel selection={{ kind: "presentation" }} onReturnToList={() => { window.location.hash = "#jelajah"; }} />
          <p className="map-review-note">Segmen route ini adalah geometri sintetik dokumentasi; basis ketelitian fixture: unknown.</p>
        </div>
      </div>

      <div className="review-footer">
        <a className="text-link" href="#jelajah">Kembali ke jelajah</a>
        <span>MOD-01 diperlukan untuk autentikasi dan tindakan review.</span>
      </div>
    </main>
  );
}
