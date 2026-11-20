import assert from "node:assert/strict";
import { after, before, describe, it, mock } from "node:test";
import worker from "../src/index.js";
import type { WorkerEnvironment } from "../src/layers/l4-application-integration/api.js";
import { eventBroadcaster } from "../src/layers/l4-application-integration/event-broadcaster.js";
import { PublicReadModel } from "../src/layers/l4-application-integration/public-read-model.js";
import { createPublicEventDetailRuntime } from "../src/runtime/public-event-detail-runtime.js";
import { createPublicEventHistoryRuntime } from "../src/runtime/public-event-history-runtime.js";
import { createPublicEventListRuntime } from "../src/runtime/public-event-list-runtime.js";
import {
  createPublicEventUpdatesRuntime,
  readPublicEventUpdatesQuery,
  type PublicEventUpdatesRuntime,
} from "../src/runtime/public-event-updates-runtime.js";
import { createTestDatabase, type TestDatabase } from "../../db/test/harness.js";
import { seedProposalLineage, type ProposalLineage } from "../../db/test/proposal-lineage-fixture.js";
import { applyMigrations, readMigrations } from "../../db/src/migrations.js";
import { createEventProposalWriter, type EventProposalDto } from "../../db/src/event-proposal-writer.js";
import type { SqlExecutor } from "../../db/src/sql.js";

/**
 * ST-F-03, ST-F-13 and NFR-05 over the Worker's real route table. Every request goes through the default export of
 * apps/worker/src/index.ts (`worker.fetch`), with a migrated PGlite database injected as env.SQL_EXECUTOR. Accounts are
 * real: a self-registered account is promoted to moderator in SQL, signs in through the account route, and then sends
 * its session cookie, the exact Origin and the session CSRF token. Proposals reach the database through the production
 * writer, which is how the intelligence pipeline stores them. Every decision, correction and publication goes through
 * the moderation route.
 *
 * Harness limits, stated where they bite: without a Hyperdrive connection string the Worker serves the list, detail,
 * history and GeoJSON views from its in-memory read model, and answers /api/v1/updates with 503. The database
 * projections that production serves are read through the same runtime factories, with the same PGlite executor
 * injected. Fictional authored data only.
 */

const ORIGIN = "http://127.0.0.1:5173";
const PASSWORD = "kata-sandi-2026";
const MODERATOR_USERNAME = "stale.route.moderator";
const FIXTURE_CONNECTION = "postgresql://fixture:fixture@db.invalid:5432/waspada";
const FIXTURE_CURSOR_KEY = "ab".repeat(32);

const INCIDENT = {
  corr: "inc-st-f13-corr",
  published: "inc-st-f13-published",
  superseded: "inc-st-f13-superseded",
  older: "inc-st-f13-older",
  draft: "inc-st-f03-draft",
  replay: "inc-st-f03-replay",
} as const;
const LINEAGE_KEY = {
  corr: "route-corr",
  published: "route-published",
  superseded: "route-superseded",
  older: "route-older",
  draft: "route-draft",
  replay: "route-replay",
} as const;

const V1_TITLE = "Genangan di Cawang (fiktif)";
const V2_TITLE = "Genangan 50 cm di Cawang, Jakarta Timur (fiktif)";
const STALE_TITLE = "Judul dari versi lama (fiktif)";
const DRAFT_TITLE = "Draf tertunda uji (fiktif)";
const NEWER_TITLE = "Versi baru uji (fiktif)";
const OLDER_TITLE = "Versi lama uji (fiktif)";

const lineages = new Map<string, ProposalLineage>();

interface PublicEventView {
  readonly event_id: string;
  readonly version: number;
  readonly title: string;
}

type WriteCounts = Record<"event_versions" | "publication_decisions" | "audit_records" | "event_proposals" | "publication_outbox", number>;

interface Spy {
  readonly mock: { callCount(): number; calls: Array<{ arguments: unknown[] }>; resetCalls(): void };
}

