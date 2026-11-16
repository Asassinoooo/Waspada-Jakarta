import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { createTestDatabase, type TestDatabase } from "../../db/test/harness.js";
import { seedProposalLineage, type ProposalLineage } from "../../db/test/proposal-lineage-fixture.js";
import { applyMigrations, readMigrations } from "../../db/src/migrations.js";
import { createEventProposalWriter, type EventProposalDto } from "../../db/src/event-proposal-writer.js";
import { createPublicEventListRepository } from "../../db/src/public-event-list.js";
import { createPublicEventSnapshotRepository } from "../../db/src/public-event-snapshot.js";
import { createPublicProjectionLookupRepository } from "../../db/src/public-projection-lookups.js";
import { createPublicEventListProjectionService } from "../src/layers/l4-application-integration/public-event-list-projection-service.js";
import { createPublicEventProjectionService } from "../src/layers/l4-application-integration/public-event-projection-service.js";
import {
  AGENT_AUTO_PUBLISHER_ID,
  decideProposal,
  originIdFor,
  writeOriginRows,
  type ProposalDecisionDependencies,
  type ProposalDecisionOutcome,
} from "../src/layers/l4-application-integration/proposal-publication.js";

/**
 * HOSTED-15: the origin rows of a publication (owner decision, 17 Nov 2026). The publication transaction writes one
 * evidence origin per registered source of a claim, and links it to the persisted evidence the version cites. Origin
 * ids are deterministic per (dataset_kind, source_id), so a repeated source reuses its row. The publication role may
 * only insert these rows. Authored fictional data, the real decision writer and PGlite.
 */

const SOURCE_ONE = "source-origin-uji-satu";
const SOURCE_TWO = "source-origin-uji-dua";
const SOURCE_UNREGISTERED = "source-origin-tidak-terdaftar";
const CLAIM_TEXT = "Genangan 50 cm di Cawang (fiktif)";

interface ClaimSource {
  readonly sourceId: string;
  readonly outlet: string;
}

function proposal(lineage: ProposalLineage, proposalId: string, options: {
  readonly incidentId?: string;
  readonly sources?: readonly ClaimSource[];
} = {}): EventProposalDto {
  const sources = options.sources ?? [{ sourceId: SOURCE_ONE, outlet: "Outlet Uji Satu" }];
  const claims = sources.map((source, index) => ({
    claim_id: `claim-${index + 1}`,
    claim_text: CLAIM_TEXT,
    evidence_label: "attributed_report" as const,
    support_assessment: "supported" as const,
    quote_text: CLAIM_TEXT,
    evidence_ref_id: `chk-${proposalId}-${index + 1}`,
    source_id: source.sourceId,
    outlet: source.outlet,
    source_url: `https://satu.example/${proposalId}/${index + 1}`,
  }));
  return {
    schema_version: "2.0",
    ...lineage,
    proposal_id: proposalId,
    incident_id: options.incidentId ?? "inc-" + proposalId,
    title: "Genangan di Cawang",
    incident_type: "genangan_air_luapan_saluran",
    primary_category: "disasters_weather",
    compatibility_category: "flood",
    severity: "medium",
    event_time: { precision: "exact", value: "2026-11-10T08:00:00.000Z" },
    location_label: "Cawang, Jakarta Timur",
    coordinates: null,
    claims,
    impacts: [],
    interpretation_category: null,
    source_id: sources[0]!.sourceId,
    is_multi_source: sources.length > 1,
    source_count: new Set(sources.map((source) => source.sourceId)).size,
    has_discrepancy: false,
    discrepancy_summary: null,
    discrepancies: [],
    caveats: [],
    correlation_relationship: "primary_initial",
    proposed_at: "2026-11-10T08:05:00.000Z",
  } as EventProposalDto;
}

