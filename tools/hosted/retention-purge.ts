// NFR-07 F-39..F-41 (ADR-005): one retention purge per hosted --once run. The database function
// waspada.purge_expired_retention does the work, and the session runs it as the NOLOGIN role waspada_retention_purger.
// This module sets the role, calls the function with the run's clock, resets the role and returns counts. It never
// reads or logs a URL, title, source text, vector or error message.
import type { SqlExecutor } from "../../apps/db/src/sql.js";
import type { RetentionPurgeCounts } from "./ingest-once.js";

export const RETENTION_PURGER_ROLE = "waspada_retention_purger";

interface PurgeRow {
  readonly source_text_nulled: string;
  readonly vectors_removed: string;
  readonly audit_records_removed: string;
  readonly account_admin_audit_removed: string;
  readonly triage_decisions_removed: string;
}

/**
 * Runs the purge once, with `now` as its clock. The role is set for this statement only and reset in finally, so the
 * rest of the run keeps its own role. The SQL text is constant; only the timestamp is a parameter.
 */
export async function runRetentionPurge(executor: Pick<SqlExecutor, "query" | "execute">, now: Date): Promise<RetentionPurgeCounts> {
  if (Number.isNaN(now.getTime())) throw new TypeError("retention_clock_invalid");
  await executor.execute(`SET ROLE ${RETENTION_PURGER_ROLE}`);
  try {
    const result = await executor.query<PurgeRow>(
      `SELECT source_text_nulled::text, vectors_removed::text, audit_records_removed::text,
              account_admin_audit_removed::text, triage_decisions_removed::text
         FROM waspada.purge_expired_retention($1::timestamptz)`,
      [now.toISOString()],
    );
    const row = result.rows[0];
    if (row === undefined) throw new Error("retention_purge_no_row");
    return {
      sourceTextNulled: Number(row.source_text_nulled),
      vectorsRemoved: Number(row.vectors_removed),
      auditRecordsRemoved: Number(row.audit_records_removed),
      accountAdminAuditRemoved: Number(row.account_admin_audit_removed),
      triageDecisionsRemoved: Number(row.triage_decisions_removed),
    };
  } finally {
    await executor.execute("RESET ROLE");
  }
}
