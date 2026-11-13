import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { createTestDatabase, type TestDatabase } from "../../db/test/harness.js";
import { applyMigrations, readMigrations } from "../../db/src/migrations.js";
import { createRepositoryPorts, type NewReportRevision } from "../../db/src/ports.js";
import type { z } from "zod";
import {
  createIncidentIntelligenceWorkflow,
  IncidentWorkflowInputSchema,
  type IncidentWorkflowOutput,
} from "../src/workflows/incident-intelligence-workflow.js";
import { recordModelConfiguration } from "../src/workflows/proposal-lineage.js";
import { createMockCorrelatorAgent, createMockInterpreterAgent } from "./mock-agents.js";

type IncidentWorkflowInput = z.infer<typeof IncidentWorkflowInputSchema>;

/**
 * FR-14 on the live intelligence path. The workflow runs against PGlite with mock agents and a
 * live-shaped report: a registry source, a report revision with one evidence chunk, and a job trace.
 * Authored synthetic data only. No model or network call.
 */

const TRACE = "trace-live-lineage-01";
const SOURCE = "source-live-lineage";
const REVISION = "rev-live-lineage-01";
const CHUNK = "chk-live-lineage-01-0";
const TEXT = "Genangan 50 cm di Cawang (fiktif)";
const QUOTE = "Genangan 50 cm";
const NOW = "2026-11-12T04:00:00.000Z";
const FIXTURE_TRACE = "trace-live-lineage-fixture";
const FIXTURE_REVISION = "rev-live-lineage-fixture";
const MISSING_REVISION = "rev-live-lineage-missing";

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

const TEXT_HASH = sha256(TEXT);
const SPAN_END = Array.from(TEXT).length;

function interpreter(chunkId: string) {
  return createMockInterpreterAgent({
    summary: "Genangan 50 cm di Cawang",
    incidentType: "genangan_air_luapan_saluran",
    primaryCategory: "disasters_weather",
    evidence: [{ chunkId, exactQuote: QUOTE, supports: "Genangan di Cawang" }],
  });
}

function workflow(db: TestDatabase, extra: { readonly syntheticFixtureLineage?: boolean } = {}) {
  return createIncidentIntelligenceWorkflow({
    executor: db.executor,
    agentOverrides: {
      interpreter: interpreter(CHUNK),
      correlator: createMockCorrelatorAgent({ decision: "new_incident", candidateIncidentId: null }),
    },
    ...extra,
  });
}

function liveInput(reportRevisionId: string, traceId: string, datasetKind: "live" | "synthetic"): IncidentWorkflowInput {
  return {
    reportRevisionId,
    reportText: TEXT,
    sourceKind: "rss",
    sourceDisplayName: "Outlet Uji",
    sourceId: SOURCE,
    sourceUrl: "https://chain.invalid/live-lineage",
    publishedAt: NOW,
    datasetKind,
    traceId,
    evidenceChunks: [{ chunkId: CHUNK, spanStart: 0, spanEnd: SPAN_END, text: TEXT }],
  };
}

