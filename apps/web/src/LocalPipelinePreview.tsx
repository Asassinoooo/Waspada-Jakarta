import { useEffect, useState } from "react";
import type { LocalPipelinePreview, LocalPreviewClaim, LocalPreviewEvidence, LocalPreviewJob, LocalPreviewReport } from "./local-pipeline-client.js";
import { getLocalPipelinePreview } from "./local-pipeline-client.js";


type ReadState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "loaded"; data: LocalPipelinePreview }
  | { status: "unavailable" };

const jobStatusLabels: Readonly<Record<LocalPreviewJob["status"], string>> = {
  pending: "Menunggu",
  leased: "Sedang diproses",
  retry: "Akan dicoba ulang",
  completed: "Pekerjaan selesai",
  terminal: "Berhenti setelah percobaan",
};
const failureLabels: Readonly<Record<Exclude<LocalPreviewJob["failure"], null>, string>> = {
  l1_failed: "Persiapan sumber gagal",
  prerequisite_pending: "Prasyarat belum tersedia",
  model_timeout: "Waktu model habis",
  model_failed: "Permintaan model gagal",
  invalid_output: "Keluaran model tidak sesuai kontrak",
  context_insufficient: "Bukti belum cukup untuk usulan",
  persistence_failed: "Penyimpanan tahap gagal",
  lease_expired: "Masa klaim pekerjaan berakhir",
};
const stageLabels: Readonly<Record<LocalPipelinePreview["reports"][number]["stages"][number], string>> = {
  extraction: "Ekstraksi",
  embedding: "Embedding",
  grounding: "Grounding",
  reasoning: "Penalaran",
  proposal: "Usulan",
};
const relationLabels: Readonly<Record<LocalPreviewEvidence["relation"], string>> = {
  supports: "Mendukung",
  contradicts: "Bertentangan",
  updates: "Memperbarui",
  context: "Konteks",
};
const assessmentLabels: Readonly<Record<LocalPreviewClaim["assessment"], string>> = {
  supported: "Model menilai ada dukungan",
  uncertain: "Penilaian belum pasti",
  disputed: "Model menilai ada pertentangan",
};

function formatTime(value: string): string {
  return new Intl.DateTimeFormat("id-ID", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Jakarta",
  }).format(new Date(value)) + " WIB";
}

function timeValue(value: string | null, missing: string) {
  return value === null
    ? <span>{missing}</span>
    : <time dateTime={value}>{formatTime(value)}</time>;
}

function jobClass(status: LocalPreviewJob["status"]): string {
  return "local-pipeline__job local-pipeline__job--" + status;
}

function JobRow({ label, layer, job }: { label: string; layer: "L1" | "L2"; job: LocalPreviewJob | null }) {
  if (job === null) {
    return (
      <section className="local-pipeline__job local-pipeline__job--missing" aria-label={layer + " " + label}>
        <div className="local-pipeline__job-heading">
          <span className="local-pipeline__layer-tag">{layer}</span>
          <h3>{label}</h3>
        </div>
        <p>Belum ada pekerjaan yang tercatat pada versi ini.</p>
      </section>
    );
  }

  return (
    <section className={jobClass(job.status)} aria-label={layer + " " + label}>
      <div className="local-pipeline__job-heading">
        <span className="local-pipeline__layer-tag">{layer}</span>
        <h3>{label}</h3>
        <span className="local-pipeline__status-chip">{jobStatusLabels[job.status]}</span>
      </div>
      <dl className="local-pipeline__job-facts">
        <div><dt>Percobaan</dt><dd>{job.attempts}</dd></div>
        <div><dt>Tersedia untuk diproses</dt><dd>{timeValue(job.availableAt, "Tidak tercatat")}</dd></div>
        {job.failure !== null && <div><dt>Kegagalan terakhir</dt><dd>{failureLabels[job.failure]}</dd></div>}
      </dl>
    </section>
  );
}

function spanText(evidence: LocalPreviewEvidence, reports: readonly LocalPreviewReport[]): string | null {
  const source = reports.find((report) => report.reportRevisionId === evidence.reportRevisionId
    && report.permittedTextHash === evidence.permittedTextHash
    && report.permittedText !== null);
  if (!source?.permittedText) return null;
  return Array.from(source.permittedText).slice(evidence.spanStart, evidence.spanEnd).join("");
}

