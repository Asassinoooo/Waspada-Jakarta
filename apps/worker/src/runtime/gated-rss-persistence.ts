import { createHash } from "node:crypto";
import type { SqlExecutor, TransactionalSqlExecutor } from "../../../db/src/sql.js";
import { createSqlIncidentRepository } from "../../../db/src/incident-repository.js";
import {
  persistHeldTriageTransaction,
  recordTriageAttempt,
  recordTriageDecision,
} from "../../../db/src/news-triage-store.js";
import type { NewsTriageDecision } from "../layers/l1-data-knowledge/news-triage.js";
import type {
  HeldTriageDecision,
  StoredReportRevision,
} from "./news-poll-runtime.js";

// WJ-INT-02B: single persistence contract for accepted/held gated RSS items.
// Both `apps/worker/src/index.ts` scheduled() and `tools/serve-live-pipeline.ts`
// call ONLY these two functions. Structured pollers (PetaBencana, BMKG) keep
// their own plain-executor path and never touch this module.

/** Accepted RSS item: revision carries the ingest triage decision. */
export interface AcceptedRssPersistInput {
  readonly datasetKind: "live" | "historical" | "synthetic";
  readonly rev: StoredReportRevision & { triage: NewsTriageDecision };
  /** Stable item identity: sha256(source_id + "|" + (guid || link)). */
  readonly itemIdentityHash: string;
  /** Content version: sha256(canonicalUrl + ":" + authorized permitted_text). */
  readonly contentHash: string;
  /** Previous content hash for the same (dataset, source, revision key), if any. */
  readonly supersedesHash: string | null;
  readonly policyVersion: string;
}

/**
 * Persist one accepted (ingest-disposition) RSS item atomically: traces,
 * triage decision (+ attempt-counted snapshot), attempt ledger row, revision
 * (with SELECT-first content-conflict check), authorized chunks, and the
 * deterministic AI job — all in exactly one transaction. Any throw rolls back
 * all six writes for the item. Throws TypeError when rev.triage is absent or
 * not ingest; throws fail-closed when the source registry has no row.
 */
