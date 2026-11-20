// NFR-06: the demo dataset rebuilds from migrations and versioned fixtures. Two fresh PGlite databases are built one
// after the other, each from every file in apps/db/migrations and the demo fixture events in
// apps/worker/src/layers/l4-application-integration/synthetic-fixtures.ts. Every event goes through the production
// proposal writer, the moderator publication gate and the withdrawal path, so the rows are the ones the Worker writes.
// The fixture file has no withdrawn event, so one is authored here and withdrawn after it is published.
// Fictional content only. No network, no real source.
import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import { createEventProposalWriter, type EventProposalDto } from "../src/event-proposal-writer.js";
import type { OfficialIncidentCategory } from "../src/incident-categories.js";
import { applyMigrations, readMigrations } from "../src/migrations.js";
import { createPublicEventListRepository, type PublicEventListCursor } from "../src/public-event-list.js";
import type { SqlExecutor } from "../src/sql.js";
import { createTestDatabase } from "./harness.js";
import { seedProposalLineage, type ProposalLineage } from "./proposal-lineage-fixture.js";
import {
  decideProposal,
  withdrawPublishedEvent,
  type ProposalDecisionDependencies,
} from "../../worker/src/layers/l4-application-integration/proposal-publication.js";
import { syntheticEventFixtures } from "../../worker/src/layers/l4-application-integration/synthetic-fixtures.js";
import type { EventView } from "../../worker/src/contracts/public-api.js";

const MODERATOR = "acc-mod-nfr06";
const DEMO_SOURCE_ID = "source-nfr06-demo";
const PROPOSED_AT = "2026-11-10T08:05:00.000Z";
const WITHDRAWAL_REASON = "Contoh fiktif ini ditarik kembali untuk menguji penarikan setelah bangun ulang.";
const FICTIONAL_LOCATION_LABEL = "Lokasi fiktif tanpa koordinat";

type DemoEvent = Pick<EventView, "event_id" | "title" | "category" | "severity" | "event_time">;

/** The fixture file has no withdrawn event, so one is authored here. It is published, then withdrawn. */
const AUTHORED_WITHDRAWN: DemoEvent = {
  event_id: "synthetic-demo-withdrawn-01",
  title: "SIMULASI FIKTIF — Contoh pemberitahuan yang ditarik kembali",
  category: "group_specific_critical_notices",
  severity: "low",
  event_time: { start: null, end: null, precision: "unknown" },
};

/** The demo events in fixture order, then the authored withdrawn event. */
const DEMO_EVENTS: readonly DemoEvent[] = [...syntheticEventFixtures, AUTHORED_WITHDRAWN];

/** Public list and database rows, as sorted text. Plain data, so two builds compare with deepEqual. */
interface DemoSnapshot {
  /** The public list, read through the Worker's repository: "event_id@version". */
  readonly listed: readonly string[];
  /** waspada.public_event_versions for the live dataset: "event_id@version". */
  readonly publicViews: readonly string[];
  /** Every waspada.event_versions row: "event_id@version:publication_status:withdrawal_reason". */
  readonly eventVersions: readonly string[];
  readonly counts: {
    readonly listed: number;
    readonly publicViews: number;
    readonly eventVersions: number;
    readonly withdrawnVersions: number;
  };
}

function proposalIdFor(eventId: string): string {
  return `prop-nfr06-${eventId}`;
}

function proposalEventTime(time: EventView["event_time"]): EventProposalDto["event_time"] {
  if (time.precision === "exact" || time.precision === "date") return { precision: time.precision, value: time.start };
  return { precision: "unknown", value: null };
}

function demoProposal(event: DemoEvent, lineage: ProposalLineage, sourceId: string): EventProposalDto {
  return {
    schema_version: "2.0",
    ...lineage,
    proposal_id: proposalIdFor(event.event_id),
    incident_id: event.event_id,
    title: event.title,
    incident_type: "simulasi_fiktif",
    primary_category: event.category as OfficialIncidentCategory,
    severity: event.severity ?? "unknown",
    event_time: proposalEventTime(event.event_time),
    // Only a group-specific notice may have no place (HOSTED-10). A fictional label gives no coordinate and no pin.
    location_label: event.category === "group_specific_critical_notices" ? null : FICTIONAL_LOCATION_LABEL,
    coordinates: null,
    claims: [{
      claim_id: `claim-${event.event_id}`,
      claim_text: `${event.title} (fiktif, untuk uji pemulihan)`,
      evidence_label: "attributed_report",
      support_assessment: "supported",
      quote_text: "Teks fiktif untuk uji pemulihan basis data.",
      evidence_ref_id: "chk-claim-1",
      source_id: sourceId,
      outlet: "Sumber fiktif NFR-06",
      source_url: "https://demo.invalid/nfr06",
    }],
    impacts: [],
    caveats: [],
    has_discrepancy: false,
    discrepancies: [],
    correlation_relationship: "primary_initial",
    is_multi_source: false,
    source_count: 1,
    source_id: sourceId,
    proposed_at: PROPOSED_AT,
  } as unknown as EventProposalDto;
}