function EvidenceRow({
  evidence,
  reports,
}: {
  evidence: LocalPreviewEvidence;
  reports: readonly LocalPreviewReport[];
}) {
  const excerpt = spanText(evidence, reports);
  const source = reports.find((report) => report.reportRevisionId === evidence.reportRevisionId);
  const sourceLabel = source
    ? source.title + " · versi " + source.version
    : "Versi sumber tidak termasuk dalam 20 versi yang dimuat";

  return (
    <li className={"local-pipeline__evidence local-pipeline__evidence--" + evidence.relation}>
      <div className="local-pipeline__evidence-heading">
        <strong>{relationLabels[evidence.relation]}</strong>
        <span>{sourceLabel}</span>
      </div>
      {excerpt === null
        ? <p className="local-pipeline__evidence-missing">Teks cuplikan tidak tersedia pada pratinjau ini.</p>
        : <blockquote>{excerpt}</blockquote>}
      <details className="local-pipeline__disclosure local-pipeline__evidence-disclosure">
        <summary>Jejak referensi</summary>
        <dl className="local-pipeline__evidence-facts">
          <div><dt>Versi sumber</dt><dd><code>{evidence.reportRevisionId}</code></dd></div>
          <div><dt>Rentang Unicode</dt><dd>{evidence.spanStart}–{evidence.spanEnd} (akhir tidak termasuk)</dd></div>
          <div><dt>Hash teks sumber</dt><dd><code>{evidence.permittedTextHash}</code></dd></div>
        </dl>
      </details>
    </li>
  );
}

function ClaimCard({
  claim,
  reports,
}: {
  claim: LocalPreviewClaim;
  reports: readonly LocalPreviewReport[];
}) {
  return (
    <li className="local-pipeline__claim">
      <div className="local-pipeline__claim-heading">
        <h4>{claim.text}</h4>
        <span className="local-pipeline__assessment">{assessmentLabels[claim.assessment]}</span>
      </div>
      {claim.evidence.length === 0
        ? <p className="local-pipeline__evidence-missing">Tidak ada referensi bukti pada klaim ini.</p>
        : <ul className="local-pipeline__evidence-list">
            {claim.evidence.map((evidence, index) => (
              <EvidenceRow key={evidence.reportRevisionId + ":" + evidence.spanStart + ":" + evidence.spanEnd + ":" + evidence.relation + ":" + index}
                evidence={evidence} reports={reports} />
            ))}
          </ul>}
    </li>
  );
}

export function LocalPipelineReportCard({
  report,
  reports,
}: {
  report: LocalPreviewReport;
  reports: readonly LocalPreviewReport[];
}) {
  const titleId = "local-pipeline-report-" + report.reportRevisionId.replace(/[^A-Za-z0-9_-]/gu, "-");
  return (
    <article className="local-pipeline__report" aria-labelledby={titleId}>
      <header className="local-pipeline__report-heading">
        <div>
          <p className="local-pipeline__eyebrow">Versi sumber {report.version} · laporan sintetis</p>
          <h2 id={titleId}>{report.title}</h2>
        </div>
        <span className="local-pipeline__private-chip">Pribadi · belum terbit</span>
      </header>
      <dl className="local-pipeline__times">
        <div><dt>Diterbitkan sumber</dt><dd>{timeValue(report.publishedAt, "Tidak dicantumkan sumber")}</dd></div>
        <div><dt>Waktu observasi</dt><dd>{timeValue(report.observedAt, "Tidak dicantumkan sumber")}</dd></div>
        <div><dt>Diterima pipeline lokal</dt><dd>{timeValue(report.capturedAt, "Tidak tersedia")}</dd></div>
      </dl>
      <details className="local-pipeline__disclosure local-pipeline__source-disclosure">
        <summary>Identitas dan hash sumber</summary>
        <dl className="local-pipeline__source-facts">
          <div><dt>ID laporan</dt><dd><code>{report.reportId}</code></dd></div>
          <div><dt>ID revisi sumber</dt><dd><code>{report.reportRevisionId}</code></dd></div>
          <div><dt>Hash konten sumber</dt><dd><code>{report.contentHash}</code></dd></div>
          {report.supersedesId !== null && <div><dt>Menggantikan revisi</dt><dd><code>{report.supersedesId}</code></dd></div>}
        </dl>
      </details>
      <div className="local-pipeline__jobs">
        <JobRow label="Penerimaan dan penyimpanan" layer="L1" job={report.ingestion} />
        <JobRow label="Pemrosesan bukti" layer="L2" job={report.ai} />
      </div>
      <section className="local-pipeline__stages" aria-label="Tahap L2 yang tercatat">
        <strong>Tahap tercatat</strong>
        {report.stages.length === 0
          ? <span>Belum ada tahap L2 yang tercatat.</span>
          : <ul>{report.stages.map((stage) => <li key={stage}>{stageLabels[stage]}</li>)}</ul>}
      </section>
      {report.proposal === null
        ? <p className="local-pipeline__proposal-empty">Belum ada usulan privat pada versi sumber ini.</p>
        : (
          <section className="local-pipeline__proposal" aria-label="Usulan privat">
            <div className="local-pipeline__proposal-heading">
              <div>
                <p className="local-pipeline__eyebrow">Usulan L2</p>
                <h3>Usulan privat · belum terbit</h3>
              </div>
              <div className="local-pipeline__proposal-time">
                <span>Acuan waktu usulan (waktu diterima pipeline)</span>
                <time dateTime={report.proposal.proposedAt}>{formatTime(report.proposal.proposedAt)}</time>
              </div>
            </div>
            <p className="local-pipeline__proposal-note">
              Waktu acuan ini mengikuti saat laporan diterima pipeline, bukan waktu selesainya inferensi L2.
              Penilaian model adalah masukan untuk peninjauan; penilaian itu sendiri tidak menyetujui klaim.
              {report.proposal.unresolvedCount > 0 && " " + report.proposal.unresolvedCount + " hal belum terselesaikan."}
            </p>
            {report.proposal.claims.length === 0
              ? <p className="local-pipeline__evidence-missing">Usulan tersimpan tanpa klaim.</p>
              : <ol className="local-pipeline__claims">
                  {report.proposal.claims.map((claim) => (
                    <ClaimCard key={claim.claimId} claim={claim} reports={reports} />
                  ))}
                </ol>}
          </section>
        )}
    </article>
  );
}

