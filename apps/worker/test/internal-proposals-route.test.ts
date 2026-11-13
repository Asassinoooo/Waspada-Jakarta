import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import worker from "../src/index.js";
import type { WorkerEnvironment } from "../src/layers/l4-application-integration/api.js";
import { PublicReadModel } from "../src/layers/l4-application-integration/public-read-model.js";
import { createTestDatabase, type TestDatabase } from "../../db/test/harness.js";
import { seedProposalLineage, type ProposalLineage } from "../../db/test/proposal-lineage-fixture.js";
import { applyMigrations, readMigrations } from "../../db/src/migrations.js";
import { createEventProposalWriter, type EventProposalDto } from "../../db/src/event-proposal-writer.js";

/**
 * FR-08, internal proposals route, 200 path. With a configured service key and a database, the
 * route runs the L4 gate through the real decision writer. The 503 and 401 denials are covered in
 * service-auth-routes.test.ts. Fixtures are authored and synthetic; the source row grants
 * public display only inside this test database.
 */

const origin = "https://waspada.example";
const route = origin + "/api/v1/internal/proposals";
const serviceKey = "job-runner-secret-000000000000";
const permittedSource = "source-internal-route-fixture";
const traceId = "trace-internal-route-fixture";

let lineage: ProposalLineage | undefined;

function proposal(proposalId: string, incidentId: string, hasDiscrepancy = false): EventProposalDto {
  const claim = {
    claim_id: "claim-1",
    claim_text: "Genangan 50 cm di Cawang",
    evidence_label: "attributed_report" as const,
    support_assessment: "supported" as const,
    quote_text: "Genangan 50 cm di Cawang",
    evidence_ref_id: "chk-" + proposalId,
    source_id: permittedSource,
    outlet: "Outlet Uji",
    source_url: "https://news.example/" + proposalId,
  };
  return {
    schema_version: "2.0",
    ...(lineage ?? {}),
    proposal_id: proposalId,
    incident_id: incidentId,
    title: "Genangan di Cawang",
    incident_type: "genangan_air_luapan_saluran",
    primary_category: "disasters_weather",
    compatibility_category: "flood",
    severity: "medium",
    event_time: { precision: "exact", value: "2026-11-10T08:00:00.000Z" },
    location_label: "Cawang, Jakarta Timur",
    coordinates: null,
    claims: [claim],
    impacts: [],
    interpretation_category: null,
    source_id: permittedSource,
    is_multi_source: false,
    source_count: 1,
    has_discrepancy: hasDiscrepancy,
    discrepancy_summary: hasDiscrepancy ? "Laporan lain menyebut 30 cm." : null,
    discrepancies: [],
    caveats: [],
    correlation_relationship: "primary_initial",
    proposed_at: "2026-11-10T08:05:00.000Z",
  } as EventProposalDto;
}