describe("HOSTED-15 publication writes the origin rows", () => {
  let db: TestDatabase;
  let lineage: ProposalLineage;
  let deps: ProposalDecisionDependencies;
  const persist = (value: EventProposalDto) => createEventProposalWriter(db.executor).persistProposal(value, "live");
  const auto = (proposalId: string): Promise<ProposalDecisionOutcome> => decideProposal(deps, {
    proposalId,
    action: "auto_publish",
    actor: { kind: "agent", actorId: AGENT_AUTO_PUBLISHER_ID },
  });
  const moderate = (proposalId: string): Promise<ProposalDecisionOutcome> => decideProposal(deps, {
    proposalId,
    action: "publish",
    actor: { kind: "moderator", actorId: "fictional-moderator-rep" },
  });

  /** The version-1 record of the event a proposal publishes. The event id is the proposal's incident id. */
  async function currentRecord(incidentId: string): Promise<Record<string, any>> {
    const result = await db.executor.query<{ record_json: Record<string, any> }>(
      "SELECT record_json FROM waspada.event_versions WHERE dataset_kind = 'live' AND event_id = $1 AND version = 1",
      [incidentId],
    );
    return result.rows[0]!.record_json;
  }

  async function originRow(originId: string): Promise<Record<string, any> | undefined> {
    const result = await db.executor.query<Record<string, any>>(
      `SELECT trace_id, origin_kind, actor_label, source_id, lineage_relation, independence_status, record_json
       FROM waspada.evidence_origins WHERE dataset_kind = 'live' AND origin_id = $1`,
      [originId],
    );
    return result.rows[0];
  }

  async function originEvidenceIds(originId: string): Promise<string[]> {
    const result = await db.executor.query<{ evidence_ref_id: string }>(
      `SELECT evidence_ref_id::text AS evidence_ref_id FROM waspada.origin_evidence
       WHERE dataset_kind = 'live' AND origin_id = $1 ORDER BY evidence_ref_id`,
      [originId],
    );
    return result.rows.map((row) => row.evidence_ref_id);
  }

  /** The persisted evidence_references ids that match the support a published claim cites. */
  async function supportEvidenceIds(support: readonly Record<string, any>[]): Promise<string[]> {
    const ids: string[] = [];
    for (const ref of support) {
      const result = await db.executor.query<{ evidence_ref_id: string }>(
        `SELECT evidence_ref_id::text AS evidence_ref_id FROM waspada.evidence_references
         WHERE dataset_kind = 'live' AND report_revision_id = $1 AND permitted_text_hash = $2
           AND span_start = $3 AND span_end = $4 AND offset_unit = 'unicode_code_points' AND relation = 'supports'`,
        [ref.report_revision_id, ref.permitted_text_hash, ref.span_start, ref.span_end],
      );
      assert.equal(result.rows.length, 1, "each cited span has exactly one persisted evidence reference");
      ids.push(result.rows[0]!.evidence_ref_id);
    }
    return ids.sort();
  }

  async function registerSource(sourceId: string, displayName: string, hosts: readonly string[]): Promise<void> {
    await db.executor.query(
      `INSERT INTO waspada.source_registry
         (source_id, trace_id, registry_version, display_name, source_kind, remit, access_method,
          approved_hosts, access_restrictions, reuse_basis, registry_status, approval_status,
          health_status, auto_acquisition_enabled, auto_publication_policy)
       VALUES ($1, $2, 1, $3, 'newsroom', ARRAY['fixture'], 'rss', $4::text[], ARRAY['fictional'],
          ARRAY['public_display'], 'active', 'approved', 'healthy', true, 'never')
       ON CONFLICT (source_id) DO NOTHING`,
      [sourceId, lineage.trace_id, displayName, [...hosts]],
    );
  }

  before(async () => {
    db = await createTestDatabase();
    await applyMigrations(db.executor, await readMigrations(new URL("../../db/migrations/", import.meta.url)));
    lineage = await seedProposalLineage(db.executor, "hosted15");
    // The public views read only a dataset the namespace config names as live.
    await db.executor.query("INSERT INTO waspada.dataset_namespace_config (singleton, dataset_kind) VALUES (true, 'live')");
    await registerSource(SOURCE_ONE, "Outlet Uji Satu", ["satu.example"]);
    await registerSource(SOURCE_TWO, "Outlet Uji Dua", ["dua.example"]);
    deps = {
      executor: db.executor,
      datasetKind: "live",
      checkPublicDisplay: async () => true,
    };
  });

  after(async () => {
    await db?.close();
  });

  it("(a) a single-revision agent publish gives the claim its origin, and the origin links the cited evidence", async () => {
    await persist(proposal(lineage, "prop-h15-a"));
    const outcome = await auto("prop-h15-a");
    assert.equal(outcome.status, "published", JSON.stringify(outcome));

    const record = await currentRecord("inc-prop-h15-a");
    const originId = originIdFor("live", SOURCE_ONE);
    assert.deepEqual(record.claims[0].origin_ids, [originId], "the claim names its source's origin");
    assert.ok(record.claims[0].support.length >= 1, "the claim cites the persisted span it was built from");

    const row = await originRow(originId);
    assert.ok(row, "the origin row exists");
    assert.equal(row.trace_id, lineage.trace_id);
    assert.equal(row.source_id, SOURCE_ONE);
    assert.equal(row.actor_label, "Outlet Uji Satu");
    assert.equal(row.origin_kind, "reporter_observation", "an attributed report maps to a reporter observation");
    assert.equal(row.lineage_relation, "unknown", "no lineage is invented");
    assert.equal(row.independence_status, "unknown", "an origin is never established by publication");
    assert.deepEqual(row.record_json, { public_hosts: ["satu.example"] }, "only the public host and display name");

    const linked = await originEvidenceIds(originId);
    assert.deepEqual(linked, await supportEvidenceIds(record.claims[0].support), "origin_evidence matches the cited refs");
  });

  it("(b) a second event from the same source reuses the origin id, with no duplicate origin or link rows", async () => {
    const originId = originIdFor("live", SOURCE_ONE);
    const linksBefore = await originEvidenceIds(originId);
    await persist(proposal(lineage, "prop-h15-b", { incidentId: "inc-h15-b" }));
    assert.equal((await auto("prop-h15-b")).status, "published");

    const record = await currentRecord("inc-h15-b");
    assert.deepEqual(record.claims[0].origin_ids, [originId], "the same deterministic id");
    const count = await db.executor.query<{ n: number }>(
      "SELECT COUNT(*)::int AS n FROM waspada.evidence_origins WHERE dataset_kind = 'live' AND source_id = $1",
      [SOURCE_ONE],
    );
    assert.equal(count.rows[0]!.n, 1, "one origin row per source");
    assert.deepEqual(await originEvidenceIds(originId), linksBefore, "the same evidence is not linked twice");
  });

  it("(c) a publish with two registered sources writes one origin per source, each claim names its own", async () => {
    await persist(proposal(lineage, "prop-h15-c", {
      incidentId: "inc-h15-c",
      sources: [
        { sourceId: SOURCE_ONE, outlet: "Outlet Uji Satu" },
        { sourceId: SOURCE_TWO, outlet: "Outlet Uji Dua" },
      ],
    }));
    const outcome = await moderate("prop-h15-c");
    assert.equal(outcome.status, "published", JSON.stringify(outcome));

    const record = await currentRecord("inc-h15-c");
    const originOne = originIdFor("live", SOURCE_ONE);
    const originTwo = originIdFor("live", SOURCE_TWO);
    assert.deepEqual(record.claims[0].origin_ids, [originOne]);
    assert.deepEqual(record.claims[1].origin_ids, [originTwo]);
    assert.ok(await originRow(originTwo), "the second source has its own origin row");
    const supportIds = await supportEvidenceIds(record.claims[0].support);
    assert.deepEqual(await originEvidenceIds(originTwo), supportIds, "current behaviour: both origins link the same own-revision support");
  });

  it("(d) a claim whose source is not in the registry gets no origin row, and its origin_ids stay empty", async () => {
    await persist(proposal(lineage, "prop-h15-d", {
      incidentId: "inc-h15-d",
      sources: [{ sourceId: SOURCE_UNREGISTERED, outlet: "Tidak Terdaftar" }],
    }));
    const outcome = await moderate("prop-h15-d");
    assert.equal(outcome.status, "published", JSON.stringify(outcome));

    const record = await currentRecord("inc-h15-d");
    assert.deepEqual(record.claims[0].origin_ids, []);
    assert.equal(await originRow(originIdFor("live", SOURCE_UNREGISTERED)), undefined);
  });

  it("(e) the origin SQL runs as the publication role: the insert, the conflict path and the link rows need no read grant", async () => {
    // decideProposal itself cannot run as this role yet: the publication role has no SELECT on event_proposals
    // .investigation_id (a pre-existing gap, not HOSTED-15). So this runs the origin writer, the same SQL the publish
    // transaction runs, under the role. The evidence ids are read as the owner, before the role is set.
    await persist(proposal(lineage, "prop-h15-e", { incidentId: "inc-h15-e" }));
    assert.equal((await auto("prop-h15-e")).status, "published");
    const record = await currentRecord("inc-h15-e");
    const supportIds = await supportEvidenceIds(record.claims[0].support);
    const originId = originIdFor("live", SOURCE_ONE);
    const linksBefore = await originEvidenceIds(originId);
    const claims = [{ sourceId: SOURCE_ONE, evidenceLabel: "attributed_report" }];

    await db.executor.execute("SET ROLE waspada_l4_publication_writer");
    try {
      const firstWrite = await writeOriginRows(db.executor, { datasetKind: "live", traceId: lineage.trace_id, claims, supportEvidenceRefIds: supportIds });
      const secondWrite = await writeOriginRows(db.executor, { datasetKind: "live", traceId: lineage.trace_id, claims, supportEvidenceRefIds: supportIds });
      assert.deepEqual(firstWrite.originIdsByClaim, [[originId]]);
      assert.deepEqual(secondWrite.originIdsByClaim, [[originId]], "the second write reuses the same origin id");
      await assert.rejects(
        db.executor.query("SELECT COUNT(*) FROM waspada.evidence_origins"),
        /permission denied/,
        "the publication role still cannot read origin rows",
      );
    } finally {
      await db.executor.execute("RESET ROLE");
    }

    assert.deepEqual(await originEvidenceIds(originId), linksBefore, "the repeated write adds no link rows");
    const count = await db.executor.query<{ n: number }>(
      "SELECT COUNT(*)::int AS n FROM waspada.evidence_origins WHERE dataset_kind = 'live' AND source_id = $1",
      [SOURCE_ONE],
    );
    assert.equal(count.rows[0]!.n, 1, "one origin row per source under the role too");
  });

  it("(f) the DB list does not show these agent events yet: origins and support are filled, but no place or geometry target exists", async () => {
    // The projector's target rule (a place id or a geometry) is unchanged, and map points are still skipped (HOSTED-10),
    // so an agent event without a place id has no public target. The list skips it and the page does not fail.
    const list = createPublicEventListProjectionService({
      candidates: createPublicEventListRepository(db.executor),
      projections: createPublicEventProjectionService({
        snapshots: createPublicEventSnapshotRepository(db.executor),
        lookups: createPublicProjectionLookupRepository(db.executor),
      }),
    });
    const page = await list.read();
    assert.deepEqual(page.events, []);
    const record = await currentRecord("inc-prop-h15-a");
    assert.ok(record.claims[0].origin_ids.length > 0, "the origin is filled, so the origin is not the blocker");
  });
});
