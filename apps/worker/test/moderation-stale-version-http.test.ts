import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { createTestDatabase, type TestDatabase } from "../../db/test/harness.js";
import { seedProposalLineage, type ProposalLineage } from "../../db/test/proposal-lineage-fixture.js";
import { applyMigrations, readMigrations } from "../../db/src/migrations.js";
import { createEventProposalWriter, type EventProposalDto } from "../../db/src/event-proposal-writer.js";
import {
  createModerationApiHandler,
  type EventCorrectionCommand,
  type EventCorrectionResult,
  type ModerationPrincipal,
} from "../src/layers/l4-application-integration/moderation-api.js";
import {
  decideProposal,
  submitEventCorrection,
  type ProposalDecisionDependencies,
} from "../src/layers/l4-application-integration/proposal-publication.js";
import { PublicReadModel } from "../src/layers/l4-application-integration/public-read-model.js";

/**
 * ST-F-03 and ST-F-13 (FR-08, FR-12): a moderator sends a correction against a base version that is no longer
 * current, over HTTP, through the real moderation handler and the real correction service on a migrated
 * database. The expected result is a 409 STALE_BASE_VERSION, one refusal record, and no new event version and
 * no change to the public view. The HTTP-to-service mapping mirrors the submitCorrection adapter in
 * apps/worker/src/index.ts, so the status code and error code come from the same code path the Worker uses.
 */

const APP_ORIGIN = "https://app.test";
const CSRF = "csrf-stale-version-fixture";
const MODERATOR = "acc-mod-stale";
const PERMITTED = new Set(["source-stale-http"]);
const EVENT = "evt-stale-http";
const BASE = `https://app.test/api/v1/moderation/events/${EVENT}`;
let lineage: ProposalLineage | undefined;

function claim(overrides: Record<string, unknown> = {}) {
  return {
    claim_id: "claim-1",
    claim_text: "Genangan 50 cm di Cawang",
    evidence_label: "attributed_report",
    support_assessment: "supported",
    quote_text: "Genangan setinggi 50 cm",
    evidence_ref_id: "chk-claim-1-stale",
    source_id: "source-stale-http",
    outlet: "Outlet Uji",
    source_url: "https://news.example/cawang-stale",
    ...overrides,
  };
}

function proposal(incidentId: string): EventProposalDto {
  return {
    schema_version: "2.0",
    ...(lineage ?? {}),
    proposal_id: `prop-${incidentId}`,
    incident_id: incidentId,
    title: "Genangan di Cawang",
    incident_type: "genangan_air_luapan_saluran",
    primary_category: "disasters_weather",
    severity: "medium",
    event_time: { precision: "exact", value: "2026-11-10T08:00:00.000Z" },
    location_label: "Cawang, Jakarta Timur",
    coordinates: null,
    claims: [claim()],
    impacts: [],
    caveats: [],
    has_discrepancy: false,
    discrepancies: [],
    correlation_relationship: "primary_initial",
    is_multi_source: false,
    source_count: 1,
    source_id: "source-stale-http",
    proposed_at: "2026-11-10T08:05:00.000Z",
  } as unknown as EventProposalDto;
}

function principal(): ModerationPrincipal {
  return { actorId: MODERATOR, role: "moderator", active: true, csrfToken: CSRF, channel: "web" };
}

function correctionRequest(body: EventCorrectionCommand): Request {
  return new Request(`${BASE}/corrections`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: APP_ORIGIN, "x-csrf-token": CSRF },
    body: JSON.stringify(body),
  });
}

