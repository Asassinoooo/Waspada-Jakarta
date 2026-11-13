import { createHash } from "node:crypto";
import { createPublicEventListRuntime } from "./runtime/public-event-list-runtime.js";
import { createPublicEventDetailRuntime } from "./runtime/public-event-detail-runtime.js";
import { createPublicEventHistoryRuntime } from "./runtime/public-event-history-runtime.js";
import { createPublicEventGeoJSONRuntime } from "./runtime/public-event-geojson-runtime.js";
import { createPublicBriefingRuntime } from "./runtime/public-briefing-runtime.js";
import { createPublicEventUpdatesRuntime } from "./runtime/public-event-updates-runtime.js";
import {
  handlePublicApiRequest,
  isPublicEventDetailPath,
  isPublicEventHistoryPath,
  type WorkerEnvironment,
} from "./layers/l4-application-integration/api.js";
import { consoleTelemetry } from "./layers/l5-evaluation-monitoring/telemetry.js";
import { handleSyntheticPollScheduleTrigger } from "./runtime/synthetic-poll-schedule-trigger.js";
import { handleSyntheticSourcePollProcessTrigger } from "./runtime/synthetic-source-poll-process-trigger.js";
import { handleFreshnessDueScheduleTrigger } from "./runtime/freshness-due-schedule-trigger.js";
import { createSourcePreviewHandler } from "./layers/l4-application-integration/source-preview-api.js";
import { createContextSourcesHandler } from "./layers/l4-application-integration/context-sources-api.js";
import { handleAccountRequest, type AccountRuntimeConfig } from "./runtime/account-runtime.js";
import { createModerationApiHandler, type EventProposalDto, type StoredEvidenceChunk } from "./layers/l4-application-integration/moderation-api.js";
import { createSourceApprovalApiHandler, isSourceApprovalPath } from "./layers/l4-application-integration/source-approval-api.js";
import {
  AGENT_AUTO_PUBLISHER_ID,
  decideProposal,
  submitEventCorrection,
  withdrawPublishedEvent,
} from "./layers/l4-application-integration/proposal-publication.js";
import { parseAutoPublishSourcePermission } from "./layers/l4-application-integration/publication-policy.js";
import { moderationAccountConfig, moderatorSurfaceDenial, readModeratorPrincipal } from "./runtime/moderator-session.js";
import { checkServiceKey } from "./security/service-key.js";
import { type StoredReportRevision, generateProposalFromReport } from "./layers/l2-model-grounding/proposal-engine.js";
import { generateCorrelatedProposal } from "./layers/l2-model-grounding/correlated-proposal-engine.js";
import { createPetaBencanaPollRuntime } from "./runtime/petabencana-poll-runtime.js";
import { createBmkgPollRuntime } from "./runtime/bmkg-poll-runtime.js";
import { createLiveNewsPollRuntime, DEFAULT_NEWS_FEEDS } from "./runtime/news-poll-runtime.js";
import { TRIAGE_POLICY_VERSION, evaluateSourcePermissions } from "./layers/l1-data-knowledge/news-triage.js";
import { buildLiveTriageGate } from "./runtime/news-triage-composition.js";
import { readUncertainTriage, markTriageReviewed } from "../../db/src/news-triage-store.js";
import { runGatedRssCycle } from "./runtime/gated-rss-persistence.js";

import { eventBroadcaster, createSSEResponse } from "./layers/l4-application-integration/event-broadcaster.js";
import { createWebhookIngestHandler, isWebhookIngestPath } from "./layers/l1-data-knowledge/webhook-ingest.js";
import { withPostgresSqlExecutor, withPostgresTransactionalSqlExecutor } from "../../db/src/postgres-sql-executor.js";
import { createSqlIncidentRepository } from "../../db/src/incident-repository.js";
import { createEventProposalWriter } from "../../db/src/event-proposal-writer.js";
import { createSourceApprovalStore } from "../../db/src/source-approval-store.js";
import type { DatasetKind } from "../../db/src/ports.js";
import type { SqlExecutor, TransactionalSqlExecutor } from "../../db/src/sql.js";
const sourcePreviewHandler = createSourcePreviewHandler({ incremental: true });
const contextSourcesHandler = createContextSourcesHandler();
import { createEmbeddingVisualizationHandler } from "./layers/l4-application-integration/embedding-visualization-handler.js";
import { createPipelineFlowHandler, PIPELINE_FLOW_ROUTE_PATH } from "./layers/l4-application-integration/pipeline-flow-api.js";
import { demoPipelineFlowItems, demoPipelineFlowSnapshotSource } from "./layers/l4-application-integration/pipeline-flow-fixtures.js";
import { runScheduledReviewExpiry } from "./runtime/review-expiry-runtime.js";

const activeRevisions = new Map<string, StoredReportRevision>();
const activeProposals = new Map<string, EventProposalDto>();
const activeChunks = new Map<string, readonly StoredEvidenceChunk[]>();

// F-03: the L1 webhook path receives its L2 proposal engines and L4 broadcaster here.
const webhookIngest = createWebhookIngestHandler({
  directProposal: generateProposalFromReport,
  correlatedProposal: generateCorrelatedProposal,
  broadcaster: eventBroadcaster,
  onRevisionCreated: (revision) => {
    activeRevisions.set(revision.report_revision_id, revision);
  },
});

