import assert from "node:assert/strict";
import { after, before, describe, it, type TestContext } from "node:test";
import { createEventProposalWriter, type EventProposalDto } from "../../db/src/event-proposal-writer.js";
import { applyMigrations, readMigrations } from "../../db/src/migrations.js";
import { createPublicEventListRepository } from "../../db/src/public-event-list.js";
import { createPublicEventSnapshotRepository } from "../../db/src/public-event-snapshot.js";
import { createPublicProjectionLookupRepository } from "../../db/src/public-projection-lookups.js";
import type { SqlExecutor } from "../../db/src/sql.js";
import { createTestDatabase, type TestDatabase } from "../../db/test/harness.js";
import { lineageIdsFor, seedProposalLineage } from "../../db/test/proposal-lineage-fixture.js";
import type { EventPage } from "../src/contracts/public-api.js";
import {
  AGENT_AUTO_PUBLISHER_ID,
  decideProposal,
  type ProposalDecisionDependencies,
} from "../src/layers/l4-application-integration/proposal-publication.js";
import {
  createPublicEventListCursorCodec,
} from "../src/layers/l4-application-integration/public-event-list-cursor.js";
import {
  createPublicEventListPageService,
  type PublicEventListPageService,
} from "../src/layers/l4-application-integration/public-event-list-page-service.js";
import {
  createPublicEventListProjectionService,
} from "../src/layers/l4-application-integration/public-event-list-projection-service.js";
import {
  createPublicEventProjectionService,
  PublicEventProjectionServiceError,
  type PublicEventProjectionBatchOutcome,
  type PublicEventProjectionService,
} from "../src/layers/l4-application-integration/public-event-projection-service.js";
import {
  createPublicEventListRuntime,
  type PublicEventListSqlExecutorRunner,
} from "../src/runtime/public-event-list-runtime.js";

/**
 * PERF-01 (19 Nov 2026): the live event list projects a page with a constant number of SQL round trips, and its JSON is
 * unchanged. The publication path is the real decideProposal, the lineage is authored synthetic data, and the database is
 * PGlite. The per-event oracle is the pre-PERF-01 shape: one snapshot read and one lookup read for each candidate.
 */

const PUBLISHED_EVENT_COUNT = 20;
const LINEAGE_KEYS = ["perf01a", "perf01b"] as const;
const SOURCE_IDS = new Set(LINEAGE_KEYS.map((key) => `source-lineage-${key}`));
const TEST_CONNECTION_STRING = "postgresql://test-user:test-password@hyperdrive.example.invalid/waspada?sslmode=require";
const TEST_CURSOR_KEY_HEX = "0123456789abcdef".repeat(4);
const TEST_NOW = Date.parse("2026-11-19T00:00:00.000Z");

function proposalFor(index: number): EventProposalDto {
  const lineageKey = LINEAGE_KEYS[index % LINEAGE_KEYS.length]!;
  const eventId = eventIdFor(index);
  const sourceId = `source-lineage-${lineageKey}`;
  return {
    schema_version: "2.0",
    ...lineageIdsFor(lineageKey),
    proposal_id: `prop-${eventId}`,
    incident_id: eventId,
    title: `Genangan titik ${index} (fiktif)`,
    incident_type: "genangan_air_luapan_saluran",
    primary_category: "disasters_weather",
    compatibility_category: "flood",
    severity: "medium",
    event_time: { precision: "exact", value: "2026-11-10T08:00:00.000Z" },
    location_label: `Lokasi fiktif ${index}, Jakarta Timur`,
    coordinates: [106.87 + index * 0.001, -6.24 - index * 0.001],
    claims: [{
      claim_id: "claim-1",
      claim_text: `Genangan ${index} di lokasi fiktif`,
      evidence_label: "attributed_report",
      support_assessment: "supported",
      quote_text: "Genangan setinggi 50 cm di Cawang (fiktif)",
      evidence_ref_id: `chk-prop-${eventId}`,
      source_id: sourceId,
      outlet: "Fictional lineage source",
      source_url: `https://lineage.invalid/${lineageKey}`,
    }],
    impacts: [],
    interpretation_category: null,
    source_id: sourceId,
    is_multi_source: false,
    source_count: 1,
    has_discrepancy: false,
    discrepancy_summary: null,
    discrepancies: [],
    caveats: [],
    correlation_relationship: "primary_initial",
    proposed_at: "2026-11-10T08:05:00.000Z",
  } as EventProposalDto;
}

