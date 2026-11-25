import * as React from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { evidenceLabel, formatInstant, freshnessLabel, lifecycleLabel } from "./display.js";
import {
  discrepancyKindLabel,
  proposalEventTimeText,
  triageActionabilityLabel,
  triageConfidenceLabel,
  triageDispositionLabel,
  triageJakartaScopeLabel,
  triageModelStatusLabel,
  triageReasonLabel,
} from "./moderation-labels.js";
import { documentedPresentationFixture as fixture } from "./presentation-fixture.js";
import { MapPanel } from "./GeoMapPanel.js";
import { InteractiveIncidentMap } from "./InteractiveIncidentMap.js";
import { moderatorAccessMessage, SIGN_IN_HREF } from "./account-messages.js";
export { InteractiveIncidentMap } from "./InteractiveIncidentMap.js";
if (typeof document !== "undefined") {
  void import("./moderator-review.css");
}

export interface StoredEvidenceChunk {
  readonly chunk_index: number;
  readonly text: string;
  readonly span_start: number;
  readonly span_end: number;
}

export interface ProposalClaim {
  readonly claim_id: string;
  readonly claim_text: string;
  readonly evidence_label: "under_review";
  readonly support_assessment: "supported";
  readonly quote_text: string;
  readonly evidence_ref_id: string;
  /** MERGE-REVIEW-01: the claim's publisher name and its own article link. */
  readonly outlet?: string | null;
  readonly source_id?: string | null;
  readonly source_url?: string | null;
  /** Legacy field, never written by new code. */
  readonly is_corroborated?: boolean;
}

export interface ProposalDiscrepancy {
  readonly kind: "water_depth" | "severity_assessment" | "casualty_count" | "operational_status" | string;
  readonly description: string;
  readonly source_a?: { readonly source_id: string | null; readonly claim_text: string };
  readonly source_b?: { readonly source_id: string | null; readonly outlet?: string | null; readonly claim_text: string };
}

export interface EventProposalDto {
  readonly schema_version: "2.0";
  readonly proposal_id: string;
  readonly title: string;
  readonly incident_type: string;
  readonly primary_category?: string;
  readonly compatibility_category?: string;
  /** FIX-MOD-UI: the interpreter's own category. The triage candidate is primary_category. */
  readonly interpretation_category?: string | null;
  readonly severity: "low" | "medium" | "high" | "critical" | "unknown";
  readonly event_time: { readonly precision: "exact" | "date" | "range" | "unknown"; readonly value: string | null };
  readonly location_label: string | null;
  readonly coordinates: readonly [longitude: number, latitude: number] | null;
  readonly claims: readonly ProposalClaim[];
  readonly impacts?: readonly string[];
  readonly proposed_at: string;
  readonly is_multi_source?: boolean;
  readonly source_count?: number;
  readonly has_discrepancy?: boolean;
  /** MERGE-REVIEW-01: AI-written Bahasa Indonesia summary of the conflict. */
  readonly discrepancy_summary?: string | null;
  readonly discrepancies?: readonly ProposalDiscrepancy[];
  /** Set on published public versions: who published and how many distinct publishers. */
  readonly publication_mode?: "agent_auto" | "moderator_reviewed" | null;
  readonly caveats?: readonly string[];
}
/** WJ-INT-02B: the moderator's choice when a proposal's triage and interpreter categories differ. */
export type CategoryResolution = "accept_triage" | "accept_interpretation";

export interface CategoryResolutionFields {
  readonly category_resolution?: CategoryResolution;
  readonly resolved_category?: string;
}

export interface ModeratorDecisionCommand extends CategoryResolutionFields {
  readonly proposal_id: string;
  readonly action: "publish" | "reject" | "investigate";
  readonly evidence_label: "attributed_report" | "crowdsourced_observation" | "independent_corroboration";
  readonly reason?: string;
}

export interface ModerationFeedback {
  readonly type: "success" | "error" | "info";
  readonly message: string;
}

export interface ModeratorReviewProps {
  /** Mode: "queue" for active moderation queue, "fixture" for static demo presentation */
  mode?: "queue" | "fixture";
  /** Initial or controlled proposal queue */
  proposals?: readonly EventProposalDto[];
  /** Chunks mapped by proposal ID */
  initialChunks?: Record<string, readonly StoredEvidenceChunk[]>;
  /** Initial selected proposal ID */
  initialSelectedId?: string;
  /** CSRF token for moderation POST actions */
  csrfToken?: string;
  /** Custom fetcher for HTTP calls */
  fetcher?: typeof fetch;
  /** Callback on moderator decision */
  onDecision?: (command: ModeratorDecisionCommand) => void | Promise<void>;
  /** Initial controlled feedback banner */
  initialFeedback?: ModerationFeedback | null;
  /** Initial approval modal open state (useful for testing) */
  initialModalOpen?: boolean;
  /** Initial triage/interpreter choice for a mismatched proposal (useful for testing) */
  initialCategoryChoice?: CategoryResolution | null;
  /** Base URL for moderation API (default: "/api/v1/moderation") */
  apiBaseUrl?: string;
}

export function incidentTypeLabel(type: string): string {
  switch (type) {
    case "flood": return "Banjir";
    case "fire": return "Kebakaran";
    case "accident": return "Kecelakaan";
    case "tree_fall": return "Pohon Tumbang";
    case "crime": return "Kriminalitas";
    case "weather": return "Cuaca Ekstrem";
    default:
      return type;
  }
}

const CANONICAL_CATEGORY_LABELS: Record<string, string> = {
  crime_personal_security: "Keamanan",
  demonstrations_public_gatherings: "Demonstrasi",
  crowds_major_events: "Keramaian",
  violence_immediate_threats: "Kekerasan",
  disasters_weather: "Bencana",
  fires_infrastructure_hazards: "Kebakaran",
  transport_road_incidents: "Transportasi",
  utilities_essential_services: "Utilitas",
  health_environmental_advisories: "Kesehatan",
  group_specific_critical_notices: "Notices",
};

export function proposalCategoryLabel(proposal: { primary_category?: string; incident_type: string }): string {
  if (proposal.primary_category && CANONICAL_CATEGORY_LABELS[proposal.primary_category]) {
    return CANONICAL_CATEGORY_LABELS[proposal.primary_category]!;
  }
  return incidentTypeLabel(proposal.incident_type);
}

/** The worker's signal for a triage/interpreter mismatch (moderation-api.ts). */
export function hasCategoryMismatch(proposal: Pick<EventProposalDto, "caveats">): boolean {
  return Array.isArray(proposal.caveats) && proposal.caveats.includes("category_mismatch_review");
}

function officialCategoryOrNull(value: unknown): string | null {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(CANONICAL_CATEGORY_LABELS, value)
    ? value
    : null;
}

/**
 * FIX-MOD-UI: the candidate a choice publishes. accept_triage is the triage category (primary_category);
 * accept_interpretation is the interpreter's category (interpretation_category). compatibility_category is a
 * legacy alias and is never a candidate.
 */
export function categoryCandidateFor(
  proposal: Pick<EventProposalDto, "primary_category" | "interpretation_category">,
  choice: CategoryResolution,
): string | null {
  return choice === "accept_triage"
    ? officialCategoryOrNull(proposal.primary_category)
    : officialCategoryOrNull(proposal.interpretation_category);
}

export interface CategoryChoiceOption {
  readonly choice: CategoryResolution;
  /** The recorded candidate, or null when the proposal records none for this choice. */
  readonly category: string | null;
  readonly label: string;
  readonly hint: string;
}