export async function persistAcceptedRssItem(
  executor: TransactionalSqlExecutor,
  input: AcceptedRssPersistInput,
): Promise<{ jobId: string }> {
  const triage = input.rev?.triage;
  if (!triage || triage.disposition !== "ingest") {
    throw new TypeError(
      "persistAcceptedRssItem requires rev.triage with disposition ingest; route held items to persistHeldTriageItem",
    );
  }
  const rev = input.rev;
  const traceId = readTraceId(rev);
  const jobId = `job-${rev.report_revision_id}-${input.contentHash.slice(0, 8)}`;
  return executor.transaction(async (tx) => {
    // Serialize concurrent poll cycles per item identity so the second
    // transaction sees the first one's committed rows and replays idempotently.
    await tx.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [
      input.itemIdentityHash,
    ]);
    // Fail closed: no registry row, no writes at all for this item.
    const registry = await tx.query<{ one: number }>(
      `SELECT 1 AS one FROM waspada.source_registry WHERE source_id = $1`,
      [rev.source_id],
    );
    if (registry.rows.length === 0) {
      throw new Error(`triage source not registered: ${rev.source_id}`);
    }
    const existingRevision = await tx.query<{
      permitted_text_hash: string;
      content_hash: string;
    }>(
      `SELECT permitted_text_hash, content_hash FROM waspada.report_revisions
       WHERE dataset_kind = $1 AND report_revision_id = $2`,
      [input.datasetKind, rev.report_revision_id],
    );
    const snapshot = await tx.query<{
      report_revision_id: string | null;
      disposition: string;
      primary_category: string | null;
      incident_type: string | null;
      content_hash: string | null;
      policy_version: string;
    }>(
      `SELECT report_revision_id, disposition, primary_category, incident_type,
              content_hash, policy_version
       FROM waspada.news_triage_decisions
       WHERE dataset_kind = $1 AND item_identity_hash = $2`,
      [input.datasetKind, input.itemIdentityHash],
    );
    const snapshotRow = snapshot.rows[0] ?? null;
    // Consistency first: an existing row under the same id MUST carry the
    // same bytes; silently keeping stale text via ON CONFLICT DO NOTHING is
    // forbidden. The throw rolls back every write in this transaction.
    // Checked BEFORE any early return so a conflicting reuse can never
    // masquerade as an identical replay.
    if (
      existingRevision.rows.length > 0 &&
      existingRevision.rows[0]!.permitted_text_hash !== rev.permitted_text_hash
    ) {
      throw new Error("RevisionContentConflict");
    }
    // Exact-retry replay (WJ-INT-02B idempotency contract §F): return the
    // existing job with NO new writes only when every evaluation dimension
    // matches — same revision row, same snapshot revision, ingest
    // disposition, same content hash, same policy version, same primary
    // category and incident type. Any changed content, policy, category, or
    // evaluation state falls through to a fresh evaluation below (new
    // attempt row, updated snapshot, supersede linkage). Permission state
    // was already enforced upstream: the caller persists only the authorized
    // revision built under the current permissions.
    if (
      existingRevision.rows.length > 0 &&
      snapshotRow?.report_revision_id === rev.report_revision_id &&
      snapshotRow?.disposition === "ingest" &&
      snapshotRow?.content_hash === input.contentHash &&
      snapshotRow?.policy_version === input.policyVersion &&
      snapshotRow?.primary_category === triage.primaryCategory &&
      (snapshotRow?.incident_type ?? null) === (triage.incidentType ?? null)
    ) {
      const existingJob = await tx.query<{ job_id: string }>(
        `SELECT job_id FROM waspada.ai_jobs
         WHERE dataset_kind = $1 AND report_revision_id = $2`,
        [input.datasetKind, rev.report_revision_id],
      );
      return { jobId: existingJob.rows[0]?.job_id ?? jobId };
    }
    // Supersession link: a different revision row for the same
    // (dataset, source, revision key) is the predecessor version.
    const predecessor = await tx.query<{
      report_revision_id: string;
      content_hash: string;
    }>(
      `SELECT report_revision_id, content_hash FROM waspada.report_revisions
       WHERE dataset_kind = $1 AND source_id = $2
         AND source_revision_key IS NOT DISTINCT FROM $3
         AND report_revision_id <> $4
       ORDER BY retrieved_at DESC, report_revision_id DESC
       LIMIT 1`,
      [input.datasetKind, rev.source_id, rev.source_revision_key ?? null, rev.report_revision_id],
    );
    const predecessorRow = predecessor.rows[0] ?? null;
    const supersedesHash = predecessorRow?.content_hash ?? input.supersedesHash;
    // (1) trace row for foreign keys.
    await tx.query(
      `INSERT INTO waspada.traces (trace_id, dataset_kind, started_at, outcome, metadata)
       VALUES ($1, $2, now(), 'succeeded', '{}'::jsonb)
       ON CONFLICT (trace_id, dataset_kind) DO NOTHING`,
      [traceId, input.datasetKind],
    );
    // (2) latest-per-item decision snapshot with revision lineage.
    const attemptCount = await readAttemptCount(tx, input.datasetKind, input.itemIdentityHash);
    await recordTriageDecision(tx, {
      datasetKind: input.datasetKind,
      itemIdentityHash: input.itemIdentityHash,
      sourceId: rev.source_id,
      traceId,
      disposition: triage.disposition,
      jakartaScope: triage.jakartaScope,
      actionability: triage.actionability,
      primaryCategory: triage.primaryCategory,
      incidentType: triage.incidentType,
      confidence: triage.confidence,
      reasonCodes: [...triage.reasonCodes],
      policyVersion: input.policyVersion,
      modelStatus: triage.modelStatus,
      reportRevisionId: rev.report_revision_id,
      contentHash: input.contentHash,
      attemptCount,
      supersedesHash,
    });
    // A changed outcome or category re-opens review: clear the snapshot flag
    // (attempt history is append-only and untouched).
    if (
      snapshotRow !== null &&
      (snapshotRow.disposition !== triage.disposition ||
        snapshotRow.primary_category !== triage.primaryCategory)
    ) {
      await tx.query(
        `UPDATE waspada.news_triage_decisions
         SET reviewed_at = NULL, reviewed_by = NULL
         WHERE dataset_kind = $1 AND item_identity_hash = $2`,
        [input.datasetKind, input.itemIdentityHash],
      );
    }
    // (3) append-only evaluation ledger row. Never title/description/chunk text.
    await recordTriageAttempt(tx, {
      datasetKind: input.datasetKind,
      itemIdentityHash: input.itemIdentityHash,
      reportRevisionId: rev.report_revision_id,
      sourceId: rev.source_id,
      traceId,
      disposition: triage.disposition,
      jakartaScope: triage.jakartaScope,
      actionability: triage.actionability,
      primaryCategory: triage.primaryCategory,
      incidentType: triage.incidentType,
      confidence: triage.confidence,
      reasonCodes: [...triage.reasonCodes],
      policyVersion: input.policyVersion,
      modelStatus: triage.modelStatus,
      contentHash: input.contentHash,
      supersedesHash,
    });
    // (4) revision row carrying the predecessor link (consistency already
    // verified above; ON CONFLICT DO NOTHING keeps identical replays safe).
    await tx.query(
      `INSERT INTO waspada.report_revisions (
         dataset_kind, report_revision_id, trace_id, source_id, canonical_url,
         source_revision_key, content_hash, permitted_text, permitted_text_hash,
         normalization_version, retrieved_at, revision_status, record_json, supersedes_id,
         triage_required
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'v1', $10, 'unreviewed', '{}'::jsonb, $11, true)
       ON CONFLICT (dataset_kind, report_revision_id) DO NOTHING`,
      [
        input.datasetKind,
        rev.report_revision_id,
        traceId,
        rev.source_id,
        rev.canonical_url,
        rev.source_revision_key ?? null,
        input.contentHash,
        rev.permitted_text,
        rev.permitted_text_hash,
        rev.retrieved_at,
        predecessorRow?.report_revision_id ?? null,
      ],
    );
    // (5) authorized evidence chunks only.
    for (const chk of readChunks(rev)) {
      const chunkTextHash = createHash("sha256").update(chk.text).digest("hex");
      await tx.query(
        `INSERT INTO waspada.evidence_chunks (
           dataset_kind, chunk_id, trace_id, report_revision_id, permitted_text_hash,
           span_start, span_end, offset_unit, chunker_version, chunk_text_hash, status
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'unicode_code_points', 'v1', $8, 'active')
         ON CONFLICT (dataset_kind, chunk_id) DO NOTHING`,
        [
          input.datasetKind,
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
    // (6) deterministic job id per content version; the (dataset, revision)
    // unique index makes replays idempotent.
    const repo = createSqlIncidentRepository(tx);
    const job = await repo.enqueueAiJob({
      jobId,
      datasetKind: input.datasetKind,
      reportRevisionId: rev.report_revision_id,
      traceId,
    });
    return { jobId: job.jobId };
  });
}

/**
 * Persist one held (drop/uncertain) triage evaluation as metadata only: the
 * decision snapshot (no revision/content linkage) plus the attempt ledger row
 * (revision/content references for traceability, never text). Never touches
 * report_revisions, evidence_chunks, or ai_jobs.
 */
export async function persistHeldTriageItem(
  executor: TransactionalSqlExecutor,
  held: HeldTriageDecision,
  datasetKind: string,
  policyVersion: string,
  replayed: boolean = held.replayed ?? false,
): Promise<void> {
  const decision = held.decision;
  // WJ-INT-02B: the freed advisory lock outside a transaction protected
  // nothing. Writes below run inside persistHeldTriageTransaction (lock,
  // snapshot, review-clear, attempt — all-or-nothing). No-tx executors fail
  // closed there. Replay and snapshot pre-reads stay outside the write tx.
  const snapshot = await executor.query<{
    report_revision_id: string | null;
    disposition: string;
    primary_category: string | null;
  }>(
    `SELECT report_revision_id, disposition, primary_category
     FROM waspada.news_triage_decisions
     WHERE dataset_kind = $1 AND item_identity_hash = $2`,
    [datasetKind, held.itemIdentityHash],
  );
  const snapshotRow = snapshot.rows[0] ?? null;
  // Replay short-circuit (WJ-INT-02B §6): the poller reused a cached prior
  // evaluation, so when the latest attempt row already records this exact
  // (revision, outcome) there is nothing new to record. Fresh evaluations
  // always append a new attempt row — including provider-error repeats that
  // feed the bounded retry budget. (The held decision snapshot carries no
  // revision linkage by design; the append-only attempt row is the replay key.)
  if (replayed) {
    const latestAttempt = await executor.query<{
      report_revision_id: string;
      disposition: string;
    }>(
      `SELECT report_revision_id, disposition FROM waspada.news_triage_attempts
       WHERE dataset_kind = $1 AND item_identity_hash = $2
       ORDER BY evaluated_at DESC LIMIT 1`,
      [datasetKind, held.itemIdentityHash],
    );
    const latestRow = latestAttempt.rows[0] ?? null;
    if (
      latestRow?.report_revision_id === held.reportRevisionId &&
      latestRow?.disposition === decision.disposition
    ) {
      return;
    }
  }
  await persistHeldTriageTransaction(
    executor,
    {
      datasetKind,
      itemIdentityHash: held.itemIdentityHash,
      sourceId: held.sourceId,
      traceId: held.traceId,
      reportRevisionId: snapshotRow?.report_revision_id ?? null,
      disposition: decision.disposition,
      jakartaScope: decision.jakartaScope,
      actionability: decision.actionability,
      primaryCategory: decision.primaryCategory,
      incidentType: decision.incidentType,
      confidence: decision.confidence,
      reasonCodes: [...decision.reasonCodes],
      policyVersion,
      modelStatus: decision.modelStatus,
      contentHash: null,
      supersedesHash: null,
      priorDisposition: snapshotRow?.disposition ?? null,
      priorPrimaryCategory: snapshotRow?.primary_category ?? null,
    },
    {
      sourceId: held.sourceId,
      traceId: held.traceId,
      reportRevisionId: held.reportRevisionId,
      disposition: decision.disposition,
      jakartaScope: decision.jakartaScope,
      actionability: decision.actionability,
      primaryCategory: decision.primaryCategory,
      incidentType: decision.incidentType,
      confidence: decision.confidence,
      reasonCodes: [...decision.reasonCodes],
      policyVersion,
      modelStatus: decision.modelStatus,
      contentHash: null,
      supersedesHash: null,
    },
  );
}

async function readAttemptCount(
  executor: SqlExecutor,
  datasetKind: string,
  itemIdentityHash: string,
): Promise<number> {
  const result = await executor.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM waspada.news_triage_attempts
     WHERE dataset_kind = $1 AND item_identity_hash = $2`,
    [datasetKind, itemIdentityHash],
  );
  return 1 + Number(result.rows[0]?.count ?? "0");
}

function readTraceId(rev: StoredReportRevision): string {
  if (
    rev !== null &&
    typeof rev === "object" &&
    "trace_id" in rev &&
    typeof rev.trace_id === "string" &&
    rev.trace_id.length > 0
  ) {
    return rev.trace_id;
  }
  return `trace-${rev.report_revision_id}`;
}

interface PersistChunkShape {
  readonly chunk_index: number;
  readonly text: string;
  readonly span_start: number;
  readonly span_end: number;
}

function isPersistChunk(value: unknown): value is PersistChunkShape {
  return (
    value !== null &&
    typeof value === "object" &&
    "chunk_index" in value &&
    typeof value.chunk_index === "number" &&
    "text" in value &&
    typeof value.text === "string" &&
    "span_start" in value &&
    typeof value.span_start === "number" &&
    "span_end" in value &&
    typeof value.span_end === "number"
  );
}

function readChunks(rev: StoredReportRevision): readonly PersistChunkShape[] {
  const raw: unknown = rev.chunks ?? rev.evidence_chunks ?? [];
  if (!Array.isArray(raw)) return [];
  return raw.filter(isPersistChunk);
}
