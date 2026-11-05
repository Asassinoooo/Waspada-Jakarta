import assert from "node:assert/strict";
import test from "node:test";
import worker from "../src/index.js";
import {
  createEmbeddingVisualizationHandler,
  generateSyntheticEmbeddingDataset,
} from "../src/layers/l4-application-integration/embedding-visualization-handler.js";
import type { SqlExecutor } from "../../db/src/sql.js";

const origin = "http://localhost";
const path = "/api/v1/embeddings/visualization";

test("synthetic dataset generator produces valid 768D normalized embeddings", () => {
  const dataset = generateSyntheticEmbeddingDataset(768);
  assert.ok(dataset.length >= 15);
  for (const item of dataset) {
    assert.equal(item.vector.length, 768);
    assert.ok(item.title.length > 0);
    assert.ok(item.chunkText.length > 0);
    assert.ok(item.sourceId.startsWith("source-"));
    let normSq = 0;
    for (const v of item.vector) {
      assert.ok(Number.isFinite(v));
      normSq += v * v;
    }
    // Normalized to unit sphere within float rounding
    assert.ok(Math.abs(Math.sqrt(normSq) - 1.0) < 0.05);
  }
});

test("GET /api/v1/embeddings/visualization returns synthetic fallback when no DB configured", async () => {
  const req = new Request(origin + path);
  const res = await worker.fetch(req, {});

  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "application/json; charset=utf-8");
  assert.equal(res.headers.get("access-control-allow-origin"), "*");

  const data = await res.json() as {
    total: number;
    dimensions: number;
    datasetKind: string;
    items: Array<{
      embeddingRunId: string;
      chunkId: string;
      sourceId: string;
      title: string;
      chunkText: string;
      vector: number[];
    }>;
  };

  assert.equal(data.dimensions, 768);
  assert.ok(data.total >= 15);
  assert.ok(data.items.length >= 15);
  assert.equal(data.items[0].vector.length, 768);
});

test("GET /api/v1/embeddings/visualization respects limit query parameter", async () => {
  const req = new Request(origin + path + "?limit=5");
  const res = await worker.fetch(req, {});
  assert.equal(res.status, 200);

  const data = await res.json() as { items: unknown[] };
  assert.equal(data.items.length, 5);
});

test("OPTIONS and method validation on /api/v1/embeddings/visualization", async () => {
  const optionsRes = await worker.fetch(new Request(origin + path, { method: "OPTIONS" }), {});
  assert.equal(optionsRes.status, 204);

  const postRes = await worker.fetch(new Request(origin + path, { method: "POST" }), {});
  assert.equal(postRes.status, 405);
  assert.equal(postRes.headers.get("allow"), "GET, OPTIONS");
});

test("createEmbeddingVisualizationHandler queries SQL executor when available", async () => {
  const mockRows = [
    {
      embedding_run_id: "emb-test-1",
      chunk_id: "chk-test-1",
      dimensions: 768,
      created_at: "2026-11-05T08:00:00.000Z",
      report_revision_id: "rep-test-1",
      span_start: 0,
      span_end: 25,
      source_id: "source-antara-metro",
      canonical_url: "https://example.org/news/1",
      chunk_text: "Uji coba teks potongan 1",
      title: "Judul Berita 1",
      vector_str: "[-0.01, 0.05, 0.12]",
    },
  ];

  let queryCalled = false;
  let queryParams: unknown[] = [];
  const mockExecutor: SqlExecutor = {
    query: async <T>(_sql: string, params?: unknown[]) => {
      queryCalled = true;
      queryParams = params ?? [];
      return { rows: mockRows as unknown as readonly T[] };
    },
    execute: async () => {},
  };

  const handler = createEmbeddingVisualizationHandler();
  const req = new Request("http://localhost/api/v1/embeddings/visualization?limit=10&dataset_kind=live");
  const res = await handler(req, { SQL_EXECUTOR: mockExecutor, DATASET_MODE: "live" });

  assert.equal(res.status, 200);
  assert.ok(queryCalled);
  assert.deepEqual(queryParams, ["live", 10]);

  const data = await res.json() as {
    total: number;
    dimensions: number;
    items: Array<{ embeddingRunId: string; chunkText: string; vector: number[] }>;
  };
  assert.equal(data.total, 1);
  assert.equal(data.items[0].embeddingRunId, "emb-test-1");
  assert.equal(data.items[0].chunkText, "Uji coba teks potongan 1");
  assert.deepEqual(data.items[0].vector, [-0.01, 0.05, 0.12]);
});