// WJ-INT-02A: live RSS triage flows only through `buildLiveTriageGate`.
// Structured feeds (PetaBencana, BMKG) bypass the news gate; only general
// news/RSS does. The legacy ungated startup sync and inline chat builder
// were removed: `buildScheduledTriageChat` moved to
// `runtime/news-triage-composition.ts`; `syncLivePipelineProposals` only
// warmed an in-memory map no read path consults after the DB cutover.
// Webhook ingestion is unaffected.
async function withSqlExecutor<Result>(
  env: WorkerEnvironment,
  operation: (executor: SqlExecutor) => Promise<Result>,
): Promise<Result> {
  if (env.SQL_EXECUTOR) {
    return operation(env.SQL_EXECUTOR);
  }
  if (env.HYPERDRIVE?.connectionString) {
    return withPostgresSqlExecutor(env.HYPERDRIVE.connectionString, operation);
  }
  throw new Error("No database executor or connection string configured in environment");
}

async function withTransactionalSqlExecutor<Result>(
  env: WorkerEnvironment,
  operation: (executor: TransactionalSqlExecutor) => Promise<Result>,
): Promise<Result> {
  if (env.SQL_EXECUTOR) {
    // WJ-INT-02B fail closed: accepted RSS persistence is only correct inside
    // a real transaction. Never degrade to a bare pooled executor here.
    const candidate = env.SQL_EXECUTOR as Partial<TransactionalSqlExecutor>;
    if (typeof candidate.transaction !== "function") {
      throw new Error("accepted RSS persistence requires a transaction-capable executor");
    }
    return operation(env.SQL_EXECUTOR as unknown as TransactionalSqlExecutor);
  }
  if (env.HYPERDRIVE?.connectionString) {
    return withPostgresTransactionalSqlExecutor(env.HYPERDRIVE.connectionString, operation);
  }
  throw new Error("No database executor or connection string configured in environment");
}
const embeddingVisualizationHandler = createEmbeddingVisualizationHandler({
  executorRunner: withSqlExecutor,
});
// FLOW-VIS-01: moderator-only pipeline flow. Demo mode answers from the fixture; live mode reads one
// read-only transaction under the flow reader role.
const pipelineFlowHandler = createPipelineFlowHandler({
  withTransactionalSqlExecutor,
  demo: {
    snapshot: (now) => demoPipelineFlowSnapshotSource(now),
    items: (input) => demoPipelineFlowItems(input),
  },
});

/**
 * WJ-INT-02B public-display rights gate: live registry permissions for one source. Fail-closed:
 * a missing row, an error or a denied capability denies publication. No approval overrides it.
 */
async function checkSourcePublicDisplay(env: WorkerEnvironment, sourceId: string): Promise<boolean> {
  if (!(env.SQL_EXECUTOR || env.HYPERDRIVE?.connectionString)) return false;
  try {
    return await withSqlExecutor(env, async (executor) => {
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
      }>(
        `SELECT approval_status, auto_acquisition_enabled, registry_status,
                reuse_basis, reuse_license_url, reuse_scope, reuse_reviewer,
                reuse_reviewed_at::text AS reuse_reviewed_at,
                reuse_expires_at::text AS reuse_expires_at
         FROM waspada.source_registry WHERE source_id = $1 LIMIT 1`,
        [sourceId],
      );
      const row = res.rows[0];
      if (!row) return false;
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
        sourceId,
      );
      return permissions.publicDisplay === true;
    });
  } catch {
    return false;
  }
}

/**
 * FR-12 admin source approval (TEST-GAP-02 / T10b): administrators only. Registry writes run on the same
 * server-selected database path as moderator publication, in one transaction with the trace and audit row.
 */
function getSourceApprovalHandler(env: WorkerEnvironment, config: AccountRuntimeConfig) {
  const datasetKind = config.datasetKind as DatasetKind;
  return createSourceApprovalApiHandler({
    authenticate: (request: Request) => readModeratorPrincipal(request, config),
    withStore: (work) => withTransactionalSqlExecutor(env, (executor) => work(createSourceApprovalStore(executor, datasetKind))),
    appOrigin: config.appOrigin,
    datasetScope: config.datasetKind,
  });
}

