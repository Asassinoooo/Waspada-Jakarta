// HOSTED-20: the --once publication sweep and run order. Fakes only: no database, no network, no clock.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { inspect } from "node:util";
import {
  formatDrainLine,
  formatPublicationLines,
  listUndecidedProposalIds,
  publicationSweepReserveMs,
  PUBLICATION_SWEEP_LIMIT,
  runOnceSequence,
  sweepUndecidedProposals,
  type DrainResult,
  type PublicationSweepResult,
  type SweepDecision,
} from "../hosted/ingest-once.js";

const SECRET = "SECRET-SOURCE-QUOTE-91c2";

/** A decide fake that answers from a table and records the order it was called in. */
function fakeDecide(table: Record<string, SweepDecision | Error>): { decide: (id: string) => Promise<SweepDecision>; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    decide: async (id: string) => {
      calls.push(id);
      const answer = table[id];
      if (answer === undefined) throw new Error(`no answer for ${id}`);
      if (answer instanceof Error) throw answer;
      return answer;
    },
  };
}

const NO_DEADLINE = { deadlineMs: Number.POSITIVE_INFINITY, now: () => 0 };

describe("publicationSweepReserveMs", () => {
  it("keeps a quarter of the budget, capped at three minutes", () => {
    assert.equal(publicationSweepReserveMs(20 * 60_000), 3 * 60_000);
    assert.equal(publicationSweepReserveMs(25 * 60_000), 3 * 60_000);
    assert.equal(publicationSweepReserveMs(60_000), 15_000);
  });
});

describe("sweepUndecidedProposals", () => {
  it("decides newest first and counts each outcome", async () => {
    const { decide, calls } = fakeDecide({
      "prop-new": { status: "published" },
      "prop-mid": { status: "queued", reasons: ["correlation_unresolved", "time_missing"] },
      "prop-old": { status: "unchanged" },
      "prop-dup": { status: "already_decided" },
      "prop-den": { status: "denied", code: "investigation_stopped_for_review" },
    });
    const result = await sweepUndecidedProposals({
      ...NO_DEADLINE,
      listUndecided: async () => ["prop-new", "prop-mid", "prop-old", "prop-dup", "prop-den"],
      decide,
    });
    assert.deepEqual(calls, ["prop-new", "prop-mid", "prop-old", "prop-dup", "prop-den"]);
    assert.equal(result.assessed, 5);
    assert.equal(result.published, 1);
    assert.equal(result.unchanged, 1);
    assert.equal(result.held, 1);
    assert.equal(result.skipped, 1);
    assert.equal(result.denied, 1);
    assert.equal(result.failed, 0);
    assert.deepEqual(result.heldReasons, { correlation_unresolved: 1, time_missing: 1 });
    assert.deepEqual(result.deniedCodes, { investigation_stopped_for_review: 1 });
    assert.equal(result.stop, "done");
  });

  it("counts a thrown decision as failed by its code, never its message", async () => {
    const coded = Object.assign(new Error(`${SECRET} leaked in a message`), { code: "23505" });
    const { decide } = fakeDecide({ a: coded, b: { status: "published" } });
    const result = await sweepUndecidedProposals({
      ...NO_DEADLINE,
      listUndecided: async () => ["a", "b"],
      decide,
    });
    assert.equal(result.failed, 1);
    assert.equal(result.published, 1);
    assert.deepEqual(result.failedCodes, { "23505": 1 });
    assert.equal(JSON.stringify(result).includes(SECRET), false);
  });

  it("does not call decide once the budget is used up", async () => {
    const { decide, calls } = fakeDecide({ a: { status: "published" } });
    const result = await sweepUndecidedProposals({
      deadlineMs: 100,
      now: () => 100,
      listUndecided: async () => ["a"],
      decide,
    });
    assert.deepEqual(calls, []);
    assert.equal(result.assessed, 0);
    assert.equal(result.stop, "budget");
  });

  it("stops after consecutive failures and leaves the rest undecided", async () => {
    const failure = new Error("connection dropped");
    const { decide, calls } = fakeDecide({ a: failure, b: failure, c: failure, d: { status: "published" } });
    const result = await sweepUndecidedProposals({
      ...NO_DEADLINE,
      listUndecided: async () => ["a", "b", "c", "d"],
      decide,
    });
    assert.deepEqual(calls, ["a", "b", "c"]);
    assert.equal(result.failed, 3);
    assert.equal(result.stop, "consecutive_failed");
  });

  it("reports limit when the list reached the cap", async () => {
    const { decide } = fakeDecide({ a: { status: "queued", reasons: [] }, b: { status: "queued", reasons: [] } });
    const result = await sweepUndecidedProposals({
      ...NO_DEADLINE,
      limit: 2,
      listUndecided: async (limit) => ["a", "b"].slice(0, limit),
      decide,
    });
    assert.equal(result.stop, "limit");
    assert.equal(result.held, 2);
  });

  it("asks for at most the default limit", async () => {
    const asked: number[] = [];
    await sweepUndecidedProposals({
      ...NO_DEADLINE,
      listUndecided: async (limit) => {
        asked.push(limit);
        return [];
      },
      decide: async () => ({ status: "published" }),
    });
    assert.deepEqual(asked, [PUBLICATION_SWEEP_LIMIT]);
  });
});

