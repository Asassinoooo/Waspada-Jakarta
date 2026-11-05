import assert from "node:assert/strict";
import test from "node:test";
import {
  cosineDistance,
  cosineSimilarity,
  dotProduct,
  findNearestNeighbors,
  projectEmbeddingsTo3D,
  vectorNorm,
  type EmbeddingInputRecord,
} from "../src/embedding-pca.js";

test("vector math: dotProduct, vectorNorm, cosineSimilarity, and cosineDistance", () => {
  const v1 = [1, 0, 0];
  const v2 = [0, 1, 0];
  const v3 = [2, 0, 0];
  const vOpp = [-1, 0, 0];

  assert.equal(dotProduct(v1, v2), 0);
  assert.equal(dotProduct(v1, v3), 2);
  assert.equal(vectorNorm(v3), 2);

  // Orthogonal
  assert.equal(cosineSimilarity(v1, v2), 0);
  assert.equal(cosineDistance(v1, v2), 1);

  // Collinear (same direction)
  assert.equal(cosineSimilarity(v1, v3), 1);
  assert.equal(cosineDistance(v1, v3), 0);

  // Opposite direction
  assert.equal(cosineSimilarity(v1, vOpp), -1);
  assert.equal(cosineDistance(v1, vOpp), 2);

  // Zero vector edge case
  assert.equal(cosineSimilarity([0, 0], [1, 2]), 0);
});

test("findNearestNeighbors returns sorted nearest neighbors by cosine similarity", () => {
  const points = [
    {
      id: "p0",
      originalVector: [1, 0, 0],
      x: 0,
      y: 0,
      z: 0,
      sourceId: "src-1",
      title: "Title 0",
      chunkText: "Chunk 0",
      createdAt: "2026-11-05T00:00:00Z",
    },
    {
      id: "p1",
      originalVector: [0.99, 0.01, 0],
      x: 1,
      y: 0,
      z: 0,
      sourceId: "src-1",
      title: "Title 1",
      chunkText: "Chunk 1",
      createdAt: "2026-11-05T00:00:00Z",
    },
    {
      id: "p2",
      originalVector: [0, 1, 0],
      x: 0,
      y: 1,
      z: 0,
      sourceId: "src-2",
      title: "Title 2",
      chunkText: "Chunk 2",
      createdAt: "2026-11-05T00:00:00Z",
    },
  ];

  const neighbors = findNearestNeighbors(0, points, 2);
  assert.equal(neighbors.length, 2);
  // Closest is p1
  assert.equal(neighbors[0].point.id, "p1");
  assert.ok(neighbors[0].cosineSimilarity > 0.95);
  // Second closest is p2
  assert.equal(neighbors[1].point.id, "p2");
});

test("projectEmbeddingsTo3D handles boundary cases: 0, 1, and 2 items", () => {
  const resEmpty = projectEmbeddingsTo3D([]);
  assert.equal(resEmpty.points.length, 0);
  assert.deepEqual(resEmpty.varianceExplained, [0, 0, 0]);

  const single: EmbeddingInputRecord = {
    id: "s1",
    vector: [1, 2, 3],
    sourceId: "source-bmkg",
    title: "Gempa",
    chunkText: "M5.7",
    createdAt: "2026-11-05T00:00:00Z",
  };
  const resSingle = projectEmbeddingsTo3D([single]);
  assert.equal(resSingle.points.length, 1);
  assert.equal(resSingle.points[0].x, 0);
  assert.equal(resSingle.points[0].y, 0);
  assert.equal(resSingle.points[0].z, 0);

  const two: EmbeddingInputRecord[] = [
    single,
    { ...single, id: "s2", vector: [4, 5, 6] },
  ];
  const resTwo = projectEmbeddingsTo3D(two, 10);
  assert.equal(resTwo.points.length, 2);
  assert.equal(resTwo.points[0].x, -5);
  assert.equal(resTwo.points[1].x, 5);
});

