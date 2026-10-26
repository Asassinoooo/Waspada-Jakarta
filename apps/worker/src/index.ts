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
import { generateProposalFromReport, type StoredReportRevision } from "./layers/l2-model-grounding/proposal-engine.js";
import { createPetaBencanaPollRuntime } from "./runtime/petabencana-poll-runtime.js";
import { createNewsPollRuntime } from "./runtime/news-poll-runtime.js";

const sourcePreviewHandler = createSourcePreviewHandler({ incremental: true });
const contextSourcesHandler = createContextSourcesHandler();

// In-memory proposal and chunk store for development and live demonstration
const activeProposals = new Map<string, EventProposalDto>();
const activeChunks = new Map<string, readonly StoredEvidenceChunk[]>();

// Seed initial demo proposals generated from verified report chunks
const sampleReports: StoredReportRevision[] = [
  {
    report_revision_id: "report-demo-flood-kemang",
    source_id: "petabencana",
    canonical_url: "https://petabencana.id/report/flood-kemang-01",
    permitted_text: "Banjir genangan setinggi 50 cm di Jalan Kemang Raya, Mampang Prapatan Jakarta Selatan.",
    permitted_text_hash: "3b08b5f3d79f048d0cf489e248b64e03d40bf5e2c77ef155f9a6565e2363b924",
    published_at: "2026-10-26T03:30:00Z",
    retrieved_at: "2026-10-26T04:00:00Z",
    revision_status: "unreviewed",
    chunks: [
      {
        chunk_index: 0,
        text: "Banjir genangan setinggi 50 cm di Jalan Kemang Raya, Mampang Prapatan Jakarta Selatan.",
        span_start: 0,
        span_end: 87,
      },
    ],
  },
  {
    report_revision_id: "report-demo-fire-senen",
    source_id: "source-antara-metro",
    canonical_url: "https://www.antaranews.com/berita/kebakaran-senen-jakpus",
    permitted_text: "Kebakaran hebat hanguskan ruko di Pasar Senen Jakarta Pusat pada pukul 02.15 WIB, 15 unit damkar dikerahkan.",
    permitted_text_hash: "7f4c51489e2c66d214a1c586b627889ef512c14041a546271c0800b411d9541a",
    published_at: "2026-10-26T02:30:00Z",
    retrieved_at: "2026-10-26T03:00:00Z",
    revision_status: "unreviewed",
    chunks: [
      {
        chunk_index: 0,
        text: "Kebakaran hebat hanguskan ruko di Pasar Senen Jakarta Pusat pada pukul 02.15 WIB, 15 unit damkar dikerahkan.",
        span_start: 0,
        span_end: 109,
      },
    ],
  },
];

for (const rep of sampleReports) {
  const prop = generateProposalFromReport(rep);
  if (prop) {
    activeProposals.set(prop.proposal_id, prop);
    activeChunks.set(prop.proposal_id, rep.chunks);
  }
}

const moderationHandler = createModerationApiHandler({
  listPendingProposals: async () => Array.from(activeProposals.values()),
  getProposalDetail: async (id: string) => {
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
      const cmd = input as { proposal_id?: string; decision?: { proposal_id?: string } };
      const id = cmd.proposal_id ?? cmd.decision?.proposal_id;
      if (id) activeProposals.delete(id);
      return { status: "written", receipt: { decision_id: `dec-${Date.now()}` } };
    },
  },
});
export default {
  async fetch(request: Request, env: WorkerEnvironment): Promise<Response> {
    const accountResponse = await handleAccountRequest(request, env);
    if (accountResponse !== undefined) return accountResponse;
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/v1/moderation/")) {
      const modRes = await moderationHandler(request);
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
      for (const rev of pbResult.revisions) {
        const proposal = generateProposalFromReport(rev);
        if (proposal) {
          activeProposals.set(proposal.proposal_id, proposal);
          activeChunks.set(proposal.proposal_id, rev.chunks);
        }
      }
    } catch {}
    try {
      const newsRunner = createNewsPollRuntime();
      const newsResult = await newsRunner.poll();
      for (const rev of newsResult.revisions) {
        const proposal = generateProposalFromReport(rev);
        if (proposal) {
          activeProposals.set(proposal.proposal_id, proposal);
          activeChunks.set(proposal.proposal_id, rev.chunks);
        }
      }
    } catch {}
  },
};
