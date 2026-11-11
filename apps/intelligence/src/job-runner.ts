import { setTimeout as sleep } from "node:timers/promises";
import type { SqlExecutor, TransactionalSqlExecutor } from "../../db/src/sql.js";
import type { DatasetKind } from "../../db/src/ports.js";
import {
  createSqlIncidentRepository,
  type IncidentRepository,
  type AiJobRecord,
  StaleLeaseError,
} from "../../db/src/incident-repository.js";
import {
  effectiveTriageRequired,
  readLatestAttemptForRevision,
  readTriageDecisionForRevision,
} from "../../db/src/news-triage-store.js";
import {
  createIncidentIntelligenceWorkflow,
  IncidentWorkflowInputSchema,
} from "./workflows/incident-intelligence-workflow.js";
import type { z } from "zod";
type IncidentWorkflowInput = z.infer<typeof IncidentWorkflowInputSchema>;
import { patchGlobalFetchForNineRouter, type NineRouterConfig } from "./providers/ninerouter-adapter.js";
import { findRateLimitedError } from "../../db/src/ninerouter-rate-gate.js";
import { Agent } from "@mastra/core/agent";

/** Cooldown assumed for a rate-limit that arrives without a Retry-After. */
const DEFAULT_RATE_LIMIT_DEFER_MS = 60_000;

export interface JobRunnerOptions {
  readonly executor: SqlExecutor;
  readonly transactionalExecutor?: TransactionalSqlExecutor;
  readonly config?: NineRouterConfig;
  /**
   * Shared secret sent as `x-service-key` when notifying the Worker. Falls back to the
   * INTERNAL_SERVICE_KEY environment variable. With no key, no notification is sent, because
   * the Worker's internal route fails closed without one.
   */
  readonly internalServiceKey?: string;
  /** Base URL of the Worker's internal route. Falls back to WORKER_INTERNAL_URL. */
  readonly workerInternalUrl?: string;
  readonly leaseDurationMs?: number;
  readonly pollIntervalMs?: number;
  readonly agentOverrides?: {
    readonly interpreter?: Agent;
    readonly correlator?: Agent;
  };
}

export function classifyJobError(err: unknown): string {
  if (!err) return "unknown_error";
  // AI-RATE-01: a rate limit is never a model failure. It defers the job and
  // does not consume an attempt (see processNextJob).
  if (findRateLimitedError(err) !== null) return "rate_limited";
  const message = err instanceof Error ? err.message.toLowerCase() : String(err).toLowerCase();
  if (/\b429\b|rate[ _-]?limit|too many requests|quota/.test(message)) {
    return "rate_limited";
  }

  if (message.includes("timeout") || message.includes("timed out") || message.includes("aborted")) {
    return "model_timeout";
  }
  if (message.includes("ninerouter") || message.includes("500") || message.includes("502") || message.includes("503") || message.includes("econnrefused")) {
    return "model_failed";
  }
  if (message.includes("zod") || message.includes("parse") || message.includes("schema") || message.includes("json")) {
    return "invalid_output";
  }
  if (message.includes("stale") || message.includes("lease")) {
    return "stale_lease";
  }
  if (message.includes("syntax") || message.includes("constraint") || message.includes("violates") || message.includes("relation")) {
    return "db_error";
  }
  return "workflow_execution_failed";
}

export function calculateBackoffMs(attemptCount: number): number {
  return Math.min(1000 * Math.pow(2, attemptCount), 60_000);
}

export interface JobRunner {
  processNextJob(datasetKind?: DatasetKind): Promise<boolean>;
  runLoop(signal?: AbortSignal, datasetKind?: DatasetKind): Promise<void>;
  getJob(jobId: string): Promise<AiJobRecord | null>;
  retryJob(jobId: string): Promise<boolean>;
}

