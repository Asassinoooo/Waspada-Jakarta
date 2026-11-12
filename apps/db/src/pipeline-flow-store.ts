/**
 * FLOW-VIS-01: read-only aggregates and drill-downs for the live agent pipeline view.
 *
 * Every query runs in one READ ONLY transaction under the `waspada_l4_pipeline_flow_reader`
 * role (migration 047), so the view gets only the columns it needs. Drill-downs return metadata
 * only: ids, short titles where the table has one, statuses, failure codes and timestamps. No
 * permitted text, chunk text, prompts, model output, vectors, URLs or keys are selected.
 */
import type { TransactionalSqlExecutor, SqlExecutor } from "./sql.js";
import type { DatasetKind } from "./ports.js";

export const PIPELINE_FLOW_READ_ROLE = "waspada_l4_pipeline_flow_reader" as const;
export const PIPELINE_FLOW_ITEM_CAP = 20;

export type PipelineFlowSourceFamily = "petabencana" | "bmkg" | "rss";

export interface PipelineFlowSourceAggregate {
  readonly family: PipelineFlowSourceFamily;
  readonly sources: number;
  readonly healthy: number;
  readonly unhealthy: number;
  readonly revisions_24h: number;
  readonly revisions_15m: number;
  readonly acquisition_waiting: number;
  readonly acquisition_running: number;
  readonly acquisition_failed_15m: number;
  readonly acquisition_failed_24h: number;
}

export interface PipelineFlowAggregates {
  readonly dataset_kind: DatasetKind;
  readonly generated_at: string;
  readonly sources: readonly PipelineFlowSourceAggregate[];
  readonly revisions: {
    readonly by_status_24h: Readonly<Record<string, number>>;
    readonly revisions_15m: number;
    readonly active_chunks: number;
  };
  readonly triage: {
    /** Stage B decisions (model_status ok) by disposition, 24 h. */
    readonly dispositions_24h: Readonly<Record<string, number>>;
    /** Every model-backed row by model_status, 24 h (includes rate_limited and failures). */
    readonly model_status_24h: Readonly<Record<string, number>>;
    readonly decisions_15m: number;
    readonly failures_15m: number;
    readonly rate_limited_15m: number;
    readonly skipped_stage_a_24h: number;
    readonly skipped_stage_a_15m: number;
  };
  readonly ai_jobs: {
    readonly pending: number;
    readonly leased: number;
    readonly retry: number;
    readonly needs_review: number;
    readonly completed_24h: number;
    readonly terminal_24h: number;
    readonly completed_15m: number;
    readonly terminal_15m: number;
    readonly checkpointed_open: number;
    readonly checkpointed_15m: number;
  };
  readonly embeddings: {
    readonly available_24h: number;
    readonly failed_24h: number;
    readonly invalidated_24h: number;
    readonly available_15m: number;
    readonly failed_15m: number;
  };
  readonly correlation: {
    readonly by_decision_24h: Readonly<Record<string, number>>;
    readonly decisions_15m: number;
    readonly incidents_open: number;
  };
  readonly proposals: {
    readonly proposed_24h: number;
    readonly proposed_15m: number;
    readonly pending: number;
    readonly pending_discrepancy: number;
  };
  readonly publication: {
    readonly decisions_24h: Readonly<Record<string, number>>;
    readonly decisions_15m: number;
    readonly moderator_decisions_15m: number;
    /** REVIEW-EXPIRY-01: `expire` decisions in 24 h. Kept out of decisions_24h and decisions_15m. */
    readonly expired_24h: number;
    readonly events_published: number;
    readonly versions_24h: number;
    readonly versions_15m: number;
    readonly versions_agent_24h: number;
    readonly versions_moderator_24h: number;
  };
}

export interface PipelineFlowStoredItem {
  readonly ref: string;
  readonly status: string;
  readonly failure_code: string | null;
  readonly title: string | null;
  readonly at: string | null;
}

/** Nodes whose drill-down comes from the database. Runtime-only nodes are answered by the Worker. */
export const PIPELINE_FLOW_DB_ITEM_NODES = [
  "src_petabencana", "src_bmkg", "src_rss", "revisions", "det_filter", "triage", "ai_queue",
  "interpret", "embed", "retrieve", "correlate", "proposal", "gate", "review", "published",
] as const;
export type PipelineFlowDbItemNode = (typeof PIPELINE_FLOW_DB_ITEM_NODES)[number];

