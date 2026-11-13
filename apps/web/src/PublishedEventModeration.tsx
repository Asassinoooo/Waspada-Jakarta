import * as React from "react";
import { useEffect, useId, useState, type FormEvent } from "react";
import { Dialog } from "./ui/Dialog.js";

/**
 * TG-FR12 (FR-12): moderator controls on published events. "Tarik peristiwa" withdraws an event and
 * "Ajukan koreksi" submits a correction. Both go through the server's CSRF-protected moderation routes and the
 * same publication gate as every other decision. Gate refusals are shown with plain Bahasa Indonesia reasons.
 */

export const WITHDRAWAL_REASON_OPTIONS = [
  { value: "source_retracted", label: "Sumber menarik kembali laporannya" },
  { value: "evidence_ineligible", label: "Bukti tidak memenuhi syarat" },
  { value: "incorrect_event_match", label: "Salah dikaitkan dengan peristiwa ini" },
  { value: "privacy_removal", label: "Penghapusan demi privasi" },
  { value: "duplicate", label: "Duplikat peristiwa lain" },
  { value: "other", label: "Alasan lain" },
] as const;

export type WithdrawalReasonValue = (typeof WITHDRAWAL_REASON_OPTIONS)[number]["value"];

const GATE_REASON_LABELS: Readonly<Record<string, string>> = {
  schema_invalid: "Data koreksi tidak lengkap atau tidak valid.",
  claims_missing: "Peristiwa harus memiliki minimal satu klaim.",
  claim_unsupported: "Ada klaim yang belum didukung bukti.",
  claim_quote_missing: "Ada klaim tanpa kutipan bukti.",
  claim_source_link_missing: "Ada klaim tanpa tautan sumber yang valid.",
  source_rights_missing: "Sumber klaim belum memiliki izin tampil publik.",
  time_missing: "Waktu kejadian belum jelas. Koreksi harus tetap mencantumkan waktu.",
  investigation_stopped_for_review: "Kasus terkait masih ditahan untuk tinjauan.",
  publication_not_authorized: "Gerbang publikasi menolak koreksi ini.",
};

/** A gate reason as a sentence. An unknown code is never shown raw. */
export function gateReasonLabel(reason: string): string {
  return GATE_REASON_LABELS[reason] ?? "Gerbang publikasi menolak koreksi ini.";
}

/** Client-side check of the withdrawal reason: 10 to 500 characters after trimming. The server checks it again. */
export function withdrawalReasonError(reason: string): string | null {
  const length = reason.trim().length;
  if (length < 10) return "Alasan penarikan minimal 10 karakter.";
  if (length > 500) return "Alasan penarikan maksimal 500 karakter.";
  return null;
}

export class ModerationActionError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
    readonly reasons: readonly string[] = [],
  ) {
    super(message);
    this.name = "ModerationActionError";
  }
}

export interface ModerationActionOptions {
  readonly fetcher?: typeof fetch;
  readonly csrfToken?: string;
  readonly apiBaseUrl?: string;
}

export interface WithdrawalResponse {
  readonly ok: boolean;
  readonly status: "withdrawn";
  readonly event_id: string;
  readonly version: number;
  readonly withdrawal_reason: string;
}

export interface CorrectionResponse {
  readonly ok: boolean;
  readonly status: "published" | "unchanged";
  readonly event_id: string;
  readonly version: number;
}

export interface CorrectionBody {
  readonly base_version: number;
  readonly title?: string;
  readonly category?: string;
  readonly claims?: readonly { readonly claim_id: string; readonly claim_text: string }[];
  readonly reason?: string;
}

async function postModerationAction<T>(
  path: string,
  body: unknown,
  options: ModerationActionOptions,
): Promise<T> {
  const base = options.apiBaseUrl ?? "/api/v1/moderation";
  const fetchFn = options.fetcher ?? globalThis.fetch.bind(globalThis);
  const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json" };
  if (options.csrfToken) headers["X-CSRF-Token"] = options.csrfToken;
  const response = await fetchFn(`${base}${path}`, {
    method: "POST",
    headers,
    credentials: "same-origin",
    body: JSON.stringify(body),
  });
  const data = (await response.json().catch(() => ({}))) as {
    code?: string;
    message?: string;
    reasons?: unknown;
  };
  if (!response.ok) {
    throw new ModerationActionError(
      data.message ?? `HTTP ${response.status}`,
      response.status,
      data.code ?? "UNKNOWN",
      Array.isArray(data.reasons) ? data.reasons.filter((r): r is string => typeof r === "string") : [],
    );
  }
  return data as T;
}

