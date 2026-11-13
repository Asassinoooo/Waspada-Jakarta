import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { createTestDatabase, type TestDatabase } from "../../db/test/harness.js";
import { applyMigrations, readMigrations } from "../../db/src/migrations.js";
import { createRepositoryPorts, type NewReportRevision } from "../../db/src/ports.js";
import { createSqlEvidenceChunkRepository } from "../../db/src/evidence-chunks.js";
import { createSqlEmbeddingRunRepository, type EmbeddingRunRecord } from "../../db/src/embedding-runs.js";
import { createSqlGroundingContextRepository, type GroundingContextRecord } from "../../db/src/grounding-contexts.js";
import { createSqlInvestigationLedgerRepository } from "../../db/src/investigation-ledger.js";
import { createEventProposalWriter, type EventProposalDto } from "../../db/src/event-proposal-writer.js";
import {
  AGENT_AUTO_PUBLISHER_ID,
  decideProposal,
  type ProposalDecisionDependencies,
} from "../src/layers/l4-application-integration/proposal-publication.js";

/**
 * FR-14: one trace id follows a report from ingestion through its candidate, embedding model
 * configuration, grounding context, investigation, proposal and publication decision. The chain
 * is written by the production writers on PGlite. Authored synthetic data only.
 *
 * The chain holds on the L2/L3 path, whose proposal carries its lineage ids. The intelligence
 * workflow builds its proposal without them, and those two todo findings record that gap.
 */

const TRACE = "trace-fr14-chain";
const SOURCE = "source-fr14-chain";
const REVISION = "rev-fr14-chain";
const CANDIDATE = "cand-fr14-chain";
const CHUNK = "chunk-fr14-chain";
const EMBEDDING_RUN = "emb-fr14-chain";
const INITIAL_CONTEXT = "ctx-fr14-initial";
const CONTEXT = "ctx-fr14-sufficient";
const INVESTIGATION = "inv-fr14-chain";
const PROPOSAL = "prop-fr14-chain";
const INCIDENT = "inc-fr14-chain";
const WORKFLOW_PROPOSAL = "prop-fr14-workflow";
const WORKFLOW_INCIDENT = "inc-fr14-workflow";
const PLACEHOLDER_PROPOSAL = "prop-fr14-placeholder";
const PLACEHOLDER_INCIDENT = "inc-fr14-placeholder";
const PROVIDER = "chain-test-provider";
const MODEL_VERSION = "chain-embedding-v1";
const TEXT = "Genangan 50 cm di Cawang (fiktif)";
const TEXT_HASH = sha256(TEXT);
const SPAN_END = Array.from(TEXT).length;
const NOW = "2026-11-12T04:00:00.000Z";
const PERMITTED = new Set([SOURCE]);

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** A schema 2.0 proposal. Lineage ids are present only when the caller passes them, as in the L2 bridge. */
function proposal(
  proposalId: string,
  incidentId: string,
  lineage: { readonly trace_id?: string; readonly candidate_id?: string; readonly context_id?: string } = {},
): EventProposalDto {
  const claim = {
    claim_id: "claim-1",
    claim_text: TEXT,
    evidence_label: "attributed_report" as const,
    support_assessment: "supported" as const,
    quote_text: TEXT,
    evidence_ref_id: "chk-" + proposalId,
    source_id: SOURCE,
    outlet: "Outlet Uji",
    source_url: "https://news.example/" + proposalId,
  };
  return {
    schema_version: "2.0",
    proposal_id: proposalId,
    incident_id: incidentId,
    title: "Genangan di Cawang",
    incident_type: "genangan_air_luapan_saluran",
    primary_category: "disasters_weather",
    compatibility_category: "flood",
    severity: "medium",
    event_time: { precision: "exact", value: "2026-11-10T08:00:00.000Z" },
    location_label: "Cawang, Jakarta Timur",
    coordinates: null,
    claims: [claim],
    impacts: [],
    interpretation_category: null,
    source_id: SOURCE,
    is_multi_source: false,
    source_count: 1,
    has_discrepancy: false,
    discrepancy_summary: null,
    discrepancies: [],
    caveats: [],
    correlation_relationship: "primary_initial",
    proposed_at: "2026-11-10T08:05:00.000Z",
    ...lineage,
  } as EventProposalDto;
}

