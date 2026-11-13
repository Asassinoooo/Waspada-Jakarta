// T8 / FR-13: owner checks for the local live freshness timer. The real Worker runtime runs with
// a fake SQL executor, a fake transition ledger and fake timers. No PGlite, no network, no model calls.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import type { SqlExecutor, TransactionalSqlExecutor } from "../apps/db/src/sql.js";
import type { FreshnessDueTarget } from "../apps/db/src/freshness-due-target-reader.js";
import { createFreshnessDueEvaluator } from "../apps/worker/src/layers/l4-application-integration/freshness-due-evaluator.js";
import {
  createFreshnessTransitionRecorder,
  type FreshnessRecorderPersistResult,
  type FreshnessTransitionRecorderRepository,
  type FreshnessTransitionAppendCommand,
} from "../apps/worker/src/layers/l4-application-integration/freshness-transition-recorder.js";
import { PublicReadModel } from "../apps/worker/src/layers/l4-application-integration/public-read-model.js";
import type { EventDetail } from "../apps/worker/src/contracts/public-api.js";
import {
  LIVE_FRESHNESS_DEFAULT_INTERVAL_MS,
  refreshPublishedFreshness,
  resolveLiveFreshnessIntervalMs,
  startLiveFreshness,
} from "./live-freshness-job.js";

const T0 = Date.parse("2026-11-13T10:00:00.000Z");
const HOUR = 60 * 60 * 1000;
const iso = (ms: number): string => new Date(ms).toISOString();
const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
// The evaluator hashes idempotency keys with crypto.subtle, which settles on a later macrotask.
// Interval-fired runs are not awaited by the test, so wait for their audit row instead.
async function settleUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 400 && !predicate(); attempt += 1) {
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}

const RUN_STATEMENTS = [
  "SET ROLE waspada_l4_freshness_writer",
  "RESET ROLE",
  "begin_freshness_due_evaluation_run",
  "finalize_freshness_due_evaluation_run",
];

interface RecordedStatement {
  readonly text: string;
  readonly inTransaction: boolean;
}

interface FakeFreshnessDb {
  executor: TransactionalSqlExecutor;
  readonly statements: RecordedStatement[];
  /** BEGIN and COMMIT/ROLLBACK markers, in order. */
  readonly events: string[];
  readonly beginRuns: { runId: string; startedAt: string }[];
  readonly finalized: { runId: string; outcome: string; counts: Record<string, number> }[];
  readonly appended: FreshnessTransitionAppendCommand[];
  readonly transitions: { event_id: string; event_version: number; transition_sequence: number; resulting_status: string; evaluated_at: string }[];
  dueTargets: FreshnessDueTarget[];
  failFirstBegin: boolean;
}

interface FakeOptions {
  readonly holdFirstRun?: Promise<void>;
  readonly failFirstBegin?: boolean;
}

function createFakeFreshnessDb(options: FakeOptions = {}): FakeFreshnessDb {
  let depth = 0;
  const db: FakeFreshnessDb = {
    executor: undefined as unknown as TransactionalSqlExecutor,
    statements: [],
    events: [],
    beginRuns: [],
    finalized: [],
    appended: [],
    transitions: [],
    dueTargets: [],
    failFirstBegin: options.failFirstBegin === true,
  };

  const executor: TransactionalSqlExecutor = {
    async execute(statement: string) {
      db.statements.push({ text: statement, inTransaction: depth > 0 });
    },
    async query<Row extends object>(statement: string, parameters: readonly unknown[] = []) {
      db.statements.push({ text: statement, inTransaction: depth > 0 });
      if (statement.includes("begin_freshness_due_evaluation_run")) {
        db.beginRuns.push({ runId: String(parameters[0]), startedAt: String(parameters[1]) });
        if (options.holdFirstRun && db.beginRuns.length === 1) await options.holdFirstRun;
        if (db.failFirstBegin && db.beginRuns.length === 1) {
          throw new Error("secret-db-detail-must-not-be-logged");
        }
        return { rows: [{ run_status: "open" }] as unknown as readonly Row[] };
      }
      if (statement.includes("finalize_freshness_due_evaluation_run")) {
        db.finalized.push({
          runId: String(parameters[0]),
          outcome: String(parameters[3]),
          counts: JSON.parse(String(parameters[4])) as Record<string, number>,
        });
        return { rows: [{ run_status: parameters[3] }] as unknown as readonly Row[] };
      }
      if (statement.includes("freshness_transitions")) {
        const ids = parameters[1] as readonly string[];
        return { rows: latestClaimRows(db.transitions, ids) as unknown as readonly Row[] };
      }
      throw new Error("unexpected statement in the freshness job test");
    },
    async transaction<Result>(work: (transaction: SqlExecutor) => Promise<Result>) {
      depth += 1;
      db.events.push("BEGIN");
      try {
        const result = await work(executor);
        db.events.push("COMMIT");
        return result;
      } catch (error) {
        db.events.push("ROLLBACK");
        throw error;
      } finally {
        depth -= 1;
      }
    },
  };
  db.executor = executor;
  return db;
}

