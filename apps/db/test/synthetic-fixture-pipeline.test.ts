import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { createSqlGeometryWriter } from "../src/geometry-writer.js";
import { applyMigrations, readMigrations } from "../src/migrations.js";
import { createRepositoryPorts } from "../src/ports.js";
import { SqlSourcePollScheduler } from "../src/source-poll-scheduler.js";
import { createTestDatabase, type TestDatabase } from "./harness.js";
import {
  InMemorySyntheticFixtureCatalog,
  InMemorySyntheticSourcePollFixtureCatalog,
  processSyntheticFixtureJob,
  type FixturePipelinePorts,
  type SyntheticFixture,
  type SyntheticReportManifest,
} from "../../worker/src/layers/l1-data-knowledge/synthetic-fixture-pipeline.js";
import { runSyntheticFixtureJob } from "../../worker/src/layers/l1-data-knowledge/synthetic-fixture-runner.js";
import { runSyntheticSourcePollJob } from "../../worker/src/layers/l1-data-knowledge/synthetic-source-poll-runner.js";
import { createModelCapabilityAdapter } from "../../worker/src/layers/l2-model-grounding/adapter.js";
import type {
  ExtractionRequest,
  UntrustedModelProvider,
} from "../../worker/src/layers/l2-model-grounding/contracts.js";

const fixtureUrl = "https://synthetic.invalid/moderator/fixture-pipeline";
const retrievedAt = "2026-09-25T03:00:00.000Z";
const permittedText = "Synthetic moderator fixture: station entrance on Merdeka Street.";
const t0 = "2026-09-25T03:00:00.000Z";

