import type { EventDetail as EventDetailRecord, HistoryPage, PublicContext } from "@waspada/worker/public-contracts";
import type { ApiReadState } from "./api-client.js";
import { categoryLabel, evidenceLabel, formatEventTime, formatInstant, freshnessLabel, lifecycleLabel } from "./display.js";
import { documentedPresentationFixture as presentation } from "./presentation-fixture.js";
import { MapPanel, RecordMapPanel } from "./MapPanel.js";
import { SeverityChip } from "./MapSeverity.js";
import { publicationPathText, SEVERITY_NOTE, severityOf } from "./published-events.js";

interface EventDetailProps {
  mode: "presentation" | "api-event";
  apiDetail?: ApiReadState<EventDetailRecord>;
  apiHistory?: ApiReadState<HistoryPage>;
  onRetryDetail?: () => void;
  onRetryHistory?: () => void;
  context: PublicContext | null;
  /** `sheet` renders the body inside the map home's detail sheet: no page landmark and no back link. */
  variant?: "page" | "sheet";
  onBackToList?: () => void;
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

/** R-05: wording for API records. Only the demo dataset is labelled as synthetic or fixture. */
function wording(demo: boolean, demoText: string, otherText: string): string {
  return demo ? demoText : otherText;
}

function historyChangeLabel(changeType: HistoryPage["data"][number]["change_type"]) {
  switch (changeType) {
    case "published": return "Versi dipublikasikan";
    case "corrected": return "Versi dikoreksi";
    case "impact_changed": return "Dampak diperbarui";
    case "retracted": return "Versi ditarik";
  }
}

function ApiHistory({
  state,
  onRetry,
  demo,
}: {
  state: ApiReadState<HistoryPage>;
  onRetry: () => void;
  demo: boolean;
}) {
  return (
    <section className="detail-panel history-panel" aria-labelledby="api-history-heading">
      <div className="panel-heading">
        <div><p className="section-kicker">{wording(demo, "Riwayat fixture sintetis", "Riwayat")}</p><h2 id="api-history-heading">Perubahan</h2></div>
        {state.status === "loaded" && <span className="count-chip">{state.data.data.length} entri</span>}
      </div>
      {state.status === "loading" && (
        <div className="state-panel state-panel--loading" role="status">
          <span className="loading-rule" aria-hidden="true" />
          <strong>{wording(demo, "Memuat riwayat fixture…", "Memuat riwayat…")}</strong>
          <span>{wording(demo, "Riwayat sintetis ini bukan keadaan terkini.", "Riwayat ini bukan keadaan terkini.")}</span>
        </div>
      )}
      {state.status === "not-found" && (
        <div className="state-panel state-panel--compact" role="status">
          <strong>Riwayat record tidak ditemukan.</strong>
          <p>{wording(demo, "API demo tidak memiliki riwayat untuk ID ini.", "API tidak memiliki riwayat untuk ID ini.")}</p>
        </div>
      )}
      {state.status === "unavailable" && (
        <div className="state-panel state-panel--error" role="alert">
          <strong>Riwayat belum dapat dimuat.</strong>
          <p>Detail event tetap dapat dibaca. {wording(demo, "Riwayat fixture ini tidak memberi informasi tentang kondisi saat ini.", "Riwayat ini tidak memberi informasi tentang kondisi saat ini.")}</p>
          <button className="button button--quiet" type="button" onClick={onRetry}>Coba lagi memuat riwayat</button>
        </div>
      )}
      {state.status === "loaded" && state.data.data.length === 0 && (
        <div className="state-panel state-panel--compact" role="status">
          <strong>{wording(demo, "Tidak ada entri riwayat pada fixture ini.", "Tidak ada entri riwayat pada record ini.")}</strong>
          <p>Entri yang kosong tidak menunjukkan keselamatan atau penyelesaian event.</p>
        </div>
      )}
      {state.status === "loaded" && state.data.data.length > 0 && (
        <ol className="claims-list" aria-label={wording(demo, "Entri riwayat fixture sintetis", "Entri riwayat")}>
          {state.data.data.map((entry) => (
            <li className="claim-card" key={`${entry.event_id}:${entry.version}:${entry.change_type}:${entry.changed_at}`}>
              <span className="claim-card__label">{historyChangeLabel(entry.change_type)} · versi {entry.version}{wording(demo, " · fixture demo", "")}</span>
              <p>{entry.summary}</p>
              <p>{wording(demo, "Waktu pada fixture: ", "Waktu: ")}<time dateTime={entry.changed_at}>{formatInstant(entry.changed_at)}</time></p>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function ApiEventDetail({
  detail,
  history,
  onRetryDetail,
  onRetryHistory,
  context,
  onBackToList,
}: {
  detail: ApiReadState<EventDetailRecord>;
  history: ApiReadState<HistoryPage>;
  onRetryDetail: () => void;
  onRetryHistory: () => void;
  context: PublicContext | null;
  onBackToList?: () => void;
}) {
  const event = detail.status === "loaded" ? detail.data : null;
  const severity = event === null ? null : severityOf(event);
  // R-05: only a demo dataset may be called synthetic or fixture. Live and unknown modes get neutral wording.
  const demo = context?.dataset_mode === "demo";
  const noun = demo ? "fixture" : "record";

  return (
    <>
      {detail.status === "loading" && (
        <>
          <section className="detail-heading" aria-labelledby="detail-title">
            <p className="section-kicker">{wording(demo, "Detail record sintetis", "Detail record")}</p>
            <h1 id="detail-title">{wording(demo, "Memuat detail contoh…", "Memuat detail…")}</h1>
          </section>
          <div className="state-panel state-panel--loading" role="status">
            <span className="loading-rule" aria-hidden="true" />
            <strong>{wording(demo, "Memuat record sintetis dari API lokal…", "Memuat record dari API lokal…")}</strong>
            <span>{wording(demo, "Data ini adalah contoh antarmuka, bukan laporan langsung.", "Ini bukan peringatan darurat.")}</span>
          </div>
        </>
      )}
      {detail.status === "not-found" && (
        <section className="state-panel" role="status">
          <strong>{wording(demo, "Record contoh tidak ditemukan.", "Record tidak ditemukan.")}</strong>
          <p>{wording(demo, "API demo tidak menyediakan record untuk ID ini.", "API tidak menyediakan record untuk ID ini.")}</p>
          <a className="text-link" href="#peta">Kembali ke daftar</a>
        </section>
      )}
      {detail.status === "unavailable" && (
        <section className="state-panel state-panel--error" role="alert">
          <strong>{wording(demo, "Detail contoh belum dapat dimuat.", "Detail belum dapat dimuat.")}</strong>
          <p>API lokal sementara tidak tersedia. Keadaan keselamatan tidak diketahui.</p>
          <button className="button button--primary" type="button" onClick={onRetryDetail}>Coba lagi memuat detail</button>
        </section>
      )}
      {event && (
        <>
          <section className="detail-heading" aria-labelledby="detail-title">
            <p className="section-kicker">{wording(demo, "Detail dari API lokal · record sintetis", "Detail dari API lokal")}</p>
            <h1 id="detail-title">{event.title}</h1>
            <p>{event.summary}</p>
            {severity !== null && (
              <p className="map-severity-note">
                <SeverityChip level={severity} />
                <small>{SEVERITY_NOTE}</small>
              </p>
            )}
            <div className="fixture-notice" role="note">
              {wording(demo, "Record ini berasal dari fixture demo sintetis. Nilai ini bukan laporan, peringatan langsung, atau gambaran kondisi Jakarta.", "Record ini menampilkan waktu dan sumbernya. Ini bukan peringatan darurat atau gambaran kondisi Jakarta.")}
            </div>
          </section>

          <section className="status-grid" aria-label="Dimensi status yang terpisah">
            <div className="status-cell"><dt>Siklus</dt><dd>{lifecycleLabel(event.lifecycle, { fixtureWording: demo })}</dd></div>
            <div className="status-cell"><dt>Kesegaran</dt><dd>{freshnessLabel(event.freshness.status, { fixtureWording: demo })}</dd><small>{demo ? "Evaluasi fixture" : "Dievaluasi"} {formatInstant(event.freshness.evaluated_at)}; basis {event.freshness.basis.replaceAll("_", " ")}.</small></div>
            <div className="status-cell"><dt>Bukti</dt><dd>{event.claims.length === 0 ? `Tidak tersedia pada ${noun}` : evidenceLabel(event.claims[0]?.evidence_label)}</dd></div>
            <div className="status-cell"><dt>Relevansi</dt><dd>Tidak dinilai</dd><small>Minat pengguna tidak digunakan.</small></div>
          </section>

          <div className="detail-columns">
            <section className="detail-panel" aria-labelledby="api-facts-heading">
              <div className="panel-heading">
                <div><p className="section-kicker">Proyeksi publik</p><h2 id="api-facts-heading">Waktu dan cakupan</h2></div>
                <span className="synthetic-label">{wording(demo, "Contoh API", "Data API")}</span>
              </div>
              <dl className="detail-facts detail-facts--spacious">
                <div><dt>Waktu kejadian</dt><dd>{formatEventTime(event, { fixtureWording: demo })}</dd></div>
                <div><dt>Validitas pada record</dt><dd>{event.validity.valid_from || event.validity.valid_until
                  ? <>{event.validity.valid_from ? formatInstant(event.validity.valid_from) : "Tidak ada waktu awal"} sampai {event.validity.valid_until ? formatInstant(event.validity.valid_until) : "Tidak ada waktu akhir"}</>
                  : `Tidak tersedia pada ${noun}`}</dd></div>
                <div><dt>Versi publik diterbitkan{wording(demo, " (waktu fixture)", "")}</dt><dd><time dateTime={event.published_at}>{formatInstant(event.published_at)}</time></dd></div>
                {publicationPathText(event.publication) !== null && (
                  <div><dt>Cara penerbitan</dt><dd>{publicationPathText(event.publication)}</dd></div>
                )}
                <div><dt>Respons konteks API dibuat</dt><dd>{formatInstant(context?.generated_at)}</dd></div>
                <div><dt>Waktu pengambilan sumber</dt><dd>Tidak disediakan dalam proyeksi EventDetail</dd></div>
                <div><dt>Cakupan tempat/layanan/kelompok</dt><dd>{event.scope.places.concat(event.scope.services, event.scope.institutions, event.scope.audiences).join(", ") || `Tidak tersedia pada ${noun}`}</dd></div>
              </dl>
              {event.impacts.length === 0 ? (
                <div className="state-panel state-panel--compact" role="note">
                  <strong>{`Dampak tidak tersedia pada ${noun} ini.`}</strong>
                  <p>Ketiadaan dampak di record tidak menjelaskan kondisi atau keselamatan.</p>
                </div>
              ) : (
                <div className="claims-list" aria-label="Dampak yang tercantum pada record">
                  {event.impacts.map((impact) => (
                    <article className="claim-card" key={`${impact.impact_id}:${impact.version}`}>
                      <span className="claim-card__label">Dampak · {lifecycleLabel(impact.lifecycle)} · {freshnessLabel(impact.freshness.status)}</span>
                      <strong>{impact.title}</strong>
                      <p>{impact.description}</p>
                      <p>Waktu dampak: {formatEventTime({ event_time: impact.event_time }, { fixtureWording: demo })}</p>
                    </article>
                  ))}
                </div>
              )}
            </section>

            <section className="detail-panel" aria-labelledby="api-claim-heading">
              <div className="panel-heading">
                <div><p className="section-kicker">Klaim per sumber</p><h2 id="api-claim-heading">Bukti</h2></div>
              </div>
              {event.claims.length === 0 ? (
                <div className="state-panel state-panel--compact" role="note">
                  <strong>{`Bukti tidak tersedia pada ${noun}${demo ? " demo" : ""} ini.`}</strong>
                  <p>Tidak ada klaim, atribusi sumber, atau kutipan dalam record. {wording(demo, "Ringkasan contoh bukan bukti.", "Ringkasan bukan bukti.")}</p>
                </div>
              ) : (
                <div className="claims-list">
                  {event.claims.map((claim) => (
                    <article className="claim-card" key={claim.claim_id}>
                      <span className="claim-card__label">{evidenceLabel(claim.evidence_label)}</span>
                      <blockquote>{claim.text}</blockquote>
                      <p>Waktu kejadian klaim: {formatEventTime({ event_time: claim.event_time })}</p>
                      {claim.qualifiers.length > 0 && <p className="qualifier">{claim.qualifiers.join(" ")}</p>}
                      {claim.sources.length === 0 && <p>Atribusi sumber tidak tersedia pada record ini.</p>}
                      {claim.sources.map((source) => (
                        <div className="source-record" key={source.url}>
                          <h3>{source.display_name}</h3>
                          <p>Waktu sumber diterbitkan: {formatInstant(source.published_at)} · waktu observasi: {formatInstant(source.observed_at)}</p>
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
            <RecordMapPanel
              title={event.title}
              geometries={event.geometries}
              onReturnToList={onBackToList ?? (() => { window.location.hash = "#peta"; })}
            />
            <ApiHistory state={history} onRetry={onRetryHistory} demo={demo} />
          </div>
        </>
      )}
      {!event && (detail.status === "loading" || detail.status === "not-found" || detail.status === "unavailable") && (
        <div className="history-panel">
          <ApiHistory state={history} onRetry={onRetryHistory} demo={demo} />
        </div>
      )}
    </>
  );
}

export function EventDetail({ mode, apiDetail, apiHistory, onRetryDetail, onRetryHistory, context, variant = "page", onBackToList }: EventDetailProps) {
  const body = mode === "presentation"
    ? <PresentationDetail />
    : apiDetail && apiHistory
      ? <ApiEventDetail
        detail={apiDetail}
        history={apiHistory}
        onRetryDetail={onRetryDetail ?? (() => {})}
        onRetryHistory={onRetryHistory ?? (() => {})}
        context={context}
        onBackToList={onBackToList}
      />
      : <div className="state-panel" role="status"><strong>Detail contoh belum dimuat.</strong><p>Kembali ke daftar contoh API.</p></div>;

  if (variant === "sheet") return <div className="event-detail-sheet">{body}</div>;
  return (
    <main id="main-content" className="main-shell detail-page">
      <a className="back-link" href="#peta">Kembali ke daftar</a>
      {body}
    </main>
  );
}