function eventIdFor(index: number): string {
  return `inc-perf01-${String(index).padStart(2, "0")}`;
}

/** Publishes the events through the real auto-publication path. Each one has a point, and a source attribution. */
async function publishEvents(database: TestDatabase): Promise<void> {
  await applyMigrations(database.executor, await readMigrations(new URL("../../db/migrations/", import.meta.url)));
  await database.executor.query("INSERT INTO waspada.dataset_namespace_config (singleton, dataset_kind) VALUES (true, 'live')");
  for (const key of LINEAGE_KEYS) await seedProposalLineage(database.executor, key);
  const deps: ProposalDecisionDependencies = {
    executor: database.executor,
    datasetKind: "live",
    checkPublicDisplay: async (sourceId: string) => SOURCE_IDS.has(sourceId),
  };
  for (let index = 0; index < PUBLISHED_EVENT_COUNT; index += 1) {
    const proposal = proposalFor(index);
    await createEventProposalWriter(database.executor).persistProposal(proposal, "live");
    const outcome = await decideProposal(deps, {
      proposalId: proposal.proposal_id,
      action: "auto_publish",
      actor: { kind: "agent", actorId: AGENT_AUTO_PUBLISHER_ID },
    }) as { readonly status: string };
    assert.equal(outcome.status, "published", eventIdFor(index));
  }
}

/** Counts each statement that reaches the database, for one request-scoped operation. */
function countingExecutor(database: TestDatabase, counter: { queries: number }): SqlExecutor {
  return {
    async query<Row extends object>(statement: string, parameters?: readonly unknown[]) {
      counter.queries += 1;
      return database.executor.query<Row>(statement, parameters);
    },
    async execute(statement: string) {
      await database.executor.execute(statement);
    },
  };
}

function countingRunner(database: TestDatabase, counter: { queries: number }): PublicEventListSqlExecutorRunner {
  return async (_connectionString, operation) => operation(countingExecutor(database, counter));
}

async function batchedPageService(database: TestDatabase, counter: { queries: number }): Promise<PublicEventListPageService> {
  const service = await createPublicEventListRuntime(
    { datasetMode: "live", connectionString: TEST_CONNECTION_STRING, cursorHmacKeyHex: TEST_CURSOR_KEY_HEX },
    { withSqlExecutor: countingRunner(database, counter), now: () => TEST_NOW },
  );
  assert.ok(service);
  return service;
}

/** The pre-PERF-01 shape: each candidate is projected by its own snapshot and lookup reads, one event at a time. */
function perEventProjections(executor: SqlExecutor): Pick<PublicEventProjectionService, "readMany"> {
  const perEvent = createPublicEventProjectionService({
    snapshots: createPublicEventSnapshotRepository(executor),
    lookups: createPublicProjectionLookupRepository(executor),
  });
  return {
    async readMany(eventIds) {
      const outcomes: PublicEventProjectionBatchOutcome[] = [];
      for (const eventId of eventIds) {
        try {
          outcomes.push({ value: await perEvent.read(eventId) });
        } catch (error) {
          outcomes.push({ error: error as PublicEventProjectionServiceError });
        }
      }
      return outcomes;
    },
  };
}