function latestClaimRows(
  transitions: FakeFreshnessDb["transitions"],
  ids: readonly string[],
): FakeFreshnessDb["transitions"] {
  const latest = new Map<string, FakeFreshnessDb["transitions"][number]>();
  for (const row of transitions) {
    if (!ids.includes(row.event_id)) continue;
    const key = `${row.event_id}\u0000${row.event_version}`;
    const prior = latest.get(key);
    if (!prior || row.transition_sequence > prior.transition_sequence) latest.set(key, row);
  }
  return [...latest.values()];
}

function fakeLedger(db: FakeFreshnessDb): FreshnessTransitionRecorderRepository {
  return {
    async append(command: FreshnessTransitionAppendCommand): Promise<FreshnessRecorderPersistResult> {
      db.appended.push(command);
      const transitionSequence = command.expectedSequence;
      db.transitions.push({
        event_id: command.eventId,
        event_version: command.eventVersion,
        transition_sequence: transitionSequence,
        resulting_status: command.resultingStatus,
        evaluated_at: command.evaluatedAt,
      });
      return {
        outcome: "written",
        record: {
          transitionId: `transition-${db.appended.length}`,
          datasetKind: command.datasetKind,
          eventId: command.eventId,
          eventVersion: command.eventVersion,
          target: command.target,
          transitionSequence,
          previousStatus: command.previousStatus,
          resultingStatus: command.resultingStatus,
          reason: command.reason,
          evaluatedAt: command.evaluatedAt,
          traceId: command.traceId,
          idempotencyKey: command.idempotencyKey,
          requestFingerprint: "fixture-fingerprint",
          evidenceReferenceIds: [],
        },
      };
    },
  };
}

function evaluatorFor(db: FakeFreshnessDb) {
  return createFreshnessDueEvaluator({
    reader: {
      async read(request: unknown) {
        const limit = (request as { limit: number }).limit;
        return { targets: db.dueTargets.slice(0, limit), nextCursor: null };
      },
    },
    recorder: createFreshnessTransitionRecorder(fakeLedger(db)),
  });
}

function dueTarget(
  eventId: string,
  fields: { status?: "current" | "needs_update"; transitionSequence?: number; validUntil?: string | null; reviewDueAt?: string | null } = {},
): FreshnessDueTarget {
  return {
    datasetKind: "live",
    eventId,
    eventVersion: 1,
    target: { kind: "event_claim_set" },
    status: fields.status ?? "current",
    transitionSequence: fields.transitionSequence ?? 0,
    validUntil: fields.validUntil ?? null,
    reviewDueAt: fields.reviewDueAt ?? null,
  };
}

function fakeTimers() {
  const intervals: { callback: () => void; ms: number; handle: object }[] = [];
  const cleared: unknown[] = [];
  return {
    intervals,
    cleared,
    api: {
      setInterval(callback: () => void, ms: number): unknown {
        const handle = {};
        intervals.push({ callback, ms, handle });
        return handle;
      },
      clearInterval(handle: unknown): void {
        cleared.push(handle);
      },
    },
  };
}