export function categoryChoiceOptions(
  proposal: Pick<EventProposalDto, "primary_category" | "interpretation_category">,
): readonly CategoryChoiceOption[] {
  return (["accept_triage", "accept_interpretation"] as const).map((choice) => {
    const category = categoryCandidateFor(proposal, choice);
    return {
      choice,
      category,
      label: category !== null ? CANONICAL_CATEGORY_LABELS[category]! : "Tidak tercatat",
      hint: choice === "accept_triage" ? "dari penyaring awal" : "dari interpretasi agen",
    };
  });
}

export type CategoryPublishPlan =
  | { readonly ok: true; readonly fields: CategoryResolutionFields }
  | { readonly ok: false; readonly hint: string };

/**
 * FIX-MOD-UI: what a publish sends about the category. Without a recorded mismatch the plan sends nothing, so the
 * request is unchanged. With a mismatch, the moderator's choice is required, and resolved_category is that choice's
 * recorded candidate, which the worker checks against the proposal.
 */
export function planCategoryPublish(
  proposal: Pick<EventProposalDto, "caveats" | "primary_category" | "interpretation_category">,
  choice: CategoryResolution | null,
): CategoryPublishPlan {
  if (!hasCategoryMismatch(proposal)) return { ok: true, fields: {} };
  if (choice === null) {
    return { ok: false, hint: "Pilih salah satu kategori di atas sebelum menerbitkan." };
  }
  const resolved = categoryCandidateFor(proposal, choice);
  if (resolved === null) {
    return { ok: false, hint: "Kategori ini tidak tercatat pada proposal, jadi pilih kategori yang lain." };
  }
  return { ok: true, fields: { category_resolution: choice, resolved_category: resolved } };
}

const CATEGORY_REFUSAL_MESSAGES: Readonly<Record<string, string>> = {
  CATEGORY_MISMATCH_UNRESOLVED:
    "Penyaring awal dan agen interpretasi menilai kategori berbeda. Pilih kategori yang dipakai, lalu terbitkan lagi.",
  CATEGORY_NOT_CANDIDATE:
    "Kategori yang dikirim tidak sesuai dengan kategori yang tercatat pada proposal. Muat ulang antrean, lalu coba lagi.",
  CATEGORY_CANDIDATES_UNRECORDED:
    "Proposal ini tidak mencatat kategori untuk pilihan tersebut. Pilih kategori yang lain.",
  INVALID_CATEGORY_RESOLUTION: "Pilihan kategori tidak dikenali sistem. Muat ulang halaman, lalu coba lagi.",
  INVALID_CATEGORY: "Kategori proposal ini tidak dikenali sistem, sehingga belum dapat diterbitkan.",
};

/** Readable Indonesian text for a category refusal from the worker, or null for any other code. */
export function categoryRefusalMessage(code: string | null | undefined): string | null {
  if (!code) return null;
  return CATEGORY_REFUSAL_MESSAGES[code.toUpperCase()] ?? null;
}

export function severityLabel(sev: string): string {
  switch (sev) {
    case "critical": return "Kritis";
    case "high": return "Tinggi";
    case "medium": return "Sedang";
    case "low": return "Rendah";
    case "unknown": return "unknown";
    default: return sev;
  }
}

export function isProposalMultiSource(proposal: EventProposalDto): boolean {
  if (proposal.is_multi_source === true) return true;
  if (typeof proposal.source_count === "number" && proposal.source_count > 1) return true;
  return false;
}

export function isProposalCrowdsourced(proposal: EventProposalDto): boolean {
  const text = [
    proposal.title,
    proposal.location_label,
    ...proposal.claims.map((c) => `${c.claim_text} ${c.quote_text} ${c.evidence_ref_id}`),
  ]
    .join(" ")
    .toLowerCase();
  return text.includes("petabencana") || text.includes("warga") || text.includes("laporan publik");
}

/**
 * ST-F-03: the origin a claim shows on the review screen, named by its outlet, else its registry source id. A claim
 * with neither shows "tidak tercatat". The name is never invented.
 */
export function claimOriginName(claim: Pick<ProposalClaim, "outlet" | "source_id">): string {
  const outlet = claim.outlet?.trim();
  if (outlet) return outlet;
  const sourceId = claim.source_id?.trim();
  if (sourceId) return sourceId;
  return "tidak tercatat";
}

/**
 * MERGE-REVIEW-01: never pre-selects independent_corroboration. Only a moderator's explicit
 * choice may set it, and this build does not offer that choice.
 */
export function autoDetectEvidenceLabel(
  proposal: EventProposalDto
): "attributed_report" | "crowdsourced_observation" {
  if (isProposalCrowdsourced(proposal)) {
    return "crowdsourced_observation";
  }
  return "attributed_report";
}

export function renderHighlightedText(text: string, quotes: readonly string[]): React.ReactNode[] {
  if (!text) return [""];
  const validQuotes = quotes
    .map((q) => q.trim())
    .filter((q) => q.length > 0);
  if (validQuotes.length === 0) return [text];

  interface Match {
    start: number;
    end: number;
  }
  const matches: Match[] = [];

  for (const quote of validQuotes) {
    let index = 0;
    while ((index = text.indexOf(quote, index)) !== -1) {
      matches.push({ start: index, end: index + quote.length });
      index += quote.length;
    }
  }

  // Fallback to case-insensitive matching if no exact matches found
  if (matches.length === 0) {
    const lowerText = text.toLowerCase();
    for (const quote of validQuotes) {
      const lowerQuote = quote.toLowerCase();
      let index = 0;
      while ((index = lowerText.indexOf(lowerQuote, index)) !== -1) {
        matches.push({ start: index, end: index + quote.length });
        index += quote.length;
      }
    }
  }

  if (matches.length === 0) {
    return [text];
  }

  matches.sort((a, b) => a.start - b.start);

  const merged: Match[] = [];
  let curr = matches[0]!;
  for (let i = 1; i < matches.length; i++) {
    const next = matches[i]!;
    if (next.start < curr.end) {
      curr = { start: curr.start, end: Math.max(curr.end, next.end) };
    } else {
      merged.push(curr);
      curr = next;
    }
  }
  merged.push(curr);

  const parts: React.ReactNode[] = [];
  let lastIndex = 0;
  for (let i = 0; i < merged.length; i++) {
    const m = merged[i]!;
    if (m.start > lastIndex) {
      parts.push(text.slice(lastIndex, m.start));
    }
    parts.push(
      <mark key={`mark-${i}-${m.start}`} className="evidence-quote-highlight">
        {text.slice(m.start, m.end)}
      </mark>
    );
    lastIndex = m.end;
  }
  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex));
  }
  return parts;
}

export function advanceProposalQueue(
  currentQueue: readonly EventProposalDto[],
  completedId: string
): { remaining: EventProposalDto[]; nextSelectedId: string | null } {
  const currentIndex = currentQueue.findIndex((p) => p.proposal_id === completedId);
  const remaining = currentQueue.filter((p) => p.proposal_id !== completedId);
  if (remaining.length === 0) {
    return { remaining: [], nextSelectedId: null };
  }
  const nextIndex =
    currentIndex >= 0 && currentIndex < remaining.length
      ? currentIndex
      : Math.max(0, remaining.length - 1);
  return {
    remaining,
    nextSelectedId: remaining[nextIndex]?.proposal_id ?? null,
  };
}

/** A failed moderation read. `status` lets callers show sign-in or role copy for 401 and 403. */
export class ModerationHttpError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "ModerationHttpError";
  }
}

/** FIX-MOD-UI: a moderation action the server refused. `code` is the worker's code, in either letter case. */
export class ModerationActionError extends Error {
  constructor(message: string, readonly status: number, readonly code: string | null) {
    super(message);
    this.name = "ModerationActionError";
  }
}

