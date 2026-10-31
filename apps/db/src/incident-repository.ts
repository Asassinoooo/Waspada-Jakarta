import type { SqlExecutor, SqlTransactionRunner } from "./sql.js";
import type { DatasetKind } from "./ports.js";
import { persistProposalWithTx, type EventProposalDto } from "./event-proposal-writer.js";

export class StaleLeaseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StaleLeaseError";
  }
}
export type IncidentStatus = "investigating" | "active" | "monitoring" | "resolved" | "closed";
export type IncidentSeverity = "low" | "medium" | "high" | "critical" | "unknown";
export type IncidentRelationship = "primary_initial" | "corroborating" | "updating" | "contradicting" | "unresolved";
export type CorrelationDecision = "same_incident" | "new_incident" | "unresolved";
export type AiJobStatus = "pending" | "leased" | "retry" | "completed" | "terminal" | "needs_review";

export interface IncidentRecord {
  readonly incidentId: string;
  readonly datasetKind: DatasetKind;
  readonly title: string;
  readonly description: string;
  readonly incidentType: string;
  readonly status: IncidentStatus;
  readonly severity: IncidentSeverity;
  readonly locationLabel: string | null;
  readonly coordinates: readonly [longitude: number, latitude: number] | null;
  readonly eventTime: Record<string, unknown>;
  readonly firstObservedAt: string;
  readonly lastUpdatedAt: string;
  readonly discrepancies: readonly unknown[];
  readonly uncertaintyNotes: readonly string[];
  readonly recordJson: Record<string, unknown>;
  readonly createdAt: string;
}

export interface IncidentReportLink {
  readonly datasetKind: DatasetKind;
  readonly incidentId: string;
  readonly reportRevisionId: string;
  readonly relationship: IncidentRelationship;
  readonly correlationDecisionId: string | null;
  readonly linkedAt: string;
}

export interface IncidentCorrelationDecisionRecord {
  readonly decisionId: string;
  readonly datasetKind: DatasetKind;
  readonly reportRevisionId: string;
  readonly decision: CorrelationDecision;
  readonly targetIncidentId: string | null;
  readonly reasoning: string;
  readonly evidenceQuotes: readonly unknown[];
  readonly conflicts: readonly unknown[];
  readonly uncertainty: readonly string[];
  readonly recordJson: Record<string, unknown>;
  readonly createdAt: string;
}

export interface AiJobRecord {
  readonly jobId: string;
  readonly datasetKind: DatasetKind;
  readonly reportRevisionId: string;
  readonly status: AiJobStatus;
  readonly attemptCount: number;
  readonly maxAttempts: number;
  readonly availableAt: string;
  readonly leaseToken: string | null;
  readonly leaseStartedAt: string | null;
  readonly leaseExpiresAt: string | null;
  readonly lastFailureCode: string | null;
  readonly traceId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly finishedAt: string | null;
}

export interface CreateIncidentInput {
  readonly incidentId: string;
  readonly datasetKind: DatasetKind;
  readonly title: string;
  readonly description: string;
  readonly incidentType: string;
  readonly status?: IncidentStatus;
  readonly severity?: IncidentSeverity;
  readonly locationLabel?: string | null;
  readonly coordinates?: readonly [longitude: number, latitude: number] | null;
  readonly eventTime?: Record<string, unknown>;
  readonly firstObservedAt: string;
  readonly lastUpdatedAt?: string;
  readonly discrepancies?: readonly unknown[];
  readonly uncertaintyNotes?: readonly string[];
  readonly recordJson?: Record<string, unknown>;
  readonly createdAt?: string;
}

export interface UpdateIncidentInput {
  readonly incidentId: string;
  readonly datasetKind: DatasetKind;
  readonly title?: string;
  readonly description?: string;
  readonly incidentType?: string;
  readonly status?: IncidentStatus;
  readonly severity?: IncidentSeverity;
  readonly locationLabel?: string | null;
  readonly coordinates?: readonly [longitude: number, latitude: number] | null;
  readonly eventTime?: Record<string, unknown>;
  readonly lastUpdatedAt: string;
  readonly discrepancies?: readonly unknown[];
  readonly uncertaintyNotes?: readonly string[];
  readonly recordJson?: Record<string, unknown>;
}

export interface LinkReportInput {
  readonly datasetKind: DatasetKind;
  readonly incidentId: string;
  readonly reportRevisionId: string;
  readonly relationship: IncidentRelationship;
  readonly correlationDecisionId?: string | null;
  readonly linkedAt?: string;
}

export interface RecordCorrelationDecisionInput {
  readonly decisionId: string;
  readonly datasetKind: DatasetKind;
  readonly reportRevisionId: string;
  readonly decision: CorrelationDecision;
  readonly targetIncidentId?: string | null;
  readonly reasoning: string;
  readonly evidenceQuotes?: readonly unknown[];
  readonly conflicts?: readonly unknown[];
  readonly uncertainty?: readonly string[];
  readonly recordJson?: Record<string, unknown>;
  readonly createdAt?: string;
}

export interface EnqueueAiJobInput {
  readonly jobId: string;
  readonly datasetKind: DatasetKind;
  readonly reportRevisionId: string;
  readonly traceId?: string | null;
  readonly availableAt?: string;
  readonly createdAt?: string;
}

export interface ClaimAiJobInput {
  readonly leaseDurationMs?: number;
  readonly now?: string;
  readonly datasetKind?: DatasetKind;
}

export interface PersistIncidentProcessingInput {
  readonly jobId: string;
  readonly leaseToken: string;
  readonly datasetKind: DatasetKind;
  readonly reportRevisionId: string;
  readonly pipelineVersion?: string;
  readonly incidentAction:
    | {
        readonly type: "create";
        readonly incident: CreateIncidentInput;
      }
    | {
        readonly type: "update";
        readonly incident: UpdateIncidentInput;
      };
  readonly correlationDecision: RecordCorrelationDecisionInput;
  readonly reportLink: {
    readonly relationship: IncidentRelationship;
  };
  readonly proposal: EventProposalDto;
  readonly now?: string;
}

