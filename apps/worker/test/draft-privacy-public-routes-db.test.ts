import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { createTestDatabase, type TestDatabase } from "../../db/test/harness.js";
import { seedProposalLineage, type ProposalLineage } from "../../db/test/proposal-lineage-fixture.js";
import { applyMigrations, readMigrations } from "../../db/src/migrations.js";
import { createEventProposalWriter, type EventProposalDto } from "../../db/src/event-proposal-writer.js";
import type { SqlExecutor } from "../../db/src/sql.js";
import {
  AGENT_AUTO_PUBLISHER_ID,
  decideProposal,
  type ProposalDecisionDependencies,
} from "../src/layers/l4-application-integration/proposal-publication.js";
import { handlePublicApiRequest, type WorkerEnvironment } from "../src/layers/l4-application-integration/api.js";
import { createModerationApiHandler, type ModerationPrincipal } from "../src/layers/l4-application-integration/moderation-api.js";
import { PublicReadModel, proposalToEventDetail } from "../src/layers/l4-application-integration/public-read-model.js";
import { createPublicEventListRuntime } from "../src/runtime/public-event-list-runtime.js";
import { createPublicEventDetailRuntime } from "../src/runtime/public-event-detail-runtime.js";
import { createPublicEventHistoryRuntime } from "../src/runtime/public-event-history-runtime.js";
import { createPublicEventUpdatesRuntime } from "../src/runtime/public-event-updates-runtime.js";
import { createPublicBriefingRuntime } from "../src/runtime/public-briefing-runtime.js";
import type { EventDetail, EventPage } from "../src/contracts/public-api.js";

/**
 * ST-F-03 (FR-08, FR-12), database level.
 *
 * (a) Draft privacy: a proposal that is still under review (an event_proposals row with no decision) and an
 * unpublished correction draft never appear on any public route. The public routes run through the real
 * handlePublicApiRequest with the real DB runtimes, each under the public-reader role on a migrated PGlite
 * database. The in-memory public read model is checked too, because /api/v1/context reads it.
 *
 * (b) Per-claim origin: the moderator review DTO (GET /api/v1/moderation/proposals/:id) keeps each claim's own
 * source identity, and each public claim shows its own source attribution. A claim with no source link lists no
 * source. Nothing is invented.
 */

const TEST_CONNECTION_STRING = "postgresql://test-user:test-password@hyperdrive.example.invalid/waspada?sslmode=require";
const APP_ORIGIN = "https://app.test";
const CSRF = "csrf-draft-privacy-fixture";
const MODERATOR = "acc-mod-draft-privacy";
const LINEAGE_SOURCE = "source-lineage-draft-privacy";
const PERMITTED = new Set([LINEAGE_SOURCE, "source-public-a", "source-public-b"]);
const PUBLISHED_EVENT = "evt-draft-public";
const DRAFT_ONLY_EVENT = "evt-draft-only";
const ORIGIN_EVENT = "evt-origin-claims";
const DRAFT_TITLE = "Judul draf belum ditinjau";
const DRAFT_ONLY_TITLE = "Judul draf kejadian baru";
const DRAFT_CLAIM = "Klaim draf belum ditinjau moderator";
const DRAFT_ONLY_CLAIM = "Klaim draf kejadian baru";

let lineage: ProposalLineage | undefined;

function claim(overrides: Record<string, unknown> = {}) {
  return {
    claim_id: "claim-1",
    claim_text: "Genangan 50 cm di Cawang",
    evidence_label: "attributed_report",
    support_assessment: "supported",
    quote_text: "Genangan setinggi 50 cm",
    evidence_ref_id: "chk-draft-privacy",
    source_id: LINEAGE_SOURCE,
    outlet: "Fictional lineage source",
    source_url: "https://lineage.invalid/draft-privacy",
    ...overrides,
  };
}

/** A proposal the auto gate accepts. `fields` replaces top-level fields. */
function proposal(proposalId: string, incidentId: string, fields: Record<string, unknown> = {}): EventProposalDto {
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
    claims: [claim()],
    impacts: [],
    interpretation_category: null,
    source_id: LINEAGE_SOURCE,
    is_multi_source: false,
    source_count: 1,
    has_discrepancy: false,
    discrepancy_summary: null,
    discrepancies: [],
    caveats: [],
    correlation_relationship: "primary_initial",
    proposed_at: "2026-11-10T08:05:00.000Z",
    ...fields,
  } as unknown as EventProposalDto;
}