function getModerationHandler(env: WorkerEnvironment, config: AccountRuntimeConfig) {
  // The DB dataset comes from the same server-side configuration that scopes the sessions.
  const datasetKind = config.datasetKind as DatasetKind;
  return createModerationApiHandler({
    listPendingProposals: async () => {
      if (env.SQL_EXECUTOR || env.HYPERDRIVE?.connectionString) {
        return withSqlExecutor(env, async (executor) => {
          const writer = createEventProposalWriter(executor);
          return writer.readPendingProposals(datasetKind);
        });
      }
      return Array.from(activeProposals.values());
    },
    listUncertainTriage: async ({ limit }: { limit?: number } = {}) => {
      if (!(env.SQL_EXECUTOR || env.HYPERDRIVE?.connectionString)) return [];
      return withSqlExecutor(env, async (executor) => {
        const rows = await readUncertainTriage(executor, datasetKind, limit ?? 100);
        return rows.map((row) => ({
          source_id: row.sourceId,
          item_identity_hash: row.itemIdentityHash,
          disposition: row.disposition,
          jakarta_scope: row.jakartaScope,
          actionability: row.actionability,
          primary_category: row.primaryCategory,
          incident_type: row.incidentType,
          confidence: row.confidence,
          reason_codes: [...row.reasonCodes],
          model_status: row.modelStatus,
          policy_version: row.policyVersion,
          evaluated_at: row.evaluatedAt,
          reviewed_at: row.reviewedAt,
          reviewed_by: row.reviewedBy,
        }));
      });
    },
    markTriageReviewed: async (itemIdentityHash: string, actorId: string) => {
      if (!(env.SQL_EXECUTOR || env.HYPERDRIVE?.connectionString)) return false;
      return withSqlExecutor(env, (executor) => markTriageReviewed(executor, datasetKind, itemIdentityHash, actorId));
    },
    // WJ-INT-02B: live public-display rights check against current registry
    // permissions. Fail-closed: missing row, error, or denied capability
    // denies publication. Moderator approval never overrides this.
    checkPublicDisplay: (sourceId: string) => checkSourcePublicDisplay(env, sourceId),
    getProposalDetail: async (id: string) => {
      if (env.SQL_EXECUTOR || env.HYPERDRIVE?.connectionString) {
        return withSqlExecutor(env, async (executor) => {
          const writer = createEventProposalWriter(executor);
          const proposal = await writer.readProposalById(id, datasetKind);
          if (!proposal) return null;
          const chunkRes = await executor.query<{
            chunk_id: string;
            span_start: number;
            span_end: number;
            text: string;
          }>(
            `SELECT ec.chunk_id, ec.span_start, ec.span_end,
                    substr(r.permitted_text, ec.span_start + 1, ec.span_end - ec.span_start) AS text
             FROM waspada.evidence_chunks ec
             JOIN waspada.report_revisions r
               ON r.dataset_kind = ec.dataset_kind AND r.report_revision_id = ec.report_revision_id
             WHERE ec.dataset_kind = $1
               AND ec.chunk_id = ANY(
                 SELECT claim_json->>'evidence_ref_id'
                 FROM waspada.event_proposals ep,
                      jsonb_array_elements(ep.record_json->'claims') AS claim_json
                 WHERE ep.dataset_kind = $1 AND ep.proposal_id = $2
               )`,
            [datasetKind, id],
          );
          return {
            proposal,
            chunks: chunkRes.rows.map((r, idx) => ({
              chunk_index: idx,
              span_start: r.span_start,
              span_end: r.span_end,
              text: r.text || "",
            })),
          };
        });
      }
      const prop = activeProposals.get(id);
      if (!prop) return null;
      return { proposal: prop, chunks: activeChunks.get(id) ?? [] };
    },
    // Real cookie session from the account store. A database failure throws and maps to 503.
    authenticate: (request: Request) => readModeratorPrincipal(request, config),
    appOrigin: config.appOrigin,
    cookieMode: config.cookieMode,
    datasetScope: config.datasetKind,
    csrfProtection: true,
    rejectProposal: async (proposalId: string, _command, principal) => {
      if (!(env.SQL_EXECUTOR || env.HYPERDRIVE?.connectionString)) {
        return { status: "denied", code: "proposal_unavailable" };
      }
      const outcome = await withSqlExecutor(env, (executor) => decideProposal(
        {
          executor,
          datasetKind: datasetKind as "live" | "historical" | "synthetic",
          checkPublicDisplay: (sourceId: string) => checkSourcePublicDisplay(env, sourceId),
        },
        {
          proposalId,
          action: "reject",
          actor: { kind: "moderator", actorId: principal.actorId },
        },
      ));
      if (outcome.status === "rejected") return { status: "rejected" };
      if (outcome.status === "already_decided") return { status: "already_decided" };
      return { status: "denied", code: outcome.status === "denied" ? outcome.code : "publication_failed" };
    },
    // TG-FR12: a moderator withdraws a published event. One transaction writes the withdrawn version, its decision and
    // its audit record. Public reads drop the event on their own, and the in-memory model drops it after COMMIT.
    withdrawEvent: async (eventId: string, command, principal) => {
      if (!(env.SQL_EXECUTOR || env.HYPERDRIVE?.connectionString)) {
        return { status: "denied", code: "withdrawal_failed" };
      }
      const outcome = await withSqlExecutor(env, (executor) => withdrawPublishedEvent(
        {
          executor,
          datasetKind: datasetKind as "live" | "historical" | "synthetic",
          checkPublicDisplay: (sourceId: string) => checkSourcePublicDisplay(env, sourceId),
        },
        {
          eventId,
          actorId: principal.actorId,
          reasonCategory: command.reason_category,
          reason: command.reason,
        },
      ));
      if (outcome.status === "withdrawn") {
        eventBroadcaster.broadcastPublic("event_withdrawn", { event_id: outcome.eventId, version: outcome.version });
        eventBroadcaster.broadcastModeration("event_withdrawn", { event_id: outcome.eventId, version: outcome.version });
        return {
          status: "withdrawn",
          event_id: outcome.eventId,
          version: outcome.version,
          decision_id: outcome.decisionId,
          withdrawn_at: outcome.withdrawnAt,
          withdrawal_reason: outcome.reasonCategory,
        };
      }
      if (outcome.status === "already_withdrawn") {
        return { status: "already_withdrawn", event_id: outcome.eventId, version: outcome.version };
      }
      if (outcome.code === "event_not_found") return { status: "not_found" };
      return { status: "denied", code: outcome.code };
    },
    // TG-FR12: a moderator correction is a stored proposal decided through the same gate, with the moderator
    // gate (time and source checks) applied. A refusal publishes nothing and is returned with its reasons.
    submitCorrection: async (eventId: string, command, principal) => {
      if (!(env.SQL_EXECUTOR || env.HYPERDRIVE?.connectionString)) {
        return { status: "refused", code: "publication_failed", reasons: [] };
      }
      const outcome = await withSqlExecutor(env, (executor) => submitEventCorrection(
        {
          executor,
          datasetKind: datasetKind as "live" | "historical" | "synthetic",
          checkPublicDisplay: (sourceId: string) => checkSourcePublicDisplay(env, sourceId),
        },
        {
          eventId,
          baseVersion: command.base_version,
          actorId: principal.actorId,
          edits: {
            ...(command.title !== undefined ? { title: command.title } : {}),
            ...(command.category !== undefined ? { category: command.category } : {}),
            ...(command.event_time !== undefined ? { eventTime: command.event_time } : {}),
            ...(command.location_label !== undefined ? { locationLabel: command.location_label } : {}),
            ...(command.claims !== undefined
              ? { claims: command.claims.map((edit) => ({ claimId: edit.claim_id, text: edit.claim_text })) }
              : {}),
          },
          reason: command.reason ?? null,
        },
      ));
      if (outcome.status === "published" || outcome.status === "unchanged") {
        if (outcome.status === "published") {
          eventBroadcaster.broadcastPublic("event_updated", { event_id: outcome.eventId, version: outcome.version });
        }
        return {
          status: outcome.status,
          event_id: outcome.eventId,
          version: outcome.version,
          proposal_id: outcome.proposalId,
          decision_id: outcome.decisionId,
        };
      }
      if (outcome.status === "invalid") return { status: "invalid", code: outcome.code };
      if (outcome.status === "refused" && outcome.code === "event_not_found") return { status: "not_found" };
      if (outcome.status === "refused") {
        return { status: "refused", code: outcome.code, reasons: [...outcome.reasons], proposal_id: outcome.proposalId };
      }
      return { status: "refused", code: "publication_failed", reasons: [] };
    },
    // MERGE-REVIEW-01: moderator publication uses the same writer and gate as the agent auto-publisher.
    publisher: {
      publish: async (input: unknown) => {
        const cmd = typeof input === "object" && input !== null
          ? (input as { proposal_id?: string; proposalId?: string; actorId?: string; decision?: { proposal_id?: string } })
          : {};
        const id = cmd.proposal_id ?? cmd.proposalId ?? cmd.decision?.proposal_id;
        const actorId = cmd.actorId;
        if (!id || typeof actorId !== "string" || actorId.length === 0) {
          return { status: "denied", code: "proposal_not_found" };
        }
        if (!(env.SQL_EXECUTOR || env.HYPERDRIVE?.connectionString)) {
          return { status: "denied", code: "proposal_unavailable" };
        }
        const outcome = await withSqlExecutor(env, (executor) => decideProposal(
          {
            executor,
            datasetKind: datasetKind as "live" | "historical" | "synthetic",
            checkPublicDisplay: (sourceId: string) => checkSourcePublicDisplay(env, sourceId),
          },
          {
            proposalId: id,
            action: "publish",
            actor: { kind: "moderator", actorId },
          },
        ));
        if (outcome.status === "published") {
          eventBroadcaster.broadcastPublic("event_published", { event_id: outcome.eventId, version: outcome.version });
          eventBroadcaster.broadcastModeration("proposal_published", { proposal_id: id });
          return { status: "written", receipt: { decision_id: outcome.decisionId } };
        }
        // F-ALERT-01: the facts are already public at this version. Nothing new is published and no alert is sent.
        if (outcome.status === "unchanged") {
          return {
            status: "unchanged",
            receipt: { decision_id: outcome.decisionId },
            event_id: outcome.eventId,
            version: outcome.version,
          };
        }
        if (outcome.status === "already_decided") {
          return { status: "conflict", code: "ALREADY_DECIDED" };
        }
        if (outcome.status === "denied") {
          if (outcome.code === "publication_failed") return { status: "denied", code: "writer_failed" };
          return { status: "denied", code: outcome.code };
        }
        return { status: "denied", code: "publication_not_authorized" };
      },
    },
  });
}
function unavailableJson(): Response {
  return new Response(JSON.stringify({
    code: "TEMPORARILY_UNAVAILABLE",
    message: "This service requires an account database for this route.",
    request_id: crypto.randomUUID(),
  }), {
    status: 503,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

/** Machine routes: 503 when the key is not configured, 401 on any mismatch. */
async function serviceKeyDenial(request: Request, configuredKey: string | undefined): Promise<Response | null> {
  const decision = await checkServiceKey(request, configuredKey);
  if (decision === "authorized") return null;
  const status = decision === "unconfigured" ? 503 : 401;
  const code = decision === "unconfigured" ? "TEMPORARILY_UNAVAILABLE" : "UNAUTHORIZED";
  return new Response(JSON.stringify({ ok: false, code, error: code }), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

export default {
  async fetch(request: Request, env: WorkerEnvironment, ctx?: { waitUntil?: (promise: Promise<unknown>) => void }): Promise<Response> {
    const url = new URL(request.url);

    // Inbound incident webhook push. Requires the shared webhook key; 503 when none is configured.
    if (isWebhookIngestPath(url.pathname)) {
      const denied = await serviceKeyDenial(request, env.WEBHOOK_SERVICE_KEY);
      if (denied) return denied;
      const response = await webhookIngest(request);
      if (response.ok && (env.SQL_EXECUTOR || env.HYPERDRIVE?.connectionString)) {
        try {
          const resBody = (await response.clone().json().catch(() => null)) as {
            report_revision_id?: string;
            report_revisions?: string[];
          } | null;
          const revIds: string[] = resBody?.report_revisions ?? (resBody?.report_revision_id ? [resBody.report_revision_id] : []);
          if (revIds.length > 0) {
            const enqueuePromise = withSqlExecutor(env, async (executor) => {
              const datasetKind = ((env.DATASET_MODE as string) || "live") as DatasetKind;
              const repo = createSqlIncidentRepository(executor);
              for (const revId of revIds) {
                const rev = activeRevisions.get(revId);
                if (rev) {
                  const traceId = (rev as any).trace_id || `trace-${rev.report_revision_id}`;
                  const contentHash = (rev as any).content_hash || rev.permitted_text_hash;

                  // Ensure trace and source exist for foreign keys
                  await executor.query(
                    `INSERT INTO waspada.traces (trace_id, dataset_kind, started_at, outcome, metadata)
                     VALUES ($1, $2, now(), 'succeeded', '{}'::jsonb)
                     ON CONFLICT (trace_id, dataset_kind) DO NOTHING`,
                    [traceId, datasetKind],
                  );
                  await executor.query(
                    `INSERT INTO waspada.source_registry (
                       source_id, trace_id, registry_version, display_name, source_kind, remit,
                       access_method, approved_hosts, access_restrictions, reuse_basis, registry_status,
                       approval_status, health_status, auto_acquisition_enabled, auto_publication_policy
                     )
                     VALUES ($1, $2, 1, $3, 'authority', ARRAY['all'], 'manual_fixture',
                             ARRAY[]::text[], ARRAY[]::text[], ARRAY['public'], 'active', 'approved', 'healthy', false, 'never')
                     ON CONFLICT (source_id) DO NOTHING`,
                    [rev.source_id, traceId, rev.source_id],
                  );

                  // Persist revision
                  await executor.query(
                    `INSERT INTO waspada.report_revisions (
                       dataset_kind, report_revision_id, trace_id, source_id, canonical_url,
                       content_hash, permitted_text, permitted_text_hash, normalization_version,
                       retrieved_at, revision_status, record_json, triage_required
                     )
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'v1', $9, 'unreviewed', '{}'::jsonb, false)
                     ON CONFLICT (dataset_kind, report_revision_id) DO NOTHING`,
                    [
                      datasetKind,
                      rev.report_revision_id,
                      traceId,
                      rev.source_id,
                      rev.canonical_url,
                      contentHash,
                      rev.permitted_text,
                      rev.permitted_text_hash,
                      rev.retrieved_at,
                    ],
                  );
                  // Persist chunks
                  for (const chk of rev.chunks) {
                    const chunkTextHash = createHash("sha256").update(chk.text).digest("hex");
                    await executor.query(
                      `INSERT INTO waspada.evidence_chunks (
                         dataset_kind, chunk_id, trace_id, report_revision_id, permitted_text_hash,
                         span_start, span_end, offset_unit, chunker_version, chunk_text_hash, status
                       )
                       VALUES ($1, $2, $3, $4, $5, $6, $7, 'unicode_code_points', 'v1', $8, 'active')
                       ON CONFLICT (dataset_kind, chunk_id) DO NOTHING`,
                      [
                        datasetKind,
                        `chk-${rev.report_revision_id}-${chk.chunk_index}`,
                        traceId,
                        rev.report_revision_id,
                        rev.permitted_text_hash,
                        chk.span_start,
                        chk.span_end,
                        chunkTextHash,
                      ],
                    );
                  }
                }
                await repo.enqueueAiJob({
                  jobId: `job-${crypto.randomUUID()}`,
                  datasetKind,
                  reportRevisionId: revId,
                  traceId: (rev as any)?.trace_id,
                }).catch(() => {});
              }
            });
            if (ctx?.waitUntil) {
              ctx.waitUntil(enqueuePromise);
            } else {
              await enqueuePromise;
            }
          }
        } catch (err) {
          console.error("Error enqueuing AI jobs for webhook:", err);
        }
      }
      return response;
    }

    // MERGE-REVIEW-01: the intelligence worker notifies each completed proposal here. The L4 gate
    // decides: publish when every automatic check passes, otherwise queue it for a moderator.
    if (url.pathname === "/api/v1/internal/proposals" && request.method === "POST") {
      const denied = await serviceKeyDenial(request, env.INTERNAL_SERVICE_KEY);
      if (denied) return denied;
      let body: { proposal_id?: unknown };
      try {
        body = (await request.json()) as { proposal_id?: unknown };
      } catch {
        return new Response(JSON.stringify({ code: "INVALID_JSON", message: "Body must be JSON" }), {
          status: 400,
          headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
        });
      }
      if (typeof body?.proposal_id !== "string" || body.proposal_id.length === 0) {
        return new Response(JSON.stringify({ code: "INVALID_PROPOSAL", message: "proposal_id is required" }), {
          status: 400,
          headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
        });
      }
      if (!(env.SQL_EXECUTOR || env.HYPERDRIVE?.connectionString)) return unavailableJson();
      const proposalId = body.proposal_id;
      const config = moderationAccountConfig(env);
      if (!config) return unavailableJson();
      const outcome = await withSqlExecutor(env, (executor) => decideProposal(
        {
          executor,
          datasetKind: config.datasetKind as "live" | "historical" | "synthetic",
          checkPublicDisplay: (sourceId: string) => checkSourcePublicDisplay(env, sourceId),
        },
        {
          proposalId,
          action: "auto_publish",
          actor: { kind: "agent", actorId: AGENT_AUTO_PUBLISHER_ID },
          sourcePermission: parseAutoPublishSourcePermission(env.AUTO_PUBLISH_SOURCE_PERMISSION),
        },
      ));
      if (outcome.status === "published") {
        eventBroadcaster.broadcastPublic("event_published", { event_id: outcome.eventId, version: outcome.version });
        eventBroadcaster.broadcastModeration("proposal_published", { proposal_id: proposalId });
      } else if (outcome.status === "queued") {
        eventBroadcaster.broadcastModeration("proposal_created", { proposal_id: proposalId });
      }
      return new Response(JSON.stringify({ ok: true, proposal_id: proposalId, status: outcome.status, ...(outcome.status === "queued" ? { reasons: outcome.reasons } : {}), ...(outcome.status === "published" || outcome.status === "unchanged" ? { event_id: outcome.eventId, version: outcome.version } : {}) }), {
        status: 200,
        headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
      });
    }

    // Realtime SSE streaming for moderation queue: moderator or admin session only.
    if (url.pathname === "/api/v1/moderation/stream" || url.pathname === "/api/v1/moderation/stream/") {
      const denied = await moderatorSurfaceDenial(request, moderationAccountConfig(env), "review_evidence");
      if (denied) return denied;
      return createSSEResponse(eventBroadcaster.subscribeModeration(request.signal));
    }

    // Realtime SSE streaming for public events
    if (url.pathname === "/api/v1/events/stream" || url.pathname === "/api/v1/events/stream/") {
      return createSSEResponse(eventBroadcaster.subscribePublicEvents(request.signal));
    }

    const accountResponse = await handleAccountRequest(request, env);
    if (accountResponse !== undefined) return accountResponse;
    if (url.pathname.startsWith("/api/v1/moderation/")) {
      // Moderation never falls back to open access: without accounts it is unavailable.
      const config = moderationAccountConfig(env);
      if (!config) return unavailableJson();
      try {
        const modRes = await getModerationHandler(env, config)(request);
        if (modRes !== undefined) return modRes;
      } catch {
        return unavailableJson();
      }
    }
    if (isSourceApprovalPath(url.pathname)) {
      // Source approval is administrator-only and never falls back to open access.
      const config = moderationAccountConfig(env);
      if (!config) return unavailableJson();
      try {
        const sourceRes = await getSourceApprovalHandler(env, config)(request);
        if (sourceRes !== undefined) return sourceRes;
      } catch {
        return unavailableJson();
      }
    }
    if (url.pathname === "/api/v1/demo/context-sources") {
      return contextSourcesHandler(request, env);
    }
    if (url.pathname === "/api/v1/demo/source-preview") {
      return sourcePreviewHandler(request, env);
    }
    if (url.pathname === "/api/v1/embeddings/visualization") {
      // Chunk-level evidence text is moderator-only; the dataset comes from server configuration.
      const denied = await moderatorSurfaceDenial(request, moderationAccountConfig(env), "review_evidence");
      if (denied) return denied;
      return embeddingVisualizationHandler(request, env);
    }
    // FLOW-VIS-01: the live pipeline view is closed to everyone but moderators and admins, in demo mode too.
    if (url.pathname === PIPELINE_FLOW_ROUTE_PATH || url.pathname.startsWith(`${PIPELINE_FLOW_ROUTE_PATH}/`)) {
      const config = moderationAccountConfig(env);
      const denied = await moderatorSurfaceDenial(request, config, "review_evidence");
      if (denied) return denied;
      return pipelineFlowHandler(request, env, (config?.datasetKind ?? "live") as DatasetKind);
    }
    const eventListPageService =
      env.DATASET_MODE === "live"
        && request.method === "GET"
        && url.pathname === "/api/v1/events"
        ? await createPublicEventListRuntime({
          datasetMode: env.DATASET_MODE,
          connectionString: env.HYPERDRIVE?.connectionString,
          cursorHmacKeyHex: env.PUBLIC_EVENT_LIST_CURSOR_HMAC_KEY_HEX,
        })
        : undefined;
    const eventDetailProjectionService =
      env.DATASET_MODE === "live"
        && request.method === "GET"
        && isPublicEventDetailPath(url.pathname)
        ? createPublicEventDetailRuntime({
          datasetMode: env.DATASET_MODE,
          connectionString: env.HYPERDRIVE?.connectionString,
        })
        : undefined;
    const eventHistoryProjectionService =
      env.DATASET_MODE === "live"
        && request.method === "GET"
        && isPublicEventHistoryPath(url.pathname)
        ? createPublicEventHistoryRuntime({
          datasetMode: env.DATASET_MODE,
          connectionString: env.HYPERDRIVE?.connectionString,
        })
        : undefined;
    const eventGeoJSONRuntime =
      env.DATASET_MODE === "live"
        && request.method === "GET"
        && url.pathname === "/api/v1/events.geojson"
        ? createPublicEventGeoJSONRuntime({
          datasetMode: env.DATASET_MODE,
          connectionString: env.HYPERDRIVE?.connectionString,
        })
        : undefined;
    const publicBriefingRuntime =
      env.DATASET_MODE === "live"
        && request.method === "POST"
        && url.pathname === "/api/v1/briefings"
        ? createPublicBriefingRuntime({
          datasetMode: env.DATASET_MODE,
          connectionString: env.HYPERDRIVE?.connectionString,
        })
        : undefined;
    let publicEventUpdatesRuntime;
    if (env.DATASET_MODE === "live"
      && request.method === "GET"
      && url.pathname === "/api/v1/updates") {
      try {
        publicEventUpdatesRuntime = await createPublicEventUpdatesRuntime({
          datasetMode: env.DATASET_MODE,
          connectionString: env.HYPERDRIVE?.connectionString,
          cursorHmacKeyHex: env.PUBLIC_EVENT_LIST_CURSOR_HMAC_KEY_HEX,
        });
      } catch {
        publicEventUpdatesRuntime = undefined;
      }
    }

    return handlePublicApiRequest(
      request,
      env,
      consoleTelemetry,
      eventListPageService,
      eventDetailProjectionService,
      eventHistoryProjectionService,
      eventGeoJSONRuntime,
      publicBriefingRuntime,
      publicEventUpdatesRuntime,
    );
  },
  async scheduled(
    controller: { readonly scheduledTime: number },
    env: WorkerEnvironment,
  ): Promise<void> {
    await handleSyntheticPollScheduleTrigger(controller.scheduledTime, env);
    await handleSyntheticSourcePollProcessTrigger(
      controller.scheduledTime,
      env,
      { telemetry: consoleTelemetry },
    );
    await handleFreshnessDueScheduleTrigger(controller.scheduledTime, env, undefined, consoleTelemetry);
    // REVIEW-EXPIRY-01 (ADR-062): live only. Its own try/catch, so an ingestion failure below cannot skip it.
    try {
      const expiry = await runScheduledReviewExpiry({
        env,
        now: new Date(controller.scheduledTime),
        withSqlExecutor: (operation) => withSqlExecutor(env, operation),
      });
      if (expiry.ran && (expiry.expired > 0 || expiry.skipped_already_decided > 0 || expiry.failed > 0)) {
        console.log(
          `[Review] expired ${expiry.expired} proposals past the ${expiry.ttl_hours}h review window ` +
          `(skipped_already_decided=${expiry.skipped_already_decided} failed=${expiry.failed})`,
        );
      }
    } catch {
      console.warn("[Review] expiry sweep failed");
    }
    try {
      const pbRunner = createPetaBencanaPollRuntime();
      const pbResult = await pbRunner.poll(controller.scheduledTime);
      const bmkgRunner = createBmkgPollRuntime();
      const bmkgResult = await bmkgRunner.poll();
      if (!(env.SQL_EXECUTOR || env.HYPERDRIVE?.connectionString)) return;
      await withSqlExecutor(env, async (executor) => {
        const datasetKind = ((env.DATASET_MODE as string) || "live") as DatasetKind;
        const repo = createSqlIncidentRepository(executor);
        // WJ-INT-02A: one shared composition for all live RSS paths. Missing
        // credentials yield a chat-less gate (uncertain, never ingest).
        const gate = buildLiveTriageGate(env, executor);
        const newsRunner = createLiveNewsPollRuntime({
          feeds: DEFAULT_NEWS_FEEDS,
          triage: gate,
        });
        const newsResult = await newsRunner.poll();
      if (newsResult.triageCounts) {
        const c = newsResult.triageCounts;
        console.log(
          `[news-triage] discovered=${c.total} ingested=${c.ingested} dropped=${c.dropped} uncertain=${c.uncertain} ` +
          `authz_rejected=${c.authzRejected} geo_rejected=${c.geoRejected} non_actionable=${c.nonActionable} ` +
          `provider_failures=${c.providerFailures} rate_limited=${c.rateLimited} rate_limit_deferred=${c.rateLimitDeferred} by_category=${JSON.stringify(c.byCategory)} ` +
          `det_considered=${c.detConsidered} det_candidate=${c.detCandidate} det_ambiguous=${c.detAmbiguous} ` +
          `det_low_signal=${c.detLowSignal} det_broad_only=${c.detBroadOnly} det_specific=${c.detSpecific} ` +
          `det_strong=${c.detStrong} det_supporting=${c.detSupporting} det_alert_only=${c.detAlertOnly} ` +
          `det_non_scene=${c.detNonScene} det_unknown_role=${c.detUnknownRole} ` +
          `det_model_calls_skipped=${c.detModelCallsSkipped} det_rule=${c.detRuleVersion} ` +
          `det_gazetteer=${c.detGazetteerVersion} det_lexicon=${c.detLexiconVersion}`,
        );
      }
      // WJ-INT-02A: revisions are ingest-only; held carries drop/uncertain
      // metadata (no content). Structured authoritative feeds (PetaBencana,
      // BMKG) bypass the news gate.
      const structuredRevisions = [...pbResult.revisions, ...bmkgResult.revisions];
      let persistFailures = 0;
      for (const rev of structuredRevisions) {
        const revRecord: Record<string, unknown> =
          rev !== null && typeof rev === "object" ? (rev as unknown as Record<string, unknown>) : {};
        const traceId = typeof revRecord.trace_id === "string" ? revRecord.trace_id : `trace-${rev.report_revision_id}`;
        const contentHash = typeof revRecord.content_hash === "string" ? revRecord.content_hash : rev.permitted_text_hash;
        await executor.query(
          `INSERT INTO waspada.traces (trace_id, dataset_kind, started_at, outcome, metadata)
           VALUES ($1, $2, now(), 'succeeded', '{}'::jsonb)
           ON CONFLICT (trace_id, dataset_kind) DO NOTHING`,
          [traceId, datasetKind],
        );
        await executor.query(
          `INSERT INTO waspada.source_registry (
             source_id, trace_id, registry_version, display_name, source_kind, remit,
             access_method, approved_hosts, access_restrictions, reuse_basis, registry_status,
             approval_status, health_status, auto_acquisition_enabled, auto_publication_policy
           )
           VALUES ($1, $2, 1, $3, 'authority', ARRAY['all'], 'manual_fixture',
                   ARRAY[]::text[], ARRAY[]::text[], ARRAY['public'], 'active', 'approved', 'healthy', false, 'never')
           ON CONFLICT (source_id) DO NOTHING`,
          [rev.source_id, traceId, rev.source_id],
        );
        await executor.query(
          `INSERT INTO waspada.report_revisions (
             dataset_kind, report_revision_id, trace_id, source_id, canonical_url,
             content_hash, permitted_text, permitted_text_hash, normalization_version,
             retrieved_at, revision_status, record_json, triage_required
           )
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'v1', $9, 'unreviewed', '{}'::jsonb, false)
           ON CONFLICT (dataset_kind, report_revision_id) DO NOTHING`,
          [
            datasetKind,
            rev.report_revision_id,
            traceId,
            rev.source_id,
            rev.canonical_url,
            contentHash,
            rev.permitted_text,
            rev.permitted_text_hash,
            rev.retrieved_at,
          ],
        );
        const rawChunks = revRecord.chunks;
        const chunks: readonly { text: string; span_start: number; span_end: number }[] =
          Array.isArray(rawChunks) ? (rawChunks as readonly { text: string; span_start: number; span_end: number }[]) : [];
        for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex++) {
          const chk = chunks[chunkIndex];
          if (!chk || typeof chk.text !== "string") continue;
          const chunkTextHash = createHash("sha256").update(chk.text).digest("hex");
          await executor.query(
            `INSERT INTO waspada.evidence_chunks (
               dataset_kind, chunk_id, trace_id, report_revision_id, permitted_text_hash,
               span_start, span_end, offset_unit, chunker_version, chunk_text_hash, status
             )
             VALUES ($1, $2, $3, $4, $5, $6, $7, 'unicode_code_points', 'v1', $8, 'active')
             ON CONFLICT (dataset_kind, chunk_id) DO NOTHING`,
            [
              datasetKind,
              `chk-${rev.report_revision_id}-${chunkIndex}`,
              traceId,
              rev.report_revision_id,
              rev.permitted_text_hash,
              chk.span_start,
              chk.span_end,
              chunkTextHash,
            ],
          );
        }
        await repo.enqueueAiJob({
          jobId: `job-${crypto.randomUUID()}`,
          datasetKind,
          reportRevisionId: rev.report_revision_id,
          traceId,
        }).catch(() => {});
      }
      // WJ-INT-02B shared gated-RSS cycle (§6): poll → split → per-item
      // shared persist calls. Structured revisions above keep their own
      // plain-executor path and never enter the gated cycle. The outer
      // executor is plain SQL; each item re-wraps transactionally inside
      // runGatedRssCycle via the tx-capable executor below.
      try {
        await withTransactionalSqlExecutor(env, async (txExecutor) => {
          const cycle = await runGatedRssCycle(txExecutor, {
            datasetKind,
            revisions: newsResult.revisions,
            held: newsResult.held,
            policyVersion: TRIAGE_POLICY_VERSION,
          });
          persistFailures = cycle.persistFailures;
        });
      } catch {
        persistFailures = newsResult.revisions.length + newsResult.held.length;
      }
      if (persistFailures > 0) {
        console.log(`[news-triage] persist_failures=${persistFailures}`);
      }
      });
    } catch {}
  },
};
export { activeProposals, activeChunks };