async function readSnapshot(executor: SqlExecutor): Promise<DemoSnapshot> {
  const repository = createPublicEventListRepository(executor);
  const listed: string[] = [];
  let cursor: PublicEventListCursor | null = null;
  do {
    const page = await repository.read(cursor === null ? { limit: 100 } : { limit: 100, cursor });
    for (const candidate of page.candidates) listed.push(`${candidate.eventId}@${candidate.eventVersion}`);
    cursor = page.nextCursor;
  } while (cursor !== null);

  const views = await executor.query<{ event_id: string; version: number }>(
    "SELECT event_id, version FROM waspada.public_event_versions WHERE dataset_kind = 'live'",
  );
  const versions = await executor.query<{
    event_id: string;
    version: number;
    publication_status: string;
    withdrawal_reason: string | null;
  }>("SELECT event_id, version, publication_status, withdrawal_reason FROM waspada.event_versions");

  const publicViews = views.rows.map((row) => `${row.event_id}@${row.version}`).sort();
  const eventVersions = versions.rows
    .map((row) => `${row.event_id}@${row.version}:${row.publication_status}:${row.withdrawal_reason ?? "-"}`)
    .sort();
  listed.sort();
  return {
    listed,
    publicViews,
    eventVersions,
    counts: {
      listed: listed.length,
      publicViews: publicViews.length,
      eventVersions: eventVersions.length,
      withdrawnVersions: versions.rows.filter((row) => row.publication_status === "withdrawn").length,
    },
  };
}

/** One full build: a fresh database, every migration, the demo events published, and the authored one withdrawn. */
async function buildDemoDatabase(): Promise<DemoSnapshot> {
  const db = await createTestDatabase();
  try {
    const migrations = await readMigrations(new URL("../migrations/", import.meta.url));
    await applyMigrations(db.executor, migrations);
    // The public views read only the live namespace, so the build declares it as the demo dataset does.
    await db.executor.query("INSERT INTO waspada.dataset_namespace_config (singleton, dataset_kind) VALUES (true, 'live')");

    const lineage = await seedProposalLineage(db.executor, "nfr06-demo");
    const deps: ProposalDecisionDependencies = {
      executor: db.executor,
      datasetKind: "live",
      checkPublicDisplay: async (sourceId) => sourceId === DEMO_SOURCE_ID,
    };
    const writer = createEventProposalWriter(db.executor);
    for (const event of DEMO_EVENTS) {
      await writer.persistProposal(demoProposal(event, lineage, DEMO_SOURCE_ID), "live");
      const outcome = await decideProposal(deps, {
        proposalId: proposalIdFor(event.event_id),
        action: "publish",
        actor: { kind: "moderator", actorId: MODERATOR },
      });
      // The outcome holds only status and reason codes, so it is safe to print when a fixture is refused.
      assert.equal(outcome.status, "published", `${event.event_id} is published through the moderator gate: ${JSON.stringify(outcome)}`);
    }

    const withdrawal = await withdrawPublishedEvent(deps, {
      eventId: AUTHORED_WITHDRAWN.event_id,
      actorId: MODERATOR,
      reasonCategory: "source_retracted",
      reason: WITHDRAWAL_REASON,
    });
    assert.equal(withdrawal.status, "withdrawn", "the authored demo event is withdrawn");

    return await readSnapshot(db.executor);
  } finally {
    await db.close();
  }
}

describe("NFR-06: demo dataset rebuild", () => {
  let first: DemoSnapshot;
  let second: DemoSnapshot;

  before(async () => {
    // One database at a time: each is closed before the next is created.
    first = await buildDemoDatabase();
    second = await buildDemoDatabase();
  });

  it("NFR-06: the demo dataset rebuilds from migrations and fixtures twice with identical public results", () => {
    assert.deepEqual(second, first);
    assert.equal(first.counts.listed, syntheticEventFixtures.length, "every demo fixture event is listed once");
    assert.ok(first.listed.every((entry) => entry.endsWith("@1")), "each listed event is at its first version");
    assert.equal(first.counts.publicViews, first.counts.listed, "the public view and the public list agree");
  });

  it("NFR-06: the withdrawn demo event stays withdrawn after each rebuild and is absent from the public results", () => {
    const id = AUTHORED_WITHDRAWN.event_id;
    for (const snapshot of [first, second]) {
      assert.ok(snapshot.eventVersions.includes(`${id}@1:published:-`), "the first version was published");
      assert.ok(snapshot.eventVersions.includes(`${id}@2:withdrawn:source_retracted`), "the tombstone is version 2");
      assert.equal(snapshot.listed.some((entry) => entry.startsWith(`${id}@`)), false, "the public list omits it");
      assert.equal(snapshot.publicViews.some((entry) => entry.startsWith(`${id}@`)), false, "the public view omits it");
      assert.equal(snapshot.counts.withdrawnVersions, 1, "one withdrawn version per build");
    }
  });
});
