import type { Category, Freshness, Lifecycle, PublicGeoJSONGeometry, PublicContext, TimeScope, Validity } from "@waspada/worker/public-contracts";

export type AdminMode = "simulation" | "public_api";
export type AdminLayer = "L1" | "L2" | "L3" | "L4" | "L5";
export type AdminItemState = "queued" | "running" | "held" | "failed" | "done";
export type AdminAvailability = "simulated" | "observed" | "unavailable";

export interface AdminStep {
  layer: AdminLayer;
  state: AdminItemState;
  label: string;
  detail: string;
  at: string | null;
}

export interface AdminBudget {
  toolsUsed: number; toolsLimit: number;
  reasoningUsed: number; reasoningLimit: number;
  tokensUsed: number; tokensLimit: number;
  activeSecondsUsed: number; activeSecondsLimit: number;
}

export interface AdminItem {
  id: string;
  title: string;
  summary: string;
  category: Category;
  layer: AdminLayer;
  state: AdminItemState;
  operationalPriority: "normal" | "attention" | "blocked";
  placeLabel: string;
  geometry: PublicGeoJSONGeometry | null;
  additionalGeometries?: PublicGeoJSONGeometry[];
  geometryBasis: "synthetic_example" | "source_supported" | "none";
  geometryNote: string;
  sourceNames: string[];
  eventVersion: number | null;
  publicEventId: string | null;
  datasetKind: "live" | "historical" | "synthetic";
  observedAt: string | null;
  fetchedAt: string | null;
  publishedAt: string | null;
  evidenceSummary: string;
  stopReason: string | null;
  nextStep: string;
  budget: AdminBudget | null;
  steps: AdminStep[];
  publicStatus?: { lifecycle: Lifecycle; freshness: Freshness; eventTime: TimeScope; validity: Validity };
}

export interface AdminLayerSummary {
  layer: AdminLayer;
  name: string;
  description: string;
  availability: AdminAvailability;
  count: number | null;
  state: "ready" | "attention" | "unavailable";
  note: string;
}

export interface AdminSource {
  id: string;
  name: string;
  health: "unknown" | "healthy" | "degraded" | "unavailable";
  lastSuccessAt: string | null;
  note: string;
}

export interface AdminActivity {
  id: string;
  itemId: string | null;
  layer: AdminLayer;
  at: string;
  state: AdminItemState;
  label: string;
  detail: string;
}

export interface AdminProbe {
  endpoint: "context" | "events" | "geometry";
  status: "succeeded" | "failed" | "unavailable";
  observedAt: string;
  durationMs: number | null;
  httpStatus: number | null;
}

export interface AdminSnapshot {
  mode: AdminMode;
  capturedAt: string;
  context: PublicContext | null;
  datasetMode: "live" | "demo" | null;
  items: AdminItem[];
  layers: AdminLayerSummary[];
  sources: AdminSource[];
  activities: AdminActivity[];
  probes: AdminProbe[];
  limitations: string[];
  hasMoreEvents: boolean;
}

export interface AdminMonitorState {
  status: "idle" | "loading" | "connected" | "partial" | "error" | "paused" | "offline";
  snapshot: AdminSnapshot | null;
  attemptedAt: string | null;
  lastSuccessAt: string | null;
  nextPollAt: string | null;
  consecutiveFailures: number;
  currentAttempt: { at: string; probes: AdminProbe[]; context: PublicContext | null } | null;
}

export interface AdminMapProps {
  items: readonly AdminItem[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  mode: AdminMode;
}
