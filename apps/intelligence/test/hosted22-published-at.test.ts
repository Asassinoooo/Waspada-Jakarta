import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { Agent } from "@mastra/core/agent";
import { createTestDatabase, type TestDatabase } from "../../db/test/harness.js";
import { applyMigrations, readMigrations } from "../../db/src/migrations.js";
import { createSqlIncidentRepository } from "../../db/src/incident-repository.js";
import { createJobRunner } from "../src/job-runner.js";
import { createMockInterpreterAgent } from "./mock-agents.js";

// HOSTED-22 (owner rule F-14): the interpreter's "Published At" is the revision's own publish time. A revision with no
// publish time gives "Not specified", never its retrieval time. Real job runner over PGlite; the model is a capturing mock.

const RETRIEVED_AT = "2026-11-10T08:00:00.000Z";
const PUBLISHED_AT = "2026-11-09T05:30:00.000Z";
const UNDATED_TEXT = "Laporan sintetis tanpa waktu terbit untuk uji HOSTED-22 di Kebayoran Baru.";
const DATED_TEXT = "Laporan sintetis dengan waktu terbit untuk uji HOSTED-22 di Tebet.";

function capturingInterpreter(prompts: string[]): Agent {
  const base = createMockInterpreterAgent() as unknown as { generate: (...args: unknown[]) => Promise<unknown> };
  return {
    generate: async (...args: unknown[]) => {
      prompts.push(String(args[0]));
      return base.generate(...args);
    },
  } as unknown as Agent;
}

describe("HOSTED-22 interpreter publish time", () => {
  let db: TestDatabase;
  /** Every prompt the interpreter received. Both tests read it, so each one can run alone or in order. */
  const prompts: string[] = [];

  /** Runs queued jobs until the interpreter has seen the report text, within a bounded number of attempts. */
  async function drainUntilInterpreted(text: string): Promise<string | undefined> {
    const runner = createJobRunner({
      executor: db.executor,
      agentOverrides: { interpreter: capturingInterpreter(prompts) },
    });
    for (let attempt = 0; attempt < 4 && !prompts.some((prompt) => prompt.includes(text)); attempt += 1) {
      await runner.processNextJob("synthetic");
    }
    return prompts.find((prompt) => prompt.includes(text));
  }

  before(async () => {
    db = await createTestDatabase();
    await applyMigrations(db.executor, await readMigrations(new URL("../../db/migrations/", import.meta.url)));
    await db.executor.execute(`
      INSERT INTO waspada.traces (trace_id, dataset_kind, started_at, outcome, metadata)
      VALUES ('trace-hosted22-interp', 'synthetic', now(), 'succeeded', '{}'::jsonb)
      ON CONFLICT (trace_id) DO NOTHING;

      INSERT INTO waspada.source_registry
        (source_id, trace_id, registry_version, display_name, source_kind, remit,
         access_method, approved_hosts, access_restrictions, reuse_basis, registry_status,
         approval_status, health_status, auto_acquisition_enabled, auto_publication_policy)
      VALUES ('source-hosted22-interp', 'trace-hosted22-interp', 1, 'Sumber Uji HOSTED-22', 'other', ARRAY['system'],
              'manual_fixture', ARRAY[]::text[], ARRAY[]::text[], ARRAY['public'], 'active', 'approved', 'healthy', false, 'never')
      ON CONFLICT (source_id) DO NOTHING;
    `);
    const dummyHash = "3333333333333333333333333333333333333333333333333333333333333333";
    const repo = createSqlIncidentRepository(db.executor);
    for (const [revisionId, text, publishedAt] of [
      ["rev-hosted22-undated", UNDATED_TEXT, null],
      ["rev-hosted22-dated", DATED_TEXT, PUBLISHED_AT],
    ] as const) {
      await db.executor.query(
        `INSERT INTO waspada.report_revisions
           (dataset_kind, report_revision_id, trace_id, source_id, canonical_url, content_hash, permitted_text,
            permitted_text_hash, normalization_version, published_at, retrieved_at, revision_status, record_json)
         VALUES ('synthetic', $1, 'trace-hosted22-interp', 'source-hosted22-interp', 'https://example.test/hosted22', $2, $3, $2,
                 'v1', $4::timestamptz, $5::timestamptz, 'unreviewed', '{}'::jsonb)
         ON CONFLICT (dataset_kind, report_revision_id) DO NOTHING`,
        [revisionId, dummyHash, text, publishedAt, RETRIEVED_AT],
      );
      await repo.enqueueAiJob({
        jobId: `ai-job-${revisionId}`,
        datasetKind: "synthetic",
        reportRevisionId: revisionId,
        traceId: "trace-hosted22-interp",
      });
    }
  });

  after(async () => {
    await db?.close();
  });

  it("gives the interpreter null for a revision with no publish time, and never its retrieval time", async () => {
    const undatedPrompt = await drainUntilInterpreted(UNDATED_TEXT);
    assert.ok(undatedPrompt, "the undated revision reached the interpreter");
    assert.match(undatedPrompt, /Published At: Not specified/u, "no publish time is shown");
    assert.doesNotMatch(undatedPrompt, /2026-11-10T08:00:00/u, "the retrieval time is never shown as a publish time");
  });

  it("gives the interpreter the revision's own publish time when the source gave one", async () => {
    const datedPrompt = await drainUntilInterpreted(DATED_TEXT);
    assert.ok(datedPrompt, "the dated revision reached the interpreter");
    assert.match(datedPrompt, /Published At: 2026-11-09T05:30:00\.000Z/u);
    assert.doesNotMatch(datedPrompt, /2026-11-10T08:00:00/u);
  });
});