export function withdrawPublishedEvent(
  eventId: string,
  body: { readonly reason: string; readonly reason_category: WithdrawalReasonValue },
  options: ModerationActionOptions = {},
): Promise<WithdrawalResponse> {
  return postModerationAction<WithdrawalResponse>(`/events/${encodeURIComponent(eventId)}/withdraw`, body, options);
}

export function submitEventCorrection(
  eventId: string,
  body: CorrectionBody,
  options: ModerationActionOptions = {},
): Promise<CorrectionResponse> {
  return postModerationAction<CorrectionResponse>(`/events/${encodeURIComponent(eventId)}/corrections`, body, options);
}

/** The public fields the controls need. The list endpoint returns these for each published event. */
export interface PublishedEventSummary {
  readonly event_id: string;
  readonly version: number;
  readonly title: string;
  readonly category: string;
  readonly claims: readonly { readonly claim_id: string; readonly text: string }[];
}

export interface PublishedEventModerationProps {
  /** Published events to show. When omitted, the public event list is loaded. */
  readonly events?: readonly PublishedEventSummary[];
  readonly csrfToken?: string;
  readonly apiBaseUrl?: string;
  readonly eventsUrl?: string;
  readonly fetcher?: typeof fetch;
}

type OpenDialog =
  | { readonly kind: "withdraw"; readonly event: PublishedEventSummary }
  | { readonly kind: "correct"; readonly event: PublishedEventSummary };

function summaryOf(event: PublishedEventSummary): string {
  return event.claims.map((claim) => claim.text).join(". ");
}

/** Gate refusals as a readable list, or the one-line message for any other failure. */
function ActionFailure({ error }: { readonly error: ModerationActionError }) {
  if (error.reasons.length > 0) {
    return (
      <div role="alert" className="pem__error">
        <p>Koreksi belum dapat diterbitkan. Tidak ada versi baru yang dibuat.</p>
        <ul>
          {error.reasons.map((reason) => <li key={reason}>{gateReasonLabel(reason)}</li>)}
        </ul>
      </div>
    );
  }
  return <p role="alert" className="pem__error">{failureMessage(error)}</p>;
}

function failureMessage(error: ModerationActionError): string {
  switch (error.code) {
    case "ALREADY_WITHDRAWN":
      return "Peristiwa ini sudah ditarik sebelumnya.";
    case "EVENT_WITHDRAWN":
      return "Peristiwa sudah ditarik dan tidak dapat dikoreksi.";
    case "STALE_BASE_VERSION":
      return "Peristiwa sudah berubah sejak Anda membukanya. Muat ulang daftar lalu coba lagi.";
    case "FORBIDDEN":
      return "Akun Anda tidak memiliki izin untuk tindakan ini.";
    case "CSRF_TOKEN_INVALID":
    case "CSRF_ORIGIN_MISMATCH":
      return "Sesi Anda tidak valid. Muat ulang halaman lalu coba lagi.";
    case "WITHDRAWAL_UNAVAILABLE":
    case "CORRECTION_UNAVAILABLE":
    case "TEMPORARILY_UNAVAILABLE":
      return "Layanan tidak tersedia untuk tindakan ini saat ini.";
    default:
      return `Tindakan gagal: ${error.message}`;
  }
}

