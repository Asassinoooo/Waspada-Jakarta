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
import { handleAccountRequest } from "./runtime/account-runtime.js";
import { createModerationApiHandler, type EventProposalDto, type StoredEvidenceChunk } from "./layers/l4-application-integration/moderation-api.js";
import { type StoredReportRevision } from "./layers/l2-model-grounding/proposal-engine.js";
import { createPetaBencanaPollRuntime } from "./runtime/petabencana-poll-runtime.js";
import { createBmkgPollRuntime } from "./runtime/bmkg-poll-runtime.js";
import { createNewsPollRuntime, DEFAULT_NEWS_FEEDS } from "./runtime/news-poll-runtime.js";

import { PublicReadModel } from "./layers/l4-application-integration/public-read-model.js";
import { eventBroadcaster, createSSEResponse } from "./layers/l4-application-integration/event-broadcaster.js";
import { createWebhookIngestHandler, isWebhookIngestPath } from "./layers/l1-data-knowledge/webhook-ingest.js";
import { withPostgresSqlExecutor } from "../../db/src/postgres-sql-executor.js";
import { createSqlIncidentRepository } from "../../db/src/incident-repository.js";
import { createEventProposalWriter } from "../../db/src/event-proposal-writer.js";
import type { DatasetKind } from "../../db/src/ports.js";
import type { SqlExecutor } from "../../db/src/sql.js";
const sourcePreviewHandler = createSourcePreviewHandler({ incremental: true });
const contextSourcesHandler = createContextSourcesHandler();

const activeRevisions = new Map<string, StoredReportRevision>();
const activeProposals = new Map<string, EventProposalDto>();
const activeChunks = new Map<string, readonly StoredEvidenceChunk[]>();

const webhookIngest = createWebhookIngestHandler({
  broadcaster: eventBroadcaster,
  onRevisionCreated: (revision) => {
    activeRevisions.set(revision.report_revision_id, revision);
  },
});

async function syncLivePipelineProposals(): Promise<void> {
  const newRevisions: StoredReportRevision[] = [];
  try {
    const pbResult = await createPetaBencanaPollRuntime().poll();
    newRevisions.push(...pbResult.revisions);
  } catch {}
  try {
    const bmkgResult = await createBmkgPollRuntime().poll();
    newRevisions.push(...bmkgResult.revisions);
  } catch {}
  try {
    const newsResult = await createNewsPollRuntime({ feeds: DEFAULT_NEWS_FEEDS }).poll();
    newRevisions.push(...newsResult.revisions);
  } catch {}
  if (newRevisions.length > 0) {
    for (const rev of newRevisions) {
      activeRevisions.set(rev.report_revision_id, rev);
    }
  }
}

// Initial live background sync
void syncLivePipelineProposals();
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