export function createJobRunner(options: JobRunnerOptions): JobRunner {
  const incidentRepo: IncidentRepository = createSqlIncidentRepository(options.executor);
  const leaseDurationMs = options.leaseDurationMs ?? 300_000;
  const pollIntervalMs = options.pollIntervalMs ?? 2_000;
  // Every model call from this runner is paced by the shared NineRouter gate.
  patchGlobalFetchForNineRouter();

  const workflow = createIncidentIntelligenceWorkflow({
    executor: options.executor,
    transactionalExecutor: options.transactionalExecutor,
    config: options.config,
    agentOverrides: options.agentOverrides,
  });

  return {
    async processNextJob(datasetKind?: DatasetKind): Promise<boolean> {
      const claim = await incidentRepo.claimAiJob({
        leaseDurationMs,
        datasetKind,
      });

      if (!claim) return false;
      const { job, leaseToken } = claim;

      // Start lease renewal heartbeat
      const heartbeatIntervalMs = Math.max(Math.floor(leaseDurationMs / 3), 10_000);
      let heartbeatActive = true;
      const heartbeatTimer = setInterval(async () => {
        if (!heartbeatActive) return;
        try {
          await incidentRepo.renewAiJob(job.jobId, leaseToken, leaseDurationMs);
        } catch {
          // Heartbeat failure ignored; will fail or complete eventually
        }
      }, heartbeatIntervalMs);

      try {
        // Load report revision from database
        interface RevisionDbRow {
          readonly report_revision_id: string;
          readonly dataset_kind: DatasetKind;
          readonly trace_id: string;
          readonly source_id: string;
          readonly permitted_text: string;
          readonly retrieved_at: string | Date;
          readonly display_name: string | null;
          readonly source_kind: string | null;
          readonly triage_required: boolean;
        }

        const revResult = await options.executor.query<RevisionDbRow>(
          `SELECT
             r.report_revision_id, r.dataset_kind, r.trace_id, r.source_id,
             r.permitted_text, r.retrieved_at, r.triage_required,
             s.display_name, s.source_kind
           FROM waspada.report_revisions r
           LEFT JOIN waspada.source_registry s ON s.source_id = r.source_id
           WHERE r.dataset_kind = $1 AND r.report_revision_id = $2
           LIMIT 1`,
          [job.datasetKind, job.reportRevisionId],
        );

        if (revResult.rows.length === 0) {
          throw new Error(`Report revision ${job.reportRevisionId} not found`);
        }

        const rev = revResult.rows[0];

        // Load evidence chunks
        interface ChunkDbRow {
          readonly chunk_id: string;
          readonly span_start: number;
          readonly span_end: number;
        }

        const chunksResult = await options.executor.query<ChunkDbRow>(
          `SELECT chunk_id, span_start, span_end
           FROM waspada.evidence_chunks
           WHERE dataset_kind = $1 AND report_revision_id = $2 AND status = 'active'
           ORDER BY span_start ASC`,
          [job.datasetKind, job.reportRevisionId],
        );

        const permittedTextChars = Array.from(rev.permitted_text);
        const evidenceChunks = chunksResult.rows.map((chk) => ({
          chunkId: chk.chunk_id,
          spanStart: chk.span_start,
          spanEnd: chk.span_end,
          text: permittedTextChars.slice(chk.span_start, chk.span_end).join(""),
        }));

        // If no pre-existing chunks in DB, use full text as single chunk
        if (evidenceChunks.length === 0) {
          evidenceChunks.push({
            chunkId: `chk-${job.reportRevisionId}-0`,
            spanStart: 0,
            spanEnd: permittedTextChars.length,
            text: rev.permitted_text,
          });
        }

        // WJ-INT-02B explicit-provenance triage gate via effectiveTriageRequired().
        // `triage_required` marks RSS-origin revisions; false means
        // structured/webhook/synthetic and runs untriaged exactly as before.
        // Synthetic rows never require triage even when the flag is set:
        // migration 042's backfill predicate (source_revision_key IS NOT NULL)
        // was over-broad on synthetic rows, and report_revisions is append-only
        // (001 trigger rejects UPDATE), so the historical flag cannot be
        // rewritten. Required-RSS revisions load the revision-specific decision
        // AND latest attempt; either missing or non-ingest routes to
        // needs_review. Lookup errors propagate into the existing retry/error
        // path — never swallowed into an untriaged run.
        // Consistency: the decision and attempt must agree on revision,
        // content, policy, disposition, and category — otherwise the
        // evaluation does not describe this revision and cannot authorize it.
        let triageContext: IncidentWorkflowInput["triage"] | undefined;
        const triageRequiredForDataset = effectiveTriageRequired({
          triage_required: rev.triage_required === true,
          dataset_kind: rev.dataset_kind,
        });
        if (triageRequiredForDataset) {
          const triageRow = await readTriageDecisionForRevision(
            options.executor,
            rev.dataset_kind,
            rev.report_revision_id,
          );
          if (!triageRow) {
            await incidentRepo.markAiJobNeedsReview(job.jobId, leaseToken, "triage_decision_missing");
            return false;
          }
          const latestAttempt = await readLatestAttemptForRevision(
            options.executor,
            rev.dataset_kind,
            rev.report_revision_id,
          );
          if (!latestAttempt) {
            await incidentRepo.markAiJobNeedsReview(job.jobId, leaseToken, "triage_decision_missing");
            return false;
          }
          const attemptRevision = await options.executor.query<{ content_hash: string }>(
            `SELECT content_hash FROM waspada.report_revisions
             WHERE dataset_kind = $1 AND report_revision_id = $2 LIMIT 1`,
            [rev.dataset_kind, rev.report_revision_id],
          );
          const revisionContentHash = attemptRevision.rows[0]?.content_hash ?? null;
          const consistent =
            triageRow.reportRevisionId === rev.report_revision_id &&
            latestAttempt.reportRevisionId === rev.report_revision_id &&
            triageRow.disposition === "ingest" &&
            latestAttempt.disposition === "ingest" &&
            triageRow.disposition === latestAttempt.disposition &&
            (triageRow.contentHash ?? null) === (latestAttempt.contentHash ?? null) &&
            (revisionContentHash === null || (triageRow.contentHash ?? null) === revisionContentHash) &&
            triageRow.policyVersion === latestAttempt.policyVersion &&
            (triageRow.primaryCategory ?? null) === (latestAttempt.primaryCategory ?? null) &&
            (triageRow.itemIdentityHash ?? null) === (latestAttempt.itemIdentityHash ?? null);
          if (!consistent) {
            const held = triageRow.disposition !== "ingest" || latestAttempt.disposition !== "ingest";
            await incidentRepo.markAiJobNeedsReview(
              job.jobId,
              leaseToken,
              held ? "triage_decision_held" : "triage_decision_missing",
            );
            return false;
          }
          triageContext = {
            disposition: "ingest",
            primaryCategory: triageRow.primaryCategory,
            incidentType: triageRow.incidentType,
            jakartaScope: triageRow.jakartaScope,
            actionability: triageRow.actionability,
            confidence: triageRow.confidence,
            itemIdentityHash: triageRow.itemIdentityHash,
          };
        }

        const workflowInput: IncidentWorkflowInput = {
          jobId: job.jobId,
          leaseToken,
          reportRevisionId: rev.report_revision_id,
          reportText: rev.permitted_text,
          sourceKind: rev.source_kind || "webhook",
          sourceDisplayName: rev.display_name || "Laporan Lapangan",
          sourceId: rev.source_id,
          publishedAt: new Date(rev.retrieved_at).toISOString(),
          datasetKind: rev.dataset_kind,
          traceId: job.traceId || rev.trace_id || `trace-${job.jobId}`,
          evidenceChunks,
          ...(triageContext ? { triage: triageContext } : {}),
        };

        // Execute Mastra Workflow
        const run = await workflow.createRun();
        const execution = await run.start({ inputData: workflowInput });

        if (execution.status !== "success") {
          const stepErrors: string[] = [];
          const rawErrors: unknown[] = [];
          if (execution.steps) {
            for (const [stepName, stepData] of Object.entries(execution.steps as Record<string, any>)) {
              if (stepData?.error) {
                rawErrors.push(stepData.error);
                stepErrors.push(`${stepName}: ${stepData.error instanceof Error ? stepData.error.message : String(stepData.error)}`);
              }
            }
          }
          const rootErr = (execution as any).error;
          if (rootErr) rawErrors.push(rootErr);
          // AI-RATE-01: keep the rate-limit error itself so its code survives the
          // workflow boundary. Rebuilding it from messages would lose the code.
          for (const raw of rawErrors) {
            if (findRateLimitedError(raw) !== null) {
              throw raw;
            }
          }
          const rootErrMsg = rootErr ? (rootErr instanceof Error ? rootErr.message : String(rootErr)) : "";
          const combinedMsg = [rootErrMsg, ...stepErrors].filter(Boolean).join(" | ");
          throw new Error(combinedMsg || `Mastra workflow execution failed with status: ${execution.status}`);
        }

        // Complete job
        await incidentRepo.completeAiJob(job.jobId, leaseToken);

        // Notify the moderation Worker. Without a configured key the notification is skipped.
        const workerUrl = options.workerInternalUrl || process.env.WORKER_INTERNAL_URL || "http://127.0.0.1:8787";
        const internalServiceKey = options.internalServiceKey || process.env.INTERNAL_SERVICE_KEY || "";
        // INTEL-02: notify with the proposal ID the workflow persisted. The old `prop-<revisionId>`
        // matched no proposal row, so the moderation event pointed at nothing.
        const persistedProposalId = (execution.result as { proposal?: { proposal_id?: unknown } } | undefined)
          ?.proposal?.proposal_id;
        if (typeof persistedProposalId === "string" && internalServiceKey.length > 0) {
          try {
            await fetch(`${workerUrl}/api/v1/internal/proposals`, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "x-service-key": internalServiceKey,
              },
              body: JSON.stringify({ proposal_id: persistedProposalId }),
              signal: AbortSignal.timeout(3000),
            });
          } catch {
            // Notification failure is non-fatal: PostgreSQL transaction is already committed
          }
        }

        return true;
      } catch (err) {
        if (err instanceof StaleLeaseError) {
          // Worker was preempted or lost lease; another worker has ownership, do not mutate job status
          return false;
        }
        const failureCode = classifyJobError(err);
        if (failureCode === "rate_limited") {
          // AI-RATE-01: defer without counting the attempt. The job never reaches needs_review.
          const retryAfterMs = findRateLimitedError(err)?.retryAfterMs ?? DEFAULT_RATE_LIMIT_DEFER_MS;
          try {
            await incidentRepo.deferAiJob({
              jobId: job.jobId,
              leaseToken,
              availableAt: new Date(Date.now() + Math.max(0, retryAfterMs)).toISOString(),
              failureCode: "rate_limited",
            });
          } catch (deferErr) {
            if (deferErr instanceof StaleLeaseError) return false;
            throw deferErr;
          }
          return false;
        }
        const backoffMs = calculateBackoffMs(job.attemptCount);
        await incidentRepo.failAiJob(job.jobId, leaseToken, failureCode, backoffMs);
        return false;
      } finally {
        heartbeatActive = false;
        clearInterval(heartbeatTimer);
      }
    },
    async getJob(jobId: string) {
      return incidentRepo.getAiJob(jobId);
    },

    async retryJob(jobId: string) {
      return incidentRepo.retryAiJob(jobId);
    },

    async runLoop(signal?: AbortSignal, datasetKind?: DatasetKind): Promise<void> {
      while (!signal?.aborted) {
        try {
          const hadWork = await this.processNextJob(datasetKind);
          if (!hadWork) {
            await sleep(pollIntervalMs, undefined, { signal });
          }
        } catch {
          await sleep(pollIntervalMs, undefined, { signal });
        }
      }
    },
  };
}