describe("L1 synthetic fixture pipeline PGlite composition", () => {
  let database: TestDatabase;
  let ports: ReturnType<typeof createRepositoryPorts>;
  let pipelinePorts: FixturePipelinePorts;
  const fixtureTrace = "trace-fixture-pipeline-first";
  const emptyTrace = "trace-fixture-pipeline-empty";
  const runnerTrace = "trace-fixture-runner-synthetic";
  const runnerHistoricalTrace = "trace-fixture-runner-historical";
  const runnerLiveTrace = "trace-fixture-runner-live";

  before(async () => {
    database = await createTestDatabase();
    ports = createRepositoryPorts(database.executor);
    pipelinePorts = {
      acquisitionJobs: ports.acquisitionJobs,
      sourceRegistry: ports.sourceRegistry,
      modelAdapter: createFixtureModelAdapter(),
      reportRevisions: ports.reportRevisions,
      extractionResults: ports.extractionResults,
      evidenceChunks: ports.evidenceChunks,
      geometryWriter: createSqlGeometryWriter(database.executor),
    };
    const migrations = await readMigrations(new URL("../migrations/", import.meta.url));
    await applyMigrations(database.executor, migrations);
    await ports.tracesAndAudit.createTrace(makeTrace("trace-fixture-catalog", null));
    await ports.tracesAndAudit.createTrace(makeTrace(fixtureTrace, "synthetic"));
    await ports.tracesAndAudit.createTrace(makeTrace(emptyTrace, "synthetic"));
    await ports.tracesAndAudit.createTrace(makeTrace(runnerTrace, "synthetic"));
    await ports.tracesAndAudit.createTrace(makeTrace(runnerHistoricalTrace, "historical"));
    await ports.tracesAndAudit.createTrace(makeTrace(runnerLiveTrace, "live"));
    await database.executor.query(
      `INSERT INTO waspada.source_registry
         (source_id, trace_id, registry_version, display_name, source_kind, remit,
          access_method, approved_hosts, access_restrictions, reuse_basis, registry_status,
          approval_status, health_status, auto_acquisition_enabled, auto_publication_policy)
       VALUES ('source-fixture-pipeline', 'trace-fixture-catalog', 1,
          'Synthetic manual fixture', 'other', ARRAY['authored fixture tests'], 'manual_fixture',
          ARRAY[]::text[], ARRAY['synthetic fixture only'], ARRAY['authored fixture'],
          'active', 'approved', 'unknown', false, 'never')`,
    );
    await database.executor.query(
      `INSERT INTO waspada.source_registry
         (source_id, trace_id, registry_version, display_name, source_kind, remit,
          access_method, approved_hosts, access_restrictions, reuse_basis, registry_status,
          approval_status, health_status, auto_acquisition_enabled, auto_publication_policy,
          polling_interval_seconds)
       VALUES ('source-fixture-runner-poll', 'trace-fixture-catalog', 1,
          'Synthetic queue poll fixture', 'authority', ARRAY['authored fixture tests'], 'api',
          ARRAY['synthetic.invalid'], ARRAY['synthetic fixture only'], ARRAY['authored fixture'],
          'active', 'approved', 'unknown', true, 'never', 300)`,
    );
  });

  after(async () => {
    await database.close();
  });

  it("converges after an uncertain queue acknowledgement under L1 role and completes empty input without writes", async () => {
    const queued = await ports.acquisitionJobs.enqueueModeratorSubmission({
      datasetKind: "synthetic",
      idempotencyKey: "fixture-pipeline:one",
      traceId: fixtureTrace,
      requestedBy: "moderator-fixture-test",
      submittedUrl: fixtureUrl,
      requestedAt: t0,
    });
    assert.equal(queued.outcome, "enqueued");
    if (queued.outcome !== "enqueued") return;

    const claimed = await ports.acquisitionJobs.claimDueJob(t0, 1_000);
    assert.ok(claimed);
    assert.equal(claimed.jobId, queued.job.jobId);
    assert.equal(claimed.jobKind, "moderator_submission");
    assert.equal(claimed.datasetKind, "synthetic");
    assert.equal(claimed.sourceId, null);
    assert.equal(claimed.status, "leased");

    const catalog = new InMemorySyntheticFixtureCatalog([makeFixture()]);
    const expiredTime = "2026-09-25T03:00:02.000Z";
    let uncertainAcknowledgementCalls = 0;
    let extractionAdapterCalls = 0;
    const changingAdapter: FixturePipelinePorts["modelAdapter"] = {
      async extract(request) {
        extractionAdapterCalls += 1;
        const result = await pipelinePorts.modelAdapter.extract(request);
        if (extractionAdapterCalls === 1 || result.status !== "succeeded") return result;
        return { ...result, value: { ...result.value, category: "crime_personal_security" } };
      },
    };
    const replayPipelinePorts: FixturePipelinePorts = { ...pipelinePorts, modelAdapter: changingAdapter };
    const interruptedPipelinePorts: FixturePipelinePorts = {
      ...replayPipelinePorts,
      acquisitionJobs: new Proxy(pipelinePorts.acquisitionJobs, {
        get(target, property, receiver) {
          if (property === "complete") {
            return async () => {
              uncertainAcknowledgementCalls += 1;
              throw new Error("synthetic uncertain acknowledgement");
            };
          }
          const value: unknown = Reflect.get(target, property, receiver);
          return typeof value === "function" ? value.bind(target) : value;
        },
      }),
    };
    const interruptedResult = await runAsL1(database, () => processSyntheticFixtureJob({
      job: claimed,
      catalog,
      ports: interruptedPipelinePorts,
      transitionAt: "2026-09-25T03:00:00.500Z",
    }));
    assert.deepEqual(interruptedResult, {
      outcome: "failed", code: "queue_acknowledgement_failed", queueOutcome: "not_acknowledged",
    });
    assert.equal(uncertainAcknowledgementCalls, 1);
    assert.equal(extractionAdapterCalls, 1);
    const stillLeased = await ports.acquisitionJobs.findById("synthetic", claimed.jobId);
    assert.equal(stillLeased?.status, "leased");
    assert.equal(stillLeased?.leaseToken, claimed.leaseToken);

    const persistedBeforeRecovery = await database.executor.query<{ candidates: string; links: string }>(
      `SELECT
         (SELECT count(*)::text FROM waspada.extraction_results
          WHERE dataset_kind = 'synthetic' AND candidate_id = 'candidate-fixture-pipeline-1') AS candidates,
         (SELECT count(*)::text FROM waspada.extraction_evidence
          WHERE dataset_kind = 'synthetic' AND candidate_id = 'candidate-fixture-pipeline-1') AS links`,
    );
    assert.deepEqual(persistedBeforeRecovery.rows[0], { candidates: "1", links: "4" });

    assert.equal(await ports.acquisitionJobs.recoverExpiredLeases(expiredTime), 1);
    const retryClaimTime = "2026-09-25T03:00:32.000Z";
    const retryClaim = await ports.acquisitionJobs.claimDueJob(retryClaimTime);
    assert.ok(retryClaim);
    assert.equal(retryClaim.jobId, claimed.jobId);
    assert.notEqual(retryClaim.leaseToken, claimed.leaseToken);

    const replayResult = await runAsL1(database, () => processSyntheticFixtureJob({
      job: retryClaim,
      catalog,
      ports: replayPipelinePorts,
      transitionAt: "2026-09-25T03:00:33.000Z",
    }));
    assert.deepEqual(replayResult, {
      outcome: "completed", empty: false, reportCount: 1,
      evidenceReferenceCount: 5, chunkCount: 1, geometryCount: 1,
    });
    assert.equal(extractionAdapterCalls, 1);
    const convergedCandidate = await database.executor.query<{ candidates: string; links: string }>(
      `SELECT
         (SELECT count(*)::text FROM waspada.extraction_results
          WHERE dataset_kind = 'synthetic' AND candidate_id = 'candidate-fixture-pipeline-1') AS candidates,
         (SELECT count(*)::text FROM waspada.extraction_evidence
          WHERE dataset_kind = 'synthetic' AND candidate_id = 'candidate-fixture-pipeline-1') AS links`,
    );
    assert.deepEqual(convergedCandidate.rows[0], { candidates: "1", links: "4" });
    const persistedRelations = await database.executor.query<{ relation: string }>(
      `SELECT reference.relation
       FROM waspada.extraction_evidence AS link
       JOIN waspada.evidence_references AS reference
         ON reference.dataset_kind = link.dataset_kind AND reference.evidence_ref_id = link.evidence_ref_id
       WHERE link.dataset_kind = 'synthetic' AND link.candidate_id = 'candidate-fixture-pipeline-1'
       ORDER BY reference.relation`,
    );
    assert.deepEqual(persistedRelations.rows.map((row) => row.relation),
      ["context", "contradicts", "supports", "updates"]);

    const revision = await database.executor.query<{
      trace_id: string;
      revision_status: string;
      retrieved_at: string;
      record_json: Record<string, unknown>;
    }>(
      `SELECT trace_id, revision_status, retrieved_at::text AS retrieved_at, record_json
       FROM waspada.report_revisions
       WHERE dataset_kind = 'synthetic' AND report_revision_id = 'revision-fixture-pipeline-1'`,
    );
    assert.equal(revision.rows.length, 1);
    assert.equal(revision.rows[0]?.trace_id, fixtureTrace);
    assert.equal(revision.rows[0]?.revision_status, "unreviewed");
    assert.equal(Date.parse(revision.rows[0]?.retrieved_at ?? "invalid"), Date.parse(retrievedAt));
    assert.equal((revision.rows[0]?.record_json).record_type, "ReportRevision");
    assert.equal((revision.rows[0]?.record_json).source_created_at, undefined);
    assert.equal((revision.rows[0]?.record_json).provider_status, undefined);
    assert.equal((revision.rows[0]?.record_json).report_type, undefined);
    assert.equal((revision.rows[0]?.record_json).source_revision_key, null);
    assert.equal((revision.rows[0]?.record_json).published_at, null);
    assert.equal((revision.rows[0]?.record_json).observed_at, null);

    const evidence = await database.executor.query<{
      evidence_ref_id: string;
      trace_id: string;
      span_start: number;
      span_end: number;
      relation: string;
    }>(
      `SELECT evidence_ref_id::text AS evidence_ref_id, trace_id, span_start, span_end, relation
       FROM waspada.evidence_references
       WHERE dataset_kind = 'synthetic' AND report_revision_id = 'revision-fixture-pipeline-1'`,
    );
    assert.equal(evidence.rows.length, 5);
    assert.equal(evidence.rows[0]?.trace_id, fixtureTrace);
    assert.deepEqual(new Set(evidence.rows.map((row) => row.relation)),
      new Set(["supports", "contradicts", "updates", "context"]));
    const cpLength = Array.from(permittedText).length;
    assert.ok(evidence.rows.some((row) => row.span_start === 0 && row.span_end === cpLength));

    const extraction = await database.executor.query<{
      candidate_id: string;
      trace_id: string;
      report_revision_id: string;
      category: string;
      record_json: Record<string, unknown>;
    }>(
      `SELECT candidate_id, trace_id, report_revision_id, category, record_json
       FROM waspada.extraction_results
       WHERE dataset_kind = 'synthetic' AND candidate_id = 'candidate-fixture-pipeline-1'`,
    );
    assert.equal(extraction.rows.length, 1);
    assert.equal(extraction.rows[0]?.trace_id, fixtureTrace);
    assert.equal(extraction.rows[0]?.report_revision_id, "revision-fixture-pipeline-1");
    assert.equal(extraction.rows[0]?.category, "transport_road_incidents");
    assert.equal(extraction.rows[0]?.record_json.schema_version, "2.0");
    assert.equal(extraction.rows[0]?.record_json.record_type, "ExtractionResult");
    assert.equal(extraction.rows[0]?.record_json.trace_id, fixtureTrace);
    assert.equal(extraction.rows[0]?.record_json.dataset_kind, "synthetic");
    assert.equal(extraction.rows[0]?.record_json.provider, undefined);
    assert.deepEqual(
      ((extraction.rows[0]?.record_json.evidence as { relation: string }[]) ?? []).map(({ relation }) => relation),
      ["supports", "contradicts", "updates", "context"],
    );
    const extractionLinks = await database.executor.query<{ candidate_id: string; relation: string }>(
      `SELECT link.candidate_id, reference.relation
       FROM waspada.extraction_evidence AS link
       JOIN waspada.evidence_references AS reference
         ON reference.dataset_kind = link.dataset_kind
        AND reference.evidence_ref_id = link.evidence_ref_id
       WHERE link.dataset_kind = 'synthetic' AND link.candidate_id = 'candidate-fixture-pipeline-1'
       ORDER BY reference.relation`,
    );
    assert.equal(extractionLinks.rows.length, 4);
    assert.deepEqual(extractionLinks.rows.map((row) => row.relation),
      ["context", "contradicts", "supports", "updates"]);

    const chunks = await database.executor.query<{ count: string; first_trace: string }>(
      `SELECT count(*)::text AS count, min(trace_id) AS first_trace
       FROM waspada.evidence_chunks
       WHERE dataset_kind = 'synthetic' AND report_revision_id = 'revision-fixture-pipeline-1'`,
    );
    assert.equal(chunks.rows[0]?.count, "1");
    assert.equal(chunks.rows[0]?.first_trace, fixtureTrace);
    const geometry = await database.executor.query<{
      count: string;
      trace_id: string;
      role: string;
      crs: string;
      coordinates: { coordinates: number[] };
    }>(
      `SELECT count(*) OVER ()::text AS count, trace_id, role,
              coordinate_reference_system AS crs, ST_AsGeoJSON(shape)::jsonb AS coordinates
       FROM waspada.geometries
       WHERE dataset_kind = 'synthetic' AND geometry_id = 'geometry-fixture-pipeline-1'`,
    );
    assert.equal(geometry.rows.length, 1);
    assert.equal(geometry.rows[0]?.count, "1");
    assert.equal(geometry.rows[0]?.trace_id, fixtureTrace);
    assert.equal(geometry.rows[0]?.role, "approximate_place");
    assert.equal(geometry.rows[0]?.crs, "OGC:CRS84");
    assert.deepEqual(geometry.rows[0]?.coordinates.coordinates, [106.8272, -6.1754]);
    const links = await database.executor.query<{ count: string }>(
      `SELECT count(*)::text AS count
       FROM waspada.geometry_evidence
       WHERE dataset_kind = 'synthetic' AND geometry_id = 'geometry-fixture-pipeline-1'`,
    );
    assert.equal(links.rows[0]?.count, "1");

    const completed = await ports.acquisitionJobs.findById("synthetic", claimed.jobId);
    assert.equal(completed?.status, "completed");
    assert.equal(completed?.lastFailureCode, "lease_expired");
    const sourceState = await database.executor.query<{
      health_status: string;
      last_checked_at: string | null;
      auto_acquisition_enabled: boolean;
      auto_publication_policy: string;
    }>(
      `SELECT health_status, last_checked_at::text AS last_checked_at,
              auto_acquisition_enabled, auto_publication_policy
       FROM waspada.source_registry WHERE source_id = 'source-fixture-pipeline'`,
    );
    assert.deepEqual(sourceState.rows[0], {
      health_status: "unknown", last_checked_at: null,
      auto_acquisition_enabled: false, auto_publication_policy: "never",
    });

    const emptyQueued = await ports.acquisitionJobs.enqueueModeratorSubmission({
      datasetKind: "synthetic",
      idempotencyKey: "fixture-pipeline:empty",
      traceId: emptyTrace,
      requestedBy: "moderator-fixture-test",
      submittedUrl: `${fixtureUrl}/empty`,
      requestedAt: "2026-09-25T03:00:40.000Z",
    });
    assert.equal(emptyQueued.outcome, "enqueued");
    if (emptyQueued.outcome !== "enqueued") return;
    const emptyClaim = await ports.acquisitionJobs.claimDueJob("2026-09-25T03:00:40.000Z");
    assert.ok(emptyClaim);
    assert.equal(emptyClaim.jobId, emptyQueued.job.jobId);
    const emptyFixture: SyntheticFixture = {
      url: `${fixtureUrl}/empty`,
      geoJson: JSON.stringify({ type: "FeatureCollection", features: [] }),
      retrievedAt,
      sourceId: "source-fixture-pipeline",
      manifests: new Map(),
    };
    const emptyResult = await runAsL1(database, () => processSyntheticFixtureJob({
      job: emptyClaim,
      catalog: new InMemorySyntheticFixtureCatalog([emptyFixture]),
      ports: pipelinePorts,
      transitionAt: "2026-09-25T03:00:41.000Z",
    }));
    assert.deepEqual(emptyResult, {
      outcome: "completed", empty: true, reportCount: 0,
      evidenceReferenceCount: 0, chunkCount: 0, geometryCount: 0,
    });
    const counts = await database.executor.query<{
      revisions: string;
      evidence: string;
      chunks: string;
      geometries: string;
      events: string;
      publications: string;
    }>(
      `SELECT
         (SELECT count(*)::text FROM waspada.report_revisions WHERE dataset_kind = 'synthetic') AS revisions,
         (SELECT count(*)::text FROM waspada.evidence_references WHERE dataset_kind = 'synthetic') AS evidence,
         (SELECT count(*)::text FROM waspada.evidence_chunks WHERE dataset_kind = 'synthetic') AS chunks,
         (SELECT count(*)::text FROM waspada.geometries WHERE dataset_kind = 'synthetic') AS geometries,
         (SELECT count(*)::text FROM waspada.event_versions WHERE dataset_kind = 'synthetic') AS events,
         (SELECT count(*)::text FROM waspada.publication_decisions WHERE dataset_kind = 'synthetic') AS publications`,
    );
    assert.deepEqual(counts.rows[0], {
      revisions: "1", evidence: "5", chunks: "1", geometries: "1", events: "0", publications: "0",
    });
    const emptyJob = await ports.acquisitionJobs.findById("synthetic", emptyClaim.jobId);
    assert.equal(emptyJob?.status, "completed");
  });

  it("claims only one due synthetic moderator fixture while leaving live and other jobs unleased", async () => {
    const runnerUrl = "https://synthetic.invalid/moderator/fixture-runner";
    const runnerTime = "2026-09-25T04:00:00.000Z";
    const livePoll = await ports.acquisitionJobs.enqueueSourcePoll({
      datasetKind: "live", idempotencyKey: "fixture-runner:live-poll",
      traceId: runnerLiveTrace, sourceId: "source-fixture-runner-poll", requestedAt: runnerTime,
    });
    const historicalSubmission = await ports.acquisitionJobs.enqueueModeratorSubmission({
      datasetKind: "historical", idempotencyKey: "fixture-runner:historical-submission",
      traceId: runnerHistoricalTrace, requestedBy: "fixture-runner-test",
      submittedUrl: runnerUrl, requestedAt: runnerTime,
    });
    const syntheticPoll = await ports.acquisitionJobs.enqueueSourcePoll({
      datasetKind: "synthetic", idempotencyKey: "fixture-runner:synthetic-poll",
      traceId: runnerTrace, sourceId: "source-fixture-runner-poll", requestedAt: runnerTime,
    });
    const syntheticSubmission = await ports.acquisitionJobs.enqueueModeratorSubmission({
      datasetKind: "synthetic", idempotencyKey: "fixture-runner:synthetic-submission",
      traceId: runnerTrace, requestedBy: "fixture-runner-test",
      submittedUrl: runnerUrl, requestedAt: runnerTime,
    });
    assert.equal(livePoll.outcome, "enqueued");
    assert.equal(historicalSubmission.outcome, "enqueued");
    assert.equal(syntheticPoll.outcome, "enqueued");
    assert.equal(syntheticSubmission.outcome, "enqueued");
    if (livePoll.outcome !== "enqueued" || historicalSubmission.outcome !== "enqueued"
      || syntheticPoll.outcome !== "enqueued" || syntheticSubmission.outcome !== "enqueued") return;

    const result = await runAsL1(database, () => runSyntheticFixtureJob({
      now: runnerTime,
      queue: ports.acquisitionJobs,
      catalog: new InMemorySyntheticFixtureCatalog([makeFixture({
        url: runnerUrl,
        candidateId: "candidate-fixture-runner-1",
        reportRevisionId: "revision-fixture-runner-1",
        geometryId: "geometry-fixture-runner-1",
      })]),
      pipelinePorts,
    }));
    assert.deepEqual(result, {
      outcome: "completed", empty: false, reportCount: 1,
      evidenceReferenceCount: 5, chunkCount: 1, geometryCount: 1,
    });
    assert.equal(JSON.stringify(result).includes(runnerUrl), false);

    for (const [datasetKind, jobId] of [
      ["live", livePoll.job.jobId],
      ["historical", historicalSubmission.job.jobId],
      ["synthetic", syntheticPoll.job.jobId],
    ] as const) {
      const untouched = await ports.acquisitionJobs.findById(datasetKind, jobId);
      assert.equal(untouched?.status, "pending");
      assert.equal(untouched?.attemptCount, 0);
      assert.equal(untouched?.leaseToken, null);
    }
    const completed = await ports.acquisitionJobs.findById("synthetic", syntheticSubmission.job.jobId);
    assert.equal(completed?.status, "completed");
    assert.equal(completed?.attemptCount, 1);

    const persisted = await database.executor.query<{ revisions: string; events: string; publications: string }>(
      `SELECT
         (SELECT count(*)::text FROM waspada.report_revisions WHERE trace_id = $1) AS revisions,
         (SELECT count(*)::text FROM waspada.event_versions WHERE trace_id = $1) AS events,
         (SELECT count(*)::text FROM waspada.publication_decisions WHERE trace_id = $1) AS publications`,
      [runnerTrace],
    );
    assert.deepEqual(persisted.rows[0], { revisions: "1", events: "0", publications: "0" });
    const pollSource = await database.executor.query<{
      health_status: string;
      last_checked_at: string | null;
      last_success_at: string | null;
    }>(
      `SELECT health_status, last_checked_at::text AS last_checked_at,
              last_success_at::text AS last_success_at
       FROM waspada.source_registry WHERE source_id = 'source-fixture-runner-poll'`,
    );
    assert.deepEqual(pollSource.rows[0], {
      health_status: "unknown", last_checked_at: null, last_success_at: null,
    });
  });

  it("claims one due synthetic source poll, replays writes, and leaves out-of-scope work untouched", async () => {
    const pollAt = "2026-09-25T03:00:00.000Z";
    const retryAt = "2026-09-25T03:02:31.000Z";
    const pollUrl = "https://synthetic.invalid/polls/fixture-runner-poll";
    const pollFixture = makeFixture({
      sourceId: "source-fixture-runner-poll",
      url: pollUrl,
      candidateId: "candidate-fixture-source-poll-1",
      reportRevisionId: "revision-fixture-source-poll-1",
      geometryId: "geometry-fixture-source-poll-1",
    });
    await database.executor.query(
      `INSERT INTO waspada.source_registry
         (source_id, trace_id, registry_version, display_name, source_kind, remit,
          access_method, approved_hosts, access_restrictions, reuse_basis, registry_status,
          approval_status, health_status, auto_acquisition_enabled, auto_publication_policy,
          polling_interval_seconds)
       VALUES ('source-fixture-poll-paused', 'trace-fixture-catalog', 1,
          'Synthetic ineligible poll fixture', 'authority', ARRAY['authored fixture tests'], 'api',
          ARRAY['synthetic.invalid'], ARRAY['synthetic fixture only'], ARRAY['authored fixture'],
          'active', 'approved', 'unknown', true, 'never', 300)`,
    );
    const ineligiblePoll = await ports.acquisitionJobs.enqueueSourcePoll({
      datasetKind: "synthetic", idempotencyKey: "fixture-source-poll:paused",
      traceId: runnerTrace, sourceId: "source-fixture-poll-paused", requestedAt: pollAt,
    });
    const duePoll = await ports.acquisitionJobs.enqueueSourcePoll({
      datasetKind: "synthetic", idempotencyKey: "fixture-source-poll:due",
      traceId: runnerTrace, sourceId: "source-fixture-runner-poll", requestedAt: pollAt,
    });
    const futurePoll = await ports.acquisitionJobs.enqueueSourcePoll({
      datasetKind: "synthetic", idempotencyKey: "fixture-source-poll:future",
      traceId: runnerTrace, sourceId: "source-fixture-runner-poll", requestedAt: "2026-09-25T03:10:00.000Z",
    });
    const livePoll = await ports.acquisitionJobs.enqueueSourcePoll({
      datasetKind: "live", idempotencyKey: "fixture-source-poll:live",
      traceId: runnerLiveTrace, sourceId: "source-fixture-runner-poll", requestedAt: pollAt,
    });
    const historicalPoll = await ports.acquisitionJobs.enqueueSourcePoll({
      datasetKind: "historical", idempotencyKey: "fixture-source-poll:historical",
      traceId: runnerHistoricalTrace, sourceId: "source-fixture-runner-poll", requestedAt: pollAt,
    });
    const moderatorSubmission = await ports.acquisitionJobs.enqueueModeratorSubmission({
      datasetKind: "synthetic", idempotencyKey: "fixture-source-poll:moderator",
      traceId: runnerTrace, requestedBy: "fixture-source-poll-test",
      submittedUrl: pollUrl, requestedAt: pollAt,
    });
    for (const receipt of [ineligiblePoll, duePoll, futurePoll, livePoll, historicalPoll]) {
      assert.equal(receipt.outcome, "enqueued");
    }
    assert.equal(moderatorSubmission.outcome, "enqueued");
    if (ineligiblePoll.outcome !== "enqueued" || duePoll.outcome !== "enqueued"
      || futurePoll.outcome !== "enqueued" || livePoll.outcome !== "enqueued"
      || historicalPoll.outcome !== "enqueued" || moderatorSubmission.outcome !== "enqueued") return;
    await database.executor.query(
      "UPDATE waspada.source_registry SET registry_status = 'paused', auto_acquisition_enabled = false WHERE source_id = 'source-fixture-poll-paused'",
    );
    let extractionAdapterCalls = 0;
    const countingAdapter: FixturePipelinePorts["modelAdapter"] = {
      async extract(request) {
        extractionAdapterCalls += 1;
        return pipelinePorts.modelAdapter.extract(request);
      },
    };
    const pollPipelinePorts: FixturePipelinePorts = { ...pipelinePorts, modelAdapter: countingAdapter };
    const catalog = new InMemorySyntheticSourcePollFixtureCatalog([pollFixture]);
    const assertPollWritesPersisted = async () => {
      const rows = await database.executor.query<{ reports: string; sourceMatches: string; candidates: string; links: string; chunks: string; geometries: string }>(
        `SELECT
           (SELECT count(*)::text FROM waspada.report_revisions WHERE dataset_kind = 'synthetic' AND report_revision_id = 'revision-fixture-source-poll-1') AS reports,
           (SELECT count(*)::text FROM waspada.report_revisions WHERE dataset_kind = 'synthetic'
              AND report_revision_id = 'revision-fixture-source-poll-1'
              AND source_id = 'source-fixture-runner-poll'
              AND canonical_url = 'https://synthetic.invalid/polls/fixture-runner-poll') AS "sourceMatches",
           (SELECT count(*)::text FROM waspada.extraction_results WHERE dataset_kind = 'synthetic' AND candidate_id = 'candidate-fixture-source-poll-1') AS candidates,
           (SELECT count(*)::text FROM waspada.extraction_evidence WHERE dataset_kind = 'synthetic' AND candidate_id = 'candidate-fixture-source-poll-1') AS links,
           (SELECT count(*)::text FROM waspada.evidence_chunks WHERE dataset_kind = 'synthetic' AND report_revision_id = 'revision-fixture-source-poll-1') AS chunks,
           (SELECT count(*)::text FROM waspada.geometries WHERE dataset_kind = 'synthetic' AND geometry_id = 'geometry-fixture-source-poll-1') AS geometries`,
      );
      assert.deepEqual(rows.rows[0], {
        reports: "1", sourceMatches: "1", candidates: "1", links: "4", chunks: "1", geometries: "1",
      });
    };
    let uncertainAcknowledgementCalls = 0;
    const interruptedJobs = new Proxy(pipelinePorts.acquisitionJobs, {
      get(target, property, receiver) {
        if (property === "complete") {
          return async () => {
            uncertainAcknowledgementCalls += 1;
            await assertPollWritesPersisted();
            throw new Error("synthetic poll acknowledgement connection loss");
          };
        }
        const value: unknown = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const interrupted = await runAsL1(database, () => runSyntheticSourcePollJob({
      now: pollAt,
      queue: ports.acquisitionJobs,
      catalog,
      pipelinePorts: { ...pollPipelinePorts, acquisitionJobs: interruptedJobs },
    }));
    assert.deepEqual(interrupted, {
      outcome: "failed", code: "queue_acknowledgement_failed", queueOutcome: "not_acknowledged",
    });
    assert.equal(uncertainAcknowledgementCalls, 1);
    assert.equal(extractionAdapterCalls, 1);
    const leased = await ports.acquisitionJobs.findById("synthetic", duePoll.job.jobId);
    assert.equal(leased?.status, "leased");

    assert.equal(await ports.acquisitionJobs.recoverExpiredLeases("2026-09-25T03:02:00.000Z"), 1);
    const replayJobs = new Proxy(pipelinePorts.acquisitionJobs, {
      get(target, property, receiver) {
        if (property === "complete") {
          return async (...args: Parameters<typeof target.complete>) => {
            await assertPollWritesPersisted();
            return target.complete(...args);
          };
        }
        const value: unknown = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const replayed = await runAsL1(database, () => runSyntheticSourcePollJob({
      now: retryAt,
      queue: ports.acquisitionJobs,
      catalog,
      pipelinePorts: { ...pollPipelinePorts, acquisitionJobs: replayJobs },
    }));
    assert.deepEqual(replayed, {
      outcome: "completed", empty: false, reportCount: 1,
      evidenceReferenceCount: 5, chunkCount: 1, geometryCount: 1,
    });
    assert.equal(extractionAdapterCalls, 1);
    assert.equal(uncertainAcknowledgementCalls, 1);

    for (const [datasetKind, jobId] of [
      ["synthetic", ineligiblePoll.job.jobId],
      ["synthetic", futurePoll.job.jobId],
      ["live", livePoll.job.jobId],
      ["historical", historicalPoll.job.jobId],
      ["synthetic", moderatorSubmission.job.jobId],
    ] as const) {
      const untouched = await ports.acquisitionJobs.findById(datasetKind, jobId);
      assert.equal(untouched?.status, "pending");
      assert.equal(untouched?.attemptCount, 0);
      assert.equal(untouched?.leaseToken, null);
    }
    const completed = await ports.acquisitionJobs.findById("synthetic", duePoll.job.jobId);
    assert.equal(completed?.status, "completed");
    assert.equal(completed?.attemptCount, 2);
    const sourceHealth = await database.executor.query<{
      registry_status: string; approval_status: string; auto_acquisition_enabled: boolean;
      auto_publication_policy: string; health_status: string; last_checked_at: string | null;
    }>(
      `SELECT registry_status, approval_status, auto_acquisition_enabled,
              auto_publication_policy, health_status, last_checked_at::text AS last_checked_at
       FROM waspada.source_registry WHERE source_id = 'source-fixture-runner-poll'`,
    );
    assert.equal(sourceHealth.rows[0]?.registry_status, "active");
    assert.equal(sourceHealth.rows[0]?.approval_status, "approved");
    assert.equal(sourceHealth.rows[0]?.auto_acquisition_enabled, true);
    assert.equal(sourceHealth.rows[0]?.auto_publication_policy, "never");
    assert.equal(sourceHealth.rows[0]?.health_status, "healthy");
    assert.equal(Date.parse(sourceHealth.rows[0]?.last_checked_at ?? "invalid"), Date.parse(retryAt));
    const publishedState = await database.executor.query<{ events: string; publications: string }>(
      `SELECT
         (SELECT count(*)::text FROM waspada.event_versions WHERE trace_id = $1) AS events,
         (SELECT count(*)::text FROM waspada.publication_decisions WHERE trace_id = $1) AS publications`,
      [runnerTrace],
    );
    assert.deepEqual(publishedState.rows[0], { events: "0", publications: "0" });
    assert.equal(JSON.stringify(replayed).includes(pollUrl), false);
    assert.equal(JSON.stringify(replayed).includes(permittedText), false);
  });

  it("schedules and persists one exact synthetic poll before acknowledging its queue job", async () => {
    const cycleAt = "2026-09-25T03:00:00.000Z";
    const cycleRetrievedAt = "2026-09-25T02:55:00.000Z";
    const cycleObservedAt = "2026-09-25T02:45:00.000Z";
    const cycleTrace = "trace-fixture-poll-cycle";
    const cycleSourceId = "source-fixture-poll-cycle";
    const cycleUrl = "https://synthetic.invalid/polls/poll-cycle-exact";
    const cycleFixture = makeFixture({
      sourceId: cycleSourceId,
      url: cycleUrl,
      candidateId: "candidate-fixture-poll-cycle",
      reportRevisionId: "revision-fixture-poll-cycle",
      geometryId: "geometry-fixture-poll-cycle",
      retrievedAt: cycleRetrievedAt,
      observedAt: cycleObservedAt,
    });
    const decoyFixture = makeFixture({
      sourceId: "source-fixture-poll-cycle-decoy",
      url: "https://synthetic.invalid/polls/poll-cycle-decoy",
      candidateId: "candidate-fixture-poll-cycle-decoy",
      reportRevisionId: "revision-fixture-poll-cycle-decoy",
      geometryId: "geometry-fixture-poll-cycle-decoy",
    });

    await ports.tracesAndAudit.createTrace(makeTrace(cycleTrace, "synthetic"));
    await database.executor.query(
      `INSERT INTO waspada.source_registry
         (source_id, trace_id, registry_version, display_name, source_kind, remit,
          access_method, approved_hosts, access_restrictions, reuse_basis, registry_status,
          approval_status, health_status, auto_acquisition_enabled, auto_publication_policy,
          polling_interval_seconds)
       VALUES ($1, 'trace-fixture-catalog', 1,
          'Synthetic poll-cycle fixture', 'authority', ARRAY['authored fixture tests'], 'api',
          ARRAY['synthetic.invalid'], ARRAY['synthetic fixture only'], ARRAY['authored fixture'],
          'active', 'approved', 'unknown', true, 'never', 300)`,
      [cycleSourceId],
    );

    // Suppress the shared runner fixture during scheduler selection, including when this case runs alone.
    const baselinePoll = await ports.acquisitionJobs.enqueueSourcePoll({
      datasetKind: "synthetic",
      idempotencyKey: "fixture-poll-cycle:suppress-baseline",
      traceId: runnerTrace,
      sourceId: "source-fixture-runner-poll",
      requestedAt: "2030-01-01T00:00:00.000Z",
    });
    assert.equal(baselinePoll.outcome, "enqueued");
    if (baselinePoll.outcome !== "enqueued") return;

    let scheduledJobId: string | null = null;
    let completionCalls = 0;
    const assertCycleWritesPersisted = async () => {
      const counts = await database.executor.query<{
        reports: string;
        sourceMatches: string;
        candidates: string;
        evidenceReferences: string;
        extractionLinks: string;
        chunks: string;
        geometries: string;
        decoyReports: string;
      }>(
        `SELECT
           (SELECT count(*)::text FROM waspada.report_revisions
            WHERE dataset_kind = 'synthetic' AND report_revision_id = 'revision-fixture-poll-cycle') AS reports,
           (SELECT count(*)::text FROM waspada.report_revisions
            WHERE dataset_kind = 'synthetic' AND report_revision_id = 'revision-fixture-poll-cycle'
              AND trace_id = $1 AND source_id = $2 AND canonical_url = $3) AS "sourceMatches",
           (SELECT count(*)::text FROM waspada.extraction_results
            WHERE dataset_kind = 'synthetic' AND candidate_id = 'candidate-fixture-poll-cycle') AS candidates,
           (SELECT count(*)::text FROM waspada.evidence_references
            WHERE dataset_kind = 'synthetic' AND report_revision_id = 'revision-fixture-poll-cycle') AS "evidenceReferences",
           (SELECT count(*)::text FROM waspada.extraction_evidence
            WHERE dataset_kind = 'synthetic' AND candidate_id = 'candidate-fixture-poll-cycle') AS "extractionLinks",
           (SELECT count(*)::text FROM waspada.evidence_chunks
            WHERE dataset_kind = 'synthetic' AND report_revision_id = 'revision-fixture-poll-cycle') AS chunks,
           (SELECT count(*)::text FROM waspada.geometries
            WHERE dataset_kind = 'synthetic' AND geometry_id = 'geometry-fixture-poll-cycle') AS geometries,
           (SELECT count(*)::text FROM waspada.report_revisions
            WHERE dataset_kind = 'synthetic' AND report_revision_id = 'revision-fixture-poll-cycle-decoy') AS "decoyReports"`,
        [cycleTrace, cycleSourceId, cycleUrl],
      );
      assert.deepEqual(counts.rows[0], {
        reports: "1", sourceMatches: "1", candidates: "1", evidenceReferences: "5",
        extractionLinks: "4", chunks: "1", geometries: "1", decoyReports: "0",
      });
      const report = await database.executor.query<{
        retrieved_at: string;
        published_at: string | null;
        observed_at: string | null;
      }>(
        `SELECT retrieved_at::text AS retrieved_at, published_at::text AS published_at,
                observed_at::text AS observed_at
         FROM waspada.report_revisions
         WHERE dataset_kind = 'synthetic' AND report_revision_id = 'revision-fixture-poll-cycle'`,
      );
      assert.equal(Date.parse(report.rows[0]?.retrieved_at ?? "invalid"), Date.parse(cycleRetrievedAt));
      assert.equal(report.rows[0]?.published_at, null);
      assert.equal(Date.parse(report.rows[0]?.observed_at ?? "invalid"), Date.parse(cycleObservedAt));
    };

    const completionObservedJobs: FixturePipelinePorts["acquisitionJobs"] = new Proxy(
      pipelinePorts.acquisitionJobs,
      {
        get(target, property, receiver) {
          if (property === "complete") {
            return async (...args: Parameters<typeof target.complete>) => {
              completionCalls += 1;
              const [datasetKind, jobId, leaseToken, completedAt] = args;
              assert.equal(datasetKind, "synthetic");
              assert.equal(jobId, scheduledJobId);
              assert.equal(completedAt, cycleAt);
              const leased = await ports.acquisitionJobs.findById(datasetKind, jobId);
              assert.equal(leased?.status, "leased");
              assert.equal(leased?.leaseToken, leaseToken);
              assert.equal(leased?.attemptCount, 1);
              await assertCycleWritesPersisted();
              const healthBeforeAcknowledgement = await database.executor.query<{
                registry_status: string;
                approval_status: string;
                auto_acquisition_enabled: boolean;
                auto_publication_policy: string;
                health_status: string;
                last_checked_at: string | null;
                last_success_at: string | null;
              }>(
                `SELECT registry_status, approval_status, auto_acquisition_enabled,
                        auto_publication_policy, health_status,
                        last_checked_at::text AS last_checked_at,
                        last_success_at::text AS last_success_at
                 FROM waspada.source_registry WHERE source_id = $1`,
                [cycleSourceId],
              );
              assert.deepEqual(healthBeforeAcknowledgement.rows[0], {
                registry_status: "active", approval_status: "approved",
                auto_acquisition_enabled: true, auto_publication_policy: "never",
                health_status: "unknown", last_checked_at: null, last_success_at: null,
              });
              return target.complete(...args);
            };
          }
          const value: unknown = Reflect.get(target, property, receiver);
          return typeof value === "function" ? value.bind(target) : value;
        },
      },
    );

    const cycleResult = await runAsL1(database, async () => {
      const scheduled = await new SqlSourcePollScheduler(database.executor, ports.acquisitionJobs)
        .scheduleDueSourcePolls({ datasetKind: "synthetic", traceId: cycleTrace, now: cycleAt });
      assert.deepEqual(scheduled, {
        candidateCount: 1, enqueuedCount: 1, existingCount: 0, notSchedulableCount: 0,
      });
      const queued = await database.executor.query<{
        job_id: string;
        dataset_kind: string;
        job_kind: string;
        source_id: string | null;
        trace_id: string;
        status: string;
        attempt_count: number;
        available_at: string;
      }>(
        `SELECT job_id, dataset_kind, job_kind, source_id, trace_id, status,
                attempt_count, available_at::text AS available_at
         FROM waspada.acquisition_jobs
         WHERE dataset_kind = 'synthetic' AND trace_id = $1`,
        [cycleTrace],
      );
      assert.equal(queued.rows.length, 1);
      const job = queued.rows[0]!;
      scheduledJobId = job.job_id;
      assert.equal(job.dataset_kind, "synthetic");
      assert.equal(job.job_kind, "source_poll");
      assert.equal(job.source_id, cycleSourceId);
      assert.equal(job.trace_id, cycleTrace);
      assert.equal(job.status, "pending");
      assert.equal(job.attempt_count, 0);
      assert.equal(Date.parse(job.available_at), Date.parse(cycleAt));

      const healthAfterScheduling = await database.executor.query<{ health_status: string; last_checked_at: string | null; last_success_at: string | null }>(
        `SELECT health_status, last_checked_at::text AS last_checked_at,
                last_success_at::text AS last_success_at
         FROM waspada.source_registry WHERE source_id = $1`,
        [cycleSourceId],
      );
      assert.deepEqual(healthAfterScheduling.rows[0], {
        health_status: "unknown", last_checked_at: null, last_success_at: null,
      });

      return runSyntheticSourcePollJob({
        now: cycleAt,
        queue: ports.acquisitionJobs,
        catalog: new InMemorySyntheticSourcePollFixtureCatalog([cycleFixture, decoyFixture]),
        pipelinePorts: { ...pipelinePorts, acquisitionJobs: completionObservedJobs },
      });
    });

    assert.deepEqual(cycleResult, {
      outcome: "completed", empty: false, reportCount: 1,
      evidenceReferenceCount: 5, chunkCount: 1, geometryCount: 1,
    });
    assert.equal(completionCalls, 1);
    assert.equal(scheduledJobId !== null, true);
    await assertCycleWritesPersisted();
    const completedJob = await ports.acquisitionJobs.findById("synthetic", scheduledJobId!);
    assert.equal(completedJob?.status, "completed");
    assert.equal(completedJob?.sourceId, cycleSourceId);
    assert.equal(completedJob?.traceId, cycleTrace);
    assert.equal(completedJob?.attemptCount, 1);
    const publishedState = await database.executor.query<{ events: string; publications: string }>(
      `SELECT
         (SELECT count(*)::text FROM waspada.event_versions WHERE trace_id = $1) AS events,
         (SELECT count(*)::text FROM waspada.publication_decisions WHERE trace_id = $1) AS publications`,
      [cycleTrace],
    );
    assert.deepEqual(publishedState.rows[0], { events: "0", publications: "0" });
    const completedHealth = await database.executor.query<{
      registry_status: string;
      approval_status: string;
      auto_acquisition_enabled: boolean;
      auto_publication_policy: string;
      health_status: string;
      last_checked_at: string | null;
      last_success_at: string | null;
    }>(
      `SELECT registry_status, approval_status, auto_acquisition_enabled,
              auto_publication_policy, health_status,
              last_checked_at::text AS last_checked_at,
              last_success_at::text AS last_success_at
       FROM waspada.source_registry WHERE source_id = $1`,
      [cycleSourceId],
    );
    const health = completedHealth.rows[0];
    assert.equal(health?.registry_status, "active");
    assert.equal(health?.approval_status, "approved");
    assert.equal(health?.auto_acquisition_enabled, true);
    assert.equal(health?.auto_publication_policy, "never");
    assert.equal(health?.health_status, "healthy");
    assert.equal(Date.parse(health?.last_checked_at ?? "invalid"), Date.parse(cycleAt));
    assert.equal(Date.parse(health?.last_success_at ?? "invalid"), Date.parse(cycleAt));

    const untouchedBaselinePoll = await ports.acquisitionJobs.findById("synthetic", baselinePoll.job.jobId);
    assert.equal(untouchedBaselinePoll?.status, "pending");
    assert.equal(untouchedBaselinePoll?.attemptCount, 0);
    assert.equal(untouchedBaselinePoll?.leaseToken, null);
  });

});

async function runAsL1<Result>(database: TestDatabase, work: () => Promise<Result>): Promise<Result> {
  await database.executor.execute("SET ROLE waspada_l1_pipeline");
  try {
    return await work();
  } finally {
    await database.executor.execute("RESET ROLE");
  }
}

function makeTrace(traceId: string, datasetKind: "live" | "historical" | "synthetic" | null) {
  return {
    traceId,
    datasetKind,
    startedAt: t0,
    endedAt: null,
    outcome: "open" as const,
    metadata: { fixture: "synthetic-fixture-pipeline" },
  };
}

function makeFixture(input: {
  readonly sourceId?: string;
  readonly url?: string;
  readonly candidateId?: string;
  readonly reportRevisionId?: string;
  readonly geometryId?: string;
  readonly retrievedAt?: string;
  readonly observedAt?: string | null;
} = {}): SyntheticFixture {
  const sourceId = input.sourceId ?? "source-fixture-pipeline";
  const url = input.url ?? fixtureUrl;
  const manifest: SyntheticReportManifest = {
    candidateId: input.candidateId ?? "candidate-fixture-pipeline-1",
    reportRevisionId: input.reportRevisionId ?? "revision-fixture-pipeline-1",
    sourceId,
    canonicalUrl: url,
    contentHash: "b".repeat(64),
    permittedText,
    publishedAt: null,
    observedAt: input.observedAt ?? null,
    validFrom: null,
    validUntil: null,
    supersedesId: null,
    supportSpans: [{ spanStart: 0, spanEnd: Array.from(permittedText).length }],
    geometry: {
      geometryId: input.geometryId ?? "geometry-fixture-pipeline-1",
      role: "approximate_place",
      precisionM: null,
      precisionBasis: "moderator_generalization",
      displayLabel: "Synthetic station entrance",
      supportSpans: [{ spanStart: 0, spanEnd: Array.from(permittedText).length }],
    },
  };
  return {
    url,
    geoJson: JSON.stringify({
      type: "FeatureCollection",
      features: [{
        type: "Feature",
        id: "parser-feature-id",
        properties: {
          status: "transient-only",
          report_type: "transient-only",
          created_at: "2020-01-02T03:04:05Z",
        },
        geometry: { type: "Point", coordinates: [106.8272, -6.1754] },
      }],
    }),
    retrievedAt: input.retrievedAt ?? retrievedAt,
    sourceId,
    manifests: new Map([["parser-feature-id", manifest]]),
  };
}

function createFixtureModelAdapter() {
  const provider: UntrustedModelProvider = {
    async classify() { throw new Error("unused synthetic classification"); },
    async extract(request: ExtractionRequest) {
      const report = request.data.report;
      const relations = ["supports", "contradicts", "updates", "context"] as const;
      return {
        output: {
          category: "transport_road_incidents",
          tags: [],
          eventTime: { start: null, end: null, precision: "unknown" },
          scope: { placeIds: [], serviceIds: [], institutionIds: [], audienceIds: [], geometryIds: [] },
          evidence: relations.map((relation, index) => ({
            reportRevisionId: report.reportRevisionId,
            permittedTextHash: report.permittedTextHash,
            spanStart: index * 5,
            spanEnd: index * 5 + 4,
            offsetUnit: "unicode_code_points",
            relation,
          })),
          unknownFields: ["event_time"],
        },
        usage: { inputTokens: 16, outputTokens: 9 },
      };
    },
    async embed() { throw new Error("unused synthetic embedding"); },
    async reason() { throw new Error("unused synthetic reasoning"); },
  };
  return createModelCapabilityAdapter(provider, {
    extraction: {
      provider: "synthetic-pglite-provider",
      modelVersion: "synthetic-extractor-v1",
      promptVersion: "fixture-extraction-v1",
    },
  });
}