function startFixture(db: FakeFreshnessDb, env: { LIVE_FRESHNESS_INTERVAL_MS?: string } = {}) {
  const timers = fakeTimers();
  const logs: string[] = [];
  const clock = { ms: T0 };
  const schedule = startLiveFreshness({
    executor: db.executor,
    env,
    deps: {
      now: () => clock.ms,
      timers: timers.api,
      log: (line: string) => logs.push(line),
      runtimeDependencies: { createEvaluator: () => evaluatorFor(db), clock: () => clock.ms },
    },
  });
  return { schedule, timers, logs, clock };
}

function isRunStatement(text: string): boolean {
  return RUN_STATEMENTS.some((statement) => text.includes(statement));
}

function publishedDetail(eventId: string, version: number): EventDetail {
  return {
    event_id: eventId,
    version,
    title: "Fixture title",
    summary: "Fixture summary",
    category: "disasters_weather",
    tags: [],
    lifecycle: "ongoing",
    freshness: {
      status: "current",
      evaluated_at: iso(T0 - HOUR),
      review_due_at: null,
      basis: "fast_observation_review",
    },
    event_time: { start: null, end: null, precision: "unknown" },
    validity: { valid_from: null, valid_until: null },
    scope: { places: [], services: [], institutions: [], audiences: [] },
    claims: [],
    impacts: [],
    published_at: iso(T0 - HOUR),
    geometries: [],
  } as EventDetail;
}

