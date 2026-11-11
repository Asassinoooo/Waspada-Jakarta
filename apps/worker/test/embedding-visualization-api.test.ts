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
    assert.equal("chunkText" in item, false, "synthetic items carry no chunk text");
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

test("the public Worker route requires a moderator session, so anonymous callers get no embedding data", async () => {
  // Without an account database the route answers 503, never the synthetic fallback.
  const unconfigured = await worker.fetch(new Request(origin + path), {});
  assert.equal(unconfigured.status, 503);
  // With accounts enabled but no session cookie, the route answers 401.
  const anonymous = await worker.fetch(new Request(origin + path), {
    AUTH_ENABLED: "true",
    AUTH_APP_ORIGIN: "http://127.0.0.1:5173",
    DATASET_MODE: "demo",
    SQL_EXECUTOR: {
      query: async () => { throw new Error("must not be reached without a cookie"); },
      execute: async () => {},
      transaction: async () => { throw new Error("must not be reached without a cookie"); },
    } as unknown as SqlExecutor,
  });
  assert.equal(anonymous.status, 401);
  assert.equal(anonymous.headers.get("access-control-allow-origin"), null);
});

test("the visualization handler falls back to synthetic items with no chunk text and no wildcard CORS", async () => {
  const handler = createEmbeddingVisualizationHandler();
  const res = await handler(new Request(origin + path), { DATASET_MODE: "demo" });

  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "application/json; charset=utf-8");
  assert.equal(res.headers.get("access-control-allow-origin"), null);

  const data = await res.json() as {
    total: number;
    dimensions: number;
    datasetKind: string;
    items: Array<{ embeddingRunId: string; chunkId: string; sourceId: string; title: string; vector: number[] }>;
  };
  assert.equal(data.dimensions, 768);
  assert.ok(data.total >= 15);
  assert.equal(data.items[0]?.vector.length, 768);
  for (const item of data.items) assert.equal("chunkText" in item, false);
});

test("the visualization handler respects the limit query parameter", async () => {
  const handler = createEmbeddingVisualizationHandler();
  const res = await handler(new Request(origin + path + "?limit=5"), { DATASET_MODE: "demo" });
  assert.equal(res.status, 200);

  const data = await res.json() as { items: unknown[] };
  assert.equal(data.items.length, 5);
});

test("OPTIONS and method validation on /api/v1/embeddings/visualization", async () => {
  const handler = createEmbeddingVisualizationHandler();
  const optionsRes = await handler(new Request(origin + path, { method: "OPTIONS" }), {});
  assert.equal(optionsRes.status, 204);

  const postRes = await handler(new Request(origin + path, { method: "POST" }), {});
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
  // The query string cannot choose the dataset: DATASET_MODE=live selects live, whatever is requested.
  const req = new Request("http://localhost/api/v1/embeddings/visualization?limit=10&dataset_kind=synthetic");
  const res = await handler(req, { SQL_EXECUTOR: mockExecutor, DATASET_MODE: "live" });

  assert.equal(res.status, 200);
  assert.ok(queryCalled);
  assert.deepEqual(queryParams, ["live", 10]);

  const data = await res.json() as {
    total: number;
    dimensions: number;
    items: Array<{ embeddingRunId: string; vector: number[] }>;
  };
  assert.equal(data.total, 1);
  assert.equal(data.items[0].embeddingRunId, "emb-test-1");
  assert.equal("chunkText" in data.items[0], false, "chunk text never leaves the server");
  assert.deepEqual(data.items[0].vector, [-0.01, 0.05, 0.12]);
});
