import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, before, describe, it } from "node:test";
import {
  createSqlExactEvidenceSpanReader,
  type EvidenceRetrievalResult,
} from "../src/evidence-retrieval.js";
import { createSqlGeometryWriter } from "../src/geometry-writer.js";
import type { GroundingContextRecord } from "../src/grounding-contexts.js";
import { applyMigrations, readMigrations } from "../src/migrations.js";
import {
  createRepositoryPorts,
} from "../src/ports.js";
import type { SqlExecutor } from "../src/sql.js";
import {
  createSqlEventProposalReader,
} from "../src/event-proposals.js";
import {
  SqlPublicationWriter,
  type PublicationEventVersionDraft,
  type PublicationWriteCommand,
  type PublicationWriteResult,
} from "../src/publication-writer.js";
import { createTestDatabase, type TestDatabase } from "./harness.js";
import {
  InMemorySyntheticFixtureCatalog,
  processSyntheticFixtureJob,
  type FixturePipelinePorts,
  type SyntheticFixture,
} from "../../worker/src/layers/l1-data-knowledge/synthetic-fixture-pipeline.js";
import { createModelCapabilityAdapter } from "../../worker/src/layers/l2-model-grounding/adapter.js";
import type {
  CapabilityOutcome,
  ExtractionRequest,
  GroundingContext,
  ModelCapabilityAdapter,
  ReasoningRequest,
  ReasoningResult,
  UntrustedModelProvider,
} from "../../worker/src/layers/l2-model-grounding/contracts.js";
import {
  assembleGroundingReasoningRequest,
} from "../../worker/src/layers/l2-model-grounding/grounding-context.js";
import {
  createReasoningContextPersister,
} from "../../worker/src/layers/l2-model-grounding/context-persistence.js";
import {
  createDirectReasoningService,
} from "../../worker/src/layers/l2-model-grounding/direct-reasoning.js";
import {
  createReasoningProposalBridge,
} from "../../worker/src/layers/l2-model-grounding/reasoning-proposal-bridge.js";
import {
  createManualPublicationService,
  type ManualPublicationServiceInput,
  type ManualPublicationWriterPort,
} from "../../worker/src/layers/l4-application-integration/manual-publication-service.js";
import {
  handlePublicApiRequest,
} from "../../worker/src/layers/l4-application-integration/api.js";
import {
  createPublicEventDetailRuntime,
} from "../../worker/src/runtime/public-event-detail-runtime.js";

const DATASET = "synthetic" as const;
const TRACE_ID = "trace-synthetic-publication-isolation";
const SOURCE_ID = "source-synthetic-publication-isolation";
const CANDIDATE_ID = "candidate-synthetic-publication-isolation";
const REVISION_ID = "revision-synthetic-publication-isolation";
const ORIGIN_ID = "origin-synthetic-publication-isolation";
const CONTEXT_ID = "context-synthetic-publication-isolation";
const PROPOSAL_ID = "proposal-synthetic-publication-isolation";
const SYNTHETIC_ONLY_EVENT_ID = "event-synthetic-only-publication-isolation";
const FIXTURE_URL = "https://synthetic.invalid/authored/publication-isolation";
const NOW = "2026-10-08T03:00:00.000Z";
const RETRIEVED_AT = "2026-10-08T03:01:00.000Z";
const REPORT_TEXT =
  "Authored synthetic notice: the fictional crossing near the civic hall is closed 😀.";
const SELECTED_SPAN = "fictional crossing near the civic hall is closed 😀";
const TEST_CONNECTION_STRING =
  "postgresql://test-user:test-password@pglite.example.invalid/waspada?sslmode=require";

const SPAN_START = codePointStart(REPORT_TEXT, SELECTED_SPAN);
const SPAN_END = SPAN_START + Array.from(SELECTED_SPAN).length;

