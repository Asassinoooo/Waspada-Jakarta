import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { BriefingInterests, BriefingResponse, EventView, PublicContext, TimeScope } from "@waspada/worker/public-contracts";
import { categoryLabel } from "./display.js";
import { requestBriefing } from "./api-client.js";
import { normalizeInterests } from "./preferences-store.js";

export type BriefingDisplayState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "unavailable" }
  | { status: "loaded"; data: BriefingResponse };

export interface BriefingRequestTicket {
  sequence: number;
  snapshotKey: string;
}

export function hasEffectiveBriefingInterest(interests: BriefingInterests) {
  return interests.places.length > 0
    || interests.services.length > 0
    || interests.institutions.length > 0
    || interests.audiences.length > 0
    || interests.categories.length > 0;
}

export function briefingSnapshotKey(
  context: PublicContext | null,
  interests: BriefingInterests,
  contextSnapshotId?: string,
): string | null {
  if (context?.dataset_mode !== "live") return null;
  const validation = normalizeInterests(interests);
  if (!validation.ok || !hasEffectiveBriefingInterest(validation.interests)) return null;
  return JSON.stringify([
    context.dataset_mode,
    context.dataset_label,
    context.generated_at,
    contextSnapshotId ?? "",
    validation.interests,
  ]);
}

export function requestBriefingIfEligible(
  context: PublicContext | null,
  interests: BriefingInterests,
  send: (value: BriefingInterests) => Promise<BriefingResponse> = requestBriefing,
): Promise<BriefingResponse> | null {
  if (context?.dataset_mode !== "live") return null;
  const validation = normalizeInterests(interests);
  if (!validation.ok || !hasEffectiveBriefingInterest(validation.interests)) return null;
  return send(validation.interests);
}

export function isCurrentBriefingRequest(
  ticket: BriefingRequestTicket,
  current: BriefingRequestTicket | null,
) {
  return current !== null
    && ticket.sequence === current.sequence
    && ticket.snapshotKey === current.snapshotKey;
}

function formatBriefingInstant(value: string | null | undefined) {
  if (!value) return "Tidak tersedia";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Waktu tidak valid";
  return new Intl.DateTimeFormat("id-ID", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Jakarta",
    hourCycle: "h23",
  }).format(date) + " WIB";
}

function formatBriefingDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Tanggal tidak valid";
  return new Intl.DateTimeFormat("id-ID", {
    dateStyle: "medium",
    timeZone: "Asia/Jakarta",
  }).format(date);
}

function formatBriefingEventTime(time: TimeScope) {
  if (time.precision === "unknown" || !time.start) return "Tidak diketahui";
  const format = time.precision === "date" ? formatBriefingDate : formatBriefingInstant;
  const start = format(time.start);
  const value = time.end ? start + " sampai " + format(time.end) : start;
  const precision = time.precision === "date" ? "tanggal saja" : time.precision === "range" ? "rentang waktu" : "waktu tepat";
  return value + " (" + precision + ")";
}

function lifecycleLabel(value: EventView["lifecycle"]) {
  switch (value) {
    case "planned": return "Direncanakan";
    case "ongoing": return "Berlangsung";
    case "resolved": return "Selesai";
    case "cancelled": return "Dibatalkan";
    case "unknown": return "Belum diketahui";
  }
}

function freshnessLabel(value: EventView["freshness"]["status"]) {
  switch (value) {
    case "current": return "Dalam batas tinjau saat evaluasi";
    case "needs_update": return "Perlu diperbarui";
    case "expired": return "Masa berlaku sumber berakhir";
  }
}

function BriefingItemCard({ item }: { item: BriefingResponse["items"][number] }) {
  const event = item.event;
  return (
    <article className="briefing-result" aria-labelledby={"briefing-event-" + encodeURIComponent(event.event_id)}>
      <div className="briefing-result__heading">
        <div>
          <p className="briefing-result__category">{categoryLabel(event.category)}</p>
          <h3 id={"briefing-event-" + encodeURIComponent(event.event_id)}>{event.title}</h3>
        </div>
        <a className="text-link" href={"#detail/api/" + encodeURIComponent(event.event_id)}>
          Lihat detail dan bukti
        </a>
      </div>
      <section className="briefing-result__relevance" aria-label="Alasan kecocokan">
        <strong>Mengapa muncul</strong>
        <ul>
          {item.relevance_reasons.map((reason, index) => <li key={index}>{reason}</li>)}
        </ul>
      </section>
      <dl className="briefing-result__facts">
        <div><dt>Siklus</dt><dd>{lifecycleLabel(event.lifecycle)}</dd></div>
        <div><dt>Kesegaran</dt><dd>{freshnessLabel(event.freshness.status)}</dd></div>
        <div><dt>Waktu kejadian</dt><dd>{formatBriefingEventTime(event.event_time)}</dd></div>
        <div><dt>Waktu terbit</dt><dd>{formatBriefingInstant(event.published_at)}</dd></div>
      </dl>
    </article>
  );
}

interface BriefingResultsViewProps {
  context: PublicContext | null;
  interests: BriefingInterests;
  state: BriefingDisplayState;
  onRequest: () => void;
}

