import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";
import {
  extractJsonFromText,
  generateMockVector,
  createNineRouterMastraAgent,
} from "../src/providers/ninerouter-adapter.js";
import {
  createSemanticRetrievalService,
  NINEROUTER_EMBEDDING_IDENTITY,
} from "../src/services/semantic-retrieval-service.js";
import { createTestDatabase, type TestDatabase } from "../../db/test/harness.js";
import { applyMigrations, readMigrations } from "../../db/src/migrations.js";

describe("NineRouter Adapter & Semantic Retrieval", () => {
  describe("Utility & Mock Functions", () => {
    it("generates deterministic 768-dim mock embeddings with unit norm", () => {
      const vec1 = generateMockVector("Banjir di Jakarta Selatan", 768);
      const vec2 = generateMockVector("Banjir di Jakarta Selatan", 768);
      const vec3 = generateMockVector("Kecelakaan di Tol Jagorawi", 768);

      assert.equal(vec1.length, 768);
      assert.deepEqual(vec1, vec2);
      assert.notDeepEqual(vec1, vec3);

      // Verify unit norm (within float rounding)
      let sumSq = 0;
      for (const val of vec1) sumSq += val * val;
      assert.ok(Math.abs(Math.sqrt(sumSq) - 1.0) < 1e-4);
    });

    it("extracts JSON from raw text and markdown codeblocks", () => {
      const raw = '{"city": "Jakarta", "depth": 50}';
      assert.deepEqual(extractJsonFromText(raw), { city: "Jakarta", depth: 50 });

      const markdown = '```json\n{"city": "Jakarta", "depth": 50}\n```';
      assert.deepEqual(extractJsonFromText(markdown), { city: "Jakarta", depth: 50 });

      const genericFence = '```\n{"city": "Jakarta", "depth": 50}\n```';
      assert.deepEqual(extractJsonFromText(genericFence), { city: "Jakarta", depth: 50 });
    });

    it("creates Mastra Agent configured for NineRouter", () => {
      const agent = createNineRouterMastraAgent({
        id: "test-agent",
        name: "Test Interpreter Agent",
        instructions: "Extract facts accurately",
      });

      assert.equal(agent.name, "Test Interpreter Agent");
      assert.ok(agent.id);
    });
  });

  describe("SemanticRetrievalService with PGlite", () => {
    let db: TestDatabase;

    before(async () => {
      db = await createTestDatabase();
      const migrations = await readMigrations(new URL("../../db/migrations/", import.meta.url));
      await applyMigrations(db.executor, migrations);
    });

    after(async () => {
      await db?.close();
    });

    it("generates embeddings and queries candidates using NINEROUTER_EMBEDDING_IDENTITY", async () => {
      const service = createSemanticRetrievalService({
        executor: db.executor,
      });

      assert.equal(NINEROUTER_EMBEDDING_IDENTITY.dimensions, 768);
      assert.equal(NINEROUTER_EMBEDDING_IDENTITY.distanceMetric, "cosine");

      const vector = await service.generateAndPersistEmbedding({
        traceId: "trace-test-embed",
        datasetKind: "synthetic",
        chunkId: "chunk-001",
        chunkText: "Genangan air setinggi 30 cm terjadi di Jalan Kemang Raya.",
      });

      assert.equal(vector.length, 768);

      const result = await service.retrieveCandidates({
        datasetKind: "synthetic",
        queryText: "Banjir di Kemang Jakarta Selatan",
        maxResults: 5,
      });

      assert.equal(result.queryVector.length, 768);
      assert.ok(Array.isArray(result.candidates));
      assert.ok(Array.isArray(result.candidateIncidents));
    });
  });
});
