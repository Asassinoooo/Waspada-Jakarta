/**
 * FLOW-VIS-01 `#alur-agen`: a node-graph view of how live items move through layers L1 to L5.
 * Moderators and admins only; the route wraps it in AccountAccessGate (shell "review"). Counts are
 * not corroboration and never prove that an area is safe.
 */
import { createContext, type RefObject, useCallback, useContext, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import {
  Background,
  Handle,
  Position,
  ReactFlow,
  type Edge,
  type FitViewOptions,
  type Node,
  type NodeProps,
  type NodeTypes,
  useNodesInitialized,
  useReactFlow,
} from "@xyflow/react";
import type {
  PipelineFlowItemsDto,
  PipelineFlowNineRouterDto,
  PipelineFlowNodeId,
  PipelineFlowSnapshotDto,
} from "@waspada/worker/pipeline-flow-contracts";
import { fetchPipelineFlowItems, fetchPipelineFlowSnapshot, PipelineFlowHttpError } from "./pipeline-flow-client.js";
import {
  cooldownLabel,
  itemRows,
  nodeView,
  PIPELINE_FLOW_NODE_TYPE,
  PIPELINE_LANE_NODE_TYPE,
  PIPELINE_NODE_META,
  PIPELINE_REVIEW_LINK_NODES,
  relativeTimeLabel,
  toPipelineFlowGraph,
  type PipelineFlowCardData,
  type PipelineFlowNodeView,
  type PipelineLaneNodeData,
} from "./pipeline-flow-model.js";
import { PIPELINE_DEFAULT_POSITIONS, type PipelineHandleSide } from "./pipeline-flow-layout.js";
import { PIPELINE_LAYER_IDS, PIPELINE_LAYER_NAMES } from "./pipeline-layers.js";
import { formatInstant } from "./display.js";

export const PIPELINE_POLL_INTERVAL_MS = 5_000;

const SelectContext = createContext<(id: PipelineFlowNodeId) => void>(() => {});

function countText(value: number | null): string {
  return value === null ? "—" : value.toLocaleString("id-ID");
}

/** Remaining NineRouter cooldown now, counted down from the snapshot's own clock. */
export function remainingCooldownMs(remainingAtSnapshot: number, generatedAt: string | null, nowMs: number): number {
  if (remainingAtSnapshot <= 0 || generatedAt === null) return Math.max(0, remainingAtSnapshot);
  const generated = Date.parse(generatedAt);
  if (!Number.isFinite(generated)) return remainingAtSnapshot;
  return Math.max(0, remainingAtSnapshot - Math.max(0, nowMs - generated));
}

/** A clock that ticks once a second, so the NineRouter countdown moves between snapshots. */
export function useNowTick(intervalMs = 1_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);
  return now;
}

export function NineRouterMeters({ runtime, generatedAt }: { runtime: PipelineFlowNineRouterDto; generatedAt: string | null }) {
  const nowMs = useNowTick();
  const bucket = (name: "Chat" | "Embedding", data: PipelineFlowNineRouterDto["chat"]) => {
    const used = Math.max(0, data.rpm - data.tokens_available);
    const percent = data.rpm > 0 ? Math.min(100, Math.round((used / data.rpm) * 100)) : 0;
    return (
      <div className="pipeline-meter" key={name}>
        <div className="pipeline-meter__label"><span>{name}</span><span>{data.tokens_available} dari {data.rpm} / menit</span></div>
        <div
          className="pipeline-meter__track"
          role="meter"
          aria-label={`Pemakaian ${name} dalam satu menit`}
          aria-valuemin={0}
          aria-valuemax={data.rpm}
          aria-valuenow={used}
          aria-valuetext={`${used} dari ${data.rpm} permintaan dipakai`}
        >
          <span className="pipeline-meter__fill" style={{ width: `${percent}%` }} />
        </div>
      </div>
    );
  };
  const cooldown = remainingCooldownMs(
    Math.max(runtime.chat.cooldown_remaining_ms, runtime.embed.cooldown_remaining_ms),
    generatedAt,
    nowMs,
  );
  return (
    <div className="pipeline-nine">
      {bucket("Chat", runtime.chat)}
      {bucket("Embedding", runtime.embed)}
      <p className="pipeline-nine__meta">
        <span>Masa tunggu: {cooldown > 0 ? cooldownLabel(cooldown) : "tidak ada"}</span>
        <span>Panggilan sejak start: {(runtime.call_counts.chat + runtime.call_counts.embed).toLocaleString("id-ID")}</span>
      </p>
    </div>
  );
}

