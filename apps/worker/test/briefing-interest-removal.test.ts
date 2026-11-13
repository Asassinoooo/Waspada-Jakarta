import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { createPublicBriefingCandidateRepository } from "../../db/src/public-briefing-candidates.js";
import { applyMigrations, readMigrations } from "../../db/src/migrations.js";
import { createTestDatabase, type TestDatabase } from "../../db/test/harness.js";
import {
  projectPublicBriefing,
} from "../src/layers/l4-application-integration/public-briefing-projection.js";
import type { EventView } from "../src/contracts/public-api.js";

/**
 * FR-11, server side. The briefing reads only the interests in its request. Removing an interest
 * from the request removes that interest's candidates and its "matched" reason, and nothing else.
 * The candidate store runs on PGlite with a published live fixture; the projection is pure.
 * All names and records are authored and fictional.
 */

const FIRST = "2026-11-10T10:00:00.000000Z";
const FIRST_ISO = "2026-11-10T10:00:00.000Z";
const trace = "trace-briefing-removal";
const source = "source-briefing-removal";
const revision = "rev-briefing-removal";
const candidate = "cand-briefing-removal";
const context = "ctx-briefing-removal";
const interestedReason = "Mencakup tempat yang Anda ikuti";

let database: TestDatabase;

function request(places: string[]): unknown {
  return { interests: { places, services: [], institutions: [], audiences: [], categories: [] } };
}

async function seedPublishedPlaceEvent(eventId: string, placeId: string, placeName: string): Promise<void> {
  await database.executor.query(
    `INSERT INTO waspada.scope_name_review_decisions
       (review_decision_id, entity_type, entity_id, locale, review_version, decision_status,
        display_name, provenance_ref, reviewer_id, decision_reason, reviewed_at)
     VALUES ($1, 'place', $2, 'id-ID', 1, 'approved', $3, 'authored-fixture', 'fixture-reviewer',
        'fictional decision', $4)`,
    ["scope-review-" + placeId, placeId, placeName, FIRST],
  );
  const decision = "decision-" + eventId;
  const proposal = "proposal-" + eventId;
  const record = {
    schema_version: "2.0", trace_id: trace, record_type: "Event", dataset_kind: "live",
    event_id: eventId, version: 1, supersedes_version: null,
    title: "Genangan fiktif di " + placeName, summary: "Ringkasan fiktif untuk uji.",
    category: "disasters_weather", tags: [], lifecycle: "unknown",
    freshness: { status: "current", evaluated_at: FIRST_ISO, review_due_at: null, basis: "unknown" },
    event_time: { start: null, end: null, precision: "unknown" },
    validity: { valid_from: null, valid_until: null },
    scope: { place_ids: [placeId], service_ids: [], institution_ids: [], audience_ids: [], geometry_ids: [] },
    claims: [{ claim_id: "claim-" + eventId, scope: {} }], impact_refs: [],
    publication_status: "published", withdrawal_reason: null,
    publication_decision_id: decision, published_at: FIRST_ISO, withdrawn_at: null,
  };
  await database.executor.transaction(async (tx) => {
    await tx.execute("SET CONSTRAINTS ALL DEFERRED");
    await tx.query(
      `INSERT INTO waspada.event_proposals
         (dataset_kind, proposal_id, trace_id, candidate_id, context_id, event_id, base_event_version, proposed_at, record_json)
       VALUES ('live', $1, $2, $3, $4, NULL, NULL, $5, '{"fixture":"fiction-only"}'::jsonb)`,
      [proposal, trace, candidate, context, FIRST],
    );
    await tx.query(
      `INSERT INTO waspada.publication_decisions
         (dataset_kind, decision_id, trace_id, proposal_id, policy_version, event_id, event_version, decided_at, record_json)
       VALUES ('live', $1, $2, $3, 'briefing-removal-policy', $4, 1, $5, '{"disposition":"publish"}'::jsonb)`,
      [decision, trace, proposal, eventId, FIRST],
    );
    await tx.query(
      `INSERT INTO waspada.event_versions
         (dataset_kind, event_id, version, trace_id, supersedes_version, title, summary, category, lifecycle,
          publication_status, withdrawal_reason, publication_decision_id, published_at, withdrawn_at, record_json)
       VALUES ('live', $1, 1, $2, NULL, $3, $4, 'disasters_weather', 'unknown', 'published', NULL, $5, $6, NULL, $7::jsonb)`,
      [eventId, trace, record.title, record.summary, decision, FIRST, JSON.stringify(record)],
    );
  });
}