const PUBLICATION_TABLES = [
  "publication_decisions",
  "publication_claim_decisions",
  "publication_decision_evidence",
  "event_versions",
  "event_claims",
  "event_claim_evidence",
  "event_claim_origins",
  "event_claim_geometries",
  "impact_versions",
  "impact_claim_support",
  "event_impact_refs",
  "audit_records",
  "publication_outbox",
  "publication_write_receipts",
] as const;
type PublicationTable = (typeof PUBLICATION_TABLES)[number];
type PublicationSnapshots = Record<PublicationTable, string>;

const TEST_ROLES = [
  "waspada_l1_pipeline",
  "waspada_l2_grounding_reader",
  "waspada_l2_grounding_writer",
  "waspada_l2_proposal_writer",
  "waspada_l4_moderator_publication_writer",
  "waspada_public_reader",
] as const;
type TestRole = (typeof TEST_ROLES)[number];

describe("synthetic publication isolation PGlite composition", () => {
  let database: TestDatabase;
  let ports: ReturnType<typeof createRepositoryPorts>;

  before(async () => {
    database = await createTestDatabase();
    const migrations = await readMigrations(new URL("../migrations/", import.meta.url));
    await applyMigrations(database.executor, migrations);
    ports = createRepositoryPorts(database.executor);

    await ports.tracesAndAudit.createTrace({
      traceId: TRACE_ID,
      datasetKind: DATASET,
      startedAt: NOW,
      endedAt: null,
      outcome: "open",
      metadata: { fixture: "authored synthetic isolation test only" },
    });
    await database.executor.query(
      "INSERT INTO waspada.source_registry " +
        "(source_id, trace_id, registry_version, display_name, source_kind, remit, " +
        " access_method, approved_hosts, access_restrictions, reuse_basis, registry_status, " +
        " approval_status, health_status, auto_acquisition_enabled, auto_publication_policy) " +
        "VALUES ($1, $2, 1, 'Authored synthetic fixture only', 'other', " +
        " ARRAY['synthetic test fixture'], 'manual_fixture', ARRAY[]::text[], " +
        " ARRAY['memory-only fixture; no network access'], " +
        " ARRAY['authored synthetic test data'], 'active', 'approved', 'unknown', false, 'never')",
      [SOURCE_ID, TRACE_ID],
    );
  });

  after(async () => {
    if (database) await database.close();
  });

  it("keeps a synthetic L1/L2 draft outside the manual publication gate and public detail view", async () => {
    const extractionRequests: ExtractionRequest[] = [];
    const extractionAdapter = createExtractionAdapter(extractionRequests);
    const pipelinePorts: FixturePipelinePorts = {
      acquisitionJobs: ports.acquisitionJobs,
      sourceRegistry: ports.sourceRegistry,
      modelAdapter: extractionAdapter,
      reportRevisions: ports.reportRevisions,
      extractionResults: ports.extractionResults,
      evidenceChunks: ports.evidenceChunks,
      geometryWriter: createSqlGeometryWriter(database.executor),
    };
    const fixture = makeFixture();
    const enqueued = await ports.acquisitionJobs.enqueueModeratorSubmission({
      datasetKind: DATASET,
      idempotencyKey: "fixture-only:synthetic-publication-isolation",
      traceId: TRACE_ID,
      requestedBy: "authored-fixture-test-metadata",
      submittedUrl: FIXTURE_URL,
      requestedAt: NOW,
    });
    assert.equal(enqueued.outcome, "enqueued");
    if (enqueued.outcome !== "enqueued") return;

    const claimedJob = await withRole(database, "waspada_l1_pipeline", () =>
      ports.acquisitionJobs.claimDueSyntheticModeratorSubmission(NOW),
    );
    assert.ok(claimedJob);
    const l1Result = await withRole(database, "waspada_l1_pipeline", () =>
      processSyntheticFixtureJob({
        job: claimedJob,
        catalog: new InMemorySyntheticFixtureCatalog([fixture]),
        ports: pipelinePorts,
        transitionAt: NOW,
      }),
    );
    assert.deepEqual(l1Result, {
      outcome: "completed",
      empty: false,
      reportCount: 1,
      evidenceReferenceCount: 2,
      chunkCount: 1,
      geometryCount: 0,
    });
    assert.equal(extractionRequests.length, 1);
    const extractionRequest = extractionRequests[0];
    assert.ok(extractionRequest);
    assert.equal(extractionRequest.data.candidateId, CANDIDATE_ID);
    assert.equal(extractionRequest.data.report.reportRevisionId, REVISION_ID);
    assert.equal(extractionRequest.data.report.permittedText, REPORT_TEXT);

    const persistedRevision = await database.executor.query<{
      dataset_kind: string;
      revision_status: string;
      permitted_text: string;
      permitted_text_hash: string;
    }>(
      "SELECT dataset_kind, revision_status, permitted_text, permitted_text_hash " +
        "FROM waspada.report_revisions WHERE report_revision_id = $1",
      [REVISION_ID],
    );
    assert.deepEqual(persistedRevision.rows, [{
      dataset_kind: DATASET,
      revision_status: "unreviewed",
      permitted_text: REPORT_TEXT,
      permitted_text_hash: extractionRequest.data.report.permittedTextHash,
    }]);

    const persistedExtraction = await database.executor.query<{
      dataset_kind: string;
      candidate_id: string;
      report_revision_id: string;
      relation: string;
    }>(
      "SELECT result.dataset_kind, result.candidate_id, result.report_revision_id, reference.relation " +
        "FROM waspada.extraction_results AS result " +
        "JOIN waspada.extraction_evidence AS link " +
        " ON link.dataset_kind = result.dataset_kind AND link.candidate_id = result.candidate_id " +
        "JOIN waspada.evidence_references AS reference " +
        " ON reference.dataset_kind = link.dataset_kind AND reference.evidence_ref_id = link.evidence_ref_id " +
        "WHERE result.dataset_kind = $1 AND result.candidate_id = $2",
      [DATASET, CANDIDATE_ID],
    );
    assert.deepEqual(persistedExtraction.rows, [{
      dataset_kind: DATASET,
      candidate_id: CANDIDATE_ID,
      report_revision_id: REVISION_ID,
      relation: "supports",
    }]);

    const selectedReferenceRows = await database.executor.query<{
      evidence_reference_id: string;
      span_start: number;
      span_end: number;
      permitted_text_hash: string;
    }>(
      "SELECT reference.evidence_ref_id::text AS evidence_reference_id, " +
        "reference.span_start, reference.span_end, reference.permitted_text_hash " +
        "FROM waspada.extraction_evidence AS link " +
        "JOIN waspada.evidence_references AS reference " +
        " ON reference.dataset_kind = link.dataset_kind AND reference.evidence_ref_id = link.evidence_ref_id " +
        "WHERE link.dataset_kind = $1 AND link.candidate_id = $2 " +
        " AND reference.report_revision_id = $3 AND reference.relation = 'supports' " +
        " AND reference.span_start = $4 AND reference.span_end = $5",
      [DATASET, CANDIDATE_ID, REVISION_ID, SPAN_START, SPAN_END],
    );
    assert.equal(selectedReferenceRows.rows.length, 1);
    const evidenceReferenceId = selectedReferenceRows.rows[0]!.evidence_reference_id;
    assert.equal(selectedReferenceRows.rows[0]?.permitted_text_hash,
      extractionRequest.data.report.permittedTextHash);

    // The current L1 fixture contract persists report/evidence/extraction rows;
    // this authored synthetic origin link supplies provenance required by L2's
    // canonical proposal writer. It does not identify a real issuer or source.
    await database.executor.query(
      "INSERT INTO waspada.evidence_origins " +
        "(dataset_kind, origin_id, trace_id, origin_kind, source_id, lineage_relation, " +
        " independence_status, record_json) " +
        "VALUES ($1, $2, $3, 'unknown', $4, 'unknown', 'unknown', " +
        " '{\"fixture\":\"authored synthetic test lineage only\"}'::jsonb)",
      [DATASET, ORIGIN_ID, TRACE_ID, SOURCE_ID],
    );
    await database.executor.query(
      "INSERT INTO waspada.origin_report_revisions " +
        "(dataset_kind, origin_id, report_revision_id) VALUES ($1, $2, $3)",
      [DATASET, ORIGIN_ID, REVISION_ID],
    );
    await database.executor.query(
      "INSERT INTO waspada.origin_evidence " +
        "(dataset_kind, origin_id, evidence_ref_id) VALUES ($1, $2, $3)",
      [DATASET, ORIGIN_ID, evidenceReferenceId],
    );

    let retrieval: EvidenceRetrievalResult | undefined;
    let reasoningRequest: ReasoningRequest | undefined;
    await withRole(database, "waspada_l2_grounding_reader", async () => {
      retrieval = await ports.evidenceRetrieval.search({
        datasetKind: DATASET,
        identifiers: [{ kind: "candidate", value: CANDIDATE_ID }],
        exactTerms: [SELECTED_SPAN],
        filters: {
          revisionStatuses: ["unreviewed"],
          registryStatuses: ["active"],
          approvalStatuses: ["approved"],
        },
        maxResults: 8,
        maxRowsExamined: 16,
        maxSpanTextCodePoints: 256,
      });
      assert.equal(retrieval.datasetKind, DATASET);
      assert.equal(retrieval.scanTruncated, false);
      assert.equal(retrieval.resultTruncated, false);
      assert.equal(retrieval.invalidSpanRowsOmitted, 0);
      assert.equal(retrieval.candidates.length, 1);
      const candidate = retrieval.candidates[0]!;
      assert.equal(candidate.datasetKind, DATASET);
      assert.equal(candidate.candidateId, CANDIDATE_ID);
      assert.equal(candidate.reportRevisionId, REVISION_ID);
      assert.equal(candidate.evidenceReferenceId, evidenceReferenceId);
      assert.equal(candidate.revisionStatus, "unreviewed");
      assert.equal(candidate.source.sourceId, SOURCE_ID);
      assert.equal(candidate.source.registryStatus, "active");
      assert.equal(candidate.source.approvalStatus, "approved");
      assert.deepEqual(candidate.origins.map(({ originId }) => originId), [ORIGIN_ID]);

      const exactSpanReader = createSqlExactEvidenceSpanReader(database.executor);
      reasoningRequest = await assembleGroundingReasoningRequest(exactSpanReader, {
        retrieval,
        datasetKind: DATASET,
        traceId: TRACE_ID,
        contextId: CONTEXT_ID,
        candidateId: CANDIDATE_ID,
        evidenceReferenceIds: [evidenceReferenceId],
        candidateEvents: [],
        priorDecisionIds: [],
        missingFields: [],
        conflicts: [],
        sufficient: true,
      });
    });
    assert.ok(retrieval);
    assert.ok(reasoningRequest);
    const expectedGroundingContext = structuredClone(reasoningRequest.data.groundingContext);
    assert.equal(reasoningRequest.data.groundingContext.evidence[0]?.text, SELECTED_SPAN);
    assert.deepEqual(reasoningRequest.data.groundingContext.evidence[0]?.reference, {
      reportRevisionId: REVISION_ID,
      permittedTextHash: extractionRequest.data.report.permittedTextHash,
      spanStart: SPAN_START,
      spanEnd: SPAN_END,
      offsetUnit: "unicode_code_points",
      relation: "supports",
    });
    assert.deepEqual(reasoningRequest.data.groundingContext.evidence[0]?.origins, [{
      originId: ORIGIN_ID,
      independenceStatus: "unknown",
      dependsOnOriginIds: [],
    }]);

    let reasoningCalls = 0;
    let reasoningRequestAtCall: ReasoningRequest | undefined;
    const directReasoning = createDirectReasoningService(
      createReasoningContextPersister(ports.groundingContexts),
      {
        async reason(request: ReasoningRequest): Promise<CapabilityOutcome<ReasoningResult, "reasoning">> {
          reasoningCalls += 1;
          reasoningRequestAtCall = request;
          const role = await database.executor.query<{ current_user: string }>(
            "SELECT current_user::text AS current_user",
          );
          assert.equal(role.rows[0]?.current_user, "waspada_l2_grounding_writer");
          assert.deepEqual(request.data.groundingContext, expectedGroundingContext);
          assert.equal(request.data.groundingContext.evidence[0]?.text, SELECTED_SPAN);

          const rows = await database.executor.query<{
            context_id: string;
            sufficient: boolean;
            record_json: string;
          }>(
            "SELECT context_id, sufficient, record_json::text AS record_json " +
              "FROM waspada.grounding_contexts WHERE dataset_kind = $1 AND context_id = $2",
            [DATASET, CONTEXT_ID],
          );
          assert.equal(rows.rows.length, 1);
          assert.equal(rows.rows[0]?.sufficient, true);
          assert.equal(rows.rows[0]!.record_json.includes(SELECTED_SPAN), false);
          const storedContext = JSON.parse(rows.rows[0]!.record_json) as Record<string, unknown>;
          const storedEvidence = storedContext.evidence as Record<string, unknown>[];
          assert.equal(Object.hasOwn(storedEvidence[0]!, "text"), false);

          return {
            status: "succeeded",
            capability: "reasoning",
            value: fixedReasoningResult(request.data.groundingContext),
          };
        },
      },
    );
    const directOutcome = await withRole(database, "waspada_l2_grounding_writer", () =>
      directReasoning.reason(reasoningRequest),
    );
    assert.equal(directOutcome.status, "succeeded");
    if (directOutcome.status !== "succeeded") assert.fail("the fixed reasoning double should succeed");
    assert.equal(directOutcome.capability, "reasoning");
    assert.equal(reasoningCalls, 1);
    assert.ok(reasoningRequestAtCall);

    const persistedContextRows = await database.executor.query<{ record_json: string }>(
      "SELECT record_json::text AS record_json FROM waspada.grounding_contexts " +
        "WHERE dataset_kind = $1 AND context_id = $2",
      [DATASET, CONTEXT_ID],
    );
    assert.equal(persistedContextRows.rows.length, 1);
    const persistedContext = JSON.parse(persistedContextRows.rows[0]!.record_json) as GroundingContextRecord;
    assert.equal(persistedContext.dataset_kind, DATASET);
    assert.equal(persistedContext.context_id, CONTEXT_ID);
    assert.equal(persistedContextRows.rows[0]!.record_json.includes(SELECTED_SPAN), false);

    const proposalBridge = createReasoningProposalBridge(ports.eventProposals);
    const bridgeInput = {
      capabilityOutcome: directOutcome,
      groundingContext: reasoningRequestAtCall.data.groundingContext,
      persistedContextRecord: persistedContext,
      proposalId: PROPOSAL_ID,
      proposedAt: "2026-10-08T03:02:00.000Z",
      target: { kind: "new" as const },
      investigationId: null,
    };
    const proposalResult = await withRole(database, "waspada_l2_proposal_writer", () =>
      proposalBridge.persist(bridgeInput),
    );
    assert.equal(proposalResult.status, "persisted");
    if (proposalResult.status !== "persisted") assert.fail("the private synthetic draft should persist");
    const proposal = proposalResult.proposal;
    assert.equal(proposal.dataset_kind, DATASET);
    assert.equal(proposal.event_id, null);
    assert.equal(proposal.claims.length, 1);
    assert.equal(proposal.claims[0]?.evidence_label, "under_review");
    assert.deepEqual(proposal.claims[0]?.support, [{
      report_revision_id: REVISION_ID,
      permitted_text_hash: extractionRequest.data.report.permittedTextHash,
      span_start: SPAN_START,
      span_end: SPAN_END,
      offset_unit: "unicode_code_points",
      relation: "supports",
    }]);
    assert.deepEqual(proposal.claims[0]?.origin_ids, [ORIGIN_ID]);

    const privateProposalRows = await database.executor.query<{
      dataset_kind: string;
      proposal_id: string;
      record_json: string;
    }>(
      "SELECT dataset_kind, proposal_id, record_json::text AS record_json " +
        "FROM waspada.event_proposals WHERE proposal_id = $1",
      [PROPOSAL_ID],
    );
    assert.equal(privateProposalRows.rows.length, 1);
    assert.equal(privateProposalRows.rows[0]?.dataset_kind, DATASET);
    assert.deepEqual(JSON.parse(privateProposalRows.rows[0]!.record_json), proposal);
    const proposalDatasetCounts = await database.executor.query<{
      synthetic_proposals: string;
      live_proposals: string;
    }>(
      "SELECT " +
        "(SELECT count(*)::text FROM waspada.event_proposals " +
        " WHERE dataset_kind = 'synthetic' AND proposal_id = $1) AS synthetic_proposals, " +
        "(SELECT count(*)::text FROM waspada.event_proposals " +
        " WHERE dataset_kind = 'live' AND proposal_id = $1) AS live_proposals",
      [PROPOSAL_ID],
    );
    assert.deepEqual(proposalDatasetCounts.rows[0], {
      synthetic_proposals: "1",
      live_proposals: "0",
    });

    const publicationBefore = await readPublicationSnapshots(database.executor);
    assertNoPublicationRows(publicationBefore);
    const strictReader = createSqlEventProposalReader(database.executor);
    const realSqlWriter = new SqlPublicationWriter(database.executor);
    assert.ok(realSqlWriter instanceof SqlPublicationWriter);
    let writerCalls = 0;
    const writerSpy: ManualPublicationWriterPort = {
      async publish(command: PublicationWriteCommand): Promise<PublicationWriteResult> {
        writerCalls += 1;
        return realSqlWriter.publish(command);
      },
    };
    const manualGate = createManualPublicationService(strictReader, writerSpy);
    const manualInput = makeNoApprovalInput(reasoningRequest, directOutcome.value, retrieval);
    const manualResult = await withRole(
      database,
      "waspada_l4_moderator_publication_writer",
      async () => {
        assert.equal(await strictReader.readLive(PROPOSAL_ID), null);
        return manualGate.publish(manualInput);
      },
    );
    assert.deepEqual(manualResult, { status: "denied", code: "proposal_not_found" });
    assert.equal(writerCalls, 0);

    const publicationAfter = await readPublicationSnapshots(database.executor);
    assert.deepEqual(publicationAfter, publicationBefore);
    assertNoPublicationRows(publicationAfter);

    let detailRunnerCalls = 0;
    const detailRuntime = createPublicEventDetailRuntime({
      // Direct test-only invocation exercises the existing exact-live reader.
      // It does not set Worker bindings or configure a production route.
      datasetMode: "live",
      connectionString: TEST_CONNECTION_STRING,
    }, {
      async withSqlExecutor(connectionString, operation) {
        detailRunnerCalls += 1;
        assert.equal(connectionString, TEST_CONNECTION_STRING);
        return withRole(database, "waspada_public_reader", async () => {
          const role = await database.executor.query<{ current_user: string }>(
            "SELECT current_user::text AS current_user",
          );
          assert.equal(role.rows[0]?.current_user, "waspada_public_reader");
          await assert.rejects(
            database.executor.query("SELECT permitted_text FROM waspada.report_revisions LIMIT 1"),
            /permission denied/iu,
          );
          return operation(database.executor);
        });
      },
    });
    assert.ok(detailRuntime);

    const publicResponse = await handlePublicApiRequest(
      new Request("http://localhost/api/v1/events/" + encodeURIComponent(SYNTHETIC_ONLY_EVENT_ID)),
      { DATASET_MODE: "live" },
      undefined,
      undefined,
      detailRuntime,
    );
    assert.equal(publicResponse.status, 404);
    const publicEnvelope = await publicResponse.json() as Record<string, unknown>;
    assert.equal(publicEnvelope.code, "NOT_FOUND");
    assert.equal(publicEnvelope.message, "The requested public route was not found.");
    assert.equal(typeof publicEnvelope.request_id, "string");
    assert.equal(detailRunnerCalls, 1);
    const serializedEnvelope = JSON.stringify(publicEnvelope);
    for (const privateValue of [REPORT_TEXT, SELECTED_SPAN, PROPOSAL_ID, CONTEXT_ID, SOURCE_ID]) {
      assert.equal(serializedEnvelope.includes(privateValue), false);
    }

    const publicEventRows = await database.executor.query<{ event_id: string }>(
      "SELECT event_id FROM waspada.public_event_versions WHERE event_id = $1",
      [SYNTHETIC_ONLY_EVENT_ID],
    );
    assert.deepEqual(publicEventRows.rows, []);
    const finalPublicationSnapshots = await readPublicationSnapshots(database.executor);
    assert.deepEqual(finalPublicationSnapshots, publicationBefore);
  });
});