describe("live freshness job (T8 / FR-13)", () => {
  it("a passed review_due_at records needs_update and writes nothing else", async () => {
    const db = createFakeFreshnessDb();
    db.dueTargets = [dueTarget("event-fr13-review", {
      validUntil: iso(T0 + 24 * HOUR),
      reviewDueAt: iso(T0 - HOUR),
    })];
    const fixture = startFixture(db);

    assert.equal(await fixture.schedule.startup, "completed");
    assert.deepEqual(
      db.appended.map((command) => ({
        eventId: command.eventId,
        previousStatus: command.previousStatus,
        resultingStatus: command.resultingStatus,
        reason: command.reason,
        expectedSequence: command.expectedSequence,
      })),
      [{
        eventId: "event-fr13-review",
        previousStatus: "current",
        resultingStatus: "needs_update",
        reason: "review_deadline_missed",
        expectedSequence: 1,
      }],
    );
    assert.equal(db.appended.some((command) => "lifecycle" in command), false,
      "the freshness write carries no lifecycle field");
    assert.deepEqual(db.finalized, [{
      runId: "freshness-due:" + T0,
      outcome: "succeeded",
      counts: { written: 1, replayed: 0, noChange: 0, conflicts: 0, failures: 0 },
    }]);
    assert.deepEqual(db.statements.filter((statement) => !isRunStatement(statement.text)), [],
      "no SQL outside the run audit and the writer role switch");
  });

  it("a missed timer gap runs once at the current time and expires only targets whose validity ended", async () => {
    const db = createFakeFreshnessDb();
    const fixture = startFixture(db);
    assert.equal(await fixture.schedule.startup, "completed");

    // The interval timer was skipped for six hours. The next tick must not backfill the gap.
    fixture.clock.ms = T0 + 6 * HOUR;
    db.dueTargets = [
      // Review deadline passed, no issuer validity window: needs_update, never expired.
      dueTarget("event-fr13-review-only", { reviewDueAt: iso(T0 + 2 * HOUR) }),
      // Still inside its validity window and not review-due: no transition.
      dueTarget("event-fr13-still-valid", { validUntil: iso(T0 + 20 * HOUR) }),
      // Already needs_update and its issuer validity has ended: expired.
      dueTarget("event-fr13-validity-ended", { status: "needs_update", transitionSequence: 1, validUntil: iso(T0 + 5 * HOUR) }),
      // Validity ended and review passed: expired, because validity wins.
      dueTarget("event-fr13-validity-and-review", { validUntil: iso(T0 + 4 * HOUR), reviewDueAt: iso(T0 + 2 * HOUR) }),
    ];

    fixture.timers.intervals[0]!.callback();
    await settleUntil(() => db.finalized.length === 2);

    assert.equal(db.beginRuns.length, 2, "one startup run and one run for the missed tick, with no backfill");
    assert.equal(db.beginRuns[1]!.startedAt, iso(T0 + 6 * HOUR));
    assert.deepEqual(
      db.appended.map((command) => [command.eventId, command.resultingStatus, command.reason]),
      [
        ["event-fr13-review-only", "needs_update", "review_deadline_missed"],
        ["event-fr13-validity-ended", "expired", "issuer_validity_ended"],
        ["event-fr13-validity-and-review", "expired", "issuer_validity_ended"],
      ],
    );
    assert.equal(db.appended.some((command) => command.eventId === "event-fr13-still-valid"), false);
    assert.deepEqual(db.finalized[1], {
      runId: "freshness-due:" + (T0 + 6 * HOUR),
      outcome: "succeeded",
      counts: { written: 3, replayed: 0, noChange: 1, conflicts: 0, failures: 0 },
    });
  });

  it("a tick that arrives while a run is in progress is skipped", async () => {
    let release: () => void = () => undefined;
    const hold = new Promise<void>((resolve) => { release = resolve; });
    const db = createFakeFreshnessDb({ holdFirstRun: hold });
    const fixture = startFixture(db);

    await flush();
    assert.equal(db.beginRuns.length, 1, "the startup run is waiting inside its begin call");
    assert.equal(await fixture.schedule.tick(), "skipped");
    assert.equal(db.beginRuns.length, 1, "the overlapping tick never reached the runtime");

    release();
    assert.equal(await fixture.schedule.startup, "completed");
    assert.equal(await fixture.schedule.tick(), "completed");
    assert.equal(db.beginRuns.length, 2);
    assert.ok(fixture.logs.some((line) => line.includes("still running")));
  });

  it("startLiveFreshness runs at startup, on the configured interval, and stop clears the timer", async () => {
    const db = createFakeFreshnessDb();
    const fixture = startFixture(db, { LIVE_FRESHNESS_INTERVAL_MS: "60000" });

    assert.equal(fixture.schedule.intervalMs, 60_000);
    assert.equal(fixture.timers.intervals.length, 1);
    assert.equal(fixture.timers.intervals[0]!.ms, 60_000);

    await fixture.schedule.startup;
    assert.equal(db.beginRuns.length, 1);
    fixture.timers.intervals[0]!.callback();
    await settleUntil(() => db.finalized.length === 2);
    assert.equal(db.beginRuns.length, 2);

    fixture.schedule.stop();
    assert.deepEqual(fixture.timers.cleared, [fixture.timers.intervals[0]!.handle]);
    fixture.timers.intervals[0]!.callback();
    await flush();
    assert.equal(db.beginRuns.length, 2, "a stopped schedule starts no new runs");
  });

  it("reads LIVE_FRESHNESS_INTERVAL_MS, defaults to five minutes, and never echoes an invalid value", async () => {
    assert.equal(LIVE_FRESHNESS_DEFAULT_INTERVAL_MS, 5 * 60 * 1000);
    assert.deepEqual(resolveLiveFreshnessIntervalMs(undefined), { intervalMs: 300_000, invalid: false });
    assert.deepEqual(resolveLiveFreshnessIntervalMs("  "), { intervalMs: 300_000, invalid: false });
    assert.deepEqual(resolveLiveFreshnessIntervalMs("60000"), { intervalMs: 60_000, invalid: false });
    for (const raw of ["5", "1e9", "-1", "1.5", "raw-value-31337", "99999999999999999999"]) {
      assert.deepEqual(resolveLiveFreshnessIntervalMs(raw), { intervalMs: 300_000, invalid: true }, raw);
    }

    const db = createFakeFreshnessDb();
    const fixture = startFixture(db, { LIVE_FRESHNESS_INTERVAL_MS: "raw-value-31337" });
    await fixture.schedule.startup;
    assert.equal(fixture.schedule.intervalMs, 300_000);
    assert.equal(fixture.timers.intervals[0]!.ms, 300_000);
    assert.ok(fixture.logs.some((line) => line.includes("LIVE_FRESHNESS_INTERVAL_MS")));
    assert.ok(fixture.logs.every((line) => !line.includes("raw-value-31337")));
  });

  it("the freshness pass runs inside one transaction, so SET ROLE cannot reach other queries", async () => {
    const db = createFakeFreshnessDb();
    db.dueTargets = [dueTarget("event-fr13-review", { reviewDueAt: iso(T0 - HOUR) })];
    const fixture = startFixture(db);
    await fixture.schedule.startup;

    assert.equal(db.events[0], "BEGIN");
    assert.equal(db.events.at(-1), "COMMIT");
    const setRole = db.statements.find((statement) => statement.text === "SET ROLE waspada_l4_freshness_writer");
    const resetRole = db.statements.find((statement) => statement.text === "RESET ROLE");
    assert.equal(setRole?.inTransaction, true);
    assert.equal(resetRole?.inTransaction, true);
  });

  it("a failed pass is logged by error code only, and the next tick still runs", async () => {
    const db = createFakeFreshnessDb({ failFirstBegin: true });
    const fixture = startFixture(db);

    assert.equal(await fixture.schedule.startup, "failed");
    assert.ok(fixture.logs.some((line) => line.includes("SCHEDULE_FAILED")));
    assert.ok(fixture.logs.every((line) => !line.includes("secret-db-detail-must-not-be-logged")));

    assert.equal(await fixture.schedule.tick(), "completed");
    assert.equal(db.beginRuns.length, 2);
  });

  it("serve:live composes the freshness job from its own entry point", () => {
    const source = fs.readFileSync(path.join(process.cwd(), "tools", "serve-live-pipeline.ts"), "utf8");
    assert.match(source, /import \{[^}]*startLiveFreshness[^}]*\} from "\.\/live-freshness-job\.js";/);
    assert.match(source, /const freshnessSchedule = startLiveFreshness\(\{/);
    assert.match(source, /freshnessSchedule\.stop\(\);/);
  });

  it("refreshes the in-memory public read model from the ledger after each pass", async () => {
    PublicReadModel.clearPublishedEvents();
    try {
      PublicReadModel.publish(publishedDetail("event-fr13-review", 1));
      PublicReadModel.publish(publishedDetail("event-fr13-untouched", 1));

      const db = createFakeFreshnessDb();
      db.dueTargets = [dueTarget("event-fr13-review", { reviewDueAt: iso(T0 - HOUR) })];
      const fixture = startFixture(db);
      assert.equal(await fixture.schedule.startup, "completed");

      const byId = new Map(PublicReadModel.getPublishedEvents().map((event) => [event.event_id, event]));
      assert.equal(byId.get("event-fr13-review")?.freshness.status, "needs_update");
      assert.equal(byId.get("event-fr13-review")?.freshness.evaluated_at, iso(T0));
      assert.equal(byId.get("event-fr13-untouched")?.freshness.status, "current");

      const refreshRead = db.statements.find((statement) => statement.text.includes("DISTINCT ON"));
      assert.equal(refreshRead?.inTransaction, false, "the public refresh reads after the run has committed");
    } finally {
      PublicReadModel.clearPublishedEvents();
    }
  });

  it("refreshPublishedFreshness leaves the read model alone when nothing is published", async () => {
    PublicReadModel.clearPublishedEvents();
    const db = createFakeFreshnessDb();
    assert.equal(await refreshPublishedFreshness(db.executor), 0);
    assert.equal(db.statements.length, 0, "no SQL is read when there is nothing to refresh");
  });
});