describe("live intelligence lineage (FR-14)", () => {
  let db: TestDatabase;

  before(async () => {
    db = await createTestDatabase();
    await applyMigrations(db.executor, await readMigrations(new URL("../../db/migrations/", import.meta.url)));
    const ports = createRepositoryPorts(db.executor);
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
       VALUES ($1, $2, 1, 'Outlet Uji', 'other', ARRAY['fixture'], 'manual_fixture',
          ARRAY[]::text[], ARRAY['fictional'], ARRAY['public_display'], 'active', 'approved',
          'healthy', true, 'never')`,
      [SOURCE, TRACE],
    );
    const revision: NewReportRevision = {
      datasetKind: "live",
      reportRevisionId: REVISION,
      traceId: TRACE,
      sourceId: SOURCE,
      canonicalUrl: "https://chain.invalid/live-lineage",
      sourceRevisionKey: null,
      contentHash: sha256("live lineage payload"),
      permittedText: TEXT,
      permittedTextHash: TEXT_HASH,
      normalizationVersion: "live-lineage-normalization-v1",
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
    await db.executor.query(
      `INSERT INTO waspada.evidence_chunks
         (dataset_kind, chunk_id, trace_id, report_revision_id, permitted_text_hash,
          span_start, span_end, offset_unit, chunker_version, chunk_text_hash, status)
       VALUES ('live', $1, $2, $3, $4, 0, $5, 'unicode_code_points', 'v1', $4, 'active')`,
      [CHUNK, TRACE, REVISION, TEXT_HASH, SPAN_END],
    );
  });

  after(async () => {
    await db?.close();
  });

  async function countWhere(sql: string, params: readonly unknown[]): Promise<number> {
    const result = await db.executor.query<{ n: number }>(sql, [...params]);
    return result.rows[0]?.n ?? -1;
  }

  it("keeps the job trace, the report's candidate and context, and records the interpretation model", async () => {
    const execution = await (await workflow(db).createRun()).start({
      inputData: liveInput(REVISION, TRACE, "live"),
    });
    assert.equal(execution.status, "success", JSON.stringify(execution.steps ?? {}));
    const result = execution.result as unknown as IncidentWorkflowOutput;
    const proposal = result.proposal as unknown as Record<string, unknown>;
    assert.equal(proposal.trace_id, TRACE, "the workflow DTO carries the job trace");
    const candidateId = proposal.candidate_id as string;
    const contextId = proposal.context_id as string;
    assert.ok(candidateId && contextId, "the workflow DTO carries the candidate and context ids");

    const row = await db.executor.query<{ trace_id: string; candidate_id: string; context_id: string }>(
      "SELECT trace_id, candidate_id, context_id FROM waspada.event_proposals WHERE dataset_kind = 'live' AND proposal_id = $1",
      [proposal.proposal_id],
    );
    assert.deepEqual(row.rows, [{ trace_id: TRACE, candidate_id: candidateId, context_id: contextId }],
      "the stored proposal keeps the job trace and the report's ids");

    const candidate = await db.executor.query<{ trace_id: string; report_revision_id: string }>(
      "SELECT trace_id, report_revision_id FROM waspada.extraction_results WHERE dataset_kind = 'live' AND candidate_id = $1",
      [candidateId],
    );
    assert.deepEqual(candidate.rows, [{ trace_id: TRACE, report_revision_id: REVISION }],
      "the candidate is the report revision's own extraction");

    const context = await db.executor.query<{ trace_id: string; candidate_id: string; sufficient: boolean }>(
      "SELECT trace_id, candidate_id, sufficient FROM waspada.grounding_contexts WHERE dataset_kind = 'live' AND context_id = $1",
      [contextId],
    );
    assert.deepEqual(context.rows, [{ trace_id: TRACE, candidate_id: candidateId, sufficient: true }],
      "the grounding context is built from the cited chunk");
    const evidence = await db.executor.query<{ span_start: number; span_end: number; relation: string }>(
      `SELECT er.span_start, er.span_end, er.relation
       FROM waspada.grounding_evidence ge
       JOIN waspada.evidence_references er
         ON er.dataset_kind = ge.dataset_kind AND er.evidence_ref_id = ge.evidence_ref_id
       WHERE ge.dataset_kind = 'live' AND ge.context_id = $1`,
      [contextId],
    );
    assert.deepEqual(evidence.rows, [{ span_start: 0, span_end: SPAN_END, relation: "supports" }],
      "the context cites the chunk's real span");

    const audit = await db.executor.query<{ action: string; entity_type: string; entity_id: string; details: Record<string, unknown> }>(
      "SELECT action, entity_type, entity_id, details FROM waspada.audit_records WHERE dataset_kind = 'live' AND trace_id = $1 AND action = 'model_configuration_recorded'",
      [TRACE],
    );
    assert.equal(audit.rows.length, 1, "the interpretation model configuration is recorded against the job trace");
    const recorded = audit.rows[0]!;
    assert.equal(recorded.entity_type, "report_revision");
    assert.equal(recorded.entity_id, REVISION);
    assert.equal(recorded.details.role, "interpretation");
    assert.equal(recorded.details.source, "override", "the mock agent override is recorded as the source");
    assert.equal(recorded.details.mode, "override");
    assert.equal(recorded.details.model_id, null, "an override's model identity is not known to the workflow");
    const allowedKeys = new Set(["role", "provider", "model_id", "mode", "source", "max_steps", "max_output_tokens", "max_active_ms", "token_budget"]);
    assert.deepEqual(Object.keys(recorded.details).filter((key) => !allowedKeys.has(key)), [],
      "only provider, model id, mode and caps are recorded, never prompts, keys or endpoints");

    assert.equal(await countWhere("SELECT COUNT(*)::int AS n FROM waspada.traces WHERE trace_id LIKE 'trace-prop-%'", []), 0,
      "no fresh trace is minted for a proposal");
    assert.equal(await countWhere("SELECT COUNT(*)::int AS n FROM waspada.source_registry WHERE source_id LIKE 'source-candidate-%'", []), 0,
      "no placeholder source is invented");
    assert.equal(await countWhere("SELECT COUNT(*)::int AS n FROM waspada.report_revisions WHERE report_revision_id LIKE 'rev-candidate-%'", []), 0,
      "no placeholder report revision is invented");
    assert.equal(await countWhere("SELECT COUNT(*)::int AS n FROM waspada.grounding_contexts WHERE context_id LIKE 'context-prop-%'", []), 0,
      "no placeholder grounding context is invented");
  });

  it("records the factory model configuration with its provider, model id, mode and caps", async () => {
    await recordModelConfiguration(db.executor, {
      datasetKind: "live",
      traceId: TRACE,
      reportRevisionId: REVISION,
      role: "correlation",
      config: {
        baseUrl: "http://127.0.0.1:9090",
        apiKey: "",
        chatModel: "Waspada-Jakarta",
        embeddingModel: "gemini/gemini-embedding-2-preview",
        embeddingDimensions: 768,
        executionMode: "mock",
      },
      agentSource: "factory",
      occurredAt: NOW,
    });
    const rows = await db.executor.query<{ details: Record<string, unknown> }>(
      "SELECT details FROM waspada.audit_records WHERE dataset_kind = 'live' AND audit_id = $1",
      [`model-config-correlation-${REVISION}`],
    );
    assert.equal(rows.rows.length, 1);
    assert.deepEqual(rows.rows[0]!.details, {
      role: "correlation",
      provider: "9router",
      model_id: "Waspada-Jakarta",
      mode: "mock",
      source: "factory",
      max_steps: 4,
      max_output_tokens: 4000,
      max_active_ms: 60000,
      token_budget: 12000,
    });
    await recordModelConfiguration(db.executor, {
      datasetKind: "live",
      traceId: TRACE,
      reportRevisionId: REVISION,
      role: "correlation",
      config: { baseUrl: "", apiKey: "", chatModel: "Waspada-Jakarta", embeddingModel: "", embeddingDimensions: 768, executionMode: "mock" },
      agentSource: "factory",
      occurredAt: NOW,
    });
    const again = await db.executor.query<{ n: number }>(
      "SELECT COUNT(*)::int AS n FROM waspada.audit_records WHERE dataset_kind = 'live' AND audit_id = $1",
      [`model-config-correlation-${REVISION}`],
    );
    assert.equal(again.rows[0]?.n, 1, "re-recording the same role for a revision is a no-op");
  });

  it("refuses a live report whose revision is missing and writes no placeholder lineage", async () => {
    const execution = await (await workflow(db).createRun()).start({
      inputData: liveInput(MISSING_REVISION, TRACE, "live"),
    });
    assert.notEqual(execution.status, "success", "a live proposal without its real revision must not be written");
    assert.equal(
      await countWhere("SELECT COUNT(*)::int AS n FROM waspada.event_proposals WHERE dataset_kind = 'live' AND record_json->>'incident_id' = $1", ["inc-" + MISSING_REVISION]),
      0,
      "no proposal is written for the missing revision",
    );
    assert.equal(await countWhere("SELECT COUNT(*)::int AS n FROM waspada.report_revisions WHERE report_revision_id = $1", [MISSING_REVISION]), 0,
      "the missing revision is not invented");
    assert.equal(await countWhere("SELECT COUNT(*)::int AS n FROM waspada.report_revisions WHERE report_revision_id LIKE 'rev-candidate-%'", []), 0,
      "no placeholder report revision is invented");
  });

  it("keeps the fixture lineage for a synthetic run only when the explicit synthetic flag is set", async () => {
    const execution = await (await workflow(db, { syntheticFixtureLineage: true }).createRun()).start({
      inputData: liveInput(FIXTURE_REVISION, FIXTURE_TRACE, "synthetic"),
    });
    assert.equal(execution.status, "success", JSON.stringify(execution.steps ?? {}));
    const proposal = (execution.result as unknown as IncidentWorkflowOutput).proposal as unknown as Record<string, unknown>;
    const row = await db.executor.query<{ trace_id: string }>(
      "SELECT trace_id FROM waspada.event_proposals WHERE dataset_kind = 'synthetic' AND proposal_id = $1",
      [proposal.proposal_id],
    );
    assert.deepEqual(row.rows, [{ trace_id: FIXTURE_TRACE }], "the fixture proposal keeps its own trace");
  });

  it("refuses a synthetic run with no revision unless the explicit synthetic flag is set", async () => {
    const execution = await (await workflow(db).createRun()).start({
      inputData: liveInput("rev-live-lineage-unflagged", FIXTURE_TRACE, "synthetic"),
    });
    assert.notEqual(execution.status, "success", "without the synthetic flag the revision must exist");
  });
});