interface Queryable {
  query<Row extends object>(statement: string, parameters?: readonly unknown[]): Promise<{ readonly rows: readonly Row[] }>;
  execute(statement: string): Promise<void>;
}

/** Source family from registry metadata. PetaBencana and BMKG have fixed ids; everything else with RSS access is RSS. */
const FAMILY_SQL = `CASE
  WHEN sr.source_id = 'petabencana' OR sr.source_id LIKE 'petabencana%' THEN 'petabencana'
  WHEN sr.source_id LIKE 'source-bmkg%' THEN 'bmkg'
  WHEN sr.access_method = 'rss' THEN 'rss'
  ELSE NULL END`;

function toCount(value: unknown): number {
  const n = typeof value === "string" ? Number(value) : typeof value === "number" ? value : 0;
  return Number.isFinite(n) ? n : 0;
}

function toInstant(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

async function beginReadOnly(tx: Queryable): Promise<void> {
  await tx.execute("SET TRANSACTION READ ONLY");
  await tx.execute(`SET LOCAL ROLE ${PIPELINE_FLOW_READ_ROLE}`);
}

export interface PipelineFlowStore {
  readAggregates(input: { readonly datasetKind: DatasetKind; readonly now: Date }): Promise<PipelineFlowAggregates>;
  readItems(input: {
    readonly datasetKind: DatasetKind;
    readonly node: PipelineFlowDbItemNode;
    readonly now: Date;
    readonly limit: number;
  }): Promise<readonly PipelineFlowStoredItem[]>;
}

export function createPipelineFlowStore(executor: TransactionalSqlExecutor): PipelineFlowStore {
  if (typeof executor.transaction !== "function") {
    throw new TypeError("The pipeline flow store requires a transaction-capable executor.");
  }

  async function inReadTransaction<Result>(work: (tx: Queryable & SqlExecutor) => Promise<Result>): Promise<Result> {
    return executor.transaction(async (tx) => {
      await beginReadOnly(tx as Queryable);
      return work(tx as Queryable & SqlExecutor);
    });
  }

  return {
    async readAggregates({ datasetKind, now }) {
      const since24h = new Date(now.getTime() - 24 * 3_600_000).toISOString();
      const since15m = new Date(now.getTime() - 15 * 60_000).toISOString();
      return inReadTransaction(async (tx) => {
        const sourceRows = await tx.query<{
          family: string;
          sources: unknown;
          healthy: unknown;
          unhealthy: unknown;
        }>(
          `SELECT ${FAMILY_SQL} AS family,
                  count(*) AS sources,
                  count(*) FILTER (WHERE sr.health_status = 'healthy') AS healthy,
                  count(*) FILTER (WHERE sr.health_status IN ('degraded', 'unavailable')) AS unhealthy
             FROM waspada.source_registry sr
            WHERE sr.registry_status = 'active' AND sr.approval_status = 'approved'
            GROUP BY 1`,
        );

        const revisionRows = await tx.query<{ family: string; revisions_24h: unknown; revisions_15m: unknown }>(
          `SELECT ${FAMILY_SQL} AS family,
                  count(*) AS revisions_24h,
                  count(*) FILTER (WHERE rr.retrieved_at >= $3::timestamptz) AS revisions_15m
             FROM waspada.report_revisions rr
             JOIN waspada.source_registry sr ON sr.source_id = rr.source_id
            WHERE rr.dataset_kind = $1 AND rr.retrieved_at >= $2::timestamptz
            GROUP BY 1`,
          [datasetKind, since24h, since15m],
        );

        const acquisitionRows = await tx.query<{
          family: string;
          waiting: unknown;
          running: unknown;
          failed_15m: unknown;
          failed_24h: unknown;
        }>(
          `SELECT ${FAMILY_SQL} AS family,
                  count(*) FILTER (WHERE aj.status IN ('pending', 'retry')) AS waiting,
                  count(*) FILTER (WHERE aj.status = 'leased') AS running,
                  count(*) FILTER (WHERE aj.status = 'terminal' AND aj.updated_at >= $3::timestamptz) AS failed_15m,
                  count(*) FILTER (WHERE aj.status = 'terminal' AND aj.updated_at >= $2::timestamptz) AS failed_24h
             FROM waspada.acquisition_jobs aj
             JOIN waspada.source_registry sr ON sr.source_id = aj.source_id
            WHERE aj.dataset_kind = $1 AND aj.job_kind = 'source_poll'
            GROUP BY 1`,
          [datasetKind, since24h, since15m],
        );

        const revisionStatusRows = await tx.query<{ revision_status: string; n: unknown }>(
          `SELECT rr.revision_status, count(*) AS n
             FROM waspada.report_revisions rr
            WHERE rr.dataset_kind = $1 AND rr.retrieved_at >= $2::timestamptz
            GROUP BY 1`,
          [datasetKind, since24h],
        );
        const activeChunks = await tx.query<{ n: unknown }>(
          `SELECT count(*) AS n FROM waspada.evidence_chunks ec WHERE ec.dataset_kind = $1 AND ec.status = 'active'`,
          [datasetKind],
        );

        const triageRows = await tx.query<{ disposition: string; model_status: string; n: unknown; n_15m: unknown }>(
          `SELECT ntd.disposition, ntd.model_status,
                  count(*) AS n,
                  count(*) FILTER (WHERE ntd.evaluated_at >= $3::timestamptz) AS n_15m
             FROM waspada.news_triage_decisions ntd
            WHERE ntd.dataset_kind = $1 AND ntd.evaluated_at >= $2::timestamptz
            GROUP BY 1, 2`,
          [datasetKind, since24h, since15m],
        );

        const jobRows = await tx.query<Record<string, unknown>>(
          `SELECT
             count(*) FILTER (WHERE aj.status = 'pending') AS pending,
             count(*) FILTER (WHERE aj.status = 'leased') AS leased,
             count(*) FILTER (WHERE aj.status = 'retry') AS retry,
             count(*) FILTER (WHERE aj.status = 'needs_review') AS needs_review,
             count(*) FILTER (WHERE aj.status = 'completed' AND aj.finished_at >= $2::timestamptz) AS completed_24h,
             count(*) FILTER (WHERE aj.status = 'terminal' AND aj.finished_at >= $2::timestamptz) AS terminal_24h,
             count(*) FILTER (WHERE aj.status = 'completed' AND aj.finished_at >= $3::timestamptz) AS completed_15m,
             count(*) FILTER (WHERE aj.status = 'terminal' AND aj.finished_at >= $3::timestamptz) AS terminal_15m,
             count(*) FILTER (WHERE aj.status IN ('pending', 'leased', 'retry') AND aj.has_interpretation) AS checkpointed_open,
             count(*) FILTER (WHERE aj.has_interpretation AND aj.updated_at >= $3::timestamptz) AS checkpointed_15m
           FROM waspada.pipeline_flow_ai_jobs aj
           WHERE aj.dataset_kind = $1`,
          [datasetKind, since24h, since15m],
        );

        const embeddingRows = await tx.query<{ status: string; n: unknown; n_15m: unknown }>(
          `SELECT er.status,
                  count(*) AS n,
                  count(*) FILTER (WHERE er.created_at >= $3::timestamptz) AS n_15m
             FROM waspada.embedding_runs er
            WHERE er.dataset_kind = $1 AND er.created_at >= $2::timestamptz
            GROUP BY 1`,
          [datasetKind, since24h, since15m],
        );

        const correlationRows = await tx.query<{ decision: string; n: unknown; n_15m: unknown }>(
          `SELECT icd.decision, count(*) AS n, count(*) FILTER (WHERE icd.created_at >= $3::timestamptz) AS n_15m
             FROM waspada.incident_correlation_decisions icd
            WHERE icd.dataset_kind = $1 AND icd.created_at >= $2::timestamptz
            GROUP BY 1`,
          [datasetKind, since24h, since15m],
        );
        const incidentRows = await tx.query<{ n: unknown }>(
          `SELECT count(*) AS n FROM waspada.incidents i
            WHERE i.dataset_kind = $1 AND i.status IN ('investigating', 'active', 'monitoring')`,
          [datasetKind],
        );

        const proposalRows = await tx.query<Record<string, unknown>>(
          `SELECT
             count(*) FILTER (WHERE ep.proposed_at >= $2::timestamptz) AS proposed_24h,
             count(*) FILTER (WHERE ep.proposed_at >= $3::timestamptz) AS proposed_15m,
             count(*) FILTER (WHERE pd.proposal_id IS NULL) AS pending,
             count(*) FILTER (WHERE pd.proposal_id IS NULL AND ep.has_discrepancy = true) AS pending_discrepancy
           FROM waspada.pipeline_flow_proposals ep
           LEFT JOIN waspada.pipeline_flow_decisions pd
             ON pd.dataset_kind = ep.dataset_kind AND pd.proposal_id = ep.proposal_id
          WHERE ep.dataset_kind = $1`,
          [datasetKind, since24h, since15m],
        );

        const decisionRows = await tx.query<{ disposition: string | null; actor_kind: string | null; n: unknown; n_15m: unknown }>(
          `SELECT pd.disposition AS disposition,
                  pd.actor_kind AS actor_kind,
                  count(*) AS n,
                  count(*) FILTER (WHERE pd.decided_at >= $3::timestamptz) AS n_15m
             FROM waspada.pipeline_flow_decisions pd
            WHERE pd.dataset_kind = $1 AND pd.decided_at >= $2::timestamptz
            GROUP BY 1, 2`,
          [datasetKind, since24h, since15m],
        );

        const versionRows = await tx.query<Record<string, unknown>>(
          `SELECT
             count(DISTINCT ev.event_id) AS events_published,
             count(*) FILTER (WHERE ev.published_at >= $2::timestamptz) AS versions_24h,
             count(*) FILTER (WHERE ev.published_at >= $3::timestamptz) AS versions_15m,
             count(*) FILTER (WHERE ev.published_at >= $2::timestamptz AND ev.publication_mode = 'agent_auto') AS versions_agent_24h,
             count(*) FILTER (WHERE ev.published_at >= $2::timestamptz AND ev.publication_mode = 'moderator_reviewed') AS versions_moderator_24h
           FROM waspada.pipeline_flow_versions ev
          WHERE ev.dataset_kind = $1 AND ev.publication_status = 'published'`,
          [datasetKind, since24h, since15m],
        );

        const byKey = <T extends { n: unknown }>(rows: readonly T[], key: (row: T) => string) => {
          const out: Record<string, number> = {};
          for (const row of rows) out[key(row)] = (out[key(row)] ?? 0) + toCount(row.n);
          return out;
        };
        const jobs = jobRows.rows[0] ?? {};
        const proposals = proposalRows.rows[0] ?? {};
        const versions = versionRows.rows[0] ?? {};
        // REVIEW-EXPIRY-01: expired proposals were never decided by a person or the publisher, so they
        // do not count as publication decisions. They are counted separately as expired_24h.
        const publicationRows = decisionRows.rows.filter((row) => row.disposition !== "expire");
        const triageAll = triageRows.rows;
        const skipped = triageAll.filter((row) => row.model_status === "skipped_stage_a");
        const modelled = triageAll.filter((row) => row.model_status !== "skipped_stage_a");
        const sumWhere = (rows: typeof triageAll, pred: (row: (typeof triageAll)[number]) => boolean, field: "n" | "n_15m") =>
          rows.filter(pred).reduce((total, row) => total + toCount(row[field]), 0);

        const embeddingBy = (status: string, field: "n" | "n_15m") =>
          embeddingRows.rows.filter((row) => row.status === status).reduce((total, row) => total + toCount(row[field]), 0);

        return {
          dataset_kind: datasetKind,
          generated_at: now.toISOString(),
          sources: sourceRows.rows
            .filter((row): row is typeof row & { family: PipelineFlowSourceFamily } =>
              row.family === "petabencana" || row.family === "bmkg" || row.family === "rss")
            .map((row) => {
              const revisions = revisionRows.rows.find((r) => r.family === row.family);
              const jobsFor = acquisitionRows.rows.find((r) => r.family === row.family);
              return {
                family: row.family,
                sources: toCount(row.sources),
                healthy: toCount(row.healthy),
                unhealthy: toCount(row.unhealthy),
                revisions_24h: toCount(revisions?.revisions_24h),
                revisions_15m: toCount(revisions?.revisions_15m),
                acquisition_waiting: toCount(jobsFor?.waiting),
                acquisition_running: toCount(jobsFor?.running),
                acquisition_failed_15m: toCount(jobsFor?.failed_15m),
                acquisition_failed_24h: toCount(jobsFor?.failed_24h),
              };
            }),
          revisions: {
            by_status_24h: byKey(revisionStatusRows.rows, (row) => row.revision_status),
            revisions_15m: revisionRows.rows.reduce((total, row) => total + toCount(row.revisions_15m), 0),
            active_chunks: toCount(activeChunks.rows[0]?.n),
          },
          triage: {
            dispositions_24h: byKey(modelled.filter((row) => row.model_status === "ok"), (row) => row.disposition),
            model_status_24h: byKey(modelled, (row) => row.model_status),
            decisions_15m: sumWhere(modelled, () => true, "n_15m"),
            failures_15m: sumWhere(modelled, (row) => row.model_status === "provider_error" || row.model_status === "invalid_model_output", "n_15m"),
            rate_limited_15m: sumWhere(modelled, (row) => row.model_status === "rate_limited", "n_15m"),
            skipped_stage_a_24h: sumWhere(skipped, () => true, "n"),
            skipped_stage_a_15m: sumWhere(skipped, () => true, "n_15m"),
          },
          ai_jobs: {
            pending: toCount(jobs.pending),
            leased: toCount(jobs.leased),
            retry: toCount(jobs.retry),
            needs_review: toCount(jobs.needs_review),
            completed_24h: toCount(jobs.completed_24h),
            terminal_24h: toCount(jobs.terminal_24h),
            completed_15m: toCount(jobs.completed_15m),
            terminal_15m: toCount(jobs.terminal_15m),
            checkpointed_open: toCount(jobs.checkpointed_open),
            checkpointed_15m: toCount(jobs.checkpointed_15m),
          },
          embeddings: {
            available_24h: embeddingBy("available", "n"),
            failed_24h: embeddingBy("failed", "n"),
            invalidated_24h: embeddingBy("invalidated", "n"),
            available_15m: embeddingBy("available", "n_15m"),
            failed_15m: embeddingBy("failed", "n_15m"),
          },
          correlation: {
            by_decision_24h: byKey(correlationRows.rows, (row) => row.decision),
            decisions_15m: correlationRows.rows.reduce((total, row) => total + toCount(row.n_15m), 0),
            incidents_open: toCount(incidentRows.rows[0]?.n),
          },
          proposals: {
            proposed_24h: toCount(proposals.proposed_24h),
            proposed_15m: toCount(proposals.proposed_15m),
            pending: toCount(proposals.pending),
            pending_discrepancy: toCount(proposals.pending_discrepancy),
          },
          publication: {
            decisions_24h: byKey(publicationRows, (row) => `${row.disposition ?? "unknown"}_${row.actor_kind ?? "unknown"}`),
            decisions_15m: publicationRows.reduce((total, row) => total + toCount(row.n_15m), 0),
            moderator_decisions_15m: publicationRows
              .filter((row) => row.actor_kind === "moderator")
              .reduce((total, row) => total + toCount(row.n_15m), 0),
            expired_24h: decisionRows.rows
              .filter((row) => row.disposition === "expire")
              .reduce((total, row) => total + toCount(row.n), 0),
            events_published: toCount(versions.events_published),
            versions_24h: toCount(versions.versions_24h),
            versions_15m: toCount(versions.versions_15m),
            versions_agent_24h: toCount(versions.versions_agent_24h),
            versions_moderator_24h: toCount(versions.versions_moderator_24h),
          },
        };
      });
    },

    async readItems({ datasetKind, node, now, limit }) {
      const cap = Math.max(1, Math.min(PIPELINE_FLOW_ITEM_CAP, Math.trunc(limit)));
      const since24h = new Date(now.getTime() - 24 * 3_600_000).toISOString();
      return inReadTransaction(async (tx) => {
        switch (node) {
          case "src_petabencana":
          case "src_bmkg":
          case "src_rss":
          case "revisions": {
            const family = node === "src_petabencana" ? "petabencana" : node === "src_bmkg" ? "bmkg" : node === "src_rss" ? "rss" : null;
            const rows = await tx.query<{ ref: string; status: string; at: unknown }>(
              `SELECT rr.report_revision_id AS ref, rr.revision_status AS status, rr.retrieved_at AS at
                 FROM waspada.report_revisions rr
                 JOIN waspada.source_registry sr ON sr.source_id = rr.source_id
                WHERE rr.dataset_kind = $1 AND rr.retrieved_at >= $2::timestamptz
                  AND ($3::text IS NULL OR ${FAMILY_SQL} = $3::text)
                ORDER BY rr.retrieved_at DESC, rr.report_revision_id DESC
                LIMIT $4`,
              [datasetKind, since24h, family, cap],
            );
            return rows.rows.map((row) => ({ ref: row.ref, status: row.status, failure_code: null, title: null, at: toInstant(row.at) }));
          }
          case "det_filter":
          case "triage": {
            const skipped = node === "det_filter";
            const rows = await tx.query<{ ref: string; disposition: string; model_status: string; at: unknown }>(
              `SELECT left(ntd.item_identity_hash, 12) AS ref, ntd.disposition, ntd.model_status, ntd.evaluated_at AS at
                 FROM waspada.news_triage_decisions ntd
                WHERE ntd.dataset_kind = $1 AND ntd.evaluated_at >= $2::timestamptz
                  AND ((ntd.model_status = 'skipped_stage_a') = $3::boolean)
                ORDER BY ntd.evaluated_at DESC, ntd.item_identity_hash DESC
                LIMIT $4`,
              [datasetKind, since24h, skipped, cap],
            );
            return rows.rows.map((row) => ({
              ref: row.ref,
              status: row.disposition,
              failure_code: row.model_status === "ok" || row.model_status === "skipped_stage_a" ? null : row.model_status,
              title: null,
              at: toInstant(row.at),
            }));
          }
          case "ai_queue": {
            const rows = await tx.query<{ ref: string; status: string; failure_code: string | null; at: unknown }>(
              `SELECT aj.job_id AS ref, aj.status, aj.last_failure_code AS failure_code, aj.updated_at AS at
                 FROM waspada.pipeline_flow_ai_jobs aj
                WHERE aj.dataset_kind = $1
                  AND (aj.status IN ('pending', 'leased', 'retry', 'needs_review') OR aj.updated_at >= $2::timestamptz)
                ORDER BY aj.updated_at DESC, aj.job_id DESC
                LIMIT $3`,
              [datasetKind, since24h, cap],
            );
            return rows.rows.map((row) => ({ ref: row.ref, status: row.status, failure_code: row.failure_code, title: null, at: toInstant(row.at) }));
          }
          case "interpret": {
            const rows = await tx.query<{ ref: string; status: string; failure_code: string | null; at: unknown }>(
              `SELECT aj.job_id AS ref, aj.status, aj.last_failure_code AS failure_code, aj.updated_at AS at
                 FROM waspada.pipeline_flow_ai_jobs aj
                WHERE aj.dataset_kind = $1 AND aj.has_interpretation
                ORDER BY aj.updated_at DESC, aj.job_id DESC
                LIMIT $2`,
              [datasetKind, cap],
            );
            return rows.rows.map((row) => ({ ref: row.ref, status: row.status, failure_code: row.failure_code, title: null, at: toInstant(row.at) }));
          }
          case "embed":
          case "retrieve": {
            const rows = await tx.query<{ ref: string; status: string; at: unknown }>(
              `SELECT er.embedding_run_id AS ref, er.status, er.created_at AS at
                 FROM waspada.embedding_runs er
                WHERE er.dataset_kind = $1 AND er.created_at >= $2::timestamptz
                  AND ($3::text = 'embed' OR er.status = 'available')
                ORDER BY er.created_at DESC, er.embedding_run_id DESC
                LIMIT $4`,
              [datasetKind, since24h, node, cap],
            );
            return rows.rows.map((row) => ({ ref: row.ref, status: row.status, failure_code: null, title: null, at: toInstant(row.at) }));
          }
          case "correlate": {
            const rows = await tx.query<{ ref: string; status: string; at: unknown }>(
              `SELECT icd.decision_id AS ref, icd.decision AS status, icd.created_at AS at
                 FROM waspada.incident_correlation_decisions icd
                WHERE icd.dataset_kind = $1 AND icd.created_at >= $2::timestamptz
                ORDER BY icd.created_at DESC, icd.decision_id DESC
                LIMIT $3`,
              [datasetKind, since24h, cap],
            );
            return rows.rows.map((row) => ({ ref: row.ref, status: row.status, failure_code: null, title: null, at: toInstant(row.at) }));
          }
          case "proposal": {
            const rows = await tx.query<{ ref: string; title: string | null; decided: boolean; disposition: string | null; at: unknown }>(
              `SELECT ep.proposal_id AS ref,
                      ep.title AS title,
                      (pd.proposal_id IS NOT NULL) AS decided,
                      pd.disposition AS disposition,
                      ep.proposed_at AS at
                 FROM waspada.pipeline_flow_proposals ep
                 LEFT JOIN waspada.pipeline_flow_decisions pd
                   ON pd.dataset_kind = ep.dataset_kind AND pd.proposal_id = ep.proposal_id
                WHERE ep.dataset_kind = $1 AND ep.proposed_at >= $2::timestamptz
                ORDER BY ep.proposed_at DESC, ep.proposal_id DESC
                LIMIT $3`,
              [datasetKind, since24h, cap],
            );
            return rows.rows.map((row) => ({
              ref: row.ref,
              status: row.disposition === "expire" ? "kedaluwarsa" : row.decided ? "diputuskan" : "menunggu",
              failure_code: null,
              title: truncateTitle(row.title),
              at: toInstant(row.at),
            }));
          }
          case "gate": {
            const rows = await tx.query<{ ref: string; disposition: string; actor_kind: string; at: unknown }>(
              `SELECT pd.proposal_id AS ref, pd.disposition AS disposition,
                      pd.actor_kind AS actor_kind, pd.decided_at AS at
                 FROM waspada.pipeline_flow_decisions pd
                WHERE pd.dataset_kind = $1 AND pd.decided_at >= $2::timestamptz
                  AND pd.disposition IS DISTINCT FROM 'expire'
                ORDER BY pd.decided_at DESC, pd.decision_id DESC
                LIMIT $3`,
              [datasetKind, since24h, cap],
            );
            return rows.rows.map((row) => ({
              ref: row.ref,
              status: `${row.disposition ?? "unknown"}_${row.actor_kind ?? "unknown"}`,
              failure_code: null,
              title: null,
              at: toInstant(row.at),
            }));
          }
          case "review": {
            const rows = await tx.query<{ ref: string; title: string | null; discrepancy: boolean; at: unknown }>(
              `SELECT ep.proposal_id AS ref, ep.title AS title,
                      ep.has_discrepancy AS discrepancy, ep.proposed_at AS at
                 FROM waspada.pipeline_flow_proposals ep
                 LEFT JOIN waspada.pipeline_flow_decisions pd
                   ON pd.dataset_kind = ep.dataset_kind AND pd.proposal_id = ep.proposal_id
                WHERE ep.dataset_kind = $1 AND pd.proposal_id IS NULL
                ORDER BY ep.proposed_at DESC, ep.proposal_id DESC
                LIMIT $2`,
              [datasetKind, cap],
            );
            return rows.rows.map((row) => ({
              ref: row.ref,
              status: row.discrepancy ? "diskrepansi" : "antrean_gerbang",
              failure_code: null,
              title: truncateTitle(row.title),
              at: toInstant(row.at),
            }));
          }
          case "published": {
            const rows = await tx.query<{ ref: string; version: unknown; title: string | null; at: unknown }>(
              `SELECT ev.event_id AS ref, ev.version, ev.title, ev.published_at AS at
                 FROM waspada.pipeline_flow_versions ev
                WHERE ev.dataset_kind = $1 AND ev.publication_status = 'published'
                ORDER BY ev.published_at DESC NULLS LAST, ev.event_id DESC, ev.version DESC
                LIMIT $2`,
              [datasetKind, cap],
            );
            return rows.rows.map((row) => ({
              ref: row.ref,
              status: `versi ${toCount(row.version)}`,
              failure_code: null,
              title: truncateTitle(row.title),
              at: toInstant(row.at),
            }));
          }
        }
      });
    },
  };
}

function truncateTitle(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.replace(/\s+/gu, " ").trim();
  if (trimmed.length === 0) return null;
  return trimmed.length > 120 ? `${trimmed.slice(0, 117)}...` : trimmed;
}