describe("FR-08 internal proposals route with a service key and a database", () => {
  let db: TestDatabase;

  const env = (): WorkerEnvironment => ({
    AUTH_ENABLED: "true",
    AUTH_APP_ORIGIN: origin,
    DATASET_MODE: "live",
    INTERNAL_SERVICE_KEY: serviceKey,
    SQL_EXECUTOR: db.executor,
  }) as unknown as WorkerEnvironment;

  const deliver = (body: unknown, key: string | null = serviceKey) => worker.fetch(
    new Request(route, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(key === null ? {} : { "x-service-key": key }),
      },
      body: JSON.stringify(body),
    }),
    env(),
  );

  async function decisionCount(proposalId: string): Promise<number> {
    const result = await db.executor.query<{ n: number }>(
      "SELECT COUNT(*)::int AS n FROM waspada.publication_decisions WHERE dataset_kind = 'live' AND proposal_id = $1",
      [proposalId],
    );
    return result.rows[0]!.n;
  }

  before(async () => {
    db = await createTestDatabase();
    const migrations = await readMigrations(new URL("../../db/migrations/", import.meta.url));
    await applyMigrations(db.executor, migrations);
    lineage = await seedProposalLineage(db.executor, "internal-route");
    await db.executor.query(
      `INSERT INTO waspada.traces (trace_id, dataset_kind, started_at, outcome, metadata)
       VALUES ($1, 'live', now(), 'succeeded', '{"fixture":"authored-synthetic-only"}'::jsonb)`,
      [traceId],
    );
    // WJ-INT-02B: public display is granted by the registry row alone, so the fixture grants it explicitly.
    await db.executor.query(
      `INSERT INTO waspada.source_registry
         (source_id, trace_id, registry_version, display_name, source_kind, remit, access_method,
          approved_hosts, access_restrictions, reuse_basis, registry_status, approval_status,
          health_status, auto_acquisition_enabled, auto_publication_policy)
       VALUES ($1, $2, 1, 'Fictional route fixture source', 'newsroom', ARRAY['test'], 'rss',
          ARRAY[]::text[], ARRAY[]::text[], ARRAY['public_display'], 'active', 'approved',
          'healthy', true, 'never')`,
      [permittedSource, traceId],
    );
    PublicReadModel.clearPublishedEvents();
  });

  after(async () => {
    await db?.close();
  });

  it("answers 200 with the service key and a database, and publishes a permitted proposal", async () => {
    await createEventProposalWriter(db.executor).persistProposal(
      proposal("prop-route-200", "inc-route-200"),
      "live",
    );

    const response = await deliver({ proposal_id: "prop-route-200" });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const body = await response.json() as Record<string, unknown>;
    assert.deepEqual(body, {
      ok: true,
      proposal_id: "prop-route-200",
      status: "published",
      event_id: "inc-route-200",
      version: 1,
    });

    const decisions = await db.executor.query<{ reviewer_id: string; record_json: Record<string, unknown> }>(
      "SELECT reviewer_id, record_json FROM waspada.publication_decisions WHERE dataset_kind = 'live' AND proposal_id = 'prop-route-200'",
    );
    assert.equal(decisions.rows.length, 1, "one decision row is written");
    assert.equal(decisions.rows[0]?.reviewer_id, "agent:auto-publisher");
    assert.equal(decisions.rows[0]?.record_json.disposition, "publish");
    const published = PublicReadModel.getPublishedEvents().find((event) => event.event_id === "inc-route-200");
    assert.ok(published, "the public read model holds the published version");
    assert.equal(published.version, 1);
  });

  it("answers 200 already_decided when the same proposal is delivered again, with no second version", async () => {
    const response = await deliver({ proposal_id: "prop-route-200" });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      ok: true,
      proposal_id: "prop-route-200",
      status: "already_decided",
    });
    assert.equal(await decisionCount("prop-route-200"), 1, "re-delivery writes no second decision");
    const versions = PublicReadModel.getPublishedEvents().filter((event) => event.event_id === "inc-route-200");
    assert.equal(versions.length, 1, "re-delivery adds no second public version");
  });

  it("answers 200 queued with reasons when a proposal carries a discrepancy, and publishes nothing", async () => {
    await createEventProposalWriter(db.executor).persistProposal(
      proposal("prop-route-queued", "inc-route-queued", true),
      "live",
    );

    const response = await deliver({ proposal_id: "prop-route-queued" });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      ok: true,
      proposal_id: "prop-route-queued",
      status: "queued",
      reasons: ["discrepancy_flagged"],
    });
    assert.equal(await decisionCount("prop-route-queued"), 0, "a queued proposal has no decision row");
    assert.equal(
      PublicReadModel.getPublishedEvents().some((event) => event.event_id === "inc-route-queued"),
      false,
      "nothing becomes public for a queued proposal",
    );
  });

  it("keeps the gate closed for a wrong key, even when the database is configured", async () => {
    const response = await deliver({ proposal_id: "prop-route-queued" }, "wrong-key");
    assert.equal(response.status, 401);
    assert.equal(await decisionCount("prop-route-queued"), 0);
  });
});