/**
 * The catalog reads the moderation endpoint, which answers 401/403 to visitors without a moderator
 * session. Show a plain access message instead of a raw HTTP error. (Moved from LaporanPublik in UI-V2-B.)
 */
export function catalogLoadErrorMessage(err: unknown): string {
  if (err instanceof ModerationHttpError && (err.status === 401 || err.status === 403)) {
    return "Katalog ini hanya tersedia untuk moderator yang sudah masuk.";
  }
  return `Gagal memuat katalog laporan terpercaya: ${err instanceof Error ? err.message : String(err)}`;
}

export async function fetchModerationProposals(
  options: { apiBaseUrl?: string; fetcher?: typeof fetch; signal?: AbortSignal } = {}
): Promise<EventProposalDto[]> {
  const base = options.apiBaseUrl ?? "/api/v1/moderation";
  const fetchFn =
    options.fetcher ??
    (typeof window !== "undefined" && window.fetch ? window.fetch.bind(window) : globalThis.fetch);
  const response = await fetchFn(`${base}/proposals`, {
    headers: { accept: "application/json" },
    credentials: "same-origin",
    signal: options.signal,
  });
  if (!response.ok) {
    throw new ModerationHttpError(`Failed to fetch moderation proposals: HTTP ${response.status}`, response.status);
  }
  const data = (await response.json()) as { proposals?: EventProposalDto[] };
  return data.proposals || [];
}

export async function fetchProposalDetail(
  id: string,
  options: { apiBaseUrl?: string; fetcher?: typeof fetch; signal?: AbortSignal } = {}
): Promise<{ proposal: EventProposalDto; chunks: StoredEvidenceChunk[] }> {
  const base = options.apiBaseUrl ?? "/api/v1/moderation";
  const fetchFn =
    options.fetcher ??
    (typeof window !== "undefined" && window.fetch ? window.fetch.bind(window) : globalThis.fetch);
  const response = await fetchFn(`${base}/proposals/${encodeURIComponent(id)}`, {
    headers: { accept: "application/json" },
    credentials: "same-origin",
    signal: options.signal,
  });
  if (!response.ok) {
    throw new ModerationHttpError(`Failed to fetch proposal details: HTTP ${response.status}`, response.status);
  }
  const data = (await response.json()) as {
    proposal?: EventProposalDto;
    chunks?: StoredEvidenceChunk[];
  } & EventProposalDto;
  const proposal = data.proposal ?? data;
  const chunks = data.chunks ?? [];
  return { proposal, chunks };
}

export async function publishModerationDecision(
  proposalId: string,
  command: ModeratorDecisionCommand,
  options: { apiBaseUrl?: string; fetcher?: typeof fetch; csrfToken?: string; signal?: AbortSignal } = {}
): Promise<{ ok: boolean; status: string; [key: string]: unknown }> {
  const base = options.apiBaseUrl ?? "/api/v1/moderation";
  const fetchFn =
    options.fetcher ??
    (typeof window !== "undefined" && window.fetch ? window.fetch.bind(window) : globalThis.fetch);
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json",
  };
  if (options.csrfToken) {
    headers["X-CSRF-Token"] = options.csrfToken;
  }
  const response = await fetchFn(`${base}/proposals/${encodeURIComponent(proposalId)}/publish`, {
    method: "POST",
    headers,
    credentials: "same-origin",
    body: JSON.stringify(command),
    signal: options.signal,
  });
  if (!response.ok) {
    let errorDetail = `HTTP ${response.status}`;
    let code: string | null = null;
    try {
      const errorJson = (await response.json()) as { code?: unknown; error?: string; message?: string };
      if (errorJson.error || errorJson.message) {
        errorDetail += `: ${errorJson.error || errorJson.message}`;
      }
      // Route errors carry `code`; publish denials carry the code in `code` and `error`.
      if (typeof errorJson.code === "string") code = errorJson.code;
      else if (typeof errorJson.error === "string") code = errorJson.error;
    } catch {
      // ignore
    }
    throw new ModerationActionError(`Moderation action failed: ${errorDetail}`, response.status, code);
  }
  return (await response.json()) as { ok: boolean; status: string };
}

export interface UncertainTriageItem {
  readonly source_id: string;
  readonly item_identity_hash: string;
  readonly disposition: string;
  readonly jakarta_scope: string;
  readonly actionability: string;
  readonly primary_category: string | null;
  readonly incident_type: string | null;
  readonly confidence: string;
  readonly reason_codes: readonly string[];
  readonly model_status: string;
  readonly policy_version: string;
  readonly evaluated_at: string;
  readonly reviewed_at: string | null;
  readonly reviewed_by: string | null;
}

export async function fetchUncertainTriage(
  options: { apiBaseUrl?: string; fetcher?: typeof fetch; signal?: AbortSignal } = {}
): Promise<UncertainTriageItem[]> {
  const base = options.apiBaseUrl ?? "/api/v1/moderation";
  const fetchFn =
    options.fetcher ??
    (typeof window !== "undefined" && window.fetch ? window.fetch.bind(window) : globalThis.fetch);
  const response = await fetchFn(`${base}/triage`, {
    headers: { accept: "application/json" },
    credentials: "same-origin",
    signal: options.signal,
  });
  if (!response.ok) {
    throw new ModerationHttpError(`Failed to fetch uncertain triage: HTTP ${response.status}`, response.status);
  }
  const data = (await response.json()) as { items?: UncertainTriageItem[] };
  return data.items || [];
}

export async function markTriageItemReviewed(
  itemIdentityHash: string,
  options: { apiBaseUrl?: string; fetcher?: typeof fetch; csrfToken?: string; signal?: AbortSignal } = {}
): Promise<{ ok: boolean; reviewed: boolean }> {
  const base = options.apiBaseUrl ?? "/api/v1/moderation";
  const fetchFn =
    options.fetcher ??
    (typeof window !== "undefined" && window.fetch ? window.fetch.bind(window) : globalThis.fetch);
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json",
  };
  if (options.csrfToken) {
    headers["X-CSRF-Token"] = options.csrfToken;
  }
  const response = await fetchFn(`${base}/triage/review`, {
    method: "POST",
    headers,
    credentials: "same-origin",
    body: JSON.stringify({ item_identity_hash: itemIdentityHash }),
    signal: options.signal,
  });
  if (!response.ok) {
    throw new Error(`Triage review failed: HTTP ${response.status}`);
  }
  return (await response.json()) as { ok: boolean; reviewed: boolean };
}

