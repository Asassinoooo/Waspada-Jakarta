// INTEL-02 B4: one retrieval policy (scan at most 16 rows, return at most 8). Fake executor only.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { SqlExecutor } from "../../db/src/sql.js";
import { RETRIEVAL_MAX_ROWS_EXAMINED, RETRIEVAL_MAX_RESULTS } from "../../db/src/retrieval-limits.js";
import { createSemanticRetrievalService } from "../src/services/semantic-retrieval-service.js";
import { generateMockVector } from "../src/providers/ninerouter-adapter.js";

interface Call { readonly sql: string; readonly params: readonly unknown[] }

function recordingExecutor(answer: (sql: string) => readonly object[]): { executor: SqlExecutor; calls: Call[] } {
  const calls: Call[] = [];
  const executor: SqlExecutor = {
    async query<Row extends object>(sql: string, params?: readonly unknown[]) {
      calls.push({ sql, params: params ?? [] });
      return { rows: answer(sql) as readonly Row[] };
    },
    async execute() {},
  };
  return { executor, calls };
}

const DIRECT_MARKER = "(v.embedding <=> $1::vector) AS cosine_distance";
const LEXICAL_MARKER = "ORDER BY i.last_updated_at DESC";

function directRow(index: number) {
  const iso = "2026-11-11T07:00:00.000Z";
  return {
    incident_id: `inc-direct-${index}`,
    dataset_kind: "synthetic",
    title: `Banjir ${index}`,
    description: "Banjir di Jalan Mampang Prapatan",
    incident_type: "banjir",
    primary_category: "disasters_weather",
    status: "active",
    severity: "unknown",
    location_label: "Jalan Mampang Prapatan",
    shape_geojson: null,
    event_time: {},
    first_observed_at: iso,
    last_updated_at: iso,
    discrepancies: [],
    uncertainty_notes: [],
    record_json: {},
    created_at: iso,
    chunk_id: `chk-direct-${index}`,
    report_revision_id: `rev-direct-${index}`,
    span_text: "Banjir",
    cosine_distance: 0.1 + index * 0.001,
    similarity_score: 0.9 - index * 0.001,
  };
}

function lexicalRow(index: number) {
  const iso = "2026-11-11T07:00:00.000Z";
  return {
    incident_id: `inc-lex-${index}`,
    dataset_kind: "synthetic",
    title: `Banjir jalan Mampang ${index}`,
    description: "genangan air jalan",
    incident_type: "banjir",
    primary_category: "disasters_weather",
    status: "active",
    severity: "unknown",
    location_label: "Mampang",
    shape_geojson: null,
    event_time: {},
    first_observed_at: iso,
    last_updated_at: iso,
    discrepancies: [],
    uncertainty_notes: [],
    record_json: {},
    created_at: iso,
  };
}

const QUERY_TEXT = "banjir genangan jalan mampang prapatan";
const QUERY_VECTOR = generateMockVector(QUERY_TEXT);

describe("INTEL-02 retrieval caps (shared policy)", () => {
  it("the shared policy constants are 16 rows scanned and 8 returned", () => {
    assert.equal(RETRIEVAL_MAX_ROWS_EXAMINED, 16);
    assert.equal(RETRIEVAL_MAX_RESULTS, 8);
  });

  it("the direct vector query scans at most 16 rows", async () => {
    const { executor, calls } = recordingExecutor((sql) => (sql.includes(DIRECT_MARKER) ? Array.from({ length: 40 }, (_, i) => directRow(i)) : []));
    const service = createSemanticRetrievalService({ executor });
    await service.retrieveCandidates({ datasetKind: "synthetic", queryText: QUERY_TEXT, queryVector: QUERY_VECTOR });
    const direct = calls.find((call) => call.sql.includes(DIRECT_MARKER));
    assert.ok(direct, "the direct query ran");
    assert.equal(direct.params[3], 16, "the LIMIT parameter is the scan cap");
  });

  it("returns at most 8 candidate incidents even when more are found or more are requested", async () => {
    const { executor } = recordingExecutor((sql) => (sql.includes(DIRECT_MARKER) ? Array.from({ length: 16 }, (_, i) => directRow(i)) : []));
    const service = createSemanticRetrievalService({ executor });
    const byDefault = await service.retrieveCandidates({ datasetKind: "synthetic", queryText: QUERY_TEXT, queryVector: QUERY_VECTOR });
    assert.equal(byDefault.candidateIncidents.length, 8);
    const requestedMore = await service.retrieveCandidates({ datasetKind: "synthetic", queryText: QUERY_TEXT, queryVector: QUERY_VECTOR, maxResults: 50 });
    assert.equal(requestedMore.candidateIncidents.length, 8, "a caller cannot raise the return cap");
    const sorted = requestedMore.candidateIncidents.map((match) => match.similarityScore);
    assert.deepEqual(sorted, [...sorted].sort((a, b) => b - a), "the best matches come first");
  });

  it("the lexical fallback scans at most 16 incidents and returns at most 8", async () => {
    const { executor, calls } = recordingExecutor((sql) => (sql.includes(LEXICAL_MARKER) ? Array.from({ length: 30 }, (_, i) => lexicalRow(i)) : []));
    const service = createSemanticRetrievalService({ executor });
    const result = await service.retrieveCandidates({ datasetKind: "synthetic", queryText: QUERY_TEXT, queryVector: QUERY_VECTOR });
    const lexical = calls.find((call) => call.sql.includes(LEXICAL_MARKER));
    assert.ok(lexical, "the lexical fallback ran");
    assert.equal(lexical.params[1], 16);
    assert.equal(result.candidateIncidents.length, 8);
  });

  it("with nothing qualifying it fails closed to no candidates, not an error", async () => {
    const { executor } = recordingExecutor(() => []);
    const service = createSemanticRetrievalService({ executor });
    const result = await service.retrieveCandidates({ datasetKind: "synthetic", queryText: QUERY_TEXT, queryVector: QUERY_VECTOR });
    assert.deepEqual(result.candidateIncidents, []);
  });
});