function makeFixture(): SyntheticFixture {
  return {
    url: FIXTURE_URL,
    geoJson: JSON.stringify({
      type: "FeatureCollection",
      features: [{
        type: "Feature",
        id: "authored-feature-id-only",
        properties: { fixture: "authored synthetic in-memory test" },
        geometry: { type: "Point", coordinates: [0, 0] },
      }],
    }),
    retrievedAt: RETRIEVED_AT,
    sourceId: SOURCE_ID,
    manifests: new Map([["authored-feature-id-only", {
      candidateId: CANDIDATE_ID,
      reportRevisionId: REVISION_ID,
      sourceId: SOURCE_ID,
      canonicalUrl: FIXTURE_URL,
      contentHash: sha256(REPORT_TEXT),
      permittedText: REPORT_TEXT,
      publishedAt: null,
      observedAt: null,
      validFrom: null,
      validUntil: null,
      supersedesId: null,
      supportSpans: [{
        spanStart: 0,
        spanEnd: Array.from(REPORT_TEXT).length,
      }],
    }]]),
  };
}

function createExtractionAdapter(
  capturedRequests: ExtractionRequest[],
): Pick<ModelCapabilityAdapter, "extract"> {
  const provider: UntrustedModelProvider = {
    async classify() {
      throw new Error("unused deterministic fixture capability");
    },
    async extract(request: ExtractionRequest) {
      capturedRequests.push(request);
      const report = request.data.report;
      const spanStart = codePointStart(report.permittedText, SELECTED_SPAN);
      const spanEnd = spanStart + Array.from(SELECTED_SPAN).length;
      return {
        output: {
          category: "transport_road_incidents",
          tags: [],
          eventTime: { start: null, end: null, precision: "unknown" },
          scope: {
            placeIds: [],
            serviceIds: [],
            institutionIds: [],
            audienceIds: [],
            geometryIds: [],
          },
          evidence: [{
            reportRevisionId: report.reportRevisionId,
            permittedTextHash: report.permittedTextHash,
            spanStart,
            spanEnd,
            offsetUnit: "unicode_code_points",
            relation: "supports",
          }],
          unknownFields: ["event_time"],
        },
        usage: { inputTokens: 8, outputTokens: 3 },
      };
    },
    async embed() {
      throw new Error("unused deterministic fixture capability");
    },
    async reason() {
      throw new Error("unused deterministic fixture capability");
    },
  };
  const adapter = createModelCapabilityAdapter(provider, {
    extraction: {
      provider: "synthetic-test-double",
      modelVersion: "synthetic-extractor-v1",
      promptVersion: "synthetic-fixture-extraction-v1",
    },
  });
  return { extract: (request) => adapter.extract(request) };
}

