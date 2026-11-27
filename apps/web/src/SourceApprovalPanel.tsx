import { useEffect, useState } from "react";
import type { AdminSourceApprovalItem, AdminSourceApprovalStatus } from "@waspada/worker/source-approval-contracts";
import type { SessionEnvelope } from "@waspada/worker/account-contracts";
import { Dialog } from "./ui/Dialog.js";
import { formatInstant } from "./display.js";
import {
  SourceApprovalHttpError,
  canManageSourceApprovals,
  sourceApprovalClient,
  sourceApprovalNoteError,
  type SourceApprovalClient,
} from "./source-approval-client.js";

/**
 * FR-12 registry approval for the administrator workspace. Approval allows public display of the source's reports and
 * never changes collection. Revoking stops publication only (HOSTED-28); collection keeps running.
 */

/** HOSTED-34: the intro. Kept true to apps/db/src/source-approval-store.ts (approve sets the status only; revoke sets it and auto-publication to never). */
export const SOURCE_APPROVAL_INTRO = "Persetujuan mencatat status sumber. Menyetujui mengizinkan laporan dari sumber ini tampil publik. "
  + "Pengumpulan otomatis tidak berubah. "
  + "Mencabut menghentikan penerbitan dari sumber ini. Pengumpulan otomatis tetap berjalan, dan terbit otomatis diatur ke tidak pernah. "
  + "Tampil publik tetap mengikuti hak penggunaan sumber. Kejadian yang sudah terbit tidak ditarik. Setiap perubahan dicatat dalam audit.";

/** HOSTED-34: the body of the confirmation dialog for each change. */
export function sourceApprovalDialogBody(status: AdminSourceApprovalStatus): string {
  return status === "approved"
    ? "Menyetujui mengizinkan laporan dari sumber ini tampil publik. Pengumpulan otomatis tidak berubah."
    : "Mencabut menghentikan penerbitan dari sumber ini. Pengumpulan otomatis tetap berjalan, dan terbit otomatis diatur ke tidak pernah. Kejadian yang sudah terbit tidak ditarik.";
}

const APPROVAL_LABEL: Readonly<Record<string, string>> = {
  pending: "Menunggu",
  approved: "Disetujui",
  suspended: "Ditangguhkan",
  revoked: "Dicabut",
};

const REGISTRY_LABEL: Readonly<Record<string, string>> = {
  active: "Registri aktif",
  paused: "Registri dijeda",
  retired: "Registri dipensiunkan",
};

/** Reuse tokens as admin text. Unknown tokens get a generic label, so no raw registry token is printed. */
const REUSE_BASIS_LABEL: Readonly<Record<string, string>> = {
  public_display: "Tampil publik",
  model_triage: "Triase model",
  ai_processing: "Pemrosesan AI",
  model_title: "Judul oleh model",
  model_description: "Deskripsi oleh model",
  retain_title: "Simpan judul",
  retain_description: "Simpan deskripsi",
  retain_derived: "Simpan turunan",
  excerpt_permitted: "Kutipan diizinkan",
  // Legacy grants never allow public display alone (WJ-INT-02B); they need reviewer-recorded license evidence.
  public: "Dasar lama: publik (perlu bukti lisensi)",
  open_access: "Dasar lama: akses terbuka (perlu bukti lisensi)",
};

const HEALTH_LABEL: Readonly<Record<string, string>> = {
  healthy: "Sehat",
  degraded: "Menurun",
  unavailable: "Tidak tersedia",
  unknown: "Belum diketahui",
};

function approvalLabel(status: string): string {
  return APPROVAL_LABEL[status] ?? "Status tidak dikenal";
}

export function publicDisplayText(granted: boolean): string {
  return granted ? "Tampil publik: diizinkan" : "Tampil publik: tidak diizinkan";
}

export function reuseBasisText(tokens: readonly string[]): string {
  if (tokens.length === 0) return "Dasar penggunaan: belum tercatat";
  const labels = [...new Set(tokens.map((token) => REUSE_BASIS_LABEL[token] ?? "Dasar lain (belum diberi label)"))];
  return `Dasar penggunaan: ${labels.join(", ")}`;
}

export function accessRestrictionsText(notes: readonly string[]): string {
  return notes.length === 0 ? "Pembatasan akses: tidak ada catatan" : `Pembatasan akses: ${notes.join("; ")}`;
}

export function pollingIntervalText(seconds: number | null): string {
  if (seconds === null) return "Interval pengambilan: belum diatur";
  if (seconds % 3600 === 0) return `Interval pengambilan: setiap ${seconds / 3600} jam`;
  if (seconds % 60 === 0) return `Interval pengambilan: setiap ${seconds / 60} menit`;
  return `Interval pengambilan: setiap ${seconds} detik`;
}

/**
 * Health lines for one source, in Jakarta time. A source that was never checked gets one line and no times.
 * The failure line names no error code, because the hosted writer stores none for these sources.
 */