export function BriefingResultsView({ context, interests, state, onRequest }: BriefingResultsViewProps) {
  const hasInterests = hasEffectiveBriefingInterest(interests);
  const canRequest = context?.dataset_mode === "live" && hasInterests;
  const responseState = canRequest ? state : { status: "idle" as const };

  return (
    <section className="preferences-briefing" aria-labelledby="briefing-status-title">
      <p className="section-kicker">Ringkasan pribadi</p>
      <h2 id="briefing-status-title">Informasi terbit yang cocok dengan minat Anda</h2>
      <p className="briefing-intro">
        Kecocokan menjelaskan relevansi terhadap pilihan Anda. Kecocokan bukan penilaian bahaya atau pernyataan bahwa suatu area aman.
      </p>

      {context === null ? (
        <p className="briefing-status" role="status">
          Briefing live belum tersedia karena status dataset belum dapat diverifikasi dari API.
        </p>
      ) : context.dataset_mode !== "live" ? (
        <p className="briefing-status" role="status">
          Briefing live tidak tersedia pada mode demo. Data demo tidak digunakan untuk mencocokkan minat.
        </p>
      ) : !hasInterests ? (
        <p className="briefing-status" role="status">
          Pilih setidaknya satu tempat, layanan, institusi, kelompok, atau kategori untuk meminta briefing.
        </p>
      ) : responseState.status === "idle" ? (
        <div className="briefing-idle">
          <p className="briefing-status" role="status">Briefing belum diminta. Minat hanya dikirim setelah Anda memilih tombol berikut.</p>
          <button className="button button--primary" type="button" onClick={onRequest}>Tampilkan ringkasan</button>
        </div>
      ) : responseState.status === "loading" ? (
        <div className="briefing-loading" role="status" aria-live="polite" aria-busy="true">
          <p className="briefing-status">Memuat briefing live…</p>
          <button className="button button--primary" type="button" disabled>Tunggu sebentar…</button>
        </div>
      ) : responseState.status === "unavailable" ? (
        <div className="briefing-error" role="alert">
          <p>Briefing belum dapat dimuat. Minat Anda tetap tersimpan di browser ini.</p>
          <button className="button button--quiet" type="button" onClick={onRequest}>Coba lagi</button>
        </div>
      ) : responseState.data.items.length === 0 ? (
        <div className="briefing-empty">
          <p className="briefing-status" role="status">Belum ada informasi terbit yang cocok dengan minat Anda.</p>
          <button className="button button--quiet" type="button" onClick={onRequest}>Perbarui ringkasan</button>
        </div>
      ) : (
        <div className="briefing-matched">
          <p className="briefing-status" role="status">{responseState.data.items.length} informasi terbit cocok dengan pilihan Anda.</p>
          <button className="button button--quiet" type="button" onClick={onRequest}>Perbarui ringkasan</button>
          <ol className="briefing-results" aria-label="Hasil briefing live">
            {responseState.data.items.map((item) => (
              <li key={item.event.event_id + ":" + item.event.version}><BriefingItemCard item={item} /></li>
            ))}
          </ol>
        </div>
      )}
      <p className="briefing-updates-note">Pembaruan otomatis belum tersedia.</p>
    </section>
  );
}

interface BriefingResultsProps {
  context: PublicContext | null;
  interests: BriefingInterests;
  contextSnapshotId?: string;
}

type InternalBriefingState =
  | { status: "idle" }
  | { status: "loading"; snapshotKey: string }
  | { status: "unavailable"; snapshotKey: string }
  | { status: "loaded"; snapshotKey: string; data: BriefingResponse };

const useIsoLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

export function BriefingResults({ context, interests, contextSnapshotId }: BriefingResultsProps) {
  const snapshotKey = briefingSnapshotKey(context, interests, contextSnapshotId);
  const activeSnapshotRef = useRef<string | null>(snapshotKey);
  const requestSequenceRef = useRef(0);
  const [state, setState] = useState<InternalBriefingState>({ status: "idle" });

  useIsoLayoutEffect(() => {
    if (activeSnapshotRef.current !== snapshotKey) {
      activeSnapshotRef.current = snapshotKey;
      requestSequenceRef.current += 1;
      setState({ status: "idle" });
    }
  }, [snapshotKey]);

  const request = () => {
    const currentSnapshot = briefingSnapshotKey(context, interests, contextSnapshotId);
    if (currentSnapshot === null || currentSnapshot !== activeSnapshotRef.current) return;

    const requestPromise = requestBriefingIfEligible(context, interests);
    if (requestPromise === null) return;

    const ticket = { sequence: ++requestSequenceRef.current, snapshotKey: currentSnapshot };
    activeSnapshotRef.current = currentSnapshot;
    setState({ status: "loading", snapshotKey: currentSnapshot });

    void requestPromise.then((data) => {
      if (!isCurrentBriefingRequest(ticket, {
        sequence: requestSequenceRef.current,
        snapshotKey: activeSnapshotRef.current ?? "",
      })) return;
      setState({ status: "loaded", snapshotKey: currentSnapshot, data });
    }).catch(() => {
      if (!isCurrentBriefingRequest(ticket, {
        sequence: requestSequenceRef.current,
        snapshotKey: activeSnapshotRef.current ?? "",
      })) return;
      setState({ status: "unavailable", snapshotKey: currentSnapshot });
    });
  };

  const visibleState: BriefingDisplayState = state.status === "idle" || state.snapshotKey !== snapshotKey
    ? { status: "idle" }
    : state.status === "loaded"
      ? { status: "loaded", data: state.data }
      : { status: state.status };

  return <BriefingResultsView context={context} interests={interests} state={visibleState} onRequest={request} />;
}