describe("FR-11 briefing personalisation follows the interests in the request", () => {
  before(async () => {
    database = await createTestDatabase();
    await applyMigrations(database.executor, await readMigrations(new URL("../../db/migrations/", import.meta.url)));
    await database.executor.query(
      "INSERT INTO waspada.dataset_namespace_config (singleton, dataset_kind) VALUES (true, 'live')",
    );
    await database.executor.query(
      `INSERT INTO waspada.traces (trace_id, dataset_kind, started_at, outcome, metadata)
       VALUES ($1, 'live', $2, 'succeeded', '{"fixture":"fiction-only"}'::jsonb)`,
      [trace, FIRST],
    );
    await database.executor.query(
      `INSERT INTO waspada.source_registry
         (source_id, trace_id, registry_version, display_name, source_kind, remit, access_method, approved_hosts,
          access_restrictions, reuse_basis, registry_status, approval_status, health_status, auto_acquisition_enabled,
          auto_publication_policy)
       VALUES ($1, $2, 1, 'Fictional briefing source', 'other', ARRAY['fixture'], 'manual_fixture', ARRAY[]::text[],
          ARRAY['fictional'], ARRAY['test'], 'active', 'pending', 'unknown', false, 'never')`,
      [source, trace],
    );
    await database.executor.query(
      `INSERT INTO waspada.report_revisions
         (dataset_kind, report_revision_id, trace_id, source_id, canonical_url, content_hash, permitted_text,
          permitted_text_hash, normalization_version, retrieved_at, revision_status, record_json)
       VALUES ('live', $1, $2, $3, 'https://briefing-removal.invalid/test', $4, 'fictional text', $5,
          'briefing-removal-v1', $6, 'unreviewed', '{"fixture":"fiction-only"}'::jsonb)`,
      [revision, trace, source, "b".repeat(64), "a".repeat(64), FIRST],
    );
    await database.executor.query(
      `INSERT INTO waspada.extraction_results (dataset_kind, candidate_id, trace_id, report_revision_id, category, record_json)
       VALUES ('live', $1, $2, $3, 'disasters_weather', '{"fixture":"fiction-only"}'::jsonb)`,
      [candidate, trace, revision],
    );
    await database.executor.query(
      `INSERT INTO waspada.grounding_contexts
         (dataset_kind, context_id, trace_id, candidate_id, retrieval_version, index_version, sufficient, record_json)
       VALUES ('live', $1, $2, $3, 'briefing-removal-v1', 'briefing-removal-index-v1', true, '{"fixture":"fiction-only"}'::jsonb)`,
      [context, trace, candidate],
    );
    await seedPublishedPlaceEvent("event-cawang", "p-cawang", "Cawang");
    await seedPublishedPlaceEvent("event-kemang", "p-kemang", "Kemang");
  });

  after(async () => {
    await database?.close();
  });

  it("selects an event only while one of its interests is in the request", async () => {
    const repository = createPublicBriefingCandidateRepository(database.executor);
    const bothSaved = await repository.read(request(["Cawang", "Kemang"]));
    assert.deepEqual(bothSaved.map((row) => row.eventId).sort(), ["event-cawang", "event-kemang"]);

    const cawangRemoved = await repository.read(request(["Kemang"]));
    assert.deepEqual(cawangRemoved.map((row) => row.eventId), ["event-kemang"],
      "after Cawang is removed, its event is no longer a candidate");

    const onlyCawang = await repository.read(request(["Cawang"]));
    assert.deepEqual(onlyCawang.map((row) => row.eventId), ["event-cawang"]);
    const unrelated = await repository.read(request(["Pondok Labu"]));
    assert.deepEqual(unrelated, [], "an interest with no approved name matches nothing");
  });

  it("gives the matched reason only for the interests still saved", () => {
    const cawangEvent: EventView = {
      event_id: "event-cawang",
      version: 1,
      title: "Genangan fiktif di Cawang",
      summary: "Ringkasan fiktif untuk uji.",
      category: "disasters_weather",
      tags: [],
      lifecycle: "unknown",
      freshness: { status: "current", evaluated_at: FIRST_ISO, review_due_at: null, basis: "unknown" },
      event_time: { start: null, end: null, precision: "unknown" },
      validity: { valid_from: null, valid_until: null },
      scope: { places: ["Cawang"], services: [], institutions: [], audiences: [] },
      claims: [],
      impacts: [],
      published_at: FIRST_ISO,
    } as unknown as EventView;
    const generatedAt = "2026-11-12T04:06:00.000Z";

    const withCawang = projectPublicBriefing({
      datasetMode: "live", request: request(["Cawang"]), events: [cawangEvent], generatedAt,
    });
    assert.equal(withCawang.items.length, 1);
    assert.deepEqual(withCawang.items[0]?.relevance_reasons, [interestedReason], "the match is explained");

    const withoutCawang = projectPublicBriefing({
      datasetMode: "live", request: request(["Kemang"]), events: [cawangEvent], generatedAt,
    });
    assert.deepEqual(withoutCawang.items, [], "with Cawang removed the event is not personalised into the briefing");
  });
});
