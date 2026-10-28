import * as React from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { evidenceLabel, formatInstant, freshnessLabel, lifecycleLabel } from "./display.js";
import { documentedPresentationFixture as fixture } from "./presentation-fixture.js";
import { MapPanel } from "./MapPanel.js";
import { InteractiveIncidentMap } from "./InteractiveIncidentMap.js";
export { InteractiveIncidentMap } from "./InteractiveIncidentMap.js";

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
  readonly is_corroborated?: boolean;
}

export interface EventProposalDto {
  readonly schema_version: "2.0";
  readonly proposal_id: string;
  readonly title: string;
  readonly incident_type: "flood" | "fire" | "accident" | "tree_fall" | "crime" | "weather";
  readonly severity: "low" | "medium" | "high" | "critical";
  readonly event_time: { readonly precision: "exact" | "date" | "range" | "unknown"; readonly value: string };
  readonly location_label: string;
  readonly coordinates: readonly [longitude: number, latitude: number] | null;
  readonly claims: readonly ProposalClaim[];
  readonly proposed_at: string;
  readonly is_multi_source?: boolean;
  readonly source_count?: number;
}

export interface ModeratorDecisionCommand {
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
    default: return type;
  }
}

export function severityLabel(sev: string): string {
  switch (sev) {
    case "critical": return "Kritis";
    case "high": return "Tinggi";
    case "medium": return "Sedang";
    case "low": return "Rendah";
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

export function autoDetectEvidenceLabel(
  proposal: EventProposalDto
): "independent_corroboration" | "attributed_report" | "crowdsourced_observation" {
  if (isProposalMultiSource(proposal)) {
    return "independent_corroboration";
  }
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
    throw new Error(`Failed to fetch moderation proposals: HTTP ${response.status}`);
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
    throw new Error(`Failed to fetch proposal details: HTTP ${response.status}`);
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
    headers["x-csrf-token"] = options.csrfToken;
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
    try {
      const errorJson = (await response.json()) as { error?: string; message?: string };
      if (errorJson.error || errorJson.message) {
        errorDetail += `: ${errorJson.error || errorJson.message}`;
      }
    } catch {
      // ignore
    }
    throw new Error(`Moderation action failed: ${errorDetail}`);
  }
  return (await response.json()) as { ok: boolean; status: string };
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
  const [evidenceLabelChoice, setEvidenceLabelChoice] = useState<
    "attributed_report" | "crowdsourced_observation" | "independent_corroboration"
  >(() => {
    const first = controlledProposals?.[0];
    return first ? autoDetectEvidenceLabel(first) : "attributed_report";
  });
  const [decisionReason, setDecisionReason] = useState<string>("");
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [feedback, setFeedback] = useState<ModerationFeedback | null>(initialFeedback);
  const [sessionCsrf, setSessionCsrf] = useState<string>("");
  const [queueCategoryFilter, setQueueCategoryFilter] = useState<string>("all");
  const [activeClaimId, setActiveClaimId] = useState<string | null>(null);

  const effectiveCsrfToken = propCsrfToken || sessionCsrf;

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
    if (!propCsrfToken && typeof window !== "undefined") {
      fetch("/api/v1/account/session", { credentials: "same-origin" })
        .then((res) => (res.ok ? res.json() : null))
        .then((data: unknown) => {
          if (data && typeof data === "object" && "session" in data) {
            const session = data.session;
            if (session && typeof session === "object" && "csrf_token" in session) {
              const token = session.csrf_token;
              if (typeof token === "string") {
                setSessionCsrf(token);
              }
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

  // Sync auto-detected evidence label when selected proposal changes
  useEffect(() => {
    if (selectedProposal) {
      setEvidenceLabelChoice(autoDetectEvidenceLabel(selectedProposal));
      setActiveClaimId(null);
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
  // Filter queue by category / multi-source
  const filteredQueue = useMemo(() => {
    if (queueCategoryFilter === "all") return queue;
    if (queueCategoryFilter === "multi_source") {
      return queue.filter((p) => isProposalMultiSource(p));
    }
    return queue.filter((p) => p.incident_type === queueCategoryFilter);
  }, [queue, queueCategoryFilter]);

  const multiSourceQueueCount = useMemo(() => {
    return queue.filter((p) => isProposalMultiSource(p)).length;
  }, [queue]);

  const handleAction = useCallback(
    async (
      action: "publish" | "reject" | "investigate",
      evidence_label: "attributed_report" | "crowdsourced_observation" | "independent_corroboration" = "attributed_report",
      reason?: string
    ) => {
      if (!selectedProposal || submitting) return;
      setSubmitting(true);
      const command: ModeratorDecisionCommand = {
        proposal_id: selectedProposal.proposal_id,
        action,
        evidence_label,
        ...(reason?.trim() ? { reason: reason.trim() } : {}),
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
        setFeedback({
          type: "error",
          message: `Gagal memproses proposal: ${err instanceof Error ? err.message : String(err)}`,
        });
      } finally {
        setSubmitting(false);
      }
    },
    [selectedProposal, submitting, onDecision, apiBaseUrl, fetcher, effectiveCsrfToken, queue]
  );

  return (
    <main id="main-content" className="main-shell moderator-page moderator-page--queue">
      <style>{`
        .moderator-page--queue {
          max-width: 86rem;
          margin: 0 auto;
        }
        .moderator-queue-grid {
          display: grid;
          grid-template-columns: 360px minmax(0, 1fr);
          gap: 1.5rem;
          align-items: start;
          margin-top: 1rem;
        }
        @media (max-width: 1024px) {
          .moderator-queue-grid {
            grid-template-columns: minmax(0, 1fr);
          }
        }
        .queue-column {
          border: 1px solid var(--beton);
          background: var(--surface);
          border-radius: 8px;
          overflow: hidden;
          box-shadow: 0 2px 8px rgba(0, 0, 0, 0.05);
        }
        .queue-column-header {
          padding: 1rem;
          border-bottom: 1px solid var(--beton);
          background: var(--soft-panel);
          display: flex;
          justify-content: space-between;
          align-items: center;
        }
        .queue-badge-count {
          font-size: 0.8rem;
          padding: 0.2rem 0.55rem;
          border-radius: 999px;
          background: var(--kali-teal);
          color: white;
          font-weight: 600;
        }
        .queue-filter-bar {
          display: flex;
          gap: 0.35rem;
          padding: 0.65rem 0.85rem;
          background: #f8fafc;
          border-bottom: 1px solid var(--beton);
          overflow-x: auto;
          white-space: nowrap;
        }
        .queue-filter-btn {
          font-size: 0.75rem;
          font-weight: 600;
          padding: 0.25rem 0.65rem;
          border-radius: 14px;
          border: 1px solid #cbd5e1;
          background: #ffffff;
          color: #475569;
          cursor: pointer;
          transition: all 0.15s ease;
        }
        .queue-filter-btn:hover {
          background: #f1f5f9;
        }
        .queue-filter-btn--active {
          background: var(--kali-teal);
          color: #ffffff;
          border-color: var(--kali-teal);
        }
        .proposal-queue-list {
          list-style: none;
          margin: 0;
          padding: 0;
          max-height: 75vh;
          overflow-y: auto;
        }
        .proposal-card-btn {
          width: 100%;
          text-align: left;
          padding: 1rem;
          border: none;
          border-bottom: 1px solid var(--beton);
          background: var(--surface);
          cursor: pointer;
          transition: background 0.15s ease;
          display: block;
        }
        .proposal-card-btn:hover {
          background: var(--hujan-pagi);
        }
        .proposal-card-btn--selected {
          background: var(--hujan-pagi);
          border-left: 4px solid var(--kali-teal);
        }
        .proposal-card-top {
          display: flex;
          gap: 0.4rem;
          margin-bottom: 0.4rem;
          align-items: center;
          flex-wrap: wrap;
        }
        .incident-badge {
          font-size: 0.72rem;
          font-weight: 700;
          padding: 0.15rem 0.45rem;
          border-radius: 4px;
          text-transform: uppercase;
          letter-spacing: 0.03em;
        }
        .incident-badge--flood { background: #E6F7FF; color: #0050B3; border: 1px solid #91CAFF; }
        .incident-badge--fire { background: #FFF1F0; color: #CF1322; border: 1px solid #FFA39E; }
        .incident-badge--accident { background: #FFF7E6; color: #D46B08; border: 1px solid #FFD591; }
        .incident-badge--tree_fall { background: #F6FFED; color: #389E0D; border: 1px solid #B7EB8F; }
        .incident-badge--crime { background: #F9F0FF; color: #531DAB; border: 1px solid #D3ADF7; }
        .incident-badge--weather { background: #E6FFFB; color: #08979C; border: 1px solid #87E8DE; }
        .severity-chip {
          font-size: 0.72rem;
          font-weight: 600;
          padding: 0.1rem 0.4rem;
          border-radius: 4px;
        }
        .severity-chip--critical { background: var(--merah-tanda); color: white; }
        .severity-chip--high { background: #FA8C16; color: white; }
        .severity-chip--medium { background: var(--kuning-perhatian); color: #18323A; }
        .severity-chip--low { background: #D9D9D9; color: #434343; }
        .multi-source-badge {
          display: inline-flex;
          align-items: center;
          gap: 0.25rem;
          font-size: 0.7rem;
          font-weight: 700;
          padding: 0.15rem 0.5rem;
          border-radius: 9999px;
          background: linear-gradient(135deg, #0d9488 0%, #0284c7 100%);
          color: #ffffff;
          box-shadow: 0 1px 3px rgba(0, 0, 0, 0.15);
        }
        .proposal-card-title {
          display: block;
          font-size: 0.95rem;
          font-weight: 600;
          color: var(--tinta-kota);
          margin-bottom: 0.35rem;
          line-height: 1.35;
        }
        .proposal-card-meta {
          display: flex;
          flex-direction: column;
          gap: 0.15rem;
          font-size: 0.8rem;
          color: var(--quiet-ink);
        }
        .evidence-quote-highlight {
          background: #FFE58F;
          color: #18323A;
          font-weight: 600;
          padding: 0.1rem 0.25rem;
          border-radius: 2px;
          box-shadow: 0 0 0 1px #FFD666;
        }
        .evidence-quote-highlight--active {
          background: #5eead4;
          color: #042f2e;
          box-shadow: 0 0 0 2px #0d9488;
        }
        .review-action-bar {
          display: flex;
          gap: 0.75rem;
          margin-top: 1.5rem;
          padding: 1.15rem 1.25rem;
          background: #ffffff;
          border: 1px solid var(--beton);
          border-radius: 8px;
          box-shadow: 0 4px 12px rgba(0, 0, 0, 0.06);
          align-items: center;
          justify-content: flex-start;
          flex-wrap: wrap;
        }
        .action-button {
          padding: 0.65rem 1.25rem;
          font-size: 0.925rem;
          font-weight: 600;
          border-radius: 6px;
          cursor: pointer;
          border: 1px solid transparent;
          transition: all 0.15s ease;
        }
        .action-button--approve {
          background: var(--kali-teal);
          color: white;
        }
        .action-button--approve:hover:not(:disabled) {
          background: #06635E;
        }
        .action-button--reject {
          background: white;
          border-color: var(--merah-tanda);
          color: var(--merah-tanda);
        }
        .action-button--reject:hover:not(:disabled) {
          background: #FFF1F0;
        }
        .action-button--investigate {
          background: white;
          border-color: var(--quiet-ink);
          color: var(--tinta-kota);
        }
        .action-button--investigate:hover:not(:disabled) {
          background: var(--soft-panel);
        }
        .action-button:disabled {
          opacity: 0.6;
          cursor: not-allowed;
        }
        .feedback-banner {
          padding: 0.75rem 1.25rem;
          border-radius: 6px;
          margin-bottom: 1rem;
          display: flex;
          justify-content: space-between;
          align-items: center;
          font-weight: 500;
        }
        .feedback-banner--success {
          background: #F6FFED;
          border: 1px solid #B7EB8F;
          color: #237804;
        }
        .feedback-banner--error {
          background: #FFF1F0;
          border: 1px solid #FFA39E;
          color: #CF1322;
        }
        .feedback-banner--info {
          background: #E6F7FF;
          border: 1px solid #91CAFF;
          color: #096DD9;
        }
        .feedback-dismiss {
          background: none;
          border: none;
          font-size: 1.25rem;
          cursor: pointer;
          color: inherit;
          padding: 0 0.25rem;
        }
        .modal-backdrop {
          position: fixed;
          inset: 0;
          background: rgba(10, 25, 30, 0.55);
          display: flex;
          align-items: center;
          justify-content: center;
          z-index: 9999;
          padding: 1rem;
        }
        .modal-dialog {
          background: var(--surface);
          border-radius: 8px;
          box-shadow: 0 10px 25px rgba(0,0,0,0.2);
          width: 100%;
          max-width: 580px;
          max-height: 90vh;
          overflow-y: auto;
          border: 1px solid var(--beton);
        }
        .modal-header {
          padding: 1.25rem 1.5rem;
          border-bottom: 1px solid var(--beton);
        }
        .modal-header h3 {
          margin: 0 0 0.25rem 0;
          font-size: 1.25rem;
        }
        .modal-subtitle {
          margin: 0;
          color: var(--quiet-ink);
          font-size: 0.875rem;
        }
        .modal-body {
          padding: 1.25rem 1.5rem;
        }
        .modal-footer {
          padding: 1rem 1.5rem;
          border-top: 1px solid var(--beton);
          background: var(--hujan-pagi);
          display: flex;
          justify-content: flex-end;
          gap: 0.75rem;
        }
        .modal-fieldset {
          border: none;
          padding: 0;
          margin: 0 0 1.25rem 0;
        }
        .modal-legend {
          font-weight: 700;
          font-size: 0.95rem;
          margin-bottom: 0.4rem;
          color: var(--tinta-kota);
        }
        .modal-help-text {
          font-size: 0.85rem;
          color: var(--quiet-ink);
          margin: 0 0 0.8rem 0;
        }
        .label-choice-card {
          display: flex;
          gap: 0.75rem;
          padding: 0.75rem 1rem;
          border: 1px solid var(--beton);
          border-radius: 6px;
          margin-bottom: 0.6rem;
          cursor: pointer;
          align-items: flex-start;
          transition: all 0.15s ease;
        }
        .label-choice-card input[type="radio"] {
          margin-top: 0.2rem;
        }
        .label-choice-card--selected {
          border-color: var(--kali-teal);
          background: #E6FFFB;
        }
        .label-choice-text strong {
          display: block;
          font-size: 0.9rem;
          color: var(--tinta-kota);
          margin-bottom: 0.15rem;
        }
        .label-choice-text span {
          display: block;
          font-size: 0.8rem;
          color: var(--quiet-ink);
          line-height: 1.35;
        }
        .modal-input-group label {
          display: block;
          font-size: 0.875rem;
          font-weight: 600;
          margin-bottom: 0.35rem;
          color: var(--tinta-kota);
        }
        .modal-text-input {
          width: 100%;
          box-sizing: border-box;
          padding: 0.6rem 0.75rem;
          border: 1px solid var(--beton);
          border-radius: 4px;
          font-size: 0.9rem;
          font-family: inherit;
        }
        .modal-btn {
          padding: 0.6rem 1.15rem;
          font-size: 0.9rem;
          font-weight: 600;
          border-radius: 6px;
          cursor: pointer;
          border: 1px solid transparent;
        }
        .modal-btn--cancel {
          background: white;
          border-color: var(--beton);
          color: var(--tinta-kota);
        }
        .modal-btn--confirm {
          background: var(--kali-teal);
          color: white;
        }
        .modal-btn--confirm:hover:not(:disabled) {
          background: #06635E;
        }
        .moderator-empty-queue {
          padding: 3rem 1.5rem;
          text-align: center;
          border: 1px dashed var(--beton);
          background: var(--surface);
          border-radius: 8px;
          margin-top: 1rem;
        }
        .empty-queue-icon {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          width: 3.5rem;
          height: 3.5rem;
          border-radius: 50%;
          background: #F6FFED;
          color: #389E0D;
          font-size: 1.75rem;
          font-weight: bold;
          margin-bottom: 1rem;
          border: 2px solid #B7EB8F;
        }
        .moderator-empty-queue h3 {
          margin: 0 0 0.5rem 0;
          color: var(--tinta-kota);
        .moderator-empty-queue p {
          margin: 0 0 1.25rem 0;
          color: var(--quiet-ink);
        }
        .chunk-article {
          border: 1px solid var(--beton);
          background: var(--surface);
          border-radius: 6px;
          padding: 0.85rem;
          margin-bottom: 0.75rem;
        }
        .chunk-header {
          display: flex;
          justify-content: space-between;
          font-size: 0.825rem;
          color: var(--quiet-ink);
          margin-bottom: 0.5rem;
        }
        .quote-card {
          border: 1px solid var(--beton);
          background: var(--surface);
          border-radius: 6px;
          padding: 0.85rem;
          margin-bottom: 0.75rem;
        }
        .quote-card-header {
          display: flex;
          justify-content: space-between;
          font-size: 0.825rem;
          margin-bottom: 0.4rem;
        }
        .quote-ref-badge {
          background: var(--soft-panel);
          padding: 0.15rem 0.4rem;
          border-radius: 4px;
          font-family: monospace;
          font-size: 0.75rem;
        }
        .quote-status-badge {
          color: #389E0D;
          font-weight: 600;
        }
        .claim-card-row {
          border: 1px solid var(--beton);
          background: var(--surface);
          border-radius: 6px;
          padding: 0.85rem;
          margin-bottom: 0.75rem;
          cursor: pointer;
          transition: border-color 0.15s ease, box-shadow 0.15s ease;
        }
        .claim-card-row:hover {
          border-color: var(--kali-teal);
        }
        .claim-card-row--active {
          border-color: var(--kali-teal);
          box-shadow: 0 0 0 2px rgba(13, 148, 136, 0.25);
          background: #f0fdfa;
        }
        .claim-card-top {
          display: flex;
          justify-content: space-between;
          font-size: 0.8rem;
          margin-bottom: 0.4rem;
          align-items: center;
        }
        .claim-status-badge {
          padding: 0.15rem 0.45rem;
          border-radius: 4px;
          background: #FFF7E6;
          color: #D46B08;
          font-weight: 600;
          font-size: 0.75rem;
        }
        .corroborated-badge {
          border-radius: 4px;
          background: #ecfdf5;
          color: #047857;
          border: 1px solid #a7f3d0;
          font-weight: 700;
          font-size: 0.75rem;
        }
        .claim-quote-box {
          background: var(--hujan-pagi);
          border-left: 3px solid var(--kali-teal);
          padding: 0.5rem 0.75rem;
          margin-top: 0.5rem;
          font-size: 0.875rem;
        }
        .evidence-floating-sheet {
          margin-top: 1.25rem;
          background: #ffffff;
          border: 1px solid var(--beton);
          border-radius: 8px;
          overflow: hidden;
          box-shadow: 0 2px 10px rgba(0, 0, 0, 0.05);
        }
        .evidence-floating-sheet-header {
          padding: 0.85rem 1.25rem;
          background: #f8fafc;
          border-bottom: 1px solid var(--beton);
          display: flex;
          justify-content: space-between;
          align-items: center;
        }
        .evidence-floating-sheet-body {
          padding: 1.25rem;
        }
        .facility-filter-pill {
          background: transparent;
          border: 1px solid transparent;
          color: #94a3b8;
          font-size: 0.75rem;
          padding: 2px 8px;
          border-radius: 12px;
          cursor: pointer;
          transition: all 0.15s ease;
        }
        .facility-filter-pill:hover {
          color: #ffffff;
        }
        .facility-filter-pill--active {
          background: rgba(255, 255, 255, 0.2);
          color: #ffffff;
          border-color: rgba(255, 255, 255, 0.3);
        }
        .map-tool-btn {
          background: rgba(255, 255, 255, 0.15);
          color: #ffffff;
          border: 1px solid rgba(255, 255, 255, 0.2);
          border-radius: 4px;
          padding: 2px 8px;
          font-size: 0.85rem;
          cursor: pointer;
        }
        .map-tool-btn:hover {
          background: rgba(255, 255, 255, 0.25);
        }
      `}</style>

      <section className="review-heading" aria-labelledby="review-title">
        <div>
          <p className="section-kicker">Antrean Kerja Moderator L4</p>
          <h1 id="review-title">Tinjau Bukti & Moderasi Insiden</h1>
          <p>Verifikasi grounding bukti sumber terhadap klaim sebelum penerbitan ke publik.</p>
        </div>
        <span className="fixture-chip">Live Moderation</span>
      </section>

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

      {loading ? (
        <div className="state-panel" role="status">
          Memuat antrean proposal moderasi…
        </div>
      ) : queue.length === 0 ? (
        <div className="moderator-empty-queue" role="status">
          <div className="empty-queue-icon">✓</div>
          <h3>Semua proposal telah ditinjau</h3>
          <p>Tidak ada proposal insiden yang menunggu dalam antrean moderasi saat ini.</p>
          <a className="text-link" href="#jelajah">
            Kembali ke jelajah
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
              {multiSourceQueueCount > 0 && (
                <button
                  type="button"
                  className={`queue-filter-btn ${
                    queueCategoryFilter === "multi_source" ? "queue-filter-btn--active" : ""
                  }`}
                  onClick={() => setQueueCategoryFilter("multi_source")}
                >
                  ⚡ Multi-Sumber ({multiSourceQueueCount})
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
                          className={`incident-badge incident-badge--${item.incident_type}`}
                        >
                          {incidentTypeLabel(item.incident_type)}
                        </span>
                        <span className={`severity-chip severity-chip--${item.severity}`}>
                          {severityLabel(item.severity)}
                        </span>
                        {isMultiSource && (
                          <span className="multi-source-badge">
                            ⚡ {item.source_count ?? 2} Sumber Terkorelasi
                          </span>
                        )}
                      </div>
                      <strong className="proposal-card-title">{item.title}</strong>
                      <div className="proposal-card-meta">
                        <span>📍 {item.location_label}</span>
                        <span>⏱ {item.event_time.value}</span>
                        <span>📄 {item.claims.length} klaim terverifikasi</span>
                      </div>
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
                    <div style={{ display: "flex", gap: "0.5rem", alignItems: "center", marginBottom: "0.25rem" }}>
                      <p className="section-kicker" style={{ margin: 0 }}>Kandidat Terpilih</p>
                      {isProposalMultiSource(selectedProposal) && (
                        <span className="multi-source-badge">
                          ⚡ {selectedProposal.source_count ?? 2} Sumber Terkorelasi
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
                        {selectedProposal.event_time.value} ({selectedProposal.event_time.precision})
                      </dd>
                    </div>
                    <div>
                      <dt>Lokasi</dt>
                      <dd>{selectedProposal.location_label}</dd>
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
                      <h3 id="evidence-reader-title" style={{ margin: 0, fontSize: "1.05rem" }}>
                        Pembaca Bukti Sumber
                      </h3>
                      <p style={{ margin: "0.15rem 0 0 0", fontSize: "0.8rem", color: "var(--quiet-ink)" }}>
                        Verifikasi Grounding L2 · Klaim &amp; Dokumen Sumber Asli
                      </p>
                    </div>
                    {isProposalMultiSource(selectedProposal) && (
                      <span className="corroborated-badge">
                        ⚡ Fusi Multi-Sumber Aktif
                      </span>
                    )}
                  </header>

                  <div className="evidence-floating-sheet-body">
                    <div className="review-columns">
                      {/* Bukti Sumber & Pembaca Highlight */}
                      <section className="review-evidence" aria-label="Teks dokumen sumber">
                        <header className="review-column-heading">
                          <p className="section-kicker">Kutipan Dokumen Asli</p>
                          <h4 style={{ margin: "0.2rem 0 0.75rem 0", fontSize: "0.95rem" }}>
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
                                    Span kode poin {chunk.span_start}–{chunk.span_end}
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
                                  <div style={{ display: "flex", gap: "0.3rem" }}>
                                    {claim.is_corroborated && (
                                      <span className="corroborated-badge">
                                        ✓ Terkonfirmasi Independen
                                      </span>
                                    )}
                                    <span className="claim-status-badge">under_review</span>
                                  </div>
                                </header>
                                <blockquote className="review-claim">
                                  {claim.claim_text}
                                </blockquote>
                                <div className="claim-quote-box">
                                  <strong>Kutipan: </strong>
                                  <em>"{claim.quote_text}"</em>
                                  <div
                                    style={{
                                      marginTop: "0.25rem",
                                      color: "var(--quiet-ink)",
                                      fontSize: "0.78rem",
                                    }}
                                  >
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

                {/* Option 1: Independent Corroboration */}
                <label
                  className={`label-choice-card ${
                    evidenceLabelChoice === "independent_corroboration"
                      ? "label-choice-card--selected"
                      : ""
                  }`}
                >
                  <input
                    type="radio"
                    name="evidence_label"
                    value="independent_corroboration"
                    checked={evidenceLabelChoice === "independent_corroboration"}
                    onChange={() => setEvidenceLabelChoice("independent_corroboration")}
                  />
                  <div className="label-choice-text">
                    <strong>Konfirmasi Multi-Sumber (independent_corroboration)</strong>
                    <span>
                      Diverifikasi silang dari minimal dua sumber independen (mis. PetaBencana + ANTARA News).
                    </span>
                  </div>
                </label>

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
                className="modal-btn modal-btn--confirm"
                data-action="modal-confirm"
                disabled={submitting}
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

      <div className="review-footer" style={{ marginTop: "2rem" }}>
        <a className="text-link" href="#jelajah">
          Kembali ke jelajah
        </a>
        <span>MOD-01 diperlukan untuk autentikasi dan tindakan review.</span>
      </div>
    </main>
  );
}

function renderReadOnlyFixture(): React.JSX.Element {
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

export function ModeratorReview(props: ModeratorReviewProps = {}): React.JSX.Element {
  const isFixture =
    props.mode === "fixture" ||
    (typeof window === "undefined" && !props.proposals && props.mode !== "queue");

  if (isFixture) {
    return renderReadOnlyFixture();
  }

  return <ModeratorReviewQueue {...props} />;
}