function fixedReasoningResult(context: GroundingContext): ReasoningResult {
  const support = context.evidence[0];
  assert.ok(support);
  return {
    outcome: "proposed",
    claims: [{
      text: "An authored synthetic draft describes a fictional crossing closure.",
      eventTime: { precision: "unknown", start: null, end: null },
      validity: { validFrom: null, validUntil: null },
      scope: {
        placeIds: [],
        serviceIds: [],
        institutionIds: [],
        audienceIds: [],
        geometryIds: [],
      },
      qualifiers: ["Authored synthetic test output only."],
      support: [support.reference],
      contradictions: [],
      contextEvidence: [],
      supportAssessment: "uncertain",
    }],
    unresolvedFields: [...context.missingFields],
    conflicts: [...context.conflicts],
    modelRun: {
      capability: "reasoning",
      modelVersion: "synthetic-reasoner-v1",
      promptVersion: "synthetic-reasoning-test-v1",
      inputTokens: 5,
      outputTokens: 2,
    },
    provider: "synthetic-test-double",
  };
}

function makeNoApprovalInput(
  reasoningRequest: ReasoningRequest,
  reasoningResult: ReasoningResult,
  retrieval: EvidenceRetrievalResult,
): ManualPublicationServiceInput {
  // The service accepts a JSON-shaped caller snapshot. Round-trip the L2
  // values through JSON so this gate test does not depend on object prototypes.
  const plainGroundingContext = JSON.parse(
    JSON.stringify(reasoningRequest.data.groundingContext),
  ) as GroundingContext;
  const plainReasoningResult = JSON.parse(JSON.stringify(reasoningResult)) as ReasoningResult;
  const plainRetrieval = JSON.parse(JSON.stringify(retrieval)) as EvidenceRetrievalResult;
  const scope = {
    place_ids: [],
    service_ids: [],
    institution_ids: [],
    audience_ids: [],
    geometry_ids: [],
  };
  const freshness = {
    status: "current" as const,
    evaluated_at: NOW,
    review_due_at: null,
    basis: "manual_review" as const,
  };
  const eventDraft: PublicationEventVersionDraft = {
    event_id: SYNTHETIC_ONLY_EVENT_ID,
    version: 1,
    supersedes_version: null,
    title: "Unpublished authored synthetic draft",
    summary: "This fictional draft exists only as a test input and is never written.",
    category: "transport_road_incidents",
    tags: [],
    lifecycle: "ongoing",
    freshness,
    event_time: { start: null, end: null, precision: "unknown" },
    validity: { valid_from: null, valid_until: null },
    scope,
    published_at: NOW,
  };
  return {
    proposalId: PROPOSAL_ID,
    policyInput: {
      groundingContext: plainGroundingContext,
      reasoningResult: plainReasoningResult,
      retrieval: plainRetrieval,
      currentEvidenceStates: [],
      target: { kind: "new" },
      currentEvent: null,
      moderatorDecision: null,
    },
    eventDraft,
    impactDrafts: [],
    writeMetadata: {
      idempotencyKey: "synthetic-only-no-publication",
      decisionId: "decision-synthetic-only-no-publication",
      policyVersion: "synthetic-test-policy",
    },
  };
}

