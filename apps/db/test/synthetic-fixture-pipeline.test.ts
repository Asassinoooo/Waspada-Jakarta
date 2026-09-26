import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { createSqlGeometryWriter } from "../src/geometry-writer.js";
import { applyMigrations, readMigrations } from "../src/migrations.js";
import { createRepositoryPorts } from "../src/ports.js";
import { createTestDatabase, type TestDatabase } from "./harness.js";
import {
  InMemorySyntheticFixtureCatalog,
  processSyntheticFixtureJob,
  type FixturePipelinePorts,
  type SyntheticFixture,
  type SyntheticReportManifest,
} from "../../worker/src/layers/l1-data-knowledge/synthetic-fixture-pipeline.js";
import { runSyntheticFixtureJob } from "../../worker/src/layers/l1-data-knowledge/synthetic-fixture-runner.js";

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
      reportRevisions: ports.reportRevisions,
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

  it("replays expired work under L1 role, preserves first trace and exact IDs, and completes empty input without writes", async () => {
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
    const staleResult = await runAsL1(database, () => processSyntheticFixtureJob({
      job: claimed,
      catalog,
      ports: pipelinePorts,
      transitionAt: expiredTime,
    }));
    assert.deepEqual(staleResult, { outcome: "lost_lease", code: "lease_not_owned" });
    const stillLeased = await ports.acquisitionJobs.findById("synthetic", claimed.jobId);
    assert.equal(stillLeased?.status, "leased");
    assert.equal(stillLeased?.leaseToken, claimed.leaseToken);

    assert.equal(await ports.acquisitionJobs.recoverExpiredLeases(expiredTime), 1);
    const retryClaimTime = "2026-09-25T03:00:32.000Z";
    const retryClaim = await ports.acquisitionJobs.claimDueJob(retryClaimTime);
    assert.ok(retryClaim);
    assert.equal(retryClaim.jobId, claimed.jobId);
    assert.notEqual(retryClaim.leaseToken, claimed.leaseToken);

    const replayResult = await runAsL1(database, () => processSyntheticFixtureJob({
      job: retryClaim,
      catalog,
      ports: pipelinePorts,
      transitionAt: "2026-09-25T03:00:33.000Z",
    }));
    assert.deepEqual(replayResult, {
      outcome: "completed", empty: false, reportCount: 1,
      evidenceReferenceCount: 1, chunkCount: 1, geometryCount: 1,
    });

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
    assert.equal(evidence.rows.length, 1);
    assert.equal(evidence.rows[0]?.trace_id, fixtureTrace);
    assert.equal(evidence.rows[0]?.relation, "supports");
    const cpLength = Array.from(permittedText).length;
    assert.deepEqual([evidence.rows[0]?.span_start, evidence.rows[0]?.span_end], [0, cpLength]);

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
      revisions: "1", evidence: "1", chunks: "1", geometries: "1", events: "0", publications: "0",
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
        reportRevisionId: "revision-fixture-runner-1",
        geometryId: "geometry-fixture-runner-1",
      })]),
      pipelinePorts,
    }));
    assert.deepEqual(result, {
      outcome: "completed", empty: false, reportCount: 1,
      evidenceReferenceCount: 1, chunkCount: 1, geometryCount: 1,
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
  readonly url?: string;
  readonly reportRevisionId?: string;
  readonly geometryId?: string;
} = {}): SyntheticFixture {
  const url = input.url ?? fixtureUrl;
  const manifest: SyntheticReportManifest = {
    reportRevisionId: input.reportRevisionId ?? "revision-fixture-pipeline-1",
    sourceId: "source-fixture-pipeline",
    canonicalUrl: url,
    contentHash: "b".repeat(64),
    permittedText,
    publishedAt: null,
    observedAt: null,
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
    retrievedAt,
    sourceId: "source-fixture-pipeline",
    manifests: new Map([["parser-feature-id", manifest]]),
  };
}
