import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { SqlExecutor, TransactionalSqlExecutor } from "../src/sql.js";
import { applyMigrations, readMigrations } from "../src/migrations.js";
import { createRepositoryPorts } from "../src/ports.js";
import { createTestDatabase, type TestDatabase } from "./harness.js";
import {
  InMemorySyntheticSourcePollFixtureCatalog,
  type SyntheticFixture,
  type SyntheticReportManifest,
} from "../../worker/src/layers/l1-data-knowledge/synthetic-fixture-pipeline.js";
import { createModelCapabilityAdapter } from "../../worker/src/layers/l2-model-grounding/adapter.js";
import type {
  ExtractionRequest,
  UntrustedModelProvider,
} from "../../worker/src/layers/l2-model-grounding/contracts.js";
import {
  createSyntheticSourcePollProcessRuntime,
  type SyntheticSourcePollProcessRuntimeDependencies,
} from "../../worker/src/runtime/synthetic-source-poll-process-runtime.js";

const connectionString =
  "postgresql://l1-user:l1-password@hyperdrive.example.invalid/waspada?sslmode=require";
const scheduledTime = Date.parse("2026-10-04T00:00:00.000Z");
const traceId = "synthetic-poll-process-runtime-trace";
const fixtureText = "Synthetic source poll describes a station entrance on Merdeka Street.";
const sourceIds = ["process-runtime-source-a", "process-runtime-source-b"] as const;

