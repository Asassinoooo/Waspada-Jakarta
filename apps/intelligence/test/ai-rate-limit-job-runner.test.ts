import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it, before, after } from "node:test";
import type { Agent } from "@mastra/core/agent";
import { createTestDatabase, type TestDatabase } from "../../db/test/harness.js";
import { applyMigrations, readMigrations } from "../../db/src/migrations.js";
import { createJobRunner, classifyJobError } from "../src/job-runner.js";
import { createSqlIncidentRepository } from "../../db/src/incident-repository.js";
import {
  createNineRouterRateGate,
  RateLimitedError,
  setNineRouterRateGate,
} from "../../db/src/ninerouter-rate-gate.js";
import { createSemanticRetrievalService, NINEROUTER_EMBEDDING_IDENTITY } from "../src/services/semantic-retrieval-service.js";
import type { NineRouterConfig } from "../src/providers/ninerouter-adapter.js";
import { createMockInterpreterAgent, createMockCorrelatorAgent } from "./mock-agents.js";

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function countingAgent(inner: Agent, counter: { calls: number }): Agent {
  return {
    generate: async (...args: unknown[]) => {
      counter.calls += 1;
      return (inner as unknown as { generate: (...a: unknown[]) => Promise<unknown> }).generate(...args);
    },
  } as unknown as Agent;
}

function throwingAgent(make: () => Error): Agent {
  return {
    generate: async () => {
      throw make();
    },
  } as unknown as Agent;
}

