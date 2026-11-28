/*
 * ADMIN-BRIEF-01: the admin workspace overview. It replaces the public-API inspector (simulation mode, second map,
 * record inspector) with a brief of the five layers built from the same pipeline-flow-v1 snapshot as Alur agen, what
 * waits for a person, and the latest published reports. It reads; it never changes anything.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { PipelineFlowRange, PipelineFlowSnapshotDto } from "@waspada/worker/pipeline-flow-contracts";
import type { EventView } from "@waspada/worker/public-contracts";
import { PIPELINE_FLOW_RANGES } from "@waspada/worker/pipeline-flow-contracts";
import { fetchPipelineFlowSnapshot, PipelineFlowHttpError } from "./pipeline-flow-client.js";
import {
  PIPELINE_HEALTH_LABELS,
  PIPELINE_RANGE_LABELS,
  readStoredPipelineFlowRange,
  writeStoredPipelineFlowRange,
} from "./pipeline-flow-model.js";
import { overviewAttention, overviewLayers, overviewWindowNote } from "./admin-overview-model.js";
import { adminTabHash } from "./admin-workspace-model.js";
import { listEvents } from "./api-client.js";
import { categoryLabel, formatInstant } from "./display.js";

const REFRESH_MS = 60_000;
const RECENT_LIMIT = 5;

type Load<T> = { status: "loading" } | { status: "ready"; value: T } | { status: "error"; message: string };

function flowErrorMessage(error: unknown): string {
  if (error instanceof PipelineFlowHttpError && (error.status === 401 || error.status === 403)) {
    return "Sesi tidak lagi berlaku untuk data alur. Masuk ulang untuk melihatnya.";
  }
  return "Data alur tidak dapat dibaca saat ini. Angka yang tidak terbaca tidak dihitung sebagai nol.";
}

export interface AdminOverviewProps {
  /** Feed failures link to Sumber only for people who can open that tab. */
  readonly canOpenSources?: boolean;
}