function groundingRecord(
  contextId: string,
  sufficient: boolean,
  traceId: string,
): GroundingContextRecord {
  return {
    schema_version: "2.0",
    trace_id: traceId,
    record_type: "GroundingContext",
    dataset_kind: "live",
    context_id: contextId,
    candidate_id: CANDIDATE,
    evidence: [{
      report_revision_id: REVISION,
      permitted_text_hash: TEXT_HASH,
      span_start: 0,
      span_end: SPAN_END,
      offset_unit: "unicode_code_points",
      relation: "supports",
    }],
    revision_states: [{ report_revision_id: REVISION, revision_status: "eligible" }],
    candidate_events: [],
    prior_decision_ids: [],
    missing_fields: sufficient ? [] : ["service_resume_confirmation"],
    conflicts: [],
    retrieval_version: "hybrid-evidence-v2",
    index_version: "synthetic-index-v1",
    sufficient,
  } as GroundingContextRecord;
}

describe("FR-14 one trace id from report ingestion to publication decision", () => {
  let db: TestDatabase;
  let deps: ProposalDecisionDependencies;

  before(async () => {
    db = await createTestDatabase();
    await applyMigrations(db.executor, await readMigrations(new URL("../../db/migrations/", import.meta.url)));
    deps = {
      executor: db.executor,
      datasetKind: "live",
      checkPublicDisplay: async (sourceId: string) => PERMITTED.has(sourceId),
    };
  });

  after(async () => {
    await db?.close();
  });

  async function traceOf(sql: string, params: readonly unknown[]): Promise<string[]> {
    const result = await db.executor.query<{ trace_id: string }>(sql, [...params]);
    return result.rows.map((row) => row.trace_id);
  }

  it("records the same trace id at ingestion, candidate, embedding, context, investigation, proposal and publication", async () => {
    const ports = createRepositoryPorts(db.executor);

    // Ingestion: the trace, its source, the report revision and its evidence span.
    await ports.tracesAndAudit.createTrace({
      traceId: TRACE,
      datasetKind: "live",
      startedAt: NOW,
      endedAt: null,
      outcome: "open",
      metadata: { fixture: "authored-synthetic-only" },
    });
    await db.executor.query(
      `INSERT INTO waspada.source_registry
         (source_id, trace_id, registry_version, display_name, source_kind, remit, access_method,
          approved_hosts, access_restrictions, reuse_basis, registry_status, approval_status,
          health_status, auto_acquisition_enabled, auto_publication_policy)
       VALUES ($1, $2, 1, 'Fictional chain source', 'other', ARRAY['fixture'], 'manual_fixture',
          ARRAY[]::text[], ARRAY['fictional'], ARRAY['public_display'], 'active', 'approved',
          'healthy', true, 'never')`,
      [SOURCE, TRACE],
    );
    const revision: NewReportRevision = {
      datasetKind: "live",
      reportRevisionId: REVISION,
      traceId: TRACE,
      sourceId: SOURCE,
      canonicalUrl: "https://chain.invalid/fr14",
      sourceRevisionKey: null,
      contentHash: sha256("fr14 report payload"),
      permittedText: TEXT,
      permittedTextHash: TEXT_HASH,
      normalizationVersion: "fr14-normalization-v1",
      publishedAt: null,
      observedAt: null,
      retrievedAt: NOW,
      validFrom: null,
      validUntil: null,
      supersedesId: null,
      revisionStatus: "eligible",
      recordJson: { fixture: "authored-synthetic-only" },
    };
    await ports.reportRevisions.create(revision);
    await ports.reportRevisions.createEvidenceReference({
      datasetKind: "live",
      traceId: TRACE,
      reportRevisionId: REVISION,
      permittedTextHash: TEXT_HASH,
      spanStart: 0,
      spanEnd: SPAN_END,
      relation: "supports",
    });
    await db.executor.query(
      `INSERT INTO waspada.extraction_results
         (dataset_kind, candidate_id, trace_id, report_revision_id, category, record_json)
       VALUES ('live', $1, $2, $3, 'disasters_weather', '{"fixture":"authored-synthetic-only"}'::jsonb)`,
      [CANDIDATE, TRACE, REVISION],
    );

    // Model configuration: the chunk and the embedding run that records its provider and model version.
    await createSqlEvidenceChunkRepository(db.executor).persist({
      datasetKind: "live",
      traceId: TRACE,
      reportRevisionId: REVISION,
      permittedTextHash: TEXT_HASH,
      normalizationVersion: "fr14-normalization-v1",
      chunks: [{
        chunkId: CHUNK,
        reportRevisionId: REVISION,
        permittedTextHash: TEXT_HASH,
        normalizationVersion: "fr14-normalization-v1",
        spanStart: 0,
        spanEnd: SPAN_END,
        offsetUnit: "unicode_code_points",
        chunkTextHash: TEXT_HASH,
        text: TEXT,
        chunkerVersion: "fr14-chunker-v1",
      }],
    });
    const embedding: EmbeddingRunRecord = {
      schema_version: "2.0",
      trace_id: TRACE,
      record_type: "EmbeddingRun",
      dataset_kind: "live",
      embedding_run_id: EMBEDDING_RUN,
      chunk_id: CHUNK,
      capability: "embedding",
      provider: PROVIDER,
      model_version: MODEL_VERSION,
      dimensions: 2,
      distance_metric: "cosine",
      vector_index_version: "fr14-index-v1",
      input_text_hash: TEXT_HASH,
      status: "available",
      created_at: NOW,
    };
    assert.equal(await createSqlEmbeddingRunRepository(db.executor).createOrVerify(embedding, [1, 0]), "created");

    // Context: an insufficient initial context opens the investigation; a sufficient one grounds the proposal.
    const contexts = createSqlGroundingContextRepository(db.executor);
    await contexts.createOrVerify(groundingRecord(INITIAL_CONTEXT, false, TRACE));
    await contexts.createOrVerify(groundingRecord(CONTEXT, true, TRACE));

    // Investigation: the L3 ledger opens a case on the report's candidate.
    const ledger = await createSqlInvestigationLedgerRepository(db.executor).create({
      datasetKind: "live",
      investigationId: INVESTIGATION,
      traceId: TRACE,
      candidateId: CANDIDATE,
      contextId: INITIAL_CONTEXT,
      fingerprintKeyId: "fixture-hmac-v1",
      initialGroundingDigestHex: sha256("fr14-initial-grounding"),
      eventId: null,
      eventVersion: null,
      questions: ["Which synthetic detail is still unknown?"],
      policyVersion: "budget-policy-v1",
      limits: { toolAttempts: 5, reasoningTurns: 4, activeSeconds: 60, modelTokens: 12_000 },
      requestedAt: NOW,
    });
    assert.equal(ledger.context_id, INITIAL_CONTEXT);

    // Proposal and publication: the L2 bridge output carries the lineage ids; the gate decides.
    await createEventProposalWriter(db.executor).persistProposal(
      proposal(PROPOSAL, INCIDENT, { trace_id: TRACE, candidate_id: CANDIDATE, context_id: CONTEXT }),
      "live",
    );
    const decision = await decideProposal(deps, {
      proposalId: PROPOSAL,
      action: "auto_publish",
      actor: { kind: "agent", actorId: AGENT_AUTO_PUBLISHER_ID },
    });
    assert.equal(decision.status, "published", JSON.stringify(decision));

    // One trace id, every stage that records one.
    assert.deepEqual(await traceOf("SELECT trace_id FROM waspada.report_revisions WHERE dataset_kind = 'live' AND report_revision_id = $1", [REVISION]), [TRACE], "ingestion");
    assert.deepEqual(await traceOf("SELECT trace_id FROM waspada.extraction_results WHERE dataset_kind = 'live' AND candidate_id = $1", [CANDIDATE]), [TRACE], "candidate");
    assert.deepEqual(await traceOf("SELECT trace_id FROM waspada.evidence_chunks WHERE dataset_kind = 'live' AND chunk_id = $1", [CHUNK]), [TRACE], "chunk");
    assert.deepEqual(await traceOf("SELECT trace_id FROM waspada.embedding_runs WHERE dataset_kind = 'live' AND embedding_run_id = $1", [EMBEDDING_RUN]), [TRACE], "embedding run");
    const model = await db.executor.query<{ provider: string; model_version: string }>(
      "SELECT provider, model_version FROM waspada.embedding_runs WHERE dataset_kind = 'live' AND embedding_run_id = $1",
      [EMBEDDING_RUN],
    );
    assert.deepEqual(model.rows, [{ provider: PROVIDER, model_version: MODEL_VERSION }], "model configuration is recorded with the run");
    assert.deepEqual(await traceOf("SELECT trace_id FROM waspada.grounding_contexts WHERE dataset_kind = 'live' AND context_id = $1", [CONTEXT]), [TRACE], "grounding context");
    assert.deepEqual(await traceOf("SELECT trace_id FROM waspada.investigation_requests WHERE dataset_kind = 'live' AND investigation_id = $1", [INVESTIGATION]), [TRACE], "investigation");
    assert.deepEqual(await traceOf("SELECT trace_id FROM waspada.event_proposals WHERE dataset_kind = 'live' AND proposal_id = $1", [PROPOSAL]), [TRACE], "proposal");
    assert.deepEqual(await traceOf("SELECT trace_id FROM waspada.publication_decisions WHERE dataset_kind = 'live' AND proposal_id = $1", [PROPOSAL]), [TRACE], "publication decision");
    assert.deepEqual(await traceOf("SELECT trace_id FROM waspada.event_versions WHERE dataset_kind = 'live' AND event_id = $1 AND version = 1", [INCIDENT]), [TRACE], "published version");
  });

  it("F-TRACE-01 the intelligence-workflow proposal keeps the report's trace id",
    { todo: "F-TRACE-01 proposal stage has no trace id from the report: the workflow DTO has no trace_id, so the writer assigns trace-<proposal_id>" },
    async () => {
      // The DTO exactly as incident-intelligence-workflow.ts builds it: no trace_id, candidate_id or context_id.
      await createEventProposalWriter(db.executor).persistProposal(
        proposal(WORKFLOW_PROPOSAL, WORKFLOW_INCIDENT),
        "live",
      );
      assert.deepEqual(
        await traceOf("SELECT trace_id FROM waspada.event_proposals WHERE dataset_kind = 'live' AND proposal_id = $1", [WORKFLOW_PROPOSAL]),
        [TRACE],
        "the proposal carries the report's trace id",
      );
    });

  it("F-TRACE-02 a proposal without lineage ids writes no invented placeholder provenance",
    { todo: "F-TRACE-02 proposal writer invents placeholder trace, source, revision and context rows when lineage ids are absent" },
    async () => {
      await createEventProposalWriter(db.executor).persistProposal(
        proposal(PLACEHOLDER_PROPOSAL, PLACEHOLDER_INCIDENT),
        "live",
      );
      const count = async (sql: string, id: string) => (await db.executor.query<{ n: number }>(sql, [id])).rows[0]?.n ?? -1;
      const invented = {
        traces: await count("SELECT COUNT(*)::int AS n FROM waspada.traces WHERE trace_id = $1", "trace-" + PLACEHOLDER_PROPOSAL),
        sources: await count("SELECT COUNT(*)::int AS n FROM waspada.source_registry WHERE source_id = $1", "source-candidate-" + PLACEHOLDER_PROPOSAL),
        revisions: await count("SELECT COUNT(*)::int AS n FROM waspada.report_revisions WHERE report_revision_id = $1", "rev-candidate-" + PLACEHOLDER_PROPOSAL),
        contexts: await count("SELECT COUNT(*)::int AS n FROM waspada.grounding_contexts WHERE context_id = $1", "context-" + PLACEHOLDER_PROPOSAL),
      };
      assert.deepEqual(invented, { traces: 0, sources: 0, revisions: 0, contexts: 0 },
        "no trace, source, report revision or grounding context is invented for a proposal from a report");
    });
});