describe("AI-RATE-01 job runner: rate limits defer, checkpoints resume, classification", () => {
  let db: TestDatabase;

  before(async () => {
    db = await createTestDatabase();
    const migrations = await readMigrations(new URL("../../db/migrations/", import.meta.url));
    await applyMigrations(db.executor, migrations);
    // AI-RPM-01: correlation calls the model only when a candidate incident is retrieved.
    // Seed one active incident, so the correlation-step tests below still reach the correlator.
    await enqueue("ai-job-rl-seed", "seed");
    const seeder = createJobRunner({
      executor: db.executor,
      agentOverrides: { interpreter: createMockInterpreterAgent(), correlator: createMockCorrelatorAgent() },
    });
    assert.equal(await seeder.processNextJob("synthetic"), true, "the seed incident is created");
  });

  after(async () => {
    setNineRouterRateGate(undefined);
    await db?.close();
  });

  async function seedRevision(key: string, permittedText = "Pohon tumbang menutup jalan."): Promise<{ traceId: string; revisionId: string }> {
    const traceId = `trace-rl-${key}`;
    const sourceId = `source-rl-${key}`;
    const revisionId = `rev-rl-${key}`;
    const textHash = sha256(permittedText);
    await db.executor.query(
      `INSERT INTO waspada.traces (trace_id, dataset_kind, started_at, outcome, metadata)
       VALUES ($1, 'synthetic', now(), 'succeeded', '{}'::jsonb)
       ON CONFLICT (trace_id, dataset_kind) DO NOTHING`,
      [traceId],
    );
    await db.executor.query(
      `INSERT INTO waspada.source_registry
         (source_id, trace_id, registry_version, display_name, source_kind, remit,
          access_method, approved_hosts, access_restrictions, reuse_basis, registry_status,
          approval_status, health_status, auto_acquisition_enabled, auto_publication_policy)
       VALUES ($1, $2, 1, 'Sumber Uji', 'other', ARRAY['system'], 'manual_fixture',
               ARRAY[]::text[], ARRAY[]::text[], ARRAY['public'], 'active', 'approved', 'healthy', false, 'never')
       ON CONFLICT (source_id) DO NOTHING`,
      [sourceId, traceId],
    );
    await db.executor.query(
      `INSERT INTO waspada.report_revisions
         (dataset_kind, report_revision_id, trace_id, source_id, canonical_url, content_hash, permitted_text,
          permitted_text_hash, normalization_version, retrieved_at, revision_status, record_json)
       VALUES ('synthetic', $1, $2, $3, $4, $5, $6, $5, 'v1', now(), 'unreviewed', '{}'::jsonb)
       ON CONFLICT (dataset_kind, report_revision_id) DO NOTHING`,
      [revisionId, traceId, sourceId, `https://synthetic.invalid/${revisionId}`, textHash, permittedText],
    );
    return { traceId, revisionId };
  }

  async function enqueue(jobId: string, key: string): Promise<void> {
    const { traceId, revisionId } = await seedRevision(key);
    await createSqlIncidentRepository(db.executor).enqueueAiJob({
      jobId,
      datasetKind: "synthetic",
      reportRevisionId: revisionId,
      traceId,
    });
  }

  /** Makes a deferred or retrying job claimable now, as time passing would. */
  async function makeDue(jobId: string): Promise<void> {
    await db.executor.query(`UPDATE waspada.ai_jobs SET available_at = now() WHERE job_id = $1`, [jobId]);
  }

  async function readJob(jobId: string) {
    const row = await db.executor.query<{
      status: string;
      attempt_count: number | string;
      last_failure_code: string | null;
      lease_token: string | null;
      available_at: string;
      checkpoint_json: unknown;
    }>(
      `SELECT status, attempt_count, last_failure_code, lease_token, available_at::text AS available_at, checkpoint_json
       FROM waspada.ai_jobs WHERE job_id = $1`,
      [jobId],
    );
    const record = row.rows[0];
    assert.ok(record, `job ${jobId} exists`);
    return { ...record, attempt_count: Number(record.attempt_count) };
  }

  it("classifies rate limits before model failures and keeps ordinary codes unchanged", () => {
    assert.equal(classifyJobError(new RateLimitedError({ retryAfterMs: 1_000, status: 429, bucket: "chat" })), "rate_limited");
    assert.equal(classifyJobError(new Error("Too Many Requests from upstream")), "rate_limited");
    assert.equal(classifyJobError(new Error("NineRouter API 429 quota exceeded")), "rate_limited");
    assert.equal(classifyJobError(new Error("NineRouter API 500 Internal Server Error")), "model_failed");
    assert.equal(classifyJobError(new Error("ZodError: Invalid schema output")), "invalid_output");
    // "generated" used to match the bare "rate" substring and became model_failed.
    assert.equal(classifyJobError(new Error("generated a short summary")), "workflow_execution_failed");
  });

  it("defers a rate-limited job: attempt given back, cooldown end as available_at, never needs_review", async () => {
    await enqueue("ai-job-rl-defer", "defer");
    const runner = createJobRunner({
      executor: db.executor,
      agentOverrides: {
        interpreter: createMockInterpreterAgent(),
        correlator: throwingAgent(() => new RateLimitedError({ retryAfterMs: 7_000, status: 429, bucket: "chat" })),
      },
    });

    assert.equal(await runner.processNextJob("synthetic"), false);
    const returnedAt = Date.now();
    const job = await readJob("ai-job-rl-defer");
    assert.equal(job.status, "retry");
    assert.equal(job.attempt_count, 0, "the claimed attempt is given back");
    assert.equal(job.last_failure_code, "rate_limited");
    assert.equal(job.lease_token, null);
    // The defer happens just before processNextJob returns, so available_at sits
    // about 7 s after the defer: at most 7 s past the return, and not much less.
    const aheadMs = Date.parse(job.available_at) - returnedAt;
    assert.ok(aheadMs <= 7_000 && aheadMs >= 5_000, `available_at is the cooldown end (${aheadMs} ms ahead)`);

    for (let i = 0; i < 10; i++) {
      await makeDue("ai-job-rl-defer");
      assert.equal(await runner.processNextJob("synthetic"), false);
    }
    const after10 = await readJob("ai-job-rl-defer");
    assert.equal(after10.status, "retry", "ten rate limits never strand the job");
    assert.equal(after10.attempt_count, 0);
    assert.equal(after10.last_failure_code, "rate_limited");
  });

  it("recognises a rate limit wrapped as an error cause and still defers", async () => {
    await enqueue("ai-job-rl-wrapped", "wrapped");
    const wrapped = new Error("Cannot connect to API: socket", {
      cause: new RateLimitedError({ retryAfterMs: 3_000, status: 429, bucket: "chat" }),
    });
    const runner = createJobRunner({
      executor: db.executor,
      agentOverrides: { interpreter: throwingAgent(() => wrapped), correlator: createMockCorrelatorAgent() },
    });
    assert.equal(await runner.processNextJob("synthetic"), false);
    const job = await readJob("ai-job-rl-wrapped");
    assert.equal(job.status, "retry");
    assert.equal(job.attempt_count, 0);
    assert.equal(job.last_failure_code, "rate_limited");
  });

  it("keeps the ordinary failure path: attempts count, and five failures reach needs_review", async () => {
    await enqueue("ai-job-rl-generic", "generic");
    const runner = createJobRunner({
      executor: db.executor,
      agentOverrides: {
        interpreter: throwingAgent(() => new Error("NineRouter 502 Bad Gateway")),
        correlator: createMockCorrelatorAgent(),
      },
    });
    for (let attempt = 1; attempt <= 4; attempt++) {
      assert.equal(await runner.processNextJob("synthetic"), false);
      const job = await readJob("ai-job-rl-generic");
      assert.equal(job.status, "retry");
      assert.equal(job.attempt_count, attempt);
      assert.equal(job.last_failure_code, "model_failed");
      await makeDue("ai-job-rl-generic");
    }
    assert.equal(await runner.processNextJob("synthetic"), false);
    const job = await readJob("ai-job-rl-generic");
    assert.equal(job.status, "needs_review");
    assert.equal(job.attempt_count, 5);
    assert.equal(job.last_failure_code, "model_failed");
  });

  it("a retry after a rate limit in correlation does not call the interpreter again", async () => {
    await enqueue("ai-job-rl-checkpoint", "checkpoint");
    const interpreterCalls = { calls: 0 };
    const correlator = createMockCorrelatorAgent();
    let correlatorCalls = 0;
    const limitedOnce: Agent = {
      generate: async (...args: unknown[]) => {
        correlatorCalls += 1;
        if (correlatorCalls === 1) {
          throw new RateLimitedError({ retryAfterMs: 2_000, status: 429, bucket: "chat" });
        }
        return (correlator as unknown as { generate: (...a: unknown[]) => Promise<unknown> }).generate(...args);
      },
    } as unknown as Agent;
    const runner = createJobRunner({
      executor: db.executor,
      agentOverrides: {
        interpreter: countingAgent(createMockInterpreterAgent(), interpreterCalls),
        correlator: limitedOnce,
      },
    });

    assert.equal(await runner.processNextJob("synthetic"), false, "first attempt is rate limited in correlation");
    assert.equal(interpreterCalls.calls, 1);
    const deferred = await readJob("ai-job-rl-checkpoint");
    assert.equal(deferred.status, "retry");
    assert.ok(deferred.checkpoint_json !== null, "the interpretation checkpoint is kept while the job waits");

    await makeDue("ai-job-rl-checkpoint");
    assert.equal(await runner.processNextJob("synthetic"), true, "second attempt completes");
    assert.equal(interpreterCalls.calls, 1, "the interpretation model was not called again");
    assert.equal(correlatorCalls, 2);

    const completed = await readJob("ai-job-rl-checkpoint");
    assert.equal(completed.status, "completed");
    assert.equal(completed.checkpoint_json, null, "completion clears the checkpoint");
  });

  describe("embedding reuse", () => {
    it("does not call the gateway again for a chunk whose vector is already stored", async () => {
      const chunkText = "Genangan air setinggi 30 cm di Jalan Kemang Raya.";
      const { traceId, revisionId } = await seedRevision("embed", chunkText);
      const chunkId = `chk-${revisionId}-0`;
      const codePoints = Array.from(chunkText).length;
      await db.executor.query(
        `INSERT INTO waspada.evidence_chunks
           (dataset_kind, chunk_id, trace_id, report_revision_id, permitted_text_hash,
            span_start, span_end, offset_unit, chunker_version, chunk_text_hash, status)
         VALUES ('synthetic', $1, $2, $3, $4, 0, $5, 'unicode_code_points', 'v1', $4, 'active')
         ON CONFLICT (dataset_kind, chunk_id) DO NOTHING`,
        [chunkId, traceId, revisionId, sha256(chunkText), codePoints],
      );

      const gatewayVector = Array.from({ length: NINEROUTER_EMBEDDING_IDENTITY.dimensions }, (_, i) => (i % 7) / 10);
      const seenBodies: string[] = [];
      const originalFetch = globalThis.fetch;
      globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
        seenBodies.push(String(init?.body ?? ""));
        return new Response(JSON.stringify({ data: [{ embedding: gatewayVector }] }), { status: 200 });
      }) as typeof fetch;
      // Unpaced gate so the test does not wait on the real embedding RPM.
      setNineRouterRateGate(createNineRouterRateGate({ clock: { now: () => Date.now(), sleep: async () => {} }, log: () => {} }));
      const liveConfig: NineRouterConfig = {
        baseUrl: "http://nr.test",
        apiKey: "test-key",
        chatModel: "Waspada-Jakarta",
        embeddingModel: NINEROUTER_EMBEDDING_IDENTITY.modelVersion,
        embeddingDimensions: NINEROUTER_EMBEDDING_IDENTITY.dimensions,
        executionMode: "live",
      };
      try {
        const service = createSemanticRetrievalService({
          executor: db.executor,
          transactionalExecutor: db.executor,
          config: liveConfig,
        });
        const first = await service.generateAndPersistEmbedding({
          traceId,
          datasetKind: "synthetic",
          chunkId,
          chunkText,
        });
        assert.equal(first.length, NINEROUTER_EMBEDDING_IDENTITY.dimensions);
        assert.equal(seenBodies.length, 1, "first attempt calls the gateway once");

        const second = await service.generateAndPersistEmbedding({
          traceId,
          datasetKind: "synthetic",
          chunkId,
          chunkText,
        });
        assert.equal(seenBodies.length, 1, "a retry reuses the stored vector without a gateway call");
        assert.equal(second.length, NINEROUTER_EMBEDDING_IDENTITY.dimensions);
        assert.ok(Math.abs(second[3]! - gatewayVector[3]!) < 1e-5, "reused vector matches the stored one");
      } finally {
        globalThis.fetch = originalFetch;
        setNineRouterRateGate(undefined);
      }
    });

    it("re-embeds when the chunk text changed under the same chunk id", async () => {
      const chunkText = "Pohon tumbang di Jalan Sudirman.";
      const { traceId, revisionId } = await seedRevision("embed-changed", chunkText);
      const chunkId = `chk-${revisionId}-0`;
      await db.executor.query(
        `INSERT INTO waspada.evidence_chunks
           (dataset_kind, chunk_id, trace_id, report_revision_id, permitted_text_hash,
            span_start, span_end, offset_unit, chunker_version, chunk_text_hash, status)
         VALUES ('synthetic', $1, $2, $3, $4, 0, $5, 'unicode_code_points', 'v1', $4, 'active')
         ON CONFLICT (dataset_kind, chunk_id) DO NOTHING`,
        [chunkId, traceId, revisionId, sha256(chunkText), Array.from(chunkText).length],
      );
      const vector = Array.from({ length: NINEROUTER_EMBEDDING_IDENTITY.dimensions }, () => 0.25);
      let calls = 0;
      const originalFetch = globalThis.fetch;
      globalThis.fetch = (async () => {
        calls += 1;
        return new Response(JSON.stringify({ data: [{ embedding: vector }] }), { status: 200 });
      }) as typeof fetch;
      setNineRouterRateGate(createNineRouterRateGate({ clock: { now: () => Date.now(), sleep: async () => {} }, log: () => {} }));
      try {
        const service = createSemanticRetrievalService({
          executor: db.executor,
          transactionalExecutor: db.executor,
          config: {
            baseUrl: "http://nr.test",
            apiKey: "test-key",
            chatModel: "Waspada-Jakarta",
            embeddingModel: NINEROUTER_EMBEDDING_IDENTITY.modelVersion,
            embeddingDimensions: NINEROUTER_EMBEDDING_IDENTITY.dimensions,
            executionMode: "live",
          },
        });
        await service.generateAndPersistEmbedding({ traceId, datasetKind: "synthetic", chunkId, chunkText: "teks lain" });
        assert.equal(calls, 1, "a different text hash is not a stored match");
      } finally {
        globalThis.fetch = originalFetch;
        setNineRouterRateGate(undefined);
      }
    });
  });
});