async function readPublicationSnapshots(executor: SqlExecutor): Promise<PublicationSnapshots> {
  const snapshots = {} as PublicationSnapshots;
  for (const table of PUBLICATION_TABLES) {
    const result = await executor.query<{ snapshot: string }>(
      "SELECT COALESCE(jsonb_agg(row_data ORDER BY row_data::text), '[]'::jsonb)::text AS snapshot " +
        "FROM (SELECT to_jsonb(record_row) AS row_data FROM waspada." + table + " AS record_row) AS snapshot_rows",
    );
    snapshots[table] = result.rows[0]?.snapshot ?? "[]";
  }
  return snapshots;
}

function assertNoPublicationRows(snapshots: PublicationSnapshots): void {
  for (const table of PUBLICATION_TABLES) {
    if (table === "audit_records") continue;
    assert.deepEqual(JSON.parse(snapshots[table]), [], table + " must remain empty");
  }
}

async function withRole<Result>(
  database: TestDatabase,
  role: TestRole,
  work: () => Promise<Result>,
): Promise<Result> {
  assert.ok((TEST_ROLES as readonly string[]).includes(role));
  await database.executor.execute("SET ROLE " + role);
  try {
    const result = await database.executor.query<{ current_user: string }>(
      "SELECT current_user::text AS current_user",
    );
    assert.equal(result.rows[0]?.current_user, role);
    return await work();
  } finally {
    await database.executor.execute("RESET ROLE");
  }
}

function codePointStart(value: string, substring: string): number {
  const utf16Start = value.indexOf(substring);
  assert.notEqual(utf16Start, -1, "the selected authored span must exist");
  return Array.from(value.slice(0, utf16Start)).length;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