describe("formatPublicationLines", () => {
  it("prints counts and fixed codes only", () => {
    const result: PublicationSweepResult = {
      assessed: 3,
      published: 1,
      unchanged: 0,
      held: 2,
      denied: 0,
      skipped: 0,
      failed: 0,
      heldReasons: { time_missing: 1, correlation_unresolved: 2 },
      deniedCodes: {},
      failedCodes: {},
      stop: "done",
    };
    const lines = formatPublicationLines(result);
    assert.equal(
      lines[0],
      "[Once] Publication: assessed=3 published=1 unchanged=0 held=2 denied=0 skipped=0 failed=0 stop=done.",
    );
    assert.equal(lines[1], "[Once] Publication held reasons: correlation_unresolved=2 time_missing=1.");
    assert.equal(lines.length, 2);
  });

  it("omits reason lines when nothing was counted", () => {
    const lines = formatPublicationLines({
      assessed: 0,
      published: 0,
      unchanged: 0,
      held: 0,
      denied: 0,
      skipped: 0,
      failed: 0,
      heldReasons: {},
      deniedCodes: {},
      failedCodes: {},
      stop: "done",
    });
    assert.equal(lines.length, 1);
  });
});

describe("runOnceSequence", () => {
  it("runs poll, drain, sweep, then freshness, and logs the drain before the sweep", async () => {
    const order: string[] = [];
    const logged: string[] = [];
    let drainFinished = false;
    const drain: DrainResult = { completed: 3, notCompleted: 0, stop: "empty" };
    await runOnceSequence({
      poll: async () => {
        order.push("poll");
      },
      onPollError: () => order.push("poll-error"),
      drain: async () => {
        order.push("drain:start");
        await new Promise((resolve) => setTimeout(resolve, 5));
        drainFinished = true;
        order.push("drain:end");
        return drain;
      },
      sweep: async () => {
        // The sweep must start only after the drain has finished.
        assert.equal(drainFinished, true);
        order.push("sweep");
        return {
          assessed: 3,
          published: 2,
          unchanged: 0,
          held: 1,
          denied: 0,
          skipped: 0,
          failed: 0,
          heldReasons: { claim_unsupported: 1 },
          deniedCodes: {},
          failedCodes: {},
          stop: "done",
        };
      },
      freshness: async () => {
        order.push("freshness");
      },
      log: (line) => logged.push(line),
    });
    assert.deepEqual(order, ["poll", "drain:start", "drain:end", "sweep", "freshness"]);
    assert.deepEqual(logged, [
      formatDrainLine(drain),
      "[Once] Publication: assessed=3 published=2 unchanged=0 held=1 denied=0 skipped=0 failed=0 stop=done.",
      "[Once] Publication held reasons: claim_unsupported=1.",
    ]);
  });

  it("keeps going after a poll error", async () => {
    const order: string[] = [];
    await runOnceSequence({
      poll: async () => {
        throw new Error("feed down");
      },
      onPollError: () => order.push("poll-error"),
      drain: async () => {
        order.push("drain");
        return { completed: 0, notCompleted: 0, stop: "empty" };
      },
      sweep: async () => {
        order.push("sweep");
        return { assessed: 0, published: 0, unchanged: 0, held: 0, denied: 0, skipped: 0, failed: 0, heldReasons: {}, deniedCodes: {}, failedCodes: {}, stop: "done" };
      },
      freshness: async () => {
        order.push("freshness");
      },
      log: () => {},
    });
    assert.deepEqual(order, ["poll-error", "drain", "sweep", "freshness"]);
  });

  it("does not sweep or refresh when the drain throws", async () => {
    const order: string[] = [];
    await assert.rejects(
      runOnceSequence({
        poll: async () => {},
        onPollError: () => {},
        drain: async () => {
          throw new Error("database unavailable");
        },
        sweep: async () => {
          order.push("sweep");
          throw new Error("unreachable");
        },
        freshness: async () => {
          order.push("freshness");
        },
        log: () => {},
      }),
      /database unavailable/,
    );
    assert.deepEqual(order, []);
  });
});

describe("listUndecidedProposalIds", () => {
  it("lists proposals with no publication decision, newest first, bounded by the limit", async () => {
    const seen: { sql: string; params: unknown[] }[] = [];
    const executor = {
      query: async <Row extends object>(sql: string, params?: readonly unknown[]) => {
        seen.push({ sql, params: [...(params ?? [])] });
        return { rows: [{ proposal_id: "prop-2" }, { proposal_id: "prop-1" }] as unknown as Row[] };
      },
    };
    const ids = await listUndecidedProposalIds(executor, "live", 50);
    assert.deepEqual(ids, ["prop-2", "prop-1"]);
    assert.equal(seen.length, 1);
    const sql = seen[0]!.sql.replace(/\s+/g, " ");
    assert.match(sql, /FROM waspada\.event_proposals ep/);
    assert.match(sql, /NOT EXISTS \( SELECT 1 FROM waspada\.publication_decisions pd/);
    assert.match(sql, /ORDER BY ep\.proposed_at DESC, ep\.proposal_id DESC/);
    assert.match(sql, /LIMIT \$2/);
    assert.deepEqual(seen[0]!.params, ["live", 50]);
  });
});

describe("the sweep output keeps source text out", () => {
  it("never prints a thrown message or a decision value", () => {
    const lines = formatPublicationLines({
      assessed: 1,
      published: 0,
      unchanged: 0,
      held: 0,
      denied: 0,
      skipped: 0,
      failed: 1,
      heldReasons: {},
      deniedCodes: {},
      failedCodes: { TypeError: 1 },
      stop: "done",
    });
    const text = lines.join("\n");
    assert.equal(text.includes(SECRET), false);
    assert.equal(inspect(lines).includes(SECRET), false);
  });
});