describe("ST-F-03 / ST-F-13: a stale-version correction over HTTP (database)", () => {
  let db: TestDatabase;
  let deps: ProposalDecisionDependencies;
  const writer = () => createEventProposalWriter(db.executor);

  before(async () => {
    db = await createTestDatabase();
    const migrations = await readMigrations(new URL("../../db/migrations/", import.meta.url));
    await applyMigrations(db.executor, migrations);
    lineage = await seedProposalLineage(db.executor, "stale-http");
    deps = {
      executor: db.executor,
      datasetKind: "live",
      checkPublicDisplay: async (sourceId: string) => PERMITTED.has(sourceId),
    };
    PublicReadModel.clearPublishedEvents();

    // Version 1 is published by a moderator, then version 2 is a real correction. The current version is 2.
    await writer().persistProposal(proposal(EVENT), "live");
    const first = await decideProposal(deps, {
      proposalId: `prop-${EVENT}`,
      action: "publish",
      actor: { kind: "moderator", actorId: MODERATOR },
    });
    assert.equal(first.status, "published", "version 1 is published first");
    const second = await submitEventCorrection(deps, {
      eventId: EVENT,
      baseVersion: 1,
      actorId: MODERATOR,
      edits: { title: "Genangan 50 cm di Cawang, Jakarta Timur" },
      reason: "Judul diperbaiki sesuai laporan asli.",
    });
    assert.equal(second.status, "published", "version 2 is the current version");
  });

  after(async () => {
    await db?.close();
  });

  async function versionTitles(): Promise<Array<{ version: number; title: string }>> {
    const result = await db.executor.query<{ version: number; title: string }>(
      `SELECT version, title FROM waspada.event_versions
       WHERE dataset_kind = 'live' AND event_id = $1 ORDER BY version ASC`,
      [EVENT],
    );
    return [...result.rows];
  }

  function publicTitle(): string | null {
    return PublicReadModel.getPublishedEvents().find((event) => event.event_id === EVENT)?.title ?? null;
  }

  /** The Worker's submitCorrection adapter: service outcome to the handler's result shape (index.ts, submitCorrection). */
  async function submitCorrectionLikeWorker(
    eventId: string,
    command: EventCorrectionCommand,
    who: ModerationPrincipal,
  ): Promise<EventCorrectionResult> {
    const outcome = await submitEventCorrection(deps, {
      eventId,
      baseVersion: command.base_version,
      actorId: who.actorId,
      edits: {
        ...(command.title !== undefined ? { title: command.title } : {}),
        ...(command.category !== undefined ? { category: command.category } : {}),
        ...(command.event_time !== undefined ? { eventTime: command.event_time } : {}),
        ...(command.location_label !== undefined ? { locationLabel: command.location_label } : {}),
        ...(command.claims !== undefined
          ? { claims: command.claims.map((edit) => ({ claimId: edit.claim_id, text: edit.claim_text })) }
          : {}),
      },
      reason: command.reason ?? null,
    });
    if (outcome.status === "published" || outcome.status === "unchanged") {
      return {
        status: outcome.status,
        event_id: outcome.eventId,
        version: outcome.version,
        proposal_id: outcome.proposalId,
        decision_id: outcome.decisionId,
      } as EventCorrectionResult;
    }
    if (outcome.status === "invalid") return { status: "invalid", code: outcome.code } as EventCorrectionResult;
    if (outcome.status === "refused" && outcome.code === "event_not_found") return { status: "not_found" };
    if (outcome.status === "refused") {
      return {
        status: "refused",
        code: outcome.code,
        reasons: [...outcome.reasons],
        proposal_id: outcome.proposalId,
      } as EventCorrectionResult;
    }
    return { status: "refused", code: "publication_failed", reasons: [] } as EventCorrectionResult;
  }

  const handler = () => createModerationApiHandler({
    authenticate: async () => principal(),
    appOrigin: APP_ORIGIN,
    csrfProtection: true,
    datasetScope: "live",
    submitCorrection: submitCorrectionLikeWorker,
  });

  it("control: the setup leaves exactly two versions, and the public view shows version 2", async () => {
    assert.deepEqual(await versionTitles(), [
      { version: 1, title: "Genangan di Cawang" },
      { version: 2, title: "Genangan 50 cm di Cawang, Jakarta Timur" },
    ]);
    assert.equal(publicTitle(), "Genangan 50 cm di Cawang, Jakarta Timur");
  });

  it("a correction against base_version 1 answers 409 STALE_BASE_VERSION over HTTP and writes no version", async () => {
    const before = { versions: await versionTitles(), publicTitle: publicTitle() };
    const response = await handler()(correctionRequest({ base_version: 1, title: "Judul dari versi lama" }));

    assert.equal(response?.status, 409);
    const body = (await response?.json()) as { ok: boolean; code: string };
    assert.equal(body.code, "STALE_BASE_VERSION");

    assert.deepEqual(await versionTitles(), before.versions, "no event version is added or changed");
    assert.equal(publicTitle(), before.publicTitle, "the public view still shows the current version");
    assert.notEqual(publicTitle(), "Judul dari versi lama");
  });

  it("the refusal is recorded once as a rejected decision and an audit record, and nothing is published", async () => {
    const decisions = await db.executor.query<{ record_json: Record<string, unknown> }>(
      `SELECT record_json FROM waspada.publication_decisions
       WHERE dataset_kind = 'live' AND record_json->>'refusal_code' = 'stale_base_version'`,
    );
    assert.equal(decisions.rows.length, 1, "one refusal decision for the stale request");
    assert.equal(decisions.rows[0]?.record_json.disposition, "reject");
    assert.equal(decisions.rows[0]?.record_json.base_version, 1);

    const audit = await db.executor.query<{ details: Record<string, unknown>; actor_id: string | null }>(
      `SELECT details, actor_id FROM waspada.audit_records
       WHERE dataset_kind = 'live' AND entity_id = $1 AND action = 'event_correction'
         AND details->>'outcome' = 'refused' AND details->>'refusal_code' = 'stale_base_version'`,
      [EVENT],
    );
    assert.equal(audit.rows.length, 1);
    assert.equal(audit.rows[0]?.actor_id, MODERATOR);
  });

  it("a correction against the current base_version 2 still publishes version 3 after the refusal", async () => {
    const response = await handler()(correctionRequest({ base_version: 2, title: "Genangan 50 cm di Cawang, Jakarta Barat" }));
    assert.equal(response?.status, 200);
    const body = (await response?.json()) as { ok: boolean; status: string; version: number };
    assert.equal(body.status, "published");
    assert.equal(body.version, 3);

    assert.deepEqual((await versionTitles()).map((row) => row.version), [1, 2, 3]);
    assert.equal(publicTitle(), "Genangan 50 cm di Cawang, Jakarta Barat");
  });
});