function FlowStrip() {
  return (
    <ol className="local-pipeline__flow" aria-label="Alur pratinjau pipeline lokal">
      <li><span>L1</span><div><strong>Penerimaan sumber</strong><small>Simpan versi laporan sintetis</small></div></li>
      <li><span>L2</span><div><strong>Pemrosesan bukti</strong><small>Ekstraksi, embedding, grounding, penalaran</small></div></li>
      <li><span aria-hidden="true">→</span><div><strong>Usulan privat</strong><small>Belum ditinjau atau diterbitkan</small></div></li>
    </ol>
  );
}

function summaryStatusLabel(status: LocalPipelinePreview["scheduler"]["status"]): string {
  switch (status) {
    case "idle": return "Diam";
    case "running": return "Berjalan";
    case "completed": return "Selesai";
    case "failed": return "Gagal";
  }
}

function SummaryDetails({ data }: { data: LocalPipelinePreview }) {
  return (
    <details className="local-pipeline__summary">
      <summary>Ringkasan seluruh state pipeline</summary>
      <p>Jumlah mencakup seluruh state tersimpan; daftar di atas memuat paling banyak 20 versi terbaru.</p>
      <div className="local-pipeline__summary-grid">
        <div><strong>{data.summary.snapshots}</strong><span>versi laporan</span></div>
        <div><strong>{data.summary.proposals}</strong><span>usulan privat</span></div>
        <div><strong>{data.scheduler.polls}</strong><span>poll scheduler</span></div>
        <div><strong>{data.scheduler.collectionFailures}</strong><span>gagal mengumpulkan</span></div>
      </div>
      <div className="local-pipeline__summary-jobs">
        <JobCountTable title="Pekerjaan L1" counts={data.summary.ingestion} />
        <JobCountTable title="Pekerjaan AI" counts={data.summary.ai} />
      </div>
    </details>
  );
}

function JobCountTable({
  title,
  counts,
}: {
  title: string;
  counts: LocalPipelinePreview["summary"]["ingestion"];
}) {
  return (
    <section>
      <h3>{title}</h3>
      <dl>
        <div><dt>Menunggu</dt><dd>{counts.pending}</dd></div>
        <div><dt>Diproses</dt><dd>{counts.leased}</dd></div>
        <div><dt>Coba ulang</dt><dd>{counts.retry}</dd></div>
        <div><dt>Selesai</dt><dd>{counts.completed}</dd></div>
        <div><dt>Terminal</dt><dd>{counts.terminal}</dd></div>
      </dl>
    </section>
  );
}