describe("JOB-01-SYNTHETIC-POLL-WORKER-RUNTIME-CORE PGlite composition", () => {
  let database: TestDatabase;

  before(async () => {
    database = await createTestDatabase();
    const migrations = await readMigrations(new URL("../migrations/", import.meta.url));
    await applyMigrations(database.executor, migrations);
  });

  after(async () => {
    await database?.close();
  });

  it("sets and resets L1 role, persists exact-source fixture data before acknowledgement, and replays without another extraction", async () => {
    const ports = createRepositoryPorts(database.executor);
    await ports.tracesAndAudit.createTrace({
      traceId,
      datasetKind: "synthetic",
      startedAt: "2026-10-04T00:00:00.000Z",
      endedAt: null,
      outcome: "open",
      metadata: { fixture: "synthetic-poll-process-runtime" },
    });
    for (const sourceId of sourceIds) await seedSource(sourceId);

    const fixtureA = makeFixture(sourceIds[0], "runtime-a");
    const fixtureB = makeFixture(sourceIds[1], "runtime-b");
    const decoy = makeFixture("process-runtime-unclaimed-decoy", "runtime-decoy");
    const enqueued = await Promise.all(sourceIds.map((sourceId, index) =>
      ports.acquisitionJobs.enqueueSourcePoll({
        datasetKind: "synthetic",
        idempotencyKey: `runtime-poll:${index}`,
        traceId,
        sourceId,
        requestedAt: "2026-10-04T00:00:00.000Z",
      }),
    ));
    assert.ok(enqueued.every((receipt) => receipt.outcome === "enqueued"));

    const fixtureBySource = new Map([
      [sourceIds[0], fixtureA],
      [sourceIds[1], fixtureB],
    ]);
    const persistedBeforeAck: string[] = [];
    const observed = createObservedExecutor(database, async (jobId) => {
      const jobRows = await database.executor.query<{ source_id: string }>(
        "SELECT source_id FROM waspada.acquisition_jobs WHERE job_id = $1 AND dataset_kind = 'synthetic'",
        [jobId],
      );
      const sourceId = jobRows.rows[0]?.source_id;
      assert.ok(sourceId && fixtureBySource.has(sourceId as (typeof sourceIds)[number]));
      const fixture = fixtureBySource.get(sourceId as (typeof sourceIds)[number]);
      assert.ok(fixture);
      assert.equal(observed.activeTransactions, 0, "acknowledgement must follow committed repository writes");
      const manifest = fixture.manifests.get("parser-feature-id");
      assert.ok(manifest);
      const rows = await database.executor.query<{
        reports: string;
        exact_source: string;
        evidence_references: string;
        extraction_results: string;
        extraction_links: string;
        chunks: string;
        geometries: string;
      }>(
        `SELECT
           (SELECT count(*)::text FROM waspada.report_revisions
            WHERE dataset_kind = 'synthetic' AND report_revision_id = $1) AS reports,
           (SELECT count(*)::text FROM waspada.report_revisions
            WHERE dataset_kind = 'synthetic' AND report_revision_id = $1
              AND source_id = $2 AND canonical_url = $3) AS exact_source,
           (SELECT count(*)::text FROM waspada.evidence_references
            WHERE dataset_kind = 'synthetic' AND report_revision_id = $1) AS evidence_references,
           (SELECT count(*)::text FROM waspada.extraction_results
            WHERE dataset_kind = 'synthetic' AND candidate_id = $4) AS extraction_results,
           (SELECT count(*)::text FROM waspada.extraction_evidence
            WHERE dataset_kind = 'synthetic' AND candidate_id = $4) AS extraction_links,
           (SELECT count(*)::text FROM waspada.evidence_chunks
            WHERE dataset_kind = 'synthetic' AND report_revision_id = $1) AS chunks,
           (SELECT count(*)::text FROM waspada.geometries
            WHERE dataset_kind = 'synthetic' AND geometry_id = $5) AS geometries`,
        [manifest.reportRevisionId, sourceId, manifest.canonicalUrl, manifest.candidateId,
          manifest.geometry?.geometryId],
      );
      assert.deepEqual(rows.rows[0], {
        reports: "1",
        exact_source: "1",
        evidence_references: "5",
        extraction_results: "1",
        extraction_links: "4",
        chunks: "1",
        geometries: "1",
      });
      persistedBeforeAck.push(jobId);
    });

    let extractionCalls = 0;
    const provider: UntrustedModelProvider = {
      async classify() { throw new Error("classification provider must not be called"); },
      async extract(request: ExtractionRequest) {
        extractionCalls += 1;
        assert.equal(observed.activeTransactions, 0, "L2 inference must not run inside a SQL transaction");
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
          usage: { inputTokens: 18, outputTokens: 9 },
        };
      },
      async embed() { throw new Error("embedding provider must not be called"); },
      async reason() { throw new Error("reasoning provider must not be called"); },
    };
    const modelAdapter = createModelCapabilityAdapter(provider, {
      extraction: {
        provider: "synthetic-pglite-double",
        modelVersion: "fixed-extractor-v1",
        promptVersion: "fixed-fixture-v1",
      },
    });
    let failFirstAcknowledgement = true;
    const dependencies: SyntheticSourcePollProcessRuntimeDependencies = {
      catalog: new InMemorySyntheticSourcePollFixtureCatalog([fixtureA, fixtureB, decoy]),
      modelAdapter,
      withTransactionalSqlExecutor: async (_connectionString, operation) => operation(observed.executor),
    };
    const runtime = createSyntheticSourcePollProcessRuntime({
      datasetMode: "demo",
      processorEnabled: "true",
      l1ConnectionString: connectionString,
    }, {
      ...dependencies,
      withTransactionalSqlExecutor: async (_connectionString, operation) => {
        observed.failNextAcknowledgement = failFirstAcknowledgement;
        return operation(observed.executor);
      },
    });
    assert.ok(runtime);

    const uncertain = await runtime.process(scheduledTime);
    assert.deepEqual(uncertain, {
      outcome: "failed",
      code: "queue_acknowledgement_failed",
      queueOutcome: "not_acknowledged",
    });
    failFirstAcknowledgement = false;
    assert.equal(await currentUser(), "postgres");

    const firstJob = persistedBeforeAck[0];
    assert.ok(firstJob);
    const firstLease = await ports.acquisitionJobs.findById("synthetic", firstJob);
    assert.equal(firstLease?.status, "leased");
    assert.equal(firstLease?.attemptCount, 1);

    const second = await runtime.process(scheduledTime);
    assert.equal(second.outcome, "completed");
    assert.equal(await currentUser(), "postgres");
    assert.equal(extractionCalls, 2);
    assert.equal(persistedBeforeAck.length, 2);

    const recovered = await ports.acquisitionJobs.recoverExpiredLeases("2026-10-04T00:01:01.000Z");
    assert.equal(recovered, 1);
    const replayed = await runtime.process(Date.parse("2026-10-04T00:01:31.000Z"));
    assert.deepEqual(replayed, {
      outcome: "completed",
      empty: false,
      reportCount: 1,
      evidenceReferenceCount: 5,
      chunkCount: 1,
      geometryCount: 1,
    });
    assert.equal(await currentUser(), "postgres");
    assert.equal(extractionCalls, 2, "retry must reuse the persisted extraction result");
    assert.equal(persistedBeforeAck.length, 3);

    const jobStates = await Promise.all(enqueued.map(async (receipt) => {
      assert.equal(receipt.outcome, "enqueued");
      if (receipt.outcome !== "enqueued") return null;
      return ports.acquisitionJobs.findById("synthetic", receipt.job.jobId);
    }));
    assert.deepEqual(jobStates.map((job) => job?.status).sort(), ["completed", "completed"]);
    assert.deepEqual(jobStates.map((job) => job?.attemptCount).sort(), [1, 2]);
    assert.equal(new Set(persistedBeforeAck).size, 2);

    const decoyRows = await database.executor.query<{ reports: string }>(
      "SELECT count(*)::text AS reports FROM waspada.report_revisions WHERE dataset_kind = 'synthetic' AND report_revision_id = 'revision-runtime-decoy'",
    );
    assert.equal(decoyRows.rows[0]?.reports, "0");
    const publicWrites = await database.executor.query<{ events: string; publications: string }>(
      `SELECT
         (SELECT count(*)::text FROM waspada.event_versions WHERE trace_id = $1) AS events,
         (SELECT count(*)::text FROM waspada.publication_decisions WHERE trace_id = $1) AS publications`,
      [traceId],
    );
    assert.deepEqual(publicWrites.rows[0], { events: "0", publications: "0" });
  });

  async function seedSource(sourceId: string): Promise<void> {
    await database.executor.query(
      `INSERT INTO waspada.source_registry
         (source_id, trace_id, registry_version, display_name, source_kind, remit,
          access_method, approved_hosts, access_restrictions, reuse_basis, registry_status,
          approval_status, health_status, auto_acquisition_enabled, auto_publication_policy,
          polling_interval_seconds)
       VALUES ($1, $2, 1, 'Authored synthetic poll source', 'authority',
          ARRAY['authored test fixture'], 'api', ARRAY['synthetic.invalid'],
          ARRAY['synthetic fixture only'], ARRAY['authored fixture'], 'active', 'approved',
          'unknown', true, 'never', 300)`,
      [sourceId, traceId],
    );
  }

  async function currentUser(): Promise<string | undefined> {
    const result = await database.executor.query<{ current_user: string }>("SELECT current_user");
    return result.rows[0]?.current_user;
  }
});

