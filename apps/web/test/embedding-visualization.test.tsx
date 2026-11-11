import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { routeFromHash } from "../src/App.js";
import { Embedding3DVisualization } from "../src/Embedding3DVisualization.js";
import {
  fetchEmbeddingVisualizationData,
  EmbeddingClientError,
} from "../src/embedding-client.js";
import { moderatorAccessMessage } from "../src/account-messages.js";

test("routeFromHash maps #visualisasi-3d and #embedding-3d to embedding-3d screen", () => {
  assert.deepEqual(routeFromHash("#visualisasi-3d"), { screen: "embedding-3d" });
  assert.deepEqual(routeFromHash("#embedding-3d"), { screen: "embedding-3d" });
});

test("fetchEmbeddingVisualizationData handles valid and error responses", async () => {
  const originalFetch = globalThis.fetch;

  try {
    // Test 1: Successful fetch
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          total: 2,
          dimensions: 768,
          datasetKind: "live",
          items: [
            {
              embeddingRunId: "emb-1",
              chunkId: "chk-1",
              reportRevisionId: "rep-1",
              sourceId: "source-antara-metro",
              canonicalUrl: "https://example.com/1",
              title: "Judul 1",
              chunkText: "Teks 1",
              createdAt: "2026-11-05T00:00:00Z",
              vector: [0.1, 0.2, 0.3],
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );

    const payload = await fetchEmbeddingVisualizationData({ limit: 10 });
    assert.equal(payload.total, 1);
    assert.equal(payload.dimensions, 768);
    assert.equal(payload.datasetKind, "live");
    assert.equal(payload.items.length, 1);
    assert.deepEqual(payload.items[0].vector, [0.1, 0.2, 0.3]);

    // Test 2: HTTP 500 error
    globalThis.fetch = async () =>
      new Response("Internal Server Error", { status: 500 });

    await assert.rejects(
      async () => fetchEmbeddingVisualizationData(),
      (err: unknown) => err instanceof EmbeddingClientError && err.status === 500,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Embedding3DVisualization renders static markup cleanly without WebGL crash", () => {
  const markup = renderToStaticMarkup(createElement(Embedding3DVisualization));

  assert.ok(markup.includes("Visualisasi 3D Embedding Chunk"));
  assert.ok(markup.includes("PCA 768D → 3D"));
  assert.ok(markup.includes("Pencarian chunk teks"));
  assert.ok(markup.includes("Putar Otomatis"));
  assert.ok(markup.includes("Garis Klaster"));
  assert.ok(markup.includes("Reset Kamera"));
  assert.ok(markup.includes("Daftar Vektor Chunk Terproyeksi"));
});

test("anonymous or non-moderator embedding requests map to moderator copy instead of a transport error", async () => {
  const originalFetch = globalThis.fetch;
  try {
    for (const status of [401, 403]) {
      globalThis.fetch = async () => new Response("{}", { status, headers: { "content-type": "application/json" } });
      await assert.rejects(
        async () => fetchEmbeddingVisualizationData({ limit: 1 }),
        (err: unknown) => err instanceof EmbeddingClientError && err.status === status && moderatorAccessMessage(err.status) !== null,
      );
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});