/** A proposal as the intelligence pipeline stores it, linked to a seeded lineage and a registry source that grants display. */
function proposalFor(key: keyof typeof LINEAGE_KEY, incidentId: string, overrides: Record<string, unknown> = {}): EventProposalDto {
  const lineage = lineages.get(LINEAGE_KEY[key]);
  assert.ok(lineage, `lineage ${key} is seeded`);
  const sourceId = `source-lineage-${LINEAGE_KEY[key]}`;
  return {
    schema_version: "2.0",
    ...lineage,
    proposal_id: `prop-${incidentId}`,
    incident_id: incidentId,
    title: V1_TITLE,
    incident_type: "genangan_air_luapan_saluran",
    primary_category: "disasters_weather",
    severity: "medium",
    event_time: { precision: "exact", value: "2026-11-10T08:00:00.000Z" },
    location_label: "Cawang, Jakarta Timur",
    coordinates: null,
    claims: [{
      claim_id: "claim-1",
      claim_text: "Genangan setinggi 50 cm di Cawang (fiktif)",
      evidence_label: "attributed_report",
      support_assessment: "supported",
      quote_text: "Genangan setinggi 50 cm di Cawang (fiktif)",
      evidence_ref_id: `chk-${incidentId}`,
      source_id: sourceId,
      outlet: "Fictional lineage source",
      source_url: `https://lineage.invalid/${LINEAGE_KEY[key]}`,
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
    ...overrides,
  } as unknown as EventProposalDto;
}

async function json<Shape>(response: Response): Promise<Shape> {
  return (await response.json()) as Shape;
}

describe("ST-F-03, ST-F-13 and NFR-05 over the Worker route (database)", () => {
  let db: TestDatabase;
  let updatesRuntime: PublicEventUpdatesRuntime;
  let updatesStartCursor = "";
  let moderatorId = "";
  let cookie = "";
  let csrf = "";
  let publicSpy: Spy;
  let moderationSpy: Spy;
  const environment: Record<string, unknown> = {
    DATASET_MODE: "live",
    AUTH_ENABLED: "true",
    AUTH_APP_ORIGIN: ORIGIN,
  };

  const send = (request: Request): Promise<Response> => worker.fetch(request, environment as unknown as WorkerEnvironment);
  const writer = () => createEventProposalWriter(db.executor);

  function publicGet(path: string): Promise<Response> {
    return send(new Request(`${ORIGIN}${path}`));
  }

  function moderatorCall(method: "GET" | "POST", path: string, body?: unknown): Promise<Response> {
    return send(new Request(`${ORIGIN}${path}`, {
      method,
      headers: {
        cookie,
        origin: ORIGIN,
        ...(method === "POST" ? { "content-type": "application/json", "x-csrf-token": csrf } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }));
  }

  const publish = (proposalId: string) => moderatorCall("POST", `/api/v1/moderation/proposals/${proposalId}/publish`, {
    action: "publish",
    evidence_label: "attributed_report",
  });
  const correct = (eventId: string, body: Record<string, unknown>) =>
    moderatorCall("POST", `/api/v1/moderation/events/${eventId}/corrections`, body);

  function resetNotices(): void {
    publicSpy.mock.resetCalls();
    moderationSpy.mock.resetCalls();
  }
  const notices = (): number => publicSpy.mock.callCount() + moderationSpy.mock.callCount();

  async function versionRows(eventId: string): Promise<Array<{ version: number; title: string }>> {
    const result = await db.executor.query<{ version: number; title: string }>(
      `SELECT version, title FROM waspada.event_versions
       WHERE dataset_kind = 'live' AND event_id = $1 ORDER BY version ASC`,
      [eventId],
    );
    return [...result.rows];
  }

  async function writeCounts(): Promise<WriteCounts> {
    const tables = ["event_versions", "publication_decisions", "audit_records", "event_proposals", "publication_outbox"] as const;
    const counts = {} as WriteCounts;
    for (const table of tables) {
      const result = await db.executor.query<{ n: number }>(
        `SELECT COUNT(*)::int AS n FROM waspada.${table} WHERE dataset_kind = 'live'`,
      );
      counts[table] = result.rows[0]?.n ?? 0;
    }
    return counts;
  }

  async function dispositionsFor(proposalId: string): Promise<string[]> {
    const result = await db.executor.query<{ disposition: string }>(
      `SELECT record_json->>'disposition' AS disposition FROM waspada.publication_decisions
       WHERE dataset_kind = 'live' AND proposal_id = $1 ORDER BY decided_at ASC, decision_id ASC`,
      [proposalId],
    );
    return result.rows.map((row) => row.disposition);
  }

  async function publishDecisionCount(eventId: string): Promise<number> {
    const result = await db.executor.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM waspada.publication_decisions
       WHERE dataset_kind = 'live' AND event_id = $1 AND record_json->>'disposition' = 'publish'`,
      [eventId],
    );
    return result.rows[0]?.n ?? 0;
  }

  async function auditFor(eventId: string): Promise<Array<{ action: string; outcome: string | null; refusal_code: string | null; actor_id: string | null }>> {
    const result = await db.executor.query<{ action: string; outcome: string | null; refusal_code: string | null; actor_id: string | null }>(
      `SELECT action, details->>'outcome' AS outcome, details->>'refusal_code' AS refusal_code, actor_id
       FROM waspada.audit_records
       WHERE dataset_kind = 'live' AND entity_id = $1 ORDER BY occurred_at ASC, audit_id ASC`,
      [eventId],
    );
    return [...result.rows];
  }

  /** The PGlite executor stands in for the Hyperdrive connection; the production readers run unchanged on it. */
  const databaseSeam = {
    withSqlExecutor: async <Result>(_connection: string, operation: (executor: SqlExecutor) => Promise<Result>): Promise<Result> =>
      operation(db.executor),
  };

  /** The database readers production serves for list, detail and history. */
  async function databaseReaders() {
    const list = await createPublicEventListRuntime(
      { datasetMode: "live", connectionString: FIXTURE_CONNECTION, cursorHmacKeyHex: FIXTURE_CURSOR_KEY },
      databaseSeam,
    );
    const detail = createPublicEventDetailRuntime({ datasetMode: "live", connectionString: FIXTURE_CONNECTION }, databaseSeam);
    const history = createPublicEventHistoryRuntime({ datasetMode: "live", connectionString: FIXTURE_CONNECTION }, databaseSeam);
    assert.ok(list && detail && history, "the database readers are constructed");
    return { list, detail, history };
  }

  /** Checks the route views and the database readers all show one version with one title, and never the excluded text. */
  async function assertEveryPublicViewShows(
    eventId: string,
    version: number,
    title: string,
    changeType: "published" | "corrected",
    excluded: readonly string[],
  ): Promise<void> {
    const expected = { event_id: eventId, version, title };
    const routeList = await json<{ data: PublicEventView[] }>(await publicGet("/api/v1/events"));
    assert.deepEqual(pickView(routeList.data.find((event) => event.event_id === eventId)), expected, "route list");

    const routeDetail = await json<PublicEventView>(await publicGet(`/api/v1/events/${eventId}`));
    assert.deepEqual(pickView(routeDetail), expected, "route detail");

    const routeHistory = await json<{ data: Array<{ version: number; title?: string }> }>(
      await publicGet(`/api/v1/events/${eventId}/history`),
    );
    assert.ok(routeHistory.data.some((entry) => entry.version === version), "route history lists the newer version");

    // These events have no usable coordinate, so the map shows no pin for them (never a pin at a made-up point).
    const geojson = await publicGet("/api/v1/events.geojson");
    assert.equal(geojson.status, 200, "route GeoJSON answers");
    const geojsonBody = await json<{ type: string; features: unknown[] }>(geojson);
    assert.equal(geojsonBody.type, "FeatureCollection");
    assert.equal(geojsonBody.features.length, 0, "a coordinate-less event is not a pin on the map");
    const geojsonText = JSON.stringify(geojsonBody);

    const routeUpdates = await publicGet("/api/v1/updates");
    assert.equal(routeUpdates.status, 503, "the route has no updates runtime without a Hyperdrive connection, so updates is read below");

    const readers = await databaseReaders();
    const dbList = await readers.list.read(new URLSearchParams());
    assert.deepEqual(pickView(dbList.data.find((event) => event.event_id === eventId)), expected, "database list");
    const dbDetail = await readers.detail.read(eventId);
    assert.equal(dbDetail.kind, "found", "database detail is found");
    if (dbDetail.kind === "found") assert.deepEqual(pickView(dbDetail.detail), expected, "database detail");
    const dbHistory = await readers.history.read(eventId, new URLSearchParams());
    assert.equal(dbHistory.kind, "found", "database history is found");
    if (dbHistory.kind === "found") {
      assert.ok(dbHistory.page.data.some((entry) => entry.version === version), "database history lists the newer version");
    }
    // The updates feed has no title field (HistoryEntry): the newer version is listed once, as a correction. It is read
    // from the cursor taken before the first publish, because a poll with no cursor starts at the current snapshot.
    const dbUpdates = await updatesRuntime.read(readPublicEventUpdatesQuery(
      new URLSearchParams({ cursor: updatesStartCursor, limit: "100" }),
    ));
    const forEvent = dbUpdates.items.filter((item) => item.event_id === eventId);
    assert.equal(forEvent.filter((item) => item.version === version).length, 1, "the updates feed lists the newer version once");
    assert.equal(forEvent.find((item) => item.version === version)?.change_type, changeType, "the newer version has its change type in the feed");
    assert.equal(Math.max(...forEvent.map((item) => item.version)), version, "the feed has no version above the current one");
    const updateText = JSON.stringify(dbUpdates);

    const bodies = [JSON.stringify(routeList), JSON.stringify(routeDetail), JSON.stringify(routeHistory), geojsonText, JSON.stringify(dbList), JSON.stringify(dbDetail), JSON.stringify(dbHistory), updateText];
    for (const text of bodies) {
      for (const stale of excluded) assert.equal(text.includes(stale), false, `no public view shows ${stale}`);
    }
  }

  function pickView(value: unknown): PublicEventView | undefined {
    if (value === null || typeof value !== "object") return undefined;
    const record = value as Record<string, unknown>;
    return {
      event_id: record.event_id as string,
      version: record.version as number,
      title: record.title as string,
    };
  }

  /** The first write for a fresh incident: a moderator publishes version 1, then corrects it to version 2 at base 1. */
  async function publishAndCorrect(incident: string, key: keyof typeof LINEAGE_KEY): Promise<void> {
    await writer().persistProposal(proposalFor(key, incident), "live");
    const published = await publish(`prop-${incident}`);
    assert.equal(published.status, 200, "version 1 publishes over the route");
    const corrected = await correct(incident, { base_version: 1, title: V2_TITLE });
    assert.equal(corrected.status, 200, "version 2 publishes over the route");
  }

  before(async () => {
    db = await createTestDatabase();
    await applyMigrations(db.executor, await readMigrations(new URL("../../db/migrations/", import.meta.url)));
    // The public readers serve only a dataset the namespace config names as live.
    await db.executor.query("INSERT INTO waspada.dataset_namespace_config (singleton, dataset_kind) VALUES (true, 'live')");
    environment.SQL_EXECUTOR = db.executor;
    PublicReadModel.clearPublishedEvents();
    for (const key of Object.values(LINEAGE_KEY)) {
      lineages.set(key, await seedProposalLineage(db.executor, key));
    }

    // Taken before any publish: the feed reads every change after this cursor, so each version shows once.
    const updates = await createPublicEventUpdatesRuntime(
      { datasetMode: "live", connectionString: FIXTURE_CONNECTION, cursorHmacKeyHex: FIXTURE_CURSOR_KEY },
      databaseSeam,
    );
    assert.ok(updates, "the database updates reader is constructed");
    updatesRuntime = updates;
    updatesStartCursor = (await updatesRuntime.read(readPublicEventUpdatesQuery(new URLSearchParams()))).next_cursor;
    assert.ok(updatesStartCursor.length > 0, "the feed issues a starting cursor");

    publicSpy = mock.method(eventBroadcaster, "broadcastPublic") as unknown as Spy;
    moderationSpy = mock.method(eventBroadcaster, "broadcastModeration") as unknown as Spy;

    const register = await send(new Request(`${ORIGIN}/api/v1/auth/register`, {
      method: "POST",
      headers: { origin: ORIGIN, "x-waspada-request": "1", "content-type": "application/json" },
      body: JSON.stringify({ username: MODERATOR_USERNAME, password: PASSWORD }),
    }));
    assert.equal(register.status, 200, "the moderator account registers");
    await db.executor.query("UPDATE waspada.accounts SET role = 'moderator' WHERE username = $1", [MODERATOR_USERNAME]);
    const idRows = await db.executor.query<{ account_id: string }>(
      "SELECT account_id FROM waspada.accounts WHERE username = $1",
      [MODERATOR_USERNAME],
    );
    moderatorId = idRows.rows[0]?.account_id ?? "";
    assert.ok(moderatorId.length > 0, "the moderator account has an id");

    const login = await send(new Request(`${ORIGIN}/api/v1/auth/login`, {
      method: "POST",
      headers: { origin: ORIGIN, "x-waspada-request": "1", "content-type": "application/json" },
      body: JSON.stringify({ username: MODERATOR_USERNAME, password: PASSWORD }),
    }));
    assert.equal(login.status, 200, "the moderator signs in");
    cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    assert.match(cookie, /^waspada_session_dev=/u);
    csrf = (await json<{ csrf_token: string }>(login)).csrf_token;
    assert.ok(csrf.length > 0, "the login envelope carries the session CSRF token");
  });

  after(async () => {
    mock.restoreAll();
    await db?.close();
  });

  describe("ST-F-13: a stale correction over the Worker route", () => {
    it("ST-F-13: control: a publish and a correction at the current base write versions 1 and 2 over the route", async () => {
      await publishAndCorrect(INCIDENT.corr, "corr");
      assert.deepEqual(await versionRows(INCIDENT.corr), [
        { version: 1, title: V1_TITLE },
        { version: 2, title: V2_TITLE },
      ]);
    });

    it("ST-F-13: a correction against base_version 1 answers 409 STALE_BASE_VERSION, writes no version and sends no notice", async () => {
      const versionsBefore = await versionRows(INCIDENT.corr);
      const writesBefore = await writeCounts();
      const publishDecisionsBefore = await publishDecisionCount(INCIDENT.corr);
      resetNotices();

      const response = await correct(INCIDENT.corr, { base_version: 1, title: STALE_TITLE });
      assert.equal(response.status, 409);
      assert.equal((await json<{ code: string }>(response)).code, "STALE_BASE_VERSION");

      assert.deepEqual(await versionRows(INCIDENT.corr), versionsBefore, "no event version is added or changed");
      assert.equal(await publishDecisionCount(INCIDENT.corr), publishDecisionsBefore, "no publish decision is added");
      const writesAfter = await writeCounts();
      assert.equal(writesAfter.event_versions, writesBefore.event_versions, "event_versions is unchanged");
      assert.equal(writesAfter.publication_outbox, writesBefore.publication_outbox, "no outbox row is added");
      // The refusal itself is recorded (one stored correction attempt, one rejected decision, one audit row), and nothing else.
      assert.equal(writesAfter.event_proposals, writesBefore.event_proposals + 1);
      assert.equal(writesAfter.publication_decisions, writesBefore.publication_decisions + 1);
      assert.equal(writesAfter.audit_records, writesBefore.audit_records + 1);
      assert.equal(notices(), 0, "no public or moderation notice is sent for the refusal");
    });

    it("ST-F-13: after the stale write every public view shows version 2 and never the stale title", async () => {
      await assertEveryPublicViewShows(INCIDENT.corr, 2, V2_TITLE, "corrected", [STALE_TITLE]);
    });
  });

  describe("NFR-05 / ST-F-13: a stale publish over the Worker route", () => {
    it("NFR-05 / ST-F-13: a repeated publish of a decided proposal answers 409 ALREADY_DECIDED and adds no version, decision, audit row or notice", async () => {
      await writer().persistProposal(proposalFor("published", INCIDENT.published), "live");
      resetNotices();
      const first = await publish(`prop-${INCIDENT.published}`);
      assert.equal(first.status, 200);
      assert.equal((await json<{ status: string }>(first)).status, "written");
      assert.equal(publicSpy.mock.callCount(), 1, "the first publish sends exactly one public notice");
      assert.equal(publicSpy.mock.calls[0]?.arguments[0], "event_published");

      const before = await writeCounts();
      resetNotices();
      const duplicate = await publish(`prop-${INCIDENT.published}`);
      assert.equal(duplicate.status, 409);
      const body = await json<{ ok: boolean; status: string; code: string }>(duplicate);
      assert.equal(body.ok, false);
      assert.equal(body.status, "conflict");
      assert.equal(body.code, "ALREADY_DECIDED");

      assert.deepEqual(await writeCounts(), before, "no version, decision, proposal, audit or outbox row is added");
      assert.deepEqual(await versionRows(INCIDENT.published), [{ version: 1, title: V1_TITLE }], "one public version");
      assert.equal(notices(), 0, "the duplicate delivery sends no notice");
    });

    it("NFR-05 / ST-F-13: a publish of a superseded proposal answers 409 and writes nothing, and the newer proposal publishes one version", async () => {
      await writer().persistProposal(proposalFor("superseded", INCIDENT.superseded), "live");
      await writer().persistProposal(
        proposalFor("superseded", INCIDENT.superseded, {
          proposal_id: `prop-${INCIDENT.superseded}-newer`,
          proposed_at: "2026-11-10T09:05:00.000Z",
        }),
        "live",
      );
      assert.deepEqual(await dispositionsFor(`prop-${INCIDENT.superseded}`), ["supersede"], "the newer proposal superseded the older one");

      const before = await writeCounts();
      resetNotices();
      const stale = await publish(`prop-${INCIDENT.superseded}`);
      assert.equal(stale.status, 409);
      assert.equal((await json<{ code: string }>(stale)).code, "ALREADY_DECIDED");
      assert.deepEqual(await writeCounts(), before, "the stale publish writes no row");
      assert.deepEqual(await versionRows(INCIDENT.superseded), [], "no version is written for the superseded proposal");
      assert.deepEqual(await dispositionsFor(`prop-${INCIDENT.superseded}`), ["supersede"], "no publish or reject row is added");
      assert.equal(notices(), 0);

      const newer = await publish(`prop-${INCIDENT.superseded}-newer`);
      assert.equal(newer.status, 200);
      assert.deepEqual(await versionRows(INCIDENT.superseded), [{ version: 1, title: V1_TITLE }]);
      assert.equal(publicSpy.mock.callCount(), 1, "the newer proposal sends one notice");
    });

    it("NFR-05 / ST-F-13: an older undecided proposal written after a newer version is published answers 409, is superseded, and never replaces the newer version", async () => {
      const newerId = `prop-${INCIDENT.older}-newer`;
      const olderId = `prop-${INCIDENT.older}`;
      await writer().persistProposal(proposalFor("older", INCIDENT.older, {
        proposal_id: newerId,
        title: NEWER_TITLE,
        proposed_at: "2026-11-10T09:05:00.000Z",
      }), "live");
      assert.equal((await publish(newerId)).status, 200, "the newer proposal publishes version 1");

      // Written after the newer version exists, so no supersede row was made when it was stored.
      await writer().persistProposal(proposalFor("older", INCIDENT.older, {
        proposal_id: olderId,
        title: OLDER_TITLE,
        proposed_at: "2026-11-10T08:05:00.000Z",
      }), "live");
      assert.deepEqual(await dispositionsFor(olderId), [], "the older proposal is undecided when it is stored");
      const queue = await json<{ proposals: EventProposalDto[] }>(await moderatorCall("GET", "/api/v1/moderation/proposals"));
      assert.ok(queue.proposals.some((proposal) => proposal.proposal_id === olderId), "the moderator queue offers the older proposal");

      const before = await writeCounts();
      resetNotices();
      const stale = await publish(olderId);
      assert.equal(stale.status, 409);
      assert.equal((await json<{ code: string }>(stale)).code, "ALREADY_DECIDED");

      assert.deepEqual(await versionRows(INCIDENT.older), [{ version: 1, title: NEWER_TITLE }], "the newer version is still the only version");
      assert.deepEqual(await dispositionsFor(olderId), ["supersede"], "the stale proposal is superseded, not published");
      const after = await writeCounts();
      assert.equal(after.event_versions, before.event_versions, "no event version is added");
      assert.equal(after.publication_outbox, before.publication_outbox, "no outbox row is added");
      assert.equal(notices(), 0, "the stale publish sends no notice");
      await assertEveryPublicViewShows(INCIDENT.older, 1, NEWER_TITLE, "published", [OLDER_TITLE, olderId]);
    });
  });

  describe("ST-F-03: the draft stays in the moderator queue and off the public routes", () => {
    it("ST-F-03: control: a publish and a correction at the current base write versions 1 and 2 for the draft incident", async () => {
      await publishAndCorrect(INCIDENT.draft, "draft");
      assert.deepEqual((await versionRows(INCIDENT.draft)).map((row) => row.version), [1, 2]);
    });

    it("ST-F-03: after a stale correction is refused, the pending draft is still in the moderator queue, undecided, and on no public route", async () => {
      const draftProposalId = `prop-${INCIDENT.draft}-draft`;
      await writer().persistProposal(
        proposalFor("draft", INCIDENT.draft, {
          proposal_id: draftProposalId,
          title: DRAFT_TITLE,
          proposed_at: "2026-11-10T09:30:00.000Z",
        }),
        "live",
      );

      const stale = await correct(INCIDENT.draft, { base_version: 1, title: STALE_TITLE });
      assert.equal(stale.status, 409);
      assert.equal((await json<{ code: string }>(stale)).code, "STALE_BASE_VERSION");

      const queue = await json<{ proposals: EventProposalDto[] }>(await moderatorCall("GET", "/api/v1/moderation/proposals"));
      const queued = queue.proposals.find((proposal) => proposal.proposal_id === draftProposalId);
      assert.ok(queued, "the moderator queue still lists the draft after the refusal");
      assert.equal(queued.title, DRAFT_TITLE);
      assert.deepEqual(await dispositionsFor(draftProposalId), [], "the draft has no decision row");

      await assertEveryPublicViewShows(INCIDENT.draft, 2, V2_TITLE, "corrected", [DRAFT_TITLE, draftProposalId, STALE_TITLE]);
    });
  });

  describe("ST-F-03: the first write and its replay", () => {
    it("ST-F-03: a first correction writes exactly one version and one audit record over the route", async () => {
      await writer().persistProposal(proposalFor("replay", INCIDENT.replay), "live");
      assert.equal((await publish(`prop-${INCIDENT.replay}`)).status, 200, "version 1 publishes");
      const auditBefore = await auditFor(INCIDENT.replay);
      const decisionsBefore = await publishDecisionCount(INCIDENT.replay);

      const first = await correct(INCIDENT.replay, { base_version: 1, title: V2_TITLE });
      assert.equal(first.status, 200);
      const body = await json<{ status: string; version: number; event_id: string }>(first);
      assert.equal(body.status, "published");
      assert.equal(body.version, 2);

      assert.deepEqual(await versionRows(INCIDENT.replay), [
        { version: 1, title: V1_TITLE },
        { version: 2, title: V2_TITLE },
      ], "exactly one new version");
      assert.equal(await publishDecisionCount(INCIDENT.replay), decisionsBefore + 1, "one publish decision for the correction");
      const auditAfter = await auditFor(INCIDENT.replay);
      assert.equal(auditAfter.length, auditBefore.length + 1, "exactly one audit record for the write");
      assert.deepEqual(auditAfter.at(-1), {
        action: "event_correction",
        outcome: "published",
        refusal_code: null,
        actor_id: moderatorId,
      });
    });

    it("ST-F-03: an identical replay of that correction answers 409, adds no version or publish decision, and records one refusal; it does not return the original result, because the route has no idempotency key", async () => {
      const versionsBefore = await versionRows(INCIDENT.replay);
      const decisionsBefore = await publishDecisionCount(INCIDENT.replay);
      const auditBefore = await auditFor(INCIDENT.replay);
      resetNotices();

      const replay = await correct(INCIDENT.replay, { base_version: 1, title: V2_TITLE });
      assert.equal(replay.status, 409);
      assert.equal((await json<{ code: string }>(replay)).code, "STALE_BASE_VERSION");

      assert.deepEqual(await versionRows(INCIDENT.replay), versionsBefore, "no second version");
      assert.equal(await publishDecisionCount(INCIDENT.replay), decisionsBefore, "no second publish decision");
      const auditAfter = await auditFor(INCIDENT.replay);
      assert.equal(auditAfter.length, auditBefore.length + 1, "the refused replay is recorded once");
      assert.equal(auditAfter.at(-1)?.refusal_code, "stale_base_version");
      assert.equal(notices(), 0, "the replay sends no notice");
    });

    it("ST-F-03: the same facts repeated at the current base answer unchanged with the existing version and add no version or notice", async () => {
      const versionsBefore = await versionRows(INCIDENT.replay);
      resetNotices();

      const repeat = await correct(INCIDENT.replay, { base_version: 2, title: V2_TITLE });
      assert.equal(repeat.status, 200);
      const body = await json<{ status: string; version: number }>(repeat);
      assert.equal(body.status, "unchanged");
      assert.equal(body.version, 2, "the existing version is returned");

      assert.deepEqual(await versionRows(INCIDENT.replay), versionsBefore, "no new version");
      assert.equal(notices(), 0, "unchanged facts send no notice");
    });
  });
});