export function LocalPipelinePreview({ enabled }: { enabled: boolean }) {
  const [retryKey, setRetryKey] = useState(0);
  const [state, setState] = useState<ReadState>(() => enabled ? { status: "loading" } : { status: "idle" });

  useEffect(() => {
    if (enabled) void import("./local-pipeline-preview.css");
  }, [enabled]);
  useEffect(() => {
    if (!enabled) {
      setState({ status: "idle" });
      return;
    }
    const controller = new AbortController();
    let active = true;
    setState({ status: "loading" });
    getLocalPipelinePreview({ signal: controller.signal })
      .then((data) => {
        if (active) setState({ status: "loaded", data });
      })
      .catch((error: unknown) => {
        if (active && !(error instanceof Error && error.name === "AbortError")) {
          setState({ status: "unavailable" });
        }
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [enabled, retryKey]);

  return (
    <main id="main-content" className="main-shell local-pipeline">
      <header className="local-pipeline__intro">
        <div>
          <p className="section-kicker">Inspeksi lokal · hanya baca</p>
          <h1>Pipeline laporan lokal</h1>
        </div>
        <span className="local-pipeline__private-chip">Sintetis · pribadi · belum terbit</span>
      </header>
      <p className="local-pipeline__boundary">
        Tampilan pengembang ini membaca rekaman pipeline lokal. Teks sumber dan usulan tetap privat di demo sintetis.
      </p>
      {!enabled
        ? <section className="state-panel" role="status">
            <strong>Pratinjau lokal tidak tersedia.</strong>
            <p>Tampilan ini hanya aktif pada build development setelah mode demo dikonfirmasi.</p>
          </section>
        : (
          <>
            <FlowStrip />
            {state.status === "loading" && (
              <section className="state-panel state-panel--loading" role="status">
                <strong>Memuat rekaman pipeline lokal…</strong>
                <span>Permintaan hanya membaca snapshot demo yang sudah tersimpan.</span>
              </section>
            )}
            {state.status === "unavailable" && (
              <section className="state-panel state-panel--error local-pipeline__unavailable" role="alert">
                <strong>Rekaman pipeline lokal tidak tersedia.</strong>
                <p>Respons tidak dapat divalidasi. Rincian respons server tidak ditampilkan.</p>
                <button className="button button--quiet" type="button" onClick={() => setRetryKey((key) => key + 1)}>
                  Muat ulang
                </button>
              </section>
            )}
            {state.status === "loaded" && (
              <>
                <section className="local-pipeline__controls" aria-label="Status pratinjau pipeline">
                  <div>
                    <strong>Snapshot terakhir dibuat</strong>
                    <span><time dateTime={state.data.generatedAt}>{formatTime(state.data.generatedAt)}</time></span>
                    <span>Sumber lokal · {state.data.models === "mock" ? "model mock" : "gateway opt-in"}</span>
                  </div>
                  <div className="local-pipeline__controls-actions">
                    <span className="local-pipeline__status-chip">
                      Scheduler: {summaryStatusLabel(state.data.scheduler.status)}
                    </span>
                    <button className="button button--quiet" type="button" onClick={() => setRetryKey((key) => key + 1)}>
                      Muat ulang
                    </button>
                  </div>
                </section>
                {state.data.truncated && (
                  <p className="local-pipeline__truncated" role="status">
                    Daftar dibatasi ke 20 versi terbaru. Ringkasan di bawah tetap mencakup seluruh state tersimpan.
                  </p>
                )}
                {state.data.reports.length === 0
                  ? <section className="state-panel local-pipeline__empty" role="status">
                      <strong>Belum ada versi laporan pada state lokal ini.</strong>
                      <p>Daftar tetap kosong sampai pipeline menyimpan laporan sintetis.</p>
                    </section>
                  : <ol className="local-pipeline__reports">
                      {state.data.reports.map((report) => (
                        <li key={report.reportRevisionId}>
                          <LocalPipelineReportCard report={report} reports={state.data.reports} />
                        </li>
                      ))}
                    </ol>}
                <SummaryDetails data={state.data} />
              </>
            )}
            {state.status === "idle" && (
              <section className="state-panel" role="status">
                <strong>Pratinjau lokal tidak tersedia.</strong>
                <p>Tampilan ini hanya aktif pada build development setelah mode demo dikonfirmasi.</p>
              </section>
            )}
          </>
        )}
    </main>
  );
}
