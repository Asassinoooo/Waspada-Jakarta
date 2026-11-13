import { createHash } from "node:crypto";
import { createSqlGroundingContextRepository } from "../src/grounding-contexts.js";
import { createRepositoryPorts, type DatasetKind } from "../src/ports.js";
import type { TransactionalSqlExecutor } from "../src/sql.js";

/**
 * Test-only. The lineage a live proposal must reference (F-TRACE-02): a trace, a registry source,
 * a report revision with one evidence span, the candidate extracted from it and the grounding context
 * built on that span. Written through the production repositories, so every row is real and validated.
 * Authored synthetic data only. Call once per key per database.
 */

export interface ProposalLineage {
  readonly trace_id: string;
  readonly candidate_id: string;
  readonly context_id: string;
}

const NOW = "2026-11-10T08:00:00.000Z";
const TEXT = "Genangan setinggi 50 cm di Cawang (fiktif)";

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** The ids seedProposalLineage(key) writes, for literals that must name them before the seed runs. */
export function lineageIdsFor(key: string): ProposalLineage {
  return {
    trace_id: `trace-lineage-${key}`,
    candidate_id: `cand-lineage-${key}`,
    context_id: `ctx-lineage-${key}`,
  };
}

/**
 * `retrievedAt` is the revision's retrieval time. A test that counts reports in time windows passes a
 * time outside every window it counts, so the fixture revision does not change those counts.
 */
export async function seedProposalLineage(
  executor: TransactionalSqlExecutor,
  key: string,
  datasetKind: DatasetKind = "live",
  retrievedAt: string = NOW,
): Promise<ProposalLineage> {
  const ids = lineageIdsFor(key);
  const traceId = ids.trace_id;
  const sourceId = `source-lineage-${key}`;
  const revisionId = `rev-lineage-${key}`;
  const candidateId = ids.candidate_id;
  const contextId = ids.context_id;
  const textHash = sha256(TEXT);
  const ports = createRepositoryPorts(executor);

  await ports.tracesAndAudit.createTrace({
    traceId,
    datasetKind,
    startedAt: NOW,
    endedAt: null,
    outcome: "open",
    metadata: { fixture: "authored-synthetic-only" },
  });
  await executor.query(
    `INSERT INTO waspada.source_registry
       (source_id, trace_id, registry_version, display_name, source_kind, remit, access_method,
        approved_hosts, access_restrictions, reuse_basis, registry_status, approval_status,
        health_status, auto_acquisition_enabled, auto_publication_policy)
     VALUES ($1, $2, 1, 'Fictional lineage source', 'other', ARRAY['fixture'], 'manual_fixture',
        ARRAY[]::text[], ARRAY['fictional'], ARRAY['public_display'], 'active', 'approved',
        'healthy', true, 'never')
     ON CONFLICT (source_id) DO NOTHING`,
    [sourceId, traceId],
  );
  await ports.reportRevisions.create({
    datasetKind,
    reportRevisionId: revisionId,
    traceId,
    sourceId,
    canonicalUrl: "https://lineage.invalid/" + key,
    sourceRevisionKey: null,
    contentHash: sha256("lineage payload " + key),
    permittedText: TEXT,
    permittedTextHash: textHash,
    normalizationVersion: "lineage-fixture-v1",
    publishedAt: null,
    observedAt: null,
    retrievedAt,
    validFrom: null,
    validUntil: null,
    supersedesId: null,
    revisionStatus: "eligible",
    recordJson: { fixture: "authored-synthetic-only" },
  });
  await ports.reportRevisions.createEvidenceReference({
    datasetKind,
    traceId,
    reportRevisionId: revisionId,
    permittedTextHash: textHash,
    spanStart: 0,
    spanEnd: Array.from(TEXT).length,
    relation: "supports",
  });
  await executor.query(
    `INSERT INTO waspada.extraction_results
       (dataset_kind, candidate_id, trace_id, report_revision_id, category, record_json)
     VALUES ($1, $2, $3, $4, 'disasters_weather', '{"fixture":"authored-synthetic-only"}'::jsonb)`,
    [datasetKind, candidateId, traceId, revisionId],
  );
  await createSqlGroundingContextRepository(executor).createOrVerify({
    schema_version: "2.0",
    trace_id: traceId,
    record_type: "GroundingContext",
    dataset_kind: datasetKind,
    context_id: contextId,
    candidate_id: candidateId,
    evidence: [{
      report_revision_id: revisionId,
      permitted_text_hash: textHash,
      span_start: 0,
      span_end: Array.from(TEXT).length,
      offset_unit: "unicode_code_points",
      relation: "supports",
    }],
    revision_states: [{ report_revision_id: revisionId, revision_status: "eligible" }],
    candidate_events: [],
    prior_decision_ids: [],
    missing_fields: [],
    conflicts: [],
    retrieval_version: "lineage-fixture-v1",
    index_version: "lineage-fixture-index-v1",
    sufficient: true,
  });

  return ids;
}
