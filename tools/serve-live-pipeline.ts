import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { PGlite } from "@electric-sql/pglite";
import { postgis } from "@electric-sql/pglite-postgis";
import { vector } from "@electric-sql/pglite-pgvector";
import { readMigrations, applyMigrations } from "../apps/db/src/migrations.js";
import type { SqlExecutor, TransactionalSqlExecutor } from "../apps/db/src/sql.js";
import { createAccountStore } from "../apps/db/src/accounts.js";
import { createSqlIncidentRepository, requeueStrandedAiJobs } from "../apps/db/src/incident-repository.js";
import { createJobRunner } from "../apps/intelligence/src/job-runner.js";
import { getNineRouterConfig, patchGlobalFetchForNineRouter } from "../apps/intelligence/src/providers/ninerouter-adapter.js";
import { getNineRouterCallCounts, getNineRouterRateGateSnapshot } from "../apps/db/src/ninerouter-rate-gate.js";
import { createPetaBencanaPollRuntime } from "../apps/worker/src/runtime/petabencana-poll-runtime.js";
import { createBmkgPollRuntime } from "../apps/worker/src/runtime/bmkg-poll-runtime.js";
import { createCycleRevisionDedupe, createLiveNewsPollRuntime, DEFAULT_NEWS_FEEDS, type StoredReportRevision } from "../apps/worker/src/runtime/news-poll-runtime.js";
import { buildLiveTriageGate } from "../apps/worker/src/runtime/news-triage-composition.js";
import { createRecentItemIndex } from "../apps/worker/src/layers/l1-data-knowledge/news-title-dedupe.js";
import { parseLiveCycleConfig } from "../apps/worker/src/runtime/live-cycle-config.js";
import { TRIAGE_POLICY_VERSION } from "../apps/worker/src/layers/l1-data-knowledge/news-triage.js";
import { runGatedRssCycle } from "../apps/worker/src/runtime/gated-rss-persistence.js";
import { createPipelineRuntimeStatus } from "../apps/worker/src/runtime/pipeline-runtime-status.js";
import type { WorkerEnvironment } from "../apps/worker/src/layers/l4-application-integration/api.js";
import worker from "../apps/worker/src/index.js";
import { seedAdminAccount } from "../apps/worker/src/accounts/seed-admin.js";
import { generateServiceKey } from "../apps/worker/src/security/service-key.js";
import { PublicReadModel, proposalToEventDetail } from "../apps/worker/src/layers/l4-application-integration/public-read-model.js";
import {
  DEFAULT_PROPOSAL_REVIEW_TTL_HOURS,
  isValidProposalReviewTtlHours,
  parseProposalReviewTtlHours,
  SOURCE_PERMISSION_WAIVED_LOCAL,
} from "../apps/worker/src/layers/l4-application-integration/publication-policy.js";
import { expireStaleProposals } from "../apps/worker/src/layers/l4-application-integration/proposal-publication.js";
import { createEventProposalWriter } from "../apps/db/src/event-proposal-writer.js";
import { claimLiveDb, LiveDbBusyError, type LiveDbClaim } from "./live-db-lock.js";
import { resolveLiveDbBackupDir, restoreLiveDbFromBackup } from "./live-db-restore.js";
import { startLiveFreshness } from "./live-freshness-job.js";

const MIME_TYPES: Readonly<Record<string, string>> = Object.freeze({
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
});

// Releases serve-live.pid on a fatal startup error. Replaced once the claim exists.
let releaseClaim: () => void = () => {};

// INTEL-02: serve:live always works on the live dataset. It is passed explicitly, never inferred from DATASET_KIND.
const SERVE_LIVE_DATASET_KIND = "live" as const;