function createObservedExecutor(
  database: TestDatabase,
  beforeAcknowledgement: (jobId: string) => Promise<void>,
) {
  let activeTransactions = 0;
  let failNextAcknowledgement = true;

  const wrapSql = (sql: SqlExecutor): SqlExecutor => ({
    async query<Row extends object>(statement: string, parameters: readonly unknown[] = []) {
      if (statement.includes("WITH completed AS")) {
        const jobId = parameters[1];
        assert.equal(typeof jobId, "string");
        await beforeAcknowledgement(jobId as string);
        if (failNextAcknowledgement) {
          failNextAcknowledgement = false;
          throw new Error("synthetic acknowledgement connection loss");
        }
      }
      return sql.query<Row>(statement, parameters);
    },
    execute(statement) { return sql.execute(statement); },
  });

  const executor: TransactionalSqlExecutor = {
    ...wrapSql(database.executor),
    async transaction<Result>(work: (transaction: SqlExecutor) => Promise<Result>) {
      return database.executor.transaction(async (transaction) => {
        activeTransactions += 1;
        try {
          return await work(wrapSql(transaction));
        } finally {
          activeTransactions -= 1;
        }
      });
    },
  };

  return {
    executor,
    get activeTransactions() { return activeTransactions; },
    set failNextAcknowledgement(value: boolean) { failNextAcknowledgement = value; },
  };
}

function makeFixture(sourceId: string, suffix: string): SyntheticFixture {
  const url = `https://synthetic.invalid/polls/${suffix}`;
  const manifest: SyntheticReportManifest = {
    candidateId: `candidate-${suffix}`,
    reportRevisionId: `revision-${suffix}`,
    sourceId,
    canonicalUrl: url,
    contentHash: "b".repeat(64),
    permittedText: fixtureText,
    publishedAt: null,
    observedAt: "2026-10-03T23:55:00.000Z",
    validFrom: null,
    validUntil: null,
    supersedesId: null,
    supportSpans: [{ spanStart: 0, spanEnd: Array.from(fixtureText).length }],
    geometry: {
      geometryId: `geometry-${suffix}`,
      role: "approximate_place",
      precisionM: null,
      precisionBasis: "moderator_generalization",
      displayLabel: "Synthetic Merdeka Street station",
      supportSpans: [{ spanStart: 0, spanEnd: Array.from(fixtureText).length }],
    },
  };
  return {
    sourceId,
    url,
    retrievedAt: "2026-10-04T00:00:00.000Z",
    geoJson: JSON.stringify({
      type: "FeatureCollection",
      features: [{
        type: "Feature",
        id: "parser-feature-id",
        properties: {
          status: "transient-only",
          report_type: "transient-only",
          created_at: "2026-10-03T23:55:00.000Z",
        },
        geometry: { type: "Point", coordinates: [106.8272, -6.1754] },
      }],
    }),
    manifests: new Map([["parser-feature-id", manifest]]),
  };
}
