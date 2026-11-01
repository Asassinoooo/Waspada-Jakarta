import type { SqlExecutor } from "../../../db/src/sql.js";
import type { WorkerEnvironment } from "../layers/l4-application-integration/api.js";
import type {
  NewsTriageDecision,
  TriageAuthorization,
} from "../layers/l1-data-knowledge/news-triage.js";
import { evaluateSourcePermissions } from "../layers/l1-data-knowledge/news-triage.js";
export {
  TITLE_MODEL_TOKENS,
  DESCRIPTION_MODEL_TOKENS,
  TITLE_RETAIN_TOKENS,
  DESCRIPTION_RETAIN_TOKENS,
  DERIVED_RETAIN_TOKENS,
  PUBLIC_DISPLAY_TOKENS,
} from "../layers/l1-data-knowledge/news-triage.js";
import {
  readLatestAttemptForRevision,
  readTriageDecision,
} from "../../../db/src/news-triage-store.js";
import {
  applyTriageGate,
  type HeldTriageDecision,
  type StoredReportRevision,
} from "./news-poll-runtime.js";
/**
 * WJ-INT-02A live triage gate composition. Single shared source for all live
 * RSS paths (worker `scheduled()` cron and `tools/serve-live-pipeline.ts`).
 * Synthetic fixtures and unit tests keep using `createNewsPollRuntime`
 * without a gate; live ingestion MUST go through `buildLiveTriageGate`.
 */
export interface LiveTriageGate {
  readonly sourceRemit: string;
  readonly concurrency: number;
  readonly checkAuthorization: (sourceId: string) => Promise<TriageAuthorization>;
  readonly callChat?: (system: string, user: string) => Promise<unknown>;
  /**
   * WJ-INT-02B persistent idempotency: cached decision for an identical
   * (identity, content, policy) evaluation, or null. Never throws: lookup
   * misses and provider-budget state resolve to null/cached without gating.
   */
  readonly findPriorDecision: (key: {
    readonly itemIdentityHash: string;
    readonly contentHash: string;
    readonly policyVersion: string;
    /**
     * WJ-INT-02B content-version pin for the provider-error retry budget.
     * Revision ids bind content (§4), so the budget fires only when the
     * in-flight evaluation targets the exact revision the ledger rows describe.
     */
    readonly reportRevisionId?: string;
  }) => Promise<NewsTriageDecision | null>;
}

/**
 * Normalizes a NineRouter base URL into a chat-completions endpoint.
 * Strips trailing slashes; keeps a single existing `/v1` segment instead of
 * doubling it; then appends `/chat/completions`.
 */
export function triageChatEndpoint(baseUrl: string): string {
  const stripped = baseUrl.replace(/\/+$/, "");
  const withVersion = stripped.endsWith("/v1") ? stripped : `${stripped}/v1`;
  return `${withVersion}/chat/completions`;
}

function readCredential(envValue: string | undefined, processKey: string, fallback?: string): string {
  if (envValue && envValue.length > 0) return envValue;
  if (typeof process !== "undefined") {
    const fromProcess = (process as unknown as { env?: Record<string, string | undefined> }).env?.[processKey];
    if (fromProcess && fromProcess.length > 0) return fromProcess;
  }
  return fallback ?? "";
}

/**
 * Builds the live triage gate from Worker bindings first, local process env
 * second (local Node parity; env wins). Missing URL or key returns a chat-less
 * gate: Stage B items resolve `uncertain/provider_error`, never ingest.
 * Never throws for missing credentials.
 */