async function perEventPage(database: TestDatabase, counter: { queries: number }, search: URLSearchParams): Promise<EventPage> {
  const executor = countingExecutor(database, counter);
  const key = await globalThis.crypto.subtle.importKey(
    "raw",
    new Uint8Array(TEST_CURSOR_KEY_HEX.match(/.{2}/gu)!.map((byte) => Number.parseInt(byte, 16))),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
  const listProjection = createPublicEventListProjectionService({
    candidates: createPublicEventListRepository(executor),
    projections: perEventProjections(executor),
  });
  const pages = createPublicEventListPageService({
    projection: listProjection,
    cursorCodec: createPublicEventListCursorCodec({ key, now: () => TEST_NOW }),
  });
  return pages.read(search);
}

describe("PERF-01 live event list reads (PGlite, real publication path)", () => {
  let database: TestDatabase;

  before(async () => {
    database = await createTestDatabase();
    await publishEvents(database);
  });

  after(async () => {
    await database?.close();
  });

  it("PERF-01: the page reader issues a constant number of SQL queries regardless of page size", async (t: TestContext) => {
    const batchedCounts: number[] = [];
    for (const limit of ["3", "20"]) {
      const counter = { queries: 0 };
      const page = await (await batchedPageService(database, counter)).read(new URLSearchParams({ limit }));
      assert.equal(page.data.length, Number(limit));
      batchedCounts.push(counter.queries);
    }

    const perEventCounter = { queries: 0 };
    const oracle = await perEventPage(database, perEventCounter, new URLSearchParams({ limit: "20" }));
    assert.equal(oracle.data.length, 20);

    t.diagnostic(`PERF-01 SQL statements per page: batched limit=3 ${batchedCounts[0]}, batched limit=20 ${batchedCounts[1]}, per-event limit=20 ${perEventCounter.queries}`);
    assert.equal(batchedCounts[0], batchedCounts[1], "the same statement count for a 3-event and a 20-event page");
    assert.ok(batchedCounts[1]! <= 5, `at most five statements per page, got ${batchedCounts[1]}`);
    assert.ok(perEventCounter.queries > batchedCounts[1]!, "the per-event path needs more statements than the batch");
  });

  it("PERF-01: a 20-event page equals the per-event projection path byte for byte, in the same order", async () => {
    const search = new URLSearchParams({ limit: "20" });
    const batched = await (await batchedPageService(database, { queries: 0 })).read(search);
    const perEvent = await perEventPage(database, { queries: 0 }, search);

    assert.equal(JSON.stringify(batched), JSON.stringify(perEvent));
    assert.deepEqual(batched, perEvent);
    assert.equal(batched.data.length, 20);
    assert.equal(batched.page.next_cursor, null);
    assert.deepEqual(batched.data.map((event) => event.event_id), perEvent.data.map((event) => event.event_id));
    // Each claim carries its approved source attribution, so the attribution lookup is part of the compared output.
    assert.ok(batched.data.every((event) => event.claims.every((claim) => claim.sources.length === 1)));
  });

  it("PERF-01: every page of a 20-event walk equals the per-event path, including each continuation cursor", async () => {
    const batchedService = await batchedPageService(database, { queries: 0 });
    const walked: string[] = [];
    let cursor: string | null = null;
    do {
      const search = new URLSearchParams({ limit: "7", ...(cursor === null ? {} : { cursor }) });
      const batched = await batchedService.read(search);
      const perEvent = await perEventPage(database, { queries: 0 }, search);
      assert.equal(JSON.stringify(batched), JSON.stringify(perEvent));
      walked.push(...batched.data.map((event) => event.event_id));
      cursor = batched.page.next_cursor;
    } while (cursor !== null);

    // The walk covers every event once, in the same order as one page of all twenty.
    const onePage = await (await batchedPageService(database, { queries: 0 })).read(new URLSearchParams({ limit: "20" }));
    assert.equal(walked.length, 20);
    assert.equal(new Set(walked).size, 20);
    assert.deepEqual(walked, onePage.data.map((event) => event.event_id));
  });
});
