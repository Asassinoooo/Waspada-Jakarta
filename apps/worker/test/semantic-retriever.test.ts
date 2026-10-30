import assert from "node:assert/strict";
import test from "node:test";
import {
  cosineSimilarity,
  generateDeterministicTextVector,
  InMemorySemanticRetriever,
} from "../src/layers/l1-data-knowledge/semantic-retriever.js";

test("cosineSimilarity returns 1.0 for identical vectors and 0.0 for orthogonal vectors", () => {
  const v1 = [1, 0, 0];
  const v2 = [1, 0, 0];
  const v3 = [0, 1, 0];

  assert.equal(Math.round(cosineSimilarity(v1, v2) * 100) / 100, 1);
  assert.equal(cosineSimilarity(v1, v3), 0);
  assert.equal(cosineSimilarity([], []), 0);
});

test("generateDeterministicTextVector produces higher cosine similarity for semantically related texts than unrelated texts", () => {
  const floodA = "Banjir merendam kawasan Kemang Raya Jakarta Selatan setinggi 60 cm";
  const floodB = "Genangan air 60 sentimeter di Kemang Jaksel sebabkan lalu lintas terganggu";
  const fireC = "Kebakaran hebat hanguskan puluhan kios pasar di Senen Jakarta Pusat";

  const vecA = generateDeterministicTextVector(floodA);
  const vecB = generateDeterministicTextVector(floodB);
  const vecC = generateDeterministicTextVector(fireC);

  const simRelated = cosineSimilarity(vecA, vecB);
  const simUnrelated = cosineSimilarity(vecA, vecC);

  assert.ok(
    simRelated > simUnrelated,
    `Expected related similarity (${simRelated.toFixed(3)}) > unrelated similarity (${simUnrelated.toFixed(3)})`,
  );
  assert.ok(simRelated > 0.4, `Expected simRelated > 0.4, got ${simRelated}`);
});

test("InMemorySemanticRetriever retrieves candidate matches with ranked similarity and distance", async () => {
  interface MockReport {
    id: string;
    text: string;
    coords: [number, number];
    time: string;
  }

  const reports: MockReport[] = [
    {
      id: "rep-1",
      text: "Banjir di Kemang Raya Jakarta Selatan setinggi 50 cm",
      coords: [106.815, -6.265],
      time: "2026-10-30T08:00:00Z",
    },
    {
      id: "rep-2",
      text: "Kebakaran ruko di Pasar Senen Jakarta Pusat",
      coords: [106.844, -6.182],
      time: "2026-10-30T08:15:00Z",
    },
    {
      id: "rep-3",
      text: "Genangan air di Jalan Kemang mengakibatkan kemacetan kendaraan",
      coords: [106.816, -6.266],
      time: "2026-10-30T08:30:00Z",
    },
  ];

  const retriever = new InMemorySemanticRetriever<MockReport>(
    {
      getText: (r) => r.text,
      getCoordinates: (r) => r.coords,
      getTimestamp: (r) => r.time,
    },
    reports,
  );

  const results = await retriever.retrieveCandidates({
    queryText: "Genangan 60 cm di Kemang Raya",
    coordinates: [106.815, -6.265],
    timestamp: "2026-10-30T08:45:00Z",
  });

  assert.ok(results.length >= 2);
  // Top candidates should be the Kemang reports (rep-1 or rep-3)
  const topIds = results.slice(0, 2).map((m) => m.item.id);
  assert.ok(topIds.includes("rep-1"));
  assert.ok(topIds.includes("rep-3"));
  assert.ok(!topIds.includes("rep-2")); // Senen fire should not be top ranked
});