export default function AdminOverview({ canOpenSources = false }: AdminOverviewProps) {
  const [range, setRange] = useState<PipelineFlowRange>(() => readStoredPipelineFlowRange());
  const [flow, setFlow] = useState<Load<PipelineFlowSnapshotDto>>({ status: "loading" });
  const [recent, setRecent] = useState<Load<EventView[]>>({ status: "loading" });
  const [refreshing, setRefreshing] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const controllerRef = useRef<AbortController | null>(null);

  const load = useCallback(async (nextRange: PipelineFlowRange) => {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    setRefreshing(true);
    const [flowResult, recentResult] = await Promise.allSettled([
      fetchPipelineFlowSnapshot(nextRange, controller.signal),
      listEvents(undefined, 20),
    ]);
    if (controller.signal.aborted) return;
    setFlow(flowResult.status === "fulfilled"
      ? { status: "ready", value: flowResult.value }
      : { status: "error", message: flowErrorMessage(flowResult.reason) });
    setRecent(recentResult.status === "fulfilled"
      ? { status: "ready", value: newestPublished(recentResult.value.data) }
      : { status: "error", message: "Daftar laporan terbit tidak dapat dibaca saat ini." });
    setNowMs(Date.now());
    setRefreshing(false);
  }, []);

  useEffect(() => {
    void load(range);
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void load(range);
    }, REFRESH_MS);
    return () => {
      window.clearInterval(timer);
      controllerRef.current?.abort();
    };
  }, [load, range]);

  function pickRange(next: PipelineFlowRange) {
    writeStoredPipelineFlowRange(next);
    setRange(next);
  }

  const snapshot = flow.status === "ready" ? flow.value : null;
  const layers = snapshot ? overviewLayers(snapshot, nowMs) : null;
  const attention = snapshot ? overviewAttention(snapshot, { canOpenSources }) : null;

  return (
    <div className="overview">
      <header className="overview__head">
        <div className="overview__intro">
          <p className="overview__kicker">Ringkasan</p>
          <h2 id="overview-title">Keadaan sistem</h2>
          <p className="overview__lede">
            Lima lapis kerja dari sumber sampai terbit, dan apa yang menunggu tindakan. Angka ini tentang alur kerja,
            bukan tentang keadaan di lapangan.
          </p>
        </div>
        <div className="overview__controls">
          <div className="pipeline-range" role="group" aria-label="Rentang waktu">
            {PIPELINE_FLOW_RANGES.map((option) => (
              <button key={option} type="button" className="filter-pill" aria-pressed={range === option} onClick={() => pickRange(option)}>
                {PIPELINE_RANGE_LABELS[option]}
              </button>
            ))}
          </div>
          <button type="button" className="button button--quiet button--sm" onClick={() => void load(range)} disabled={refreshing}>
            {refreshing ? "Memuat…" : "Muat ulang"}
          </button>
        </div>
        <p className="overview__meta" aria-live="polite">
          {snapshot?.dataset_mode === "demo" && <span className="overview__badge">Data contoh</span>}
          {snapshot ? <>Diperbarui {formatInstant(snapshot.generated_at)}</> : flow.status === "loading" ? "Membaca data alur…" : null}
        </p>
      </header>

      <section className="overview__section" aria-labelledby="overview-attention-title">
        <h3 id="overview-attention-title">Perlu tindakan</h3>
        {flow.status === "error" && <p className="overview__error" role="status">{flow.message}</p>}
        {flow.status === "loading" && <p className="overview__placeholder">Memuat…</p>}
        {attention && attention.length === 0 && (
          <p className="overview__empty">Tidak ada yang menunggu tindakan.</p>
        )}
        {attention && attention.length > 0 && (
          <ul className="overview__attention">
            {attention.map((item) => (
              <li key={item.id} className={`overview__alert overview__alert--${item.tone}`}>
                <span className="overview__dot" aria-hidden="true" />
                <span className="overview__alert-text">{item.text}</span>
                <a className="text-link" href={item.href}>{item.action}</a>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="overview__section" aria-labelledby="overview-layers-title">
        <div className="overview__section-head">
          <h3 id="overview-layers-title">Lima lapis</h3>
          <a className="text-link" href={adminTabHash("alur")}>Buka Alur agen</a>
        </div>
        {snapshot && <p className="overview__note">{overviewWindowNote(snapshot)}</p>}
        <ol className="overview__layers">
          {(layers ?? []).map((layer) => (
            <li key={layer.id} className={`overview-layer overview-layer--${layer.health}`}>
              <div className="overview-layer__top">
                <span className="overview-layer__id">{layer.id}</span>
                <span className="overview-layer__health">
                  <span className="overview__dot" aria-hidden="true" />
                  {PIPELINE_HEALTH_LABELS[layer.health]}
                </span>
              </div>
              <h4>{layer.name}</h4>
              <p className="overview-layer__role">{layer.role}</p>
              <dl className="overview-layer__metrics">
                {layer.metrics.map((metric) => (
                  <div key={metric.label}>
                    <dt>{metric.label}</dt>
                    <dd>{metric.value ?? <span aria-label="Tidak tersedia">—</span>}</dd>
                  </div>
                ))}
              </dl>
              {layer.failingStages.length > 0 && (
                <p className="overview-layer__failing">Gagal: {layer.failingStages.join(", ")}</p>
              )}
            </li>
          ))}
          {!layers && PIPELINE_FLOW_PLACEHOLDERS.map((id) => (
            <li key={id} className="overview-layer overview-layer--unavailable" aria-hidden="true">
              <div className="overview-layer__top"><span className="overview-layer__id">{id}</span></div>
              <h4>&nbsp;</h4>
            </li>
          ))}
        </ol>
      </section>

      <section className="overview__section" aria-labelledby="overview-recent-title">
        <div className="overview__section-head">
          <h3 id="overview-recent-title">Terbit terakhir</h3>
          <a className="text-link" href="#peta">Buka peta</a>
        </div>
        {recent.status === "loading" && <p className="overview__placeholder">Memuat…</p>}
        {recent.status === "error" && <p className="overview__error" role="status">{recent.message}</p>}
        {recent.status === "ready" && recent.value.length === 0 && (
          <p className="overview__empty">Belum ada laporan terbit. Ini bukan pernyataan bahwa kondisi aman.</p>
        )}
        {recent.status === "ready" && recent.value.length > 0 && (
          <ul className="overview__recent">
            {recent.value.map((event) => (
              <li key={event.event_id}>
                <a href={`#detail/api/${encodeURIComponent(event.event_id)}`}>{event.title}</a>
                <span className="overview__recent-meta">
                  {categoryLabel(event.category)} · {formatInstant(event.published_at)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

/** The list endpoint's order is not a publication order, so sort by publication time here. */
function newestPublished(events: readonly EventView[]): EventView[] {
  return [...events].sort((a, b) => Date.parse(b.published_at) - Date.parse(a.published_at)).slice(0, RECENT_LIMIT);
}

const PIPELINE_FLOW_PLACEHOLDERS = ["L1", "L2", "L3", "L4", "L5"] as const;
