import type { SqlExecutor } from "../../../db/src/sql.js";
import type { WorkerEnvironment } from "../layers/l4-application-integration/api.js";
import type { TriageAuthorization } from "../layers/l1-data-knowledge/news-triage.js";
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
import { MODEL_TRIAGE_REUSE_TOKENS } from "../layers/l1-data-knowledge/news-triage.js";
export { MODEL_TRIAGE_REUSE_TOKENS, DESCRIPTION_REUSE_TOKENS } from "../layers/l1-data-knowledge/news-triage.js";

export function buildLiveTriageGate(env: WorkerEnvironment, executor: SqlExecutor): LiveTriageGate {
  const baseUrl = readCredential(env.NINEROUTER_URL, "NINEROUTER_URL");
  const apiKey = readCredential(env.NINEROUTER_KEY, "NINEROUTER_KEY");
  const chatModel =
    readCredential(env.NINEROUTER_CHAT_MODEL, "NINEROUTER_CHAT_MODEL", "ag/gemini-3.8-flash") ||
    "ag/gemini-3.8-flash";

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
          remit: string | null;
        }>(
          `SELECT approval_status, auto_acquisition_enabled, registry_status,
                  reuse_basis, remit
           FROM waspada.source_registry WHERE source_id = $1 LIMIT 1`,
          [sourceId],
        );
        const row = res.rows[0];
        if (!row) return { cleared: false, reason: "source_not_registered" };
        // Stage 1: acquisition approval.
        const acquired =
          row.approval_status === "approved" &&
          row.auto_acquisition_enabled === true &&
          row.registry_status === "active";
        if (!acquired) return { cleared: false, reason: "source_not_cleared" };
        // Stage 2: explicit model-use permission (ADR-005). Missing array,
        // unknown tokens, or DB shape errors fail closed to uncleared.
        const basis = Array.isArray(row.reuse_basis) ? row.reuse_basis : null;
        if (!basis) return { cleared: false, reason: "model_use_not_permitted" };
        const permitted = basis.some((token) =>
          typeof token === "string" && MODEL_TRIAGE_REUSE_TOKENS.has(token),
        );
        if (!permitted) return { cleared: false, reason: "model_use_not_permitted" };
        return { cleared: true, reuseBasis: [...basis] };
      } catch {
        return { cleared: false, reason: "source_not_cleared" };
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