export function buildLiveTriageGate(env: WorkerEnvironment, executor: SqlExecutor): LiveTriageGate {
  const baseUrl = readCredential(env.NINEROUTER_URL, "NINEROUTER_URL");
  const apiKey = readCredential(env.NINEROUTER_KEY, "NINEROUTER_KEY");
  const chatModel =
    readCredential(env.NINEROUTER_CHAT_MODEL, "NINEROUTER_CHAT_MODEL", "Waspada-Jakarta") ||
    "Waspada-Jakarta";

  const gate: LiveTriageGate = {
    sourceRemit: "general news",
    concurrency: 4,
    checkAuthorization: async (sourceId: string) => {
      try {
        const res = await executor.query<{
          approval_status: string;
          auto_acquisition_enabled: boolean;
          registry_status: string;
          reuse_basis: readonly string[] | string | null;
          reuse_license_url: string | null;
          reuse_scope: string | null;
          reuse_reviewer: string | null;
          reuse_reviewed_at: string | null;
          reuse_expires_at: string | null;
          remit: string | null;
        }>(
          `SELECT approval_status, auto_acquisition_enabled, registry_status,
                  reuse_basis, reuse_license_url, reuse_scope, reuse_reviewer,
                  reuse_reviewed_at::text AS reuse_reviewed_at,
                  reuse_expires_at::text AS reuse_expires_at, remit
           FROM waspada.source_registry WHERE source_id = $1 LIMIT 1`,
          [sourceId],
        );
        const row = res.rows[0];
        if (!row) return { cleared: false, reason: "source_not_registered" };
        // WJ-INT-02B explicit capability evaluation (ADR-005). Acquisition is
        // the unchanged approval gate; model use additionally needs an
        // explicit title/description model token (or licensed legacy basis).
        const basis = Array.isArray(row.reuse_basis) ? row.reuse_basis : null;
        const permissions = evaluateSourcePermissions(
          {
            approval_status: row.approval_status,
            auto_acquisition_enabled: row.auto_acquisition_enabled,
            registry_status: row.registry_status,
            reuse_basis: basis,
            reuse_license_url: row.reuse_license_url,
            reuse_scope: row.reuse_scope,
            reuse_reviewer: row.reuse_reviewer,
            reuse_reviewed_at: row.reuse_reviewed_at,
            reuse_expires_at: row.reuse_expires_at,
          },
          new Date().toISOString(),
        );
        if (!permissions.acquisition) return { cleared: false, reason: "source_not_cleared" };
        if (!(permissions.titleModel || permissions.descriptionModel)) {
          return { cleared: false, reason: "model_use_not_permitted" };
        }
        return { cleared: true, reuseBasis: basis ? [...basis] : [], permissions };
      } catch {
        return { cleared: false, reason: "source_not_cleared" };
      }
    },
    findPriorDecision: async (key) => {
      try {
        // WJ-INT-02B live-only lookup ("live" literal): the composition gate
        // never runs for synthetic/historical datasets.
        const snapshot = await readTriageDecision(executor, "live", key.itemIdentityHash);
        if (!snapshot || snapshot.policyVersion !== key.policyVersion) return null;
        // WJ-INT-02B idempotency probes read the latest attempt for the
        // identity (not the snapshot revision): held snapshots carry no
        // revision linkage by design, and held attempts carry no content hash
        // (metadata-only). Both probes pin the version by revision id — which
        // binds content (§4) — instead of by content hash.
        const attemptForIdentity = await executor.query<{
          report_revision_id: string;
          disposition: string;
          jakarta_scope: string;
          actionability: string;
          primary_category: string | null;
          incident_type: string | null;
          confidence: string;
          reason_codes: readonly string[];
          policy_version: string;
          model_status: string;
        }>(
          `SELECT report_revision_id, disposition, jakarta_scope, actionability,
                  primary_category, incident_type, confidence, reason_codes,
                  policy_version, model_status
           FROM waspada.news_triage_attempts
           WHERE dataset_kind = 'live' AND item_identity_hash = $1
           ORDER BY evaluated_at DESC LIMIT 1`,
          [key.itemIdentityHash],
        );
        const latestIdentityAttempt = attemptForIdentity.rows[0] ?? null;
        const pinnedRevision =
          key.reportRevisionId !== undefined &&
          latestIdentityAttempt !== null &&
          key.reportRevisionId === latestIdentityAttempt.report_revision_id &&
          latestIdentityAttempt.policy_version === key.policyVersion
            ? latestIdentityAttempt
            : null;
        // Bounded provider-error retry (§5): three or more provider_error
        // attempts in the last 24h for this exact version exhaust the budget;
        // reuse the cached uncertain outcome with no new model call.
        if (pinnedRevision !== null && pinnedRevision.model_status === "provider_error") {
          const budgeted = await executor.query<{ count: string }>(
            `SELECT COUNT(*)::text AS count FROM waspada.news_triage_attempts
             WHERE dataset_kind = 'live' AND item_identity_hash = $1
               AND report_revision_id = $2 AND model_status = 'provider_error'
               AND evaluated_at > now() - interval '24 hours'`,
            [key.itemIdentityHash, pinnedRevision.report_revision_id],
          );
          if (Number(budgeted.rows[0]?.count ?? "0") >= 3) {
            return {
              disposition: "uncertain",
              jakartaScope: "unknown",
              actionability: "unknown",
              primaryCategory: null,
              incidentType: null,
              confidence: "low",
              reasonCodes: ["provider_error"],
              evidence: [],
              modelStatus: "provider_error",
            };
          }
          return null;
        }
        // Settled held replay: the latest evaluation of this exact version
        // already produced a final (non-provider-error) outcome — reuse it
        // with no new model call. The poller persists it as a replay without
        // new writes.
        if (
          pinnedRevision !== null &&
          (pinnedRevision.disposition === "drop" || pinnedRevision.disposition === "uncertain")
        ) {
          return {
            disposition: pinnedRevision.disposition,
            jakartaScope: pinnedRevision.jakarta_scope as NewsTriageDecision["jakartaScope"],
            actionability: pinnedRevision.actionability as NewsTriageDecision["actionability"],
            primaryCategory: pinnedRevision.primary_category,
            incidentType: pinnedRevision.incident_type,
            confidence: pinnedRevision.confidence as NewsTriageDecision["confidence"],
            reasonCodes: [...pinnedRevision.reason_codes],
            evidence: [],
            modelStatus: pinnedRevision.model_status as NewsTriageDecision["modelStatus"],
          };
        }
        const revisionId = snapshot.reportRevisionId;
        if (!revisionId) return null;
        const attempt = await readLatestAttemptForRevision(executor, "live", revisionId);
        if (!attempt) return null;
        if (
          attempt.contentHash !== key.contentHash ||
          attempt.disposition !== snapshot.disposition
        ) {
          return null;
        }
        const cached: NewsTriageDecision = {
          disposition: snapshot.disposition,
          jakartaScope: snapshot.jakartaScope,
          actionability: snapshot.actionability,
          primaryCategory: snapshot.primaryCategory,
          incidentType: snapshot.incidentType,
          confidence: snapshot.confidence,
          reasonCodes: [...snapshot.reasonCodes],
          evidence: [],
          modelStatus: snapshot.modelStatus,
        };
        return cached;
      } catch {
        // Lookup miss or gating error: never block ingestion on idempotency.
        return null;
      }
    },
  };

  if (!baseUrl || !apiKey) return gate;

  const endpoint = triageChatEndpoint(baseUrl);
  const callChat = async (system: string, user: string): Promise<unknown> => {
    let lastError: unknown = new Error("triage transport failed");
    for (let attempt = 0; attempt < 2; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15_000);
      try {
        const response = await fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({ model: chatModel, messages: [{ role: "system", content: system }, { role: "user", content: user }], stream: false }),
          signal: controller.signal,
        });
        if (!response.ok) throw new Error(`triage chat HTTP ${response.status}`);
        const envelope = (await response.json()) as unknown;
        if (!envelope || typeof envelope !== "object" || !("choices" in envelope)) {
          throw new Error("triage chat bad envelope");
        }
        const choices = (envelope as { choices: unknown }).choices;
        if (!Array.isArray(choices) || choices.length === 0) throw new Error("triage chat no choices");
        const first = choices[0] as { message?: { content?: unknown } };
        const content = first?.message?.content;
        if (typeof content !== "string" || content.length === 0) throw new Error("triage chat empty content");
        const start = content.indexOf("{");
        const end = content.lastIndexOf("}");
        if (start < 0 || end <= start) throw new Error("triage chat no JSON object");
        return JSON.parse(content.slice(start, end + 1)) as unknown;
      } catch (error) {
        lastError = error;
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastError;
  };

  return { ...gate, callChat };
}

/** Thin shared wrapper over the poller gate with live defaults. */
export function applyLiveTriageGate(
  stored: readonly StoredReportRevision[],
  classified: ReadonlyArray<{ guid: string; title: string; descriptionExcerpt: string | null; link: string; pubDate: string | null }>,
  feed: { url: string; sourceId: string; maxAgeHours?: number },
  retrievedAt: string,
  gate: LiveTriageGate,
): Promise<{ revisions: StoredReportRevision[]; held: readonly HeldTriageDecision[]; triageCounts: import("./news-poll-runtime.js").NewsTriageCounts }> {
  return applyTriageGate(stored, classified, feed, retrievedAt, gate);
}