function WithdrawDialog({
  event,
  onClose,
  onWithdrawn,
  submit,
}: {
  readonly event: PublishedEventSummary;
  readonly onClose: () => void;
  readonly onWithdrawn: (version: number) => void;
  readonly submit: (reason: string, category: WithdrawalReasonValue) => Promise<WithdrawalResponse>;
}) {
  const titleId = useId();
  const [reason, setReason] = useState("");
  const [category, setCategory] = useState<WithdrawalReasonValue>("source_retracted");
  const [error, setError] = useState<ModerationActionError | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(formEvent: FormEvent<HTMLFormElement>) {
    formEvent.preventDefault();
    const problem = withdrawalReasonError(reason);
    setLocalError(problem);
    if (problem || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const result = await submit(reason.trim(), category);
      onWithdrawn(result.version);
    } catch (caught) {
      setError(caught instanceof ModerationActionError ? caught : new ModerationActionError(String(caught), 0, "UNKNOWN"));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open onClose={onClose} titleId={titleId} className="pem__dialog">
      <form onSubmit={onSubmit} className="pem__form">
        <h3 id={titleId}>Tarik peristiwa: {event.title}</h3>
        <p>
          Peristiwa ditarik dari daftar publik. Penarikan tidak sama dengan penyelesaian, dan tidak menyatakan
          bahwa suatu area aman. Alasan lengkap hanya tercatat di log audit internal.
        </p>
        <label>
          Kategori alasan
          <select value={category} onChange={(e) => setCategory(e.target.value as WithdrawalReasonValue)}>
            {WITHDRAWAL_REASON_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
        </label>
        <label>
          Alasan (internal, 10 sampai 500 karakter)
          <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={4} maxLength={500} />
        </label>
        {localError ? <p role="alert" className="pem__error">{localError}</p> : null}
        {error ? <ActionFailure error={error} /> : null}
        <div className="pem__actions">
          <button type="button" onClick={onClose} disabled={submitting}>Batal</button>
          <button type="submit" disabled={submitting}>
            {submitting ? "Menarik…" : "Ya, tarik peristiwa"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

function CorrectionDialog({
  event,
  onClose,
  onCorrected,
  submit,
}: {
  readonly event: PublishedEventSummary;
  readonly onClose: () => void;
  readonly onCorrected: (message: string) => void;
  readonly submit: (body: CorrectionBody) => Promise<CorrectionResponse>;
}) {
  const titleId = useId();
  const [title, setTitle] = useState(event.title);
  const [category, setCategory] = useState(event.category);
  const [claimTexts, setClaimTexts] = useState<readonly string[]>(() => event.claims.map((claim) => claim.text));
  const [reason, setReason] = useState("");
  const [error, setError] = useState<ModerationActionError | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(formEvent: FormEvent<HTMLFormElement>) {
    formEvent.preventDefault();
    if (submitting) return;
    // Only changed fields are sent. A submission with no change is answered "unchanged" by the server.
    const claims = event.claims
      .map((claim, index) => ({ claim_id: claim.claim_id, claim_text: (claimTexts[index] ?? "").trim(), original: claim.text }))
      .filter((edit) => edit.claim_text !== edit.original.trim())
      .map(({ claim_id, claim_text }) => ({ claim_id, claim_text }));
    const body: CorrectionBody = {
      base_version: event.version,
      ...(title.trim() !== event.title ? { title: title.trim() } : {}),
      ...(category !== event.category ? { category } : {}),
      ...(claims.length > 0 ? { claims } : {}),
      ...(reason.trim().length > 0 ? { reason: reason.trim() } : {}),
    };
    setSubmitting(true);
    setError(null);
    try {
      const result = await submit(body);
      onCorrected(
        result.status === "unchanged"
          ? "Tidak ada perubahan fakta. Versi tetap seperti sebelumnya."
          : `Koreksi diterbitkan sebagai versi ${result.version}.`,
      );
    } catch (caught) {
      setError(caught instanceof ModerationActionError ? caught : new ModerationActionError(String(caught), 0, "UNKNOWN"));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open onClose={onClose} titleId={titleId} className="pem__dialog">
      <form onSubmit={onSubmit} className="pem__form">
        <h3 id={titleId}>Ajukan koreksi: versi {event.version}</h3>
        <p>Koreksi melewati gerbang publikasi yang sama dengan laporan lain. Bukti dan sumber setiap klaim tidak berubah.</p>
        <label>
          Judul
          <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={240} />
        </label>
        <label>
          Kategori
          <input value={category} onChange={(e) => setCategory(e.target.value)} />
        </label>
        {event.claims.map((claim, index) => (
          <label key={claim.claim_id}>
            Teks klaim {index + 1}
            <textarea
              rows={3}
              maxLength={500}
              value={claimTexts[index] ?? ""}
              onChange={(e) => setClaimTexts(claimTexts.map((text, i) => (i === index ? e.target.value : text)))}
            />
          </label>
        ))}
        <p className="pem__summary">Ringkasan publik (dari teks klaim): {summaryOf({ ...event, claims: event.claims.map((c, i) => ({ ...c, text: claimTexts[i] ?? c.text })) })}</p>
        <label>
          Alasan koreksi (internal, opsional)
          <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={2} maxLength={500} />
        </label>
        {error ? <ActionFailure error={error} /> : null}
        <div className="pem__actions">
          <button type="button" onClick={onClose} disabled={submitting}>Batal</button>
          <button type="submit" disabled={submitting}>{submitting ? "Mengirim…" : "Kirim koreksi"}</button>
        </div>
      </form>
    </Dialog>
  );
}

export function PublishedEventModeration({
  events: providedEvents,
  csrfToken: providedCsrf,
  apiBaseUrl,
  eventsUrl = "/api/v1/events",
  fetcher,
}: PublishedEventModerationProps = {}): React.JSX.Element {
  const [loaded, setLoaded] = useState<readonly PublishedEventSummary[] | null>(providedEvents ?? null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [sessionCsrf, setSessionCsrf] = useState("");
  const [open, setOpen] = useState<OpenDialog | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [withdrawnIds, setWithdrawnIds] = useState<ReadonlySet<string>>(() => new Set());
  const csrfToken = providedCsrf || sessionCsrf;

  useEffect(() => {
    if (providedEvents) return;
    const fetchFn = fetcher ?? globalThis.fetch.bind(globalThis);
    let cancelled = false;
    fetchFn(eventsUrl, { headers: { accept: "application/json" }, credentials: "same-origin" })
      .then(async (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = (await response.json()) as { data?: PublishedEventSummary[] };
        if (!cancelled) setLoaded(data.data ?? []);
      })
      .catch((caught: unknown) => {
        if (!cancelled) setLoadError(`Gagal memuat peristiwa terbit: ${caught instanceof Error ? caught.message : String(caught)}`);
      });
    return () => {
      cancelled = true;
    };
  }, [providedEvents, eventsUrl, fetcher]);

  useEffect(() => {
    if (providedCsrf || typeof window === "undefined") return;
    fetch("/api/v1/auth/session", { credentials: "same-origin" })
      .then((response) => (response.ok ? response.json() : null))
      .then((data: unknown) => {
        const token = data && typeof data === "object" ? (data as { csrf_token?: unknown }).csrf_token : undefined;
        if (typeof token === "string") setSessionCsrf(token);
      })
      .catch(() => undefined);
  }, [providedCsrf]);

  const events = (loaded ?? []).filter((event) => !withdrawnIds.has(event.event_id));
  const options = { csrfToken, apiBaseUrl, fetcher };

  return (
    <section className="pem" aria-labelledby="pem-heading">
      <h2 id="pem-heading">Peristiwa terbit</h2>
      <p className="pem__note">
        Penarikan dan koreksi dicatat di log audit dan melewati gerbang publikasi yang sama dengan laporan lain.
      </p>
      {notice ? <p role="status" className="pem__notice">{notice}</p> : null}
      {loadError ? <p role="alert" className="pem__error">{loadError}</p> : null}
      {loaded === null && !loadError ? <p>Memuat peristiwa terbit…</p> : null}
      {loaded !== null && events.length === 0 ? <p>Belum ada peristiwa terbit.</p> : null}
      <ul className="pem__list">
        {events.map((event) => (
          <li key={event.event_id} className="pem__item">
            <p>
              <strong>{event.title}</strong> <span>versi {event.version}</span>
            </p>
            <div className="pem__actions">
              <button type="button" onClick={() => setOpen({ kind: "withdraw", event })}>Tarik peristiwa</button>
              <button type="button" onClick={() => setOpen({ kind: "correct", event })}>Ajukan koreksi</button>
            </div>
          </li>
        ))}
      </ul>
      {open?.kind === "withdraw" ? (
        <WithdrawDialog
          event={open.event}
          onClose={() => setOpen(null)}
          submit={(reason, reasonCategory) =>
            withdrawPublishedEvent(open.event.event_id, { reason, reason_category: reasonCategory }, options)}
          onWithdrawn={(version) => {
            setWithdrawnIds((current) => new Set([...current, open.event.event_id]));
            setNotice(`Peristiwa "${open.event.title}" ditarik. Ditarik oleh moderator pada versi ${version}.`);
            setOpen(null);
          }}
        />
      ) : null}
      {open?.kind === "correct" ? (
        <CorrectionDialog
          event={open.event}
          onClose={() => setOpen(null)}
          submit={(body) => submitEventCorrection(open.event.event_id, body, options)}
          onCorrected={(message) => {
            setNotice(message);
            setOpen(null);
          }}
        />
      ) : null}
    </section>
  );
}
