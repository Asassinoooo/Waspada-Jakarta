// NFR-07 F-39..F-41 (ADR-005): the hosted run's retention step, its count line and the role it runs under.
// Fakes only: no database, no network, no clock except the one passed in.
import assert from "node:assert/strict";
import test from "node:test";
import {
  formatRetentionLine,
  runOnceSequence,
  type DrainResult,
  type OnceSteps,
  type PublicationSweepResult,
  type RetentionPurgeCounts,
} from "./ingest-once.js";
import { RETENTION_PURGER_ROLE, runRetentionPurge } from "./retention-purge.js";

const COUNTS: RetentionPurgeCounts = {
  sourceTextNulled: 3,
  vectorsRemoved: 2,
  auditRecordsRemoved: 5,
  accountAdminAuditRemoved: 1,
  triageDecisionsRemoved: 7,
};

const DRAIN: DrainResult = { completed: 0, notCompleted: 0, stop: "empty" };
const SWEEP: PublicationSweepResult = {
  assessed: 0, published: 0, unchanged: 0, held: 0, denied: 0, skipped: 0, failed: 0,
  heldReasons: {}, deniedCodes: {}, failedCodes: {}, stop: "done",
};

/** Every step records its name, so the order of one run can be asserted. */
function steps(order: string[], lines: string[], retention?: () => Promise<RetentionPurgeCounts>): OnceSteps {
  return {
    poll: async () => {
      order.push("poll");
      return undefined;
    },
    onPollError: () => order.push("poll_error"),
    drain: async () => {
      order.push("drain");
      return DRAIN;
    },
    sweep: async () => {
      order.push("sweep");
      return SWEEP;
    },
    attribution: async () => {
      order.push("attribution");
      return { candidates: 0, attributed: 0, skipped: 0, failed: 0 };
    },
    location: async () => {
      order.push("location");
      return { candidates: 0, refreshed: 0, skipped: 0, failed: 0 };
    },
    ...(retention === undefined ? {} : {
      retention: async () => {
        order.push("retention");
        return retention();
      },
    }),
    freshness: async () => {
      order.push("freshness");
    },
    log: (line) => lines.push(line),
    runStartedAtMs: 0,
    now: () => 0,
  };
}

test("NFR-07: the retention purge runs once per run, after the backfills and before the freshness pass", async () => {
  const order: string[] = [];
  const lines: string[] = [];
  await runOnceSequence(steps(order, lines, async () => COUNTS));
  assert.deepEqual(order, ["poll", "drain", "sweep", "attribution", "location", "retention", "freshness"]);
  assert.equal(lines.filter((line) => line.startsWith("[Once] Retention purge:")).length, 1);
});

test("NFR-07: the purge line carries the counts and nothing else", () => {
  const line = formatRetentionLine(COUNTS);
  assert.equal(
    line,
    "[Once] Retention purge: source_text_nulled=3 vectors_removed=2 audit_records_removed=5 " +
      "account_admin_audit_removed=1 triage_decisions_removed=7.",
  );
  assert.doesNotMatch(line, /https?:|\/|title|quote|error|@/iu, "no URL, title, quote, error text or address");
});

test("NFR-07: a failed purge logs one fixed line, never fails the run, and the freshness pass still runs", async () => {
  const order: string[] = [];
  const lines: string[] = [];
  await runOnceSequence(steps(order, lines, async () => {
    throw new Error("permission denied for function purge_expired_retention with secret-text-in-message");
  }));
  assert.equal(order.at(-1), "freshness", "the run reaches freshness");
  const purgeLines = lines.filter((line) => line.includes("Retention purge"));
  assert.deepEqual(purgeLines, ["[Once] Retention purge: failed."]);
  assert.ok(lines.every((line) => !line.includes("secret-text-in-message")), "the error message never reaches the log");
});

test("NFR-07: a run without a retention step keeps its order and its lines", async () => {
  const order: string[] = [];
  const lines: string[] = [];
  await runOnceSequence(steps(order, lines));
  assert.deepEqual(order, ["poll", "drain", "sweep", "attribution", "location", "freshness"]);
  assert.equal(lines.some((line) => line.includes("Retention purge")), false);
});

test("NFR-07: the purge runs as the purger role for one statement, passes the clock as a parameter, and resets the role", async () => {
  const calls: Array<{ kind: "execute" | "query"; text: string; params?: readonly unknown[] }> = [];
  const executor = {
    execute: async (text: string) => {
      calls.push({ kind: "execute", text });
      return undefined;
    },
    query: async <Row extends object>(text: string, params?: readonly unknown[]) => {
      calls.push({ kind: "query", text, params });
      return {
        rows: [{
          source_text_nulled: "3", vectors_removed: "2", audit_records_removed: "5",
          account_admin_audit_removed: "1", triage_decisions_removed: "7",
        } as unknown as Row],
      };
    },
  };
  const now = new Date("2026-11-19T12:00:00.000Z");
  assert.deepEqual(await runRetentionPurge(executor, now), COUNTS);
  assert.deepEqual(calls.map((call) => call.kind), ["execute", "query", "execute"]);
  assert.equal(calls[0]?.text, `SET ROLE ${RETENTION_PURGER_ROLE}`);
  assert.equal(RETENTION_PURGER_ROLE, "waspada_retention_purger");
  assert.match(calls[1]?.text ?? "", /FROM waspada\.purge_expired_retention\(\$1::timestamptz\)/u);
  assert.deepEqual(calls[1]?.params, ["2026-11-19T12:00:00.000Z"], "the clock is a bound parameter, never interpolated");
  assert.equal(calls[2]?.text, "RESET ROLE");
});

test("NFR-07: the purge resets the role even when the function throws, so the rest of the session is not left in the purger role", async () => {
  const calls: string[] = [];
  const executor = {
    execute: async (text: string) => {
      calls.push(text);
      return undefined;
    },
    query: async () => {
      calls.push("query");
      throw new Error("insufficient_privilege");
    },
  };
  await assert.rejects(runRetentionPurge(executor, new Date("2026-11-19T12:00:00.000Z")), /insufficient_privilege/u);
  assert.deepEqual(calls, [`SET ROLE ${RETENTION_PURGER_ROLE}`, "query", "RESET ROLE"]);
});

test("NFR-07: an invalid clock is refused before any statement runs", async () => {
  const calls: string[] = [];
  const executor = {
    execute: async (text: string) => {
      calls.push(text);
      return undefined;
    },
    query: async () => {
      calls.push("query");
      return { rows: [] };
    },
  };
  await assert.rejects(runRetentionPurge(executor, new Date("not a date")), /retention_clock_invalid/u);
  assert.deepEqual(calls, []);
});