export interface PersistIncidentProcessingResult {
  readonly outcome: "committed" | "already_processed";
  readonly incidentId: string;
  readonly decisionId: string;
  readonly proposalId: string;
}

export interface IncidentRepository {
  createIncident(input: CreateIncidentInput): Promise<IncidentRecord>;
  updateIncident(input: UpdateIncidentInput): Promise<IncidentRecord>;
  linkReport(input: LinkReportInput): Promise<IncidentReportLink>;
  recordCorrelationDecision(input: RecordCorrelationDecisionInput): Promise<IncidentCorrelationDecisionRecord>;
  getIncidentById(datasetKind: DatasetKind, incidentId: string): Promise<{
    readonly incident: IncidentRecord;
    readonly contributingReports: readonly IncidentReportLink[];
    readonly decisions: readonly IncidentCorrelationDecisionRecord[];
  } | null>;
  listActiveIncidents(datasetKind: DatasetKind, options?: { limit?: number; offset?: number }): Promise<readonly IncidentRecord[]>;
  getIncidentForReport(datasetKind: DatasetKind, reportRevisionId: string): Promise<IncidentRecord | null>;
  enqueueAiJob(input: EnqueueAiJobInput): Promise<AiJobRecord>;
  claimAiJob(input?: ClaimAiJobInput): Promise<{ readonly job: AiJobRecord; readonly leaseToken: string } | null>;
  renewAiJob(jobId: string, leaseToken: string, leaseDurationMs?: number, now?: string): Promise<boolean>;
  completeAiJob(jobId: string, leaseToken: string, now?: string): Promise<boolean>;
  failAiJob(jobId: string, leaseToken: string, failureCode: string, retryBackoffMs?: number, now?: string): Promise<{ readonly status: "retry" | "terminal" | "needs_review"; readonly attemptCount: number }>;
  markAiJobNeedsReview(jobId: string, leaseToken: string, reasonCode: string, now?: string): Promise<boolean>;
  retryAiJob(jobId: string, now?: string): Promise<boolean>;
  getAiJob(jobId: string): Promise<AiJobRecord | null>;
  listAiJobs(options?: { status?: AiJobStatus; datasetKind?: DatasetKind; limit?: number }): Promise<readonly AiJobRecord[]>;
  persistIncidentProcessingTransaction(
    input: PersistIncidentProcessingInput,
  ): Promise<PersistIncidentProcessingResult>;
}

function parseGeoJsonPoint(geoJsonText: string | null): [number, number] | null {
  if (!geoJsonText) return null;
  try {
    const parsed = typeof geoJsonText === "string" ? JSON.parse(geoJsonText) : geoJsonText;
    if (parsed && parsed.type === "Point" && Array.isArray(parsed.coordinates) && parsed.coordinates.length >= 2) {
      const lon = Number(parsed.coordinates[0]);
      const lat = Number(parsed.coordinates[1]);
      if (Number.isFinite(lon) && Number.isFinite(lat)) {
        return [lon, lat];
      }
    }
  } catch {
    // Malformed geometry safely returns null
  }
  return null;
}

interface IncidentDbRow {
  readonly incident_id: string;
  readonly dataset_kind: DatasetKind;
  readonly title: string;
  readonly description: string;
  readonly incident_type: string;
  readonly status: IncidentStatus;
  readonly severity: IncidentSeverity;
  readonly location_label: string | null;
  readonly shape_geojson: string | null;
  readonly event_time: unknown;
  readonly first_observed_at: string | Date;
  readonly last_updated_at: string | Date;
  readonly discrepancies: unknown;
  readonly uncertainty_notes: unknown;
  readonly record_json: unknown;
  readonly created_at: string | Date;
}

interface AiJobDbRow {
  readonly job_id: string;
  readonly dataset_kind: DatasetKind;
  readonly report_revision_id: string;
  readonly status: AiJobStatus;
  readonly attempt_count: number | string;
  readonly max_attempts: number | string;
  readonly available_at: string | Date;
  readonly lease_token: string | null;
  readonly lease_started_at: string | Date | null;
  readonly lease_expires_at: string | Date | null;
  readonly last_failure_code: string | null;
  readonly trace_id: string | null;
  readonly created_at: string | Date;
  readonly updated_at: string | Date;
  readonly finished_at: string | Date | null;
}