test("projectEmbeddingsTo3D projects high-dimensional vectors and centers them", () => {
  // Generate 20 synthetic 768-dimensional vectors
  const items: EmbeddingInputRecord[] = [];
  const dims = 768;

  for (let i = 0; i < 20; i++) {
    const vec: number[] = new Array(dims);
    for (let d = 0; d < dims; d++) {
      // Deterministic synthetic signal with higher variance in first few dims
      vec[d] = Math.sin((i + 1) * (d + 1)) * (d < 10 ? 5 : 0.5);
    }
    items.push({
      id: `item-${i}`,
      vector: vec,
      sourceId: i % 2 === 0 ? "source-antara" : "source-detik",
      title: `News Item ${i}`,
      chunkText: `Teks berita ke-${i}`,
      createdAt: "2026-11-05T00:00:00Z",
    });
  }

  const result = projectEmbeddingsTo3D(items, 12);
  assert.equal(result.points.length, 20);

  // Verify coordinates are finite and bounded within targetExtent
  for (const pt of result.points) {
    assert.ok(Number.isFinite(pt.x));
    assert.ok(Number.isFinite(pt.y));
    assert.ok(Number.isFinite(pt.z));
    assert.ok(Math.abs(pt.x) <= 12.01);
    assert.ok(Math.abs(pt.y) <= 12.01);
    assert.ok(Math.abs(pt.z) <= 12.01);
  }

  // Verify centering: sum of coordinates should be close to 0
  let meanX = 0;
  let meanY = 0;
  let meanZ = 0;
  for (const pt of result.points) {
    meanX += pt.x;
    meanY += pt.y;
    meanZ += pt.z;
  }
  meanX /= items.length;
  meanY /= items.length;
  meanZ /= items.length;

  assert.ok(Math.abs(meanX) < 0.05, `meanX ${meanX} should be close to 0`);
  assert.ok(Math.abs(meanY) < 0.05, `meanY ${meanY} should be close to 0`);
  assert.ok(Math.abs(meanZ) < 0.05, `meanZ ${meanZ} should be close to 0`);

  // Verify variance explained ordering
  const [pc1, pc2, pc3] = result.varianceExplained;
  assert.ok(pc1 >= pc2, `PC1 (${pc1}) should be >= PC2 (${pc2})`);
  assert.ok(pc2 >= pc3, `PC2 (${pc2}) should be >= PC3 (${pc3})`);
  assert.ok(result.totalVarianceRatio <= 100);
});


test("projectEmbeddingsTo3D separates distinct geometric clusters in 3D space", () => {
  // Create two distinct high-dimensional clusters
  // Cluster A: points centered around [+1, +1, ... +1]
  // Cluster B: points centered around [-1, -1, ... -1]
  const dims = 768;
  const items: EmbeddingInputRecord[] = [];

  for (let i = 0; i < 6; i++) {
    const vecA: number[] = new Array(dims);
    const vecB: number[] = new Array(dims);
    for (let d = 0; d < dims; d++) {
      vecA[d] = 1.0 + Math.sin(i * 13 + d) * 0.1;
      vecB[d] = -1.0 + Math.sin(i * 17 + d) * 0.1;
    }
    items.push({
      id: `clusterA-${i}`,
      vector: vecA,
      sourceId: "source-cluster-a",
      title: `A ${i}`,
      chunkText: `Cluster A text ${i}`,
      createdAt: "2026-11-05T00:00:00Z",
    });
    items.push({
      id: `clusterB-${i}`,
      vector: vecB,
      sourceId: "source-cluster-b",
      title: `B ${i}`,
      chunkText: `Cluster B text ${i}`,
      createdAt: "2026-11-05T00:00:00Z",
    });
  }

  const res = projectEmbeddingsTo3D(items, 15);
  assert.equal(res.points.length, 12);

  const ptsA = res.points.filter((p) => p.sourceId === "source-cluster-a");
  const ptsB = res.points.filter((p) => p.sourceId === "source-cluster-b");

  const meanX_A = ptsA.reduce((acc, p) => acc + p.x, 0) / ptsA.length;
  const meanX_B = ptsB.reduce((acc, p) => acc + p.x, 0) / ptsB.length;

  // The primary component (X axis) must strongly separate the two clusters with opposing signs
  assert.ok(
    (meanX_A > 0 && meanX_B < 0) || (meanX_A < 0 && meanX_B > 0),
    `meanX_A (${meanX_A}) and meanX_B (${meanX_B}) should have opposing signs`,
  );
  assert.ok(Math.abs(meanX_A - meanX_B) > 10, "Cluster separation distance should be substantial");
});