export function sourceHealthLines(source: Pick<AdminSourceApprovalItem, "health_status" | "last_checked_at" | "last_success_at" | "last_failure_at">): string[] {
  if (source.last_checked_at === null) return ["Belum ada data kesehatan"];
  const lines = [`Status: ${HEALTH_LABEL[source.health_status] ?? "Status tidak dikenal"}`];
  lines.push(source.last_success_at === null
    ? "Pengambilan berhasil terakhir: belum pernah"
    : `Pengambilan berhasil terakhir: ${formatInstant(source.last_success_at)}`);
  lines.push(source.last_failure_at === null
    ? "Galat aktif: tidak ada"
    : `Galat terakhir: ${formatInstant(source.last_failure_at)}, penyebab belum dicatat`);
  return lines;
}

function requestedStatus(source: AdminSourceApprovalItem): AdminSourceApprovalStatus {
  return source.approval_status === "approved" ? "revoked" : "approved";
}

function listErrorMessage(error: unknown): string {
  if (error instanceof SourceApprovalHttpError) {
    if (error.status === 401 || error.status === 403) return "Sesi atau izin administrator tidak berlaku. Muat ulang halaman.";
    if (error.status === 503) return "Persetujuan sumber belum tersedia di layanan ini.";
  }
  return "Daftar sumber belum dapat dimuat.";
}

function writeErrorMessage(error: unknown): { message: string; reload: boolean } {
  if (error instanceof SourceApprovalHttpError) {
    if (error.status === 400) return { message: "Catatan harus 10 sampai 500 karakter.", reload: false };
    if (error.status === 401 || error.status === 403) {
      return { message: "Sesi atau izin administrator tidak berlaku. Muat ulang halaman sebelum mencoba lagi.", reload: false };
    }
    if (error.status === 404) return { message: "Sumber tidak ditemukan. Daftar akan dimuat ulang.", reload: true };
    if (error.status === 409) return { message: "Status sumber sudah sama. Daftar akan dimuat ulang.", reload: true };
  }
  return { message: "Perubahan belum dapat dikonfirmasi. Daftar akan dimuat ulang sebelum mencoba lagi.", reload: true };
}

export interface SourceApprovalListProps {
  readonly sources: readonly AdminSourceApprovalItem[];
  /** Rendered only when supplied. Without it the list is read-only and contains no control. */
  readonly onRequestChange?: (source: AdminSourceApprovalItem, status: AdminSourceApprovalStatus) => void;
}

export function SourceApprovalList({ sources, onRequestChange }: SourceApprovalListProps) {
  if (sources.length === 0) return <p className="source-approval__empty">Belum ada sumber di registri.</p>;
  return (
    <ul className="source-approval__list">
      {sources.map((source) => {
        const target = requestedStatus(source);
        const name = source.display_name;
        const actionLabel = target === "approved" ? "Setujui" : "Cabut";
        const ariaLabel = target === "approved" ? `Setujui ${name}` : `Cabut persetujuan ${name}`;
        return (
          <li key={source.source_id} className="source-approval__item">
            <div className="source-approval__identity">
              <h3 className="source-approval__name">{name}</h3>
              <p className="source-approval__id"><code>{source.source_id}</code> · {source.source_kind} · {source.access_method}</p>
            </div>
            <ul className="source-approval__facts" aria-label={`Persetujuan ${name}`}>
              <li>{approvalLabel(source.approval_status)}</li>
            </ul>
            <section className="source-approval__block" aria-label={`Pembatasan ${name}`}>
              <h4 className="source-approval__subtitle">Pembatasan</h4>
              <ul className="source-approval__details">
                <li>{REGISTRY_LABEL[source.registry_status] ?? "Registri tidak dikenal"}</li>
                <li>{source.auto_acquisition_enabled ? "Pengumpulan otomatis aktif" : "Pengumpulan otomatis nonaktif"}</li>
                <li>{publicDisplayText(source.public_display_granted)}</li>
                <li>{reuseBasisText(source.reuse_basis)}</li>
                <li>{accessRestrictionsText(source.access_restrictions)}</li>
                <li>{pollingIntervalText(source.polling_interval_seconds)}</li>
              </ul>
            </section>
            <section className="source-approval__block" aria-label={`Kesehatan ${name}`}>
              <h4 className="source-approval__subtitle">Kesehatan sumber</h4>
              <ul className="source-approval__details">
                {sourceHealthLines(source).map((line) => <li key={line}>{line}</li>)}
              </ul>
            </section>
            {onRequestChange && (
              <button
                type="button"
                className="button button--quiet"
                aria-label={ariaLabel}
                onClick={() => onRequestChange(source, target)}
              >
                {actionLabel}
              </button>
            )}
          </li>
        );
      })}
    </ul>
  );
}

type ListState =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly sources: readonly AdminSourceApprovalItem[] }
  | { readonly status: "error"; readonly message: string };

