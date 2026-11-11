// INTEL-02 B4: DB evidence retrieval defaults follow the shared policy (16 rows scanned, 8 returned).
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createSqlEvidenceRetrievalRepository } from "../src/evidence-retrieval.js";
import { RETRIEVAL_MAX_ROWS_EXAMINED, RETRIEVAL_MAX_RESULTS } from "../src/retrieval-limits.js";
import type { SqlExecutor } from "../src/sql.js";

describe("INTEL-02 DB retrieval defaults", () => {
  it("default scan is 16 rows (the query fetches one extra row to detect truncation)", async () => {
    const calls: unknown[][] = [];
    const executor: SqlExecutor = {
      async query<Row extends object>(_sql: string, params?: readonly unknown[]) {
        calls.push([...(params ?? [])]);
        return { rows: [] as readonly Row[] };
      },
      async execute() {},
    };
    const repo = createSqlEvidenceRetrievalRepository(executor);
    const result = await repo.search({
      datasetKind: "synthetic",
      identifiers: [{ kind: "candidate", value: "candidate-default-caps" }],
    });
    assert.equal(RETRIEVAL_MAX_ROWS_EXAMINED, 16);
    assert.equal(RETRIEVAL_MAX_RESULTS, 8);
    assert.equal(calls[0]?.[2], 16, "the scan cap parameter is 16");
    assert.equal(calls[0]?.[1], 17, "one extra row detects truncation");
    assert.equal(result.candidates.length, 0);
  });
});