function FlowNodeCard({ data }: NodeProps<Node<PipelineFlowCardData>>) {
  const select = useContext(SelectContext);
  const view: PipelineFlowNodeView = data.view;
  const unavailable = view.health === "unavailable";
  const onKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      select(view.id);
    }
  };
  return (
    <div
      className={`pipeline-card pipeline-card--${view.lane.toLowerCase()} pipeline-card--${view.health}`}
      role="button"
      tabIndex={0}
      aria-label={`${view.label}. ${view.healthLabel}. ${view.primaryLabel}: ${countText(view.primaryValue)}.`}
      onClick={() => select(view.id)}
      onKeyDown={onKey}
    >
      <CardHandles type="target" />
      <div className="pipeline-card__head">
        <span className="pipeline-card__lane">{view.lane}</span>
        <span className={`pipeline-card__dot pipeline-card__dot--${view.health}`} aria-hidden="true" />
        <h3 className="pipeline-card__title">{view.label}</h3>
      </div>
      {data.nineRouter ? (
        <NineRouterMeters runtime={data.nineRouter} generatedAt={data.nineRouterGeneratedAt} />
      ) : unavailable ? (
        <p className="pipeline-card__empty">Tidak tersedia di layanan ini.</p>
      ) : (
        <>
          <p className="pipeline-card__primary">
            <strong>{countText(view.primaryValue)}</strong>
            <span>{view.primaryLabel}</span>
          </p>
          {view.chips.length > 0 && (
            <ul className="pipeline-card__chips" aria-label="Rincian status">
              {view.chips.map((chip) => (
                <li key={chip.label} className={`pipeline-chip pipeline-chip--${chip.tone}`}>
                  {chip.label} {countText(chip.value)}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      <div className="pipeline-card__foot">
        <span>{view.healthLabel}</span>
        <span>15 mnt: {countText(view.throughput15m)}</span>
      </div>
      <CardHandles type="source" />
    </div>
  );
}

const HANDLE_POSITIONS: Readonly<Record<PipelineHandleSide, Position>> = {
  left: Position.Left,
  right: Position.Right,
  top: Position.Top,
  bottom: Position.Bottom,
};

/** One handle per side; the layout table picks which side each edge uses (see pipeline-flow-layout). */
function CardHandles({ type }: { type: "source" | "target" }) {
  return (
    <>
      {(Object.keys(HANDLE_POSITIONS) as PipelineHandleSide[]).map((side) => (
        <Handle
          key={side}
          id={`${type}-${side}`}
          type={type}
          position={HANDLE_POSITIONS[side]}
          isConnectable={false}
          className="pipeline-card__handle"
        />
      ))}
    </>
  );
}

function LaneCard({ data }: NodeProps<Node<PipelineLaneNodeData>>) {
  return (
    <div className={`pipeline-lane pipeline-lane--${data.lane.toLowerCase()}`} aria-hidden="true">
      {data.title && <span className="pipeline-lane__title">{data.title}</span>}
    </div>
  );
}

const NODE_TYPES: NodeTypes = {
  [PIPELINE_FLOW_NODE_TYPE]: FlowNodeCard,
  [PIPELINE_LANE_NODE_TYPE]: LaneCard,
};

export function PipelineDrawer({
  view,
  nineRouter,
  generatedAt,
  items,
  itemState,
  onClose,
}: {
  view: PipelineFlowNodeView;
  nineRouter: PipelineFlowNineRouterDto | null;
  generatedAt: string | null;
  items: PipelineFlowItemsDto | null;
  itemState: "loading" | "ready" | "error" | "forbidden";
  onClose: () => void;
}) {
  const nowMs = useNowTick();
  const meta = PIPELINE_NODE_META[view.id];
  const rows = items ? itemRows(items.items) : [];
  const reviewLink = PIPELINE_REVIEW_LINK_NODES.has(view.id);
  return (
    <aside className="pipeline-drawer" role="dialog" aria-modal="false" aria-labelledby="pipeline-drawer-title">
      <header className="pipeline-drawer__head">
        <div>
          <p className="pipeline-drawer__lane">{view.lane} · {PIPELINE_LAYER_NAMES[view.lane]}</p>
          <h2 id="pipeline-drawer-title">{meta.label}</h2>
          <p className="pipeline-drawer__health">{view.healthLabel}</p>
        </div>
        <button type="button" className="button button--quiet button--sm" onClick={onClose}>Tutup</button>
      </header>
      <p className="pipeline-drawer__desc">{meta.description}</p>
      {view.emptyText !== null && <p className="pipeline-drawer__note" role="status">{view.emptyText}</p>}
      {nineRouter && <NineRouterMeters runtime={nineRouter} generatedAt={generatedAt} />}
      <section aria-labelledby="pipeline-drawer-counts">
        <h3 id="pipeline-drawer-counts">Hitungan</h3>
        {view.countRows.length === 0 ? (
          <p className="pipeline-drawer__note">Belum ada hitungan dari layanan ini.</p>
        ) : (
          <dl className="pipeline-counts">
            {view.countRows.map((row) => (
              <div key={row.key}><dt>{row.label}</dt><dd>{countText(row.value)}</dd></div>
            ))}
            <div><dt>Aliran 15 menit</dt><dd>{countText(view.throughput15m)}</dd></div>
          </dl>
        )}
      </section>
      <section aria-labelledby="pipeline-drawer-items">
        <h3 id="pipeline-drawer-items">Rincian terbaru</h3>
        {itemState === "loading" && <p className="pipeline-drawer__note" role="status">Memuat rincian…</p>}
        {itemState === "error" && <p className="pipeline-drawer__note" role="alert">Rincian belum dapat dimuat. Coba lagi beberapa saat.</p>}
        {itemState === "forbidden" && <p className="pipeline-drawer__note" role="alert">Sesi tidak memiliki izin untuk rincian ini.</p>}
        {itemState === "ready" && items?.unavailable_reason && <p className="pipeline-drawer__note">{items.unavailable_reason}</p>}
        {itemState === "ready" && rows.length === 0 && !items?.unavailable_reason && (
          <p className="pipeline-drawer__note">Tidak ada rincian dalam 24 jam.</p>
        )}
        {itemState === "ready" && rows.length > 0 && (
          <ol className="pipeline-items">
            {rows.map((row, index) => (
              <li key={`${row.ref}-${index}`}>
                <div className="pipeline-items__row">
                  <code>{row.ref}</code>
                  <span className="pipeline-items__status">{row.status}</span>
                  {row.failure && <span className="pipeline-items__failure">{row.failure}</span>}
                </div>
                {row.title && <p className="pipeline-items__title">{row.title}</p>}
                <p className="pipeline-items__time">{relativeTimeLabel(row.at, nowMs)}</p>
              </li>
            ))}
          </ol>
        )}
      </section>
      {reviewLink && (
        <p className="pipeline-drawer__link">
          <a className="text-link" href="#admin/tinjau">Buka tinjau bukti</a>
          <span> untuk usulan, keputusan, dan versi yang terbit.</span>
        </p>
      )}
    </aside>
  );
}

export function PipelineHeaderStrip({
  mode,
  generatedAt,
  paused,
  loadState,
  runtimeAvailable,
  onTogglePause,
  onRefresh,
}: {
  mode: "live" | "demo" | null;
  generatedAt: string | null;
  paused: boolean;
  loadState: "loading" | "ready" | "error" | "forbidden";
  runtimeAvailable: boolean;
  onTogglePause: () => void;
  onRefresh: () => void;
}) {
  const badge = mode === "demo" ? "Data contoh" : mode === "live" ? "Langsung" : "Status belum diketahui";
  const badgeClass = mode === "demo" ? "pipeline-badge--demo" : mode === "live" ? "pipeline-badge--live" : "pipeline-badge--unknown";
  const status = loadState === "loading"
    ? "Memuat status…"
    : loadState === "error"
      ? "Status belum dapat dimuat."
      : loadState === "forbidden"
        ? "Sesi tidak memiliki izin."
        : paused
          ? "Pembaruan dijeda."
          : generatedAt
            ? `Diperbarui ${formatInstant(generatedAt)}`
            : "Belum ada pembaruan.";
  return (
    <div className="pipeline-strip" role="region" aria-label="Status tampilan">
      <span className={`pipeline-badge ${badgeClass}`}>{badge}</span>
      <span className="pipeline-strip__status" role="status">{status}</span>
      {!runtimeAvailable && loadState === "ready" && (
        <span className="pipeline-strip__warning">Status runtime tidak tersedia; bagian pemantauan ditandai tidak tersedia.</span>
      )}
      <div className="pipeline-strip__actions">
        <button type="button" className="button button--quiet button--sm" onClick={onTogglePause} aria-pressed={paused}>
          {paused ? "Lanjutkan pembaruan" : "Jeda pembaruan"}
        </button>
        <button type="button" className="button button--quiet button--sm" onClick={onRefresh}>Muat ulang</button>
      </div>
    </div>
  );
}

export function PipelineLegend() {
  return (
    <ul className="pipeline-legend" aria-label="Lapisan">
      {PIPELINE_LAYER_IDS.map((lane) => (
        <li key={lane} className={`pipeline-legend__item pipeline-legend__item--${lane.toLowerCase()}`}>
          <span>{lane}</span> {PIPELINE_LAYER_NAMES[lane]}
        </li>
      ))}
      <li className="pipeline-legend__item pipeline-legend__item--note">Garis bergerak bila tahap tujuan memproses item dalam 15 menit terakhir.</li>
    </ul>
  );
}

/** The whole diagram is fitted into the canvas once and then stays put. */
const FIT_VIEW: FitViewOptions = { padding: 0.04, minZoom: 0.3, maxZoom: 1 };

/** Refits the fixed diagram when the canvas changes size, since users cannot pan or zoom it. */
function FitOnResize({ target }: { target: RefObject<HTMLDivElement | null> }) {
  const { fitView } = useReactFlow();
  const ready = useNodesInitialized();
  useEffect(() => {
    if (!ready) return undefined;
    void fitView(FIT_VIEW);
    const element = target.current;
    if (!element || typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(() => void fitView(FIT_VIEW));
    observer.observe(element);
    return () => observer.disconnect();
  }, [ready, fitView, target]);
  return null;
}

export function PipelineFlow() {
  const [snapshot, setSnapshot] = useState<PipelineFlowSnapshotDto | null>(null);
  const [loadState, setLoadState] = useState<"loading" | "ready" | "error" | "forbidden">("loading");
  const [paused, setPaused] = useState(false);
  const [selectedId, setSelectedId] = useState<PipelineFlowNodeId | null>(null);
  const [items, setItems] = useState<PipelineFlowItemsDto | null>(null);
  const [itemState, setItemState] = useState<"loading" | "ready" | "error" | "forbidden">("loading");
  const disposed = useRef(false);
  const canvasRef = useRef<HTMLDivElement>(null);
  const requestId = useRef(0);

  useEffect(() => {
    disposed.current = false;
    return () => {
      disposed.current = true;
    };
  }, []);

  const loadSnapshot = useCallback(async () => {
    const current = ++requestId.current;
    try {
      const next = await fetchPipelineFlowSnapshot();
      if (disposed.current || current !== requestId.current) return;
      setSnapshot(next);
      setLoadState("ready");
    } catch (error) {
      if (disposed.current) return;
      const forbidden = error instanceof PipelineFlowHttpError && (error.status === 401 || error.status === 403);
      setLoadState(forbidden ? "forbidden" : "error");
    }
  }, []);

  useEffect(() => {
    void loadSnapshot();
  }, [loadSnapshot]);

  useEffect(() => {
    if (paused) return undefined;
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void loadSnapshot();
    }, PIPELINE_POLL_INTERVAL_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") void loadSnapshot();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [paused, loadSnapshot]);

  // Moderation events refresh the view at once. The stream is the existing moderator SSE channel.
  useEffect(() => {
    if (typeof EventSource === "undefined") return undefined;
    let source: EventSource | null = null;
    let debounce: number | undefined;
    const schedule = () => {
      window.clearTimeout(debounce);
      debounce = window.setTimeout(() => {
        if (!paused) void loadSnapshot();
      }, 300);
    };
    try {
      source = new EventSource("/api/v1/moderation/stream", { withCredentials: true });
      source.addEventListener("proposal_created", schedule);
      source.addEventListener("proposal_published", schedule);
    } catch {
      source = null;
    }
    return () => {
      window.clearTimeout(debounce);
      source?.close();
    };
  }, [paused, loadSnapshot]);

  const graph = useMemo(() => (snapshot ? toPipelineFlowGraph(snapshot, PIPELINE_DEFAULT_POSITIONS) : null), [snapshot]);
  const nodes: Node[] = graph?.nodes ?? [];
  const edges: Edge[] = graph?.edges ?? [];

  useEffect(() => {
    if (selectedId === null) return undefined;
    let cancelled = false;
    setItemState("loading");
    fetchPipelineFlowItems(selectedId, 20)
      .then((next) => {
        if (cancelled) return;
        setItems(next);
        setItemState("ready");
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        const forbidden = error instanceof PipelineFlowHttpError && (error.status === 401 || error.status === 403);
        setItemState(forbidden ? "forbidden" : "error");
      });
    return () => {
      cancelled = true;
    };
  }, [selectedId, snapshot?.generated_at]);

  // Escape closes the drawer; focus returns to the page, not to a hidden control.
  useEffect(() => {
    if (selectedId === null) return undefined;
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") setSelectedId(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectedId]);

  const selectedNode = useMemo(
    () => (snapshot && selectedId !== null ? snapshot.nodes.find((candidate) => candidate.id === selectedId) ?? null : null),
    [snapshot, selectedId],
  );

  const onNodeClick = useCallback((_: unknown, node: Node) => {
    if (node.type === PIPELINE_FLOW_NODE_TYPE) setSelectedId(node.id as PipelineFlowNodeId);
  }, []);

  const runtimeAvailable = Boolean(snapshot?.runtime);

  return (
    <div className="pipeline-page">
      <header className="pipeline-page__intro">
        <p className="pipeline-kicker">Moderator · baca saja</p>
        <h2>Alur agen</h2>
        <p className="pipeline-page__lede">
          Hitungan item dari sumber sampai terbit. Angka menunjukkan aliran kerja, bukan bukti bahwa suatu kejadian benar
          atau bahwa suatu wilayah aman.
        </p>
      </header>
      <PipelineHeaderStrip
        mode={snapshot?.dataset_mode ?? null}
        generatedAt={snapshot?.generated_at ?? null}
        paused={paused}
        loadState={loadState}
        runtimeAvailable={runtimeAvailable}
        onTogglePause={() => setPaused((value) => !value)}
        onRefresh={() => void loadSnapshot()}
      />
      <PipelineLegend />
      {loadState === "forbidden" && (
        <section className="state-panel" role="alert">
          <strong>Sesi tidak memiliki izin.</strong>
          <p>Tampilan ini hanya untuk moderator atau administrator yang masuk.</p>
        </section>
      )}
      <div ref={canvasRef} className="pipeline-canvas" aria-label="Diagram alur agen. Pilih tahap untuk melihat rinciannya.">
        <SelectContext.Provider value={setSelectedId}>
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodeClick={onNodeClick}
            nodeTypes={NODE_TYPES}
            fitView
            fitViewOptions={FIT_VIEW}
            nodesDraggable={false}
            nodesConnectable={false}
            elementsSelectable
            edgesFocusable={false}
            panOnDrag={false}
            panOnScroll={false}
            zoomOnScroll={false}
            zoomOnPinch={false}
            zoomOnDoubleClick={false}
            preventScrolling={false}
            autoPanOnNodeFocus={false}
            deleteKeyCode={null}
            selectionKeyCode={null}
            multiSelectionKeyCode={null}
            minZoom={0.3}
            maxZoom={1}
            proOptions={{ hideAttribution: false }}
          >
            <Background gap={24} size={1} />
            <FitOnResize target={canvasRef} />
          </ReactFlow>
        </SelectContext.Provider>
      </div>
      {selectedNode && (
        <PipelineDrawer
          view={nodeView(selectedNode)}
          nineRouter={selectedNode.id === "ninerouter" ? snapshot?.runtime?.ninerouter ?? null : null}
          generatedAt={snapshot?.runtime?.generated_at ?? null}
          items={items}
          itemState={itemState}
          onClose={() => setSelectedId(null)}
        />
      )}
      {loadState === "ready" && snapshot && (
        <p className="pipeline-footnote">
          {snapshot.dataset_mode === "demo"
            ? "Data contoh: fixture sintetis, bukan data langsung."
            : `Jendela hitungan 24 jam. Tahap tanpa data menampilkan "tidak ada data dalam 24 jam".`}
        </p>
      )}
    </div>
  );
}