async function main() {
  console.log("==================================================================");
  console.log("  Waspada Jakarta: Live Incident Intelligence & Ingestion Server  ");
  console.log("==================================================================");

  // 1. Probing NineRouter Live AI Gateway
  const config = getNineRouterConfig();
  // INTEL-02: mock mode gives deterministic chat output. The live dataset must not receive it.
  if (config.explicitMock) {
    console.error("Refusing to start: NINEROUTER_MODE=mock would write mock interpretations into the live dataset. Unset NINEROUTER_MODE to use the gateway.");
    process.exit(1);
  }
  console.log(`[NineRouter] Gateway URL : ${config.baseUrl}`);
  console.log(`[NineRouter] Chat Model  : ${config.chatModel}`);
  console.log(`[NineRouter] Embeddings  : ${config.embeddingModel} (768 dimensions)`);
  if (!config.baseUrl || !config.apiKey || config.baseUrl.includes("127.0.0.1:9090")) {
    console.warn("⚠️ Warning: Real NINEROUTER_URL and NINEROUTER_KEY not found in environment. In live mode, requests will require valid credentials.");
  } else {
    console.log("✓ NineRouter provider credentials loaded.");
  }

  // AI-RATE-01: pace every NineRouter call (Mastra agents, embeddings, triage)
  // through the shared rate gate. Installed before the job runner and the first poll.
  patchGlobalFetchForNineRouter();

  // 2. Persistent PGlite Database Setup
  const dataDir = path.resolve(process.cwd(), ".data/live-db");
  fs.mkdirSync(dataDir, { recursive: true });
  // LIVE-SERVER-02: claim the dir before anything opens or changes it. A live serve:live owner
  // refuses this start. Stale pid files are replaced and postmaster.pid is cleared only without a live owner.
  let claim: LiveDbClaim;
  try {
    claim = claimLiveDb(dataDir);
  } catch (err) {
    if (err instanceof LiveDbBusyError) {
      console.error(err.message);
      process.exit(1);
    }
    throw err;
  }
  releaseClaim = () => claim.release();
  if (claim.removedStale.length > 0) {
    console.log(`[Database] Removed stale owner files: ${claim.removedStale.join(", ")}.`);
  }
  console.log(`\n[Database] Opening persistent database at: ${dataDir}`);
  let database: PGlite;
  try {
    database = await PGlite.create({
      dataDir,
      extensions: { postgis, vector },
    });
  } catch (err) {
    const openError = err instanceof Error ? err.message : String(err);
    // Restore only from a backup that exists. The data dir is kept unless a complete copy is ready.
    // LIVE-SERVER-02: the backup is `.data/live-db-backup` or the newest `.data/live-db.bak-<epoch>`
    // (the repo's real name), unless LIVE_DB_BACKUP_DIR names one explicitly.
    const backup = resolveLiveDbBackupDir({ dataDir, explicitDir: process.env.LIVE_DB_BACKUP_DIR });
    if (backup === null) {
      console.error(`[Database] Could not open ${dataDir}: ${openError}`);
      console.error(`[Database] No backup under .data (live-db-backup or live-db.bak-<epoch>). The data dir was not changed. Set LIVE_DB_BACKUP_DIR to restore from a backup.`);
      claim.release();
      process.exit(1);
    }
    console.warn(`[Database] Could not open ${dataDir}: ${openError}`);
    console.log(`[Database] Restoring from ${backup.dir} (${backup.source}). The broken directory is kept, not deleted.`);
    const restored = restoreLiveDbFromBackup({ dataDir, backupDir: backup.dir });
    console.log(`[Database] Broken directory kept at ${restored.brokenDir ?? "(none, data dir was absent)"}.`);
    // The owner files moved with the broken dir, so the restored dir needs its own claim.
    claim = claimLiveDb(dataDir);
    releaseClaim = () => claim.release();
    database = await PGlite.create({
      dataDir,
      extensions: { postgis, vector },
    });
    console.log(`[Database] Database recovered and opened successfully.`);
  }

  const executor: TransactionalSqlExecutor = {
    async query<Row extends object>(statement: string, parameters?: readonly unknown[]) {
      const res = await database.query<Row>(statement, parameters ? [...parameters] : undefined);
      return { rows: res.rows };
    },
    async execute(statement: string) {
      await database.exec(statement);
    },
    async transaction<Result>(work: (tx: SqlExecutor) => Promise<Result>): Promise<Result> {
      return database.transaction(async (client) => {
        const tx: SqlExecutor = {
          async query<Row extends object>(stmt: string, params?: readonly unknown[]) {
            const r = await client.query<Row>(stmt, params ? [...params] : undefined);
            return { rows: r.rows };
          },
          async execute(stmt: string) {
            await client.exec(stmt);
          },
        };
        return work(tx);
      });
    },
  };

  const migrations = await readMigrations(new URL("../apps/db/migrations/", import.meta.url));
  await applyMigrations(executor, migrations);
  console.log(`✓ Applied ${migrations.length} database migrations.`);

  // Operator-seeded administrator. Credentials come only from the environment and are never printed.
  const adminUsername = process.env.WASPADA_ADMIN_USERNAME;
  const adminPassword = process.env.WASPADA_ADMIN_PASSWORD;
  if (adminUsername && adminPassword) {
    try {
      const seeded = await seedAdminAccount(createAccountStore(executor, "live"), {
        username: adminUsername,
        password: adminPassword,
        now: new Date().toISOString(),
      });
      console.log(`✓ Administrator account '${seeded.username}': ${seeded.status === "created" ? "created" : "already exists"}.`);
    } catch (err) {
      console.warn(`[Accounts] Administrator seeding failed: ${err instanceof Error ? err.message : "unknown error"}`);
    }
  } else {
    console.log("[Accounts] WASPADA_ADMIN_USERNAME / WASPADA_ADMIN_PASSWORD not set; moderator sign-in needs an existing admin account.");
  }

  // Clear demo synthetic fixtures so only genuine live data is shown
  PublicReadModel.clearPublishedEvents();

  // MERGE-REVIEW-01 (ADR-061): restore only versions that have a publication decision, oldest first,
  // so the latest decision for each event wins. Multi-source proposals are never published by
  // startup; a proposal with no publish decision stays in the moderator queue.
  console.log("\n[Public Read Model] Restoring published versions from publication decisions...");
  const decidedRes = await executor.query<{
    record_json: unknown;
    event_version: number | null;
    publication_mode: string | null;
    source_count: string | null;
    waivers: unknown;
  }>(
    `SELECT ep.record_json,
            pd.event_version,
            pd.record_json->>'publication_mode' AS publication_mode,
            pd.record_json->>'source_count' AS source_count,
            pd.record_json->'waivers' AS waivers
     FROM waspada.publication_decisions pd
     JOIN waspada.event_proposals ep
       ON ep.dataset_kind = pd.dataset_kind AND ep.proposal_id = pd.proposal_id
     WHERE pd.dataset_kind = 'live' AND pd.record_json->>'disposition' = 'publish'
     ORDER BY pd.decided_at ASC, pd.decision_id ASC`
  );
  let pubCount = 0;
  for (const row of decidedRes.rows) {
    const p = typeof row.record_json === "string" ? JSON.parse(row.record_json) : row.record_json;
    if (!p || row.event_version === null) continue;
    try {
      const mode = row.publication_mode === "agent_auto" ? "agent_auto" : "moderator_reviewed";
      // ADR-061 amendment: keep the waiver label on versions published under local relaxation.
      const storedWaivers = typeof row.waivers === "string" ? JSON.parse(row.waivers) : row.waivers;
      const waivers = Array.isArray(storedWaivers)
        ? storedWaivers.filter((waiver) => waiver === SOURCE_PERMISSION_WAIVED_LOCAL)
        : [];
      const detail = proposalToEventDetail(p, undefined, {
        version: row.event_version,
        publication: {
          mode,
          source_count: Number(row.source_count ?? 0),
          ...(waivers.length > 0 ? { waivers } : {}),
        },
      });
      PublicReadModel.publish(detail);
      pubCount++;
    } catch {
      // skip a version that no longer projects; it stays in the database
    }
  }
  console.log(`✓ Restored ${pubCount} published live versions into PublicReadModel.`);

  // Seed the 14 news feeds into waspada.source_registry for live user testing
  console.log(`\n[Source Registry] Seeding ${DEFAULT_NEWS_FEEDS.length} RSS sources...`);
  const seedTraceId = "trace-seed-rss-sources";
  await executor.query(
    `INSERT INTO waspada.traces (trace_id, dataset_kind, started_at, outcome, metadata)
     VALUES ($1, 'live', now(), 'succeeded', '{"seed": "all_rss_feeds"}'::jsonb)
     ON CONFLICT (trace_id, dataset_kind) DO NOTHING`,
    [seedTraceId],
  );

  for (const feed of DEFAULT_NEWS_FEEDS) {
    const host = new URL(feed.url).host;
    const displayName = feed.sourceId.replace(/^source-/, "").replace(/-/g, " ").toUpperCase();
    await executor.query(
      `INSERT INTO waspada.source_registry (
         source_id, trace_id, registry_version, display_name, source_kind, remit,
         access_method, approved_hosts, access_restrictions, reuse_basis, registry_status,
         approval_status, health_status, auto_acquisition_enabled, auto_publication_policy,
         polling_interval_seconds
       )
       VALUES (
         $1, $2, 1, $3, 'newsroom', ARRAY['news', 'incidents'],
         'rss', ARRAY[$4]::text[], ARRAY[]::text[],
         ARRAY['model_triage', 'model_description', 'retain_title', 'retain_description', 'retain_derived', 'public_display'],
         'active', 'approved', 'healthy', true, 'never', 600
       )
       ON CONFLICT (source_id) DO UPDATE SET
         approval_status = 'approved',
         auto_acquisition_enabled = true,
         registry_status = 'active',
         reuse_basis = ARRAY['model_triage', 'model_description', 'retain_title', 'retain_description', 'retain_derived', 'public_display'],
         health_status = 'healthy'`,
      [feed.sourceId, seedTraceId, displayName, host],
    );
  }
  console.log(`✓ Seeded ${DEFAULT_NEWS_FEEDS.length} RSS sources in source_registry.`);

  // Triage attempts/decisions are an append-only audit ledger (WJ-INT-02B) and also the
  // dedupe cache that stops every restart re-sending the 48h window to the model, so they
  // are kept across runs. Rate-limited attempts are handled by AI-RATE-01, not by wiping.

  const incidentRepo = createSqlIncidentRepository(executor);

  // 3. Worker Environment Configuration. The internal key is random per run and is shared
  // with the in-process job runner below. Nothing is printed. Accounts run on the local origin.
  const internalServiceKey = generateServiceKey();
  // AI-RATE-01 re-drive: jobs stranded in needs_review by model or rate-limit
  // failures go back to pending once per start.
  const requeued = await requeueStrandedAiJobs(executor, { codes: ["model_failed", "rate_limited"] });
  if (requeued.length > 0) {
    console.log(`✓ Requeued ${requeued.length} stranded AI jobs (model_failed, rate_limited).`);
  }

  // 3. Worker Environment Configuration
  // ADR-061 amendment: only this local server relaxes the automatic gate's public-display permission
  // check. It is bound to 127.0.0.1. Hosted deployments keep the default `required`.
  console.log("[Publication] Source-permission check is relaxed for local live mode (AUTO_PUBLISH_SOURCE_PERMISSION=local_relaxed). Other automatic gate checks still apply.");
  // FLOW-VIS-01: in-process cycle, source, dedupe and NineRouter status for the moderator pipeline view.
  const pipelineStatus = createPipelineRuntimeStatus({ ninerouter: () => getNineRouterRateGateSnapshot() });
  const env: WorkerEnvironment = {
    DATASET_MODE: "live",
    AUTH_ENABLED: "true",
    AUTH_APP_ORIGIN: "http://127.0.0.1:5173",
    INTERNAL_SERVICE_KEY: internalServiceKey,
    WEBHOOK_SERVICE_KEY: process.env.WEBHOOK_SERVICE_KEY,
    SQL_EXECUTOR: executor,
    AUTO_PUBLISH_SOURCE_PERMISSION: "local_relaxed",
    PIPELINE_STATUS: pipelineStatus,
  };

  // 4. Start Unified Live Worker Server (Port 8787)
  const distDir = path.resolve(process.cwd(), "apps/web/dist");
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", `http://${req.headers.host}`);

      if (url.pathname.startsWith("/api/v1")) {
        const chunks: Buffer[] = [];
        for await (const chunk of req) {
          chunks.push(chunk as Buffer);
        }
        const bodyBuf = Buffer.concat(chunks);
        const headers = new Headers();
        for (const [k, v] of Object.entries(req.headers)) {
          if (v !== undefined) {
            if (Array.isArray(v)) {
              v.forEach((val) => headers.append(k, val));
            } else {
              headers.set(k, v);
            }
          }
        }

        const webReq = new Request(url.href, {
          method: req.method,
          headers,
          body: ["GET", "HEAD"].includes(req.method ?? "") ? undefined : bodyBuf,
        });

        const webRes = await worker.fetch(webReq, env);
        res.statusCode = webRes.status;
        webRes.headers.forEach((v, k) => {
          res.setHeader(k, v);
        });
        const resBuf = Buffer.from(await webRes.arrayBuffer());
        res.end(resBuf);
      } else {
        let targetFile = path.join(distDir, url.pathname);
        if (!fs.existsSync(targetFile) || fs.statSync(targetFile).isDirectory()) {
          targetFile = path.join(distDir, "index.html");
        }
        const ext = path.extname(targetFile);
        const contentType = MIME_TYPES[ext] || "application/octet-stream";
        const content = fs.readFileSync(targetFile);
        res.writeHead(200, { "Content-Type": contentType });
        res.end(content);
      }
    } catch (err) {
      console.error("Server request error:", err);
      res.statusCode = 500;
      res.end("Internal Server Error");
    }
  });

  const API_PORT = 8787;
  await new Promise<void>((resolve) => server.listen(API_PORT, "127.0.0.1", resolve));
  console.log(`\n✓ Unified Live Backend Server listening on http://127.0.0.1:${API_PORT}`);

  // 5. Start Mastra AI Intelligence Worker Background Runner
  console.log("[Intelligence] Starting durable Mastra AI Job Runner loop...");
  const jobRunner = createJobRunner({
    executor,
    transactionalExecutor: executor,
    config,
    internalServiceKey,
    workerInternalUrl: `http://127.0.0.1:${API_PORT}`,
    leaseDurationMs: 300_000,
    pollIntervalMs: 2_000,
  });

  let workerActive = true;
  (async () => {
    while (workerActive) {
      try {
        const processed = await jobRunner.processNextJob(SERVE_LIVE_DATASET_KIND);
        if (!processed) {
          await new Promise((r) => setTimeout(r, 2000));
        }
      } catch (err) {
        console.error("[Intelligence Error]:", err);
        await new Promise((r) => setTimeout(r, 3000));
      }
    }
  })().catch(() => {});

  // 6. Start Live Ingestion Pollers (PetaBencana, BMKG, ANTARA News)
  console.log("[Ingestion] Initializing live source pollers (PetaBencana, BMKG, ANTARA News)...");
  // AI-RPM-01 knobs: RSS article age limit and new triage calls per cycle (defaults 6 h, 5).
  // Feeds get the age limit explicitly, so the parse filter and Stage A stale check agree.
  const liveCycle = parseLiveCycleConfig(process.env);
  const liveFeeds = DEFAULT_NEWS_FEEDS.map((feed) => ({ ...feed, maxAgeHours: liveCycle.rssMaxAgeHours }));
  // One process-scoped index: Stage A duplicates across feeds and cycles (48 h window).
  const liveRecentItems = createRecentItemIndex();
  console.log(`[Ingestion] RSS max age ${liveCycle.rssMaxAgeHours} h; up to ${liveCycle.maxNewItemsPerCycle} new triage calls per cycle.`);
  // REVIEW-EXPIRY-01 (ADR-062): undecided proposals expire after this many hours. The raw value is never logged.
  const reviewTtlHours = parseProposalReviewTtlHours(process.env.PROPOSAL_REVIEW_TTL_HOURS);
  if (process.env.PROPOSAL_REVIEW_TTL_HOURS !== undefined && !isValidProposalReviewTtlHours(process.env.PROPOSAL_REVIEW_TTL_HOURS)) {
    console.warn(`[Review] PROPOSAL_REVIEW_TTL_HOURS is not an integer from 1 to 720; using ${DEFAULT_PROPOSAL_REVIEW_TTL_HOURS}h.`);
  }
  console.log(`[Review] Undecided proposals expire after ${reviewTtlHours} h without a moderator decision (ADR-062).`);
  let isPolling = false;
  async function pollLiveFeeds() {
    if (isPolling) {
      console.log("  [Ingestion Cycle] Previous poll cycle still running, skipping.");
      return;
    }
    isPolling = true;
    const callsAtCycleStart = getNineRouterCallCounts();
    // FLOW-VIS-01: the fresh-call budget object is read at cycle end, after every feed has spent from it.
    let triageBudget: { remaining: number } | undefined;
    let cycleFeedFailures = 0;
    pipelineStatus.recordCycleStart({ newItemsCap: liveCycle.maxNewItemsPerCycle, feedsTotal: liveFeeds.length });
    try {
      console.log("\n[Ingestion Cycle] Polling live Jakarta sources...");
    const discoveredRevisions: StoredReportRevision[] = [];

    // A. PetaBencana
    try {
      const pbRunner = createPetaBencanaPollRuntime();
      const pbRes = await pbRunner.poll();
      if (pbRes.revisions.length > 0) {
        console.log(`  [PetaBencana] Discovered ${pbRes.revisions.length} live flood reports.`);
        discoveredRevisions.push(...pbRes.revisions);
      } else {
        console.log("  [PetaBencana] 0 new flood reports in the last 24h.");
      }
      pipelineStatus.recordSourceCycle("petabencana", { ingest: pbRes.revisions.length, held: 0, duplicate: 0, deferred: 0, errors: 0 });
    } catch (e: unknown) {
      console.warn(`  [PetaBencana] Poll error: ${e instanceof Error ? e.message : String(e)}`);
      pipelineStatus.recordSourceCycle("petabencana", { ingest: 0, held: 0, duplicate: 0, deferred: 0, errors: 1 });
    }

    // B. BMKG CAP Alerts
    try {
      const bmkgRunner = createBmkgPollRuntime();
      const bmkgRes = await bmkgRunner.poll();
      if (bmkgRes.revisions.length > 0) {
        console.log(`  [BMKG] Discovered ${bmkgRes.revisions.length} weather/disaster warnings.`);
        discoveredRevisions.push(...bmkgRes.revisions);
      } else {
        console.log("  [BMKG] No active alerts for Jakarta.");
      }
      pipelineStatus.recordSourceCycle("bmkg", { ingest: bmkgRes.revisions.length, held: 0, duplicate: 0, deferred: 0, errors: 0 });
    } catch (e: unknown) {
      console.warn(`  [BMKG] Poll error: ${e instanceof Error ? e.message : String(e)}`);
      pipelineStatus.recordSourceCycle("bmkg", { ingest: 0, held: 0, duplicate: 0, deferred: 0, errors: 1 });
    }

    // C. RSS Feeds (14 sources) — WJ-INT-02B shared gated-RSS cycle (§6):
    // Process feeds sequentially to avoid overwhelming LLM gateway concurrency.
    // Persist after each feed so decisions are immediately saved to DB cache.
    let gatedPersistFailures = 0;
    try {
      const toolEnv: WorkerEnvironment = {
        NINEROUTER_URL: process.env.NINEROUTER_URL,
        NINEROUTER_KEY: process.env.NINEROUTER_KEY,
        NINEROUTER_CHAT_MODEL: process.env.NINEROUTER_CHAT_MODEL,
        NEWS_DETERMINISTIC_FILTER_MODE: process.env.NEWS_DETERMINISTIC_FILTER_MODE ?? "enforce",
      };
      // Gate per cycle: the fresh-call budget resets each cycle and is shared by all feeds in it.
      const gate = buildLiveTriageGate(toolEnv, executor, {
        recentItems: liveRecentItems,
        maxFreshCallsPerCycle: liveCycle.maxNewItemsPerCycle,
      });
      console.log(`  [Deterministic Filter] Active mode: ${gate.deterministicMode}`);
      triageBudget = gate.freshCallBudget;
      const newsRunner = createLiveNewsPollRuntime({ feeds: liveFeeds, triage: gate });
      // AI-RPM-01: the same revision dedupe as poll(), kept across this cycle's feeds.
      const cycleDedupe = createCycleRevisionDedupe();
      let totalIngest = 0;
      let totalHeld = 0;
      let totalDuplicates = 0;
      let totalBudgetDeferred = 0;
      for (let i = 0; i < liveFeeds.length; i++) {
        const feed = liveFeeds[i]!;
        try {
          const feedRes = await newsRunner.pollFeed(feed);
          const admitted = feedRes.revisions.filter((rev) => cycleDedupe.admit(rev));
          // FLOW-VIS-01: title-dedupe hits come from Stage A; cycle-dedupe hits are the revisions this cycle already admitted.
          const counts = feedRes.triageCounts;
          pipelineStatus.recordDedupeHits({ title: counts?.duplicate ?? 0, cycle: feedRes.revisions.length - admitted.length, ref: `feed-${feed.sourceId}` });
          pipelineStatus.recordDetFilter({
            mode: gate.deterministicMode,
            dropped: Math.max(0, (counts?.detConsidered ?? 0) - (counts?.detCandidate ?? 0) - (counts?.detAmbiguous ?? 0)),
          });
          if (admitted.length > 0 || (feedRes.held && feedRes.held.length > 0)) {
            if (typeof executor.transaction === "function") {
              const cycle = await runGatedRssCycle(executor, {
                datasetKind: "live",
                revisions: admitted,
                held: feedRes.held ?? [],
                policyVersion: TRIAGE_POLICY_VERSION,
              });
              gatedPersistFailures += cycle.persistFailures;
            }
          }
          totalIngest += admitted.length;
          totalHeld += feedRes.held ? feedRes.held.length : 0;
          totalDuplicates += feedRes.triageCounts?.duplicate ?? 0;
          totalBudgetDeferred += feedRes.triageCounts?.budgetDeferred ?? 0;
          pipelineStatus.recordSourceCycle("rss", {
            ingest: admitted.length,
            held: feedRes.held ? feedRes.held.length : 0,
            duplicate: feedRes.triageCounts?.duplicate ?? 0,
            deferred: feedRes.triageCounts?.budgetDeferred ?? 0,
            errors: 0,
          });
          console.log(`  [RSS ${i + 1}/${liveFeeds.length}: ${feed.sourceId}] ${admitted.length} ingest, ${feedRes.held ? feedRes.held.length : 0} held.`);
        } catch (feedErr: unknown) {
          console.warn(`  [RSS ${i + 1}/${liveFeeds.length}: ${feed.sourceId}] Poll error: ${feedErr instanceof Error ? feedErr.message : String(feedErr)}`);
          pipelineStatus.recordSourceCycle("rss", { ingest: 0, held: 0, duplicate: 0, deferred: 0, errors: 1 });
          cycleFeedFailures += 1;
        }
      }
      console.log(`  [RSS Feeds (${liveFeeds.length})] Total: ${totalIngest} articles (ingest), ${totalHeld} held, ${totalDuplicates} duplicate, ${totalBudgetDeferred} deferred by cycle cap.`);
    } catch (e: unknown) {
      console.warn(`  [RSS Feeds] Poll error: ${e instanceof Error ? e.message : String(e)}`);
    }

    // Persist structured revisions (PetaBencana/BMKG) to PostgreSQL and enqueue
    // AI jobs. discoveredRevisions contains ONLY structured revisions: the
    // gated RSS half already persisted through runGatedRssCycle above.
    let persistFailures = gatedPersistFailures;
    for (const rev of discoveredRevisions) {
      const revRecord = rev as unknown as Record<string, unknown>;
      const contentHash = typeof revRecord.content_hash === "string"
        ? (revRecord.content_hash as string)
        : rev.permitted_text_hash;
      const traceId = `trace-${rev.report_revision_id}`;

      await executor.query(
        `INSERT INTO waspada.traces (trace_id, dataset_kind, started_at, outcome, metadata)
         VALUES ($1, 'live', now(), 'succeeded', '{}'::jsonb)
         ON CONFLICT (trace_id, dataset_kind) DO NOTHING`,
        [traceId],
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

      // Persist report revision
      await executor.query(
        `INSERT INTO waspada.report_revisions (
           dataset_kind, report_revision_id, trace_id, source_id, canonical_url,
           content_hash, permitted_text, permitted_text_hash, normalization_version,
           retrieved_at, revision_status, record_json, triage_required
         )
         VALUES ('live', $1, $2, $3, $4, $5, $6, $7, 'v1', $8, 'unreviewed', '{}'::jsonb, false)
         ON CONFLICT (dataset_kind, report_revision_id) DO NOTHING`,
        [
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

      // Persist evidence chunks
      for (const chk of rev.chunks) {
        const chunkTextHash = createHash("sha256").update(chk.text).digest("hex");
        await executor.query(
          `INSERT INTO waspada.evidence_chunks (
             dataset_kind, chunk_id, trace_id, report_revision_id, permitted_text_hash,
             span_start, span_end, offset_unit, chunker_version, chunk_text_hash, status
           )
           VALUES ('live', $1, $2, $3, $4, $5, $6, 'unicode_code_points', 'v1', $7, 'active')
           ON CONFLICT (dataset_kind, chunk_id) DO NOTHING`,
          [
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

      // Enqueue durable AI Job
      await incidentRepo.enqueueAiJob({
        jobId: `job-${crypto.randomUUID()}`,
        datasetKind: "live",
        reportRevisionId: rev.report_revision_id,
        traceId,
      }).catch(() => {});
    }
    if (persistFailures > 0) {
      console.log(`[news-triage] persist_failures=${persistFailures}`);
    }

    if (discoveredRevisions.length > 0) {
      console.log(`✓ Enqueued ${discoveredRevisions.length} new durable AI jobs into waspada.ai_jobs.`);
    }
    // AI-RPM-01: counts only. Requests include concurrent AI jobs, not just triage.
    const callsNow = getNineRouterCallCounts();
    console.log(`  [NineRouter] requests since cycle start: chat=${callsNow.chat - callsAtCycleStart.chat} embed=${callsNow.embed - callsAtCycleStart.embed}`);
    pipelineStatus.recordNineRouterCalls((callsNow.chat - callsAtCycleStart.chat) + (callsNow.embed - callsAtCycleStart.embed));
    } finally {
      pipelineStatus.recordCycleEnd({
        newItemsUsed: triageBudget ? liveCycle.maxNewItemsPerCycle - triageBudget.remaining : null,
        feedsFailed: cycleFeedFailures,
      });
      // REVIEW-EXPIRY-01 (ADR-062): mark undecided proposals past the review TTL as expired. Counts only.
      // It runs inside the isPolling guard, so sweeps never overlap. Errors never reach proposal text.
      try {
        const expiry = await expireStaleProposals({
          executor,
          writer: createEventProposalWriter(executor),
          datasetKind: SERVE_LIVE_DATASET_KIND,
          now: new Date(),
          ttlHours: reviewTtlHours,
        });
        if (expiry.expired > 0 || expiry.failed > 0) {
          console.log(
            `[Review] expired ${expiry.expired} proposals past the ${reviewTtlHours}h review window ` +
            `(skipped_already_decided=${expiry.skipped_already_decided} failed=${expiry.failed})`,
          );
        }
      } catch (err) {
        console.warn(`[Review] expiry sweep failed (${err instanceof Error ? err.name : "unknown error"}).`);
      }
      isPolling = false;
    }
  }

  // Run initial poll cycle now, then repeat every 60 seconds
  void pollLiveFeeds();
  const pollInterval = setInterval(() => {
    void pollLiveFeeds();
  }, 60_000);

  // T8 / FR-13: freshness and expiry run on their own timer, once at startup and then every
  // LIVE_FRESHNESS_INTERVAL_MS (default 5 min). A pass never resolves an incident. Public views
  // are refreshed from the ledger after each pass.
  const freshnessSchedule = startLiveFreshness({ executor, env: process.env });

  // 7. Start Vite Dev Server (Port 5173) for Live Frontend
  console.log("\n[Frontend] Starting Vite development server on http://127.0.0.1:5173...");
  const viteProcess = spawn("npm", ["run", "dev", "--workspace=@waspada/web"], {
    stdio: "inherit",
    shell: true,
  });

  console.log("\n==================================================================");
  console.log("  ALL LIVE SERVICES ARE RUNNING:");
  console.log("  ----------------------------------------------------------------");
  console.log("  Web Application UI   : http://127.0.0.1:5173");
  console.log("  Moderator Review     : http://127.0.0.1:5173/#tinjau-bukti");
  console.log("  Public Incident Map  : http://127.0.0.1:5173/#peta");
  console.log("  3D Embedding Visual  : http://127.0.0.1:5173/#visualisasi-3d");
  console.log("  Live API & Ingestion : http://127.0.0.1:8787/api/v1");
  console.log("  Moderator sign-in    : http://127.0.0.1:5173/#masuk (username and password)");
  console.log("==================================================================");
  console.log("Press Ctrl+C to stop all services.\n");

  const cleanup = () => {
    console.log("\nStopping live testing server and background services...");
    workerActive = false;
    clearInterval(pollInterval);
    freshnessSchedule.stop();
    viteProcess.kill();
    server.close();
    claim.release();
    void database.close().then(() => process.exit(0));
  };

  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
}

main().catch((err) => {
  console.error("Live server error:", err);
  releaseClaim();
  process.exit(1);
});