interface PendingChange {
  readonly source: AdminSourceApprovalItem;
  readonly status: AdminSourceApprovalStatus;
}

export function SourceApprovalPanel({ session, client = sourceApprovalClient }: { session: SessionEnvelope; client?: SourceApprovalClient }) {
  const canManage = canManageSourceApprovals(session);
  const csrfToken = session.csrf_token;
  const isAdministrator = session.user !== null && session.user.active && session.user.role === "admin";
  const [list, setList] = useState<ListState>({ status: "loading" });
  const [reloadToken, setReloadToken] = useState(0);
  const [change, setChange] = useState<PendingChange | null>(null);
  const [note, setNote] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!canManage) return undefined;
    const controller = new AbortController();
    setList({ status: "loading" });
    client.listSources({ signal: controller.signal }).then(
      (result) => {
        if (!controller.signal.aborted) setList({ status: "ready", sources: result.sources });
      },
      (error: unknown) => {
        if (!controller.signal.aborted) setList({ status: "error", message: listErrorMessage(error) });
      },
    );
    return () => controller.abort();
  }, [canManage, client, reloadToken]);

  function closeDialog() {
    setChange(null);
    setNote("");
    setFormError(null);
  }

  async function submit() {
    if (!change || csrfToken === null || submitting) return;
    const problem = sourceApprovalNoteError(note);
    if (problem !== null) {
      setFormError(problem);
      return;
    }
    setSubmitting(true);
    setFormError(null);
    try {
      const result = await client.setApproval(change.source.source_id, change.status, note, csrfToken);
      setList((current) => current.status === "ready"
        ? { status: "ready", sources: current.sources.map((item) => item.source_id === result.source.source_id ? result.source : item) }
        : current);
      setMessage(`Status ${result.source.display_name} sekarang: ${approvalLabel(result.source.approval_status)}.`);
      closeDialog();
    } catch (error) {
      const failure = writeErrorMessage(error);
      setFormError(failure.message);
      if (failure.reload) setReloadToken((value) => value + 1);
    } finally {
      setSubmitting(false);
    }
  }

  if (!isAdministrator) {
    return (
      <section className="source-approval" aria-labelledby="source-approval-title">
        <h2 id="source-approval-title">Persetujuan sumber</h2>
        <p className="source-approval__notice" role="status">Persetujuan sumber hanya dapat diubah oleh administrator yang masuk.</p>
      </section>
    );
  }
  if (!canManage) {
    return (
      <section className="source-approval" aria-labelledby="source-approval-title">
        <h2 id="source-approval-title">Persetujuan sumber</h2>
        <p className="source-approval__notice" role="status">Sesi belum lengkap. Muat ulang halaman untuk mengubah persetujuan sumber.</p>
      </section>
    );
  }

  const changeName = change?.source.display_name ?? "";
  return (
    <section className="source-approval" aria-labelledby="source-approval-title">
      <h2 id="source-approval-title">Persetujuan sumber</h2>
      <p className="source-approval__intro">{SOURCE_APPROVAL_INTRO}</p>
      {message && <p className="source-approval__message" role="status">{message}</p>}
      {list.status === "loading" && <p role="status">Memuat daftar sumber…</p>}
      {list.status === "error" && (
        <p role="alert">
          {list.message}{" "}
          <button type="button" className="button button--quiet" onClick={() => setReloadToken((value) => value + 1)}>Coba lagi</button>
        </p>
      )}
      {list.status === "ready" && (
        <SourceApprovalList
          sources={list.sources}
          onRequestChange={(source, status) => {
            setMessage(null);
            setFormError(null);
            setNote("");
            setChange({ source, status });
          }}
        />
      )}
      <Dialog open={change !== null} onClose={closeDialog} titleId="source-approval-dialog-title" className="source-approval__dialog">
        {change && (
          <>
            <h2 id="source-approval-dialog-title">{change.status === "approved" ? `Setujui ${changeName}` : `Cabut persetujuan ${changeName}`}</h2>
            <p>{sourceApprovalDialogBody(change.status)}</p>
            <label className="source-approval__note">
              Catatan (10 sampai 500 karakter)
              <textarea
                value={note}
                onChange={(event) => setNote(event.currentTarget.value)}
                maxLength={500}
                rows={3}
                disabled={submitting}
                required
              />
            </label>
            <p className="source-approval__count">{note.trim().length} / 500</p>
            {formError && <p role="alert" className="source-approval__error">{formError}</p>}
            <div className="source-approval__actions">
              <button type="button" className="button button--quiet" onClick={closeDialog} disabled={submitting}>Batal</button>
              <button
                type="button"
                className="button button--primary"
                onClick={() => void submit()}
                disabled={submitting || note.trim().length < 10}
              >
                {submitting ? "Menyimpan…" : change.status === "approved" ? "Simpan persetujuan" : "Cabut persetujuan"}
              </button>
            </div>
          </>
        )}
      </Dialog>
    </section>
  );
}

export default SourceApprovalPanel;