function formatRowToIncident(row: IncidentDbRow): IncidentRecord {
  return {
    incidentId: row.incident_id,
    datasetKind: row.dataset_kind,
    title: row.title,
    description: row.description,
    incidentType: row.incident_type,
    status: row.status,
    severity: row.severity,
    locationLabel: row.location_label,
    coordinates: parseGeoJsonPoint(row.shape_geojson),
    eventTime: (typeof row.event_time === "string" ? JSON.parse(row.event_time) : row.event_time ?? {}) as Record<string, unknown>,
    firstObservedAt: new Date(row.first_observed_at).toISOString(),
    lastUpdatedAt: new Date(row.last_updated_at).toISOString(),
    discrepancies: (typeof row.discrepancies === "string" ? JSON.parse(row.discrepancies) : row.discrepancies ?? []) as readonly unknown[],
    uncertaintyNotes: (typeof row.uncertainty_notes === "string" ? JSON.parse(row.uncertainty_notes) : row.uncertainty_notes ?? []) as readonly string[],
    recordJson: (typeof row.record_json === "string" ? JSON.parse(row.record_json) : row.record_json ?? {}) as Record<string, unknown>,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

function formatRowToJob(row: AiJobDbRow): AiJobRecord {
  return {
    jobId: row.job_id,
    datasetKind: row.dataset_kind,
    reportRevisionId: row.report_revision_id,
    status: row.status,
    attemptCount: Number(row.attempt_count),
    maxAttempts: Number(row.max_attempts),
    availableAt: new Date(row.available_at).toISOString(),
    leaseToken: row.lease_token,
    leaseStartedAt: row.lease_started_at ? new Date(row.lease_started_at).toISOString() : null,
    leaseExpiresAt: row.lease_expires_at ? new Date(row.lease_expires_at).toISOString() : null,
    lastFailureCode: row.last_failure_code,
    traceId: row.trace_id,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
    finishedAt: row.finished_at ? new Date(row.finished_at).toISOString() : null,
  };
}

async function runInTransaction<Result>(
  executor: SqlExecutor,
  work: (tx: SqlExecutor) => Promise<Result>,
): Promise<Result> {
  const runner = executor as SqlExecutor & Partial<SqlTransactionRunner>;
  if (typeof runner.transaction === "function") {
    return runner.transaction(work);
  }
  await executor.execute("BEGIN");
  try {
    const result = await work(executor);
    await executor.execute("COMMIT");
    return result;
  } catch (err) {
    try {
      await executor.execute("ROLLBACK");
    } catch {
      // Ignore rollback failure
    }
    throw err;
  }
}

export function createSqlIncidentRepository(executor: SqlExecutor): IncidentRepository {
  return {
    async createIncident(input: CreateIncidentInput): Promise<IncidentRecord> {
      const status = input.status ?? "investigating";
      const severity = input.severity ?? "unknown";
      const now = input.createdAt ?? new Date().toISOString();
      const lastUpdatedAt = input.lastUpdatedAt ?? now;
      const discrepancies = JSON.stringify(input.discrepancies ?? []);
      const uncertaintyNotes = JSON.stringify(input.uncertaintyNotes ?? []);
      const eventTime = JSON.stringify(input.eventTime ?? {});
      const recordJson = JSON.stringify(input.recordJson ?? {});

      let shapeSql = "NULL";
      const params: unknown[] = [
        input.incidentId,
        input.datasetKind,
        input.title,
        input.description,
        input.incidentType,
        status,
        severity,
        input.locationLabel ?? null,
        eventTime,
        input.firstObservedAt,
        lastUpdatedAt,
        discrepancies,
        uncertaintyNotes,
        recordJson,
        now,
      ];

      if (input.coordinates) {
        shapeSql = `ST_SetSRID(ST_MakePoint($16, $17), 4326)`;
        params.push(input.coordinates[0], input.coordinates[1]);
      }

      const query = `
        INSERT INTO waspada.incidents (
          incident_id, dataset_kind, title, description, incident_type,
          status, severity, location_label, shape, event_time,
          first_observed_at, last_updated_at, discrepancies, uncertainty_notes,
          record_json, created_at
        )
        VALUES (
          $1, $2, $3, $4, $5,
          $6, $7, $8, ${shapeSql}, $9,
          $10, $11, $12::jsonb, $13::jsonb,
          $14::jsonb, $15
        )
        RETURNING
          incident_id, dataset_kind, title, description, incident_type,
          status, severity, location_label, ST_AsGeoJSON(shape) AS shape_geojson,
          event_time, first_observed_at, last_updated_at, discrepancies,
          uncertainty_notes, record_json, created_at
      `;

      const result = await executor.query<IncidentDbRow>(query, params);
      return formatRowToIncident(result.rows[0]);
    },

    async updateIncident(input: UpdateIncidentInput): Promise<IncidentRecord> {
      const updates: string[] = ["last_updated_at = $3"];
      const params: unknown[] = [input.datasetKind, input.incidentId, input.lastUpdatedAt];
      let paramIndex = 4;

      if (input.title !== undefined) {
        updates.push(`title = $${paramIndex++}`);
        params.push(input.title);
      }
      if (input.description !== undefined) {
        updates.push(`description = $${paramIndex++}`);
        params.push(input.description);
      }
      if (input.incidentType !== undefined) {
        updates.push(`incident_type = $${paramIndex++}`);
        params.push(input.incidentType);
      }
      if (input.status !== undefined) {
        updates.push(`status = $${paramIndex++}`);
        params.push(input.status);
      }
      if (input.severity !== undefined) {
        updates.push(`severity = $${paramIndex++}`);
        params.push(input.severity);
      }
      if (input.locationLabel !== undefined) {
        updates.push(`location_label = $${paramIndex++}`);
        params.push(input.locationLabel);
      }
      if (input.coordinates !== undefined) {
        if (input.coordinates === null) {
          updates.push(`shape = NULL`);
        } else {
          updates.push(`shape = ST_SetSRID(ST_MakePoint($${paramIndex++}, $${paramIndex++}), 4326)`);
          params.push(input.coordinates[0], input.coordinates[1]);
        }
      }
      if (input.eventTime !== undefined) {
        updates.push(`event_time = $${paramIndex++}::jsonb`);
        params.push(JSON.stringify(input.eventTime));
      }
      if (input.discrepancies !== undefined) {
        updates.push(`discrepancies = $${paramIndex++}::jsonb`);
        params.push(JSON.stringify(input.discrepancies));
      }
      if (input.uncertaintyNotes !== undefined) {
        updates.push(`uncertainty_notes = $${paramIndex++}::jsonb`);
        params.push(JSON.stringify(input.uncertaintyNotes));
      }
      if (input.recordJson !== undefined) {
        updates.push(`record_json = $${paramIndex++}::jsonb`);
        params.push(JSON.stringify(input.recordJson));
      }

      const query = `
        UPDATE waspada.incidents
        SET ${updates.join(", ")}
        WHERE dataset_kind = $1 AND incident_id = $2
        RETURNING
          incident_id, dataset_kind, title, description, incident_type,
          status, severity, location_label, ST_AsGeoJSON(shape) AS shape_geojson,
          event_time, first_observed_at, last_updated_at, discrepancies,
          uncertainty_notes, record_json, created_at
      `;

      const result = await executor.query<IncidentDbRow>(query, params);
      if (result.rows.length === 0) {
        throw new Error(`Incident not found: ${input.datasetKind}:${input.incidentId}`);
      }
      return formatRowToIncident(result.rows[0]);
    },

    async linkReport(input: LinkReportInput): Promise<IncidentReportLink> {
      const now = input.linkedAt ?? new Date().toISOString();
      const query = `
        INSERT INTO waspada.incident_reports (
          dataset_kind, incident_id, report_revision_id, relationship,
          correlation_decision_id, linked_at
        )
        VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT (dataset_kind, incident_id, report_revision_id)
        DO UPDATE SET
          relationship = EXCLUDED.relationship,
          correlation_decision_id = EXCLUDED.correlation_decision_id,
          linked_at = EXCLUDED.linked_at
        RETURNING
          dataset_kind, incident_id, report_revision_id, relationship,
          correlation_decision_id, linked_at
      `;

      interface LinkDbRow {
        readonly dataset_kind: DatasetKind;
        readonly incident_id: string;
        readonly report_revision_id: string;
        readonly relationship: IncidentRelationship;
        readonly correlation_decision_id: string | null;
        readonly linked_at: string | Date;
      }

      const result = await executor.query<LinkDbRow>(query, [
        input.datasetKind,
        input.incidentId,
        input.reportRevisionId,
        input.relationship,
        input.correlationDecisionId ?? null,
        now,
      ]);

      const row = result.rows[0];
      return {
        datasetKind: row.dataset_kind,
        incidentId: row.incident_id,
        reportRevisionId: row.report_revision_id,
        relationship: row.relationship,
        correlationDecisionId: row.correlation_decision_id,
        linkedAt: new Date(row.linked_at).toISOString(),
      };
    },

    async recordCorrelationDecision(input: RecordCorrelationDecisionInput): Promise<IncidentCorrelationDecisionRecord> {
      const now = input.createdAt ?? new Date().toISOString();
      const evidenceQuotes = JSON.stringify(input.evidenceQuotes ?? []);
      const conflicts = JSON.stringify(input.conflicts ?? []);
      const uncertainty = JSON.stringify(input.uncertainty ?? []);
      const recordJson = JSON.stringify(input.recordJson ?? {});

      const query = `
        INSERT INTO waspada.incident_correlation_decisions (
          decision_id, dataset_kind, report_revision_id, decision,
          target_incident_id, reasoning, evidence_quotes, conflicts,
          uncertainty, record_json, created_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9::jsonb, $10::jsonb, $11)
        ON CONFLICT (dataset_kind, decision_id) DO NOTHING
        RETURNING
          decision_id, dataset_kind, report_revision_id, decision,
          target_incident_id, reasoning, evidence_quotes, conflicts,
          uncertainty, record_json, created_at
      `;

      interface DecisionDbRow {
        readonly decision_id: string;
        readonly dataset_kind: DatasetKind;
        readonly report_revision_id: string;
        readonly decision: CorrelationDecision;
        readonly target_incident_id: string | null;
        readonly reasoning: string;
        readonly evidence_quotes: unknown;
        readonly conflicts: unknown;
        readonly uncertainty: unknown;
        readonly record_json: unknown;
        readonly created_at: string | Date;
      }

      const result = await executor.query<DecisionDbRow>(query, [
        input.decisionId,
        input.datasetKind,
        input.reportRevisionId,
        input.decision,
        input.targetIncidentId ?? null,
        input.reasoning,
        evidenceQuotes,
        conflicts,
        uncertainty,
        recordJson,
        now,
      ]);

      const row = result.rows[0];
      return {
        decisionId: row.decision_id,
        datasetKind: row.dataset_kind,
        reportRevisionId: row.report_revision_id,
        decision: row.decision,
        targetIncidentId: row.target_incident_id,
        reasoning: row.reasoning,
        evidenceQuotes: (typeof row.evidence_quotes === "string" ? JSON.parse(row.evidence_quotes) : row.evidence_quotes ?? []) as readonly unknown[],
        conflicts: (typeof row.conflicts === "string" ? JSON.parse(row.conflicts) : row.conflicts ?? []) as readonly unknown[],
        uncertainty: (typeof row.uncertainty === "string" ? JSON.parse(row.uncertainty) : row.uncertainty ?? []) as readonly string[],
        recordJson: (typeof row.record_json === "string" ? JSON.parse(row.record_json) : row.record_json ?? {}) as Record<string, unknown>,
        createdAt: new Date(row.created_at).toISOString(),
      };
    },

    async getIncidentById(datasetKind: DatasetKind, incidentId: string): Promise<{
      readonly incident: IncidentRecord;
      readonly contributingReports: readonly IncidentReportLink[];
      readonly decisions: readonly IncidentCorrelationDecisionRecord[];
    } | null> {
      const incidentResult = await executor.query<IncidentDbRow>(
        `SELECT
           incident_id, dataset_kind, title, description, incident_type,
           status, severity, location_label, ST_AsGeoJSON(shape) AS shape_geojson,
           event_time, first_observed_at, last_updated_at, discrepancies,
           uncertainty_notes, record_json, created_at
         FROM waspada.incidents
         WHERE dataset_kind = $1 AND incident_id = $2`,
        [datasetKind, incidentId],
      );

      if (incidentResult.rows.length === 0) return null;

      const incident = formatRowToIncident(incidentResult.rows[0]);

      interface LinkDbRow {
        readonly dataset_kind: DatasetKind;
        readonly incident_id: string;
        readonly report_revision_id: string;
        readonly relationship: IncidentRelationship;
        readonly correlation_decision_id: string | null;
        readonly linked_at: string | Date;
      }

      const linksResult = await executor.query<LinkDbRow>(
        `SELECT
           dataset_kind, incident_id, report_revision_id, relationship,
           correlation_decision_id, linked_at
         FROM waspada.incident_reports
         WHERE dataset_kind = $1 AND incident_id = $2
         ORDER BY linked_at ASC`,
        [datasetKind, incidentId],
      );

      const contributingReports: IncidentReportLink[] = linksResult.rows.map((r) => ({
        datasetKind: r.dataset_kind,
        incidentId: r.incident_id,
        reportRevisionId: r.report_revision_id,
        relationship: r.relationship,
        correlationDecisionId: r.correlation_decision_id,
        linkedAt: new Date(r.linked_at).toISOString(),
      }));

      interface DecisionDbRow {
        readonly decision_id: string;
        readonly dataset_kind: DatasetKind;
        readonly report_revision_id: string;
        readonly decision: CorrelationDecision;
        readonly target_incident_id: string | null;
        readonly reasoning: string;
        readonly evidence_quotes: unknown;
        readonly conflicts: unknown;
        readonly uncertainty: unknown;
        readonly record_json: unknown;
        readonly created_at: string | Date;
      }

      const decisionsResult = await executor.query<DecisionDbRow>(
        `SELECT
           d.decision_id, d.dataset_kind, d.report_revision_id, d.decision,
           d.target_incident_id, d.reasoning, d.evidence_quotes, d.conflicts,
           d.uncertainty, d.record_json, d.created_at
         FROM waspada.incident_correlation_decisions d
         WHERE d.dataset_kind = $1 AND (
           d.target_incident_id = $2
           OR d.decision_id IN (
             SELECT correlation_decision_id
             FROM waspada.incident_reports
             WHERE dataset_kind = $1 AND incident_id = $2 AND correlation_decision_id IS NOT NULL
           )
         )
         ORDER BY d.created_at ASC`,
        [datasetKind, incidentId],
      );

      const decisions: IncidentCorrelationDecisionRecord[] = decisionsResult.rows.map((r) => ({
        decisionId: r.decision_id,
        datasetKind: r.dataset_kind,
        reportRevisionId: r.report_revision_id,
        decision: r.decision,
        targetIncidentId: r.target_incident_id,
        reasoning: r.reasoning,
        evidenceQuotes: (typeof r.evidence_quotes === "string" ? JSON.parse(r.evidence_quotes) : r.evidence_quotes ?? []) as readonly unknown[],
        conflicts: (typeof r.conflicts === "string" ? JSON.parse(r.conflicts) : r.conflicts ?? []) as readonly unknown[],
        uncertainty: (typeof r.uncertainty === "string" ? JSON.parse(r.uncertainty) : r.uncertainty ?? []) as readonly string[],
        recordJson: (typeof r.record_json === "string" ? JSON.parse(r.record_json) : r.record_json ?? {}) as Record<string, unknown>,
        createdAt: new Date(r.created_at).toISOString(),
      }));

      return { incident, contributingReports, decisions };
    },

    async listActiveIncidents(datasetKind: DatasetKind, options?: { limit?: number; offset?: number }): Promise<readonly IncidentRecord[]> {
      const limit = Math.min(Math.max(options?.limit ?? 50, 1), 200);
      const offset = Math.max(options?.offset ?? 0, 0);

      const result = await executor.query<IncidentDbRow>(
        `SELECT
           incident_id, dataset_kind, title, description, incident_type,
           status, severity, location_label, ST_AsGeoJSON(shape) AS shape_geojson,
           event_time, first_observed_at, last_updated_at, discrepancies,
           uncertainty_notes, record_json, created_at
         FROM waspada.incidents
         WHERE dataset_kind = $1 AND status IN ('investigating', 'active', 'monitoring')
         ORDER BY last_updated_at DESC
         LIMIT $2 OFFSET $3`,
        [datasetKind, limit, offset],
      );

      return result.rows.map(formatRowToIncident);
    },

    async getIncidentForReport(datasetKind: DatasetKind, reportRevisionId: string): Promise<IncidentRecord | null> {
      const result = await executor.query<IncidentDbRow>(
        `SELECT
           i.incident_id, i.dataset_kind, i.title, i.description, i.incident_type,
           i.status, i.severity, i.location_label, ST_AsGeoJSON(i.shape) AS shape_geojson,
           i.event_time, i.first_observed_at, i.last_updated_at, i.discrepancies,
           i.uncertainty_notes, i.record_json, i.created_at
         FROM waspada.incidents i
         JOIN waspada.incident_reports r
           ON r.dataset_kind = i.dataset_kind AND r.incident_id = i.incident_id
         WHERE r.dataset_kind = $1 AND r.report_revision_id = $2
         LIMIT 1`,
        [datasetKind, reportRevisionId],
      );

      if (result.rows.length === 0) return null;
      return formatRowToIncident(result.rows[0]);
    },

    async enqueueAiJob(input: EnqueueAiJobInput): Promise<AiJobRecord> {
      const now = input.createdAt ?? new Date().toISOString();
      const availableAt = input.availableAt ?? now;

      const query = `
        INSERT INTO waspada.ai_jobs (
          job_id, dataset_kind, report_revision_id, trace_id,
          status, attempt_count, max_attempts, available_at,
          created_at, updated_at
        )
        VALUES ($1, $2, $3, $4, 'pending', 0, 5, $5, $6, $6)
        ON CONFLICT (dataset_kind, report_revision_id) DO UPDATE
          SET updated_at = EXCLUDED.updated_at
        RETURNING
          job_id, dataset_kind, report_revision_id, status, attempt_count,
          max_attempts, available_at, lease_token, lease_started_at,
          lease_expires_at, last_failure_code, trace_id, created_at,
          updated_at, finished_at
      `;

      const result = await executor.query<AiJobDbRow>(query, [
        input.jobId,
        input.datasetKind,
        input.reportRevisionId,
        input.traceId ?? null,
        availableAt,
        now,
      ]);

      return formatRowToJob(result.rows[0]);
    },

    async claimAiJob(input?: ClaimAiJobInput): Promise<{ readonly job: AiJobRecord; readonly leaseToken: string } | null> {
      const nowStr = input?.now ?? new Date().toISOString();
      const leaseDurationMs = input?.leaseDurationMs ?? 300_000;
      const leaseToken = crypto.randomUUID();

      const selectQuery = `
        SELECT job_id
        FROM waspada.ai_jobs
        WHERE (
          (status IN ('pending', 'retry') AND available_at <= $1)
          OR (status = 'leased' AND lease_expires_at < $1)
        )
        ${input?.datasetKind ? "AND dataset_kind = $2" : ""}
        ORDER BY available_at ASC, created_at ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      `;

      const selectParams = input?.datasetKind ? [nowStr, input.datasetKind] : [nowStr];
      const selectResult = await executor.query<{ job_id: string }>(selectQuery, selectParams);

      if (selectResult.rows.length === 0) return null;
      const jobId = selectResult.rows[0].job_id;

      const updateQuery = `
        UPDATE waspada.ai_jobs
        SET
          status = 'leased',
          attempt_count = attempt_count + 1,
          lease_token = $2,
          lease_started_at = $1,
          lease_expires_at = $1::timestamptz + ($3 || ' milliseconds')::interval,
          updated_at = $1
        WHERE job_id = $4
        RETURNING
          job_id, dataset_kind, report_revision_id, status, attempt_count,
          max_attempts, available_at, lease_token, lease_started_at,
          lease_expires_at, last_failure_code, trace_id, created_at,
          updated_at, finished_at
      `;

      const updateResult = await executor.query<AiJobDbRow>(updateQuery, [
        nowStr,
        leaseToken,
        leaseDurationMs.toString(),
        jobId,
      ]);

      if (updateResult.rows.length === 0) return null;
      return {
        job: formatRowToJob(updateResult.rows[0]),
        leaseToken,
      };
    },

    async renewAiJob(jobId: string, leaseToken: string, leaseDurationMs: number = 300_000, now?: string): Promise<boolean> {
      const nowStr = now ?? new Date().toISOString();
      const query = `
        UPDATE waspada.ai_jobs
        SET
          lease_expires_at = $1::timestamptz + ($2 || ' milliseconds')::interval,
          updated_at = $1
        WHERE job_id = $3 AND lease_token = $4 AND status = 'leased'
        RETURNING job_id
      `;

      const result = await executor.query<{ job_id: string }>(query, [
        nowStr,
        leaseDurationMs.toString(),
        jobId,
        leaseToken,
      ]);

      return result.rows.length > 0;
    },

    async completeAiJob(jobId: string, leaseToken: string, now?: string): Promise<boolean> {
      const nowStr = now ?? new Date().toISOString();
      const query = `
        UPDATE waspada.ai_jobs
        SET
          status = 'completed',
          lease_token = NULL,
          lease_started_at = NULL,
          lease_expires_at = NULL,
          finished_at = $1,
          updated_at = $1
        WHERE job_id = $2 AND lease_token = $3 AND status = 'leased'
        RETURNING job_id
      `;

      const result = await executor.query<{ job_id: string }>(query, [nowStr, jobId, leaseToken]);
      return result.rows.length > 0;
    },

    async failAiJob(
      jobId: string,
      leaseToken: string,
      failureCode: string,
      retryBackoffMs: number = 10_000,
      now?: string,
    ): Promise<{ readonly status: "retry" | "terminal" | "needs_review"; readonly attemptCount: number }> {
      const nowStr = now ?? new Date().toISOString();

      const jobRes = await executor.query<{ attempt_count: number | string; max_attempts: number | string }>(
        `SELECT attempt_count, max_attempts FROM waspada.ai_jobs WHERE job_id = $1 AND lease_token = $2`,
        [jobId, leaseToken],
      );

      if (jobRes.rows.length === 0) {
        throw new Error(`Active leased job not found: ${jobId}`);
      }

      const attemptCount = Number(jobRes.rows[0].attempt_count);
      const maxAttempts = Number(jobRes.rows[0].max_attempts);

      if (attemptCount >= maxAttempts) {
        await executor.query(
          `UPDATE waspada.ai_jobs
           SET
             status = 'needs_review',
             lease_token = NULL,
             lease_started_at = NULL,
             lease_expires_at = NULL,
             last_failure_code = $1,
             finished_at = $2,
             updated_at = $2
           WHERE job_id = $3 AND lease_token = $4`,
          [failureCode, nowStr, jobId, leaseToken],
        );
        return { status: "needs_review", attemptCount };
      }

      await executor.query(
        `UPDATE waspada.ai_jobs
         SET
           status = 'retry',
           lease_token = NULL,
           lease_started_at = NULL,
           lease_expires_at = NULL,
           last_failure_code = $1,
           available_at = $2::timestamptz + ($3 || ' milliseconds')::interval,
           updated_at = $2
         WHERE job_id = $4 AND lease_token = $5`,
        [failureCode, nowStr, retryBackoffMs.toString(), jobId, leaseToken],
      );

      return { status: "retry", attemptCount };
    },

    async markAiJobNeedsReview(jobId: string, leaseToken: string, reasonCode: string, now?: string): Promise<boolean> {
      const nowStr = now ?? new Date().toISOString();
      const result = await executor.query<{ job_id: string }>(
        `UPDATE waspada.ai_jobs
         SET
           status = 'needs_review',
           lease_token = NULL,
           lease_started_at = NULL,
           lease_expires_at = NULL,
           last_failure_code = $1,
           finished_at = $2,
           updated_at = $2
         WHERE job_id = $3 AND lease_token = $4 AND status = 'leased'
         RETURNING job_id`,
        [reasonCode, nowStr, jobId, leaseToken],
      );
      return result.rows.length > 0;
    },

    async retryAiJob(jobId: string, now?: string): Promise<boolean> {
      const nowStr = now ?? new Date().toISOString();
      const result = await executor.query<{ job_id: string }>(
        `UPDATE waspada.ai_jobs
         SET
           status = 'pending',
           attempt_count = 0,
           lease_token = NULL,
           lease_started_at = NULL,
           lease_expires_at = NULL,
           available_at = $1,
           finished_at = NULL,
           updated_at = $1
         WHERE job_id = $2 AND status IN ('retry', 'terminal', 'needs_review')
         RETURNING job_id`,
        [nowStr, jobId],
      );
      return result.rows.length > 0;
    },

    async getAiJob(jobId: string): Promise<AiJobRecord | null> {
      const result = await executor.query<AiJobDbRow>(
        `SELECT
           job_id, dataset_kind, report_revision_id, status, attempt_count,
           max_attempts, available_at, lease_token, lease_started_at,
           lease_expires_at, last_failure_code, trace_id, created_at,
           updated_at, finished_at
         FROM waspada.ai_jobs
         WHERE job_id = $1`,
        [jobId],
      );
      if (result.rows.length === 0) return null;
      return formatRowToJob(result.rows[0]);
    },

    async listAiJobs(options?: {
      status?: AiJobStatus;
      datasetKind?: DatasetKind;
      limit?: number;
    }): Promise<readonly AiJobRecord[]> {
      const conditions: string[] = [];
      const params: unknown[] = [];
      let pIdx = 1;

      if (options?.status) {
        conditions.push(`status = $${pIdx++}`);
        params.push(options.status);
      }
      if (options?.datasetKind) {
        conditions.push(`dataset_kind = $${pIdx++}`);
        params.push(options.datasetKind);
      }

      const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
      const limit = Math.min(options?.limit ?? 50, 100);
      params.push(limit);

      const query = `
        SELECT
          job_id, dataset_kind, report_revision_id, status, attempt_count,
          max_attempts, available_at, lease_token, lease_started_at,
          lease_expires_at, last_failure_code, trace_id, created_at,
          updated_at, finished_at
        FROM waspada.ai_jobs
        ${whereClause}
        ORDER BY created_at DESC
        LIMIT $${pIdx}
      `;

      const result = await executor.query<AiJobDbRow>(query, params);
      return result.rows.map(formatRowToJob);
    },

    async persistIncidentProcessingTransaction(
      input: PersistIncidentProcessingInput,
    ): Promise<PersistIncidentProcessingResult> {
      const now = input.now ?? new Date().toISOString();
      const pipelineVersion = input.pipelineVersion ?? "v1";

      return runInTransaction(executor, async (tx) => {
        // 1. Validate worker lease token and status with row lock
        const jobRes = await tx.query<AiJobDbRow>(
          `SELECT job_id, dataset_kind, report_revision_id, status, lease_token, lease_expires_at
           FROM waspada.ai_jobs
           WHERE job_id = $1
           FOR UPDATE`,
          [input.jobId],
        );

        if (jobRes.rows.length === 0) {
          throw new StaleLeaseError(`Job not found: ${input.jobId}`);
        }

        const job = jobRes.rows[0];
        if (job.status !== "leased" || job.lease_token !== input.leaseToken) {
          throw new StaleLeaseError(
            `Worker lease invalid or preempted for job ${input.jobId} (current status: ${job.status}, expected token: ${input.leaseToken})`,
          );
        }

        const leaseExpires = job.lease_expires_at ? new Date(job.lease_expires_at).getTime() : 0;
        if (leaseExpires <= new Date(now).getTime()) {
          throw new StaleLeaseError(
            `Worker lease expired for job ${input.jobId} at ${job.lease_expires_at}`,
          );
        }

        // 2. Check pipeline processing idempotency
        const existingRec = await tx.query<{
          incident_id: string;
          decision_id: string;
          proposal_id: string;
        }>(
          `SELECT incident_id, decision_id, proposal_id
           FROM waspada.incident_processing_records
           WHERE dataset_kind = $1 AND report_revision_id = $2 AND pipeline_version = $3`,
          [input.datasetKind, input.reportRevisionId, pipelineVersion],
        );

        if (existingRec.rows.length > 0) {
          const rec = existingRec.rows[0];
          await tx.query(
            `UPDATE waspada.ai_jobs
             SET status = 'completed',
                 finished_at = COALESCE(finished_at, $2),
                 lease_token = NULL,
                 lease_started_at = NULL,
                 lease_expires_at = NULL,
                 updated_at = $2
             WHERE job_id = $1`,
            [input.jobId, now],
          );
          return {
            outcome: "already_processed",
            incidentId: rec.incident_id,
            decisionId: rec.decision_id,
            proposalId: rec.proposal_id,
          };
        }

        // 3. Apply Incident Create or Update
        let targetIncidentId: string;
        if (input.incidentAction.type === "create") {
          const inc = input.incidentAction.incident;
          targetIncidentId = inc.incidentId;
          const status = inc.status ?? "investigating";
          const severity = inc.severity ?? "unknown";
          const incCreated = inc.createdAt ?? now;
          const incUpdated = inc.lastUpdatedAt ?? now;
          const discrepancies = JSON.stringify(inc.discrepancies ?? []);
          const uncertaintyNotes = JSON.stringify(inc.uncertaintyNotes ?? []);
          const eventTime = JSON.stringify(inc.eventTime ?? {});
          const recordJson = JSON.stringify(inc.recordJson ?? {});

          let shapeSql = "NULL";
          const params: unknown[] = [
            inc.incidentId,
            inc.datasetKind,
            inc.title,
            inc.description,
            inc.incidentType,
            status,
            severity,
            inc.locationLabel ?? null,
            eventTime,
            inc.firstObservedAt,
            incUpdated,
            discrepancies,
            uncertaintyNotes,
            recordJson,
            incCreated,
          ];
          if (inc.coordinates) {
            shapeSql = `ST_SetSRID(ST_MakePoint($16, $17), 4326)`;
            params.push(inc.coordinates[0], inc.coordinates[1]);
          }

          await tx.query(
            `INSERT INTO waspada.incidents (
              incident_id, dataset_kind, title, description, incident_type,
              status, severity, location_label, shape, event_time,
              first_observed_at, last_updated_at, discrepancies, uncertainty_notes,
              record_json, created_at
            )
            VALUES (
              $1, $2, $3, $4, $5,
              $6, $7, $8, ${shapeSql}, $9,
              $10, $11, $12::jsonb, $13::jsonb,
              $14::jsonb, $15
            )
            ON CONFLICT (dataset_kind, incident_id) DO NOTHING`,
            params,
          );
        } else {
          const upd = input.incidentAction.incident;
          targetIncidentId = upd.incidentId;
          const updates: string[] = ["last_updated_at = $3"];
          const params: unknown[] = [upd.datasetKind, upd.incidentId, upd.lastUpdatedAt];
          let pIdx = 4;
          if (upd.title !== undefined) {
            updates.push(`title = $${pIdx++}`);
            params.push(upd.title);
          }
          if (upd.description !== undefined) {
            updates.push(`description = $${pIdx++}`);
            params.push(upd.description);
          }
          if (upd.incidentType !== undefined) {
            updates.push(`incident_type = $${pIdx++}`);
            params.push(upd.incidentType);
          }
          if (upd.status !== undefined) {
            updates.push(`status = $${pIdx++}`);
            params.push(upd.status);
          }
          if (upd.severity !== undefined) {
            updates.push(`severity = $${pIdx++}`);
            params.push(upd.severity);
          }
          if (upd.locationLabel !== undefined) {
            updates.push(`location_label = $${pIdx++}`);
            params.push(upd.locationLabel);
          }
          if (upd.coordinates !== undefined) {
            if (upd.coordinates === null) {
              updates.push(`shape = NULL`);
            } else {
              updates.push(`shape = ST_SetSRID(ST_MakePoint($${pIdx++}, $${pIdx++}), 4326)`);
              params.push(upd.coordinates[0], upd.coordinates[1]);
            }
          }
          if (upd.discrepancies !== undefined) {
            updates.push(`discrepancies = $${pIdx++}::jsonb`);
            params.push(JSON.stringify(upd.discrepancies));
          }
          if (upd.uncertaintyNotes !== undefined) {
            updates.push(`uncertainty_notes = $${pIdx++}::jsonb`);
            params.push(JSON.stringify(upd.uncertaintyNotes));
          }
          if (upd.recordJson !== undefined) {
            updates.push(`record_json = $${pIdx++}::jsonb`);
            params.push(JSON.stringify(upd.recordJson));
          }

          await tx.query(
            `UPDATE waspada.incidents
             SET ${updates.join(", ")}
             WHERE dataset_kind = $1 AND incident_id = $2`,
            params,
          );
        }

        // 4. Record Correlation Decision
        const dec = input.correlationDecision;
        const decCreated = dec.createdAt ?? now;
        await tx.query(
          `INSERT INTO waspada.incident_correlation_decisions (
            decision_id, dataset_kind, report_revision_id, decision,
            target_incident_id, reasoning, evidence_quotes, conflicts,
            uncertainty, record_json, created_at
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9::jsonb, $10::jsonb, $11)
          ON CONFLICT (dataset_kind, decision_id) DO NOTHING`,
          [
            dec.decisionId,
            dec.datasetKind,
            dec.reportRevisionId,
            dec.decision,
            dec.targetIncidentId,
            dec.reasoning,
            JSON.stringify(dec.evidenceQuotes ?? []),
            JSON.stringify(dec.conflicts ?? []),
            JSON.stringify(dec.uncertainty ?? []),
            JSON.stringify(dec.recordJson ?? {}),
            decCreated,
          ],
        );

        // 5. Link Report Revision to Incident
        await tx.query(
          `INSERT INTO waspada.incident_reports (
            dataset_kind, incident_id, report_revision_id, relationship,
            correlation_decision_id, linked_at
          )
          VALUES ($1, $2, $3, $4, $5, $6)
          ON CONFLICT (dataset_kind, incident_id, report_revision_id)
          DO UPDATE SET
            relationship = EXCLUDED.relationship,
            correlation_decision_id = EXCLUDED.correlation_decision_id,
            linked_at = EXCLUDED.linked_at`,
          [
            input.datasetKind,
            targetIncidentId,
            input.reportRevisionId,
            input.reportLink.relationship,
            dec.decisionId,
            now,
          ],
        );

        // 6. Persist Proposal and Claims
        await persistProposalWithTx(tx, input.proposal, input.datasetKind);

        // 7. Record Idempotency Record
        await tx.query(
          `INSERT INTO waspada.incident_processing_records (
            dataset_kind, report_revision_id, pipeline_version,
            incident_id, decision_id, proposal_id, processed_at
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7)
          ON CONFLICT (dataset_kind, report_revision_id, pipeline_version) DO NOTHING`,
          [
            input.datasetKind,
            input.reportRevisionId,
            pipelineVersion,
            targetIncidentId,
            dec.decisionId,
            input.proposal.proposal_id,
            now,
          ],
        );

        // 8. Mark AI Job as Completed
        await tx.query(
          `UPDATE waspada.ai_jobs
           SET status = 'completed',
               finished_at = $2,
               lease_token = NULL,
               lease_started_at = NULL,
               lease_expires_at = NULL,
               updated_at = $2
           WHERE job_id = $1`,
          [input.jobId, now],
        );

        return {
          outcome: "committed",
          incidentId: targetIncidentId,
          decisionId: dec.decisionId,
          proposalId: input.proposal.proposal_id,
        };
      });
    },
  };
}