/**
 * ST-F-13 (FR-08, NFR-05): the moderator PUBLISH route over HTTP, against a proposal that already has a decision and
 * against a proposal that a newer proposal of its incident superseded (POLISH-03). Each refusal is 409 ALREADY_DECIDED
 * and writes no decision and no event version. The publisher mapping mirrors the publisher adapter in
 * apps/worker/src/index.ts (decideProposal outcome to the handler's result), as the correction adapter does above.
 */
const PUBLISH_EVENT_B = "evt-stale-publish-b";

describe("ST-F-13: a publish against a decided or superseded proposal over HTTP (database)", () => {
  let db: TestDatabase;
  let deps: ProposalDecisionDependencies;
  const writer = () => createEventProposalWriter(db.executor);

  before(async () => {
    db = await createTestDatabase();
    const migrations = await readMigrations(new URL("../../db/migrations/", import.meta.url));
    await applyMigrations(db.executor, migrations);
    lineage = await seedProposalLineage(db.executor, "stale-publish-http");
    deps = {
      executor: db.executor,
      datasetKind: "live",
      checkPublicDisplay: async (sourceId: string) => PERMITTED.has(sourceId),
    };
    PublicReadModel.clearPublishedEvents();
  });

  after(async () => {
    await db?.close();
  });

  async function publishedVersionCount(eventId: string): Promise<number> {
    const result = await db.executor.query<{ n: number }>(
      "SELECT COUNT(*)::int AS n FROM waspada.event_versions WHERE dataset_kind = 'live' AND event_id = $1",
      [eventId],
    );
    return result.rows[0]?.n ?? 0;
  }

  async function dispositions(proposalId: string): Promise<string[]> {
    const result = await db.executor.query<{ disposition: string }>(
      `SELECT record_json->>'disposition' AS disposition FROM waspada.publication_decisions
       WHERE dataset_kind = 'live' AND proposal_id = $1 ORDER BY decided_at ASC, decision_id ASC`,
      [proposalId],
    );
    return result.rows.map((row) => row.disposition);
  }

  /** The Worker's publisher adapter: decideProposal outcome to the handler's publisher result (index.ts, publisher.publish). */
  async function publishLikeWorker(input: unknown): Promise<unknown> {
    const command = input as { proposal_id?: string; actorId?: string };
    const outcome = await decideProposal(deps, {
      proposalId: command.proposal_id!,
      action: "publish",
      actor: { kind: "moderator", actorId: command.actorId! },
    });
    if (outcome.status === "published") {
      return { status: "written", receipt: { decision_id: outcome.decisionId } };
    }
    if (outcome.status === "unchanged") {
      return { status: "unchanged", receipt: { decision_id: outcome.decisionId }, event_id: outcome.eventId, version: outcome.version };
    }
    if (outcome.status === "already_decided") return { status: "conflict", code: "ALREADY_DECIDED" };
    if (outcome.status === "denied") {
      return { status: "denied", code: outcome.code === "publication_failed" ? "writer_failed" : outcome.code };
    }
    return { status: "denied", code: "publication_not_authorized" };
  }

  const publishHandler = () => createModerationApiHandler({
    authenticate: async () => principal(),
    appOrigin: APP_ORIGIN,
    csrfProtection: true,
    datasetScope: "live",
    getProposalDetail: async (proposalId: string) => {
      const found = await writer().readProposalById(proposalId, "live");
      return found ? { proposal: found, chunks: [] } : null;
    },
    checkPublicDisplay: async (sourceId: string) => PERMITTED.has(sourceId),
    publicationService: { publish: publishLikeWorker },
  });

  function publishRequest(proposalId: string): Request {
    return new Request(`https://app.test/api/v1/moderation/proposals/${proposalId}/publish`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: APP_ORIGIN, "x-csrf-token": CSRF },
      body: JSON.stringify({ action: "publish", evidence_label: "attributed_report" }),
    });
  }

  it("control: a first publish of an undecided proposal answers 200 written and creates version 1", async () => {
    await writer().persistProposal(proposal("inc-publish-first"), "live");
    const response = await publishHandler()(publishRequest("prop-inc-publish-first"));

    assert.equal(response?.status, 200);
    const body = (await response?.json()) as { ok: boolean; status: string };
    assert.equal(body.ok, true);
    assert.equal(body.status, "written");
    assert.equal(await publishedVersionCount("inc-publish-first"), 1);
  });

  it("a second publish of the already-decided proposal answers 409 ALREADY_DECIDED and writes no decision or version", async () => {
    const before = {
      versions: await publishedVersionCount("inc-publish-first"),
      decisions: await dispositions("prop-inc-publish-first"),
    };
    const response = await publishHandler()(publishRequest("prop-inc-publish-first"));

    assert.equal(response?.status, 409);
    const body = (await response?.json()) as { ok: boolean; status: string; code: string };
    assert.equal(body.ok, false);
    assert.equal(body.status, "conflict");
    assert.equal(body.code, "ALREADY_DECIDED");
    assert.equal(await publishedVersionCount("inc-publish-first"), before.versions, "no new event version");
    assert.deepEqual(await dispositions("prop-inc-publish-first"), before.decisions, "no second decision row");
  });

  it("a publish of a superseded proposal answers 409 ALREADY_DECIDED, and the newer proposal still publishes", async () => {
    await writer().persistProposal(proposal(PUBLISH_EVENT_B), "live");
    await writer().persistProposal({
      ...proposal(PUBLISH_EVENT_B),
      proposal_id: `prop-${PUBLISH_EVENT_B}-newer`,
      proposed_at: "2026-11-10T09:05:00.000Z",
    } as EventProposalDto, "live");
    assert.deepEqual(await dispositions(`prop-${PUBLISH_EVENT_B}`), ["supersede"], "the newer proposal superseded the older one");

    const refused = await publishHandler()(publishRequest(`prop-${PUBLISH_EVENT_B}`));
    assert.equal(refused?.status, 409);
    const body = (await refused?.json()) as { code: string; status: string };
    assert.equal(body.status, "conflict");
    assert.equal(body.code, "ALREADY_DECIDED");
    assert.equal(await publishedVersionCount(PUBLISH_EVENT_B), 0, "the superseded publish writes no version");
    assert.deepEqual(await dispositions(`prop-${PUBLISH_EVENT_B}`), ["supersede"], "no publish or reject row is added");

    const newer = await publishHandler()(publishRequest(`prop-${PUBLISH_EVENT_B}-newer`));
    assert.equal(newer?.status, 200);
    assert.equal(await publishedVersionCount(PUBLISH_EVENT_B), 1, "the newer proposal is the one version written");
  });
});
