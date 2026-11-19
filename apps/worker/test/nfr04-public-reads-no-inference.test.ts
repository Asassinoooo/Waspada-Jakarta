import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import worker from "../src/index.js";
import {
  AGENT_AUTO_PUBLISHER_ID,
  decideProposal,
  type ProposalDecisionDependencies,
} from "../src/layers/l4-application-integration/proposal-publication.js";
import { createTestDatabase, type TestDatabase } from "../../db/test/harness.js";
import { seedProposalLineage, type ProposalLineage } from "../../db/test/proposal-lineage-fixture.js";
import { applyMigrations, readMigrations } from "../../db/src/migrations.js";
import { createEventProposalWriter, type EventProposalDto } from "../../db/src/event-proposal-writer.js";
import type { SqlExecutor, TransactionalSqlExecutor } from "../../db/src/sql.js";

/**
 * NFR-04 (SOFTWARE_DEVELOPMENT_PLAN §3): public reads never wait for source acquisition or model inference.
 *
 * The Worker runs in live mode with every model, acquisition and dispatch binding configured, so an inference or
 * acquisition call would be reachable. Global fetch is replaced by a stub that records the target and throws, and
 * every SQL statement is recorded. The public reads go through the real fetch handler. Afterwards, no outbound call
 * and no SQL that touches acquisition, inference or a write may have happened.
 *
 * Offline limit: /api/v1/updates and POST /api/v1/briefings need a Postgres connection through Hyperdrive. No such
 * connection can run here, so they are checked to fail closed (503) with no call. Their 2xx paths are covered by the
 * runtime tests with an injected executor. The other public reads are served from the published read model.
 */

const origin = "http://127.0.0.1:5173";
const LINEAGE_KEY = "nfr04";
const EVENT_ID = "inc-nfr04-pub";
/** Acquisition, inference and write statements. A public read must send none of them. */
const ACQUISITION_OR_INFERENCE_SQL = /\b(ai_jobs|acquisition_jobs|news_triage_\w+|embedding_runs|embedding_vectors|evidence_chunks|report_revisions|source_registry)\b|\b(INSERT|UPDATE|DELETE)\b/iu;

function proposalFor(incidentId: string, lineage: ProposalLineage): EventProposalDto {
  return {
    schema_version: "2.0",
    ...lineage,
    proposal_id: `prop-${incidentId}`,
    incident_id: incidentId,
    title: "Genangan di Cawang",
    incident_type: "genangan_air_luapan_saluran",
    primary_category: "disasters_weather",
    severity: "medium",
    event_time: { precision: "exact", value: "2026-11-10T08:00:00.000Z" },
    location_label: "Cawang, Jakarta Timur",
    coordinates: null,
    claims: [{
      claim_id: "claim-1",
      claim_text: "Genangan 50 cm di Cawang",
      evidence_label: "attributed_report",
      support_assessment: "supported",
      quote_text: "Genangan setinggi 50 cm",
      evidence_ref_id: `chk-${incidentId}`,
      source_id: "source-detik",
      outlet: "Detik News",
      source_url: "https://news.example/cawang",
    }],
    impacts: [],
    caveats: [],
    has_discrepancy: false,
    discrepancy_summary: null,
    discrepancies: [],
    correlation_relationship: "primary_initial",
    is_multi_source: false,
    source_count: 1,
    source_id: "source-detik",
    proposed_at: "2026-11-10T08:05:00.000Z",
  } as unknown as EventProposalDto;
}