/** An undecided draft: its claims are still under review, and it carries no decision. */
function draft(proposalId: string, incidentId: string, title: string, claimText: string): EventProposalDto {
  return proposal(proposalId, incidentId, {
    title,
    proposed_at: "2026-11-10T10:00:00.000Z",
    claims: [claim({
      claim_id: "claim-draft",
      claim_text: claimText,
      evidence_label: "under_review",
      evidence_ref_id: `chk-${proposalId}`,
      outlet: "Outlet Draf",
      source_url: "https://news.example/draf-belum-ditinjau",
    })],
  });
}

function principal(): ModerationPrincipal {
  return { actorId: MODERATOR, role: "moderator", active: true, csrfToken: CSRF, channel: "web" };
}

describe("ST-F-03: draft privacy on public routes and per-claim origin (database)", () => {
  let db: TestDatabase;
  let deps: ProposalDecisionDependencies;
  let baselineCursor: string;
  /** One key for every runtime in this test, so a cursor issued by one read is accepted by the next. */
  const cursorHmacKeyHex = randomBytes(32).toString("hex");
  const writer = () => createEventProposalWriter(db.executor);

  /** Each public read runs under the public-reader role, as the Worker's exact-live reads do. */
  const withSqlExecutor = async <Result>(
    _connectionString: string,
    operation: (executor: SqlExecutor) => Promise<Result>,
  ): Promise<Result> => {
    await db.executor.execute("SET ROLE waspada_public_reader");
    try {
      return await operation(db.executor);
    } finally {
      await db.executor.execute("RESET ROLE");
    }
  };

  before(async () => {
    db = await createTestDatabase();
    const migrations = await readMigrations(new URL("../../db/migrations/", import.meta.url));
    await applyMigrations(db.executor, migrations);
    lineage = await seedProposalLineage(db.executor, "draft-privacy");
    // The public views read only a dataset the namespace config names as live.
    await db.executor.query("INSERT INTO waspada.dataset_namespace_config (singleton, dataset_kind) VALUES (true, 'live')");
    deps = {
      executor: db.executor,
      datasetKind: "live",
      checkPublicDisplay: async (sourceId: string) => PERMITTED.has(sourceId),
    };
    PublicReadModel.clearPublishedEvents();

    // The updates baseline is taken before anything is published, so the feed's first page holds the publication.
    const updates = await updatesRuntime();
    assert.ok(updates, "the exact-live updates runtime accepts its injected seam");
    const baseline = await handlePublicApiRequest(
      new Request("https://api.example.invalid/api/v1/updates"),
      { DATASET_MODE: "live" },
      undefined, undefined, undefined, undefined, undefined, undefined, updates,
    );
    assert.equal(baseline.status, 200);
    baselineCursor = ((await baseline.json()) as { next_cursor: string }).next_cursor;

    // A published event, then a correction draft of it that is still under review (no decision row).
    await writer().persistProposal(proposal("prop-draft-public", PUBLISHED_EVENT), "live");
    const published = await decideProposal(deps, {
      proposalId: "prop-draft-public",
      action: "auto_publish",
      actor: { kind: "agent", actorId: AGENT_AUTO_PUBLISHER_ID },
      sourcePermission: "required",
    });
    assert.equal(published.status, "published", JSON.stringify(published));

    await writer().persistProposal(draft("prop-draft-correction", PUBLISHED_EVENT, DRAFT_TITLE, DRAFT_CLAIM), "live");
    // A draft for an event that has never been published.
    await writer().persistProposal(draft("prop-draft-only", DRAFT_ONLY_EVENT, DRAFT_ONLY_TITLE, DRAFT_ONLY_CLAIM), "live");
  });

  after(async () => {
    await db?.close();
  });

  const listRuntime = async () => createPublicEventListRuntime({
    datasetMode: "live",
    connectionString: TEST_CONNECTION_STRING,
    cursorHmacKeyHex,
  }, { withSqlExecutor, now: () => Date.parse("2026-11-19T12:00:00.000Z") });

  const updatesRuntime = async () => createPublicEventUpdatesRuntime({
    datasetMode: "live",
    connectionString: TEST_CONNECTION_STRING,
    cursorHmacKeyHex,
  }, { withSqlExecutor, now: () => Date.parse("2026-11-19T12:00:00.000Z") });

  const detailRuntime = () => createPublicEventDetailRuntime({
    datasetMode: "live",
    connectionString: TEST_CONNECTION_STRING,
  }, { withSqlExecutor });

  const historyRuntime = () => createPublicEventHistoryRuntime({
    datasetMode: "live",
    connectionString: TEST_CONNECTION_STRING,
  }, { withSqlExecutor });

  const briefingRuntime = () => createPublicBriefingRuntime({
    datasetMode: "live",
    connectionString: TEST_CONNECTION_STRING,
  }, { withSqlExecutor, now: () => Date.parse("2026-11-19T12:00:00.000Z") });

  const environment: WorkerEnvironment = { DATASET_MODE: "live" };

  /** Every public route the task names, read through the real public handler and DB runtimes. */
  async function publicResponses(): Promise<Record<string, { status: number; body: unknown; text: string }>> {
    const list = await listRuntime();
    const detail = detailRuntime();
    const history = historyRuntime();
    const briefing = briefingRuntime();
    const updates = await updatesRuntime();
    assert.ok(list && detail && history && briefing && updates, "every exact-live runtime accepts its injected seam");

    const get = async (path: string, init?: RequestInit) => {
      const response = await handlePublicApiRequest(
        new Request(`https://api.example.invalid${path}`, init),
        environment,
        undefined,
        list,
        detail,
        history,
        undefined,
        briefing,
        updates,
      );
      const text = await response.text();
      return { status: response.status, body: text.length > 0 ? JSON.parse(text) : null, text };
    };

    const responses: Record<string, { status: number; body: unknown; text: string }> = {};
    responses.list = await get("/api/v1/events?limit=10");
    responses.detailPublished = await get(`/api/v1/events/${PUBLISHED_EVENT}`);
    responses.detailDraftOnly = await get(`/api/v1/events/${DRAFT_ONLY_EVENT}`);
    responses.historyPublished = await get(`/api/v1/events/${PUBLISHED_EVENT}/history`);
    responses.historyDraftOnly = await get(`/api/v1/events/${DRAFT_ONLY_EVENT}/history`);
    responses.updates = await get(`/api/v1/updates?cursor=${encodeURIComponent(baselineCursor)}&limit=10`);
    responses.briefing = await get("/api/v1/briefings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        interests: { places: [], services: [], institutions: [], audiences: [], categories: ["disasters_weather"] },
      }),
    });
    const context = await handlePublicApiRequest(new Request("https://api.example.invalid/api/v1/context"), environment);
    const contextText = await context.text();
    responses.context = { status: context.status, body: JSON.parse(contextText), text: contextText };
    return responses;
  }

  it("control: the published event is public on the list, detail, history, updates and briefing routes", async () => {
    const responses = await publicResponses();
    const page = responses.list?.body as EventPage;
    assert.equal(responses.list?.status, 200);
    assert.deepEqual(page.data.map((event) => event.event_id), [PUBLISHED_EVENT]);
    assert.equal(page.data[0]?.title, "Genangan di Cawang");

    const detail = responses.detailPublished?.body as EventDetail;
    assert.equal(responses.detailPublished?.status, 200);
    assert.equal(detail.event_id, PUBLISHED_EVENT);
    assert.equal(detail.version, 1);
    // The live detail route serves the attribution the publication wrote from the source's approval (HOSTED-22).
    assert.deepEqual(detail.claims.map((c) => c.sources.map((source) => [source.display_name, source.url])), [
      [["Fictional lineage source", "https://lineage.invalid/draft-privacy"]],
    ]);

    assert.equal(responses.historyPublished?.status, 200);
    assert.equal((responses.historyPublished?.body as { data: unknown[] }).data.length, 1);

    assert.equal(responses.updates?.status, 200);
    const updates = responses.updates?.body as { items: Array<{ event_id: string; version: number }> };
    assert.deepEqual(updates.items.map((item) => [item.event_id, item.version]), [[PUBLISHED_EVENT, 1]]);

    assert.equal(responses.briefing?.status, 200);
    const briefing = responses.briefing?.body as { items: Array<{ event: { event_id: string } }> };
    assert.deepEqual(briefing.items.map((item) => item.event.event_id), [PUBLISHED_EVENT]);
  });

  it("an undecided draft and an unpublished correction draft are absent from every public route", async () => {
    const responses = await publicResponses();
    for (const [route, response] of Object.entries(responses)) {
      for (const hidden of [
        DRAFT_TITLE, DRAFT_CLAIM, DRAFT_ONLY_TITLE, DRAFT_ONLY_CLAIM,
        "prop-draft-correction", "prop-draft-only", DRAFT_ONLY_EVENT,
        "https://news.example/draf-belum-ditinjau", "Outlet Draf",
      ]) {
        assert.equal(response?.text.includes(hidden), false, `${route} does not expose the draft value`);
      }
    }
    assert.equal(responses.detailDraftOnly?.status, 404, "a draft-only event has no public detail");
    assert.equal(responses.historyDraftOnly?.status, 404, "a draft-only event has no public history");
    assert.equal((responses.list?.body as EventPage).data.some((event) => event.event_id === DRAFT_ONLY_EVENT), false);
    assert.equal((responses.briefing?.body as { items: unknown[] }).items.length, 1, "the briefing lists only the published event");
  });

  it("the public event detail keeps the published version's title, not the draft's", async () => {
    const responses = await publicResponses();
    const detail = responses.detailPublished?.body as EventDetail;
    assert.equal(detail.title, "Genangan di Cawang");
    assert.equal(detail.claims.some((c) => c.text === DRAFT_CLAIM), false);
  });

  it("the in-memory public read model used by /api/v1/context lists only the published event", async () => {
    const published = PublicReadModel.getPublishedEvents();
    assert.deepEqual(published.map((event) => event.event_id), [PUBLISHED_EVENT]);
    assert.equal(published.some((event) => event.title === DRAFT_TITLE), false);
    const responses = await publicResponses();
    assert.equal(responses.context?.status, 200);
    assert.equal(responses.context?.text.includes(DRAFT_ONLY_EVENT), false);
  });

  it("the draft rows exist in event_proposals with no decision, so privacy comes from the public views, not from absence", async () => {
    const rows = await db.executor.query<{ proposal_id: string; decisions: number }>(
      `SELECT ep.proposal_id, COUNT(pd.decision_id)::int AS decisions
       FROM waspada.event_proposals AS ep
       LEFT JOIN waspada.publication_decisions AS pd
         ON pd.dataset_kind = ep.dataset_kind AND pd.proposal_id = ep.proposal_id
       WHERE ep.dataset_kind = 'live' AND ep.proposal_id IN ('prop-draft-correction', 'prop-draft-only')
       GROUP BY ep.proposal_id ORDER BY ep.proposal_id`,
    );
    assert.deepEqual(rows.rows, [
      { proposal_id: "prop-draft-correction", decisions: 0 },
      { proposal_id: "prop-draft-only", decisions: 0 },
    ]);
  });

  describe("per-claim origin", () => {
    before(async () => {
      await writer().persistProposal(proposal("prop-origin-claims", ORIGIN_EVENT, {
        claims: [
          claim({
            claim_id: "claim-alfa",
            claim_text: "Genangan 50 cm di Cawang",
            evidence_label: "attributed_report",
            evidence_ref_id: "chk-origin-alfa",
            source_id: "source-public-a",
            outlet: "Outlet Alfa",
            source_url: "https://news.example/alfa-origin",
          }),
          claim({
            claim_id: "claim-beta",
            claim_text: "Warga melapor satu jalan tergenang",
            evidence_label: "crowdsourced_observation",
            evidence_ref_id: "chk-origin-beta",
            source_id: "source-public-b",
            outlet: "Outlet Beta",
            source_url: "https://news.example/beta-origin",
          }),
        ],
      }), "live");
    });

    it("the moderator review DTO shows each claim's own origin: source id, outlet, article link and evidence label", async () => {
      const handler = createModerationApiHandler({
        authenticate: async () => principal(),
        appOrigin: APP_ORIGIN,
        csrfProtection: true,
        datasetScope: "live",
        getProposalDetail: async (proposalId: string) => {
          const found = await writer().readProposalById(proposalId, "live");
          return found ? { proposal: found, chunks: [] } : null;
        },
      });
      const response = await handler(new Request("https://app.test/api/v1/moderation/proposals/prop-origin-claims"));
      assert.equal(response?.status, 200);
      const body = (await response?.json()) as { proposal: EventProposalDto };
      assert.deepEqual(body.proposal.claims.map((c) => ({
        claim_id: c.claim_id,
        evidence_label: c.evidence_label,
        source_id: c.source_id,
        outlet: c.outlet,
        source_url: c.source_url,
      })), [
        {
          claim_id: "claim-alfa",
          evidence_label: "attributed_report",
          source_id: "source-public-a",
          outlet: "Outlet Alfa",
          source_url: "https://news.example/alfa-origin",
        },
        {
          claim_id: "claim-beta",
          evidence_label: "crowdsourced_observation",
          source_id: "source-public-b",
          outlet: "Outlet Beta",
          source_url: "https://news.example/beta-origin",
        },
      ]);
    });

    it("after publication, each public claim shows its own source attribution and label", async () => {
      const outcome = await decideProposal(deps, {
        proposalId: "prop-origin-claims",
        action: "publish",
        actor: { kind: "moderator", actorId: MODERATOR },
      });
      assert.equal(outcome.status, "published", JSON.stringify(outcome));

      const event = PublicReadModel.getPublishedEvents().find((e) => e.event_id === ORIGIN_EVENT);
      assert.ok(event, "the origin event is public");
      assert.deepEqual(event.claims.map((c) => ({
        claim_id: c.claim_id,
        evidence_label: c.evidence_label,
        sources: c.sources.map((s) => ({ display_name: s.display_name, url: s.url })),
      })), [
        {
          claim_id: "claim-alfa",
          evidence_label: "attributed_report",
          sources: [{ display_name: "Outlet Alfa", url: "https://news.example/alfa-origin" }],
        },
        {
          claim_id: "claim-beta",
          evidence_label: "crowdsourced_observation",
          sources: [{ display_name: "Outlet Beta", url: "https://news.example/beta-origin" }],
        },
      ]);
      const serialized = JSON.stringify(event);
      assert.equal(serialized.includes("Outlet Draf"), false, "the other event's draft outlet never leaks into this event");
    });

    it("a moderator publish refuses a claim still labelled under_review, as the automatic gate does, and shows no relabelled claim", async () => {
      await writer().persistProposal(proposal("prop-label-review", "evt-label-review", {
        claims: [claim({
          claim_id: "claim-review",
          claim_text: "Klaim yang masih ditinjau",
          evidence_label: "under_review",
          evidence_ref_id: "chk-label-review",
        })],
      }), "live");
      const outcome = await decideProposal(deps, {
        proposalId: "prop-label-review",
        action: "publish",
        actor: { kind: "moderator", actorId: MODERATOR },
      });
      // The moderator gate checks the same AUTO_PUBLICATION_LABELS list as the automatic gate, so the reason matches.
      assert.equal(outcome.status, "denied", JSON.stringify(outcome));
      assert.match(JSON.stringify(outcome), /"reasons":\["claim_label_not_allowed"\]/, JSON.stringify(outcome));
      assert.equal(PublicReadModel.getPublishedEvents().some((e) => e.event_id === "evt-label-review"), false);
    });

    it("a claim with no source link lists no source: no publisher, date or URL is invented", () => {
      const detail = proposalToEventDetail(proposal("prop-no-link", "evt-no-link", {
        claims: [claim({ claim_id: "claim-unlinked", source_url: undefined, outlet: undefined, source_id: null })],
      }), undefined, { version: 1 });
      assert.deepEqual(detail.claims[0]?.sources, []);
    });
  });
});