export function ModeratorReviewQueue({
  proposals: controlledProposals,
  initialChunks = {},
  initialSelectedId,
  csrfToken: propCsrfToken,
  fetcher,
  onDecision,
  initialFeedback = null,
  initialModalOpen = false,
  initialCategoryChoice = null,
  apiBaseUrl = "/api/v1/moderation",
}: ModeratorReviewProps) {
  const [queue, setQueue] = useState<EventProposalDto[]>(() =>
    controlledProposals ? [...controlledProposals] : []
  );
  const [selectedId, setSelectedId] = useState<string | null>(() =>
    initialSelectedId ?? controlledProposals?.[0]?.proposal_id ?? null
  );
  const [chunksMap, setChunksMap] = useState<Record<string, readonly StoredEvidenceChunk[]>>(initialChunks);
  const [loading, setLoading] = useState<boolean>(!controlledProposals);
  const [modalOpen, setModalOpen] = useState<boolean>(initialModalOpen);
  // MERGE-REVIEW-01: the moderator chooses only attributed or crowdsourced labels. Corroboration is never preselected.
  const [evidenceLabelChoice, setEvidenceLabelChoice] = useState<
    "attributed_report" | "crowdsourced_observation"
  >(() => {
    const first = controlledProposals?.[0];
    return first ? autoDetectEvidenceLabel(first) : "attributed_report";
  });
  const [decisionReason, setDecisionReason] = useState<string>("");
  // FIX-MOD-UI: the triage/interpreter choice. Stays unset until the moderator picks one for a mismatched proposal.
  const [categoryChoice, setCategoryChoice] = useState<CategoryResolution | null>(initialCategoryChoice);
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [feedback, setFeedback] = useState<ModerationFeedback | null>(initialFeedback);
  const [sessionCsrf, setSessionCsrf] = useState<string>("");
  const [queueCategoryFilter, setQueueCategoryFilter] = useState<string>("all");
  const [activeClaimId, setActiveClaimId] = useState<string | null>(null);
  const [realtimeConnected, setRealtimeConnected] = useState<boolean>(false);
  const [reviewView, setReviewView] = useState<"proposals" | "triage">("proposals");
  const [triageItems, setTriageItems] = useState<UncertainTriageItem[]>([]);
  const [triageLoading, setTriageLoading] = useState<boolean>(false);
  const [triageFeedback, setTriageFeedback] = useState<string | null>(null);
  // Set when the server answers 401 (no session) or 403 (no active moderator role) for the queue.
  const [accessStatus, setAccessStatus] = useState<number | null>(null);

  const effectiveCsrfToken = propCsrfToken || sessionCsrf;

  const loadTriage = async () => {
    setTriageLoading(true);
    setTriageFeedback(null);
    try {
      const items = await fetchUncertainTriage({ apiBaseUrl, fetcher });
      setTriageItems(items);
    } catch (err) {
      const status = err instanceof ModerationHttpError ? err.status : null;
      setTriageFeedback(moderatorAccessMessage(status) ?? "Gagal memuat antrean tertahan.");
    } finally {
      setTriageLoading(false);
    }
  };

  useEffect(() => {
    if (controlledProposals) {
      setQueue([...controlledProposals]);
      if (!selectedId && controlledProposals.length > 0) {
        setSelectedId(controlledProposals[0]!.proposal_id);
      }
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    fetchModerationProposals({ apiBaseUrl, fetcher })
      .then((items) => {
        if (cancelled) return;
        setQueue(items);
        if (items.length > 0) {
          setSelectedId(items[0]!.proposal_id);
        }
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setLoading(false);
        const status = err instanceof ModerationHttpError ? err.status : null;
        if (status === 401 || status === 403) {
          setAccessStatus(status);
          return;
        }
        setFeedback({
          type: "error",
          message: `Gagal memuat antrean proposal: ${err instanceof Error ? err.message : String(err)}`,
        });
      });
    return () => {
      cancelled = true;
    };
  }, [controlledProposals, apiBaseUrl, fetcher]);

  useEffect(() => {
    if (reviewView === "triage" && !controlledProposals) {
      void loadTriage();
    }
  }, [reviewView]);
  // Real-time EventSource listener for streaming ingestion & auto-updates
  useEffect(() => {
    if (controlledProposals || typeof window === "undefined" || typeof EventSource === "undefined") {
      return;
    }
    const sseUrl = `${apiBaseUrl.replace(/\/+$/, "")}/stream`;
    let eventSource: EventSource | null = null;
    try {
      eventSource = new EventSource(sseUrl, { withCredentials: true });
      eventSource.onopen = () => setRealtimeConnected(true);
      eventSource.onerror = () => setRealtimeConnected(false);

      eventSource.addEventListener("proposal_created", (e: MessageEvent) => {
        try {
          const payload = JSON.parse(e.data);
          const newProp: EventProposalDto = payload.proposal ?? payload;
          if (newProp && newProp.proposal_id) {
            setQueue((prev) => {
              if (prev.some((p) => p.proposal_id === newProp.proposal_id)) return prev;
              return [newProp, ...prev];
            });
            if (payload.chunks && Array.isArray(payload.chunks)) {
              setChunksMap((prev) => ({ ...prev, [newProp.proposal_id]: payload.chunks }));
            }
            setSelectedId((prev) => prev ?? newProp.proposal_id);
          }
        } catch {}
      });

      eventSource.addEventListener("proposal_published", (e: MessageEvent) => {
        try {
          const payload = JSON.parse(e.data);
          const id = payload.proposal_id ?? payload.proposalId;
          if (id) {
            setQueue((prev) => prev.filter((p) => p.proposal_id !== id));
            setSelectedId((prev) => (prev === id ? null : prev));
          }
        } catch {}
      });
    } catch {}

    return () => {
      if (eventSource) {
        eventSource.close();
        setRealtimeConnected(false);
      }
    };
  }, [controlledProposals, apiBaseUrl]);

  useEffect(() => {
    if (!propCsrfToken && typeof window !== "undefined") {
      // account-v1 returns the envelope at the top level; csrf_token is set only for a web session.
      fetch("/api/v1/auth/session", { credentials: "same-origin" })
        .then((res) => (res.ok ? res.json() : null))
        .then((data: unknown) => {
          if (data && typeof data === "object" && "csrf_token" in data) {
            const token = (data as { csrf_token: unknown }).csrf_token;
            if (typeof token === "string") {
              setSessionCsrf(token);
            }
          }
        })
        .catch(() => {});
    }
  }, [propCsrfToken]);

  useEffect(() => {
    if (!selectedId || chunksMap[selectedId]) return;
    let cancelled = false;
    fetchProposalDetail(selectedId, { apiBaseUrl, fetcher })
      .then((detail) => {
        if (cancelled) return;
        if (detail.chunks && detail.chunks.length > 0) {
          setChunksMap((prev) => ({ ...prev, [selectedId]: detail.chunks }));
        }
      })
      .catch(() => {
        // Fallback: renders claims quotes
      });
    return () => {
      cancelled = true;
    };
  }, [selectedId, chunksMap, apiBaseUrl, fetcher]);

  const selectedProposal = useMemo(() => {
    return queue.find((p) => p.proposal_id === selectedId) ?? null;
  }, [queue, selectedId]);

  // FIX-MOD-UI: what the selected proposal's publish must carry about its category (null when nothing is selected).
  const categoryPlan = useMemo(() => {
    return selectedProposal ? planCategoryPublish(selectedProposal, categoryChoice) : null;
  }, [selectedProposal, categoryChoice]);

  // Sync auto-detected evidence label when selected proposal changes
  useEffect(() => {
    if (selectedProposal) {
      setEvidenceLabelChoice(autoDetectEvidenceLabel(selectedProposal));
      setActiveClaimId(null);
      setCategoryChoice(null);
    }
  }, [selectedProposal?.proposal_id]);

  const activeClaim = useMemo(() => {
    if (!selectedProposal || !activeClaimId) return null;
    return selectedProposal.claims.find((c) => c.claim_id === activeClaimId) ?? null;
  }, [selectedProposal, activeClaimId]);

  const currentQuotes = useMemo(() => {
    if (!selectedProposal) return [];
    return selectedProposal.claims.map((c) => c.quote_text).filter(Boolean);
  }, [selectedProposal]);

  const currentChunks = selectedProposal ? chunksMap[selectedProposal.proposal_id] : undefined;

  // Filter chunks to only those that are grounded in and relevant to the proposal's claims
  const relevantChunks = useMemo(() => {
    if (!currentChunks || currentChunks.length === 0) return [];
    if (!currentQuotes || currentQuotes.length === 0) return currentChunks;
    return currentChunks.filter((chunk) => {
      const chunkLower = chunk.text.toLowerCase();
      return currentQuotes.some((q) => {
        const qLower = q.toLowerCase();
        return (
          chunkLower.includes(qLower) ||
          qLower.includes(chunkLower) ||
          qLower.split(/\s+/).filter((w) => w.length >= 4).some((w) => chunkLower.includes(w))
        );
      });
    });
  }, [currentChunks, currentQuotes]);
  // Filter queue by category / multi-source. Canonical primary_category wins;
  // legacy incident_type/compatibility_category values act as compatibility aliases.
  const categoryOf = (p: EventProposalDto): string =>
    p.primary_category ?? p.compatibility_category ?? p.incident_type;
  const otherQueueCount = useMemo(() => {
    return queue.filter((p) => {
      const c = categoryOf(p);
      return c !== "flood" && c !== "fire" && c !== "disasters_weather" && c !== "fires_infrastructure_hazards";
    }).length;
  }, [queue]);

  const filteredQueue = useMemo(() => {
    if (queueCategoryFilter === "all") return queue;
    if (queueCategoryFilter === "discrepancy") {
      return queue.filter((p) => p.has_discrepancy === true);
    }
    if (queueCategoryFilter === "other") {
      return queue.filter((p) => {
        const c = categoryOf(p);
        return c !== "flood" && c !== "fire" && c !== "disasters_weather" && c !== "fires_infrastructure_hazards";
      });
    }
    return queue.filter((p) => {
      const c = categoryOf(p);
      if (c === queueCategoryFilter) return true;
      // Legacy aliases: flood/fire tabs also match canonical equivalents.
      if (queueCategoryFilter === "flood" && c === "disasters_weather") return true;
      if (queueCategoryFilter === "fire" && c === "fires_infrastructure_hazards") return true;
      if (queueCategoryFilter === "disasters_weather" && (c === "flood" || c === "weather")) return true;
      if (queueCategoryFilter === "fires_infrastructure_hazards" && (c === "fire" || c === "tree_fall")) return true;
      return false;
    });
  }, [queue, queueCategoryFilter]);

  // MERGE-REVIEW-01: the queue lists proposals a moderator must decide. Discrepancies come first.
  const discrepancyQueueCount = useMemo(() => {
    return queue.filter((p) => p.has_discrepancy === true).length;
  }, [queue]);

  const handleAction = useCallback(
    async (
      action: "publish" | "reject" | "investigate",
      evidence_label: "attributed_report" | "crowdsourced_observation" = "attributed_report",
      reason?: string
    ) => {
      if (!selectedProposal || submitting) return;
      // FIX-MOD-UI: a publish of a mismatched proposal waits for the moderator's choice. Nothing is sent before it.
      const categoryFields = action === "publish" ? planCategoryPublish(selectedProposal, categoryChoice) : null;
      if (categoryFields !== null && !categoryFields.ok) {
        setFeedback({ type: "error", message: categoryFields.hint });
        return;
      }
      setSubmitting(true);
      const command: ModeratorDecisionCommand = {
        proposal_id: selectedProposal.proposal_id,
        action,
        evidence_label,
        ...(reason?.trim() ? { reason: reason.trim() } : {}),
        // Only a mismatch adds the two fields. Without one the request is unchanged.
        ...(categoryFields !== null && categoryFields.ok ? categoryFields.fields : {}),
      };

      try {
        if (onDecision) {
          await onDecision(command);
        } else {
          await publishModerationDecision(selectedProposal.proposal_id, command, {
            apiBaseUrl,
            fetcher,
            csrfToken: effectiveCsrfToken,
          });
        }

        const { remaining, nextSelectedId } = advanceProposalQueue(queue, selectedProposal.proposal_id);
        setQueue(remaining);
        setSelectedId(nextSelectedId);
        setModalOpen(false);
        setDecisionReason("");

        const titleSnippet = selectedProposal.title;
        if (action === "publish") {
          const labelText = evidenceLabel(evidence_label);
          setFeedback({
            type: "success",
            message: `Proposal "${titleSnippet}" berhasil disetujui dan diterbitkan sebagai ${labelText}.`,
          });
        } else if (action === "reject") {
          setFeedback({
            type: "info",
            message: `Proposal "${titleSnippet}" telah ditolak.`,
          });
        } else {
          setFeedback({
            type: "info",
            message: `Proposal "${titleSnippet}" ditandai untuk investigasi / minta bukti.`,
          });
        }
      } catch (err) {
        // FIX-MOD-UI: a category refusal from the worker shows readable Indonesian text, never the raw code.
        const refusal = err instanceof ModerationActionError ? categoryRefusalMessage(err.code) : null;
        setFeedback({
          type: "error",
          message: refusal ?? `Gagal memproses proposal: ${err instanceof Error ? err.message : String(err)}`,
        });
      } finally {
        setSubmitting(false);
      }
    },
    [selectedProposal, submitting, onDecision, apiBaseUrl, fetcher, effectiveCsrfToken, queue, categoryChoice]
  );

  return (
    <div className="moderator-page moderator-page--queue">

      <section className="review-heading" aria-labelledby="review-title">
        <div>
          <p className="section-kicker">Antrean Kerja Moderator L4</p>
          <h2 id="review-title">Tinjau Bukti & Moderasi Insiden</h2>
          <p>Verifikasi grounding bukti sumber terhadap klaim sebelum penerbitan ke publik.</p>
        </div>
        <div className="review-heading-status">
          {realtimeConnected && (
            <span className="realtime-indicator" title="Terhubung langsung ke stream pembaruan server">
              <span className="realtime-indicator__dot" aria-hidden="true" />
              <span>Siaran langsung aktif</span>
            </span>
          )}
          <span className="fixture-chip">Moderasi langsung</span>
        </div>
      </section>

      <div className="queue-filter-bar" role="tablist" aria-label="Tampilan moderasi">
        <button
          type="button"
          role="tab"
          aria-selected={reviewView === "proposals"}
          className={`queue-filter-btn ${reviewView === "proposals" ? "queue-filter-btn--active" : ""}`}
          onClick={() => setReviewView("proposals")}
        >
          Proposal ({queue.length})
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={reviewView === "triage"}
          className={`queue-filter-btn ${reviewView === "triage" ? "queue-filter-btn--active" : ""}`}
          onClick={() => setReviewView("triage")}
        >
          Tinjauan Tertahan
        </button>
      </div>

      {feedback && (
        <div
          className={`feedback-banner feedback-banner--${feedback.type}`}
          role={feedback.type === "error" ? "alert" : "status"}
        >
          <span>{feedback.message}</span>
          <button
            type="button"
            className="feedback-dismiss"
            onClick={() => setFeedback(null)}
            aria-label="Tutup pemberitahuan"
          >
            ×
          </button>
        </div>
      )}

      {accessStatus !== null ? (
        <section className="state-panel" role="status" aria-labelledby="review-access-title">
          <h2 id="review-access-title">Tinjauan hanya untuk moderator</h2>
          <p>{moderatorAccessMessage(accessStatus)}</p>
          <a className="text-link" href={`${SIGN_IN_HREF}?return_to=%23tinjau-bukti`}>Masuk dengan nama pengguna</a>
        </section>
      ) : reviewView === "triage" ? (
        <section className="state-panel" aria-label="Antrean tertahan untuk inspeksi">
          <p className="section-kicker">Inspeksi metadata — tanpa teks artikel</p>
          <h3>Tinjauan Tertahan</h3>
          <p>Keputusan drop/uncertain hanya metadata. Peninjauan ulang terjadi lewat siklus polling resmi berikutnya.</p>
          {triageFeedback && <p role="alert">{triageFeedback}</p>}
          {triageLoading ? (
            <p role="status">Memuat antrean tertahan…</p>
          ) : triageItems.length === 0 ? (
            <p role="status">Tidak ada keputusan tertahan.</p>
          ) : (
            <ul className="proposal-queue-list">
              {triageItems.map((item) => (
                <li key={item.item_identity_hash}>
                  <div>
                    <strong>{item.source_id}</strong>
                    <span title={`${item.disposition} · ${item.jakarta_scope} · ${item.actionability}`}> · {item.item_identity_hash.slice(0, 12)}… · {triageDispositionLabel(item.disposition)} · {triageJakartaScopeLabel(item.jakarta_scope)} · {triageActionabilityLabel(item.actionability)}</span>
                  </div>
                  <div>
                    <span>Kategori: {item.primary_category ?? item.incident_type ?? "—"}</span>
                    <span title={`confidence: ${item.confidence}; model_status: ${item.model_status}`}> · Keyakinan: {triageConfidenceLabel(item.confidence)} · {triageModelStatusLabel(item.model_status)}</span>
                  </div>
                  <div>
                    <span title={item.reason_codes.join(", ")}>Alasan: {item.reason_codes.map((code) => triageReasonLabel(code)).join(", ")}</span>
                    <span> · Ditinjau: {item.reviewed_at ? `${formatInstant(item.reviewed_at)} oleh ${item.reviewed_by ?? "—"}` : "belum"}</span>
                  </div>
                  <button
                    type="button"
                    className="queue-filter-btn"
                    onClick={async () => {
                      try {
                        await markTriageItemReviewed(item.item_identity_hash, {
                          apiBaseUrl,
                          fetcher,
                          csrfToken: effectiveCsrfToken,
                        });
                        setTriageFeedback("Ditandai ditinjau.");
                        await loadTriage();
                      } catch {
                        setTriageFeedback("Gagal menandai ditinjau.");
                      }
                    }}
                  >
                    Tandai ditinjau
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : (queue.length === 0 && !loading) ? (
        <div className="moderator-empty-queue" role="status">
          <div className="empty-queue-icon">✓</div>
          <h3>Semua proposal telah ditinjau</h3>
          <p>Tidak ada proposal insiden yang menunggu dalam antrean moderasi saat ini.</p>
          <a className="text-link" href="#peta">
            Kembali ke peta
          </a>
        </div>
      ) : (
        <div className="moderator-queue-grid">
          {/* Kolom Kiri: Antrean Proposal (360px) */}
          <aside className="queue-column" aria-label="Antrean proposal insiden">
            <header className="queue-column-header">
              <strong>Antrean Proposal</strong>
              <span className="queue-badge-count">{queue.length} menunggu</span>
            </header>

            {/* Quick Filter Bar */}
            <div className="queue-filter-bar" role="toolbar" aria-label="Filter kategori proposal">
              <button
                type="button"
                className={`queue-filter-btn ${queueCategoryFilter === "all" ? "queue-filter-btn--active" : ""}`}
                onClick={() => setQueueCategoryFilter("all")}
              >
                Semua ({queue.length})
              </button>
              {discrepancyQueueCount > 0 && (
                <button
                  type="button"
                  className={`queue-filter-btn ${
                    queueCategoryFilter === "discrepancy" ? "queue-filter-btn--active" : ""
                  }`}
                  onClick={() => setQueueCategoryFilter("discrepancy")}
                >
                  ⚠️ Perbedaan ({discrepancyQueueCount})
                </button>
              )}
              <button
                type="button"
                className={`queue-filter-btn ${
                  queueCategoryFilter === "flood" ? "queue-filter-btn--active" : ""
                }`}
                onClick={() => setQueueCategoryFilter("flood")}
              >
                Banjir
              </button>
              <button
                type="button"
                className={`queue-filter-btn ${
                  queueCategoryFilter === "fire" ? "queue-filter-btn--active" : ""
                }`}
                onClick={() => setQueueCategoryFilter("fire")}
              >
                Kebakaran
              </button>
              {otherQueueCount > 0 && (
                <button
                  type="button"
                  className={`queue-filter-btn ${
                    queueCategoryFilter === "other" ? "queue-filter-btn--active" : ""
                  }`}
                  onClick={() => setQueueCategoryFilter("other")}
                >
                  Lainnya ({otherQueueCount})
                </button>
              )}
            </div>

            <ul className="proposal-queue-list">
              {filteredQueue.map((item) => {
                const isSelected = item.proposal_id === selectedId;
                const isMultiSource = isProposalMultiSource(item);
                return (
                  <li key={item.proposal_id}>
                    <button
                      type="button"
                      className={`proposal-card-btn ${
                        isSelected ? "proposal-card-btn--selected" : ""
                      }`}
                      data-proposal-id={item.proposal_id}
                      aria-selected={isSelected}
                      onClick={() => setSelectedId(item.proposal_id)}
                    >
                      <div className="proposal-card-top">
                        <span
                          className={`incident-badge incident-badge--${item.primary_category ?? item.incident_type}`}
                        >
                          {proposalCategoryLabel(item)}
                        </span>
                        <span className={`severity-chip severity-chip--${item.severity}`}>
                          {severityLabel(item.severity)}
                        </span>
                        {isMultiSource && (
                          <span className="multi-source-badge">
                            Dilaporkan oleh {item.source_count ?? "?"} media
                          </span>
                        )}
                      </div>
                      <strong className="proposal-card-title">{item.title}</strong>
                      <div className="proposal-card-meta">
                        <span>📍 {item.location_label || "Lokasi belum ditentukan"}</span>
                        <span>⏱ {proposalEventTimeText(item.event_time)}</span>
                        <span>📄 {item.claims.length} klaim untuk ditinjau</span>
                      </div>
                      {item.impacts && item.impacts.length > 0 && (
                        <div className="proposal-card-impacts">
                          {item.impacts.map((imp, impIdx) => (
                            <span key={`card-imp-${impIdx}`} className="severity-chip proposal-card-impact">
                              {imp.replace(/_/g, " ")}
                            </span>
                          ))}
                        </div>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          </aside>

          {/* Kolom Kanan: Command Center Peta, Detail Proposal, & Floating Evidence Sheet */}
          <div className="details-column">
            {selectedProposal ? (
              <>
                {/* Header Identitas Proposal */}
                <section className="review-case-heading" aria-label="Identitas proposal insiden">
                  <div>
                    <div className="review-case-kicker-row">
                      <p className="section-kicker">Kandidat Terpilih</p>
                      {typeof selectedProposal.source_count === "number" && (
                        <span className="multi-source-badge">
                          Dilaporkan oleh {selectedProposal.source_count} media
                        </span>
                      )}
                      {selectedProposal.has_discrepancy && (
                        <span className="badge badge--warning discrepancy-badge" title="Terdapat perbedaan data kuantitatif atau status antar sumber">
                          ⚠️ Perbedaan Keterangan Sumber
                        </span>
                      )}
                    </div>
                    <h2>{selectedProposal.title}</h2>
                    <p>
                      Diajukan pada {formatInstant(selectedProposal.proposed_at)} · Schema{" "}
                      {selectedProposal.schema_version}
                    </p>
                  </div>
                  <dl>
                    <div>
                      <dt>ID Proposal</dt>
                      <dd>{selectedProposal.proposal_id}</dd>
                    </div>
                    <div>
                      <dt>Tipe Insiden</dt>
                      <dd>{incidentTypeLabel(selectedProposal.incident_type)}</dd>
                    </div>
                    <div>
                      <dt>Keparahan</dt>
                      <dd>{severityLabel(selectedProposal.severity)}</dd>
                    </div>
                    <div>
                      <dt>Waktu Kejadian</dt>
                      <dd>
                        {proposalEventTimeText(selectedProposal.event_time)}
                      </dd>
                    </div>
                    <div>
                      <dt>Lokasi</dt>
                      <dd>{selectedProposal.location_label || "Lokasi belum ditentukan"}</dd>
                    </div>
                    <div>
                      <dt>Koordinat</dt>
                      <dd>
                        {selectedProposal.coordinates
                          ? `${selectedProposal.coordinates[0].toFixed(4)}, ${selectedProposal.coordinates[1].toFixed(4)}`
                          : "Tidak ada koordinat"}
                      </dd>
                    </div>
                  </dl>
                </section>
                {selectedProposal.has_discrepancy && (
                  <aside className="notice notice--warning discrepancy-callout" role="alert" aria-label="Ringkasan perbedaan dari agen AI">
                    <h3 className="discrepancy-callout__title">⚠️ Perbedaan terdeteksi, diringkas agen AI</h3>
                    <p>{selectedProposal.discrepancy_summary ?? "Ringkasan tidak tersedia. Bandingkan klaim berikut."}</p>
                    {selectedProposal.discrepancies && selectedProposal.discrepancies.length > 0 && (
                      <div className="discrepancy-pairs">
                        {selectedProposal.discrepancies.map((disc, dIdx) => (
                          <div className="discrepancy-pair" key={`disc-${dIdx}`}>
                            <span className="badge badge--warning discrepancy-kind-pill" title={disc.kind}>{discrepancyKindLabel(disc.kind)}</span>
                            <div className="card discrepancy-side">
                              <strong>Laporan A</strong>
                              <p>{disc.source_a?.claim_text ?? "-"}</p>
                            </div>
                            <div className="card discrepancy-side">
                              <strong>{disc.source_b?.outlet ?? "Laporan B"}</strong>
                              <p>{disc.source_b?.claim_text ?? "-"}</p>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </aside>
                )}

                {/* Interactive Incident Map */}
                <InteractiveIncidentMap
                  coordinates={selectedProposal.coordinates}
                  incidentType={selectedProposal.incident_type}
                  severity={selectedProposal.severity}
                  locationLabel={selectedProposal.location_label}
                  title={selectedProposal.title}
                  activeQuote={activeClaim?.quote_text}
                  height={480}
                />

                {/* Floating Evidence Sheet */}
                <section
                  className="evidence-floating-sheet"
                  aria-labelledby="evidence-reader-title"
                >
                  <header className="evidence-floating-sheet-header">
                    <div>
                      <h3 id="evidence-reader-title" className="evidence-reader-heading">
                        Pembaca Bukti Sumber
                      </h3>
                      <p className="evidence-reader-subheading">
                        Verifikasi Grounding L2 · Klaim &amp; Dokumen Sumber Asli
                      </p>
                    </div>
                    {typeof selectedProposal.source_count === "number" && (
                      <span className="multi-source-badge">
                        Dilaporkan oleh {selectedProposal.source_count} media
                      </span>
                    )}
                  </header>

                  <div className="evidence-floating-sheet-body">
                    <div className="review-columns">
                      {/* Bukti Sumber & Pembaca Highlight */}
                      <section className="review-evidence" aria-label="Teks dokumen sumber">
                        <header className="review-column-heading">
                          <p className="section-kicker">Kutipan Dokumen Asli</p>
                          <h4 className="review-column-subheading">
                            Potongan Teks Dokumen
                          </h4>
                        </header>

                        {relevantChunks && relevantChunks.length > 0 ? (
                          <div className="chunks-list">
                            {relevantChunks.map((chunk, idx) => (
                              <article key={`chunk-${chunk.chunk_index}-${idx}`} className="chunk-article">
                                <header className="chunk-header">
                                  <strong>Chunk #{chunk.chunk_index + 1}</strong>
                                  <span className="chunk-span">
                                    Rentang teks {chunk.span_start}–{chunk.span_end}
                                  </span>
                                </header>
                                <blockquote className="review-quote">
                                  {renderHighlightedText(chunk.text, currentQuotes)}
                                </blockquote>
                              </article>
                            ))}
                          </div>
                        ) : (
                          <div className="quotes-fallback-list">
                            <p className="evidence-reader-note">
                              Kutipan bukti langsung yang diekstraksi dari dokumen sumber:
                            </p>
                            {selectedProposal.claims.map((claim) => (
                              <article key={claim.claim_id} className="quote-card">
                                <header className="quote-card-header">
                                  <span className="quote-ref-badge">Ref: {claim.evidence_ref_id}</span>
                                  <span className="quote-status-badge">Didukung</span>
                                </header>
                                <blockquote className="review-quote">
                                  <mark className="evidence-quote-highlight">
                                    {claim.quote_text}
                                  </mark>
                                </blockquote>
                              </article>
                            ))}
                          </div>
                        )}
                      </section>

                      {/* Klaim dan Grounding */}
                      <section className="review-proposal" aria-labelledby="claims-breakdown-title">
                        <header className="review-column-heading">
                          <p className="section-kicker">Struktur Klaim Insiden</p>
                          <h2 id="claims-breakdown-title">
                            Daftar Klaim ({selectedProposal.claims.length})
                          </h2>
                        </header>

                        <div className="claims-list">
                          {selectedProposal.claims.map((claim) => {
                            const isClaimActive = activeClaimId === claim.claim_id;
                            return (
                              <article
                                key={claim.claim_id}
                                className={`claim-card-row ${
                                  isClaimActive ? "claim-card-row--active" : ""
                                }`}
                                onClick={() =>
                                  setActiveClaimId(isClaimActive ? null : claim.claim_id)
                                }
                              >
                                <header className="claim-card-top">
                                  <span className="claim-ref-badge">ID: {claim.claim_id}</span>
                                  <div className="claim-badges-group">
                                    <span className="claim-status-badge" title="under_review">Menunggu tinjauan</span>
                                    <span className="claim-origin-label">Asal: {claimOriginName(claim)}</span>
                                  </div>
                                </header>
                                <blockquote className="review-claim">
                                  {claim.claim_text}
                                </blockquote>
                                <div className="claim-quote-box">
                                  <strong>Kutipan: </strong>
                                  <em>"{claim.quote_text}"</em>
                                  <div className="claim-quote-meta">
                                    Ref Bukti: {claim.evidence_ref_id} · {claim.support_assessment}
                                  </div>
                                </div>
                              </article>
                            );
                          })}
                        </div>
                      </section>
                    </div>
                  </div>
                </section>

                {/* Kontrol Aksi Keputusan Moderator */}
                <div className="review-action-bar">
                  <button
                    type="button"
                    className="action-button action-button--approve"
                    data-action="approve"
                    disabled={submitting}
                    onClick={() => {
                      setEvidenceLabelChoice(autoDetectEvidenceLabel(selectedProposal));
                      setCategoryChoice(null);
                      setModalOpen(true);
                    }}
                  >
                    Setujui & Terbitkan
                  </button>
                  <button
                    type="button"
                    className="action-button action-button--reject"
                    data-action="reject"
                    disabled={submitting}
                    onClick={() => void handleAction("reject")}
                  >
                    Tolak
                  </button>
                  <button
                    type="button"
                    className="action-button action-button--investigate"
                    data-action="investigate"
                    disabled={submitting}
                    onClick={() => void handleAction("investigate")}
                  >
                    Minta Bukti
                  </button>
                </div>
              </>
            ) : (
              <div className="state-panel" role="status">
                Pilih proposal dari antrean di sebelah kiri untuk melihat rincian bukti.
              </div>
            )}
          </div>
        </div>
      )}

      {/* Modal Dialog Pilihan Label Bukti */}
      {modalOpen && selectedProposal && (
        <div
          className="modal-backdrop"
          role="presentation"
          onClick={() => !submitting && setModalOpen(false)}
        >
          <div
            className="modal-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="approval-modal-title"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="modal-header">
              <h3 id="approval-modal-title">Setujui & Terbitkan Proposal</h3>
              <p className="modal-subtitle">{selectedProposal.title}</p>
            </div>

            <div className="modal-body">
              <fieldset className="modal-fieldset">
                <legend className="modal-legend">Pilih Klasifikasi Label Bukti</legend>
                <p className="modal-help-text">
                  Pilih label bukti yang tepat sebelum diterbitkan ke feed publik Waspada Jakarta:
                </p>

                {/* Option 2: Attributed Report */}
                <label
                  className={`label-choice-card ${
                    evidenceLabelChoice === "attributed_report"
                      ? "label-choice-card--selected"
                      : ""
                  }`}
                >
                  <input
                    type="radio"
                    name="evidence_label"
                    value="attributed_report"
                    checked={evidenceLabelChoice === "attributed_report"}
                    onChange={() => setEvidenceLabelChoice("attributed_report")}
                  />
                  <div className="label-choice-text">
                    <strong>Laporan Teratribusi (attributed_report)</strong>
                    <span>
                      Berasal dari sumber berita resmi, BMKG, atau instansi terverifikasi (mis. ANTARA News).
                    </span>
                  </div>
                </label>

                {/* Option 3: Crowdsourced Observation */}
                <label
                  className={`label-choice-card ${
                    evidenceLabelChoice === "crowdsourced_observation"
                      ? "label-choice-card--selected"
                      : ""
                  }`}
                >
                  <input
                    type="radio"
                    name="evidence_label"
                    value="crowdsourced_observation"
                    checked={evidenceLabelChoice === "crowdsourced_observation"}
                    onChange={() => setEvidenceLabelChoice("crowdsourced_observation")}
                  />
                  <div className="label-choice-text">
                    <strong>Observasi Warga (crowdsourced_observation)</strong>
                    <span>
                      Berasal dari laporan publik, sensor masyarakat, atau agregasi warga (mis. PetaBencana.id).
                    </span>
                  </div>
                </label>
              </fieldset>

              {selectedProposal && hasCategoryMismatch(selectedProposal) && (
                <fieldset className="modal-fieldset">
                  <legend className="modal-legend">Kategori berbeda — pilih kategori yang dipakai</legend>
                  <p className="modal-help-text">
                    Penyaring awal dan agen interpretasi menilai kategori yang berbeda untuk proposal ini.
                    Sistem tidak memilih sendiri, jadi pilih satu kategori.
                  </p>
                  {categoryChoiceOptions(selectedProposal).map((option) => (
                    <label
                      key={option.choice}
                      className={`label-choice-card ${
                        categoryChoice === option.choice ? "label-choice-card--selected" : ""
                      }`}
                    >
                      <input
                        type="radio"
                        name="category_resolution"
                        value={option.choice}
                        checked={categoryChoice === option.choice}
                        disabled={submitting || option.category === null}
                        onChange={() => setCategoryChoice(option.choice)}
                      />
                      <div className="label-choice-text">
                        <strong>{option.label}</strong>
                        <span>
                          {option.category === null ? `${option.hint}; tidak tercatat pada proposal` : option.hint}
                        </span>
                      </div>
                    </label>
                  ))}
                  {categoryPlan !== null && !categoryPlan.ok && (
                    <p id="category-choice-hint" className="modal-help-text" role="status">
                      {categoryPlan.hint}
                    </p>
                  )}
                </fieldset>
              )}

              <div className="modal-input-group">
                <label htmlFor="decision-reason-input">Catatan / Alasan Verifikasi (Opsional):</label>
                <input
                  id="decision-reason-input"
                  type="text"
                  className="modal-text-input"
                  value={decisionReason}
                  onChange={(e) => setDecisionReason(e.target.value)}
                  placeholder="Contoh: Terverifikasi dari liputan ANTARA News Metro & laporan PetaBencana"
                  disabled={submitting}
                />
              </div>
            </div>

            <div className="modal-footer">
              <button
                type="button"
                className="modal-btn modal-btn--cancel"
                data-action="modal-cancel"
                disabled={submitting}
                onClick={() => setModalOpen(false)}
              >
                Batal
              </button>
              <button
                type="button"
                className="modal-btn modal-btn--primary"
                data-action="modal-confirm"
                disabled={submitting || (categoryPlan !== null && !categoryPlan.ok)}
                aria-describedby={categoryPlan !== null && !categoryPlan.ok ? "category-choice-hint" : undefined}
                onClick={() =>
                  void handleAction("publish", evidenceLabelChoice, decisionReason)
                }
              >
                {submitting ? "Menerbitkan…" : "Konfirmasi & Terbitkan"}
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="review-footer">
        <a className="text-link" href="#peta">
          Kembali ke peta
        </a>
        <span>MOD-01 diperlukan untuk autentikasi dan tindakan review.</span>
      </div>
    </div>
  );
}

function renderReadOnlyFixture(): React.JSX.Element {
  return (
    <div className="moderator-page">
      <section className="review-heading" aria-labelledby="review-title">
        <div>
          <p className="section-kicker">Ruang tinjau · contoh UI</p>
          <h2 id="review-title">Tinjau bukti</h2>
          <p>Hubungan sumber, klaim, versi, dan geometri ditampilkan berdampingan.</p>
        </div>
        <span className="read-only-stamp">Pratinjau baca saja</span>
      </section>

      <div className="read-only-callout" role="note">
        <strong>Bukan antrean moderator.</strong>
        <span>
          Laporan di bawah berasal dari fixture dokumentasi, bukan API review. Tidak ada sesi autentikasi atau tindakan tulis pada demo ini.
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
            <div><dt>Revisi laporan sumber</dt><dd>{fixture.source.reportRevisionId}</dd></div>
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
            <div className="claim-card__label">{evidenceLabel(fixture.claim.evidenceLabel)} · nilai fixture</div>
            <blockquote>{fixture.claim.text}</blockquote>
            <p className="qualifier">{fixture.claim.qualifier}</p>
            <dl className="detail-facts">
              <div><dt>Waktu kejadian</dt><dd><time dateTime={fixture.event.eventTime.start}>{formatInstant(fixture.event.eventTime.start)}</time> · {fixture.event.eventTime.precision}</dd></div>
              <div><dt>Siklus</dt><dd>{lifecycleLabel(fixture.event.lifecycle)}</dd></div>
              <div><dt>Kesegaran</dt><dd>{freshnessLabel(fixture.event.freshness.status)} · dievaluasi {formatInstant(fixture.event.freshness.evaluatedAt)}</dd></div>
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
            Jumlah dan status di sini menjelaskan laporan contoh saja; bukan temuan tentang sumber atau kejadian nyata.
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
          <MapPanel selection={{ kind: "presentation" }} onReturnToList={() => { window.location.hash = "#peta"; }} />
          <p className="map-review-note">Segmen route ini adalah geometri sintetik dokumentasi; basis ketelitian fixture: unknown.</p>
        </div>
      </div>

      <div className="review-footer">
        <a className="text-link" href="#peta">Kembali ke peta</a>
        <span>MOD-01 diperlukan untuk autentikasi dan tindakan review.</span>
      </div>
    </div>
  );
}

export function ModeratorReview(props: ModeratorReviewProps = {}): React.JSX.Element {
  const isFixture =
    props.mode === "fixture" ||
    (typeof window === "undefined" && !props.proposals && props.mode !== "queue");

  if (isFixture) {
    return renderReadOnlyFixture();
  }

  return <ModeratorReviewQueue {...props} />;
}