describe("NFR-04 public reads never call acquisition or inference", () => {
  let db: TestDatabase;
  let deps: ProposalDecisionDependencies;
  let publicEnv: never;
  const outbound: string[] = [];
  const sqlStatements: string[] = [];
  const realFetch = globalThis.fetch;

  function recording(executor: TransactionalSqlExecutor): TransactionalSqlExecutor {
    return {
      async query<Row extends object>(statement: string, parameters?: readonly unknown[]) {
        sqlStatements.push(statement);
        return executor.query<Row>(statement, parameters);
      },
      async execute(statement: string) {
        sqlStatements.push(statement);
        return executor.execute(statement);
      },
      async transaction<Result>(work: (transaction: SqlExecutor) => Promise<Result>): Promise<Result> {
        sqlStatements.push("BEGIN");
        return executor.transaction(work);
      },
    };
  }

  const read = (path: string) => worker.fetch(new Request(`${origin}${path}`), publicEnv);

  before(async () => {
    db = await createTestDatabase();
    await applyMigrations(db.executor, await readMigrations(new URL("../../db/migrations/", import.meta.url)));

    // One automatic publication, so the public reads have a published event to serve. Seeding happens before the stub.
    const lineage = await seedProposalLineage(db.executor, LINEAGE_KEY);
    deps = { executor: db.executor, datasetKind: "live", checkPublicDisplay: async () => true };
    await createEventProposalWriter(db.executor).persistProposal(proposalFor(EVENT_ID, lineage), "live");
    const published = await decideProposal(deps, {
      proposalId: `prop-${EVENT_ID}`,
      action: "auto_publish",
      actor: { kind: "agent", actorId: AGENT_AUTO_PUBLISHER_ID },
    });
    assert.equal(published.status, "published", "the seeded event is public before the reads");

    // Every model, acquisition and dispatch binding is configured, so a call would be reachable.
    publicEnv = {
      DATASET_MODE: "live",
      SQL_EXECUTOR: recording(db.executor),
      NINEROUTER_URL: "https://ninerouter.invalid/v1",
      NINEROUTER_KEY: "nfr04-not-a-real-key",
      AI_PROVIDER: "google_ai_studio",
      GOOGLE_AI_API_KEY: "nfr04-not-a-real-key",
      NEWS_DETERMINISTIC_FILTER_MODE: "enforce",
      SYNTHETIC_POLL_SCHEDULER_ENABLED: "true",
      SYNTHETIC_POLL_PROCESSOR_ENABLED: "true",
      FRESHNESS_DUE_SCHEDULER_ENABLED: "true",
      SCHEDULED_MODE: "github_dispatch",
      GITHUB_DISPATCH_TOKEN: "nfr04-not-a-real-token",
      INGEST_DISPATCH_REPO: "nfr04/example",
      INTERNAL_SERVICE_KEY: "nfr04-internal-key",
      WEBHOOK_SERVICE_KEY: "nfr04-webhook-key",
      PUBLIC_EVENT_LIST_CURSOR_HMAC_KEY_HEX: "00".repeat(32),
    } as never;

    globalThis.fetch = (async (input: unknown) => {
      outbound.push(typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url);
      throw new Error("NFR-04: an outbound call is not allowed during this check");
    }) as typeof fetch;
  });

  after(async () => {
    globalThis.fetch = realFetch;
    await db?.close();
  });

  it("NFR-04: public reads never call acquisition or inference", async () => {
    outbound.length = 0;
    sqlStatements.length = 0;

    assert.equal((await read("/api/v1/context")).status, 200, "context answers");
    const list = await read("/api/v1/events");
    assert.equal(list.status, 200, "the event list answers");
    const page = await list.json() as { data: ReadonlyArray<{ event_id: string }> };
    assert.equal(page.data[0]?.event_id, EVENT_ID, "the published event is listed");
    assert.equal((await read(`/api/v1/events/${EVENT_ID}`)).status, 200, "the event detail answers");
    assert.equal((await read(`/api/v1/events/${EVENT_ID}/history`)).status, 200, "the event history answers");
    assert.equal((await read("/api/v1/events.geojson")).status, 200, "the event GeoJSON answers");

    assert.deepEqual(outbound, [], "no outbound call: no source poll, no model call, no dispatch");
    assert.deepEqual(sqlStatements.filter((statement) => ACQUISITION_OR_INFERENCE_SQL.test(statement)), [],
      "no SQL reaches acquisition, inference or a write");
  });

  it("NFR-04: updates and briefings fail closed without a database runtime, and make no call", async () => {
    outbound.length = 0;
    sqlStatements.length = 0;

    const updates = await read("/api/v1/updates");
    assert.equal(updates.status, 503, "updates has no runtime offline, so it fails closed");
    assert.equal((await updates.json() as { code: string }).code, "TEMPORARILY_UNAVAILABLE");

    const briefing = await worker.fetch(new Request(`${origin}/api/v1/briefings`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    }), publicEnv);
    assert.equal(briefing.status, 503, "the briefing has no runtime offline, so it fails closed");

    assert.deepEqual(outbound, [], "neither read calls out");
    assert.deepEqual(sqlStatements, [], "neither read touches the database");
  });

  it("NFR-04 control: the outbound stub records the acquisition trigger, so the empty record above is not an unwired stub", async () => {
    outbound.length = 0;
    await worker.scheduled({ scheduledTime: Date.now() }, publicEnv);
    assert.deepEqual(outbound, ["https://api.github.com/repos/nfr04/example/actions/workflows/ingest.yml/dispatches"]);
  });
});