function getModerationHandler(env: WorkerEnvironment) {
  const datasetKind = ((env.DATASET_MODE as string) || "live") as DatasetKind;
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
    authenticate: async (request: Request) => {
      return {
        actorId: "mod-demo-01",
        role: "moderator",
        active: true,
        csrfToken: request.headers.get("x-csrf-token") ?? "demo-csrf-token",
      };
    },
    csrfProtection: false,
    publisher: {
      publish: async (input: unknown) => {
        const cmd = typeof input === "object" && input !== null
          ? (input as {
              proposal_id?: string;
              proposalId?: string;
              decision?: { proposal_id?: string };
              eventDraft?: unknown;
              event?: unknown;
              proposal?: EventProposalDto;
              title?: string;
              incident_type?: string;
              severity?: "low" | "medium" | "high" | "critical" | "unknown";
              location_label?: string;
              coordinates?: readonly [number, number];
              claims?: EventProposalDto["claims"];
            })
          : {};
        const id = cmd.proposal_id ?? cmd.proposalId ?? cmd.decision?.proposal_id;
        let proposal: EventProposalDto | undefined = cmd.proposal;
        let chunks: readonly StoredEvidenceChunk[] | undefined;

        if (id && (env.SQL_EXECUTOR || env.HYPERDRIVE?.connectionString)) {
          await withSqlExecutor(env, async (executor) => {
            const writer = createEventProposalWriter(executor);
            const found = await writer.readProposalById(id, datasetKind);
            if (found) proposal = found;
          });
        }
        if (!proposal && id) {
          proposal = activeProposals.get(id);
          chunks = activeChunks.get(id);
        }

        let publishedDetail: unknown;
        if (proposal) {
          publishedDetail = PublicReadModel.publish(proposal, chunks);
        } else if (cmd.eventDraft || cmd.event) {
          publishedDetail = PublicReadModel.publish((cmd.eventDraft ?? cmd.event) as Record<string, unknown>);
        } else if (id) {
          publishedDetail = PublicReadModel.publish({
            schema_version: "2.0",
            proposal_id: id,
            title: cmd.title ?? `Laporan Kejadian ${id}`,
            incident_type: cmd.incident_type ?? "unclassified",
            severity: cmd.severity ?? "unknown",
            event_time: { precision: "exact", value: new Date().toISOString() },
            location_label: cmd.location_label ?? null,
            coordinates: cmd.coordinates ?? null,
            claims: cmd.claims ?? [],
            proposed_at: new Date().toISOString(),
          });
        }
        if (publishedDetail) {
          eventBroadcaster.broadcastPublic("event_published", publishedDetail);
        }
        if (id) {
          eventBroadcaster.broadcastModeration("proposal_published", { proposal_id: id });
        }
        const decisionId = `dec-${Date.now()}`;
        if (id && (env.SQL_EXECUTOR || env.HYPERDRIVE?.connectionString)) {
          await withSqlExecutor(env, async (executor) => {
            const pubTrace = `trace-pub-${id}`;
            await executor.query(
              `INSERT INTO waspada.traces (trace_id, dataset_kind, started_at, outcome, metadata)
               VALUES ($1, $2, now(), 'succeeded', '{}'::jsonb)
               ON CONFLICT (trace_id, dataset_kind) DO NOTHING`,
              [pubTrace, datasetKind],
            );
            const eventId = (publishedDetail as any)?.event_id || `evt-${id}`;
            await executor.query(
              `INSERT INTO waspada.publication_decisions (
                 dataset_kind, decision_id, trace_id, proposal_id, policy_version,
                 event_id, event_version, reviewer_id, decided_at, record_json
               )
               VALUES ($1, $2, $3, $4, 'v1', $5, 1, 'mod-demo-01', now(), '{}'::jsonb)
               ON CONFLICT (dataset_kind, decision_id) DO NOTHING`,
              [datasetKind, decisionId, pubTrace, id, eventId],
            );
          }).catch(() => {});
        }
        return { status: "written", receipt: { decision_id: decisionId } };
      },
    },
  });
}
export default {
  async fetch(request: Request, env: WorkerEnvironment, ctx?: { waitUntil?: (promise: Promise<unknown>) => void }): Promise<Response> {
    const url = new URL(request.url);

    // Development / demo authentication bypass
    if (url.pathname === "/api/v1/auth/demo-login" || url.pathname === "/api/v1/auth/demo/login") {
      let role = "moderator";
      if (request.method === "POST") {
        try {
          const body = await request.json() as { role?: string };
          if (body.role === "admin" || body.role === "moderator") role = body.role;
        } catch {}
      } else {
        const queryRole = url.searchParams.get("role");
        if (queryRole === "admin" || queryRole === "moderator") role = queryRole;
      }
      let returnTo = url.searchParams.get("return_to") ?? (role === "admin" ? "/#admin" : "/#tinjau-bukti");
      if (!returnTo.startsWith("/")) {
        returnTo = "/" + returnTo;
      }
      const headers = new Headers();
      headers.set("content-type", "application/json; charset=utf-8");
      headers.set("set-cookie", `waspada_demo_session=${role}; Path=/; SameSite=Lax; Max-Age=86400`);
      if (request.method === "GET") {
        headers.set("location", returnTo);
        return new Response(null, { status: 302, headers });
      }
      return new Response(JSON.stringify({ ok: true, role }), { status: 200, headers });
    }

    if (url.pathname === "/api/v1/auth/session") {
      const cookieHeader = request.headers.get("cookie") ?? "";
      const match = /(?:^|;\s*)waspada_demo_session=([^;]+)/u.exec(cookieHeader);
      const demoRole = match ? match[1] : null;
      if (demoRole === "moderator" || demoRole === "admin") {
        return new Response(JSON.stringify({
          version: "account-v1",
          status: "authenticated",
          google_login_available: true,
          native_login_available: false,
          csrf_token: "demo-csrf-token-1234567890",
          user: {
            id: `user-demo-${demoRole}`,
            display_name: demoRole === "admin" ? "Demo Administrator" : "Demo Moderator",
            email: `demo-${demoRole}@waspada.jakarta.go.id`,
            role: demoRole,
            active: true,
            onboarding_version: 1,
            onboarding_completed_at: "2026-10-26T00:00:00.000Z",
            version: 1,
          },
        }), {
          status: 200,
          headers: {
            "content-type": "application/json; charset=utf-8",
            "cache-control": "no-store",
          },
        });
      }
    }

    if (url.pathname === "/api/v1/auth/logout" && request.method === "POST") {
      return new Response(null, {
        status: 204,
        headers: {
          "set-cookie": "waspada_demo_session=; Path=/; Max-Age=0",
        },
      });
    }
    // Inbound incident webhook push
    if (isWebhookIngestPath(url.pathname)) {
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
                       retrieved_at, revision_status, record_json
                     )
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'v1', $9, 'unreviewed', '{}'::jsonb)
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

    // Internal endpoint for Node.js intelligence worker to notify moderation of completed proposals
    if (url.pathname === "/api/v1/internal/proposals" && request.method === "POST") {
      const serviceKey = request.headers.get("x-service-key");
      const expectedKey = env.INTERNAL_SERVICE_KEY || "dev-internal-key";
      if (serviceKey !== expectedKey) {
        return new Response(JSON.stringify({ ok: false, error: "Unauthorized" }), {
          status: 401,
          headers: { "Content-Type": "application/json; charset=utf-8" },
        });
      }
      try {
        const body = (await request.json()) as { proposal_id?: string };
        if (body?.proposal_id) {
          eventBroadcaster.broadcastModeration("proposal_created", { proposal_id: body.proposal_id });
          return new Response(JSON.stringify({ ok: true, proposal_id: body.proposal_id }), {
            status: 200,
            headers: { "Content-Type": "application/json; charset=utf-8" },
          });
        }
      } catch {}
      return new Response(JSON.stringify({ ok: false, error: "invalid_payload" }), {
        status: 400,
        headers: { "Content-Type": "application/json; charset=utf-8" },
      });
    }
    // Realtime SSE streaming for moderation queue
    if (url.pathname === "/api/v1/moderation/stream" || url.pathname === "/api/v1/moderation/stream/") {
      return createSSEResponse(eventBroadcaster.subscribeModeration(request.signal));
    }

    // Realtime SSE streaming for public events
    if (url.pathname === "/api/v1/events/stream" || url.pathname === "/api/v1/events/stream/") {
      return createSSEResponse(eventBroadcaster.subscribePublicEvents(request.signal));
    }

    const accountResponse = await handleAccountRequest(request, env);
    if (accountResponse !== undefined) return accountResponse;
    if (url.pathname.startsWith("/api/v1/moderation/")) {
      const modRes = await getModerationHandler(env)(request);
      if (modRes !== undefined) return modRes;
    }
    if (url.pathname === "/api/v1/demo/context-sources") {
      return contextSourcesHandler(request, env);
    }
    if (url.pathname === "/api/v1/demo/source-preview") {
      return sourcePreviewHandler(request, env);
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
    // Scheduled live ingestion pollers
    try {
      const pbRunner = createPetaBencanaPollRuntime();
      const pbResult = await pbRunner.poll(controller.scheduledTime);
      const bmkgRunner = createBmkgPollRuntime();
      const bmkgResult = await bmkgRunner.poll();
      const newsRunner = createNewsPollRuntime({ feeds: DEFAULT_NEWS_FEEDS });
      const newsResult = await newsRunner.poll();
      const allRevisions = [...pbResult.revisions, ...bmkgResult.revisions, ...newsResult.revisions];
      if (allRevisions.length > 0 && (env.SQL_EXECUTOR || env.HYPERDRIVE?.connectionString)) {
        await withSqlExecutor(env, async (executor) => {
          const datasetKind = ((env.DATASET_MODE as string) || "live") as DatasetKind;
          const repo = createSqlIncidentRepository(executor);
          for (const rev of allRevisions) {
            const traceId = (rev as any).trace_id || `trace-${rev.report_revision_id}`;
            const contentHash = (rev as any).content_hash || rev.permitted_text_hash;
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
                 retrieved_at, revision_status, record_json
               )
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'v1', $9, 'unreviewed', '{}'::jsonb)
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
            await repo.enqueueAiJob({
              jobId: `job-${crypto.randomUUID()}`,
              datasetKind,
              reportRevisionId: rev.report_revision_id,
              traceId,
            }).catch(() => {});
          }
        });
      }
    } catch {}
  },
};
export { activeProposals, activeChunks, syncLivePipelineProposals };
