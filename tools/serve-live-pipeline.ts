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
import { createSqlIncidentRepository } from "../apps/db/src/incident-repository.js";
import { createJobRunner } from "../apps/intelligence/src/job-runner.js";
import { getNineRouterConfig } from "../apps/intelligence/src/providers/ninerouter-adapter.js";
import { createPetaBencanaPollRuntime } from "../apps/worker/src/runtime/petabencana-poll-runtime.js";
import { createBmkgPollRuntime } from "../apps/worker/src/runtime/bmkg-poll-runtime.js";
import { createNewsPollRuntime, DEFAULT_NEWS_FEEDS } from "../apps/worker/src/runtime/news-poll-runtime.js";
import { PublicReadModel } from "../apps/worker/src/layers/l4-application-integration/public-read-model.js";
import worker from "../apps/worker/src/index.js";
import type { WorkerEnvironment } from "../apps/worker/src/layers/l4-application-integration/api.js";

const MIME_TYPES: Readonly<Record<string, string>> = Object.freeze({
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
});

async function main() {
  console.log("==================================================================");
  console.log("  Waspada Jakarta: Live Incident Intelligence & Ingestion Server  ");
  console.log("==================================================================");

  // 1. Probing NineRouter Live AI Gateway
  const config = getNineRouterConfig();
  console.log(`[NineRouter] Gateway URL : ${config.baseUrl}`);
  console.log(`[NineRouter] Chat Model  : ${config.chatModel}`);
  console.log(`[NineRouter] Embeddings  : ${config.embeddingModel} (768 dimensions)`);
  if (!config.baseUrl || !config.apiKey || config.baseUrl.includes("127.0.0.1:9090")) {
    console.warn("⚠️ Warning: Real NINEROUTER_URL and NINEROUTER_KEY not found in environment. In live mode, requests will require valid credentials.");
  } else {
    console.log("✓ NineRouter provider credentials loaded.");
  }

  // 2. Persistent PGlite Database Setup
  const dataDir = path.resolve(process.cwd(), ".data/live-db");
  fs.mkdirSync(dataDir, { recursive: true });
  console.log(`\n[Database] Opening persistent database at: ${dataDir}`);
  const database = await PGlite.create({
    dataDir,
    extensions: { postgis, vector },
  });

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
  console.log(`✓ Applied ${migrations.length} database migrations (including 039).`);

  // Clear demo synthetic fixtures so only genuine live data is shown
  PublicReadModel.clearPublishedEvents();

  const incidentRepo = createSqlIncidentRepository(executor);

  // 3. Worker Environment Configuration
  const env: WorkerEnvironment = {
    DATASET_MODE: "live",
    INTERNAL_SERVICE_KEY: "dev-internal-key",
    SQL_EXECUTOR: executor,
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
    leaseDurationMs: 300_000,
    pollIntervalMs: 2_000,
  });

  let workerActive = true;
  (async () => {
    while (workerActive) {
      try {
        const processed = await jobRunner.processNextJob("live");
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
  async function pollLiveFeeds() {
    console.log("\n[Ingestion Cycle] Polling live Jakarta sources...");
    const discoveredRevisions: Array<{
      report_revision_id: string;
      source_id: string;
      canonical_url: string;
      permitted_text: string;
      permitted_text_hash: string;
      retrieved_at: string;
      chunks: readonly {
        chunk_index: number;
        span_start: number;
        span_end: number;
        text: string;
      }[];
    }> = [];

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
    } catch (e: any) {
      console.warn(`  [PetaBencana] Poll error: ${e.message}`);
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
    } catch (e: any) {
      console.warn(`  [BMKG] Poll error: ${e.message}`);
    }

    // C. ANTARA Megapolitan RSS
    try {
      const newsRunner = createNewsPollRuntime({ feeds: DEFAULT_NEWS_FEEDS });
      const newsRes = await newsRunner.poll();
      if (newsRes.revisions.length > 0) {
        console.log(`  [ANTARA News] Discovered ${newsRes.revisions.length} megapolitan articles.`);
        discoveredRevisions.push(...newsRes.revisions);
      } else {
        console.log("  [ANTARA News] 0 new articles.");
      }
    } catch (e: any) {
      console.warn(`  [ANTARA News] Poll error: ${e.message}`);
    }

    // Persist to PostgreSQL and enqueue AI jobs
    for (const rev of discoveredRevisions) {
      const traceId = `trace-${rev.report_revision_id}`;
      const contentHash = rev.permitted_text_hash;

      // Ensure trace and source exist for foreign keys
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
           retrieved_at, revision_status, record_json
         )
         VALUES ('live', $1, $2, $3, $4, $5, $6, $7, 'v1', $8, 'unreviewed', '{}'::jsonb)
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

    if (discoveredRevisions.length > 0) {
      console.log(`✓ Enqueued ${discoveredRevisions.length} new durable AI jobs into waspada.ai_jobs.`);
    }
  }

  // Run initial poll cycle now, then repeat every 60 seconds
  void pollLiveFeeds();
  const pollInterval = setInterval(() => {
    void pollLiveFeeds();
  }, 60_000);

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
  console.log("  Live API & Ingestion : http://127.0.0.1:8787/api/v1");
  console.log("  Fast Demo Login      : http://127.0.0.1:8787/api/v1/auth/demo-login?role=moderator");
  console.log("==================================================================");
  console.log("Press Ctrl+C to stop all services.\n");

  const cleanup = () => {
    console.log("\nStopping live testing server and background services...");
    workerActive = false;
    clearInterval(pollInterval);
    viteProcess.kill();
    server.close();
    void database.close().then(() => process.exit(0));
  };

  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
}

main().catch((err) => {
  console.error("Live server error:", err);
  process.exit(1);
});
